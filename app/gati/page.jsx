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

function sanitizePhone(phone) {
  return (phone || '').replace(/[^0-9+]+/g, '');
}

function computePieces(order) {
  return (
    (Array.isArray(order.tepiha) ? order.tepiha.length : 0) +
    (Array.isArray(order.staza) ? order.staza.length : 0) +
    (order.shkallore && Number(order.shkallore.qty) > 0 ? 1 : 0)
  );
}

function computeM2(order) {
  if (order.pay && typeof order.pay.m2 === 'number') {
    return Number(order.pay.m2) || 0;
  }
  let total = 0;
  if (Array.isArray(order.tepiha)) {
    for (const r of order.tepiha) {
      const m2 = Number(r.m2) || 0;
      const qty = Number(r.qty) || 0;
      total += m2 * qty;
    }
  }
  if (Array.isArray(order.staza)) {
    for (const r of order.staza) {
      const m2 = Number(r.m2) || 0;
      const qty = Number(r.qty) || 0;
      total += m2 * qty;
    }
  }
  if (order.shkallore) {
    const qty = Number(order.shkallore.qty) || 0;
    const per = Number(order.shkallore.per) || 0;
    total += qty * per;
  }
  return Number(total.toFixed(2));
}

function computeTotalEuro(order) {
  if (order.pay && typeof order.pay.euro === 'number') {
    return Number(order.pay.euro) || 0;
  }
  const m2 = computeM2(order);
  const rate = order.pay && typeof order.pay.rate === 'number' ? Number(order.pay.rate) : 0;
  return Number((m2 * rate).toFixed(2));
}

function saveOrderLocal(order) {
  if (typeof window === 'undefined') return;
  const { id } = order;
  localStorage.setItem(`order_${id}`, JSON.stringify(order));

  let list = [];
  try {
    list = JSON.parse(localStorage.getItem('order_list_v1') || '[]');
  } catch {
    list = [];
  }
  if (!Array.isArray(list)) list = [];

  const pieces = computePieces(order);
  const m2 = computeM2(order);
  const total = computeTotalEuro(order);

  const entry = {
    id,
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

  const idx = list.findIndex((o) => o.id === id);
  if (idx >= 0) list[idx] = entry;
  else list.unshift(entry);

  list = list.slice(0, 200);
  localStorage.setItem('order_list_v1', JSON.stringify(list));
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

// Ngjyra sipas sa ditë ka që është GATI
function getGatiBadgeColor(entry) {
  const baseTs = entry.readyAt || entry.ts;
  if (!baseTs) return '#16a34a'; // default green

  const now = Date.now();
  const diffMs = now - baseTs;
  const days = Math.floor(diffMs / (24 * 60 * 60 * 1000));

  if (days <= 0) {
    // Sot
    return '#16a34a'; // green
  } else if (days === 1) {
    // Nesër
    return '#f97316'; // orange/yellow
  } else {
    // 2+ ditë
    return '#dc2626'; // red
  }
}

// Lexim nga Supabase – vetëm status 'gati'
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

// Fallback: lexo nga localStorage, filtro vetëm 'gati'
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
      // ignore
    }
  }

  result.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  return result;
}

function formatCodeForList(raw) {
  const n = normalizeCode(raw);
  return n || '?';
}

// -------------------- COMPONENT --------------------

