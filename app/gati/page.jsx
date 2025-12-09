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
  };
}

// -------------------- ARKA HELPERS --------------------

function saveArkaLocal(record) {
  if (typeof window === 'undefined') return;
  let list = [];
  try {
    list = JSON.parse(localStorage.getItem('arka_list_v1') || '[]');
  } catch {
    list = [];
  }
  if (!Array.isArray(list)) list = [];
  list.unshift(record);
  list = list.slice(0, 500);
  localStorage.setItem('arka_list_v1', JSON.stringify(list));
}

async function saveArkaOnline(record) {
  if (!supabase) return;
  const path = `arka/${record.id}.json`;
  const blob =
    typeof Blob !== 'undefined'
      ? new Blob([JSON.stringify(record)], { type: 'application/json' })
      : null;
  if (!blob) return;
  await supabase.storage.from(BUCKET).upload(path, blob, { upsert: true });
}

// -------------------- LOAD ORDERS --------------------

async function loadOrdersFromSupabase() {
  if (!supabase) return [];
  const { data, error } = await supabase.storage.from(BUCKET).list('orders', {
    limit: 1000,
  });
  if (error || !data) return [];

  const list = [];
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
      if ((order.status || '') !== 'gati') continue;
      list.push(buildIndexFromOrder(order));
      // mirror edhe lokalisht
      if (typeof window !== 'undefined') {
        localStorage.setItem(`order_${order.id}`, JSON.stringify(order));
      }
    } catch (e) {
      console.error('Error parsing order from Supabase (GATI)', item.name, e);
    }
  }

  // rendit sipas kodit numerik (desc)
  list.sort((a, b) => {
    const ac = Number(normalizeCode(a.code));
    const bc = Number(normalizeCode(b.code));
    if (bc !== ac) return bc - ac;
    return (b.ts || 0) - (a.ts || 0);
  });

  return list;
}

function loadOrdersFromLocal() {
  if (typeof window === 'undefined') return [];
  let idx = [];
  try {
    const raw = JSON.parse(localStorage.getItem('order_list_v1') || '[]');
    idx = Array.isArray(raw) ? raw : [];
  } catch {
    idx = [];
  }
  const result = [];
  for (const row of idx) {
    try {
      const rawOrder = localStorage.getItem(`order_${row.id}`);
      if (!rawOrder) continue;
      const order = JSON.parse(rawOrder);
      if (!order || !order.id) continue;
      if ((order.status || '') !== 'gati') continue;
      result.push(buildIndexFromOrder(order));
    } catch {
      // ignore
    }
  }

  result.sort((a, b) => {
    const ac = Number(normalizeCode(a.code));
    const bc = Number(normalizeCode(b.code));
    if (bc !== ac) return bc - ac;
    return (b.ts || 0) - (a.ts || 0);
  });

  return result;
}

// -------------------- COMPONENT --------------------

