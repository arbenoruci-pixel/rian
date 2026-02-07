'use client';

import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabaseClient';
import { getActor } from '@/lib/actorSession';
import { getTransportSession } from '@/lib/transportAuth';

function fmtDateTime(d) {
  if (!d) return '';
  try {
    return new Date(d).toLocaleString('sq-AL', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch {
    return String(d);
  }
}

function fmtDate(d) {
  if (!d) return '';
  try {
    return new Date(d).toLocaleDateString('sq-AL', { day: '2-digit', month: '2-digit' });
  } catch {
    return String(d);
  }
}

function jparse(v, fallback) {
  try {
    if (v && typeof v === 'object') return v;
    return JSON.parse(String(v));
  } catch {
    return fallback;
  }
}

function normPhone(v) {
  return String(v || '').replace(/\D+/g, '');
}

function normCodeN(v) {
  const n = String(v ?? '').replace(/\D+/g, '').replace(/^0+/, '');
  return n || '';
}

function getOrderData(o) {
  return jparse(o?.data, {}) || {};
}

function piecesSummaryFromOrder(o) {
  const d = getOrderData(o);
  const pieces = Number(d?.pieces ?? d?.copa ?? d?.qty_total ?? 0) || 0;
  if (pieces > 0) return `${pieces} COPË`;

  const t = Array.isArray(d?.tepihaRows) ? d.tepihaRows : (Array.isArray(d?.tepiha) ? d.tepiha : []);
  const s = Array.isArray(d?.stazaRows) ? d.stazaRows : (Array.isArray(d?.staza) ? d.staza : []);
  const sumQty = (arr) => (arr || []).reduce((acc, r) => acc + (Number(r?.qty) || 0), 0);
  const total = sumQty(t) + sumQty(s) + (Number(d?.stairsQty) || 0);
  return total > 0 ? `${total} COPË` : '';
}

function m2TotalFromOrder(o) {
  const d = getOrderData(o);
  // transport data uses tepihaRows/stazaRows + shkallore
  const t = (Array.isArray(d?.tepihaRows) ? d.tepihaRows : []).reduce((a, r) => a + (Number(r?.m2) || 0) * (Number(r?.qty) || 0), 0);
  const s = (Array.isArray(d?.stazaRows) ? d.stazaRows : []).reduce((a, r) => a + (Number(r?.m2) || 0) * (Number(r?.qty) || 0), 0);
  const sh = (Number(d?.stairsQty) || 0) * (Number(d?.stairsPer) || 0.3);
  const v = Number((t + s + sh).toFixed(2));
  return Number.isFinite(v) ? v : 0;
}

function totalEurFromOrder(o) {
  const d = getOrderData(o);
  const pay = d?.pay && typeof d.pay === 'object' ? d.pay : {};
  const total = Number(pay?.total ?? d?.total ?? d?.sum ?? d?.shuma ?? NaN);
  if (Number.isFinite(total)) return total;
  const price = Number(pay?.pricePerM2 ?? d?.price ?? d?.eur_per_m2 ?? 0) || 0;
  const m2 = m2TotalFromOrder(o);
  return Number((price * m2).toFixed(2)) || 0;
}

export default function TransportFletorePage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [meta, setMeta] = useState(null);
  const [rows, setRows] = useState([]);
  const [q, setQ] = useState('');
  const [running, setRunning] = useState(false);
  const [showCompleted, setShowCompleted] = useState(false);

  const actor = useMemo(() => {
    try { return getActor(); } catch { return null; }
  }, []);

  const session = useMemo(() => {
    try { return getTransportSession(); } catch { return null; }
  }, [actor?.pin, actor?.role]);

  const transportId = String(session?.transport_id || '').trim();
  const transportName = String(session?.transport_name || session?.name || actor?.name || 'TRANSPORT').trim();

  const ok = useMemo(() => {
    const role = String(actor?.role || '').toUpperCase();
    return role === 'TRANSPORT' || role === 'OWNER' || role === 'ADMIN' || role === 'DISPATCH';
  }, [actor?.role]);

  async function load() {
    setError('');
    setNotice('');
    setRunning(true);
    setLoading(true);

    if (!ok) {
      setLoading(false);
      setRunning(false);
      setError('NUK JE I KYÇUR — Shko te LOGIN dhe hyn me PIN.');
      return;
    }
    if (!transportId) {
      setLoading(false);
      setRunning(false);
      setError('TRANSPORT SESSION MUNGON — Hape /TRANSPORT edhe provo prapë.');
      return;
    }

    try {
      const started = Date.now();

      // 1) Orders for this transport only
      const ordersQ = supabase
        .from('transport_orders')
        .select('id,created_at,updated_at,code_n,code_str,client_name,client_phone,status,data,transport_id')
        .eq('transport_id', transportId)
        .order('created_at', { ascending: false })
        .limit(4000);

      // 2) Clients table (optional; fallback is orders list)
      const clientsQ = supabase
        .from('transport_clients')
        .select('id,full_name,phone,created_at,updated_at')
        .order('created_at', { ascending: true })
        .limit(4000);

      const [ordersRes, clientsRes] = await Promise.all([ordersQ, clientsQ]);

      if (ordersRes?.error) throw ordersRes.error;

      const orders = ordersRes?.data || [];
      const clients = (clientsRes && !clientsRes.error) ? (clientsRes.data || []) : [];

      const byPhone = new Map();
      for (const c of clients) {
        const p = normPhone(c?.phone);
        if (!p) continue;
        byPhone.set(p, { name: c?.full_name || '-', phone: p });
      }

      // Merge: ensure every order phone exists as a client in map
      for (const o of orders) {
        const p = normPhone(o?.client_phone);
        if (!p) continue;
        if (!byPhone.has(p)) {
          byPhone.set(p, { name: o?.client_name || '-', phone: p });
        }
      }

      // Group orders per client phone
      const groups = [];
      for (const [phone, c] of byPhone.entries()) {
        const list = orders.filter((o) => normPhone(o?.client_phone) === phone);
        if (!list.length) continue;

        // Completed means dorzim or completed/done variants
        const filtered = showCompleted ? list : list.filter((o) => !['dorzim', 'done', 'completed'].includes(String(o?.status || '').toLowerCase()));

        if (!filtered.length) continue;

        const last = filtered[0];
        const sumEur = filtered.reduce((a, o) => a + (totalEurFromOrder(o) || 0), 0);
        const sumM2 = filtered.reduce((a, o) => a + (m2TotalFromOrder(o) || 0), 0);

        groups.push({
          phone,
          name: c?.name || '-',
          count: filtered.length,
          lastStatus: String(last?.status || '').toUpperCase() || '-',
          lastDate: last?.created_at || last?.updated_at || null,
          sumEur: Number(sumEur.toFixed(2)),
          sumM2: Number(sumM2.toFixed(2)),
          orders: filtered,
        });
      }

      // Sort: newest activity first
      groups.sort((a, b) => new Date(b.lastDate || 0).getTime() - new Date(a.lastDate || 0).getTime());

      const tookMs = Date.now() - started;
      setRows(groups);
      setMeta({
        transportId,
        transportName,
        ordersCount: orders.length,
        clientsCount: groups.length,
        loadedAt: new Date().toISOString(),
        tookMs,
      });
      setNotice(clientsRes?.error ? 'KUJDES: transport_clients nuk u lexua (po përdor vetëm orders).' : '');
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setLoading(false);
      setRunning(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transportId, ok, showCompleted]);

  const filtered = useMemo(() => {
    const qq = String(q || '').trim().toLowerCase();
    if (!qq) return rows;

    return (rows || []).filter((r) => {
      const phone = String(r.phone || '');
      const name = String(r.name || '').toLowerCase();
      const codes = (r.orders || []).map((o) => String(o.code_str || o.code_n || '')).join(' ').toLowerCase();
      return name.includes(qq) || phone.includes(qq) || codes.includes(qq);
    });
  }, [rows, q]);

  return (
    <div style={{ padding: 20, fontFamily: 'Arial', color: '#f2f2f2' }}>
      {/* HEADER & CONTROLS (Nuk printohen) */}
      <div className="no-print">
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 22, letterSpacing: 1 }}>FLETORJA — TRANSPORT</h1>
            <div style={{ opacity: 0.85, fontWeight: 700 }}>{transportName ? transportName.toUpperCase() : 'TRANSPORT'} • ID: {transportId || '-'}</div>
            <div style={{ opacity: 0.75, marginTop: 4, fontSize: 13 }}>
              {meta?.loadedAt ? `E NGARKUAR: ${fmtDateTime(meta.loadedAt)}` : ''}
              {meta?.tookMs ? ` • ${meta.tookMs}ms` : ''}
            </div>
          </div>

          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <Link className="pill" href="/transport/menu">MENU</Link>
            <Link className="pill" href="/transport">TRANSPORT</Link>
            <Link className="pill" href="/">HOME</Link>
            <button
              onClick={() => window.print()}
              style={{ padding: '10px 14px', backgroundColor: '#444', color: '#fff', cursor: 'pointer', border: '1px solid #666', borderRadius: 10, fontWeight: 800 }}
              title="Ruaje si PDF (Print → Save as PDF)"
            >
              📄 PDF
            </button>
          </div>
        </div>

        <div style={{ marginTop: 14, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="KËRKO: EMËR / TEL / KOD"
            style={{ padding: 10, minWidth: 260, borderRadius: 10, border: '1px solid #555', background: '#111', color: '#fff', fontWeight: 800 }}
          />
          <button
            onClick={load}
            disabled={running}
            style={{ padding: '10px 14px', borderRadius: 10, border: '1px solid #666', background: '#222', color: '#fff', fontWeight: 900, cursor: running ? 'not-allowed' : 'pointer', opacity: running ? 0.7 : 1 }}
          >
            {running ? 'DUKE NGARKUAR…' : 'REFRESH'}
          </button>

          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 900 }}>
            <input type="checkbox" checked={showCompleted} onChange={(e) => setShowCompleted(e.target.checked)} />
            SHFAQ EDHE TË DORËZUARA
          </label>

          <div style={{ marginLeft: 'auto', opacity: 0.9, fontWeight: 800 }}>
            {meta ? `${meta.clientsCount || 0} KLIENTË • ${meta.ordersCount || 0} POROSI (TË MIAT)` : ''}
          </div>
        </div>

        {notice ? <div style={{ marginTop: 10, color: '#ffd54a', fontWeight: 800 }}>{notice}</div> : null}
        {error ? <div style={{ marginTop: 10, color: '#ff6b6b', fontWeight: 800 }}>{error}</div> : null}
      </div>

      {/* PRINT CONTENT */}
      <div style={{ marginTop: 16 }}>
        {loading ? (
          <div style={{ opacity: 0.8, fontWeight: 800 }}>DUKE NGARKUAR…</div>
        ) : (
          <>
            {(filtered || []).map((c) => (
              <div
                key={c.phone}
                style={{
                  background: '#0d0d0d',
                  border: '1px solid #333',
                  borderRadius: 14,
                  padding: 14,
                  marginBottom: 12,
                  pageBreakInside: 'avoid',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
                  <div style={{ fontSize: 16, fontWeight: 900, letterSpacing: 0.5 }}>
                    {String(c.name || '-').toUpperCase()} <span style={{ opacity: 0.85 }}>({c.phone})</span>
                  </div>
                  <div style={{ fontWeight: 900, opacity: 0.9 }}>
                    {c.count} POROSI • {c.sumM2}m² • €{c.sumEur}
                  </div>
                </div>

                <div style={{ marginTop: 10, borderTop: '1px solid #222', paddingTop: 10 }}>
                  {(c.orders || []).slice(0, 30).map((o) => {
                    const codeStr = String(o?.code_str || '').trim();
                    const codeN = normCodeN(o?.code_n);
                    const code = codeStr || (codeN ? `T${codeN}` : '-');
                    const st = String(o?.status || '').toUpperCase() || '-';
                    const dt = fmtDate(o?.created_at || o?.updated_at);
                    const pcs = piecesSummaryFromOrder(o);
                    const m2 = m2TotalFromOrder(o);
                    const eur = totalEurFromOrder(o);

                    return (
                      <div key={o.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, padding: '6px 0', borderBottom: '1px dashed #1d1d1d' }}>
                        <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
                          <div style={{ fontWeight: 900, minWidth: 52 }}>{code}</div>
                          <div style={{ opacity: 0.9, fontWeight: 800 }}>{dt}</div>
                          <div style={{ opacity: 0.9, fontWeight: 900 }}>{st}</div>
                          {pcs ? <div style={{ opacity: 0.85, fontWeight: 800 }}>{pcs}</div> : null}
                        </div>
                        <div style={{ fontWeight: 900, opacity: 0.9 }}>
                          {m2 ? `${m2}m²` : ''} {eur ? ` • €${Number(eur).toFixed(2)}` : ''}
                        </div>
                      </div>
                    );
                  })}

                  {(c.orders || []).length > 30 ? (
                    <div style={{ marginTop: 8, opacity: 0.75, fontWeight: 800 }}>
                      + {c.orders.length - 30} POROSI TË TJERA (NË PDF KUFIZOJME 30 RRESHTA PËR KLIENT)
                    </div>
                  ) : null}
                </div>
              </div>
            ))}

            {(!filtered || filtered.length === 0) && !error ? (
              <div style={{ opacity: 0.8, fontWeight: 800 }}>S’KA TË DHËNA.</div>
            ) : null}
          </>
        )}
      </div>

      {/* PRINT STYLES */}
      <style jsx>{`
        @media print {
          .no-print { display: none !important; }
          body { background: white; -webkit-print-color-adjust: exact; color-adjust: exact; }
          div { color: #000 !important; }
        }
      `}</style>
    </div>
  );
}
