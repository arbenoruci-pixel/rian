'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabaseClient';
import { recordCashMove } from '@/lib/arkaCashSync';

const BUCKET = 'tepiha-photos';

// PAGESA CHIPS
const PAY_CHIPS = [5, 10, 20, 30, 50];

// ---------------- HELPERS ----------------
function normalizeCode(raw) {
  if (!raw) return '';
  const s = String(raw).trim();
  // Preserve TRANSPORT codes (T123)
  if (/^t\d+/i.test(s)) {
    const n = s.replace(/\D+/g, '').replace(/^0+/, '');
    return `T${n || '0'}`;
  }
  const n = s.replace(/\D+/g, '').replace(/^0+/, '');
  return n || '0';
}

function sanitizePhone(phone) {
  return String(phone || '').replace(/[^\d+]+/g, '');
}

function computeM2(order) {
  if (!order) return 0;
  let total = 0;
  if (Array.isArray(order.tepiha)) {
    for (const r of order.tepiha) total += (Number(r.m2) || 0) * (Number(r.qty) || 0);
  }
  if (Array.isArray(order.staza)) {
    for (const r of order.staza) total += (Number(r.m2) || 0) * (Number(r.qty) || 0);
  }
  if (order.shkallore) total += (Number(order.shkallore.qty) || 0) * (Number(order.shkallore.per) || 0);
  return Number(total.toFixed(2));
}

function computeTotalEuro(order) {
  if (!order) return 0;
  if (order.pay && typeof order.pay.euro === 'number') return Number(order.pay.euro) || 0;
  const m2 = computeM2(order);
  const rate = Number(order.pay?.rate || 0);
  return Number((m2 * rate).toFixed(2));
}

function computePieces(order) {
  const tCope = order?.tepiha?.reduce((a, b) => a + (Number(b.qty) || 0), 0) || 0;
  const sCope = order?.staza?.reduce((a, b) => a + (Number(b.qty) || 0), 0) || 0;
  const shk = Number(order?.shkallore?.qty) > 0 ? 1 : 0;
  return tCope + sCope + shk;
}

function daysSince(ts) {
  const a = new Date(ts || Date.now());
  const b = new Date();
  const startA = new Date(a.getFullYear(), a.getMonth(), a.getDate()).getTime();
  const startB = new Date(b.getFullYear(), b.getMonth(), b.getDate()).getTime();
  return Math.floor((startB - startA) / (24 * 60 * 60 * 1000));
}

function badgeColorByAge(ts) {
  const d = daysSince(ts);
  if (d <= 0) return '#16a34a'; // green (today)
  if (d === 1) return '#f59e0b'; // orange (day 1)
  return '#dc2626'; // red (day 2+)
}

/**
 * ✅ IMPORTANT: download JSON no-cache (prevents stale reads)
 */
