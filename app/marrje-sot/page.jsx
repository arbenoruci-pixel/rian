'use client';

import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabaseClient';

const BUCKET = 'tepiha-photos';

// -------------------- HELPERS --------------------

function normalizeCode(raw) {
  if (!raw) return '';
  const n = String(raw).replace(/^X/i, '').replace(/^0+/, '');
  return n || '0';
}

function computePieces(order) {
  let pieces = 0;
  if (Array.isArray(order.tepiha)) {
    for (const r of order.tepiha) {
      const q = Number(r.qty) || 0;
      pieces += q;
    }
  }
  if (Array.isArray(order.staza)) {
    for (const r of order.staza) {
      const q = Number(r.qty) || 0;
      pieces += q;
    }
  }
  if (order.shkallore) {
    const q = Number(order.shkallore.qty) || 0;
    pieces += q;
  }
  return pieces;
}

function computeM2(order) {
  const payM2 = Number(order?.pay?.m2);
  if (!Number.isNaN(payM2) && payM2 > 0) return payM2;

  let total = 0;
  if (Array.isArray(order.tepiha)) {
    for (const r of order.tepiha) {
      const m2 = Number(r.m2) || 0;
      const q = Number(r.qty) || 0;
      total += m2 * q;
    }
  }
  if (Array.isArray(order.staza)) {
    for (const r of order.staza) {
      const m2 = Number(r.m2) || 0;
      const q = Number(r.qty) || 0;
      total += m2 * q;
    }
  }
  if (order.shkallore) {
    const m2 = Number(order.shkallore.m2) || 0;
    total += m2;
  }
  return total;
}

function computeTotalEuro(order) {
  const payEuro = Number(order?.pay?.euro);
  if (!Number.isNaN(payEuro) && payEuro > 0) return payEuro;

  const m2 = computeM2(order);
  const rate = Number(order?.pay?.rate) || 0;
  return m2 * rate;
}

function saveOrderLocal(order) {
  if (typeof window === 'undefined') return;
  try {
    const key = `order_${order.id}`;
    localStorage.setItem(key, JSON.stringify(order));

    const raw = localStorage.getItem('order_list_v1') || '[]';
    const list = JSON.parse(raw);
    const idx = Array.isArray(list) ? list.findIndex((x) => x && x.id === order.id) : -1;
    const entry = {
      id: order.id,
      ts: order.ts || Date.now(),
    };
    let next = Array.isArray(list) ? [...list] : [];
    if (idx >= 0) {
      next[idx] = { ...next[idx], ...entry };
    } else {
      next.push(entry);
    }
    localStorage.setItem('order_list_v1', JSON.stringify(next));
  } catch {
  }
}

async function saveOrderOnline(order) {
  if (!supabase) return;
  const { id } = order;
  if (!id) return;

  const path = `orders/${id}.json`;
  const blob =
    typeof Blob !== 'undefined'
      ? new Blob([JSON.stringify(order)], { type: 'application/json' })
      : null;
  if (blob) {
    await supabase.storage.from(BUCKET).upload(path, blob, { upsert: true });
  }
}

function buildIndexFromOrder(order) {
  const pieces = computePieces(order);
  const m2 = computeM2(order);
  const total = computeTotalEuro(order);

  return {
    id: order.id,
    name: order.client?.name || '',
    phone: order.client?.phone || '',
    code: order.client?.code || '',
    pieces,
    m2,
    total,
    status: order.status || '',
    ts: order.ts || Date.now(),
    readyAt: order.readyAt || null,
  };
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

async function loadOrdersFromSupabase() {
  if (!supabase) return [];
  const { data, error } = await supabase.storage.from(BUCKET).list('orders', {
    limit: 1000,
  });
  if (error || !data) return [];

  const orders = [];
  for (const item of data) {
    if (!item || !item.name) continue;
    try {
      const { data: file, error: dErr } = await supabase.storage
        .from(BUCKET)
        .download(`orders/${item.name}`);
      if (dErr || !file) continue;
      const text = await file.text();
      const order = JSON.parse(text);
      if (!order || !order.id) continue;
      if (order.status !== 'gati') continue;
      const idxEntry = buildIndexFromOrder(order);
      orders.push(idxEntry);
      saveOrderLocal(order);
    } catch (e) {
      console.error('Error parsing order from Supabase', item.name, e);
    }
  }

  orders.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  return orders;
}

function loadOrdersIndexLocal() {
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
      if (order.status !== 'gati') continue;
      result.push(buildIndexFromOrder(order));
    } catch {
    }
  }

  result.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  return result;
}

