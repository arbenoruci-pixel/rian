'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';

/**
 * SHPENZIME (PRO)
 * Safe compile version (fixes "Unterminated regexp literal" build error).
 * Uses shared /arka layout + CSS for the PRO dark look.
 */
export default function ShpenzimePage() {
  const [items, setItems] = useState([]);
  const [title, setTitle] = useState('');
  const [amount, setAmount] = useState('');

  useEffect(() => {
    try {
      const raw = localStorage.getItem('arka_expenses_v1');
      if (raw) setItems(JSON.parse(raw));
    } catch {}
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem('arka_expenses_v1', JSON.stringify(items));
    } catch {}
  }, [items]);

  const total = useMemo(() => {
    return items.reduce((s, it) => s + (Number(it.amount) || 0), 0);
  }, [items]);

  function addExpense() {
    const a = Number(amount);
    if (!title.trim() || !Number.isFinite(a) || a <= 0) return;
    const it = {
      id: `${Date.now()}_${Math.random().toString(16).slice(2)}`,
      title: title.trim(),
      amount: a,
      ts: new Date().toISOString(),
    };
    setItems([it, ...items]);
    setTitle('');
    setAmount('');
  }

  function removeExpense(id) {
    setItems(items.filter(x => x.id !== id));
  }

  return (
    <div className="arka-page">
      <div className="arka-top">
        <div className="arka-top-left">
          <Link className="arka-back" href="/arka">⬅</Link>
          <div>
            <div className="arka-title">SHPENZIME</div>
            <div className="arka-subtitle">PRO • DARK</div>
          </div>
        </div>
        <div className="arka-pill">TOTAL €{total.toFixed(2)}</div>
      </div>

      <div className="arka-card">
        <div className="arka-card-title">SHTO SHPENZIM</div>
        <div className="arka-row">
          <input
            className="arka-input"
            placeholder="ARSYJA (p.sh. NAFTË, PARKING...)"
            value={title}
            onChange={e => setTitle(e.target.value)}
          />
          <input
            className="arka-input"
            placeholder="€"
            inputMode="decimal"
            value={amount}
            onChange={e => setAmount(e.target.value)}
          />
        </div>
        <button className="arka-btn arka-btn-primary" onClick={addExpense}>
          SHTO
        </button>
        <div className="arka-note">
          Shënim: Kjo është cache lokale (opsionale). Supabase sync injektohet më vonë.
        </div>
      </div>

      <div className="arka-card">
        <div className="arka-card-title">LISTA</div>
        {items.length === 0 ? (
          <div className="arka-empty">S’KA SHPENZIME ENDE.</div>
        ) : (
          <div className="arka-list">
            {items.map(it => (
              <div className="arka-item" key={it.id}>
                <div className="arka-item-main">
                  <div className="arka-item-title">{it.title}</div>
                  <div className="arka-item-meta">{new Date(it.ts).toLocaleString()}</div>
                </div>
                <div className="arka-item-right">
                  <div className="arka-amount">€{Number(it.amount).toFixed(2)}</div>
                  <button className="arka-btn arka-btn-danger" onClick={() => removeExpense(it.id)}>
                    FSHI
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
