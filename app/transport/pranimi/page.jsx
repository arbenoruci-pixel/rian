'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { getActor } from '@/lib/actorSession';
import { recordCashMove } from '@/lib/arkaCashSync';
import { nextTransportCode, searchTransportClients, upsertTransportClient, insertTransportOrder } from '@/lib/transport/transportDb';

function onlyDigits(v){ return String(v || '').replace(/\D/g,''); }
function parseAmount(v){
  const s = String(v ?? '').replace(/[^0-9.,-]/g,'').replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

export default function TransportPranimiPage(){
  const router = useRouter();
  const [me, setMe] = useState(null);

  const [code, setCode] = useState('T1');

  const [q, setQ] = useState('');
  const [hits, setHits] = useState([]);
  const [pick, setPick] = useState(null);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');

  const [address, setAddress] = useState('');
  const [gps, setGps] = useState({ lat: '', lng: '' });

  const [note, setNote] = useState('');

  const [paid, setPaid] = useState('');
  const [method, setMethod] = useState('CASH');

  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    const a = getActor();
    setMe(a);
    setCode(nextTransportCode());
  }, []);

  const role = String(me?.role || '').toUpperCase();
  const canSee = role === 'TRANSPORT' || role === 'ADMIN';

  async function doSearch(val){
    setQ(val);
    setErr('');
    const v = String(val||'').trim();
    if (!v) { setHits([]); return; }
    try{
      const list = await searchTransportClients(v);
      setHits(list);
    }catch(e){
      const msg = String(e?.message || e || '');
      if (String(e?.code||'')==='TRANSPORT_CLIENTS_TABLE_MISSING' || msg.toLowerCase().includes('relation')) {
        setErr('TRANSPORT_CLIENTS nuk ekziston në DB. Duhet me ekzekutu SQL patch-in (supabase/transport_clients.sql).');
      } else {
        setErr('Gabim në kërkim: ' + msg);
      }
      setHits([]);
    }
  }

  function pickClient(c){
    setPick(c);
    setName(c?.full_name || '');
    setPhone(c?.phone || '');
    setHits([]);
    setQ('');
  }

  async function takeGps(){
    setErr('');
    if (!navigator?.geolocation) { setErr('GPS nuk suportohen në këtë pajisje.'); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setGps({ lat: String(pos.coords.latitude), lng: String(pos.coords.longitude) });
      },
      () => setErr('S’u mor GPS. Kontrollo lejet e lokacionit.'),
      { enableHighAccuracy: true, timeout: 8000 }
    );
  }

  async function save(){
    setErr('');
    if (!me?.pin) { setErr('Duhet LOGIN me PIN.'); return; }
    const n = String(name||'').trim();
    const ph = onlyDigits(phone);
    if (!n) { setErr('Shkruaj EMRIN.'); return; }
    if (!ph) { setErr('Shkruaj NUMRIN.'); return; }

    const payPaid = parseAmount(paid);
    const payObj = (Number.isFinite(payPaid) && payPaid > 0)
      ? { paid: Number(payPaid.toFixed(2)), method: method, euro: Number(payPaid.toFixed(2)) }
      : { paid: 0, method: method, euro: 0 };

    setBusy(true);
    try{
      const c = await upsertTransportClient({ full_name: n, phone: ph });
      const order = await insertTransportOrder({
        code,
        client: c,
        address,
        gps: (gps?.lat && gps?.lng) ? { lat: Number(gps.lat), lng: Number(gps.lng) } : null,
        note,
        pay: payObj,
      });

      if (payObj.paid > 0 && method === 'CASH') {
        try{
          await recordCashMove({
            order_id: order?.id,
            order_code: code,
            client_name: n,
            stage: 'TRANSPORT_PRANIMI',
            amount: payObj.paid,
            method: 'CASH',
            created_by_pin: me.pin,
            created_by_name: me.name,
          });
        }catch{}
      }

      setPick(null);
      setName('');
      setPhone('');
      setAddress('');
      setGps({ lat:'', lng:'' });
      setNote('');
      setPaid('');
      setMethod('CASH');
      setCode(nextTransportCode());

      router.push('/pastrimi');
    }catch(e){
      setErr(String(e?.message || e || 'Gabim'));
    }finally{
      setBusy(false);
    }
  }

  return (
    <main className="wrap">
      <header className="top">
        <div>
          <div className="h1">TRANSPORT • PRANIMI</div>
          <div className="sub">KODI: <b className="badge">{code}</b></div>
        </div>
        <div className="row">
          <Link className="btn ghost" href="/transport/menu">MENU</Link>
          <Link className="btn ghost" href="/">HOME</Link>
        </div>
      </header>

      {!me ? (
        <div className="card">
          <div className="t">NUK JE I KYÇUR</div>
          <div className="p">Shko te LOGIN dhe hyn me PIN.</div>
          <Link className="btn" href="/login">LOGIN</Link>
        </div>
      ) : !canSee ? (
        <div className="card">
          <div className="t">S’KE LEJE</div>
          <div className="p">Vetëm TRANSPORT / ADMIN.</div>
          <Link className="btn" href="/">KTHEHU</Link>
        </div>
      ) : (
        <>
          {err ? <div className="card err"><div className="t">GABIM</div><div className="p">{err}</div></div> : null}

          <div className="card">
            <div className="t">KLIENTI (TRANSPORT)</div>

            <div className="p">KËRKO: (EMËR / TEL)</div>
            <input className="in" value={q} onChange={(e)=>doSearch(e.target.value)} placeholder="KËRKO..." />

            {hits?.length ? (
              <div className="list">
                {hits.map((c)=>(
                  <button key={c.id} className="li" onClick={()=>pickClient(c)}>
                    <b>{c.full_name}</b><span className="muted"> • {c.phone}</span>
                  </button>
                ))}
              </div>
            ) : null}

            <div className="grid2">
              <div>
                <div className="p">EMRI</div>
                <input className="in" value={name} onChange={(e)=>setName(e.target.value)} placeholder="EMRI..." />
              </div>
              <div>
                <div className="p">TEL</div>
                <input className="in" value={phone} onChange={(e)=>setPhone(onlyDigits(e.target.value))} placeholder="NUMRI..." />
              </div>
            </div>

            {pick ? <div className="p muted">ZGJEDHUR: <b>{pick.full_name}</b></div> : null}
          </div>

          <div className="card">
            <div className="t">ADRESA</div>
            <input className="in" value={address} onChange={(e)=>setAddress(e.target.value)} placeholder="RRUGA / QYTETI..." />

            <div className="row" style={{ marginTop: 10 }}>
              <button className="btn" onClick={takeGps} disabled={busy}>MERRE GPS</button>
              <div className="p muted">LAT: <b>{gps.lat || '-'}</b> • LNG: <b>{gps.lng || '-'}</b></div>
            </div>
          </div>

          <div className="card">
            <div className="t">PAGESA NË FILLIM (OPSIONALE)</div>
            <div className="grid2">
              <div>
                <div className="p">SHUMA (€)</div>
                <input className="in" value={paid} onChange={(e)=>setPaid(e.target.value)} placeholder="0" />
              </div>
              <div>
                <div className="p">METODA</div>
                <select className="in" value={method} onChange={(e)=>setMethod(e.target.value)}>
                  <option value="CASH">CASH</option>
                  <option value="TRANSFER">TRANSFER</option>
                </select>
              </div>
            </div>
          </div>

          <div className="card">
            <div className="t">SHËNIM</div>
            <textarea className="in" rows={3} value={note} onChange={(e)=>setNote(e.target.value)} placeholder="OPSIONALE..." />
          </div>

          <div className="row">
            <button className="btn" onClick={save} disabled={busy}>{busy ? 'DUKE RUAJT...' : 'RUAJ (SHKON NË PASTRIM)'}</button>
          </div>

          <div className="card">
            <div className="p muted">Kjo krijon porosi me kod <b>{code}</b> dhe e dërgon direkt në listën e <b>PASTRIMIT</b> (e përbashkët).</div>
          </div>
        </>
      )}

      <style jsx>{`
        .err{ border-color: rgba(255,90,90,.35); background: rgba(255,60,60,.08); }
        .badge{ display:inline-block; padding:2px 10px; border-radius:999px; background:#16a34a; color:#fff; }
        .grid2{ display:grid; grid-template-columns:1fr 1fr; gap:10px; }
        .list{ margin-top:10px; display:flex; flex-direction:column; gap:6px; }
        .li{ text-align:left; padding:10px; border-radius:10px; border:1px solid rgba(255,255,255,.14); background: rgba(255,255,255,.04); }
        .muted{ opacity:.8; }
        @media (max-width: 520px){ .grid2{ grid-template-columns:1fr; } }
      `}</style>
    </main>
  );
}
