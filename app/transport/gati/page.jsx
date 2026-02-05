'use client';

import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabaseClient';

function readActor() {
  try {
    const raw = localStorage.getItem('CURRENT_USER_DATA');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function normalizeCode(raw) {
  if (!raw) return '';
  const s = String(raw).trim();
  // Transport codes stored in DB as numeric offset to avoid collisions.
  const n0 = Number(s);
  if (Number.isFinite(n0) && n0 >= 1000000) return `T${n0 - 1000000}`;
  if (/^t\d+/i.test(s)) {
    const n = s.replace(/\D+/g, '').replace(/^0+/, '');
    return `T${n || '0'}`;
  }
  const n = s.replace(/\D+/g, '').replace(/^0+/, '');
  return n || '0';
}

function computePieces(order) {
  const t = order?.tepiha?.reduce((a, b) => a + (Number(b.qty) || 0), 0) || 0;
  const s = order?.staza?.reduce((a, b) => a + (Number(b.qty) || 0), 0) || 0;
  const shk = Number(order?.shkallore?.qty) > 0 ? 1 : 0;
  return t + s + shk;
}

export default function TransportGatiPage() {
  const [me, setMe] = useState(null);
  const [items, setItems] = useState([]);
  const [busy, setBusy] = useState(true);
  const [err, setErr] = useState('');

  useEffect(() => { setMe(readActor()); }, []);

  const role = String(me?.role || '').toUpperCase();
  const canSee = role === 'TRANSPORT' || role === 'ADMIN' || role === 'OWNER' || role === 'DISPATCH';

  const myPin = String(me?.pin || '');

  async function load() {
    setBusy(true);
    setErr('');
    try {
      // pull gati orders and filter locally (safe & simple)
      const { data, error } = await supabase
        .from('orders')
        .select('id, code, status, created_at, data')
        .eq('status', 'gati')
        .order('created_at', { ascending: false })
        .limit(300);

      if (error) throw error;

      const list = (data || []).map((r) => ({
        id: r.id,
        code: normalizeCode(r.code || r.data?.code || ''),
        status: r.status,
        created_at: r.created_at,
        order: r.data || {},
        transport_pin: String(r.data?.transport_pin || ''),
        transport_id: String(r.data?.transport_id || ''),
      }))
      .filter((x) => /^T\d+$/i.test(x.code))
      .filter((x) => {
        // TRANSPORT role sees only their own orders.
        if (String(me?.role || '').toUpperCase() === 'TRANSPORT') {
          return myPin && x.transport_pin === myPin;
        }
        return true;
      });

      setItems(list);
    } catch (e) {
      setErr(String(e?.message || e || 'Gabim'));
      setItems([]);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!canSee) return;
    load();
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canSee]);

  return (
    <main className="wrap">
      <header className="header-row">
        <div>
          <h1 className="title">TRANSPORT • GATI</h1>
          <div className="subtitle">SHFAQ VETËM POROSITË E TUA (T)</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Link className="pill" href="/transport">MENU</Link>
          <Link className="pill" href="/">HOME</Link>
        </div>
      </header>

      {!me ? (
        <section className="card">
          <div className="muted">NUK JE I KYÇUR • SHKO TE LOGIN</div>
          <Link className="btn" href="/login">LOGIN</Link>
        </section>
      ) : !canSee ? (
        <section className="card">
          <div className="muted">S’KE LEJE</div>
          <Link className="btn" href="/">KTHEHU HOME</Link>
        </section>
      ) : (
        <>
          {err ? <section className="card"><div className="muted">{err}</div></section> : null}

          <section className="card">
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <div className="t">POROSI GATI (T)</div>
              <Link className="btn" href="/transport/pranim">+ PRANIMI</Link>
            </div>

            {busy ? <div className="muted" style={{ paddingTop: 10 }}>Loading…</div> : null}

            {!busy && items.length === 0 ? (
              <div className="muted" style={{ paddingTop: 10 }}>S’KA POROSI GATI PËR TY.</div>
            ) : null}

            <div className="list">
              {items.map((it) => {
                const o = it.order || {};
                const clientName = o?.client?.name || it.code;
                const pieces = computePieces(o);
                const total = Number(o?.pay?.euro || 0);
                return (
                  <div key={it.id} className="row" style={{ justifyContent: 'space-between', gap: 10, padding: '10px 0' }}>
                    <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                      <span className="pill" style={{ background: '#16a34a' }}>{it.code}</span>
                      <div>
                        <div style={{ fontWeight: 700 }}>{clientName}</div>
                        <div className="muted">{pieces} COPË • €{total.toFixed(2)}</div>
                      </div>
                    </div>
                    <Link className="btn ghost" href={`/gati?id=${it.id}`}>HAP</Link>
                  </div>
                );
              })}
            </div>
          </section>
        </>
      )}
    </main>
  );
}
