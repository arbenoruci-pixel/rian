'use client';

// app/gati/page.jsx

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { supabase } from '@/lib/supabaseClient';
import { recordOrderCashPayment } from '@/components/payments/payService';
import { saveOrderToDb, updateOrderInDb } from '@/lib/ordersDb';
import { saveOrderLocal, getAllOrdersLocal } from '@/lib/offlineStore';
import { queueOp } from '@/lib/offlineSyncClient';

function readActor() {
  try {
    const raw = localStorage.getItem('CURRENT_USER_DATA');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

const BUCKET = 'tepiha-photos';

// PAGESA CHIPS
const PAY_CHIPS = [5, 10, 20, 30, 50];

// ---------------- SLOT MAP (A1..A20, B1..B20) ----------------
// Local-only reservation so the same slot can't be assigned to two orders.
// Released automatically on delivery (status -> 'dorzim').
const SLOT_MAP_KEY = 'tepiha_gati_slot_map_v1';

function loadSlotMap() {
  try {
    const raw = localStorage.getItem(SLOT_MAP_KEY);
    const obj = raw ? JSON.parse(raw) : {};
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    return {};
  }
}

function saveSlotMap(map) {
  try {
    localStorage.setItem(SLOT_MAP_KEY, JSON.stringify(map || {}));
  } catch {}
}

function parseSlotsFromText(text) {
  const slots = new Set();
  const lines = String(text || '').split('\n');
  for (const ln of lines) {
    const m = String(ln || '').trim().match(/^([AB])\s*(\d{1,2})\b/i);
    if (!m) continue;
    const letter = String(m[1]).toUpperCase();
    const num = Number(m[2]);
    if (!Number.isFinite(num) || num <= 0 || num > 99) continue;
    slots.add(`${letter}${num}`);
  }
  return Array.from(slots);
}

function releaseSlotsOwnedBy(map, orderId) {
  const oid = String(orderId || '');
  if (!oid) return map;
  const next = { ...(map || {}) };
  for (const k of Object.keys(next)) {
    if (String(next[k]?.orderId || '') === oid) delete next[k];
  }
  return next;
}

function reserveSlots(map, orderId, meta, slots) {
  const oid = String(orderId || '');
  if (!oid) return map;
  const next = { ...(map || {}) };
  const ts = Date.now();
  for (const s of slots || []) {
    const key = String(s || '').toUpperCase().trim();
    if (!key) continue;
    next[key] = {
      orderId: oid,
      code: meta?.code || '',
      name: meta?.name || '',
      ts,
    };
  }
  return next;
}

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

function codeToNumber(raw) {
  const s = String(raw ?? '').trim();
  const n = Number(s.replace(/\D+/g, '').replace(/^0+/, '') || 0);
  return Number.isFinite(n) ? n : NaN;
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

const round2 = (n) => {
  const num = Number(n || 0);
  return Math.round((num + Number.EPSILON) * 100) / 100;
};


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

// ---------------- COMPONENT ----------------
export default function GatiPage() {
  const sp = useSearchParams();

  const holdTimer = useRef(null);
  const holdFired = useRef(false);

  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  // "KU E LAM" / placement full-screen card
  const [showPlace, setShowPlace] = useState(false);
  const [placeBusy, setPlaceBusy] = useState(false);
  const [placeErr, setPlaceErr] = useState('');
  const [placeOrderId, setPlaceOrderId] = useState(null);
  const [placeOrder, setPlaceOrder] = useState(null);
  const [placeText, setPlaceText] = useState('');
  const [slotMap, setSlotMap] = useState({});

  // Prefill search from URL (?q=123)
  useEffect(() => {
    try {
      const q = sp?.get('q') || '';
      if (q) setSearch(String(q));
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sp]);


  // payment sheet
  const [showPaySheet, setShowPaySheet] = useState(false);
  const [payOrder, setPayOrder] = useState(null); // { id, order, code, name, phone, total, paid, arkaRecordedPaid, paidUpfront, m2 }
  const [payAdd, setPayAdd] = useState(0);
  const [payMethod, setPayMethod] = useState('CASH');
  const [payBusy, setPayBusy] = useState(false);
  const [payErr, setPayErr] = useState('');

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

      if (error || !data) {
        // OFFLINE fallback
        try {
          const local = await getAllOrdersLocal().catch(() => []);
          const list = Array.isArray(local) ? local : [];
          const rows = list
            .filter((o) => String(o?.status || '').toLowerCase() === 'gati')
            .map((o) => {
              const order = o || {};
              const m2 = computeM2(order);
              const total = Number(order.pay?.euro || computeTotalEuro(order));
              const paid = Number(order.pay?.paid || 0);
              const cope = computePieces(order);
              const readyTs =
                Number(order.ready_at || order.readyAt || order.ts || 0) || Date.now();
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
            })
            .filter((r) => !/^T\d+$/i.test(String(r.code || '').trim()))
            .sort((a, b) => (b.readyTs || 0) - (a.readyTs || 0));
          setOrders(rows);
        } catch {
          setOrders([]);
        }
        return;
      }

      const list = (data || []).map((row) => {
        // Supabase JSONB can come back as object OR string (older rows / RPC)
        let raw = row.data;
        if (typeof raw === 'string') {
          try { raw = JSON.parse(raw); } catch { raw = {}; }
        }

        const order = { ...(raw || {}) };

        // Backward-compat: some rows may still use tepihaRows/stazaRows keys
        if (!Array.isArray(order.tepiha) && Array.isArray(order.tepihaRows)) {
          order.tepiha = order.tepihaRows.map((r) => ({
            m2: Number(r?.m2) || 0,
            qty: Number(r?.qty ?? r?.count ?? r?.copa ?? r?.pieces ?? 0) || 0,
            photoUrl: r?.photoUrl || r?.photo_url || ''
          }));
        }
        if (!Array.isArray(order.staza) && Array.isArray(order.stazaRows)) {
          order.staza = order.stazaRows.map((r) => ({
            m2: Number(r?.m2) || 0,
            qty: Number(r?.qty ?? r?.count ?? r?.copa ?? r?.pieces ?? 0) || 0,
            photoUrl: r?.photoUrl || r?.photo_url || ''
          }));
        }
        order.id = String(row.id);
        order.status = row.status;

        // mirror local cache
        try {
          const k = `order_${order.id}`;
          const existing = localStorage.getItem(k);
          if (!existing) localStorage.setItem(k, JSON.stringify(order));
        } catch {}

        // IndexedDB mirror for offline
        try { saveOrderLocal({ ...order, id: String(row.id), status: 'gati', ready_at: row.ready_at || null }); } catch {}

        const m2 = computeM2(order);
        const total = Number(order.pay?.euro || computeTotalEuro(order));
        const paid = Number(order.pay?.paid || 0);
        const cope = computePieces(order);

        const readyTs =
          (row.ready_at ? Date.parse(row.ready_at) : 0) ||
          Number(order.ready_at) ||
          Number(order.readyAt) ||
          Number(order.ts) ||
          (row.created_at ? Date.parse(row.created_at) : Date.now());

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

      // ✅ BASE GATI: mos i shfaq porositë e TRANSPORTIT (kodet T...)
      const baseOnly = (list || []).filter((r) => {
        const c = String(r.code || '').trim();
        return !/^T\d+$/i.test(c);
      });

      setOrders(baseOnly);
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

  // ---------------- KU E LAM (PLACEMENT CARD) ----------------
  async function openPlaceCard(row) {
    try {
      setPlaceErr('');
      setPlaceBusy(true);
      setShowPlace(true);
      setPlaceOrderId(String(row?.id || ''));

      // Load current slot reservations
      try {
        setSlotMap(loadSlotMap());
      } catch {
        setSlotMap({});
      }

      // Fetch latest full order so we can safely update JSONB
      const { order } = await dbFetchOrderById(row?.id);
      const txt = String(order?.ready_note || order?.ready_location || '').trim();
      setPlaceOrder(order);
      setPlaceText(txt);
    } catch (e) {
      console.error(e);
      setPlaceErr('Nuk u hap kartela. Provo prap.');
      setPlaceOrder(null);
      setPlaceText('');
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
  }

  function appendLine(prefix) {
    const p = String(prefix || '').trim();
    if (!p) return;

    // If this is a slot like A1/B1, prevent using it if already reserved by another order.
    const m = p.match(/^([AB])\s*(\d{1,2})$/i);
    if (m) {
      const key = `${String(m[1]).toUpperCase()}${Number(m[2])}`;
      const owner = slotMap?.[key];
      const oid = String(placeOrderId || '');
      if (owner && String(owner.orderId || '') && String(owner.orderId || '') !== oid) {
        alert(`${key} ESHTE I NXANE${owner.code ? ` (KODI ${owner.code})` : ''}.`);
        return;
      }
    }

    setPlaceText((prev) => {
      const v = String(prev || '');
      const base = v.length ? (v.endsWith('\n') ? v : v + '\n') : '';
      return base + `${p} - `;
    });
  }

  function addMany(letter, count) {
    const L = String(letter || '').trim().toUpperCase();
    const c = Number(count || 0);
    if (!L || !Number.isFinite(c) || c <= 0) return;
    setPlaceText((prev) => {
      const v = String(prev || '');
      const base = v.length ? (v.endsWith('\n') ? v : v + '\n') : '';
      const lines = Array.from({ length: c }, (_, i) => `${L}${i + 1} - `).join('\n');
      return base + lines + '\n';
    });
  }

  function applyTemplate20AB() {
    const a = Array.from({ length: 20 }, (_, i) => `A${i + 1} - `).join('\n');
    const b = Array.from({ length: 20 }, (_, i) => `B${i + 1} - `).join('\n');
    setPlaceText(`${a}\n\n${b}\n\nSHENIM: `);
  }

  function getLinesForPreview() {
    return String(placeText || '')
      .split('\n')
      .map((x) => x.trim())
      .filter(Boolean)
      .slice(0, 80);
  }

  async function savePlaceCard() {
    if (!placeOrderId) return;
    const txt = String(placeText || '').trimEnd();
    const actor = readActor();
    const slots = parseSlotsFromText(txt);
    const meta = {
      code: normalizeCode(placeOrder?.code || placeOrder?.client?.code || ''),
      name: (placeOrder?.client?.name || placeOrder?.client_name || '').trim(),
    };

    const patch = {
      ready_note: txt,
      ready_note_at: new Date().toISOString(),
      ready_note_by: actor?.name || actor?.role || 'UNKNOWN',
      ready_slots: slots,
    };

    setPlaceBusy(true);
    setPlaceErr('');
    try {
      // Hard-stop if user typed an occupied slot (e.g. via TEMPLATE)
      try {
        const cur = loadSlotMap();
        const oid = String(placeOrderId || '');
        const conflicts = (slots || []).filter((s) => {
          const owner = cur?.[String(s).toUpperCase()];
          return owner && String(owner.orderId || '') && String(owner.orderId || '') !== oid;
        });
        if (conflicts.length) {
          setPlaceErr(`${conflicts.slice(0, 4).join(', ')} ESHTE/N TE NXANA.`);
          return;
        }
      } catch {}

      const merged = { ...(placeOrder || {}), ...patch };

      // Update slot reservations locally (release old slots for this order, reserve new)
      try {
        const cur = loadSlotMap();
        const released = releaseSlotsOwnedBy(cur, placeOrderId);
        const reserved = reserveSlots(released, placeOrderId, meta, slots);
        saveSlotMap(reserved);
        setSlotMap(reserved);
      } catch {}

      // Always update offline mirror immediately
      try { await saveOrderLocal(merged); } catch {}
      try { localStorage.setItem(`order_${placeOrderId}`, JSON.stringify(merged)); } catch {}

      // Try online update; if offline, queue for sync
      let online = true;
      try {
        online = typeof navigator === 'undefined' ? true : navigator.onLine !== false;
      } catch {
        online = true;
      }

      if (online) {
        await updateOrderInDb(placeOrderId, { data: merged });
      } else {
        await queueOp('patch_order_data', { id: placeOrderId, data_patch: patch });
      }

      // Update list preview
      setOrders((prev) =>
        (prev || []).map((x) =>
          String(x.id) === String(placeOrderId)
            ? { ...x, readyNote: txt, readySlots: slots }
            : x
        )
      );
      closePlaceCard();
    } catch (e) {
      console.error(e);
      // If online update failed, queue anyway so user doesn't lose work
      try { await queueOp('patch_order_data', { id: placeOrderId, data_patch: patch }); } catch {}
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
      if (!order) {
        alert('Nuk u gjet porosia.');
        return;
      }

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

  async function applyPayOnly() {
    if (!payOrder) return;
    const actor = readActor();
    const amountExact = Math.max(0, round2(Number(payDue) || 0));
    const cashGiven = Math.max(0, round2(Number(payAdd) || 0));

    if (amountExact <= 0) {
      setShowPaySheet(false);
      return;
    }
    if (cashGiven < amountExact) {
      alert('KLIENTI DHA MË PAK SE SHUMA. JU LUTEM FUTNI SHUMËN E PLOTË.');
      return;
    }

    setPayErr('');
    setPayBusy(true);
    try {
      // Record ONLY the exact remaining amount in system/ARKË
      await recordOrderCashPayment({
        supabase,
        orderId: payOrder.id,
        amount: amountExact,
        method: 'CASH',
        pin: actor?.pin || '2380',
        meta: { source: 'GATI', mode: 'PAY_ONLY' },
      });

      // Update order totals
      const newPaidTotal = round2((Number(payOrder.paid || 0)) + amountExact);
      await updateOrderInDb({
        supabase,
        id: payOrder.id,
        patch: {
          paid_total: newPaidTotal,
          debt: 0,
          paid_upfront: false,
          updated_by_pin: actor?.pin || '2380',
        },
      });

      // Refresh UI
      await refreshOrders();
      setShowPaySheet(false);
    } catch (e) {
      console.error(e);
      setPayErr(e?.message || 'GABIM');
      alert(e?.message || 'GABIM');
    } finally {
      setPayBusy(false);
    }
  }

  // ✅ FIXED: removes from GATI + writes picked_up_at to DB for MARRJE SOT (ONLY picked_up_at!)
  async async function confirmDelivery() {
    if (!payOrder) return;
    const o = payOrder.order;

    const total = Number(payOrder.total || 0);
    const paidBefore = Number(payOrder.paid || 0);
    const cashGiven = Number((Number(payAdd || 0)).toFixed(2));
    const paidUpfront = !!payOrder.paidUpfront;

    const due = Math.max(0, Number((total - paidBefore).toFixed(2)));
    const applied = paidUpfront ? due : Number(Math.min(cashGiven, due).toFixed(2));

    const alreadyPaidFull = due <= 0;
    if (!paidUpfront && !alreadyPaidFull && applied <= 0) {
      alert('SHUMA NUK VLEN (0 €).');
      return;
    }

    const paidAfter = paidUpfront ? Math.max(paidBefore, total) : Number((paidBefore + applied).toFixed(2));
    const debt = Math.max(0, Number((total - paidAfter).toFixed(2)));
    const change = paidUpfront ? 0 : Math.max(0, Number((cashGiven - applied).toFixed(2)));

    const prevArka = Number(o.pay?.arkaRecordedPaid || 0);
    const willRecordCash = payMethod === 'CASH';

    const targetCashRecorded = willRecordCash ? paidAfter : prevArka;
    const delta = willRecordCash ? Number((targetCashRecorded - prevArka).toFixed(2)) : 0;
    const safeDelta = Math.max(0, delta);
    const finalArka = willRecordCash ? Number((prevArka + safeDelta).toFixed(2)) : prevArka;

    // iOS/Safari confirm dialogs are disruptive ("Suppress dialogs").
    // Keep the flow fast: no confirm popup here.

    const nowIso = new Date().toISOString();
    const nowMs = Date.now();

    // local snapshot (legacy / storage)
    const updated = {
      ...o,
      status: 'dorzim', // UI + storage flow
      deliveredAt: nowMs,
      delivered_at: nowIso,
      pickedUpAt: nowMs,
      picked_up_at: nowIso,
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

    // Release any reserved slots for this order (so A1 becomes available again)
    try {
      const cur = loadSlotMap();
      const next = releaseSlotsOwnedBy(cur, updated.id);
      saveSlotMap(next);
      setSlotMap(next);
    } catch {}

    // ✅ IMMEDIATE UI REMOVE (string/number safe)
    const uid = String(updated.id);
    setOrders((prev) => (prev || []).filter((x) => normalizeCode(x.code) !== normalizeCode(updated.code) && String(x.id) !== uid));

    // save to localStorage + storage json (best-effort)
    try {
      localStorage.setItem(`order_${updated.id}`, JSON.stringify(updated));
      try { saveOrderLocal(updated); } catch {}
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
      console.log('save storage/local fail', e);
    }

    // ✅ DB: set status + timestamps via single endpoint, then persist payment snapshot in data
    try {
      await fetch('/api/orders/set-status', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: payOrder.id, status: 'dorzim' }),
      });
      await supabase
        .from('orders')
        .update({ data: { ...updated, status: 'dorzim' }, picked_up_at: nowIso })
        .eq('id', payOrder.id);
    } catch (e) {
            console.log('DB delivery update EX:', e);
      // OFFLINE/FAILSAFE: queue full snapshot as insert_order (single op_type supported)
      try {
        await queueOp('insert_order', {
          ...updated,
          status: 'dorzim',
          picked_up_at: nowIso,
          delivered_at: nowIso,
          // keep columns top-level too (route will normalize)
          code: updated.code ?? updated.code_n ?? updated.client?.code ?? updated.client_code ?? null,
          code_n: updated.code_n ?? updated.code ?? null,
          client_code: updated.client_code ?? updated.client?.code ?? null,
          client_name: updated.client_name ?? updated.client?.name ?? null,
          client_phone: updated.client_phone ?? updated.client?.phone ?? null,
          total,
          paid: paidAfter,
        });
      } catch {}
    }}

    // Record CASH payment (EXACT delta only). When ARKA is closed, it is stored as WAITING.
    if (willRecordCash && safeDelta > 0) {
      try {
        const actor = readActor();

        // Ensure ARKA pending entries always have CODE + NAME (avoid "# ." rows)
        const codeNum = normalizeCode(
          updated.code ?? updated.code_n ?? updated.client?.code ?? updated.client?.code_n ?? null
        );
        const clientName = (
          updated.client_name ?? updated.client?.name ?? updated.client?.client_name ?? ''
        ).trim();
        const mode = paidUpfront ? 'paid_upfront_delta' : 'delivery_cash_delta';

        await recordOrderCashPayment({
          supabase,
          orderId: updated.id,
          code: codeNum,
          clientName,
          amount: safeDelta,
          method: 'CASH',
          pin: actor?.pin ? String(actor.pin) : null,
          // deterministic id => prevents double-tap duplicates
          externalId: `${mode}:${updated.id}`,
          meta: {
            page: 'GATI',
            mode,
            code: codeNum,
            name: clientName,
          },
        });
      } catch (e) {
        console.log('PAYMENT record error', e);
      }
    }

    // No blocking alerts here; the order will disappear/move automatically.

    closePay();

    try {
      await refreshOrders();
    } catch {}
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

      // Ensure DB id is available for return sync
      // NOTE: row.id is the Supabase UUID. Some legacy/local orders may not store it on `id`.
      // The hidden return flow expects `order.id` to be the DB uuid.
      if (!order.db_id && row?.id) order.db_id = row.id;
      if (!order.id && row?.id) order.id = row.id;
      if (!order.data) order.data = { ...order };

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
    const oid = retOrder?.id || retOrder?.db_id;
    if (!file || !oid) return;
    setPhotoUploading(true);
    try {
      const url = await uploadPhoto(file, oid, 'return');
      if (url) setRetPhotoUrl(url);
    } catch {
      alert('❌ Gabim foto!');
    } finally {
      setPhotoUploading(false);
    }
  }

  async function confirmReturn() {
    const oid = retOrder?.id || retOrder?.db_id || retOrder?.data?.db_id || null;
    if (!oid) return;

    const reason = (retReason || '').trim();
    const note = (retNote || '').trim();

    if (!reason && !note) {
      alert('Shkruaj së paku një arsye ose shënim për kthimin.');
      return;
    }

    if (!confirm('Kjo porosi do të kthehet në PASTRIM si KTHIM.\nJeni i sigurt?')) return;

    const entry = {
      id: `ret_${oid}_${Date.now()}`,
      ts: Date.now(),
      from: 'gati',
      reason: reason || '',
      note: note || '',
      photoUrl: retPhotoUrl || '',
    };

    const updated = {
      ...retOrder,
      // Ensure we have a stable local id for localStorage keys and bucket paths
      id: retOrder?.id || oid,
      status: 'pastrim',
      returnInfo: {
        active: true,
        at: Date.now(),
        from: 'gati',
        reason: entry.reason,
        note: entry.note,
        photoUrl: entry.photoUrl,
        logId: entry.id,
      },
      returnLog: Array.isArray(retOrder.returnLog) ? [entry, ...retOrder.returnLog] : [entry],
    };

    // Ensure we have the Supabase UUID for DB operations.
    // Some local orders don't persist it on `id`, so we store it on `db_id`.
    updated.db_id = retOrder?.db_id || retOrder?.data?.db_id || oid;

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

      try {
        const list = JSON.parse(localStorage.getItem('return_list_v1') || '[]');
        const next = Array.isArray(list) ? [entry, ...list].slice(0, 300) : [entry];
        localStorage.setItem('return_list_v1', JSON.stringify(next));
      } catch {
        localStorage.setItem('return_list_v1', JSON.stringify([entry]));
      }

      // 7) Sync to DB so it shows up in PASTRIMI (DB-driven list)
      try {
        const dbId = updated.db_id || updated.data?.db_id || null;

        // Keep DB JSON as full, consistent payload (so EDIT in PASTRIMI can show return note/photo)
        const nextData = {
          ...(updated.data || updated || {}),
          status: 'pastrim',
          returnInfo: updated.returnInfo || {
            active: true,
            at: Date.now(),
            from: 'gati',
            reason: entry.reason || '',
            note: entry.note || '',
            photoUrl: entry.photoUrl || '',
            logId: entry.id,
          },
          returnLog: Array.isArray(updated.returnLog) ? updated.returnLog : [entry],
          ready_at: null,
          picked_up_at: null,
          delivered_at: null,
        };

        if (dbId) {
          await updateOrderInDb(dbId, {
            status: 'pastrim',
            ready_at: null,
            picked_up_at: null,
            data: nextData,
          });
        } else {
          // Fallback for legacy orders that never had db_id
          const res = await saveOrderToDb({ ...updated, data: nextData });
          if (res?.db_id) {
            updated.db_id = res.db_id;
            if (updated.data) updated.data.db_id = res.db_id;
          }
        }
      } catch (e) {
        console.warn('DB sync (return) failed:', e);
        // Don't block the flow; local storage + bucket already updated.
      }
    } catch (e) {
      console.error('return save fail', e);
      alert('❌ Gabim gjatë ruajtjes së kthimit.');
      return;
    }

    alert('✅ U kthye në PASTRIM (KTHIM).');
    closeReturn();
    setOrders((prev) => prev.filter((x) => String(x.id) !== String(updated.id)));
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
    if (holdFired.current) return;
    openPay(row);
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
                      cursor: 'pointer',
                    }}
                    title="RAGING COLORS"
                    onClick={() => openPlaceCard(o)}
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

                    <div
                      style={{
                        fontSize: 11,
                        color: o.readyNote ? 'rgba(255,255,255,0.8)' : '#f59e0b',
                        fontWeight: 800,
                      }}
                    >
                      📍 {o.readyNote ? String(o.readyNote).split('\n')[0].slice(0, 42) : 'PA VEND'}
                    </div>
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

      {/* ============ FULL SCREEN PAGESA ============ */}
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
	                  // Paid so far (from DB). Keep it local to avoid runtime ReferenceError.
	                  const paidToDate = Number(payOrder?.paid || 0);
	                  const totalEuro = Number(payOrder.total || 0);
                  const dueNow = Number((totalEuro - paidToDate).toFixed(2));
                  const dueSafe = dueNow > 0 ? dueNow : 0;
                  const given = Number((Number(payAdd || 0)).toFixed(2));
                  const applied = Number((Math.min(given, dueSafe)).toFixed(2));
                  const paidAfter = Number((paidToDate + applied).toFixed(2));
                  const debtNow = Number((totalEuro - paidAfter).toFixed(2));
                  const debtSafe = debtNow > 0 ? debtNow : 0;
                  const changeNow = given > dueSafe ? Number((given - dueSafe).toFixed(2)) : 0;

                  return (
                    <>
                      <div className="tot-line">
                        NË SISTEM REGJISTROHET: <strong>{applied.toFixed(2)} €</strong>
                      </div>
                      <div className="tot-line">
                        PAGUAR PAS KËSAJ: <strong style={{ color: '#16a34a' }}>{paidAfter.toFixed(2)} €</strong>
                      </div>
                      {debtSafe > 0 && (
                        <div className="tot-line">
                          BORXH: <strong style={{ color: '#dc2626' }}>{debtSafe.toFixed(2)} €</strong>
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
                  <label className="label">KLIENTI DHA (€)</label>

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
                        onClick={() => setPayAdd(v)}
                      >
                        {v}€
                      </button>
                    ))}
                    <button className="chip" type="button" onClick={() => setPayAdd(0)} style={{ opacity: 0.9 }}>
                      FSHI
                    </button>
                  </div>
                </div>

                <div style={{ fontSize: 12, color: "#666", marginTop: 8 }}>* CASH VETËM — pagesa regjistrohet në ARKË (ose WAITING kur ARKA është e mbyllur).</div>
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

      {/* FULL SCREEN: KU E LAM */}
      {showPlace && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.92)',
            zIndex: 10001,
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <div
            style={{
              padding: 14,
              borderBottom: '1px solid rgba(255,255,255,0.12)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 10,
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 900, letterSpacing: 0.4 }}>KARTELA E VENDOSJES</div>
              <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.7)' }}>
                Shkruaj ku e ke vendos tepihin (rreshta)
              </div>
            </div>
            <button className="btn secondary" onClick={closePlaceCard} style={{ padding: '8px 12px' }}>
              MBYLLE
            </button>
          </div>

          <div style={{ padding: 12, overflow: 'auto', flex: 1 }}>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(4, 1fr)',
                gap: 10,
                marginBottom: 12,
              }}
            >
              {[
                { k: 'A1', kind: 'A' },
                { k: 'A2', kind: 'A' },
                { k: 'B1', kind: 'B' },
                { k: 'B2', kind: 'B' },
                { k: '20 A', kind: 'A', act: 'MANY_A' },
                { k: '20 B', kind: 'B', act: 'MANY_B' },
                { k: 'THARJE', kind: 'X' },
                { k: 'PAKETIM', kind: 'X' },
                { k: 'HYRJE', kind: 'X' },
                { k: 'TEMPLATE', kind: 'X', act: 'TPL' },
              ].map((it) => {
                const isA = it.kind === 'A';
                const isB = it.kind === 'B';
                const slotMatch = String(it.k).match(/^([AB])\d{1,2}$/i);
                const slotKey = slotMatch ? String(it.k).toUpperCase() : '';
                const owner = slotKey ? slotMap?.[slotKey] : null;
                const ownedByOther =
                  !!(owner && String(owner.orderId || '') && String(owner.orderId || '') !== String(placeOrderId || ''));
                const bg = isA
                  ? 'rgba(59,130,246,0.22)'
                  : isB
                  ? 'rgba(168,85,247,0.22)'
                  : 'rgba(255,255,255,0.08)';
                const bd = isA
                  ? 'rgba(59,130,246,0.35)'
                  : isB
                  ? 'rgba(168,85,247,0.35)'
                  : 'rgba(255,255,255,0.12)';
                return (
                  <button
                    key={it.k}
                    className="btn"
                    disabled={ownedByOther || placeBusy}
                    onClick={() => {
                      if (it.act === 'TPL') return applyTemplate20AB();
                      if (it.act === 'MANY_A') return addMany('A', 20);
                      if (it.act === 'MANY_B') return addMany('B', 20);
                      appendLine(it.k);
                    }}
                    style={{
                      padding: '14px 10px',
                      fontWeight: 900,
                      borderRadius: 12,
                      background: bg,
                      border: `1px solid ${bd}`,
                      color: '#fff',
                      opacity: ownedByOther ? 0.35 : 1,
                    }}
                  >
                    {it.k}{ownedByOther ? ' (NXAN)' : ''}
                  </button>
                );
              })}
            </div>

            <textarea
              value={placeText}
              onChange={(e) => setPlaceText(e.target.value)}
              placeholder={`Shembull:\nA1 - 20 COPE (2x3)\nA2 - 15 COPE\nB1 - 10 COPE\nSHENIM: ...`}
              style={{
                width: '100%',
                minHeight: 280,
                resize: 'vertical',
                padding: 12,
                borderRadius: 12,
                border: '1px solid rgba(255,255,255,0.14)',
                background: 'rgba(255,255,255,0.06)',
                color: '#fff',
                fontSize: 14,
                fontFamily:
                  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, Courier New, monospace',
                outline: 'none',
              }}
            />

            {/* PREVIEW: A = blue, B = purple */}
            <div style={{ marginTop: 10 }}>
              <div style={{ fontSize: 12, fontWeight: 900, color: 'rgba(255,255,255,0.7)', marginBottom: 8 }}>
                PREVIEW
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {getLinesForPreview().map((line, idx) => {
                  const s = String(line || '').trim();
                  const isA = /^A\d+\b/i.test(s);
                  const isB = /^B\d+\b/i.test(s);
                  const bg = isA
                    ? 'rgba(59,130,246,0.20)'
                    : isB
                    ? 'rgba(168,85,247,0.20)'
                    : 'rgba(255,255,255,0.08)';
                  const bd = isA
                    ? 'rgba(59,130,246,0.35)'
                    : isB
                    ? 'rgba(168,85,247,0.35)'
                    : 'rgba(255,255,255,0.12)';
                  return (
                    <span
                      key={`${idx}_${s}`}
                      style={{
                        maxWidth: '100%',
                        padding: '6px 10px',
                        borderRadius: 999,
                        background: bg,
                        border: `1px solid ${bd}`,
                        fontSize: 12,
                        fontWeight: 900,
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                      title={s}
                    >
                      {s}
                    </span>
                  );
                })}
              </div>
            </div>

            {placeErr && (
              <div style={{ marginTop: 10, color: '#f59e0b', fontWeight: 800, fontSize: 12 }}>{placeErr}</div>
            )}
          </div>

          <div
            style={{
              padding: 12,
              borderTop: '1px solid rgba(255,255,255,0.12)',
              display: 'flex',
              gap: 10,
            }}
          >
            <button
              className="btn secondary"
              onClick={() => setPlaceText('')}
              style={{ flex: 1, padding: '12px 12px', fontWeight: 900 }}
              disabled={placeBusy}
            >
              PASTRO
            </button>
            <button
              className="btn primary"
              onClick={savePlaceCard}
              style={{ flex: 2, padding: '12px 12px', fontWeight: 900 }}
              disabled={placeBusy}
            >
              {placeBusy ? 'DUKE RUAJTUR...' : 'RUJ'}
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