export default function GatiPage() {
  const [orders, setOrders] = useState([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);

  async function refresh() {
    try {
      setLoading(true);
      let online = [];
      try {
        online = await loadOrdersFromSupabase();
      } catch (e) {
        console.error('Error loading GATI from Supabase, fallback local', e);
      }
      if (online && online.length > 0) {
        setOrders(online);
      } else {
        setOrders(loadOrdersFromLocal());
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (typeof window === 'undefined') return;
    refresh();
  }, []);

  const totalM2 = useMemo(
    () => orders.reduce((sum, o) => sum + (Number(o.m2) || 0), 0),
    [orders],
  );

  const filtered = useMemo(() => {
    const q = (search || '').trim().toLowerCase();
    if (!q) return orders;
    return orders.filter((o) => {
      const name = (o.name || '').toLowerCase();
      const phone = (o.phone || '').toLowerCase();
      const code = normalizeCode(o.code).toLowerCase();
      return (
        name.includes(q) ||
        phone.includes(q) ||
        code.includes(q)
      );
    });
  }, [orders, search]);

  // -------------------- ACTIONS --------------------

  function openSms(row) {
    const phone = sanitizePhone(row.phone || '');
    if (!phone) {
      alert('Nuk ka numër telefoni për SMS.');
      return;
    }
    const code = normalizeCode(row.code);
    const text =
      `Përshëndetje ${row.name || 'klient'}, ` +
      `porosia juaj${code ? ` (kodi ${code})` : ''} është gati për marrje.\n` +
      `Keni ${row.pieces || 0} copë • ${(Number(row.m2) || 0).toFixed(2)} m².\n` +
      `Faleminderit!`;
    const encoded = encodeURIComponent(text);
    if (typeof window !== 'undefined') {
      window.location.href = `sms:${phone}?&body=${encoded}`;
    }
  }

  async function handlePay(row) {
    if (typeof window === 'undefined') return;

    // lexo porosinë e plotë
    let order = null;
    try {
      const raw = localStorage.getItem(`order_${row.id}`);
      if (raw) order = JSON.parse(raw);
    } catch {
      order = null;
    }
    if (!order) {
      alert('Nuk u gjet porosia e plotë për pagesë.');
      return;
    }

    const total = computeTotalEuro(order);
    const paidStr = prompt(
      'Shuma që dha klienti (€):',
      total > 0 ? total.toFixed(2) : '',
    );
    if (paidStr === null) return;
    const paid = Number(paidStr.replace(',', '.')) || 0;
    if (paid <= 0) {
      alert('Shuma duhet të jetë më e madhe se zero.');
      return;
    }

    const change = paid - total;
    if (!confirm(
      `Totali: ${total.toFixed(2)} €\n` +
        `Klienti dha: ${paid.toFixed(2)} €\n` +
        `Kthim: ${change > 0 ? change.toFixed(2) : '0.00'} €\n\n` +
        'Konfirmo pagesën dhe dorëzimin?',
    )) {
      return;
    }

    // përditëso porosinë si DORZIM
    const newPay = {
      ...(order.pay || {}),
      m2: computeM2(order),
      euro: total,
      paid,
      debt: paid < total ? Number((total - paid).toFixed(2)) : 0,
      change: change > 0 ? Number(change.toFixed(2)) : 0,
    };

    const updatedOrder = {
      ...order,
      pay: newPay,
      status: 'dorzim',
      deliveredAt: Date.now(),
    };

    // ruaj lokalisht + online
    try {
      localStorage.setItem(`order_${updatedOrder.id}`, JSON.stringify(updatedOrder));

      const path = `orders/${updatedOrder.id}.json`;
      const blob =
        typeof Blob !== 'undefined'
          ? new Blob([JSON.stringify(updatedOrder)], { type: 'application/json' })
          : null;
      if (blob && supabase) {
        await supabase.storage.from(BUCKET).upload(path, blob, { upsert: true });
      }
    } catch (e) {
      console.error('Gabim gjatë ruajtjes së porosisë DORZIM', e);
    }

    // regjistro ARKA
    const arkaRecord = {
      id: `arka_${updatedOrder.id}_${Date.now()}`,
      orderId: updatedOrder.id,
      code: normalizeCode(updatedOrder.client?.code),
      name: updatedOrder.client?.name || '',
      phone: updatedOrder.client?.phone || '',
      paid,
      ts: Date.now(),
    };

    saveArkaLocal(arkaRecord);
    await saveArkaOnline(arkaRecord);

    alert('Pagesa u regjistrua dhe porosia u dorëzua.');

    // hiqe nga lista GATI
    setOrders((prev) => prev.filter((o) => o.id !== row.id));
  }

  // -------------------- RENDER --------------------

  return (
    <div className="wrap" style={{ paddingBottom: '80px' }}>
      <header className="header-row">
        <div>
          <h1 className="title">GATI</h1>
          <div className="subtitle">Porositë e gatshme për marrje</div>
        </div>
        <div style={{ textAlign: 'right', fontSize: 12 }}>
          <div>
            TOTAL M²:{' '}
            <strong>{totalM2.toFixed(2)} m²</strong>
          </div>
        </div>
      </header>

      <section className="card">
        <h2 className="card-title">Lista e porosive GATI</h2>

        <div className="field-group" style={{ marginBottom: 12 }}>
          <input
            className="input"
            type="text"
            placeholder="Kërko me emër / telefon / kod"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        {loading && <p>Duke i lexuar porositë...</p>}
        {!loading && filtered.length === 0 && (
          <p>Nuk ka porosi GATI. Kaloi nga PASTRIMI.</p>
        )}

        {!loading &&
          filtered.map((o) => (
            <div
              key={o.id}
              className="home-btn"
              style={{
                marginBottom: 8,
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
              }}
            >
              <div
                className="home-btn-main"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 12,
                }}
              >
                {/* MAJTA: kodi + emri */}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    minWidth: 0,
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
                      flexShrink: 0,
                    }}
                  >
                    {normalizeCode(o.code)}
                  </span>
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      minWidth: 0,
                    }}
                  >
                    <span
                      style={{
                        fontWeight: 600,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {o.name || 'Pa emër'}
                    </span>
                    <span style={{ fontSize: 12, opacity: 0.85 }}>
                      {(o.pieces || 0) + ' cop • ' + (Number(o.m2) || 0).toFixed(2) + ' m²'}
                    </span>
                  </div>
                </div>

                {/* DJATHTA: totali € (optional) */}
                <div style={{ textAlign: 'right', fontSize: 12 }}>
                  {typeof o.total === 'number' && o.total > 0 && (
                    <div>
                      <strong>{o.total.toFixed(2)} €</strong>
                    </div>
                  )}
                </div>
              </div>

              {/* RRESHTI I BUTONAVE: SMS MAJTAS, PAGUAJE DJATHTAS */}
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'row',
                  gap: 8,
                }}
              >
                <button
                  type="button"
                  className="btn secondary"
                  style={{ flex: 1, padding: '4px 8px', fontSize: 12 }}
                  onClick={() => openSms(o)}
                >
                  SMS
                </button>
                <button
                  type="button"
                  className="btn primary"
                  style={{ flex: 1, padding: '4px 8px', fontSize: 12 }}
                  onClick={() => handlePay(o)}
                >
                  💶 PAGUAJE
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