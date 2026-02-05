'use client';

import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { getTransportSession } from '@/lib/transportAuth';
import { reserveTransportCode, markTransportCodeUsed } from '@/lib/transportCodes';
import { insertTransportOrder, updateTransportOrder } from '@/lib/transport/transportDb';
import { recordCashMove } from '@/lib/arkaCashSync';

// TRANSPORT • PRANIMI
// UI = same style/classes as base PRANIMI.
// Logic = transport-scoped:
// - Code = T-codes (separate counter)
// - Clients are NOT saved into base `clients` table (avoids phone unique conflicts)
// - Cash collected is saved as arka_pending_payments.status='COLLECTED' type='TRANSPORT' (not applied to daily cycle)

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

function normalizeTCode(raw) {
  if (!raw) return '';
  const s = String(raw).trim();
  if (/^t\d+/i.test(s)) {
    const n = s.replace(/\D+/g, '').replace(/^0+/, '') || '0';
    return `T${n}`;
  }
  const n = s.replace(/\D+/g, '').replace(/^0+/, '');
  return n ? `T${n}` : '';
}

function computeM2FromRows(tepihaRows, stazaRows, stairsQty, stairsPer) {
  const t = (tepihaRows || []).reduce((a, r) => a + (Number(r.m2) || 0) * (Number(r.qty) || 0), 0);
  const s = (stazaRows || []).reduce((a, r) => a + (Number(r.m2) || 0) * (Number(r.qty) || 0), 0);
  const sh = (Number(stairsQty) || 0) * (Number(stairsPer) || 0);
  return Number((t + s + sh).toFixed(2));
}

function parseNum(v, fallback = 0) {
  const s = String(v ?? '').replace(/[^0-9.,-]/g, '').replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : fallback;
}

