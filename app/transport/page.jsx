'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabaseClient';

function normalizeCode(raw) {
  if (!raw) return '';
  const s = String(raw).trim();
  if (/^t\d+/i.test(s)) {
    const n = s.replace(/\D+/g, '').replace(/^0+/, '');
    return `T${n || '0'}`;
  }
  const n = s.replace(/\D+/g, '').replace(/^0+/, '');
  return n || '0';
}

function computeM2(order) {
  if (!order) return 0;
  let total = 0;
  if (Array.isArray(order.tepiha)) {
    for (const r of order.tepiha) total += (Number(r?.m2) || 0) * (Number(r?.qty) || 0);
  }
  if (Array.isArray(order.staza)) {
    for (const r of order.staza) total += (Number(r?.m2) || 0) * (Number(r?.qty) || 0);
  }
  if (order.shkallore) total += (Number(order.shkallore.qty) || 0) * (Number(order.shkallore.per) || 0);
  return Number(total.toFixed(2));
}

function computeCope(order) {
  if (!order) return 0;
  const t = Array.isArray(order.tepiha) ? order.tepiha.reduce((a, r) => a + (Number(r?.qty) || 0), 0) : 0;
  const s = Array.isArray(order.staza) ? order.staza.reduce((a, r) => a + (Number(r?.qty) || 0), 0) : 0;
  const shk = Number(order?.shkallore?.qty) > 0 ? 1 : 0;
  return Number(t + s + shk) || 0;
}

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

  const out = [];

  if (normalRes?.error) console.error('GLOBAL PASTRIMI orders', normalRes.error);
  if (transRes?.error) console.error('GLOBAL PASTRIMI transport_orders', transRes.error);

  for (const row of normalRes?.data || []) {
    let raw = row.data;
    if (typeof raw === 'string') {
      try { raw = JSON.parse(raw); } catch { raw = {}; }
    }
    const o = raw || {};
    // normalize old shapes
    if (!Array.isArray(o.tepiha) && Array.isArray(o.tepihaRows)) {
      o.tepiha = o.tepihaRows.map(r => ({ m2: Number(r?.m2) || 0, qty: Number(r?.qty || r?.pieces) || 0 }));
    }
    if (!Array.isArray(o.staza) && Array.isArray(o.stazaRows)) {
      o.staza = o.stazaRows.map(r => ({ m2: Number(r?.m2) || 0, qty: Number(r?.qty || r?.pieces) || 0 }));
    }
    const m2 = computeM2(o);
    const cope = computeCope(o);
    const total = Number(o?.pay?.euro || o?.total || 0) || 0;
    const code = normalizeCode(o?.client?.code || o?.code || row.code);
    out.push({ id: row.id, source: 'orders', created_at: row.created_at, code, cope, m2, total });
  }

  for (const row of transRes?.data || []) {
    let raw = row.data;
    if (typeof raw === 'string') {
      try { raw = JSON.parse(raw); } catch { raw = {}; }
    }
    const o = raw || {};
    if (!Array.isArray(o.tepiha) && Array.isArray(o.tepihaRows)) {
      o.tepiha = o.tepihaRows.map(r => ({ m2: Number(r?.m2) || 0, qty: Number(r?.qty || r?.pieces) || 0 }));
    }
    if (!Array.isArray(o.staza) && Array.isArray(o.stazaRows)) {
      o.staza = o.stazaRows.map(r => ({ m2: Number(r?.m2) || 0, qty: Number(r?.qty || r?.pieces) || 0 }));
    }
    const m2 = computeM2(o);
    const cope = computeCope(o);
    const total = Number(o?.pay?.euro || o?.total || 0) || 0;
    const code = normalizeCode(o?.code_str || o?.code || row.code_str);
    out.push({ id: row.id, source: 'transport_orders', created_at: row.created_at, code, cope, m2, total });
  }

  return out;
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
  const [globalPastrimi, setGlobalPastrimi] = useState([]);
  const [globalBusy, setGlobalBusy] = useState({ count: 0, m2: 0, score: 0, level: '...' });
  const [refreshing, setRefreshing] = useState(false);

  async function refreshGlobalPastrimi() {
    setRefreshing(true);
    try {
      const rows = await loadGlobalPastrimi();
      setGlobalPastrimi(rows);

      const count = rows.length;
      const m2 = rows.reduce((s, r) => s + (Number(r.m2) || 0), 0);
      const score = (count * 1) + (m2 * 0.4);
      const level = scoreToLevel(score);

      setGlobalBusy({ count, m2, score, level });
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
              <Link className="pill" href="/">HOME</Link>
            </div>

            <div style={{ height: 10 }} />
            <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
              <Link className="btn btn-primary" href="/transport/pranimi">PRANIMI (TRANSPORT)</Link>
              <Link className="btn" href="/transport/gati">GATI (TRANSPORT)</Link>
              <Link className="btn" href="/transport/arka">ARKA (TRANSPORT)</Link>
              <Link className="btn" href="/pastrimi">PASTRIMI (PËRBASHKËT)</Link>
            </div>

            <div style={{ marginTop: 14, opacity: 0.92 }}>
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
                <div style={{ fontWeight: 900 }}>GLOBAL PASTRIMI (KAPACITET)</div>
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

              <div style={{ display: 'flex', gap: 12, fontSize: 13, margin: '8px 0 6px 0' }}>
                <div>AKTIVE: <b>{globalBusy.count}</b></div>
                <div>M²: <b>{Number(globalBusy.m2 || 0).toFixed(1)}</b></div>
                <div>
                  NGARKESA:{' '}
                  {globalBusy.level === 'LOW' && '🟢 LEHTE'}
                  {globalBusy.level === 'MID' && '🟠 MESATARE'}
                  {globalBusy.level === 'HIGH' && '🔴 E LARTE'}
                </div>
                <div style={{ opacity: 0.75 }}>SCORE: <b>{Number(globalBusy.score || 0).toFixed(1)}</b></div>
              </div>

              {globalBusy.level === 'HIGH' && (
                <div style={{ marginBottom: 8, fontSize: 13, fontWeight: 800 }}>
                  TRANSPORT: PRANO ME KUJDES
                </div>
              )}

              {globalPastrimi.length === 0 && (
                <div style={{ opacity: 0.6 }}>ASNJE POROSI NE PASTRIM</div>
              )}

              {globalPastrimi.map(o => (
                <div
                  key={`${o.source}_${o.id}`}
                  style={{
                    display: 'flex',
                    gap: 10,
                    fontSize: 13,
                    padding: '4px 0',
                    borderBottom: '1px solid #222'
                  }}
                >
                  <div style={{ width: 46 }}>{o.code}</div>
                  <div style={{ width: 56 }}>{o.cope || 0} copë</div>
                  <div style={{ width: 70 }}>{Number(o.m2 || 0).toFixed(1)} m²</div>
                  <div>€{Number(o.total || 0).toFixed(2)}</div>
                </div>
              ))}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
