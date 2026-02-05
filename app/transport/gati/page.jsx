'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabaseClient';
import { getActor } from '@/lib/actorSession';

function safeJson(v){ try { return v && typeof v === 'object' ? v : (v ? JSON.parse(v) : null); } catch { return null; } }

export default function TransportGatiPage(){
  const [me, setMe] = useState(null);
  const [items, setItems] = useState([]);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { setMe(getActor()); }, []);

  const role = String(me?.role || '').toUpperCase();
  const canSee = role === 'TRANSPORT' || role === 'ADMIN';

  async function load(){
    if (!me?.pin) return;
    setBusy(true);
    setErr('');
    try{
      const { data, error } = await supabase
        .from('orders')
        .select('id, code, status, client_name, client_phone, data, created_at, updated_at')
        .eq('status', 'gati')
        .ilike('code', 'T%')
        .order('updated_at', { ascending: false })
        .limit(2000);

      if (error) throw error;

      const list = Array.isArray(data) ? data : [];
      const mine = list.filter(o => {
        const d = safeJson(o.data) || {};
        const pin = d?.transport?.pin || d?._audit?.created_by_pin || null;
        return String(pin || '') === String(me.pin);
      });

      setItems(mine);
    }catch(e){
      setErr(String(e?.message || e || 'Gabim'));
      setItems([]);
    }finally{
      setBusy(false);
    }
  }

  useEffect(() => { if (me?.pin) load(); }, [me?.pin]);

  return (
    <main className="wrap">
      <header className="top">
        <div>
          <div className="h1">TRANSPORT • GATI</div>
          <div className="sub">VETËM POROSITË E MIA</div>
        </div>
        <div className="row">
          <button className="btn ghost" onClick={load} disabled={busy}>{busy ? '...' : 'REFRESH'}</button>
          <Link className="btn ghost" href="/transport/menu">MENU</Link>
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
            <div className="t">LISTA</div>
            <div className="p muted">PIN: <b>{me.pin}</b> • {items.length} POROSI</div>
          </div>

          {items.map((o)=>(
            <div key={o.id} className="card rowline">
              <div className="left">
                <div className="t"><span className="code">{o.code}</span> • {o.client_name || 'KLIENT'}</div>
                <div className="p muted">{o.client_phone || ''}</div>
              </div>
              <Link className="btn" href={`/gati?id=${encodeURIComponent(o.id)}`}>HAP</Link>
            </div>
          ))}

          {!items.length && !err ? (
            <div className="card">
              <div className="p muted">S’ka porosi “GATI” për PIN-in tënd.</div>
            </div>
          ) : null}
        </>
      )}

      <style jsx>{`
        .err{ border-color: rgba(255,90,90,.35); background: rgba(255,60,60,.08); }
        .rowline{ display:flex; align-items:center; justify-content:space-between; gap:12px; }
        .left{ min-width:0; }
        .code{ display:inline-block; padding:2px 10px; border-radius:999px; background:#16a34a; color:#fff; }
        .muted{ opacity:.8; }
      `}</style>
    </main>
  );
}
