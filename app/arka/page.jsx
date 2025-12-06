'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';

function loadOrdersIndex() {
  if (typeof window === 'undefined') return [];
  try {
    const list = JSON.parse(localStorage.getItem('order_list_v1') || '[]');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function loadOrderById(id) {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(`order_${id}`);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export default function Page() {
  const [rows, setRows] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [selectedOrder, setSelectedOrder] = useState(null);
  const [totals, setTotals] = useState({ euro: 0, paid: 0, debt: 0 });

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const idx = loadOrdersIndex();
    const enriched = idx.map((entry) => {
      const full = loadOrderById(entry.id) || {};
      const pay = full.pay || {};
      const euroVal =
        typeof pay.euro === 'number' ? pay.euro : Number(pay.euro || 0) || 0;
      const paidVal =
        typeof pay.paid === 'number' ? pay.paid : Number(pay.paid || 0) || 0;
      const debtVal =
        typeof pay.debt === 'number' ? pay.debt : Number(pay.debt || 0) || 0;
      return {
        ...entry,
        status: full.status || entry.status || '',
        totalEuro: euroVal,
        paid: paidVal,
        debt: debtVal,
      };
    });
    setRows(enriched);
    const euro = enriched.reduce((s, r) => s + (r.totalEuro || 0), 0);
    const paid = enriched.reduce((s, r) => s + (r.paid || 0), 0);
    const debt = enriched.reduce((s, r) => s + (r.debt || 0), 0);
    setTotals({ euro, paid, debt });
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setSelectedOrder(null);
      return;
    }
    const full = loadOrderById(selectedId);
    setSelectedOrder(full);
  }, [selectedId]);

  return (
    <div className="wrap">
      <header className="header-row">
        <div>
          <h1 className="title">ARKA</h1>
          <div className="subtitle">Përmbledhje e thjeshtë e pagesave</div>
        </div>
      </header>

      <section className="card">
        <h2 className="card-title">Përmbledhje</h2>
        <div className="tot-line">
          Xhiro totale: <strong>{totals.euro.toFixed(2)} €</strong>
        </div>
        <div className="tot-line small">
          Paguar: <strong>{totals.paid.toFixed(2)} €</strong> · Borxh:{' '}
          <strong>{totals.debt.toFixed(2)} €</strong>
        </div>
      </section>

      <section className="card">
        <h2 className="card-title">Lista e porosive</h2>
        {rows.length === 0 && <p>Nuk ka porosi të ruajtura ende.</p>}
        {rows.map((r) => {
          const total = typeof r.totalEuro === 'number' ? r.totalEuro : 0;
          const status =
            typeof r.status === 'string' && r.status
              ? r.status.toUpperCase()
              : '—';
          return (
            <button
              key={r.id}
              type="button"
              className="home-btn"
              style={{
                marginBottom: 8,
                borderColor: selectedId === r.id ? '#196bff' : undefined,
              }}
              onClick={() => setSelectedId(r.id)}
            >
              <div>
                <div>
                  <span className="badge" style={{ marginRight: 8 }}>
                    {r.id}
                  </span>
                  <strong>{r.name || 'Pa emër'}</strong>
                </div>
                <div className="tot-line small">
                  {status} · {total.toFixed(2)} €
                </div>
              </div>
              <span>DETALJE</span>
            </button>
          );
        })}
      </section>

      {selectedOrder && (
        <section className="card">
          <h2 className="card-title">Detajet e porosisë</h2>
          <div className="field-group">
            <label className="label">Klienti</label>
            <div className="readonly">
              {selectedOrder.client?.name || 'Pa emër'}
            </div>
          </div>
          <div className="field-group">
            <label className="label">Telefoni</label>
            <div className="readonly">
              {selectedOrder.client?.phone || '—'}
            </div>
          </div>
          <div className="field-group">
            <label className="label">KËRKESË SPECIALE / SHËNIME</label>
            <div className="readonly">
              {selectedOrder.notes || '—'}
            </div>
          </div>
          <div className="field-group">
            <label className="label">Pagesa</label>
            <div className="tot-line small">
              Total:{' '}
              <strong>
                {(selectedOrder.pay?.euro ?? 0).toFixed(2)} €
              </strong>{' '}
              · Paguar:{' '}
              <strong>
                {(selectedOrder.pay?.paid ?? 0).toFixed(2)} €
              </strong>{' '}
              · Borxh:{' '}
              <strong>
                {(selectedOrder.pay?.debt ?? 0).toFixed(2)} €
              </strong>
            </div>
          </div>
        </section>
      )}

      <footer className="footer-bar">
        <Link className="btn secondary" href="/">
          🏠 HOME
        </Link>
      </footer>
    </div>
  );
}
