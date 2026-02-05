'use client';

import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient';
import { getTransportSession } from '@/lib/transportAuth';
import { reserveTransportCode, markTransportCodeUsed } from '@/lib/transportCodes';

// TRANSPORT PRANIMI: cloned UX from base PRANIMI, but transport-scoped (T-codes + transport session).

const BUCKET = 'tepiha-photos';

const TEPIHA_CHIPS = [2.0, 2.5, 3.0, 3.2, 3.5, 3.7, 6.0];
const STAZA_CHIPS = [1.5, 2.0, 2.2, 3.0];

const SHKALLORE_QTY_CHIPS = [5, 10, 15, 20, 25, 30];
const SHKALLORE_PER_CHIPS = [0.25, 0.3, 0.35, 0.4];
const SHKALLORE_M2_PER_STEP_DEFAULT = 0.3;

const PRICE_DEFAULT = 3.0;
const PHONE_PREFIX_DEFAULT = '+383';

function sanitizePhone(phone) {
  return String(phone || '').replace(/\D+/g, '');
}

function normalizeCodeKeepT(raw) {
  if (!raw) return '';
  const s = String(raw).trim();
  if (/^t\d+/i.test(s)) {
    const n = s.replace(/\D+/g, '').replace(/^0+/, '') || '0';
    return `T${n}`;
  }
  const n = s.replace(/\D+/g, '').replace(/^0+/, '');
  return n || '0';
}

function computeM2FromRows(tepihaRows, stazaRows, stairsQty, stairsPer) {
  const t = (tepihaRows || []).reduce((a, r) => a + (Number(r.m2) || 0) * (Number(r.qty) || 0), 0);
  const s = (stazaRows || []).reduce((a, r) => a + (Number(r.m2) || 0) * (Number(r.qty) || 0), 0);
  const sh = (Number(stairsQty) || 0) * (Number(stairsPer) || 0);
  return Number((t + s + sh).toFixed(2));
}

async function uploadJson(path, obj) {
  const blob = new Blob([JSON.stringify(obj)], { type: 'application/json' });
  const { error } = await supabase.storage.from(BUCKET).upload(path, blob, { upsert: true, contentType: 'application/json' });
  if (error) throw error;
}