export default function TransportPranim() {
  const router = useRouter();
  const sp = useSearchParams();
  const editId = sp.get('id') || '';

  const [me, setMe] = useState(null);
  const [creating, setCreating] = useState(true);

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

  // rows
  const [tepihaRows, setTepihaRows] = useState([]);
  const [stazaRows, setStazaRows] = useState([]);
  const [stairsQty, setStairsQty] = useState(0);
  const [stairsPer, setStairsPer] = useState(SHKALLORE_M2_PER_STEP_DEFAULT);

  // pay (CASH)
  const [pricePerM2, setPricePerM2] = useState(PRICE_DEFAULT);
  const [clientPaid, setClientPaid] = useState(0);

  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
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
        if (editId) {
          // For simplicity: editing transport order is handled in /transport/gati detail (later).
          // Keep page usable by loading from DB here if needed in future.
          setOid(editId);
          setCreating(false);
          return;
        }

        // new order
        const id = `tord_${Date.now()}`;
        setOid(id);

        const tcode = await reserveTransportCode();
        setCodeRaw(tcode);

        setCreating(false);
      } catch (e) {
        console.error(e);
        setCreating(false);
      }
    })();
  }, [me, editId]);

  const totalM2 = useMemo(() => computeM2FromRows(tepihaRows, stazaRows, stairsQty, stairsPer), [tepihaRows, stazaRows, stairsQty, stairsPer]);
  const totalEuro = useMemo(() => Number((totalM2 * parseNum(pricePerM2, 0)).toFixed(2)), [totalM2, pricePerM2]);
  const paidEuro = useMemo(() => parseNum(clientPaid, 0), [clientPaid]);
  const debt = useMemo(() => {
    const d = Number((totalEuro - paidEuro).toFixed(2));
    return d > 0 ? d : 0;
  }, [totalEuro, paidEuro]);

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

  async function saveOrder() {
    if (!me?.transport_id) return;
    if (!validate()) return;

    setSaving(true);
    try {
      const code = normalizeTCode(codeRaw);

      const order = {
        id: oid,
        code,                 // keep Txx here (transport pages)
        code_n: Number(code.replace(/\D+/g, '')) || 0,
        scope: 'transport',
        transport_id: String(me.transport_id),
        transport_name: me.transport_name || me.transport_id,
        status: saveIncomplete ? 'transport_incomplete' : 'pastrim', // shared pastrimi stage
        created_at: new Date().toISOString(),
        data: {
          scope: 'transport',
          transport_id: String(me.transport_id),
          transport_name: me.transport_name || me.transport_id,
          status: saveIncomplete ? 'transport_incomplete' : 'pastrim',
          client: {
            name: name.trim(),
            phone: phonePrefix + (phone || ''),
            code,
          },
          transport: {
            address: address || '',
            lat: gpsLat || '',
            lng: gpsLng || '',
            desc: clientDesc || '',
          },
          tepiha: tepihaRows.map((r) => ({ m2: parseNum(r.m2, 0), qty: parseNum(r.qty, 0) })),
          staza: stazaRows.map((r) => ({ m2: parseNum(r.m2, 0), qty: parseNum(r.qty, 0) })),
          shkallore: { qty: parseNum(stairsQty, 0), per: parseNum(stairsPer, SHKALLORE_M2_PER_STEP_DEFAULT) },
          pay: {
            price: parseNum(pricePerM2, 0),
            m2: Number(totalM2) || 0,
            euro: Number(totalEuro) || 0,
            paid: Number(paidEuro) || 0,
            debt: Number(debt) || 0,
            method: 'CASH',
          },
          notes: notes || '',
        },
      };

      // DB insert (NO clients table usage)
      const res = await insertTransportOrder(order);
      if (!res?.ok) throw new Error(res?.error || 'Insert failed');

      // Mark T code used (always on save)
      await markTransportCodeUsed(code);

      // CASH collected by transport operator -> goes to TRANSPORT wallet (COLLECTED), not daily cycle
      if (paidEuro > 0) {
        await recordCashMove({
          amount: paidEuro,
          method: 'CASH',
          type: 'TRANSPORT',
          status: 'COLLECTED',
          order_id: order.id,
          order_code: code,
          client_name: name.trim(),
          stage: 'PRANIMI',
          note: `TRANSPORT PRANIMI ${code}`,
          created_by_pin: String(me.transport_id),
          created_by_name: me.transport_name || me.transport_id,
          approved_by_pin: null,
        });
      }

      // route
      if (saveIncomplete) {
        router.push('/transport/te-pa-plotsuara');
      } else {
        router.push(`/pastrimi?id=${order.id}`);
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
      </div>
    );
  }

  return (
    <div className="wrap">
      <header className="header-row" style={{ alignItems: 'flex-start' }}>
        <div>
          <h1 className="title">TRANSPORT • PRANIMI</h1>
          <div className="subtitle">{me?.transport_name || ''}</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Link className="pill" href="/transport/menu">MENU</Link>
          <Link className="pill" href="/">HOME</Link>
        </div>
      </header>

      <section className="card">
        <div className="row" style={{ alignItems: 'center', justifyContent: 'space-between' }}>
          <span className="badge">{`KODI: ${normalizeTCode(codeRaw)}`}</span>
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
          <textarea className="textarea" value={clientDesc} onChange={(e) => setClientDesc(e.target.value)} placeholder="p.sh. hyrja e dytë, kati 3, telefononi 10 min para..." />
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
        <button type="button" className="btn" onClick={() => setTepihaRows((p) => [...p, { m2: '', qty: '0' }])}>
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
        <button type="button" className="btn" onClick={() => setStazaRows((p) => [...p, { m2: '', qty: '0' }])}>
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

        <h2 className="card-title">PAGESA (TRANSPORT)</h2>
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

        <button className="btn btn-primary" disabled={saving} onClick={saveOrder}>
          {saving ? 'DUKE RUAJTUR...' : 'RUAJ (SHKON NË PASTRIMI)'}
        </button>
      </section>
    </div>
  );
}