export default function GatiPage() {
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);

  async function refreshOrders() {
    try {
      setLoading(true);
      let online = [];
      try {
        online = await loadOrdersFromSupabase();
      } catch (e) {
        console.error('Error loading from Supabase in GATI, falling back to local', e);
      }
      if (online && online.length > 0) {
        setOrders(online);
      } else {
        setOrders(loadOrdersIndexLocal());
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (typeof window === 'undefined') return;
    refreshOrders();
  }, []);

  const [payTarget, setPayTarget] = useState(null);
  const [payAmount, setPayAmount] = useState('');
  const [showPaySheet, setShowPaySheet] = useState(false);

  function openPaySheet(row) {
    if (!row) return;
    setPayTarget(row);
    const base =
      typeof row.total === 'number' && row.total > 0 ? row.total : 0;
    setPayAmount(base ? String(base.toFixed(2)) : '');
    setShowPaySheet(true);
  }

  async function confirmPayment() {
    if (!payTarget) return;
    const value = Number(payAmount) || 0;
    if (value <= 0) {
      alert('Shkruaj shumën e pagesës.');
      return;
    }

    if (typeof window === 'undefined') return;

    const payment = {
      id: `pay_${Date.now()}`,
      orderId: payTarget.id,
      code: normalizeCode(payTarget.code || ''),
      name: payTarget.name || '',
      phone: payTarget.phone || '',
      amount: value,
      ts: Date.now(),
    };

    try {
      // Local cache
      let arr = [];
      try {
        arr = JSON.parse(window.localStorage.getItem('payments_v1') || '[]');
      } catch {
        arr = [];
      }
      if (!Array.isArray(arr)) arr = [];
      arr.unshift(payment);
      window.localStorage.setItem('payments_v1', JSON.stringify(arr));
    } catch {
      // ignore local errors
    }

    try {
      // Supabase storage: ruajmë pagesën si json
      const path = `cash/${payment.id}.json`;
      const blob =
        typeof Blob !== 'undefined'
          ? new Blob([JSON.stringify(payment)], { type: 'application/json' })
          : null;
      if (blob) {
        await supabase.storage.from(BUCKET).upload(path, blob, { upsert: true });
      }
    } catch (e) {
      console.error('Error saving payment to Supabase', e);
    }

    // Tani shëno porosinë si DORZIM / MARRE
    await changeStatus(payTarget, 'dorzim');

    setShowPaySheet(false);
    setPayTarget(null);
    setPayAmount('');
  }

  const listTotalM2 = useMemo(() => {
    return orders.reduce((sum, o) => sum + (Number(o.m2) || 0), 0);
  }, [orders]);

  function openGatiSms(row) {
    const phone = row?.phone || '';
    const digits = sanitizePhone(phone);
    if (!digits) {
      alert('Nuk ka numër telefoni për SMS.');
      return;
    }

    const name = row?.name || 'klient';
    const codeClean = normalizeCode(row?.code || '');

    const pieces = typeof row.pieces === 'number' ? row.pieces : 0;
    const m2 = typeof row.m2 === 'number' ? row.m2 : 0;
    const euro = typeof row.total === 'number' ? row.total : 0;

    const text =
      `Përshëndetje ${name}, ` +
      `porosia juaj e tepihave${codeClean ? ` (kodi ${codeClean})` : ''} është GATI për t'u marrë.\n` +
      `Keni ${pieces} copë = ${m2.toFixed(2)} m². Totali për pagesë: ${euro.toFixed(
        2,
      )} €.\n` +
      `Ju lutemi t’i tërhiqni sa më shpejt të jetë e mundur.\n` +
      `Faleminderit!`;

    const encoded = encodeURIComponent(text);

    if (typeof window !== 'undefined') {
      window.location.href = `sms:${digits}?&body=${encoded}`;
    }
  }

  async function changeStatus(row, newStatus) {
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
      status: newStatus,
    };

    if (newStatus === 'dorzim') {
      updated.deliveredAt = Date.now();
    }

    saveOrderLocal(updated);
    await saveOrderOnline(updated);
    await refreshOrders();

    if (newStatus === 'pastrim') {
      alert('Porosia u kthye përsëri në PASTRIM.');
    } else if (newStatus === 'dorzim') {
      alert('Porosia u shënua si MARRE / DORËZUAR.');
    }
  }

  return (
    <div className="wrap" style={{ paddingBottom: '80px' }}>
      <header className="header-row">
        <div>
          <h1 className="title">GATI</h1>
          <div className="subtitle">Porositë e gatshme për marrje</div>
        </div>
        <div style={{ textAlign: 'right', fontSize: 12 }}>
          <div>
            TOTAL M²: <strong>{listTotalM2.toFixed(2)} m²</strong>
          </div>
        </div>
      </header>

      <section className="card">
        <h2 className="card-title">Lista e porosive GATI</h2>
        {loading && <p>Duke i lexuar porositë...</p>}
        {!loading && orders.length === 0 && <p>Nuk ka porosi GATI.</p>}

        {!loading &&
          orders.map((o) => (
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
                    backgroundColor: getGatiBadgeColor(o),
                    color: '#ffffff',
                    minWidth: 32,
                    textAlign: 'center',
                  }}
                >
                  {formatCodeForList(o.code)}
                </span>
                <span>{o.name || 'Pa emër'}</span>
                {typeof o.pieces === 'number' && o.pieces > 0 && (
                  <span style={{ fontSize: 12, opacity: 0.85 }}>
                    {o.pieces} cop
                  </span>
                )}
                {typeof o.total === 'number' && o.total > 0 && (
                  <span style={{ fontSize: 12, opacity: 0.85 }}>
                    {o.total.toFixed(2)} €
                  </span>
                )}
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <button
                  type="button"
                  className="btn secondary"
                  style={{ padding: '4px 8px', fontSize: 12 }}
                  onClick={() => openGatiSms(o)}
                >
                  SMS
                </button>
                <button
                  type="button"
                  className="btn secondary"
                  style={{ padding: '4px 8px', fontSize: 12 }}
                  onClick={() => changeStatus(o, 'pastrim')}
                >
                  ⇦ KTHE NË PASTRIM
                </button>
                <button
                  type="button"
                  className="btn primary"
                  style={{ padding: '4px 8px', fontSize: 12 }}
                  onClick={() => changeStatus(o, 'dorzim')}
                >
                  ✅ MARRE
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