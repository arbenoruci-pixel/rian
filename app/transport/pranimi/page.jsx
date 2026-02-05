'use client';

import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient';
import { reserveTransportCode, markTransportCodeUsed } from '@/lib/transportCodes';
import { recordCashMove } from '@/lib/arkaCashSync';

// TRANSPORT PRANIMI = same look/feel as base PRANIMI, but:
// - Separate code system: T1, T2, ... stored in DB as code = 1000000 + n
// - Separate clients namespace (avoid clients_phone_uniq collisions): clients.phone = 'T' + realPhone
// - Payments go to arka_pending_payments with status=COLLECTED (not applied to daily cycle)
// - After save, goes to shared /pastrimi (Pastrimi sees all)

const CODE_OFFSET = 1000000; // numeric codes >= this are TRANSPORT (T + (code - offset))

const TEPIHA_CHIPS = [2.0, 2.5, 3.0, 3.2, 3.5, 3.7, 6.0];
const STAZA_CHIPS = [1.5, 2.0, 2.2, 3.0];
const SHKALLORE_QTY_CHIPS = [5, 10, 15, 20, 25, 30];
const SHKALLORE_PER_CHIPS = [0.25, 0.3, 0.35, 0.4];
const SHKALLORE_M2_PER_STEP_DEFAULT = 0.3;

const PRICE_DEFAULT = 3.0;
const PHONE_PREFIX_DEFAULT = '+383';

