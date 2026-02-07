'use client';

import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabaseClient';
import { getActor } from '@/lib/actorSession';
import { getTransportSession } from '@/lib/transportAuth';

function fmtDateTime(d) {
  if (!d) return '';
  try {
    return new Date(d).toLocaleString('sq-AL', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
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

function getOrderData(o) {
  return jparse(o?.data, {}) || {};
}

function listQty(arr) {
  return (arr || []).reduce((acc, r) => acc + (Number(r?.qty) || 0), 0);
}

function piecesSummaryFromOrder(o) {
  const d = getOrderData(o);

  const pieces = Number(d?.pieces ?? d?.copa ?? d?.qty_total ?? 0) || 0;
  if (pieces > 0) return `${pieces} COPË`;

  const t = Array.isArray(d?.tepiha) ? d.tepiha : (Array.isArray(d?.tepihaRows) ? d.tepihaRows : []);
  const s = Array.isArray(d?.staza) ? d.staza : (Array.isArray(d?.stazaRows) ? d.stazaRows : []);
  const sumQty = (arr) => (arr || []).reduce((acc, r) => acc + (Number(r?.qty) || 0), 0);

  const stairsQty = Number(d?.shkallore?.qty ?? d?.stairsQty ?? 0) || 0;
  const total = sumQty(t) + sumQty(s) + (stairsQty > 0 ? 1 : 0);
  return total > 0 ? `${total} COPË` : '';
}

function m2TotalFromOrder(o) {
  const d = getOrderData(o);

  const t = Array.isArray(d?.tepiha) ? d.tepiha : (Array.isArray(d?.tepihaRows) ? d.tepihaRows : []);
  const s = Array.isArray(d?.staza) ? d.staza : (Array.isArray(d?.stazaRows) ? d.stazaRows : []);

  const sumM2 = (arr) => (arr || []).reduce((acc, r) => acc + (Number(r?.m2) || 0) * (Number(r?.qty) || 0), 0);

  const shQty = Number(d?.shkallore?.qty ?? d?.stairsQty ?? 0) || 0;
  const shPer = Number(d?.shkallore?.per ?? d?.stairsPer ?? 0.3) || 0.3;

  const v = Number((sumM2(t) + sumM2(s) + (shQty * shPer)).toFixed(2));
  return Number.isFinite(v) ? v : 0;
}

function totalEurFromOrder(o) {
  const d = getOrderData(o);
  const pay = d?.pay && typeof d.pay === 'object' ? d.pay : {};

  const euro = Number(pay?.euro ?? pay?.total ?? d?.total ?? d?.sum ?? d?.shuma ?? NaN);
  if (Number.isFinite(euro)) return Number(euro.toFixed(2));

  const rate = Number(pay?.rate ?? pay?.price ?? pay?.pricePerM2 ?? d?.price ?? d?.eur_per_m2 ?? 0) || 0;
  const m2 = m2TotalFromOrder(o);
  return Number((rate * m2).toFixed(2)) || 0;
}

function paidEurFromOrder(o) {
  const d = getOrderData(o);
  const pay = (d?.pay && typeof d.pay === 'object') ? d.pay : {};
  const paid = Number(pay?.paid);
  return Number.isFinite(paid) ? Number(paid.toFixed(2)) : 0;
}

export default function TransportFletorePage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [meta, setMeta] = useState(null);
  const [groups, setGroups] = useState([]);
  const [q, setQ] = useState('');
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
    setLoading(true);

    if (!ok) {
      setLoading(false);
      setError('NUK JE I KYÇUR — Shko te LOGIN dhe hyn me PIN.');
      return;
    }
    if (!transportId) {
      setLoading(false);
      setError('TRANSPORT SESSION MUNGON — Hape /TRANSPORT edhe provo prapë.');
      return;
    }

    try {
      const started = Date.now();

      const ordersQ = supabase
        .from('transport_orders')
        .select('id,created_at,updated_at,code_str,client_name,client_phone,status,data,transport_id')
        .eq('transport_id', transportId)
        .order('created_at', { ascending: false })
        .limit(5000);

      // Clients table is optional. If it fails, we still build from orders.
      const clientsQ = supabase
        .from('transport_clients')
        .select('id,full_name,phone,created_at,updated_at')
        .order('created_at', { ascending: true })
        .limit(5000);

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

      for (const o of orders) {
        const p = normPhone(o?.client_phone);
        if (!p) continue;
        if (!byPhone.has(p)) byPhone.set(p, { name: o?.client_name || '-', phone: p });
      }

      const out = [];
      for (const [phone, c] of byPhone.entries()) {
        let list = orders.filter((o) => normPhone(o?.client_phone) === phone);
        if (!list.length) continue;

        if (!showCompleted) {
          list = list.filter((o) => !['dorzim', 'done', 'completed'].includes(String(o?.status || '').toLowerCase()));
        }
        if (!list.length) continue;

        // newest first already from query order, but filter keeps order
        const last = list[0];
        const sumEur = list.reduce((a, o) => a + (totalEurFromOrder(o) || 0), 0);
        const sumPaid = list.reduce((a, o) => a + (paidEurFromOrder(o) || 0), 0);
        const sumM2 = list.reduce((a, o) => a + (m2TotalFromOrder(o) || 0), 0);

        out.push({
          phone,
          name: c?.name || '-',
          count: list.length,
          lastStatus: String(last?.status || '').toUpperCase() || '-',
          lastDate: last?.created_at || last?.updated_at || null,
          sumEur: Number(sumEur.toFixed(2)),
          sumPaid: Number(sumPaid.toFixed(2)),
          sumDebt: Number(Math.max(0, sumEur - sumPaid).toFixed(2)),
          sumM2: Number(sumM2.toFixed(2)),
          orders: list,
        });
      }

      out.sort((a, b) => new Date(b.lastDate || 0).getTime() - new Date(a.lastDate || 0).getTime());

      const tookMs = Date.now() - started;
      setGroups(out);
      setMeta({
        transportId,
        transportName,
        ordersCount: orders.length,
        clientsCount: out.length,
        loadedAt: new Date().toISOString(),
        tookMs,
      });

      setNotice(clientsRes?.error ? 'KUJDES: transport_clients nuk u lexua (po përdor vetëm orders).' : '');
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transportId, ok, showCompleted]);

  const filtered = useMemo(() => {
    const s = String(q || '').trim().toLowerCase();
    if (!s) return groups;
    return groups.filter((g) => {
      const phone = String(g.phone || '').toLowerCase();
      const name = String(g.name || '').toLowerCase();
      const codes = (g.orders || []).map((o) => String(o.code_str || '').toLowerCase()).join(' ');
      return phone.includes(s) || name.includes(s) || codes.includes(s);
    });
  }, [groups, q]);

  const totals = useMemo(() => {
    const sumEur = filtered.reduce((a, g) => a + (Number(g.sumEur) || 0), 0);
    const sumPaid = filtered.reduce((a, g) => a + (Number(g.sumPaid) || 0), 0);
    const sumDebt = filtered.reduce((a, g) => a + (Number(g.sumDebt) || 0), 0);
    const sumM2 = filtered.reduce((a, g) => a + (Number(g.sumM2) || 0), 0);
    return {
      eur: Number(sumEur.toFixed(2)),
      paid: Number(sumPaid.toFixed(2)),
      debt: Number(sumDebt.toFixed(2)),
      m2: Number(sumM2.toFixed(2)),
    };
  }, [filtered]);

  function doPrint() {
    try { window.print(); } catch {}
  }

  return (
    <div className="wrap">
      <style jsx global>{`
        @media print {
          .no-print { display: none !important; }
          body { background: #fff !important; color: #000 !important; }
          .card { box-shadow: none !important; border: 1px solid #ddd !important; }
          .btn, .pill { border: 1px solid #333 !important; color: #000 !important; }
          .title, .card-title { color: #000 !important; }
        }
      `}</style>

      <header className="header-row no-print">
        <div>
          <h1 className="title">FLETORJA • TRANSPORT</h1>
          <div className="subtitle">{transportName ? transportName.toLowerCase() : 'transport'} • ID {transportId || '-'}</div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <Link className="pill" href="/transport/menu">MENU</Link>
          <button className="pill" type="button" onClick={load} disabled={loading} style={{ opacity: loading ? 0.6 : 1 }}>
            {loading ? 'DUKE NGARKU...' : 'REFRESH'}
          </button>
          <button className="pill" type="button" onClick={doPrint}>📄 PDF</button>
        </div>
      </header>

      <section className="card no-print">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              className="input"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="KËRKO (EMËR / TEL / KOD)"
              style={{ minWidth: 220 }}
            />
            <label className="pill" style={{ cursor: 'pointer', userSelect: 'none' }}>
              <input
                type="checkbox"
                checked={showCompleted}
                onChange={(e) => setShowCompleted(e.target.checked)}
                style={{ marginRight: 8 }}
              />
              SHFAQ EDHE TË DORËZUARA
            </label>
          </div>

          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', fontWeight: 900 }}>
            <div>M²: {totals.m2}</div>
            <div>€ TOTAL: {totals.eur}</div>
            <div>€ PAGUAR: {totals.paid}</div>
            <div>€ BORXH: {totals.debt}</div>
          </div>
        </div>

        {notice ? <div className="muted" style={{ marginTop: 10 }}>{notice}</div> : null}
        {error ? <div style={{ marginTop: 10, color: '#ffb4b4', fontWeight: 900 }}>{error}</div> : null}
        {meta ? (
          <div className="muted" style={{ marginTop: 10 }}>
            KLIENTA: {meta.clientsCount} • POROSI: {meta.ordersCount} • NGARKUAR: {fmtDateTime(meta.loadedAt)}
          </div>
        ) : null}
      </section>

      {/* PRINT HEADER */}
      <section className="card" style={{ marginTop: 10 }}>
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <div>
            <div style={{ fontWeight: 1000, fontSize: 16 }}>FLETORJA — TRANSPORT</div>
            <div className="muted" style={{ marginTop: 4 }}>TRANSPORT: {transportName} • ID: {transportId || '-'}</div>
            <div className="muted">DATA: {fmtDateTime(new Date().toISOString())}</div>
          </div>
          <div style={{ textAlign: 'right', fontWeight: 900 }}>
            <div>€ TOTAL: {totals.eur}</div>
            <div>€ PAGUAR: {totals.paid}</div>
            <div>€ BORXH: {totals.debt}</div>
          </div>
        </div>
      </section>

      <section className="card" style={{ marginTop: 10 }}>
        {loading ? (
          <div className="muted">DUKE NGARKU...</div>
        ) : (
          <div style={{ display: 'grid', gap: 10 }}>
            {filtered.map((g) => (
              <div key={g.phone} style={{ padding: 10, border: '1px solid rgba(255,255,255,0.08)', borderRadius: 14 }}>
                <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
                  <div>
                    <div style={{ fontWeight: 1000 }}>{String(g.name || '-').toUpperCase()}</div>
                    <div className="muted">TEL: {g.phone}</div>
                  </div>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap', fontWeight: 900 }}>
                    <div>{g.count} POROSI</div>
                    <div>M² {g.sumM2}</div>
                    <div>€ {g.sumEur}</div>
                    <div>€ BORXH {g.sumDebt}</div>
                    <div style={{ opacity: 0.85 }}>{g.lastStatus}</div>
                    <div className="muted">{fmtDateTime(g.lastDate)}</div>
                  </div>
                </div>

                <div style={{ marginTop: 10, display: 'grid', gap: 6 }}>
                  {(g.orders || []).map((o) => (
                    <div key={o.id} className="row" style={{ justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', fontSize: 12 }}>
                      <div style={{ fontWeight: 1000 }}>{String(o.code_str || '').toUpperCase()}</div>
                      <div style={{ opacity: 0.9 }}>{piecesSummaryFromOrder(o)}</div>
                      <div style={{ opacity: 0.9 }}>M² {m2TotalFromOrder(o)}</div>
                      <div style={{ opacity: 0.9 }}>€ {totalEurFromOrder(o)}</div>
                      <div className="muted">{String(o.status || '').toUpperCase()}</div>
                      <div className="muted">{fmtDateTime(o.created_at || o.updated_at)}</div>
                    </div>
                  ))}
                </div>
              </div>
            ))}

            {!filtered.length ? <div className="muted">S’KA REZULTATE.</div> : null}
          </div>
        )}
      </section>

      <div className="no-print" style={{ height: 30 }} />
    </div>
  );
}
