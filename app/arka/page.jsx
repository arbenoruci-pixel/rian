'use client';

import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';

function normalizeCode(raw) {
  if (!raw) return '';
  const n = String(raw).replace(/^X/i, '').replace(/^0+/, '');
  return n || '0';
}

function formatCode(raw) {
  const n = normalizeCode(raw);
  return n || '?';
}

function isSameDay(ts, now) {
  if (!ts) return false;
  const d = new Date(ts);
  const n = new Date(now);
  return (
    d.getFullYear() === n.getFullYear() &&
    d.getMonth() === n.getMonth() &&
    d.getDate() === n.getDate()
  );
}

function loadAllLocalOrders() {
  if (typeof window === 'undefined') return [];
  let list = [];
  try {
    const raw = JSON.parse(localStorage.getItem('order_list_v1') || '[]');
    list = Array.isArray(raw) ? raw : [];
  } catch {
    list = [];
  }
  if (!Array.isArray(list)) return [];

  const result = [];
  for (const entry of list) {
    try {
      const rawOrder = localStorage.getItem(`order_${entry.id}`);
      if (!rawOrder) continue;
      const order = JSON.parse(rawOrder);
      if (!order || !order.id) continue;
      result.push(order);
    } catch {
    }
  }
  return result;
}

function getPay(order) {
  const p = order?.pay || {};
  return {
    euro: Number(p.euro) || 0,
    paid: Number(p.paid) || 0,
    debt: Number(p.debt) || 0,
  };
}

export default function ArkaPage() {
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);

  function refresh() {
    try {
      setLoading(true);
      const all = loadAllLocalOrders();
      setOrders(all);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  const { todayDelivered, todayTotals, allTotals } = useMemo(() => {
    const now = Date.now();
    const delivered = [];
    let today = { euro: 0, paid: 0, debt: 0 };
    let all = { euro: 0, paid: 0, debt: 0 };

    for (const o of orders) {
      if (o.status !== 'dorzim') continue;
      const pay = getPay(o);
      all.euro += pay.euro;
      all.paid += pay.paid;
      all.debt += pay.debt;

      if (isSameDay(o.deliveredAt || o.readyAt || o.ts, now)) {
        today.euro += pay.euro;
        today.paid += pay.paid;
        today.debt += pay.debt;
        delivered.push(o);
      }
    }

    return {
      todayDelivered: delivered,
      todayTotals: today,
      allTotals: all,
    };
  }, [orders]);

  return (
    <div className="wrap">
      <header className="header-row">
        <div>
          <h1 className="title">ARKA</h1>
          <div className="subtitle">PAGESAT &amp; BORXHET</div>
        </div>
        <div>
          <button
            type="button"
            className="btn secondary"
            style={{ padding: '4px 10px', fontSize: 12 }}
            onClick={refresh}
          >
            🔄 Rifresko
          </button>
        </div>
      </header>

      <section className="card">
        {loading && <p>Duke llogaritur...</p>}
        {!loading && (
          <>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <div>
                <div style={{ fontSize: 12, opacity: 0.8 }}>SOT • TOTAL FATURE</div>
                <div style={{ fontSize: 20, fontWeight: 700 }}>
                  {todayTotals.euro.toFixed(2)} €
                </div>
              </div>
              <div>
                <div style={{ fontSize: 12, opacity: 0.8 }}>SOT • PAGUAR CASH</div>
                <div style={{ fontSize: 16, fontWeight: 600 }}>
                  {todayTotals.paid.toFixed(2)} €
                </div>
              </div>
              <div>
                <div style={{ fontSize: 12, opacity: 0.8 }}>SOT • BORXH</div>
                <div style={{ fontSize: 16, fontWeight: 600 }}>
                  {todayTotals.debt.toFixed(2)} €
                </div>
              </div>
            </div>

            <hr style={{ margin: '12px 0', borderColor: 'rgba(255,255,255,0.08)' }} />

            <div className="row" style={{ justifyContent: 'space-between', fontSize: 12 }}>
              <div style={{ opacity: 0.8 }}>TOTAL HISTORIK FATURE</div>
              <div style={{ fontWeight: 600 }}>{allTotals.euro.toFixed(2)} €</div>
            </div>
            <div className="row" style={{ justifyContent: 'space-between', fontSize: 12 }}>
              <div style={{ opacity: 0.8 }}>TOTAL HISTORIK PAGUAR</div>
              <div style={{ fontWeight: 600 }}>{allTotals.paid.toFixed(2)} €</div>
            </div>
            <div className="row" style={{ justifyContent: 'space-between', fontSize: 12 }}>
              <div style={{ opacity: 0.8 }}>TOTAL HISTORIK BORXH</div>
              <div style={{ fontWeight: 600 }}>{allTotals.debt.toFixed(2)} €</div>
            </div>
          </>
        )}
      </section>

      <section className="card">
        <h2 className="card-title">MARRJE SOT</h2>
        {loading && <p>Duke lexuar porositë...</p>}
        {!loading && todayDelivered.length === 0 && <p>Nuk ka porosi të marra sot.</p>}

        {!loading &&
          todayDelivered.map((o) => {
            const pay = getPay(o);
            return (
              <div
                key={o.id}
                className="home-btn"
                style={{
                  marginBottom: 8,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 8,
                }}
              >
                <div
                  style={{
                    flex: 1,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'flex-start',
                    gap: 12,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  <span
                    style={{
                      fontWeight: 700,
                      fontSize: 14,
                      padding: '2px 8px',
                      borderRadius: 4,
                      backgroundColor: '#16a34a',
                      color: '#ffffff',
                      minWidth: 32,
                      textAlign: 'center',
                    }}
                  >
                    {formatCode(o.client?.code)}
                  </span>
                  <span>{o.client?.name || 'Pa emër'}</span>
                  <span style={{ fontSize: 12, opacity: 0.8 }}>
                    {pay.euro.toFixed(2)} € • pagoi {pay.paid.toFixed(2)} € • borxh{' '}
                    {pay.debt.toFixed(2)} €
                  </span>
                </div>
              </div>
            );
          })}
      </section>

      <footer className="footer-bar">
        <Link className="btn secondary" href="/">
          🏠 HOME
        </Link>
      </footer>
    </div>
  );
}