async function downloadJsonNoCache(path) {
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, 60);
  if (error || !data?.signedUrl) throw error || new Error('No signedUrl');
  const res = await fetch(`${data.signedUrl}&t=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error('Fetch failed');
  return await res.json();
}

async function uploadPhoto(file, oid, key) {
  if (!file || !oid) return null;
  const ext = file.name.split('.').pop() || 'jpg';
  const path = `photos/${oid}/${key}_${Date.now()}.${ext}`;
  const { data, error } = await supabase.storage.from(BUCKET).upload(path, file, { upsert: true, cacheControl: '0' });
  if (error) throw error;
  const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(data.path);
  return pub?.publicUrl || null;
}

// ---------------- ARKA HELPERS ----------------
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
  await supabase.storage.from(BUCKET).upload(path, blob, {
    upsert: true,
    cacheControl: '0',
    contentType: 'application/json',
  });
}

// ---------------- COMPONENT ----------------
export default function GatiPage() {
  const holdTimer = useRef(null);
  const holdFired = useRef(false);

  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  // payment sheet
  const [showPaySheet, setShowPaySheet] = useState(false);
  const [payOrder, setPayOrder] = useState(null); // { id, order, code, name, phone, total, paid, arkaRecordedPaid, paidUpfront, m2 }
  const [payAdd, setPayAdd] = useState(0);
  const [payMethod, setPayMethod] = useState('CASH');

  // return hidden sheet
  const [showReturnSheet, setShowReturnSheet] = useState(false);
  const [retOrder, setRetOrder] = useState(null);
  const [retReason, setRetReason] = useState('');
  const [retNote, setRetNote] = useState('');
  const [retPhotoUrl, setRetPhotoUrl] = useState('');
  const [photoUploading, setPhotoUploading] = useState(false);

  useEffect(() => {
    refreshOrders();
    return () => {
      if (holdTimer.current) clearTimeout(holdTimer.current);
    };
  }, []);

  async function refreshOrders() {
    setLoading(true);
    try {
      const { data } = await supabase.storage.from(BUCKET).list('orders', { limit: 1000 });
      if (!data) {
        setOrders([]);
        return;
      }

      const items = (data || []).filter((x) => (x.name || '').endsWith('.json'));

      const promises = items.map(async (item) => {
        try {
          const remoteOrder = await downloadJsonNoCache(`orders/${item.name}`);
          if (!remoteOrder?.id) return null;

          // Prefer LOCAL copy when it exists. Reason:
          // after "PAGUAR & DORËZUAR", the local status becomes "dorzim".
          // If storage upload is blocked (RLS/permissions/network), remote JSON
          // may still be "gati" and would keep showing the client here.
          let order = remoteOrder;
          if (typeof window !== 'undefined') {
            try {
              const localRaw = localStorage.getItem(`order_${remoteOrder.id}`);
              if (localRaw) {
                const localOrder = JSON.parse(localRaw);
                if (localOrder && localOrder.id === remoteOrder.id) {
                  order = localOrder;
                }
              }
            } catch {}
          }

          // mirror local (but DON'T overwrite a newer local state with remote)
          if (typeof window !== 'undefined') {
            try {
              const existing = localStorage.getItem(`order_${remoteOrder.id}`);
              if (!existing) localStorage.setItem(`order_${remoteOrder.id}`, JSON.stringify(remoteOrder));
            } catch {}
          }

          if ((order.status || '') !== 'gati') return null;

          const m2 = computeM2(order);
          const total = Number(order.pay?.euro || computeTotalEuro(order));
          const paid = Number(order.pay?.paid || 0);
          const cope = computePieces(order);

          // aging uses ready_at if exists (set from PASTRIMI), else ts fallback
          const readyTs =
            Number(order.ready_at) ||
            Number(order.readyAt) ||
            Number(order.gati_at) ||
            Number(order.gatiAt) ||
            Number(order.ts) ||
            Date.now();

          return {
            id: order.id,
            ts: Number(order.ts || 0),
            readyTs,
            name: order.client?.name || '',
            phone: order.client?.phone || '',
            code: order.client?.code || '',
            m2,
            cope,
            total,
            paid,
            paidUpfront: !!order.pay?.paidUpfront,
            isReturn: !!order.returnInfo?.active,
          };
        } catch {
          return null;
        }
      });

      const res = await Promise.all(promises);
      const list = res.filter(Boolean).sort((a, b) => (b.readyTs || 0) - (a.readyTs || 0));
      setOrders(list);
    } finally {
      setLoading(false);
    }
  }

  const totalM2 = useMemo(() => orders.reduce((sum, o) => sum + (Number(o.m2) || 0), 0), [orders]);

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

  // ---------------- SMS ----------------
  function sendPickupSms(row) {
    const phone = sanitizePhone(row.phone || '');
    if (!phone) {
      alert('Nuk ka numër telefoni.');
      return;
    }

    const code = normalizeCode(row.code);
    const paidTxt = row.paidUpfront ? '\n✅ KJO POROSI ËSHTË PAGUAR NË FILLIM.' : '';

    const msg =
      `Përshëndetje ${row.name || 'klient'}, ` +
      `porosia juaj${code ? ` (kodi ${code})` : ''} është GATI.\n` +
      `Keni ${row.cope || 0} copë • ${(Number(row.m2) || 0).toFixed(2)} m².` +
      `${paidTxt}\n\n` +
      `Ju lutem ejani sot ose nesër me i marrë tepihat, sepse kemi mungesë të vendit në depo.\nFaleminderit!`;

    window.location.href = `sms:${phone}?&body=${encodeURIComponent(msg)}`;
  }

  // ---------------- PAY FULLSCREEN ----------------
  async function openPay(row) {
    try {
      let order = null;
      try {
        const raw = localStorage.getItem(`order_${row.id}`);
        if (raw) order = JSON.parse(raw);
      } catch {
        order = null;
      }
      if (!order) {
        order = await downloadJsonNoCache(`orders/${row.id}.json`);
        localStorage.setItem(`order_${row.id}`, JSON.stringify(order));
      }
      if (!order) {
        alert('Nuk u gjet porosia.');
        return;
      }

      const total = Number(order.pay?.euro || computeTotalEuro(order)) || 0;
      const paid = Number(order.pay?.paid || 0) || 0;

      setPayOrder({
        id: row.id,
        order,
        code: normalizeCode(order.client?.code),
        name: order.client?.name || '',
        phone: order.client?.phone || '',
        total,
        paid,
        arkaRecordedPaid: Number(order.pay?.arkaRecordedPaid || 0) || 0,
        paidUpfront: !!order.pay?.paidUpfront,
        m2: computeM2(order),
      });

      setPayAdd(0);
      setPayMethod(order.pay?.method === 'CARD' ? 'CARD' : 'CASH');
      setShowPaySheet(true);
    } catch {
      alert('❌ Gabim gjatë hapjes së pagesës.');
    }
  }

  function closePay() {
    setShowPaySheet(false);
    setPayOrder(null);
    setPayAdd(0);
    setPayMethod('CASH');
  }

  function applyPayOnly() {
    // Just close. Payment actually applied when confirming delivery (same “one place” logic).
    setShowPaySheet(false);
  }

  async function confirmDelivery() {
    if (!payOrder) return;
    const o = payOrder.order;

    const total = Number(payOrder.total || 0);
    const paidBefore = Number(payOrder.paid || 0);
    const cashGiven = Number((Number(payAdd || 0)).toFixed(2));
    const paidUpfront = !!payOrder.paidUpfront;

    const due = Math.max(0, Number((total - paidBefore).toFixed(2)));
    const applied = paidUpfront ? due : Number(Math.min(cashGiven, due).toFixed(2));
    if (!paidUpfront && applied <= 0) {
      setShowPaySheet(false);
      return;
    }

    // if paid upfront, treat paid as total
    const paidAfter = paidUpfront ? Math.max(paidBefore, total) : Number((paidBefore + applied).toFixed(2));

    const debt = Math.max(0, Number((total - paidAfter).toFixed(2)));
    const change = paidUpfront ? 0 : Math.max(0, Number((cashGiven - applied).toFixed(2)));

    // ARKA delta only if CASH
    const prevArka = Number(o.pay?.arkaRecordedPaid || 0);
    const willRecordCash = payMethod === 'CASH';

    // In CASH, we want arkaRecordedPaid == paidAfter (minimum), never lower
    const targetCashRecorded = willRecordCash ? paidAfter : prevArka;
    const delta = willRecordCash ? Number((targetCashRecorded - prevArka).toFixed(2)) : 0;
    const safeDelta = Math.max(0, delta);
    const finalArka = willRecordCash ? Number((prevArka + safeDelta).toFixed(2)) : prevArka;

    const msg =
      `Totali: ${total.toFixed(2)} €\n` +
      (paidUpfront ? `✅ E PAGUAR NË FILLIM\n` : `Paguar pas kësaj: ${paidAfter.toFixed(2)} €\n`) +
      `Borxh: ${debt.toFixed(2)} €\n` +
      `Kthim: ${change.toFixed(2)} €\n\n` +
      `Konfirmo DORËZIMIN?`;

    if (!confirm(msg)) return;

    const updated = {
      ...o,
      status: 'dorzim',
      deliveredAt: Date.now(),
        delivered_at: new Date().toISOString(),
      returnInfo: { ...(o.returnInfo || {}), active: false },
      pay: {
        ...(o.pay || {}),
        m2: payOrder.m2,
        euro: total,
        paid: paidAfter,
        debt,
        change,
        method: payMethod,
        arkaRecordedPaid: finalArka,
      },
    };

    try {
      localStorage.setItem(`order_${updated.id}`, JSON.stringify(updated));
      const blob =
        typeof Blob !== 'undefined'
          ? new Blob([JSON.stringify(updated)], { type: 'application/json' })
          : null;
      if (blob) {
        await supabase.storage.from(BUCKET).upload(`orders/${updated.id}.json`, blob, {
          upsert: true,
          cacheControl: '0',
          contentType: 'application/json',
        });
      }
    } catch (e) {
      console.error('save dorzim fail', e);
    }

    // ARKA record (only CASH + positive delta)
    if (willRecordCash && safeDelta > 0) {
      const arkaRecord = {
        id: `arka_${updated.id}_${Date.now()}`,
        orderId: updated.id,
        code: normalizeCode(updated.client?.code),
        name: updated.client?.name || '',
        phone: updated.client?.phone || '',
        paid: safeDelta,
        ts: Date.now(),
        note: paidUpfront ? 'paid_upfront_delta' : 'delivery_cash_delta',
      };

	      const cashRes = await recordCashMove({
        externalId: arkaRecord.id,
        orderId: updated.id,
        code: arkaRecord.code,
        name: (arkaRecord.name || '').trim(),
	        stage: 'GATI',
        amount: safeDelta,
        note: (paidUpfront ? 'AVANS ' : 'PAGESA ') + safeDelta.toFixed(2) + '€ • #' + arkaRecord.code + ' • ' + (arkaRecord.name || '').trim(),
        source: paidUpfront ? 'ORDER_FRONT' : 'ORDER_PAY',
	        method: 'CASH',
        type: 'IN',
      });

	      // If ARKA was closed (or HANDED), payment is saved as WAITING (PENDING)
	      if (cashRes?.pending) {
	        try {
	          // non-blocking hint
	          console.log('ARKA WAITING payment saved', cashRes);
	        } catch {}
	      }
    }

	    const doneMsg = '✅ Porosia u dorëzua.' + (willRecordCash ? '\n\n(Nëse ARKA ishte e mbyllur: pagesa ruhet si WAITING dhe futet në ARKË kur hapet.)' : '');
	    alert(doneMsg);
    closePay();
    setOrders((prev) => prev.filter((x) => x.id !== updated.id));
  }

  // ---------------- HIDDEN RETURN (HOLD 3s ON PAY) ----------------
  async function openReturn(row) {
    try {
      let order = null;
      try {
        const raw = localStorage.getItem(`order_${row.id}`);
        if (raw) order = JSON.parse(raw);
      } catch {
        order = null;
      }
      if (!order) {
        order = await downloadJsonNoCache(`orders/${row.id}.json`);
        localStorage.setItem(`order_${row.id}`, JSON.stringify(order));
      }
      if (!order) {
        alert('Nuk u gjet porosia.');
        return;
      }

      setRetOrder(order);
      setRetReason('');
      setRetNote('');
      setRetPhotoUrl('');
      setShowReturnSheet(true);
    } catch {
      alert('❌ Gabim gjatë hapjes së kthimit.');
    }
  }

  function closeReturn() {
    setShowReturnSheet(false);
    setRetOrder(null);
    setRetReason('');
    setRetNote('');
    setRetPhotoUrl('');
  }

  async function handleReturnPhoto(file) {
    if (!file || !retOrder?.id) return;
    setPhotoUploading(true);
    try {
      const url = await uploadPhoto(file, retOrder.id, 'return');
      if (url) setRetPhotoUrl(url);
    } catch {
      alert('❌ Gabim foto!');
    } finally {
      setPhotoUploading(false);
    }
  }

  async function confirmReturn() {
    if (!retOrder?.id) return;

    const reason = (retReason || '').trim();
    const note = (retNote || '').trim();

    if (!reason && !note) {
      alert('Shkruaj së paku një arsye ose shënim për kthimin.');
      return;
    }

    if (!confirm('Kjo porosi do të kthehet në PASTRIM si KTHIM.\nJeni i sigurt?')) return;

    const entry = {
      id: `ret_${retOrder.id}_${Date.now()}`,
      ts: Date.now(),
      from: 'gati',
      reason: reason || '',
      note: note || '',
      photoUrl: retPhotoUrl || '',
    };

    const updated = {
      ...retOrder,
      status: 'pastrim',

      // ✅ SNAPSHOT që PASTRIMI ta lexojë lehtë (pa kërku returnLog)
      returnInfo: {
        active: true,
        at: Date.now(),
        from: 'gati',
        reason: entry.reason,
        note: entry.note,
        photoUrl: entry.photoUrl,
        logId: entry.id,
      },

      // ✅ HISTORI e plotë (opsionale)
      returnLog: Array.isArray(retOrder.returnLog) ? [entry, ...retOrder.returnLog] : [entry],
    };

    try {
      localStorage.setItem(`order_${updated.id}`, JSON.stringify(updated));

      const blob =
        typeof Blob !== 'undefined'
          ? new Blob([JSON.stringify(updated)], { type: 'application/json' })
          : null;
      if (blob) {
        await supabase.storage.from(BUCKET).upload(`orders/${updated.id}.json`, blob, {
          upsert: true,
          cacheControl: '0',
          contentType: 'application/json',
        });
      }

      // optional audit file
      const blob2 =
        typeof Blob !== 'undefined'
          ? new Blob([JSON.stringify(entry)], { type: 'application/json' })
          : null;
      if (blob2) {
        await supabase.storage.from(BUCKET).upload(`returns/${entry.id}.json`, blob2, {
          upsert: true,
          cacheControl: '0',
          contentType: 'application/json',
        });
      }

      // local return list
      try {
        const list = JSON.parse(localStorage.getItem('return_list_v1') || '[]');
        const next = Array.isArray(list) ? [entry, ...list].slice(0, 300) : [entry];
        localStorage.setItem('return_list_v1', JSON.stringify(next));
      } catch {
        localStorage.setItem('return_list_v1', JSON.stringify([entry]));
      }
    } catch (e) {
      console.error('return save fail', e);
      alert('❌ Gabim gjatë ruajtjes së kthimit.');
      return;
    }

    alert('✅ U kthye në PASTRIM (KTHIM).');
    closeReturn();
    setOrders((prev) => prev.filter((x) => x.id !== updated.id));
  }

  // Hold logic on PAY button
  function onPayPressStart(row) {
    holdFired.current = false;
    if (holdTimer.current) clearTimeout(holdTimer.current);
    holdTimer.current = setTimeout(() => {
      holdFired.current = true;
      openReturn(row);
    }, 3000);
  }

  function onPayPressEnd(row) {
    if (holdTimer.current) {
      clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
    if (holdFired.current) return; // long press already opened return
    openPay(row); // short press opens payment
  }

  // ---------------- RENDER ----------------
  return (
    <div className="wrap">
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

      <input
        className="input"
        placeholder="🔎 Kërko emrin / telefonin / kodin..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />

      <section className="card" style={{ padding: '10px' }}>
        {loading ? (
          <p style={{ textAlign: 'center' }}>Duke u ngarkuar...</p>
        ) : filtered.length === 0 ? (
          <p style={{ textAlign: 'center' }}>Nuk ka porosi GATI.</p>
        ) : (
          filtered.map((o) => {
            const total = Number(o.total || 0);
            const paid = Number(o.paid || 0);
            const isPaid = total > 0 && paid >= total;
            const debt = Math.max(0, Number((total - paid).toFixed(2)));

            return (
              <div
                key={o.id}
                className="list-item-compact"
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '8px 4px',
                  borderBottom: '1px solid rgba(255,255,255,0.08)',
                  opacity: o.isReturn ? 0.92 : 1,
                }}
              >
                <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      background: badgeColorByAge(o.readyTs || o.ts),
                      color: '#fff',
                      width: 40,
                      height: 40,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      borderRadius: 8,
                      fontWeight: 900,
                      fontSize: 14,
                      flexShrink: 0,
                    }}
                    title="RAGING COLORS"
                  >
                    {normalizeCode(o.code)}
                  </div>

                  <div style={{ minWidth: 0 }}>
                    <div
                      style={{
                        fontWeight: 700,
                        fontSize: 14,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {o.name || 'Pa emër'}
                    </div>

                    <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.65)' }}>
                      {o.cope} copë • {Number(o.m2 || 0).toFixed(2)} m²
                    </div>

                    {o.paidUpfront && (
                      <div style={{ fontSize: 11, color: '#16a34a', fontWeight: 900 }}>
                        ✅ E PAGUAR (NË FILLIM)
                      </div>
                    )}

                    {paid > 0 && !o.paidUpfront && (
                      <div style={{ fontSize: 11, color: '#16a34a', fontWeight: 800 }}>
                        Paguar: {paid.toFixed(2)}€
                      </div>
                    )}

                    {debt > 0 && !o.paidUpfront && (
                      <div style={{ fontSize: 11, color: '#dc2626', fontWeight: 900 }}>
                        Borxh: {debt.toFixed(2)}€
                      </div>
                    )}
                  </div>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  {isPaid && <span style={{ fontSize: 14 }}>✅</span>}

                  <button
                    className="btn secondary"
                    style={{ padding: '6px 10px', fontSize: 12 }}
                    onClick={() => sendPickupSms(o)}
                  >
                    SMS
                  </button>

                  <button
                    className="btn primary"
                    style={{ padding: '6px 10px', fontSize: 12 }}
                    onMouseDown={() => onPayPressStart(o)}
                    onMouseUp={() => onPayPressEnd(o)}
                    onMouseLeave={() => {
                      if (holdTimer.current) clearTimeout(holdTimer.current);
                    }}
                    onTouchStart={() => onPayPressStart(o)}
                    onTouchEnd={() => onPayPressEnd(o)}
                    onTouchMove={() => {
                      if (holdTimer.current) clearTimeout(holdTimer.current);
                    }}
                  >
                    💶 PAGUAJ
                  </button>
                </div>
              </div>
            );
          })
        )}
      </section>

      <footer className="dock">
        <Link href="/" className="btn secondary" style={{ width: '100%' }}>
          🏠 HOME
        </Link>
      </footer>

      {/* ============ FULL SCREEN PAGESA (si PASTRIMI) ============ */}
      {showPaySheet && payOrder && (
        <div className="payfs">
          <div className="payfs-top">
            <div>
              <div className="payfs-title">PAGESA</div>
              <div className="payfs-sub">
                KODI: {payOrder.code} • {payOrder.name}
              </div>
              {payOrder.paidUpfront && (
                <div style={{ fontSize: 12, color: '#16a34a', fontWeight: 900, marginTop: 4 }}>
                  ✅ E PAGUAR NË FILLIM
                </div>
              )}
            </div>
            <button className="btn secondary" onClick={closePay}>
              ✕
            </button>
          </div>

          <div className="payfs-body">
            <div className="card" style={{ marginTop: 0 }}>
              <div className="tot-line">
                TOTAL: <strong>{Number(payOrder.total || 0).toFixed(2)} €</strong>
              </div>
              <div className="tot-line">
                PAGUAR DERI TANI:{' '}
                <strong style={{ color: '#16a34a' }}>{Number(payOrder.paid || 0).toFixed(2)} €</strong>
              </div>
              <div className="tot-line" style={{ fontSize: 12, color: '#666' }}>
                REGJISTRU N&apos;ARKË DERI TANI:{' '}
                <strong>{Number(payOrder.arkaRecordedPaid || 0).toFixed(2)} €</strong>
              </div>

              <div className="tot-line" style={{ borderTop: '1px solid #eee', marginTop: 10, paddingTop: 10 }}>
                SOT PAGUAN: <strong>{Number(payAdd || 0).toFixed(2)} €</strong>
              </div>

              {(() => {
                const total = Number(payOrder.total || 0);
                const paidBefore = Number(payOrder.paid || 0);
                const paidUpfront = !!payOrder.paidUpfront;

                const paidAfter = paidUpfront ? Math.max(paidBefore, total) : Number((paidBefore + Number(payAdd || 0)).toFixed(2));
                const d = Number((total - paidAfter).toFixed(2));
                const debtNow = d > 0 ? d : 0;
                const changeNow = d < 0 ? Math.abs(d) : 0;

                return (
                  <>
                    <div className="tot-line">
                      PAGUAR PAS KËSAJ:{' '}
                      <strong style={{ color: '#16a34a' }}>{paidAfter.toFixed(2)} €</strong>
                    </div>
                    {debtNow > 0 && (
                      <div className="tot-line">
                        BORXH: <strong style={{ color: '#dc2626' }}>{debtNow.toFixed(2)} €</strong>
                      </div>
                    )}
                    {changeNow > 0 && (
                      <div className="tot-line">
                        KTHIM: <strong style={{ color: '#2563eb' }}>{changeNow.toFixed(2)} €</strong>
                      </div>
                    )}
                  </>
                );
              })()}
            </div>

            {!payOrder.paidUpfront && (
              <div className="card">
                <div className="field-group">
                  <label className="label">SHTO PAGESË (€) — VETËM SOT</label>

                  <input
                    type="text"
                  inputMode="decimal"
                  pattern="[0-9]*"
                    className="input"
                    value={Number(payAdd || 0) === 0 ? '' : payAdd}
                    onChange={(e) => {
                      const v = e.target.value;
                      setPayAdd(v === '' ? 0 : Number(v));
                    }}
                  />

                  <div className="chip-row" style={{ marginTop: 10 }}>
                    {PAY_CHIPS.map((v) => (
                      <button
                        key={v}
                        className="chip"
                        type="button"
                        onClick={() => setPayAdd(Number((Number(payAdd || 0) + v).toFixed(2)))}
                      >
                        +{v}€
                      </button>
                    ))}
                    <button className="chip" type="button" onClick={() => setPayAdd(0)} style={{ opacity: 0.9 }}>
                      FSHI
                    </button>
                  </div>
                </div>

                <div className="field-group">
                  <label className="label">METODA</label>

                  {/* iOS fix: avoid native <select> overlay stealing taps */}
                  <div className="row" style={{ gap: 10 }}>
                    <button
                      type="button"
                      className="btn secondary"
                      style={{ flex: 1, outline: payMethod === 'CASH' ? '2px solid rgba(255,255,255,0.35)' : 'none' }}
                      onClick={() => setPayMethod('CASH')}
                    >
                      CASH
                    </button>
                    <button
                      type="button"
                      className="btn secondary"
                      style={{ flex: 1, outline: payMethod === 'CARD' ? '2px solid rgba(255,255,255,0.35)' : 'none' }}
                      onClick={() => setPayMethod('CARD')}
                    >
                      CARD / TRANSFER
                    </button>
                  </div>
                </div>

                <div style={{ fontSize: 12, color: '#666', marginTop: 8 }}>
                  * CASH regjistrohet në ARKË. CARD/TRANSFER nuk hyn në ARKË.
                </div>
              </div>
            )}

            {payOrder.paidUpfront && (
              <div className="card">
                <div style={{ fontSize: 12, color: '#666' }}>
                  * Kjo porosi është e paguar në fillim. Shtyp “KONFIRMO DORËZIMIN”.
                </div>
              </div>
            )}
          </div>

          <div className="payfs-footer">
            <button className="btn secondary" onClick={closePay}>
              ANULO
            </button>
            <button className="btn secondary" onClick={applyPayOnly}>
              RUJ (PA DORËZU)
            </button>
            <button className="btn primary" onClick={confirmDelivery}>
              KONFIRMO DORËZIMIN
            </button>
          </div>
        </div>
      )}

      {/* ============ HIDDEN RETURN FULLSCREEN (HOLD 3s) ============ */}
      {showReturnSheet && retOrder && (
        <div className="payfs">
          <div className="payfs-top">
            <div>
              <div className="payfs-title">KTHIM (HIDDEN)</div>
              <div className="payfs-sub">
                KODI: {normalizeCode(retOrder.client?.code)} • {retOrder.client?.name || ''}
              </div>
            </div>
            <button className="btn secondary" onClick={closeReturn} disabled={photoUploading}>
              ✕
            </button>
          </div>

          <div className="payfs-body">
            <div className="card" style={{ marginTop: 0 }}>
              <div className="field-group">
                <label className="label">PSE PO KTHEHET?</label>
                <select className="input" value={retReason} onChange={(e) => setRetReason(e.target.value)}>
                  <option value="">— ZGJIDH —</option>
                  <option value="SHTESË LARJE / NJOLLA">SHTESË LARJE / NJOLLA</option>
                  <option value="ANKESË KLIENTI">ANKESË KLIENTI</option>
                  <option value="GABIM NË POROSI">GABIM NË POROSI</option>
                  <option value="TJETER">TJETER</option>
                </select>
              </div>

              <div className="field-group">
                <label className="label">SHËNIM / DOKUMENTIM</label>
                <textarea
                  className="input"
                  rows={4}
                  value={retNote}
                  onChange={(e) => setRetNote(e.target.value)}
                  placeholder="P.sh. klienti kërkoi larje shtesë, u lanë edhe njëherë, etj..."
                />
              </div>

              <div className="field-group">
                <label className="label">FOTO (OPSIONALE)</label>
                <label className="camera-btn" style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                  📷 SHTO FOTO
                  <input
                    type="file"
                    accept="image/*"
                    style={{ display: 'none' }}
                    onChange={(e) => handleReturnPhoto(e.target.files?.[0])}
                  />
                </label>

                {retPhotoUrl && (
                  <div style={{ marginTop: 10 }}>
                    <img src={retPhotoUrl} className="photo-thumb" alt="" />
                    <button
                      className="btn secondary"
                      style={{ display: 'block', fontSize: 10, padding: '4px 8px', marginTop: 6 }}
                      onClick={() => setRetPhotoUrl('')}
                      disabled={photoUploading}
                    >
                      🗑️ FSHI FOTO
                    </button>
                  </div>
                )}

                {photoUploading && <div style={{ marginTop: 8, fontSize: 12, color: '#666' }}>Duke ngarkuar foton…</div>}
              </div>
            </div>

            <div className="card">
              <div style={{ fontSize: 12, color: '#666' }}>
                * Kjo screen nuk shfaqet në UI normal. Hapet vetëm me HOLD 3 SEK te “PAGUAJ”.
              </div>
            </div>
          </div>

          <div className="payfs-footer" style={{ gridTemplateColumns: '1fr 1fr' }}>
            <button className="btn secondary" onClick={closeReturn} disabled={photoUploading}>
              ANULO
            </button>
            <button className="btn primary" onClick={confirmReturn} disabled={photoUploading}>
              KONFIRMO KTHIMIN
            </button>
          </div>
        </div>
      )}

      {/* Styles: dock + payfs */}
      <style jsx>{`
        .dock {
          position: sticky;
          bottom: 0;
          padding: 10px 0 6px 0;
          background: linear-gradient(to top, rgba(0, 0, 0, 0.9), rgba(0, 0, 0, 0));
          margin-top: 10px;
        }

        .payfs {
          position: fixed;
          inset: 0;
          background: #0b0b0b;
          z-index: 10000;
          display: flex;
          flex-direction: column;
        }
        .payfs-top {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 14px 14px;
          background: #0b0b0b;
          border-bottom: 1px solid rgba(255, 255, 255, 0.08);
        }
        .payfs-title {
          color: #fff;
          font-weight: 900;
          font-size: 18px;
        }
        .payfs-sub {
          color: rgba(255, 255, 255, 0.7);
          font-size: 12px;
          margin-top: 2px;
        }
        .payfs-body {
          flex: 1;
          overflow: auto;
          padding: 14px;
        }
        .payfs-footer {
          display: grid;
          grid-template-columns: 1fr 1fr 1fr;
          gap: 10px;
          padding: 12px 14px;
          border-top: 1px solid rgba(255, 255, 255, 0.08);
          background: #0b0b0b;
        }
        .payfs-footer .btn {
          width: 100%;
        }
      `}</style>
    </div>
  );
}