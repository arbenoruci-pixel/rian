'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabaseClient';

function scoreToLevel(score) {
  if (score > 24) return 'HIGH';
  if (score >= 12) return 'MID';
  return 'LOW';
}

async function loadGlobalPastrimi() {
  // Read-only capacity view: merge NORMAL + TRANSPORT pastrim
  const [normalRes, transRes] = await Promise.all([
    supabase
      .from('orders')
      .select('id,created_at,data,code,status')
      .eq('status', 'pastrim')
      .order('created_at', { ascending: true })
      .limit(300),
    supabase
      .from('transport_orders')
      .select('id,created_at,data,code_str,status')
      .eq('status', 'pastrim')
      .order('created_at', { ascending: true })
      .limit(300),
  ]);

  if (normalRes?.error) console.error('GLOBAL PASTRIMI orders', normalRes.error);
  if (transRes?.error) console.error('GLOBAL PASTRIMI transport_orders', transRes.error);

  // We only need totals for capacity (not per-order details)
  const rows = [];
  for (const row of normalRes?.data || []) rows.push({ source: 'orders', id: row.id, data: row.data });
  for (const row of transRes?.data || []) rows.push({ source: 'transport_orders', id: row.id, data: row.data });

  // Compute m2 roughly (same logic as before) to build a capacity score
  let m2 = 0;
  for (const r of rows) {
    let raw = r.data;
    if (typeof raw === 'string') {
      try { raw = JSON.parse(raw); } catch { raw = {}; }
    }
    const o = raw || {};

    // normalize old shapes
    const tepiha = Array.isArray(o.tepiha)
      ? o.tepiha
      : Array.isArray(o.tepihaRows)
        ? o.tepihaRows.map(x => ({ m2: Number(x?.m2) || 0, qty: Number(x?.qty || x?.pieces) || 0 }))
        : [];

    const staza = Array.isArray(o.staza)
      ? o.staza
      : Array.isArray(o.stazaRows)
        ? o.stazaRows.map(x => ({ m2: Number(x?.m2) || 0, qty: Number(x?.qty || x?.pieces) || 0 }))
        : [];

    for (const x of tepiha) m2 += (Number(x?.m2) || 0) * (Number(x?.qty) || 0);
    for (const x of staza) m2 += (Number(x?.m2) || 0) * (Number(x?.qty) || 0);

    if (o.shkallore) {
      m2 += (Number(o.shkallore.qty) || 0) * (Number(o.shkallore.per) || 0);
    }
  }

  m2 = Number(m2.toFixed(1));
  const count = rows.length;
  const score = (count * 1) + (m2 * 0.4);
  const level = scoreToLevel(score);

  return { count, m2, score, level };
}

function readActor() {
  try {
    const raw = localStorage.getItem('CURRENT_USER_DATA');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export default function TransportHome() {
  const [me, setMe] = useState(null);
  const [busy, setBusy] = useState({ count: 0, m2: 0, score: 0, level: '...' });
  const [refreshing, setRefreshing] = useState(false);

  async function refreshGlobalPastrimi() {
    setRefreshing(true);
    try {
      const v = await loadGlobalPastrimi();
      setBusy(v);
    } finally {
      setRefreshing(false);
    }
  }

  useEffect(() => {
    setMe(readActor());
    refreshGlobalPastrimi();

    const t = setInterval(() => {
      refreshGlobalPastrimi();
    }, 30000);

    return () => clearInterval(t);
  }, []);

  const role = String(me?.role || '').toUpperCase();
  const ok = role === 'TRANSPORT' || role === 'OWNER' || role === 'ADMIN' || role === 'DISPATCH';

  return (
    <div className="wrap">
      <header className="header-row">
        <div>
          <h1 className="title">TRANSPORT</h1>
          <div className="subtitle">HYRJE ME PIN</div>
        </div>
        {/* Vetem 1 HOME */}
        <Link className="pill" href="/">HOME</Link>
      </header>

      <section className="card">
        {!ok ? (
          <>
            <div className="muted" style={{ marginBottom: 10 }}>
              NUK JE I KYÇUR — Shko te LOGIN dhe hyn me PIN.
            </div>
            <Link className="btn btn-primary" href="/login">LOGIN</Link>
          </>
        ) : (
          <>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div className="label">PËRDORUESI</div>
                <div style={{ fontWeight: 800 }}>{String(me?.name || '').toUpperCase()}</div>
                <div className="muted">{role}</div>
              </div>
            </div>

            <div style={{ height: 10 }} />
            <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
              <Link className="btn btn-primary" href="/transport/pranimi">PRANIMI (TRANSPORT)</Link>
              <Link className="btn" href="/transport/gati">GATI (TRANSPORT)</Link>
              <Link className="btn" href="/transport/arka">ARKA (TRANSPORT)</Link>
              <Link className="btn" href="/pastrimi">PASTRIMI (PËRBASHKËT)</Link>
            </div>

            {/* KAPACITETI: vetëm ngarkesa, pa listë / m² / numra */}
            <div style={{ marginTop: 16, opacity: 0.92 }}>
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
                <div style={{ fontWeight: 900 }}>KAPACITETI I PASTRIMIT</div>
                <button
                  className="pill"
                  type="button"
                  onClick={refreshGlobalPastrimi}
                  disabled={refreshing}
                  style={{ cursor: refreshing ? 'not-allowed' : 'pointer', opacity: refreshing ? 0.6 : 1 }}
                >
                  {refreshing ? 'REFRESH...' : 'REFRESH'}
                </button>
              </div>

              <div style={{ display: 'flex', gap: 10, alignItems: 'center', fontSize: 15, marginTop: 10, fontWeight: 900 }}>
                <div>NGARKESA:</div>
                {busy.level === 'LOW' && <div>🟢 LEHTE</div>}
                {busy.level === 'MID' && <div>🟠 MESATARE</div>}
                {busy.level === 'HIGH' && <div>🔴 E LARTE</div>}
                {busy.level === '...' && <div style={{ opacity: 0.7 }}>...</div>}
              </div>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