function formatCodeForList(raw) {
  const n = normalizeCode(raw);
  return n || '?';
}

export default function MarrjeSotPage() {
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);

  const todayOrders = useMemo(() => {
    const now = Date.now();
    return orders.filter((o) => isSameDay(o.readyAt || o.ts, now));
  }, [orders]);

  async function refreshOrders() {
    try {
      setLoading(true);
      let online = [];
      try {
        online = await loadOrdersFromSupabase();
      } catch (e) {
        console.error('Error loading from Supabase, falling back to local', e);
      }
      if (online && online.length > 0) {
        setOrders(online);
        return;
      }
      const fallback = loadOrdersIndexLocal();
      setOrders(fallback);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refreshOrders();
  }, []);

  async function markTakenToday(row) {
    if (!row || !row.id) return;
    if (typeof window === 'undefined') return;

    let full = null;
    try {
      const raw = localStorage.getItem(`order_${row.id}`);
      if (raw) full = JSON.parse(raw);
    } catch {
      full = null;
    }
    if (!full) {
      alert('Nuk u gjet porosia e plotë.');
      return;
    }

    const updated = {
      ...full,
      status: 'dorzim',
      deliveredAt: Date.now(),
    };

    saveOrderLocal(updated);
    await saveOrderOnline(updated);
    await refreshOrders();
    alert('Porosia u shënua si MARRE SOT.');
  }

  return (
    <div className="wrap">
      <header className="header-row">
        <div>
          <h1 className="title">MARRJE SOT</h1>
          <div className="subtitle">Porositë GATI për sot</div>
        </div>
        <div>
          <Link className="btn secondary" href="/gati">
            ← GATI
          </Link>
        </div>
      </header>

      <section className="card">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div style={{ fontSize: 12, opacity: 0.8 }}>Numri i porosive sot</div>
            <div style={{ fontSize: 20, fontWeight: 700 }}>{todayOrders.length}</div>
          </div>
          <button
            type="button"
            className="btn secondary"
            style={{ padding: '4px 10px', fontSize: 12 }}
            onClick={refreshOrders}
          >
            🔄 Rifresko
          </button>
        </div>
      </section>

      <section className="card">
        {loading && <p>Duke i lexuar porositë...</p>}
        {!loading && todayOrders.length === 0 && <p>Nuk ka porosi për MARRJE SOT.</p>}

        {!loading &&
          todayOrders.map((o) => (
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
                  {formatCodeForList(o.code)}
                </span>
                <span>{o.name || 'Pa emër'}</span>
                {typeof o.pieces === 'number' && o.pieces > 0 && (
                  <span style={{ fontSize: 12, opacity: 0.8 }}>{o.pieces} copë</span>
                )}
                {typeof o.total === 'number' && o.total > 0 && (
                  <span style={{ fontSize: 12, opacity: 0.9 }}>{o.total.toFixed(2)} €</span>
                )}
              </div>
              <div className="row" style={{ gap: 6 }}>
                <button
                  type="button"
                  className="btn primary"
                  style={{ padding: '4px 8px', fontSize: 12 }}
                  onClick={() => markTakenToday(o)}
                >
                  ✅ MARRE SOT
                </button>
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