async function downloadJsonNoCache(path) {
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, 60);
  if (error || !data?.signedUrl) throw error || new Error('No signedUrl');
  const res = await fetch(`${data.signedUrl}&t=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error('Fetch failed');
  return await res.json();
}

export default function TransportPranim() {
  const router = useRouter();
  const sp = useSearchParams();
  const editId = sp.get('id') || '';

  const [me, setMe] = useState(null);
  const [creating, setCreating] = useState(true);

  // identity
  const [oid, setOid] = useState('');
  const [codeRaw, setCodeRaw] = useState('');

  // client
  const [name, setName] = useState('');
  const [phonePrefix, setPhonePrefix] = useState(PHONE_PREFIX_DEFAULT);
  const [phone, setPhone] = useState('');

  // transport address / gps
  const [address, setAddress] = useState('');
  const [gpsLat, setGpsLat] = useState('');
  const [gpsLng, setGpsLng] = useState('');
  const [clientDesc, setClientDesc] = useState('');

  // rows (empty by default)
  const [tepihaRows, setTepihaRows] = useState([]);
  const [stazaRows, setStazaRows] = useState([]);

  const [stairsQty, setStairsQty] = useState(0);
  const [stairsPer, setStairsPer] = useState(SHKALLORE_M2_PER_STEP_DEFAULT);

  // pay (CASH only)
  const [pricePerM2, setPricePerM2] = useState(PRICE_DEFAULT);
  const [clientPaid, setClientPaid] = useState(0);

  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  // incomplete mode (transport_incomplete)
  const [saveIncomplete, setSaveIncomplete] = useState(false);

  useEffect(() => {
    const s = getTransportSession();
    if (!s?.transport_id) {
      router.push('/transport');
      return;
    }
    setMe(s);
  }, [router]);

  useEffect(() => {
    if (!me?.transport_id) return;

    (async () => {
      try {
        // load existing
        if (editId) {
          const ord = await downloadJsonNoCache(`orders/${editId}.json`);
          setOid(ord.id || editId);
          setCodeRaw(ord?.client?.code || ord?.code || '');
          setName(ord?.client?.name || '');
          const p = String(ord?.client?.phone || '');
          setPhone(p.startsWith(phonePrefix) ? p.slice(phonePrefix.length) : sanitizePhone(p));

          setTepihaRows(
            Array.isArray(ord.tepiha) && ord.tepiha.length
              ? ord.tepiha.map((r) => ({ m2: r.m2 ?? '', qty: String(r.qty ?? '0'), photoUrl: r.photoUrl || '' }))
              : []
          );
          setStazaRows(
            Array.isArray(ord.staza) && ord.staza.length
              ? ord.staza.map((r) => ({ m2: r.m2 ?? '', qty: String(r.qty ?? '0'), photoUrl: r.photoUrl || '' }))
              : []
          );
          setStairsQty(Number(ord?.shkallore?.qty || 0));
          setStairsPer(Number(ord?.shkallore?.per || SHKALLORE_M2_PER_STEP_DEFAULT));
          setPricePerM2(Number(ord?.pay?.price || PRICE_DEFAULT));
          setClientPaid(Number(ord?.pay?.paid || 0));
          setNotes(String(ord?.notes || ''));
          setSaveIncomplete(ord.status === 'transport_incomplete');
          setAddress(String(ord?.transport?.address || ''));
          setGpsLat(String(ord?.transport?.lat || ''));
          setGpsLng(String(ord?.transport?.lng || ''));
          setClientDesc(String(ord?.transport?.desc || ''));
          setCreating(false);
          return;
        }

        // new order
        const id = `ord_${Date.now()}`;
        setOid(id);

        const t = await reserveTransportCode();
        setCodeRaw(t);

        setCreating(false);
      } catch (e) {
        console.error(e);
        setCreating(false);
      }
    })();
  }, [me, editId, phonePrefix]);

  const totalM2 = useMemo(() => computeM2FromRows(tepihaRows, stazaRows, stairsQty, stairsPer), [tepihaRows, stazaRows, stairsQty, stairsPer]);
  const totalEuro = useMemo(() => Number((totalM2 * (Number(pricePerM2) || 0)).toFixed(2)), [totalM2, pricePerM2]);
  const debt = useMemo(() => {
    const d = Number((totalEuro - Number(clientPaid || 0)).toFixed(2));
    return d > 0 ? d : 0;
  }, [totalEuro, clientPaid]);

  function setRow(setter, idx, patch) {
    setter((prev) => {
      const next = [...prev];
      next[idx] = { ...next[idx], ...patch };
      return next;
    });
  }

  function validate() {
    if (saveIncomplete) return true;
    if (!name.trim()) return alert('Shkruaj emrin dhe mbiemrin.'), false;
    if (name.trim().split(/\s+/).length < 2) return alert('Shkruaj edhe mbiemrin.'), false;
    const ph = sanitizePhone(phonePrefix + phone);
    if (!ph || ph.length < 6) return alert('Shkruaj një numër telefoni të vlefshëm.'), false;
    if (totalM2 <= 0) return alert('Shto të paktën 1 m².'), false;
    return true;
  }

  function getGps() {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      alert('GPS nuk është i disponueshëm në këtë pajisje.');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = String(pos?.coords?.latitude ?? '');
        const lng = String(pos?.coords?.longitude ?? '');
        setGpsLat(lat);
        setGpsLng(lng);
      },
      () => alert('S’u mor GPS. Lejo Location në browser.'),
      { enableHighAccuracy: true, timeout: 8000 }
    );
  }

  async function saveOrder(nextStatus) {
    if (!me?.transport_id) return;
    if (!validate()) return;

    setSaving(true);
    try {
      const code = normalizeCodeKeepT(codeRaw);
      const order = {
        id: oid,
        ts: Date.now(),
        scope: 'transport',
        transport_id: me.transport_id,
        status: nextStatus,
        client: {
          name: name.trim(),
          phone: phonePrefix + (phone || ''),
          code,
          photoUrl: '',
        },
        tepiha: tepihaRows.map((r) => ({ m2: Number(r.m2) || 0, qty: Number(r.qty) || 0, photoUrl: r.photoUrl || '' })),
        staza: stazaRows.map((r) => ({ m2: Number(r.m2) || 0, qty: Number(r.qty) || 0, photoUrl: r.photoUrl || '' })),
        shkallore: { qty: Number(stairsQty) || 0, per: Number(stairsPer) || SHKALLORE_M2_PER_STEP_DEFAULT },
        pay: {
          price: Number(pricePerM2) || 0,
          m2: Number(totalM2) || 0,
          euro: Number(totalEuro) || 0,
          paid: Number(clientPaid) || 0,
          debt: Number(debt) || 0,
          method: 'CASH',
        },
        transport: {
          address: address || '',
          lat: gpsLat || '',
          lng: gpsLng || '',
          desc: clientDesc || '',
        },
        notes: notes || '',
      };

      await uploadJson(`orders/${oid}.json`, order);

      if (nextStatus === 'transport_ready_for_base') {
        await markTransportCodeUsed(code);
      }

      if (nextStatus === 'transport_incomplete') {
        router.push('/transport/te-pa-plotsuara');
      } else {
        // PASRTIMI is shared stage
        router.push(`/pastrimi?id=${oid}`);
      }
    } catch (e) {
      console.error(e);
      alert('❌ Gabim ruajtja!');
    } finally {
      setSaving(false);
    }
  }

  if (creating) {
    return (
      <div className="wrap">
        <header className="header-row">
          <div>
            <h1 className="title">TRANSPORT • PRANIMI</h1>
            <div className="subtitle">DUKE HAPUR...</div>
          </div>
          <Link className="pill" href="/transport/menu">MENU</Link>
        </header>
        <section className="card">
          <div className="muted">Loading...</div>
        </section>
export default function TransportPranimiDebug() {
  return (
    <main className="wrap" style={{ padding: 18 }}>
      <div style={{ fontSize: 22, fontWeight: 800, marginBottom: 10 }}>
        TRANSPORT • PRANIMI — LIVE STAMP 2026-02-05 v999
      </div>
      <div style={{ opacity: 0.85, marginBottom: 14 }}>
        NËSE PO E SHEH KËTË, ATËHERË VERCEL PO SHËRBEN DEPLOY-IN E FUNDIT DHE ROUTE-I /transport/pranimi ËSHTË OK.
      </div>
      <div style={{ display: 'flex', gap: 10 }}>
        <Link className="pill" href="/transport">KTHEHU NË TRANSPORT</Link>
        <Link className="pill" href="/">HOME</Link>
      </div>
      <div style={{ marginTop: 16, fontSize: 13, opacity: 0.8 }}>
        Pasi ta konfirmosh këtë stamp, kthehemi e fusim formën e plotë (pa u përzi me /pranim).
      </div>
    );
  }

  return (
    <div className="wrap">
      <header className="header-row" style={{ alignItems: 'flex-start' }}>
        <div>
          <h1 className="title">TRANSPORT • PRANIMI</h1>
          <div className="subtitle">TRANSPORT: {me?.transport_id || ''}</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Link className="pill" href="/transport/menu">MENU</Link>
          <Link className="pill" href="/">HOME</Link>
        </div>
      </header>

      <section className="card">
        <div className="row" style={{ alignItems: 'center', justifyContent: 'space-between' }}>
          <span className="badge">{`KODI: ${normalizeCodeKeepT(codeRaw)}`}</span>
          <label className="pill" style={{ cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={saveIncomplete}
              onChange={(e) => setSaveIncomplete(e.target.checked)}
              style={{ marginRight: 8 }}
            />
            E PA PLOTSUAR
          </label>
        </div>

        <div className="row">
          <div className="field">
            <div className="label">EMRI + MBIEMRI</div>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Emri Mbiemri" />
          </div>
        </div>

        <div className="row">
          <div className="field" style={{ flex: 0.5 }}>
            <div className="label">PREFIX</div>
            <input className="input" value={phonePrefix} onChange={(e) => setPhonePrefix(e.target.value)} placeholder="+383" />
          </div>
          <div className="field" style={{ flex: 1 }}>
            <div className="label">TELEFONI</div>
            <input className="input" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="48xxxxxx" />
          </div>
        </div>

        <div className="sep" />

        <h2 className="card-title">ADRESA</h2>
        <div className="row" style={{ gap: 8, alignItems: 'center' }}>
          <div className="field" style={{ flex: 1 }}>
            <div className="label">RRUGA / QYTETI</div>
            <input className="input" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="p.sh. Rr. Justina Shkupi, Prishtinë" />
          </div>
          <button type="button" className="btn" onClick={getGps} style={{ whiteSpace: 'nowrap' }}>
            MERRE GPS
          </button>
        </div>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <span className="pill">LAT: {gpsLat ? Number(gpsLat).toFixed(6) : '-'}</span>
          <span className="pill">LNG: {gpsLng ? Number(gpsLng).toFixed(6) : '-'}</span>
        </div>

        <div className="field">
          <div className="label">PËRSHKRIM (OPSIONALE)</div>
          <textarea className="textarea" value={clientDesc} onChange={(e) => setClientDesc(e.target.value)} placeholder="p.sh. hyrja e dytë, kati 3, telefononi para se të vini..." />
        </div>

        <div className="sep" />

        <h2 className="card-title">TEPIHA</h2>
        {tepihaRows.map((r, idx) => (
          <div key={`t_${idx}`} className="row" style={{ gap: 8 }}>
            <div className="field" style={{ flex: 1 }}>
              <div className="label">M²</div>
              <input className="input" value={r.m2} onChange={(e) => setRow(setTepihaRows, idx, { m2: e.target.value })} placeholder="p.sh. 3.2" />
              <div className="chip-row">
                {TEPIHA_CHIPS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    className="chip"
                    onClick={() => {
                      const curQty = String(tepihaRows?.[idx]?.qty ?? '').trim();
                      setRow(setTepihaRows, idx, { m2: c, qty: curQty && curQty !== '0' ? curQty : '1' });
                    }}
                  >
                    {c}
                  </button>
                ))}
              </div>
            </div>
            <div className="field" style={{ width: 110 }}>
              <div className="label">COPË</div>
              <input className="input" value={r.qty} onChange={(e) => setRow(setTepihaRows, idx, { qty: e.target.value })} />
            </div>
          </div>
        ))}

        <button type="button" className="btn" onClick={() => setTepihaRows((p) => [...p, { m2: '', qty: '0', photoUrl: '' }])}>
          + SHTO RRESHT
        </button>

        <div className="sep" />

        <h2 className="card-title">STAZA</h2>
        {stazaRows.map((r, idx) => (
          <div key={`s_${idx}`} className="row" style={{ gap: 8 }}>
            <div className="field" style={{ flex: 1 }}>
              <div className="label">M²</div>
              <input className="input" value={r.m2} onChange={(e) => setRow(setStazaRows, idx, { m2: e.target.value })} placeholder="p.sh. 2.0" />
              <div className="chip-row">
                {STAZA_CHIPS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    className="chip"
                    onClick={() => {
                      const curQty = String(stazaRows?.[idx]?.qty ?? '').trim();
                      setRow(setStazaRows, idx, { m2: c, qty: curQty && curQty !== '0' ? curQty : '1' });
                    }}
                  >
                    {c}
                  </button>
                ))}
              </div>
            </div>
            <div className="field" style={{ width: 110 }}>
              <div className="label">COPË</div>
              <input className="input" value={r.qty} onChange={(e) => setRow(setStazaRows, idx, { qty: e.target.value })} />
            </div>
          </div>
        ))}

        <button type="button" className="btn" onClick={() => setStazaRows((p) => [...p, { m2: '', qty: '0', photoUrl: '' }])}>
          + SHTO RRESHT
        </button>

        <div className="sep" />

        <h2 className="card-title">SHKALLORE</h2>
        <div className="row" style={{ gap: 8 }}>
          <div className="field" style={{ flex: 1 }}>
            <div className="label">SASI (COPË)</div>
            <input className="input" value={stairsQty} onChange={(e) => setStairsQty(e.target.value)} placeholder="p.sh. 20" />
            <div className="chip-row">
              {SHKALLORE_QTY_CHIPS.map((c) => (
                <button key={c} type="button" className="chip" onClick={() => setStairsQty(c)}>
                  {c}
                </button>
              ))}
            </div>
          </div>
          <div className="field" style={{ width: 140 }}>
            <div className="label">M² / COPË</div>
            <input className="input" value={stairsPer} onChange={(e) => setStairsPer(e.target.value)} />
            <div className="chip-row">
              {SHKALLORE_PER_CHIPS.map((c) => (
                <button key={c} type="button" className="chip" onClick={() => setStairsPer(c)}>
                  {c}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="sep" />

        <h2 className="card-title">PAGESA (CASH)</h2>
        <div className="row" style={{ gap: 8 }}>
          <div className="field" style={{ flex: 1 }}>
            <div className="label">€/M²</div>
            <input className="input" value={pricePerM2} onChange={(e) => setPricePerM2(e.target.value)} />
          </div>
          <div className="field" style={{ flex: 1 }}>
            <div className="label">KLIENTI DHA</div>
            <input className="input" value={clientPaid} onChange={(e) => setClientPaid(e.target.value)} />
          </div>
        </div>

        <div className="row" style={{ justifyContent: 'space-between' }}>
          <span className="pill">M²: {Number(totalM2 || 0).toFixed(2)}</span>
          <span className="pill">TOTAL: {Number(totalEuro || 0).toFixed(2)} €</span>
          <span className="pill">BORXH: {Number(debt || 0).toFixed(2)} €</span>
        </div>

        <div className="sep" />

        <div className="field">
          <div className="label">KËRKESË SPECIALE</div>
          <textarea className="textarea" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Shëno diçka (opsionale)" />
        </div>

        <div style={{ height: 10 }} />

        <button className="btn btn-primary" disabled={saving} onClick={() => saveOrder(saveIncomplete ? 'transport_incomplete' : 'transport_ready_for_base')}>
          {saving ? 'DUKE RUAJTUR...' : 'RUAJ (SHKON NË PASTRIMI)'}
        </button>
      </section>
    </div>
  );
}
