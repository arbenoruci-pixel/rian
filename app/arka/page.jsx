'use client';

import React, { useEffect, useMemo, useState } from 'react';
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
    const obj = JSON.parse(raw);
    return obj;
  } catch {
    return null;
  }
}

export default function ArkaPage() {
  const [rows, setRows] = useState([]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const index = loadOrdersIndex();
    const collected = [];
    for (const row of index) {
      const full = loadOrderById(row.id);
      if (!full || !full.pay) continue;
      collected.push({
        id: row.id,
        name: full.client?.name || 'Pa emër',
        status: full.status || 'pranim',
        totalEuro: Number(full.pay.euro) || 0,
        paid: Number(full.pay.paid) || 0,
        debt: Number(full.pay.debt) || 0,
      });
    }
    setRows(collected);
  }, []);

  const totalEuro = useMemo(
    () => rows.reduce((sum, r) => sum + (r.totalEuro || 0), 0),
    [rows],
  );
  const totalPaid = useMemo(
    () => rows.reduce((sum, r) => sum + (r.paid || 0), 0),
    [rows],
  );
  const totalDebt = useMemo(
    () => rows.reduce((sum, r) => sum + (r.debt || 0), 0),
    [rows],
  );

  return (
    <div className="wrap">
      <header className="header-row">
        <div>
          <h1 className="title">ARKA</h1>
          <div className="subtitle">Përmbledhje e thjeshtë e pagesave</div>
        </div>
      </header>

      <section className="card">
        <h2 className="card-title">Totali nga të gjitha porositë</h2>
        <div className="tot-line">
          Totali i faturuar: <strong>{totalEuro.toFixed(2)} €</strong>
        </div>
        <div className="tot-line">
          Paguar: <strong>{totalPaid.toFixed(2)} €</strong>
        </div>
        <div className="tot-line">
          Borxh: <strong>{totalDebt.toFixed(2)} €</strong>
        </div>
        <p className="small-text" style={{ marginTop: 8 }}>
          * Këto shuma llogariten nga të gjitha porositë në aplikacion, pavarësisht datës.
        </p>
      </section>

      <section className="card">
        <h2 className="card-title">Lista e porosive</h2>
        {rows.length === 0 && <p>Nuk ka porosi të ruajtura ende.</p>}
        {rows.map((r) => (
          <div key={r.id} className="list-row">
            <div>
              <div>
                <strong>{r.name}</strong>
              </div>
              <small>
                Status: {r.status.toUpperCase()} · Total: {r.totalEuro.toFixed(2)} € · Paguar:{' '}
                {r.paid.toFixed(2)} € · Borxh: {r.debt.toFixed(2)} €
              </small>
            </div>
          </div>
        ))}
      </section>

      <footer className="footer-bar">
        <Link className="btn secondary" href="/">
          🏠 HOME
        </Link>
      </footer>
    </div>
  );
}
