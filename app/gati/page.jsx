'use client';
import PosModal from '@/components/PosModal';

// app/gati/page.jsx

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { supabase } from '@/lib/supabaseClient';
import { recordOrderCashPayment } from '@/components/payments/payService';
import { saveOrderLocal, getAllOrdersLocal } from '@/lib/offlineStore';
import { queueOp } from '@/lib/offlineSyncClient';
import { requirePaymentPin } from '@/lib/paymentPin';
import RackLocationModal from '@/components/RackLocationModal';
import { loadSlotMap, saveSlotMap, releaseSlotsOwnedBy, reserveSlots } from '@/lib/rackLocations';

function readActor() {
  try {
    const raw = localStorage.getItem('CURRENT_USER_DATA');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

const BUCKET = 'tepiha-photos';
const PAY_CHIPS = [5, 10, 20, 30, 50];

// ---------------- SHARED RACK LOCATIONS ----------------
// ---------------- HELPERS ----------------
function normalizeCode(raw) {
  if (!raw) return '';
  const s = String(raw).trim();
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

function rowQty(row) {
  return Number(row?.qty ?? row?.pieces ?? 0) || 0;
}

function rowM2(row) {
  return Number(row?.m2 ?? row?.m ?? row?.area ?? 0) || 0;
}

function extractArray(obj, ...keys) {
  if (!obj || typeof obj !== 'object') return [];
  for (const k of keys) {
    if (Array.isArray(obj[k]) && obj[k].length > 0) return obj[k];
    if (obj.data && typeof obj.data === 'object' && Array.isArray(obj.data[k]) && obj.data[k].length > 0) return obj.data[k];
  }
  return [];
}
function getTepihaRows(order) { return extractArray(order, 'tepiha', 'tepihaRows'); }
function getStazaRows(order) { return extractArray(order, 'staza', 'stazaRows'); }
function getStairsQty(order) {
  if (!order || typeof order !== 'object') return 0;
  return Number(order?.shkallore?.qty) || Number(order?.data?.shkallore?.qty) || Number(order?.stairsQty) || Number(order?.data?.stairsQty) || 0;
}
function getStairsPer(order) {
  if (!order || typeof order !== 'object') return 0.3;
  return Number(order?.shkallore?.per) || Number(order?.data?.shkallore?.per) || Number(order?.stairsPer) || Number(order?.data?.stairsPer) || 0.3;
}
function computeM2(order) {
  if (!order) return 0;
  let total = 0;
  for (const r of getTepihaRows(order)) total += (Number(r?.m2 ?? r?.m ?? r?.area ?? 0) || 0) * (Number(r?.qty ?? r?.pieces ?? 0) || 0);
  for (const r of getStazaRows(order)) total += (Number(r?.m2 ?? r?.m ?? r?.area ?? 0) || 0) * (Number(r?.qty ?? r?.pieces ?? 0) || 0);
  total += getStairsQty(order) * getStairsPer(order);
  return Number(total.toFixed(2));
}

function computeTotalEuro(order) {
  if (!order) return 0;
  if (order.pay && typeof order.pay.euro === 'number') return Number(order.pay.euro) || 0;
  const m2 = computeM2(order);
  const rate = Number(order.pay?.rate || 0);
  return Number((m2 * rate).toFixed(2));
}

const round2 = (n) => {
  const num = Number(n || 0);
  return Math.round((num + Number.EPSILON) * 100) / 100;
};

function computePieces(order) {
  if (!order) return 0;
  let p = 0;
  for (const r of getTepihaRows(order)) p += (Number(r?.qty ?? r?.pieces ?? 0) || 0);
  for (const r of getStazaRows(order)) p += (Number(r?.qty ?? r?.pieces ?? 0) || 0);
  p += getStairsQty(order);
  return p;
}
function triggerFatalCacheHeal() {
  console.error('Fatal Cache Error Detected. Auto-healing...');
  try { localStorage.removeItem('tepiha_offline_queue_v1'); } catch {}
  try { localStorage.removeItem('tepiha_local_orders_v1'); } catch {}
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
  if (d <= 0) return '#16a34a';
  if (d === 1) return '#f59e0b';
  return '#dc2626';
}

function formatDayMonth(ts) {
  const d = new Date(ts || Date.now());
  if (Number.isNaN(d.getTime())) return '--/--';
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}`;
}

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

// ---------------- COMPONENT ----------------
export default function GatiPage() {
  const sp = useSearchParams();

  const holdTimer = useRef(null);
  const holdFired = useRef(false);

  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  const [showPlace, setShowPlace] = useState(false);
  const [placeBusy, setPlaceBusy] = useState(false);
  const [placeErr, setPlaceErr] = useState('');
  const [placeOrderId, setPlaceOrderId] = useState(null);
  const [placeOrder, setPlaceOrder] = useState(null);
  const [placeText, setPlaceText] = useState('');
  const [selectedSlots, setSelectedSlots] = useState([]);
  const [slotMap, setSlotMap] = useState({});

  const [showPaySheet, setShowPaySheet] = useState(false);
  const [payOrder, setPayOrder] = useState(null);
  const [payAdd, setPayAdd] = useState(0);
  const [payMethod, setPayMethod] = useState('CASH');
  const [payBusy, setPayBusy] = useState(false);
  const [payErr, setPayErr] = useState('');

  const [showReturnSheet, setShowReturnSheet] = useState(false);
  const [retOrder, setRetOrder] = useState(null);
  const [retReason, setRetReason] = useState('');
  const [retPhotoUrl, setRetPhotoUrl] = useState('');
  const [retBusy, setRetBusy] = useState(false);
  const [retErr, setRetErr] = useState('');
  const [photoUploading, setPhotoUploading] = useState(false);
  const returnPhotoInputRef = useRef(null);

  const [showCodeMenu, setShowCodeMenu] = useState(false);
  const [menuOrder, setMenuOrder] = useState(null);

  const [showEditSheet, setShowEditSheet] = useState(false);
  const [editOrder, setEditOrder] = useState(null);
  const [editBusy, setEditBusy] = useState(false);
  const [editErr, setEditErr] = useState('');
  const [editTepihaRows, setEditTepihaRows] = useState([{ id: 't1', m2: '', qty: '' }]);
  const [editStazaRows, setEditStazaRows] = useState([{ id: 's1', m2: '', qty: '' }]);
  const [editStairsQty, setEditStairsQty] = useState('0');
  const [editStairsPer, setEditStairsPer] = useState('0.3');

  useEffect(() => {
    try {
      const q = sp?.get('q') || '';
      if (q) setSearch(String(q));
    } catch {}
  }, [sp]);

  useEffect(() => {
    refreshOrders();
    return () => {
      if (holdTimer.current) clearTimeout(holdTimer.current);
    };
  }, []);

  async function dbFetchOrderById(idNum) {
    const { data, error } = await supabase
      .from('orders')
      .select('id,status,ready_at,picked_up_at,created_at,data')
      .eq('id', Number(idNum))
      .single();
    if (error || !data) throw error || new Error('ORDER_NOT_FOUND');

    const order = { ...(data.data || {}) };
    order.id = String(data.id);
    order.status = data.status;

    return { row: data, order };
  }

  async function refreshOrders() {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('orders')
        .select('id,status,ready_at,picked_up_at,created_at,data')
        .eq('status', 'gati')
        .order('ready_at', { ascending: false })
        .order('created_at', { ascending: false })
        .limit(500);

      let finalRows = [];

      if (error || !data) {
        try {
          const local = await getAllOrdersLocal().catch(() => []);
          const list = Array.isArray(local) ? local : [];
          finalRows = list
            .filter((o) => String(o?.status || '').toLowerCase() === 'gati')
            .map((o) => {
              const order = o || {};
              const m2 = computeM2(order);
              const total = Number(order.pay?.euro || computeTotalEuro(order));
              const paid = Number(order.pay?.paid || 0);
              const cope = computePieces(order);
              const readyTs = Number(order.ready_at || order.readyAt || order.ts || 0) || Date.now();
              return {
                id: String(order.id),
                ts: Number(order.ts || 0),
                readyTs,
                name: order.client?.name || '',
                phone: order.client?.phone || '',
                code: order.client?.code || order.code || '',
                m2,
                cope,
                total,
                paid,
                paidUpfront: !!order.pay?.paidUpfront,
                isReturn: !!order.returnInfo?.active,
                readyNote: String(order.ready_note || order.ready_location || ''),
              };
            });
        } catch (e) {
          console.error('LOCAL_FALLBACK failed:', e);
          triggerFatalCacheHeal();
          finalRows = [];
        }
      } else {
        finalRows = (data || []).map((row) => {
          let raw = row.data;
          if (typeof raw === 'string') {
            try {
              raw = JSON.parse(raw);
            } catch {
              raw = {};
            }
          }
          const order = { ...(raw || {}) };

          if (!Array.isArray(order.tepiha) && Array.isArray(order.tepihaRows)) {
            order.tepiha = order.tepihaRows.map((r) => ({
              m2: Number(r?.m2) || 0,
              qty: Number(r?.qty ?? r?.pieces ?? 0) || 0,
              photoUrl: r?.photoUrl || '',
            }));
          }
          if (!Array.isArray(order.staza) && Array.isArray(order.stazaRows)) {
            order.staza = order.stazaRows.map((r) => ({
              m2: Number(r?.m2) || 0,
              qty: Number(r?.qty ?? r?.pieces ?? 0) || 0,
              photoUrl: r?.photoUrl || '',
            }));
          }
          order.id = String(row.id);
          order.status = row.status;

          try {
            saveOrderLocal({ ...order, id: String(row.id), status: 'gati', ready_at: row.ready_at || null });
          } catch {}

          const m2 = computeM2(order);
          const total = Number(order.pay?.euro || computeTotalEuro(order));
          const paid = Number(order.pay?.paid || 0);
          const cope = computePieces(order);
          const readyTs = (row.ready_at ? Date.parse(row.ready_at) : 0) || Number(order.ready_at) || Number(order.ts) || Date.now();

          return {
            id: String(order.id),
            ts: Number(order.ts || 0),
            readyTs,
            name: order.client?.name || '',
            phone: order.client?.phone || '',
            code: order.client?.code || order.code || '',
            m2,
            cope,
            total,
            paid,
            paidUpfront: !!order.pay?.paidUpfront,
            isReturn: !!order.returnInfo?.active,
            readyNote: String(order.ready_note || order.ready_location || ''),
          };
        });
      }

      const baseOnly = finalRows.filter((r) => !/^T\d+$/i.test(String(r.code || '').trim()));
      baseOnly.sort((a, b) => (b.readyTs || 0) - (a.readyTs || 0));
      setOrders(baseOnly);

      if (typeof window !== 'undefined') {
        setTimeout(() => {
          try {
            const activeIds = new Set(baseOnly.map((o) => String(o.id)));
            let map = loadSlotMap();
            let changed = false;
            for (const key of Object.keys(map)) {
              const originalLength = map[key].length;
              map[key] = map[key].filter((owner) => activeIds.has(String(owner.orderId)));
              if (map[key].length !== originalLength) changed = true;
              if (map[key].length === 0) delete map[key];
            }
            if (changed) saveSlotMap(map);
          } catch (e) {}
        }, 1000);
      }
    } catch (e) {
      console.error('Gati refresh failed:', e);
      triggerFatalCacheHeal();
      setOrders([]);
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

  function sendPickupSms(row) {
    const phone = sanitizePhone(row.phone || '');
    if (!phone) return alert('Nuk ka numër telefoni.');
    const code = normalizeCode(row.code);
    const paidTxt = row.paidUpfront ? '\n✅ KJO POROSI ËSHTË PAGUAR NË FILLIM.' : '';
    const msg = `Përshëndetje ${row.name || 'klient'}, porosia juaj${code ? ` (kodi ${code})` : ''} është GATI.\nKeni ${row.cope || 0} copë • ${(Number(row.m2) || 0).toFixed(2)} m².${paidTxt}\n\nJu lutem ejani sot ose nesër me i marrë tepihat, sepse kemi mungesë të vendit në depo.\nFaleminderit!`;
    window.location.href = `sms:${phone}?&body=${encodeURIComponent(msg)}`;
  }

  // ---------------- KU E LAM ----------------
  async function openPlaceCard(row) {
    try {
      setPlaceErr('');
      setPlaceBusy(true);
      setShowPlace(true);
      setPlaceOrderId(String(row?.id || ''));

      let map = {};
      try {
        map = loadSlotMap();
      } catch {}
      setSlotMap(map);

      const { order } = await dbFetchOrderById(row?.id);
      setPlaceOrder(order);

      setSelectedSlots(Array.isArray(order?.ready_slots) ? order.ready_slots : []);
      setPlaceText(order?.ready_note_text || '');
    } catch (e) {
      setPlaceErr('Nuk u hap kartela. Provo prap.');
      setPlaceOrder(null);
      setPlaceText('');
      setSelectedSlots([]);
    } finally {
      setPlaceBusy(false);
    }
  }

  function closePlaceCard() {
    setShowPlace(false);
    setPlaceErr('');
    setPlaceOrderId(null);
    setPlaceOrder(null);
    setPlaceText('');
    setSelectedSlots([]);
  }

  function toggleSlot(s) {
    setSelectedSlots((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));
  }

  async function savePlaceCard() {
    if (!placeOrderId) return;

    const txt = String(placeText || '').trim();
    const actor = readActor();
    const meta = {
      code: normalizeCode(placeOrder?.code || placeOrder?.client?.code || ''),
      name: (placeOrder?.client?.name || placeOrder?.client_name || '').trim(),
    };

    const finalNoteString = selectedSlots.length > 0 ? `📍 [${selectedSlots.join(', ')}] ${txt}`.trim() : txt;

    const patch = {
      ready_note: finalNoteString,
      ready_note_text: txt,
      ready_note_at: new Date().toISOString(),
      ready_note_by: actor?.name || actor?.role || 'UNKNOWN',
      ready_slots: selectedSlots,
    };

    setPlaceBusy(true);
    setPlaceErr('');
    try {
      const merged = { ...(placeOrder || {}), ...patch };

      try {
        const cur = loadSlotMap();
        const released = releaseSlotsOwnedBy(cur, placeOrderId);
        const reserved = reserveSlots(released, placeOrderId, meta, selectedSlots);
        saveSlotMap(reserved);
        setSlotMap(reserved);
      } catch {}

      try {
        await saveOrderLocal(merged);
      } catch {}
      try {
        localStorage.setItem(`order_${placeOrderId}`, JSON.stringify(merged));
      } catch {}

      let online = typeof navigator === 'undefined' ? true : navigator.onLine !== false;

      if (online) {
        const { error: dbErr } = await supabase
          .from('orders')
          .update({ data: merged, updated_at: new Date().toISOString() })
          .eq('id', placeOrderId);
        if (dbErr) throw dbErr;
      } else {
        await queueOp('patch_order_data', { id: placeOrderId, data_patch: patch });
      }

      setOrders((prev) =>
        (prev || []).map((x) =>
          String(x.id) === String(placeOrderId)
            ? { ...x, readyNote: finalNoteString, readySlots: selectedSlots }
            : x
        )
      );
      closePlaceCard();
    } catch (e) {
      try {
        await queueOp('patch_order_data', { id: placeOrderId, data_patch: patch });
      } catch {}
      setPlaceErr("S'u ruajt online, por u ruajt lokalisht.");
    } finally {
      setPlaceBusy(false);
    }
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
        const res = await dbFetchOrderById(row.id);
        order = res.order;
        localStorage.setItem(`order_${row.id}`, JSON.stringify(order));
      }
      if (!order) return alert('Nuk u gjet porosia.');

      const total = Number(order.pay?.euro || computeTotalEuro(order)) || 0;
      const paid = Number(order.pay?.paid || 0) || 0;

      setPayOrder({
        id: String(row.id),
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
      const dueNow = Math.max(0, Number((total - paid).toFixed(2)));
      setPayAdd(dueNow);
      setPayMethod('CASH');
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

  // PAGESA PA DORËZUAR
  async function applyPayOnly() {
    if (!payOrder) return;

    const due = Math.max(0, Number((Number(payOrder.total || 0) - Number(payOrder.paid || 0)).toFixed(2)));
    const payNow = Number((Number(payAdd) || 0).toFixed(2));

    if (due <= 0) {
      alert('KJO POROSI ËSHTË E PAGUAR PLOTËSISHT.');
      return;
    }
    if (payNow <= 0) {
      alert('SHKRUANI SHUMËN!');
      return;
    }
    const applied = Math.min(payNow, due);
    const kusuri = Math.max(0, payNow - due);

    const pinLabel = `PAGESË: ${applied.toFixed(2)}€
KLIENTI DHA: ${payNow.toFixed(2)}€
KUSURI (RESTO): ${kusuri.toFixed(2)}€

👉 SHKRUAJ PIN-IN TËND PËR TË KRYER PAGESËN:`;
    const pinData = await requirePaymentPin({ label: pinLabel });
    if (!pinData) return;

    // OPTIMISTIC UI
    const newPaid = Number((Number(payOrder.paid || 0) + applied).toFixed(2));
    const newDebt = Math.max(0, Number((Number(payOrder.total || 0) - newPaid).toFixed(2)));
    setPayOrder({ ...payOrder, paid: newPaid, debt: newDebt, isPaid: newDebt <= 0 });
    setOrders((prev) =>
      (prev || []).map((o) =>
        o.id === payOrder.id ? { ...o, paid: newPaid, debt: newDebt, isPaid: newDebt <= 0 } : o
      )
    );

    closePay();

    // Background network work
    const snap = { ...payOrder, paid: newPaid, debt: newDebt, isPaid: newDebt <= 0 };
    void (async () => {
      try {
        setPayBusy(true);
        setPayErr(null);
        await recordOrderCashPayment(snap, applied, pinData, payMethod);
        await refreshOrders();
      } catch (e) {
        setPayErr(e?.message || 'Gabim pagesë');
      } finally {
        setPayBusy(false);
      }
    })();
  }

  // DORËZIMI FINAL DHE PAGESA
  async function confirmDelivery() {
    if (!payOrder) return;

    // 1) Validate payment (if any)
    const due = Math.max(0, Number((Number(payOrder.total || 0) - Number(payOrder.paid || 0)).toFixed(2)));
    const payNow = Number((Number(payAdd) || 0).toFixed(2));
    if (payNow < 0) {
      alert('SHUMA E PAVLEFSHME!');
      return;
    }
    const applied = Math.min(payNow, due);
    const kusuri = Math.max(0, payNow - due);

    const newPaid = Number((Number(payOrder.paid || 0) + applied).toFixed(2));
    const newDebt = Math.max(0, Number((Number(payOrder.total || 0) - newPaid).toFixed(2)));

    // 2) Require PIN
    const pinLabel = `DORËZIM POROSIE\nKODI: ${payOrder.code}\n\nPAGESË SOT: ${applied.toFixed(2)}€\nKLIENTI DHA: ${payNow.toFixed(2)}€
KUSURI: ${kusuri.toFixed(2)}€
BORXHI PAS: ${newDebt.toFixed(2)}€\n\n👉 SHKRUAJ PIN-IN TËND PËR TË KONFIRMUAR:`;
    const pinData = await requirePaymentPin({ label: pinLabel });
    if (!pinData) return;

    // OPTIMISTIC UI: hiqe nga lista dhe mbyll modalin menjëherë
    const snapOrder = {
      ...payOrder,
      paid: newPaid,
      debt: newDebt,
      isPaid: newDebt <= 0,
      status: 'dorzim',
      delivered_at: new Date().toISOString(),
      delivered_by: pinData?.pin || null,
    };

    setOrders((prev) => (prev || []).filter((o) => o.id !== payOrder.id));
    closePay();

    // Background: DB + arka + foto nënshkrimi + refresh
    void (async () => {
      try {
        setPayBusy(true);
        setPayErr(null);

        const payload = {
          ...snapOrder,
          status: 'dorzim',
          delivered_at: snapOrder.delivered_at,
          delivered_by: snapOrder.delivered_by,
        };

        // Save local mirror (mos blloko UI edhe nëse dështon)
        try {
          localStorage.setItem(`tepiha_delivered_${snapOrder.id}`, JSON.stringify(payload));
          await saveOrderLocal({
            id: snapOrder.id,
            status: 'dorzim',
            data: payload,
            updated_at: payload.delivered_at,
            _synced: false,
            _table: 'orders',
          });
        } catch (e) {}

        // Record payment if any
        if (applied > 0) {
          try {
            await recordOrderCashPayment(payload, applied, pinData, payMethod);
          } catch (e) {}
        }

        // Update server (orders table)
        try {
          const { error: upErr2 } = await supabase
            .from('orders')
            .update({ status: 'dorzim', data: payload, updated_at: payload.delivered_at })
            .eq('id', snapOrder.id);
          if (upErr2) throw upErr2;
        } catch (e) {
          // fallback queue
          try {
            await queueOp('patch_order_data', {
              id: snapOrder.id,
              data_patch: {
                status: 'dorzim',
                delivered_at: payload.delivered_at,
                delivered_by: payload.delivered_by,
                paid: payload.paid,
                debt: payload.debt,
                isPaid: payload.isPaid,
              },
            });
          } catch (e2) {}
        }

        await refreshOrders();
      } catch (e) {
        setPayErr(e?.message || 'Gabim dorëzim');
        await refreshOrders();
      } finally {
        setPayBusy(false);
      }
    })();
  }

  // ---------------- HIDDEN RETURN ----------------
  async function openReturn(row) {
    try {
      setRetErr('');
      setRetBusy(true);
      let order = null;

      try {
        const res = await dbFetchOrderById(row.id);
        order = res?.order || null;
        if (order) {
          try { localStorage.setItem(`order_${row.id}`, JSON.stringify(order)); } catch {}
        }
      } catch {}

      if (!order) {
        try {
          const raw = localStorage.getItem(`order_${row.id}`);
          if (raw) order = JSON.parse(raw);
        } catch {
          order = null;
        }
      }

      if (!order) {
        try {
          order = await downloadJsonNoCache(`orders/${row.id}.json`);
          try { localStorage.setItem(`order_${row.id}`, JSON.stringify(order)); } catch {}
        } catch {}
      }

      if (!order) throw new Error('ORDER_NOT_FOUND');

      if (!order.db_id && row?.id) order.db_id = row.id;
      if (!order.id && row?.id) order.id = row.id;
      if (!order.data || typeof order.data !== 'object') order.data = {};

      setRetOrder(order);
      setRetReason('');
      setRetPhotoUrl('');
      setShowReturnSheet(true);
    } catch (e) {
      setRetErr('Gabim gjatë hapjes së kthimit.');
      alert('❌ Gabim gjatë hapjes së kthimit.');
    } finally {
      setRetBusy(false);
    }
  }

  function closeReturn() {
    setShowReturnSheet(false);
    setRetOrder(null);
    setRetReason('');
    setRetPhotoUrl('');
    setRetErr('');
    setRetBusy(false);
    try { if (returnPhotoInputRef.current) returnPhotoInputRef.current.value = ''; } catch {}
  }

  async function handleReturnPhoto(file) {
    const oid = retOrder?.id || retOrder?.db_id;
    if (!file || !oid) return;
    setPhotoUploading(true);
    setRetErr('');
    try {
      const url = await uploadPhoto(file, oid, 'return');
      if (url) setRetPhotoUrl(url);
    } catch {
      setRetErr('Gabim gjatë ngarkimit të fotos.');
      alert('❌ Gabim foto!');
    } finally {
      setPhotoUploading(false);
    }
  }

  async function confirmReturn() {
    const oid = retOrder?.id || retOrder?.db_id || retOrder?.data?.db_id || null;
    if (!oid) return;

    const reason = (retReason || '').trim();
    if (!reason) {
      setRetErr('Shkruaj arsyen e kthimit.');
      return;
    }

    const at = Date.now();
    const entry = {
      id: `ret_${oid}_${at}`,
      ts: at,
      from: 'gati',
      reason,
      photoUrl: retPhotoUrl || '',
    };

    const returnInfo = {
      active: true,
      reason,
      photoUrl: retPhotoUrl || '',
      at,
    };

    const nextData = {
      ...((retOrder?.data && typeof retOrder.data === 'object') ? retOrder.data : {}),
      returnInfo,
      returnLog: Array.isArray(retOrder?.data?.returnLog) ? [entry, ...retOrder.data.returnLog] : [entry],
      ready_at: null,
      picked_up_at: null,
      delivered_at: null,
    };

    const updated = {
      ...retOrder,
      id: retOrder?.id || oid,
      db_id: retOrder?.db_id || retOrder?.data?.db_id || oid,
      status: 'pastrim',
      data: nextData,
      returnInfo,
      returnLog: nextData.returnLog,
      ready_at: null,
      picked_up_at: null,
      delivered_at: null,
    };

    setRetBusy(true);
    setRetErr('');
    try {
      try {
        await saveOrderLocal(updated);
      } catch {}
      try {
        localStorage.setItem(`order_${updated.id}`, JSON.stringify(updated));
      } catch {}

      const blob = typeof Blob !== 'undefined' ? new Blob([JSON.stringify(updated)], { type: 'application/json' }) : null;
      if (blob) {
        await supabase.storage.from(BUCKET).upload(`orders/${updated.id}.json`, blob, {
          upsert: true,
          cacheControl: '0',
          contentType: 'application/json',
        });
      }

      const { error: dbErr } = await supabase
        .from('orders')
        .update({
          status: 'pastrim',
          ready_at: null,
          picked_up_at: null,
          data: nextData,
          updated_at: new Date().toISOString(),
        })
        .eq('id', updated.db_id);
      if (dbErr) throw dbErr;

      try {
        const blob2 = typeof Blob !== 'undefined' ? new Blob([JSON.stringify(entry)], { type: 'application/json' }) : null;
        if (blob2) {
          await supabase.storage.from(BUCKET).upload(`returns/${entry.id}.json`, blob2, {
            upsert: true,
            cacheControl: '0',
            contentType: 'application/json',
          });
        }
      } catch {}

      closeReturn();
      await refreshOrders();
    } catch (e) {
      try {
        await queueOp('patch_order_data', {
          id: updated.db_id || updated.id,
          data_patch: nextData,
        });
      } catch {}
      setRetErr(e?.message || 'Gabim gjatë ruajtjes së kthimit.');
      alert('❌ Gabim gjatë ruajtjes së kthimit.');
    } finally {
      setRetBusy(false);
    }
  }


  function openCodeMenu(row) {
    setMenuOrder(row || null);
    setShowCodeMenu(true);
  }

  function closeCodeMenu() {
    setShowCodeMenu(false);
    setMenuOrder(null);
  }

  async function openEditMeasures(row) {
    try {
      setEditErr('');
      setEditBusy(true);
      let order = null;

      try {
        const res = await dbFetchOrderById(row.id);
        order = res?.order || null;
      } catch {}

      if (!order) {
        try {
          const raw = localStorage.getItem(`order_${row.id}`);
          if (raw) order = JSON.parse(raw);
        } catch {}
      }

      if (!order) {
        try {
          order = await downloadJsonNoCache(`orders/${row.id}.json`);
        } catch {}
      }

      if (!order) throw new Error('ORDER_NOT_FOUND');

      if (!order.id) order.id = row.id;
      if (!order.db_id) order.db_id = row.id;

      const tList = getTepihaRows(order);
      const sList = getStazaRows(order);

      setEditOrder(order);
      setEditTepihaRows(
        tList.length
          ? tList.map((x, i) => ({ id: `t${i + 1}`, m2: String(x?.m2 ?? x?.m ?? x?.area ?? ''), qty: String(x?.qty ?? x?.pieces ?? '') }))
          : [{ id: 't1', m2: '', qty: '' }]
      );
      setEditStazaRows(
        sList.length
          ? sList.map((x, i) => ({ id: `s${i + 1}`, m2: String(x?.m2 ?? x?.m ?? x?.area ?? ''), qty: String(x?.qty ?? x?.pieces ?? '') }))
          : [{ id: 's1', m2: '', qty: '' }]
      );
      setEditStairsQty(String(getStairsQty(order) || 0));
      setEditStairsPer(String(getStairsPer(order) || 0.3));
      setShowEditSheet(true);
    } catch (e) {
      setEditErr('Gabim gjatë hapjes së editimit.');
      alert('❌ Gabim gjatë hapjes së editimit.');
    } finally {
      setEditBusy(false);
    }
  }

  function closeEditSheet() {
    setShowEditSheet(false);
    setEditOrder(null);
    setEditErr('');
    setEditBusy(false);
    setEditTepihaRows([{ id: 't1', m2: '', qty: '' }]);
    setEditStazaRows([{ id: 's1', m2: '', qty: '' }]);
    setEditStairsQty('0');
    setEditStairsPer('0.3');
  }

  function addEditRow(kind) {
    if (kind === 'tepiha') {
      setEditTepihaRows((prev) => [...prev, { id: `t${prev.length + 1}`, m2: '', qty: '' }]);
      return;
    }
    setEditStazaRows((prev) => [...prev, { id: `s${prev.length + 1}`, m2: '', qty: '' }]);
  }

  function updateEditRow(kind, id, field, value) {
    const setter = kind === 'tepiha' ? setEditTepihaRows : setEditStazaRows;
    setter((prev) => prev.map((row) => (row.id === id ? { ...row, [field]: value } : row)));
  }

  function removeEditRow(kind, id) {
    const setter = kind === 'tepiha' ? setEditTepihaRows : setEditStazaRows;
    setter((prev) => {
      const next = prev.filter((row) => row.id !== id);
      if (next.length) return next;
      return [kind === 'tepiha' ? { id: 't1', m2: '', qty: '' } : { id: 's1', m2: '', qty: '' }];
    });
  }

  async function saveEditMeasures() {
    if (!editOrder) return;
    setEditBusy(true);
    setEditErr('');
    try {
      const cleanRows = (rows) =>
        (rows || [])
          .map((r) => ({
            m2: Number(r?.m2 || 0) || 0,
            qty: Number(r?.qty || 0) || 0,
          }))
          .filter((r) => r.m2 > 0 && r.qty > 0);

      const tepiha = cleanRows(editTepihaRows);
      const staza = cleanRows(editStazaRows);
      const shkallore = {
        qty: Number(editStairsQty || 0) || 0,
        per: Number(editStairsPer || 0.3) || 0.3,
      };

      const nextData = {
        ...((editOrder?.data && typeof editOrder.data === 'object') ? editOrder.data : {}),
        tepiha,
        tepihaRows: tepiha,
        staza,
        stazaRows: staza,
        shkallore,
        stairsQty: shkallore.qty,
        stairsPer: shkallore.per,
      };

      const updated = {
        ...editOrder,
        data: nextData,
        tepiha,
        tepihaRows: tepiha,
        staza,
        stazaRows: staza,
        shkallore,
        stairsQty: shkallore.qty,
        stairsPer: shkallore.per,
      };

      try { await saveOrderLocal(updated); } catch {}
      try { localStorage.setItem(`order_${updated.id}`, JSON.stringify(updated)); } catch {}

      const { error: dbErr } = await supabase
        .from('orders')
        .update({ data: nextData, updated_at: new Date().toISOString() })
        .eq('id', updated.db_id || updated.id);
      if (dbErr) throw dbErr;

      setOrders((prev) =>
        (prev || []).map((o) =>
          String(o.id) === String(updated.id)
            ? { ...o, m2: computeM2(updated), cope: computePieces(updated), total: Number(updated.pay?.euro || computeTotalEuro(updated)) }
            : o
        )
      );
      closeEditSheet();
    } catch (e) {
      setEditErr(e?.message || 'Gabim gjatë ruajtjes së masave.');
    } finally {
      setEditBusy(false);
    }
  }

  function onPayPressStart(row) {
    holdFired.current = false;
    if (holdTimer.current) clearTimeout(holdTimer.current);
    holdTimer.current = setTimeout(() => {
      holdFired.current = true;
      openReturn(row);
    }, 2000);
  }
  function onPayPressEnd(row) {
    if (holdTimer.current) {
      clearTimeout(holdTimer.current);
      holdTimer.current = null;
    }
    if (holdFired.current) return;
    openPay(row);
  }

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
                      cursor: 'pointer',
                    }}
                    onClick={() => openCodeMenu(o)}
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
                    <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.48)', marginTop: 2 }}>
                      PRANUAR: {formatDayMonth(o.ts)}
                    </div>
                    {o.paidUpfront && (
                      <div style={{ fontSize: 11, color: '#16a34a', fontWeight: 900 }}>✅ E PAGUAR (NË FILLIM)</div>
                    )}
                    {paid > 0 && !o.paidUpfront && (
                      <div style={{ fontSize: 11, color: '#16a34a', fontWeight: 800 }}>Paguar: {paid.toFixed(2)}€</div>
                    )}
                    {debt > 0 && !o.paidUpfront && (
                      <div style={{ fontSize: 11, color: '#dc2626', fontWeight: 900 }}>Borxh: {debt.toFixed(2)}€</div>
                    )}
                    <div style={{ fontSize: 11, color: o.readyNote ? '#4ade80' : '#f59e0b', fontWeight: 800 }}>
                      {o.readyNote ? String(o.readyNote).split('\n')[0].slice(0, 42) : '📍 PA VEND'}
                    </div>
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  {isPaid && <span style={{ fontSize: 14 }}>✅</span>}
                  <button className="btn secondary" style={{ padding: '6px 10px', fontSize: 12 }} onClick={() => sendPickupSms(o)}>
                    SMS
                  </button>
                  <button
                    className="btn primary"
                    style={{ padding: '6px 10px', fontSize: 12, touchAction: 'manipulation' }}
                    onPointerDown={(e) => {
                      e.preventDefault();
                      onPayPressStart(o);
                    }}
                    onPointerUp={(e) => {
                      e.preventDefault();
                      onPayPressEnd(o);
                    }}
                    onPointerCancel={() => {
                      if (holdTimer.current) clearTimeout(holdTimer.current);
                    }}
                    onPointerLeave={() => {
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

      {showCodeMenu && menuOrder && (
        <div className="payfs">
          <div className="payfs-top">
            <div>
              <div className="payfs-title">VEPRIMET E KODIT</div>
              <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.65)', marginTop: 4 }}>
                KODI: {normalizeCode(menuOrder.code)}
              </div>
            </div>
            <button className="btn secondary" onClick={closeCodeMenu}>✕</button>
          </div>
          <div className="payfs-body">
            <div className="card" style={{ marginTop: 0, display: 'grid', gap: 10 }}>
              <button
                className="btn secondary"
                onClick={() => {
                  const row = menuOrder;
                  closeCodeMenu();
                  openPlaceCard(row);
                }}
                style={{ width: '100%', padding: 14, fontWeight: 900 }}
              >
                📍 VENDOS LOKACIONIN
              </button>
              <button
                className="btn secondary"
                onClick={() => {
                  const row = menuOrder;
                  closeCodeMenu();
                  openEditMeasures(row);
                }}
                style={{ width: '100%', padding: 14, fontWeight: 900 }}
              >
                ✏️ EDITO MASAT
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ============ PAGESA ME DIZAJN TE RI ARKË (POS) ============ */}
      {showPaySheet && payOrder && (
        <PosModal
          open={showPaySheet}
          onClose={() => setShowPaySheet(false)}
          title="DORËZIMI & PAGESA"
          subtitle={`KODI: ${normalizeCode(payOrder.code)} • ${payOrder.name || ''}`}
          total={Number(payOrder.total || 0)}
          alreadyPaid={Number(payOrder.paid || 0)}
          amount={payAdd}
          setAmount={setPayAdd}
          payChips={PAY_CHIPS}
          confirmText="KONFIRMO DORËZIMIN"
          cancelText="ANULO"
          disabled={payBusy}
          onConfirm={confirmDelivery}
          footerNote={
            <button
              className="btn secondary"
              onClick={applyPayOnly}
              disabled={payBusy}
              style={{
                width: '100%',
                padding: '12px',
                marginTop: '10px',
                background: 'rgba(59,130,246,0.15)',
                color: '#60a5fa',
                border: '1px solid rgba(59,130,246,0.3)',
                fontWeight: 'bold',
              }}
            >
              PAGUAJ PA DORËZU
            </button>
          }
        />
      )}

      {showEditSheet && editOrder && (
        <div className="payfs">
          <div className="payfs-top">
            <div>
              <div className="payfs-title">EDITO MASAT</div>
              <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.65)', marginTop: 4 }}>
                KODI: {normalizeCode(editOrder?.client?.code || editOrder?.code)}
              </div>
            </div>
            <button className="btn secondary" onClick={closeEditSheet} disabled={editBusy}>✕</button>
          </div>
          <div className="payfs-body">
            <div className="card" style={{ marginTop: 0, display: 'grid', gap: 14 }}>
              <div>
                <div className="label" style={{ marginBottom: 8 }}>TEPIHA</div>
                <div style={{ display: 'grid', gap: 8 }}>
                  {editTepihaRows.map((row) => (
                    <div key={row.id} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 8 }}>
                      <input className="input" inputMode="decimal" placeholder="m²" value={row.m2} onChange={(e) => updateEditRow('tepiha', row.id, 'm2', e.target.value)} />
                      <input className="input" inputMode="numeric" placeholder="copë" value={row.qty} onChange={(e) => updateEditRow('tepiha', row.id, 'qty', e.target.value)} />
                      <button className="btn secondary" type="button" onClick={() => removeEditRow('tepiha', row.id)}>✕</button>
                    </div>
                  ))}
                </div>
                <button className="btn secondary" type="button" onClick={() => addEditRow('tepiha')} style={{ marginTop: 8 }}>+ SHTO RRESHT</button>
              </div>

              <div>
                <div className="label" style={{ marginBottom: 8 }}>STAZA</div>
                <div style={{ display: 'grid', gap: 8 }}>
                  {editStazaRows.map((row) => (
                    <div key={row.id} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 8 }}>
                      <input className="input" inputMode="decimal" placeholder="m²" value={row.m2} onChange={(e) => updateEditRow('staza', row.id, 'm2', e.target.value)} />
                      <input className="input" inputMode="numeric" placeholder="copë" value={row.qty} onChange={(e) => updateEditRow('staza', row.id, 'qty', e.target.value)} />
                      <button className="btn secondary" type="button" onClick={() => removeEditRow('staza', row.id)}>✕</button>
                    </div>
                  ))}
                </div>
                <button className="btn secondary" type="button" onClick={() => addEditRow('staza')} style={{ marginTop: 8 }}>+ SHTO RRESHT</button>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <div>
                  <div className="label" style={{ marginBottom: 8 }}>SHKALLORE COPË</div>
                  <input className="input" inputMode="numeric" value={editStairsQty} onChange={(e) => setEditStairsQty(e.target.value)} />
                </div>
                <div>
                  <div className="label" style={{ marginBottom: 8 }}>M² / COPË</div>
                  <input className="input" inputMode="decimal" value={editStairsPer} onChange={(e) => setEditStairsPer(e.target.value)} />
                </div>
              </div>

              {editErr ? <div style={{ color: '#fca5a5', fontSize: 13, fontWeight: 800 }}>{editErr}</div> : null}
            </div>
          </div>
          <div className="payfs-footer">
            <button className="btn secondary" onClick={closeEditSheet} disabled={editBusy}>ANULO</button>
            <button className="btn primary" onClick={saveEditMeasures} disabled={editBusy}>{editBusy ? 'DUKE RUAJTUR...' : 'RUAJ MASAT'}</button>
          </div>
        </div>
      )}

      {/* ============ KTHIMI NË PASTRIM ============ */}
      {showReturnSheet && retOrder && (
        <div className="payfs">
          <div className="payfs-top">
            <div>
              <div className="payfs-title">KTHIMI NË PASTRIM</div>
              <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.65)', marginTop: 4 }}>
                Shkruaj arsyen dhe shto foto nëse duhet.
              </div>
            </div>
            <button className="btn secondary" onClick={closeReturn} disabled={retBusy || photoUploading}>
              ✕
            </button>
          </div>
          <div className="payfs-body">
            <div className="card" style={{ marginTop: 0 }}>
              <div style={{ display: 'grid', gap: 12 }}>
                <div>
                  <div className="label" style={{ marginBottom: 8 }}>ARSYEJA E KTHIMIT</div>
                  <textarea
                    className="input"
                    value={retReason}
                    onChange={(e) => setRetReason(e.target.value)}
                    placeholder="p.sh. ka mbetur njollë, duhet ripastruar..."
                    rows={5}
                    style={{ minHeight: 120, resize: 'vertical', paddingTop: 12 }}
                  />
                </div>

                <div>
                  <div className="label" style={{ marginBottom: 8 }}>FOTO E PROBLEMIT</div>
                  <input
                    ref={returnPhotoInputRef}
                    type="file"
                    accept="image/*"
                    capture="environment"
                    onChange={(e) => handleReturnPhoto(e.target.files?.[0] || null)}
                    style={{ display: 'none' }}
                  />
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                    <button
                      className="btn secondary"
                      type="button"
                      onClick={() => returnPhotoInputRef.current?.click()}
                      disabled={retBusy || photoUploading}
                      style={{ minWidth: 160 }}
                    >
                      {photoUploading ? 'DUKE NGARKUAR...' : '📷 BASHKANGJIT FOTO'}
                    </button>
                    {retPhotoUrl ? (
                      <a
                        href={retPhotoUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="btn secondary"
                        style={{ textDecoration: 'none' }}
                      >
                        SHIKO FOTON
                      </a>
                    ) : null}
                  </div>
                </div>

                {retErr ? (
                  <div style={{ color: '#fca5a5', fontSize: 13, fontWeight: 800 }}>
                    {retErr}
                  </div>
                ) : null}
              </div>
            </div>
          </div>
          <div className="payfs-footer">
            <button className="btn secondary" onClick={closeReturn} disabled={retBusy || photoUploading}>
              ANULO
            </button>
            <button className="btn primary" onClick={confirmReturn} disabled={retBusy || photoUploading}>
              {retBusy ? 'DUKE RUAJTUR...' : 'KONFIRMO KTHIMIN'}
            </button>
          </div>
        </div>
      )}

      {/* ============ KARTELA E VENDOSJES (MULTIPLE ORDERS PER SPOT) ============ */}
      <RackLocationModal
        open={showPlace}
        busy={placeBusy}
        title="POZICIONI"
        subtitle="Zgjidh një ose më shumë vende"
        orderId={placeOrderId}
        orderCode={normalizeCode(placeOrder?.code || placeOrder?.client?.code)}
        slotMap={slotMap}
        selectedSlots={selectedSlots}
        onToggleSlot={toggleSlot}
        placeText={placeText}
        onPlaceTextChange={setPlaceText}
        placeErr={placeErr}
        onClose={closePlaceCard}
        onClear={() => {
          setSelectedSlots([]);
          setPlaceText('');
        }}
        onSave={savePlaceCard}
        saveLabel="RUAJ POZICIONIN"
      />

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
          z-index: 9999;
          background: rgba(5, 8, 12, 0.96);
          display: flex;
          flex-direction: column;
          backdrop-filter: blur(8px);
          -webkit-backdrop-filter: blur(8px);
        }
        .payfs-top {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 12px;
          padding: 14px 14px;
          background: #0b0f14;
          border-bottom: 1px solid rgba(255, 255, 255, 0.08);
          position: sticky;
          top: 0;
          z-index: 2;
        }
        .payfs-title {
          color: #fff;
          font-weight: 900;
          font-size: 18px;
          letter-spacing: 0.02em;
        }
        .payfs-sub {
          color: rgba(255, 255, 255, 0.72);
          font-size: 12px;
          margin-top: 2px;
          line-height: 1.25;
        }
        .payfs-body {
          flex: 1;
          overflow: auto;
          padding: 14px;
        }
        .payfs-footer {
          display: flex;
          gap: 10px;
          padding: 12px 14px calc(12px + env(safe-area-inset-bottom, 0px));
          border-top: 1px solid rgba(255, 255, 255, 0.08);
          background: #0b0f14;
          position: sticky;
          bottom: 0;
          z-index: 2;
        }
        .payfs-footer .btn {
          flex: 1;
          padding: 16px 0;
        }
      `}</style>
    </div>
  );
}