function readActor() {
  try {
    const raw = localStorage.getItem('CURRENT_USER_DATA');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function onlyDigits(v) {
  return String(v || '').replace(/\D+/g, '');
}

function tCodeToN(tCode) {
  const n = Number(String(tCode || '').replace(/\D+/g, '').replace(/^0+/, ''));
  return Number.isFinite(n) ? n : 0;
}
function tCodeToDbCode(tCode) {
  return CODE_OFFSET + tCodeToN(tCode);
}
function toTCodeDisplayFromDb(code) {
  const n = Number(code);
  if (!Number.isFinite(n)) return '';
  if (n >= CODE_OFFSET) return `T${n - CODE_OFFSET}`;
  return String(n);
}

function computeM2FromRows(tepihaRows, stazaRows, stairsQty, stairsPer) {
  const t = (tepihaRows || []).reduce((a, r) => a + (Number(r.m2) || 0) * (Number(r.qty) || 0), 0);
  const s = (stazaRows || []).reduce((a, r) => a + (Number(r.m2) || 0) * (Number(r.qty) || 0), 0);
  const sh = (Number(stairsQty) || 0) * (Number(stairsPer) || 0);
  return Number((t + s + sh).toFixed(2));
}

export default function TransportPranimiPage() {
  const router = useRouter();
  const sp = useSearchParams();
  const editId = sp.get('id') || '';

  const [actor, setActor] = useState(null);
  const [loading, setLoading] = useState(true);

  const [orderId, setOrderId] = useState('');
  const [tCode, setTCode] = useState('');

  const [name, setName] = useState('');
  const [phonePrefix, setPhonePrefix] = useState(PHONE_PREFIX_DEFAULT);
  const [phone, setPhone] = useState('');

  const [address, setAddress] = useState('');
  const [gpsLat, setGpsLat] = useState('');
  const [gpsLng, setGpsLng] = useState('');
  const [clientDesc, setClientDesc] = useState('');

  const [tepihaRows, setTepihaRows] = useState([]);
  const [stazaRows, setStazaRows] = useState([]);
  const [stairsQty, setStairsQty] = useState(0);
  const [stairsPer, setStairsPer] = useState(SHKALLORE_M2_PER_STEP_DEFAULT);

  const [pricePerM2, setPricePerM2] = useState(PRICE_DEFAULT);
  const [clientPaid, setClientPaid] = useState(0);

  const [notes, setNotes] = useState('');
  const [saveIncomplete, setSaveIncomplete] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const a = readActor();
    setActor(a);
  }, []);

  useEffect(() => {
    if (!actor) return;
    // Require login (and ideally TRANSPORT role)
    if (!actor?.pin) {
      router.push('/login');
      return;
    }

    (async () => {
      try {
        setLoading(true);
        if (editId) {
          const { data, error } = await supabase.from('orders').select('*').eq('id', editId).maybeSingle();
          if (error || !data) throw error || new Error('Order not found');

          const d = data.data || {};
          setOrderId(data.id);
          setTCode(toTCodeDisplayFromDb(data.code));
          setName(d?.client?.name || '');
          const realPhone = String(d?.client?.phone_real || d?.client?.phone || '');
          setPhone(realPhone.startsWith(phonePrefix) ? realPhone.slice(phonePrefix.length) : onlyDigits(realPhone));

          setTepihaRows(Array.isArray(d.tepiha) ? d.tepiha.map((r) => ({ m2: r.m2 ?? '', qty: String(r.qty ?? '0') })) : []);
          setStazaRows(Array.isArray(d.staza) ? d.staza.map((r) => ({ m2: r.m2 ?? '', qty: String(r.qty ?? '0') })) : []);
          setStairsQty(Number(d?.shkallore?.qty || 0));
          setStairsPer(Number(d?.shkallore?.per || SHKALLORE_M2_PER_STEP_DEFAULT));

          setPricePerM2(Number(d?.pay?.price || PRICE_DEFAULT));
          setClientPaid(Number(d?.pay?.paid || 0));

          setAddress(String(d?.transport?.address || ''));
          setGpsLat(String(d?.transport?.lat || ''));
          setGpsLng(String(d?.transport?.lng || ''));
          setClientDesc(String(d?.transport?.desc || ''));

          setNotes(String(d?.notes || ''));
          setSaveIncomplete(String(data.status || '').toLowerCase() === 'transport_incomplete');
          return;
        }

        // New
        setOrderId('');
        const tc = await reserveTransportCode();
        setTCode(tc);
      } catch (e) {
        console.error(e);
        alert('❌ Gabim: s’u hap TRANSPORT PRANIMI.');
      } finally {
        setLoading(false);
      }
    })();
  }, [actor, editId, phonePrefix, router]);

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
    const ph = `${phonePrefix}${phone || ''}`;
    if (onlyDigits(ph).length < 6) return alert('Shkruaj një numër telefoni të vlefshëm.'), false;
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
        setGpsLat(String(pos?.coords?.latitude ?? ''));
        setGpsLng(String(pos?.coords?.longitude ?? ''));
      },
      () => alert("S’u mor GPS. Lejo Location në browser."),
      { enableHighAccuracy: true, timeout: 8000 }
    );
  }

  async function saveOrder() {
    if (!actor?.pin) return;
    if (!validate()) return;
    setSaving(true);
    try {
      const realPhone = `${phonePrefix}${phone || ''}`;
      const client_phone_db = `T${onlyDigits(realPhone)}`; // avoids clients_phone_uniq collision
      const code_db = tCodeToDbCode(tCode);
      const code_display = toTCodeDisplayFromDb(code_db);

      const nowIso = new Date().toISOString();
      const status = saveIncomplete ? 'transport_incomplete' : 'pastrim';

      // 1) Upsert client (transport namespace)
      // NOTE: clients.code is numeric => use code_db
      await supabase
        .from('clients')
        .upsert(
          {
            code: code_db,
            full_name: name.trim(),
            phone: client_phone_db,
            updated_at: nowIso,
          },
          { onConflict: 'phone' }
        );

      // 2) Insert/update order
      const payload = {
        code: code_db,
        status,
        data: {
          scope: 'transport',
          transport_pin: String(actor.pin || ''),
          transport_name: String(actor.name || actor.full_name || ''),
          client: {
            name: name.trim(),
            phone_real: realPhone,
            phone_db: client_phone_db,
            code_display,
          },
          tepiha: tepihaRows.map((r) => ({ m2: Number(r.m2) || 0, qty: Number(r.qty) || 0 })),
          staza: stazaRows.map((r) => ({ m2: Number(r.m2) || 0, qty: Number(r.qty) || 0 })),
          shkallore: { qty: Number(stairsQty) || 0, per: Number(stairsPer) || SHKALLORE_M2_PER_STEP_DEFAULT },
          pay: {
            price: Number(pricePerM2) || 0,
            m2: Number(totalM2) || 0,
            euro: Number(totalEuro) || 0,
            paid: Number(clientPaid) || 0,
            debt: Number(debt) || 0,
            method: 'CASH',
          },
          transport: { address: address || '', lat: gpsLat || '', lng: gpsLng || '', desc: clientDesc || '' },
          notes: notes || '',
          created_at_client: nowIso,
        },
      };

      let savedOrderId = orderId;
      if (savedOrderId) {
        const { error } = await supabase.from('orders').update(payload).eq('id', savedOrderId);
        if (error) throw error;
      } else {
        const { data, error } = await supabase.from('orders').insert(payload).select('id').single();
        if (error) throw error;
        savedOrderId = data?.id;
        setOrderId(savedOrderId);
      }

      // 3) Mark T-code used ONLY when it becomes a real order (not incomplete)
      if (!saveIncomplete) {
        await markTransportCodeUsed(code_display);
      }

      // 4) If paid upfront, create TRANSPORT collected cash (NOT daily ARKA)
      if (!saveIncomplete && Number(clientPaid || 0) > 0) {
        await recordCashMove({
          amount: Number(clientPaid || 0),
          type: 'TRANSPORT',
          status: 'COLLECTED',
          order_id: savedOrderId,
          order_code: code_display,
          client_name: name.trim(),
          created_by_pin: String(actor.pin || ''),
          created_by_name: String(actor.name || actor.full_name || ''),
          note: 'TRANSPORT • PAGESA NË FILLIM',
          source: 'TRANSPORT_PRANIMI',
        });
      }

      // 5) Navigate
      if (saveIncomplete) {
        router.push('/transport/te-pa-plotsuara');
      } else {
        router.push(`/pastrimi?id=${savedOrderId}`);
      }
    } catch (e) {
      console.error(e);
      alert(`❌ RUJTJA DËSHTOI: ${e?.message || 'Gabim'}`);
    } finally {
      setSaving(false);
    }
  }

  if (!actor?.pin) {
    return (
      <div className="wrap">
        <header className="header-row">
          <div>
            <h1 className="title">TRANSPORT • PRANIMI</h1>
            <div className="subtitle">NUK JE I KYÇUR</div>
          </div>
          <Link className="pill" href="/login">LOGIN</Link>
        </header>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="wrap">
        <header className="header-row">
          <div>
            <h1 className="title">TRANSPORT • PRANIMI</h1>
            <div className="subtitle">DUKE HAPUR...</div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Link className="pill" href="/transport/menu">MENU</Link>
            <Link className="pill" href="/">HOME</Link>
          </div>
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
          <div className="subtitle">{String(actor?.name || actor?.full_name || '').toLowerCase()}</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Link className="pill" href="/transport/menu">MENU</Link>
          <Link className="pill" href="/">HOME</Link>
        </div>
      </header>

      <section className="card">
        <div className="row" style={{ alignItems: 'center', justifyContent: 'space-between' }}>
          <span className="badge">KODI: {String(tCode || '').toUpperCase()}</span>
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
            <input
              className="input"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="p.sh. Rr. Justina Shkupi, Prishtinë (ose: Lagjja, hyrja, kati...)"
            />
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
          <textarea
            className="textarea"
            value={clientDesc}
            onChange={(e) => setClientDesc(e.target.value)}
            placeholder="p.sh. hyrja e dytë, kati 3, telefononi 10 min para..."
          />
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
