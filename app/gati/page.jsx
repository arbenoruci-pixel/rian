'use client';

import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabaseClient';

const BUCKET = 'tepiha-photos';

// -------------------- HELPERS --------------------

function normalizeCode(raw) {
  if (!raw) return '';
  const s = String(raw).trim();
  const n = s.replace(/^X/i, '').replace(/^#/, '').replace(/^0+/, '');
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
  if (order?.pay && typeof order.pay.m2 === 'number') return Number(order.pay.m2) || 0;

  let total = 0;

  if (Array.isArray(order.tepiha)) {
    for (const r of order.tepiha) {
      const m2 = Number(r?.m2) || 0;
      const qty = Number(r?.qty) || 0;
      total += m2 * qty;
    }
  }

  if (Array.isArray(order.staza)) {
    for (const r of order.staza) {
      const m2 = Number(r?.m2) || 0;
      const qty = Number(r?.qty) || 0;
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
  if (order?.pay && typeof order.pay.euro === 'number') return Number(order.pay.euro) || 0;
  const m2 = computeM2(order);
  const rate = order?.pay && typeof order.pay.rate === 'number' ? Number(order.pay.rate) : 0;
  return Number((m2 * rate).toFixed(2));
}

function buildIndexFromOrder(order) {
  const pieces = computePieces(order);
  const m2 = computeM2(order);
  const total = computeTotalEuro(order);

  return {
    id: order.id,
    name: order?.client?.name || '',
    phone: order?.client?.phone || '',
    code: order?.client?.code || '',
    pieces,
    m2,
    total,
    status: order?.status || '',
    ts: order?.ts || Date.now(),
    isReturn: !!order?.returnInfo?.active,
  };
}

// -------------------- SAFE LOCAL STORAGE --------------------

function safeLSGet(key, fallback = null) {
  try {
    if (typeof window === 'undefined') return fallback;
    const v = localStorage.getItem(key);
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
}

function safeLSSet(key, value) {
  try {
    if (typeof window === 'undefined') return;
    localStorage.setItem(key, value);
  } catch {
    // ignore
  }
}

// -------------------- ARKA (LOCAL + ONLINE) --------------------

function saveArkaLocal(record) {
  try {
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
  } catch {
    // ignore
  }
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

  const { data, error } = await supabase.storage.from(BUCKET).list('orders', { limit: 1000 });
  if (error || !data) return [];

  const list = [];

  for (const item of data) {
    if (!item?.name) continue;
    // vetëm .json
    if (!String(item.name).toLowerCase().endsWith('.json')) continue;

    try {
      const { data: file, error: dErr } = await supabase.storage
        .from(BUCKET)
        .download(`orders/${item.name}`);

      if (dErr || !file) continue;

      const text = await file.text();
      const order = JSON.parse(text);

      if (!order?.id) continue;
      if ((order.status || '') !== 'gati') continue;

      list.push(buildIndexFromOrder(order));

      // mirror local (client-only)
      safeLSSet(`order_${order.id}`, JSON.stringify(order));
    } catch (e) {
      console.error('Error parsing order from Supabase (GATI):', item?.name, e);
    }
  }

  list.sort((a, b) => {
    const ac = Number(normalizeCode(a.code));
    const bc = Number(normalizeCode(b.code));
    if (bc !== ac) return bc - ac;
    return (b.ts || 0) - (a.ts || 0);
  });

  return list;
}

function loadOrdersFromLocal() {
  let idx = [];
  try {
    const raw = JSON.parse(safeLSGet('order_list_v1', '[]') || '[]');
    idx = Array.isArray(raw) ? raw : [];
  } catch {
    idx = [];
  }

  const result = [];

  for (const row of idx) {
    try {
      const rawOrder = safeLSGet(`order_${row?.id}`, null);
      if (!rawOrder) continue;

      const order = JSON.parse(rawOrder);
      if (!order?.id) continue;
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

  // paneli i pagesës / kthimit
  const [payOrder, setPayOrder] = useState(null); // { row, order, total }
  const [payPaid, setPayPaid] = useState('');
  const [payMode, setPayMode] = useState('normal'); // normal | return
  const [payNote, setPayNote] = useState('');

  async function refresh() {
    try {
      setLoading(true);

      let online = [];
      try {
        online = await loadOrdersFromSupabase();
      } catch (e) {
        console.error('GATI: Supabase failed, fallback local', e);
      }

      if (online && online.length > 0) setOrders(online);
      else setOrders(loadOrdersFromLocal());
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      return name.includes(q) || phone.includes(q) || code.includes(q);
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
      `porosia juaj${code ? ` (kodi ${code})` : ''} është GATI për marrje.\n` +
      `Keni ${row.pieces || 0} copë • ${(Number(row.m2) || 0).toFixed(2)} m².\n\n` +
      `Ju lutemi t’i tërhiqni brenda 2 ditësh. Pas këtij afati nuk mbajmë përgjegjësi ` +
      `për humbje/ngatërresa për shkak të hapësirës.\nFaleminderit.`;

    const encoded = encodeURIComponent(text);
    window.location.href = `sms:${phone}?&body=${encoded}`;
  }

  async function openPayPanel(row) {
    let order = null;

    try {
      const raw = safeLSGet(`order_${row.id}`, null);
      if (raw) order = JSON.parse(raw);
    } catch {
      order = null;
    }

    if (!order) {
      alert('Nuk u gjet porosia e plotë për pagesë / kthim.');
      return;
    }

    const total = computeTotalEuro(order);
    setPayOrder({ row, order, total });
    setPayPaid(total > 0 ? total.toFixed(2) : '');
    setPayMode('normal');
    setPayNote('');
  }

  function closePayPanel() {
    setPayOrder(null);
    setPayPaid('');
    setPayMode('normal');
    setPayNote('');
  }

  function chipSetExact() {
    if (!payOrder) return;
    setPayPaid(payOrder.total.toFixed(2));
  }

  function chipAdd(amount) {
    const current = Number(String(payPaid).replace(',', '.')) || 0;
    setPayPaid((current + amount).toFixed(2));
  }

  async function saveOrderToSupabase(updatedOrder) {
    try {
      safeLSSet(`order_${updatedOrder.id}`, JSON.stringify(updatedOrder));

      const blob =
        typeof Blob !== 'undefined'
          ? new Blob([JSON.stringify(updatedOrder)], { type: 'application/json' })
          : null;

      if (blob && supabase) {
        await supabase.storage
          .from(BUCKET)
          .upload(`orders/${updatedOrder.id}.json`, blob, { upsert: true });
      }
    } catch (e) {
      console.error('Save order failed:', e);
    }
  }

  async function confirmPayOrReturn() {
    if (!payOrder) return;

    const { row, order, total } = payOrder;

    const paidNum = Number(String(payPaid).replace(',', '.')) || 0;
    const totalNum = Number(total) || 0;

    if (payMode === 'normal') {
      if (paidNum <= 0) {
        alert('Shuma që dha klienti duhet të jetë më e madhe se zero.');
        return;
      }

      const change = paidNum - totalNum;
      const debt = totalNum - paidNum;

      const ok = confirm(
        `Totali: ${totalNum.toFixed(2)} €\n` +
          `Klienti dha: ${paidNum.toFixed(2)} €\n` +
          `Kthim: ${change > 0 ? change.toFixed(2) : '0.00'} €\n` +
          `Borxh: ${debt > 0 ? debt.toFixed(2) : '0.00'} €\n\n` +
          `Konfirmo pagesën dhe dorëzimin?`,
      );
      if (!ok) return;

      const newPay = {
        ...(order.pay || {}),
        m2: computeM2(order),
        euro: totalNum,
        paid: paidNum,
        debt: debt > 0 ? Number(debt.toFixed(2)) : 0,
        change: change > 0 ? Number(change.toFixed(2)) : 0,
      };

      const updatedOrder = {
        ...order,
        pay: newPay,
        status: 'dorzim',
        deliveredAt: Date.now(),
        returnInfo: { ...(order.returnInfo || {}), active: false },
      };

      await saveOrderToSupabase(updatedOrder);

      // ARKA record
      const arkaRecord = {
        id: `arka_${updatedOrder.id}_${Date.now()}`,
        orderId: updatedOrder.id,
        code: normalizeCode(updatedOrder?.client?.code),
        name: updatedOrder?.client?.name || '',
        phone: updatedOrder?.client?.phone || '',
        paid: paidNum,
        total: totalNum,
        debt: debt > 0 ? Number(debt.toFixed(2)) : 0,
        change: change > 0 ? Number(change.toFixed(2)) : 0,
        ts: Date.now(),
        from: 'gati',
      };

      saveArkaLocal(arkaRecord);
      await saveArkaOnline(arkaRecord);

      alert('Pagesa u regjistrua dhe porosia u dorëzua.');
      setOrders((prev) => prev.filter((o) => o.id !== row.id));
      closePayPanel();
      return;
    }

    // return mode
    const ok = confirm(
      'Kjo porosi do të kthehet në PASTRIM si KTHIM.\nJeni i sigurt që dëshironi ta ktheni?',
    );
    if (!ok) return;

    const updatedOrder = {
      ...order,
      status: 'pastrim',
      returnInfo: {
        active: true,
        at: Date.now(),
        note: payNote || '',
        from: 'gati',
      },
    };

    await saveOrderToSupabase(updatedOrder);

    alert('Porosia u kthye në PASTRIM si KTHIM.');
    setOrders((prev) => prev.filter((o) => o.id !== row.id));
    closePayPanel();
  }

  // -------------------- DERIVED FOR PANEL --------------------

  const payTotal = payOrder ? Number(payOrder.total) || 0 : 0;
  const payPaidNum = Number(String(payPaid).replace(',', '.')) || 0;
  const payChange = payPaidNum - payTotal;
  const payDebt = payTotal - payPaidNum;

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
            TOTAL M²: <strong>{totalM2.toFixed(2)} m²</strong>
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
        {!loading && filtered.length === 0 && <p>Nuk ka porosi GATI.</p>}

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
                borderColor: o.isReturn ? '#f97316' : undefined,
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
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                  <span
                    style={{
                      fontWeight: 700,
                      fontSize: 14,
                      padding: '2px 8px',
                      borderRadius: 4,
                      backgroundColor: o.isReturn ? '#f97316' : '#16a34a',
                      color: '#fff',
                      minWidth: 32,
                      textAlign: 'center',
                      flexShrink: 0,
                    }}
                  >
                    {normalizeCode(o.code)}
                  </span>

                  <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                    <span
                      style={{
                        fontWeight: 600,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        color: o.isReturn ? '#f97316' : undefined,
                      }}
                    >
                      {o.name || 'Pa emër'}
                    </span>
                    <span style={{ fontSize: 12, opacity: 0.85 }}>
                      {(o.pieces || 0) + ' cop • ' + (Number(o.m2) || 0).toFixed(2) + ' m²'}
                    </span>
                  </div>
                </div>

                <div style={{ textAlign: 'right', fontSize: 12 }}>
                  {typeof o.total === 'number' && o.total > 0 && (
                    <div>
                      <strong>{o.total.toFixed(2)} €</strong>
                    </div>
                  )}
                  {o.isReturn && <div style={{ fontSize: 10, color: '#f97316' }}>KTHIM</div>}
                </div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'row', gap: 8 }}>
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
                  onClick={() => openPayPanel(o)}
                >
                  💶 PAGUAJE / KTHIM
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

      {payOrder && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            backgroundColor: 'rgba(0,0,0,0.7)',
            display: 'flex',
            alignItems: 'flex-end',
            justifyContent: 'center',
            zIndex: 50,
          }}
          onClick={closePayPanel}
        >
          <div
            className="card"
            style={{
              width: '100%',
              maxWidth: 480,
              marginBottom: 0,
              borderRadius: '16px 16px 0 0',
              boxShadow: '0 -6px 24px rgba(0,0,0,0.6)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="header-row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
              <div>
                <div className="card-title" style={{ marginBottom: 4 }}>
                  {payMode === 'normal' ? 'Pagesa & dorëzimi' : 'Kthim në pastrim'}
                </div>
                <div style={{ fontSize: 12, opacity: 0.9 }}>
                  {payOrder.order?.client?.name || 'Klient pa emër'} • kodi{' '}
                  {normalizeCode(payOrder.order?.client?.code)}
                </div>
              </div>

              <button
                type="button"
                className="btn secondary"
                style={{ padding: '2px 8px', fontSize: 11 }}
                onClick={closePayPanel}
              >
                MBYLL
              </button>
            </div>

            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              <button
                type="button"
                className="btn secondary"
                style={{ flex: 1, fontSize: 11, borderColor: payMode === 'normal' ? '#22c55e' : undefined }}
                onClick={() => setPayMode('normal')}
              >
                PAGUAJ
              </button>
              <button
                type="button"
                className="btn secondary"
                style={{ flex: 1, fontSize: 11, borderColor: payMode === 'return' ? '#f97316' : undefined }}
                onClick={() => setPayMode('return')}
              >
                KTHE NË PASTRIM (KTHIM)
              </button>
            </div>

            {payMode === 'normal' && (
              <>
                <div className="tot-line small" style={{ marginBottom: 8 }}>
                  Totali: <strong>{payTotal.toFixed(2)} €</strong> · KLIENTI DHA:{' '}
                  <strong>{payPaidNum.toFixed(2)} €</strong>
                  <br />
                  Borxh:{' '}
                  <strong style={{ color: payDebt > 0 ? '#f97316' : undefined }}>
                    {payDebt > 0 ? payDebt.toFixed(2) : '0.00'} €
                  </strong>{' '}
                  · Kthim:{' '}
                  <strong style={{ color: payChange > 0 ? '#22c55e' : undefined }}>
                    {payChange > 0 ? payChange.toFixed(2) : '0.00'} €
                  </strong>
                </div>

                <div className="field-group">
                  <label className="label">Shuma që dha klienti (€)</label>
                  <input
                    className="input"
                    type="number"
                    min="0"
                    step="0.1"
                    value={payPaid}
                    onChange={(e) => setPayPaid(e.target.value)}
                  />

                  <div className="chip-row" style={{ marginTop: 8, flexWrap: 'wrap', gap: 6 }}>
                    <button type="button" className="chip" style={{ fontSize: 11 }} onClick={chipSetExact}>
                      SAKT ( {payTotal.toFixed(2)} € )
                    </button>
                    <button type="button" className="chip chip-outline" style={{ fontSize: 11 }} onClick={() => chipAdd(5)}>
                      +5 €
                    </button>
                    <button type="button" className="chip chip-outline" style={{ fontSize: 11 }} onClick={() => chipAdd(10)}>
                      +10 €
                    </button>
                    <button type="button" className="chip chip-outline" style={{ fontSize: 11 }} onClick={() => chipAdd(20)}>
                      +20 €
                    </button>
                    <button type="button" className="chip chip-outline" style={{ fontSize: 11 }} onClick={() => chipAdd(50)}>
                      +50 €
                    </button>
                  </div>
                </div>
              </>
            )}

            {payMode === 'return' && (
              <div className="field-group">
                <label className="label">Arsyeja e kthimit / vërejtje</label>
                <textarea
                  className="input"
                  rows={3}
                  value={payNote}
                  onChange={(e) => setPayNote(e.target.value)}
                  placeholder="P.sh. njollat nuk janë hequr, klienti kërkon larje shtesë, problem me erë, etj."
                />
                <p style={{ fontSize: 11, opacity: 0.8, marginTop: 4 }}>
                  Ky shënim shfaqet në PASTRIM për këtë porosi.
                </p>
              </div>
            )}

            <div className="btn-row" style={{ marginTop: 8 }}>
              <button type="button" className="btn primary" onClick={confirmPayOrReturn}>
                {payMode === 'normal' ? 'KONFIRMO PAGESËN & DORËZIMIN' : 'KONFIRMO KTHIMIN'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}