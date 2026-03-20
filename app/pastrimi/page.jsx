'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { supabase } from '@/lib/supabaseClient';
import { getAllOrdersLocal, saveOrderLocal } from '@/lib/offlineStore';
import { recordCashMove } from '@/lib/arkaCashSync';
import { requirePaymentPin } from '@/lib/paymentPin';
import { getOutboxSnapshot } from '@/lib/syncManager';
import PosModal from '@/components/PosModal'; // SHTUAR: Për leximin e porosive Offline
import RackLocationModal from '@/components/RackLocationModal';
import { loadSlotMap, saveSlotMap, releaseSlotsOwnedBy, reserveSlots } from '@/lib/rackLocations';

// --- CONFIG ---
const BUCKET = 'tepiha-photos';
const LOCAL_ORDERS_KEY = 'tepiha_local_orders_v1';
const OFFLINE_QUEUE_KEY = 'tepiha_offline_queue_v1';
const TEPIHA_CHIPS = [2.0, 2.5, 3.0, 3.2, 3.5, 3.7, 6.0];
const STAZA_CHIPS = [1.5, 2.0, 2.2, 3.0];
const SHKALLORE_QTY_CHIPS = [5, 10, 15, 20, 25, 30];
const SHKALLORE_PER_CHIPS = [0.25, 0.3, 0.35, 0.4];
const SHKALLORE_M2_PER_STEP_DEFAULT = 0.3;
const PRICE_DEFAULT = 3.0;
const PAY_CHIPS = [5, 10, 20, 30, 50];
const DAILY_CAPACITY_M2 = 400;
const STREAM_MAX_M2 = 450;

// FIX: Timeout 7s për mbrojtjen e Safari
function withTimeout(promise, ms = 7000) {
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error('TIMEOUT')), ms);
  });
  return Promise.race([
    Promise.resolve(promise).finally(() => {
      try { clearTimeout(t); } catch (e) {}
    }),
    timeout,
  ]);
}

// ---------------- HELPERS ----------------

function getGhostBlacklist() {
  if (typeof window === 'undefined') return [];
  try { return JSON.parse(window.localStorage.getItem('tepiha_ghost_blacklist') || '[]'); } catch { return []; }
}

function normalizeCode(raw) {
  if (!raw) return '—';
  const s = String(raw).trim();
  if (/^t\d+/i.test(s)) {
    const n = s.replace(/\D+/g, '').replace(/^0+/, '');
    return `T${n || '0'}`;
  }
  const n = s.replace(/\D+/g, '').replace(/^0+/, '');
  return n || '0';
}

function normalizeOrder(input){
  const raw = input && typeof input === 'object' && 'data' in input ? input.data : input;
  return unwrapOrderData(raw);
}

function normalizeStatus(s){
  const st = String(s || '').toLowerCase().trim();
  if (!st) return '';
  if (st === 'pastrimi') return 'pastrim';
  if (st === 'pranimi') return 'pranim';
  if (st === 'gati') return 'gati';
  if (st === 'marrje_sot' || st === 'marrje') return 'marrje';
  return st;
}

function unwrapOrderData(raw) {
  let o = raw;
  if (!o) return {};
  if (typeof o === 'string') { try { o = JSON.parse(o); } catch { o = {}; } }
  if (o && o.data) {
    let d = o.data;
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch { d = null; } }
    if (d && (d.client || d.tepiha || d.pay || d.transport)) { o = d; }
  }
  return (o && typeof o === 'object') ? o : {};
}

async function readLocalOrdersByStatus(status) {
  const out = [];
  const blacklist = getGhostBlacklist();

  const pushRow = (id, fullOrder, ts, source, synced) => {
    if (!id || !fullOrder) return;
    if (blacklist.includes(String(id))) return;
    const st = String(fullOrder.status || '').toLowerCase();
    if (normalizeStatus(st) !== normalizeStatus(status)) return;
    out.push({ id, source, ts: Number(ts || fullOrder.ts || Date.now()), fullOrder, synced: !!synced });
  };

  try {
    const list = await getAllOrdersLocal();
    (Array.isArray(list) ? list : []).forEach((x) => {
      const raw = x?.data ?? x;
      const full = normalizeOrder(raw);
      full.status = String(x?.status || full.status || '').toLowerCase() || 'pastrim';
      const id = x?.id || full.id || full.oid || '';
      const ts = x?.updated_at || x?.created_at || full.created_at || full.updated_at || Date.now();
      pushRow(id, full, ts, 'idb', !!x?._synced);
    });
  } catch {}

  const byCode = new Map();

  const scoreRow = (row) => {
    const m2 = computeM2(row.fullOrder) || 0;
    const pcs = computePieces(row.fullOrder) || 0;
    return (row.synced ? 1000000 : 0) + (row.source === 'idb' ? 10000 : 0) + (m2 * 100) + (pcs * 10);
  };

  for (const row of out) {
    const order = row.fullOrder;
    const codeKey = normalizeCode(order?.code || order?.code_n || order?.client?.code || order?.client_code || row?.id);
    const prev = byCode.get(codeKey);
    if (!prev) { byCode.set(codeKey, row); continue; }
    const s1 = scoreRow(row);
    const s0 = scoreRow(prev);
    if (s1 > s0) byCode.set(codeKey, row);
    else if (s1 === s0 && Number(row.ts) >= Number(prev.ts)) byCode.set(codeKey, row);
  }

  return Array.from(byCode.values());
}

function sanitizePhone(phone) { return String(phone || '').replace(/\D+/g, ''); }
function formatDayMonth(ts) {
  if (!ts) return '--/--';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '--/--';
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function rowQty(r) { return Number(r?.qty ?? r?.pieces ?? 0) || 0; }
function rowM2(r) { return Number(r?.m2 ?? r?.m ?? r?.area ?? 0) || 0; }
function extractArray(obj, ...keys) {
  if (!obj || typeof obj !== 'object') return [];
  for (const k of keys) {
    if (Array.isArray(obj[k]) && obj[k].length > 0) return obj[k];
    if (obj.data && typeof obj.data === 'object' && Array.isArray(obj.data[k]) && obj.data[k].length > 0) return obj.data[k];
    if (typeof obj.data === 'string') {
      try { const p = JSON.parse(obj.data); if (Array.isArray(p[k]) && p[k].length > 0) return p[k]; } catch(e) {}
    }
  }
  return [];
}
function getTepihaRows(order) { return extractArray(order, 'tepiha', 'tepihaRows'); }
function getStazaRows(order) { return extractArray(order, 'staza', 'stazaRows'); }
function getStairsQty(order) {
  if (!order || typeof order !== 'object') return 0;
  let q = Number(order?.shkallore?.qty) || Number(order?.data?.shkallore?.qty) || Number(order?.stairsQty) || Number(order?.data?.stairsQty) || 0;
  if (q === 0 && typeof order.data === 'string') { try { const p = JSON.parse(order.data); q = Number(p?.shkallore?.qty) || Number(p?.stairsQty) || 0; } catch(e){} }
  return q;
}
function getStairsPer(order) {
  if (!order || typeof order !== 'object') return 0.3;
  let p = Number(order?.shkallore?.per) || Number(order?.data?.shkallore?.per) || Number(order?.stairsPer) || Number(order?.data?.stairsPer) || 0.3;
  if (p === 0.3 && typeof order.data === 'string') { try { const parsed = JSON.parse(order.data); p = Number(parsed?.shkallore?.per) || Number(parsed?.stairsPer) || 0.3; } catch(e){} }
  return p;
}
function computeM2(order) {
  if (!order) return 0;
  let total = 0;
  for (const r of getTepihaRows(order)) total += (Number(r?.m2 ?? r?.m ?? r?.area ?? 0) || 0) * (Number(r?.qty ?? r?.pieces ?? 0) || 0);
  for (const r of getStazaRows(order)) total += (Number(r?.m2 ?? r?.m ?? r?.area ?? 0) || 0) * (Number(r?.qty ?? r?.pieces ?? 0) || 0);
  total += getStairsQty(order) * getStairsPer(order);
  return Number(total.toFixed(2));
}
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


function dayKey(ts) {
  const d = new Date(ts || Date.now());
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
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
export default function PastrimiPage() {
  const sp = useSearchParams();
  const phonePrefix = '+383';
  const longPressTimer = useRef(null);

  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  const [debugInfo, setDebugInfo] = useState({
    source: 'INIT', dbCount: 0, localCount: 0,
    online: typeof navigator !== 'undefined' ? navigator.onLine : null,
    lastError: null, ts: 0,
  });

  useEffect(() => {
    try {
      const q = sp?.get('q') || '';
      if (q) setSearch(String(q));
    } catch {}
  }, [sp]);

  const [editMode, setEditMode] = useState(false);
  const [saving, setSaving] = useState(false);
  const [photoUploading, setPhotoUploading] = useState(false);

  const [oid, setOid] = useState('');
  const [orderSource, setOrderSource] = useState('orders'); 
  const [origTs, setOrigTs] = useState(null);
  const [codeRaw, setCodeRaw] = useState('');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [clientPhotoUrl, setClientPhotoUrl] = useState('');

  const [tepihaRows, setTepihaRows] = useState([{ id: 't1', m2: '', qty: '', photoUrl: '' }]);
  const [stazaRows, setStazaRows] = useState([{ id: 's1', m2: '', qty: '', photoUrl: '' }]);

  const [stairsQty, setStairsQty] = useState(0);
  const [stairsPer, setStairsPer] = useState(SHKALLORE_M2_PER_STEP_DEFAULT);
  const [stairsPhotoUrl, setStairsPhotoUrl] = useState('');

  const [pricePerM2, setPricePerM2] = useState(PRICE_DEFAULT);
  const [clientPaid, setClientPaid] = useState(0);
  const [paidUpfront, setPaidUpfront] = useState(false);
  const [arkaRecordedPaid, setArkaRecordedPaid] = useState(0);
  const [payMethod, setPayMethod] = useState('CASH');
  const [notes, setNotes] = useState('');

  const [returnActive, setReturnActive] = useState(false);
  const [returnAt, setReturnAt] = useState(0);
  const [returnReason, setReturnReason] = useState('');
  const [returnNote, setReturnNote] = useState('');
  const [returnPhoto, setReturnPhoto] = useState('');

  const [showPaySheet, setShowPaySheet] = useState(false);
  const [showStairsSheet, setShowStairsSheet] = useState(false);
  const [readyPlaceSheet, setReadyPlaceSheet] = useState(false);
  const [readyPlaceOrder, setReadyPlaceOrder] = useState(null);
  const [readyPlaceText, setReadyPlaceText] = useState('');
  const [readyPlaceBusy, setReadyPlaceBusy] = useState(false);
  const [readyPlaceErr, setReadyPlaceErr] = useState('');
  const [slotMap, setSlotMap] = useState({});
  const [selectedSlots, setSelectedSlots] = useState([]);
  const [payAdd, setPayAdd] = useState(0);

  const [streamPastrimM2, setStreamPastrimM2] = useState(0);

  useEffect(() => {
    refreshOrders();
    return () => {
      if (longPressTimer.current) clearTimeout(longPressTimer.current);
    };
  }, []);

  // FIX: Realtime me mbrojtje nga crash
  useEffect(() => {
    if (!supabase || typeof supabase.channel !== 'function') return;

    let ch1, ch2;
    try {
      ch1 = supabase.channel('pastrim-live-orders')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, async (payload) => {
            const row = payload?.new || payload?.old;
            if (row?.id) {
              await saveOrderLocal({ id: row.id, status: normalizeStatus(row.status), data: row.data ?? null, updated_at: row.updated_at || new Date().toISOString(), _synced: true, _table: 'orders' });
            }
            refreshOrders();
        }).subscribe();

      ch2 = supabase.channel('pastrim-live-transport')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'transport_orders' }, async (payload) => {
            const row = payload?.new || payload?.old;
            if (row?.id) {
              await saveOrderLocal({ id: row.id, status: normalizeStatus(row.status), data: row.data ?? null, updated_at: row.updated_at || new Date().toISOString(), _synced: true, _table: 'transport_orders' });
            }
            refreshOrders();
        }).subscribe();
    } catch(e) {}

    const onFocus = () => refreshOrders();
    if (typeof window !== 'undefined') window.addEventListener('focus', onFocus);

    return () => {
      try { if (ch1) supabase.removeChannel(ch1); } catch {}
      try { if (ch2) supabase.removeChannel(ch2); } catch {}
      if (typeof window !== 'undefined') window.removeEventListener('focus', onFocus);
    };
  }, []);

  async function refreshOrders() {
    setLoading(true);
    try {
      // 1. Lexojmë Outbox-in për porositë që janë ruajtur offline por s'kanë shkuar në DB
      const outboxSnap = typeof getOutboxSnapshot === 'function' ? getOutboxSnapshot() : [];
      const pendingOutbox = Array.isArray(outboxSnap)
        ? outboxSnap.filter((it) => it?.status === 'pending' && (it?.table === 'orders' || it?.table === 'transport_orders')).map((it) => {
            const p = it.payload || {};
            const isTrans = it.table === 'transport_orders';
            const codeKey = p.code ?? p.code_n ?? p.order_code ?? null;
            const m2 = computeM2(p);
            const cope = computePieces(p);
            return {
              id: it.id, source: 'OUTBOX', ts: Number(it.createdAt ? Date.parse(it.createdAt) : Date.now()),
              name: p.client?.name || p.client_name || '', phone: p.client?.phone || '', code: normalizeCode(codeKey),
              m2, cope, total: Number(p.pay?.euro || 0), paid: Number(p.pay?.paid || 0),
              isPaid: Number(p.pay?.paid||0) >= Number(p.pay?.euro||0) && Number(p.pay?.euro||0) > 0,
              isReturn: false, fullOrder: p, _outboxPending: true
            };
        }) : [];

      const mergeUnique = (baseArr, extraArr) => {
        const seen = new Set((baseArr || []).map((o) => String(o?.id || o?.oid)));
        (extraArr || []).forEach((o) => {
          const k = String(o?.id || o?.oid);
          if (seen.has(k)) return;
          baseArr.push(o);
          seen.add(k);
        });
        return baseArr;
      };

      // OFFLINE MODE
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        const locals = (await readLocalOrdersByStatus('pastrim')).map((x) => {
          const order = unwrapOrderData(x.fullOrder);
          const total = Number(order.pay?.euro || 0);
          const paid = Number(order.pay?.paid || 0);
          return {
            id: x.id, source: 'LOCAL', ts: Number(order.ts || x.ts || Date.now()),
            name: order.client?.name || '', phone: order.client?.phone || '', code: normalizeCode(order.client?.code || order.code || x.id),
            m2: computeM2(order), cope: computePieces(order),
            total, paid, isPaid: paid >= total && total > 0, isReturn: !!order?.returnInfo?.active, fullOrder: order, localOnly: true,
          };
        });

        const cleanLocals = locals.filter(o => o.cope > 0 || o.m2 > 0 || (o.name && o.name.trim() !== ''));
        mergeUnique(cleanLocals, pendingOutbox); // Shton Outbox-in

        // FINAL DEDUPE: vetëm me id/oid (jo me code)
        const byId = new Map();
        (cleanLocals || []).forEach((o) => {
          const k = String(o?.id || o?.oid);
          if (!k) return;
          const prev = byId.get(k);
          if (!prev) { byId.set(k, o); return; }
          if (Number(o.ts || 0) >= Number(prev.ts || 0)) byId.set(k, o);
        });
        const dedupedLocals = Array.from(byId.values());

        dedupedLocals.sort((a, b) => b.ts - a.ts);

        setOrders(dedupedLocals);
        setDebugInfo({ source: 'LOCAL_OFFLINE', dbCount: 0, localCount: dedupedLocals.length, online: false, lastError: null, ts: Date.now() });
        setLoading(false);
        return;
      }

      // ONLINE MODE
      const { data: normalData } = await withTimeout(
        supabase.from('orders').select('id,status,created_at,data,code').in('status', ['pastrim','pastrimi']).order('created_at', { ascending: false }).limit(300)
      );
      const { data: transportData } = await withTimeout(
        supabase.from('transport_orders').select('id,status,created_at,data,code_str').in('status', ['pastrim','pastrimi']).order('created_at', { ascending: false }).limit(300)
      );

      const allOrders = [];
      (normalData || []).forEach(row => {
        const order = unwrapOrderData(row.data);
        const total = Number(order.pay?.euro || 0);
        const paid = Number(order.pay?.paid || 0);
        const cope = computePieces(order);
        allOrders.push({
          id: row.id, source: 'orders', ts: Number(order.ts || Date.parse(row.created_at) || 0) || 0,
          name: order.client?.name || order.client_name || '', phone: order.client?.phone || order.client_phone || '',
          code: normalizeCode(order.client?.code || order.code || row.code), m2: computeM2(order),
          cope, total, paid, isPaid: paid >= total && total > 0, isReturn: !!order?.returnInfo?.active, fullOrder: order
        });
      });

      (transportData || []).forEach(row => {
        const order = unwrapOrderData(row.data);
        const total = Number(order.pay?.euro || 0);
        const paid = Number(order.pay?.paid || 0);
        const cope = computePieces(order);
        allOrders.push({
          id: row.id, source: 'transport_orders', ts: Number(order.created_at ? Date.parse(order.created_at) : (Date.parse(row.created_at) || 0)),
          name: order.client?.name || '', phone: order.client?.phone || '',
          code: normalizeCode(row.code_str || order.client?.code), m2: computeM2(order),
          cope, total, paid, isPaid: paid >= total && total > 0, isReturn: false, fullOrder: order
        });
      });

      mergeUnique(allOrders, pendingOutbox); // Shton Outbox-in

      // FINAL DEDUPE: vetëm me id/oid (jo me code)
      const byId = new Map();
      (allOrders || []).forEach((o) => {
        const k = String(o?.id || o?.oid);
        if (!k) return;
        const prev = byId.get(k);
        if (!prev) { byId.set(k, o); return; }
        if (Number(o.ts || 0) >= Number(prev.ts || 0)) byId.set(k, o);
      });
      const dedupedOrders = Array.from(byId.values());

      dedupedOrders.sort((a, b) => b.ts - a.ts);

      const cleanOrders = dedupedOrders.filter(o => o.cope > 0 || o.m2 > 0 || (o.name && o.name.trim() !== ''));
      setOrders(cleanOrders);

      const streamTotal = cleanOrders.reduce((sum, o) => sum + (Number(o.m2) || 0), 0);
      setStreamPastrimM2(Number(streamTotal.toFixed(2)));

    } catch (e) {
      console.error('refreshOrders failed:', e);
      triggerFatalCacheHeal();
      setOrders([]);
      setStreamPastrimM2(0);
      setDebugInfo({ source: 'ERROR', dbCount: 0, localCount: 0, online: navigator?.onLine !== false, lastError: String(e?.message || e), ts: Date.now() });
    } finally {
      setLoading(false);
    }
  }

  async function openEdit(item) {
    if (item._outboxPending) {
       alert("⏳ Kjo porosi është në pritje për internet. Nuk mund ta editosh derisa të dërgohet në server.");
       return;
    }
    try {
      let ord = item.fullOrder;
      setOid(String(item.id));
      setOrderSource(item.source);
      setOrigTs(ord.ts || Date.now());
      setCodeRaw(normalizeCode(item.code));
      setName(ord.client?.name || '');
      const p = String(ord.client?.phone || '');
      setPhone(p.startsWith(phonePrefix) ? p.slice(phonePrefix.length) : p.replace(/\D+/g, ''));
      setClientPhotoUrl(ord.client?.photoUrl || ord.client?.photo || '');

      const tList = getTepihaRows(ord);
      const sList = getStazaRows(ord);

      setTepihaRows(tList.length ? tList.map((x,i)=>({id:`t${i+1}`, m2:String(x?.m2 ?? x?.m ?? x?.area ?? ''), qty:String(x?.qty ?? x?.pieces ?? ''), photoUrl:x?.photoUrl||''})) : [{id:'t1', m2:'', qty:'', photoUrl:''}]);
      setStazaRows(sList.length ? sList.map((x,i)=>({id:`s${i+1}`, m2:String(x?.m2 ?? x?.m ?? x?.area ?? ''), qty:String(x?.qty ?? x?.pieces ?? ''), photoUrl:x?.photoUrl||''})) : [{id:'s1', m2:'', qty:'', photoUrl:''}]);

      setStairsQty(getStairsQty(ord));
      setStairsPer(getStairsPer(ord));
      setStairsPhotoUrl(ord?.shkallore?.photoUrl || ord?.data?.shkallore?.photoUrl || '');

      setPricePerM2(Number(ord.pay?.rate ?? ord.pay?.price ?? PRICE_DEFAULT));
      const paid = Number(ord.pay?.paid ?? 0);
      const method = ord.pay?.method || 'CASH';
      setClientPaid(paid);
      setPaidUpfront(!!ord.pay?.paidUpfront);
      setPayMethod(method);
      setArkaRecordedPaid(Number(ord.pay?.arkaRecordedPaid ?? (method==='CASH'?paid:0)));

      setNotes(ord.notes || '');

      const ri = ord?.returnInfo;
      setReturnActive(!!ri?.active);
      setReturnAt(Number(ri?.at || 0));
      setReturnReason(String(ri?.reason || ''));
      setReturnNote(String(ri?.note || ''));
      setReturnPhoto(String(ri?.photoUrl || ''));

      setPayAdd(0);
      setShowPaySheet(false);
      setShowStairsSheet(false);
      setEditMode(true);

    } catch (e) {
      alert('❌ Gabim gjatë hapjes!');
    }
  }

  function startLongPress(item) {
    if (longPressTimer.current) clearTimeout(longPressTimer.current);
    longPressTimer.current = setTimeout(() => openEdit(item), 600);
  }
  function cancelLongPress() {
    if (longPressTimer.current) { clearTimeout(longPressTimer.current); longPressTimer.current = null; }
  }

  async function handleSave() {
    setSaving(true);
    try {
      const currentPaidAmount = Number((Number(clientPaid) || 0).toFixed(2));
      let finalArka = Number(arkaRecordedPaid) || 0;

      const order = {
        id: oid, ts: origTs, status: 'pastrim',
        client: { name: name.trim(), phone: phonePrefix + (phone || ''), code: normalizeCode(codeRaw), photoUrl: clientPhotoUrl || '' },
        tepiha: tepihaRows.map(r => ({ m2: Number(r.m2) || 0, qty: Number(r.qty) || 0, photoUrl: r.photoUrl || '' })),
        staza: stazaRows.map(r => ({ m2: Number(r.m2) || 0, qty: Number(r.qty) || 0, photoUrl: r.photoUrl || '' })),
        shkallore: { qty: Number(stairsQty) || 0, per: Number(stairsPer) || 0, photoUrl: stairsPhotoUrl || '' },
        pay: { m2: totalM2, rate: Number(pricePerM2) || PRICE_DEFAULT, euro: totalEuro, paid: currentPaidAmount, debt: currentDebt, paidUpfront: paidUpfront, method: payMethod, arkaRecordedPaid: finalArka },
        notes: notes || '',
        returnInfo: returnActive ? { active: true, at: returnAt, reason: returnReason, note: returnNote, photoUrl: returnPhoto } : undefined
      };

      const { error: dbErr } = await supabase.from(orderSource).update({ status: 'pastrim', data: order, updated_at: new Date().toISOString() }).eq('id', oid);
      if (dbErr) throw dbErr;

      setEditMode(false);
      await refreshOrders();
    } catch (e) {
      alert('❌ Gabim ruajtja: ' + e.message);
    } finally {
      setSaving(false);
    }
  }

  function openReadyPlaceSheet(o) {
    if (o?._outboxPending) {
      alert("⏳ Kjo porosi është në pritje për internet. Prit sa të sinkronizohet lart.");
      return;
    }
    if (o?.source === 'transport_orders') {
      handleMarkReady(o);
      return;
    }
    setReadyPlaceErr('');
    setReadyPlaceOrder(o);
    setReadyPlaceText(String(o?.fullOrder?.ready_note_text || o?.fullOrder?.ready_note || o?.fullOrder?.ready_location || ''));
    setSelectedSlots(Array.isArray(o?.fullOrder?.ready_slots) ? o.fullOrder.ready_slots : []);
    try { setSlotMap(loadSlotMap()); } catch { setSlotMap({}); }
    setReadyPlaceSheet(true);
  }

  function toggleReadySlot(s) {
    setSelectedSlots((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));
  }

  function closeReadyPlaceSheet() {
    if (readyPlaceBusy) return;
    setReadyPlaceSheet(false);
    setReadyPlaceOrder(null);
    setReadyPlaceText('');
    setReadyPlaceErr('');
    setSelectedSlots([]);
  }

  async function confirmReadyPlaceAndSend() {
    if (!readyPlaceOrder || readyPlaceBusy) return;
    setReadyPlaceBusy(true);
    setReadyPlaceErr('');
    try {
      const txt = String(readyPlaceText || '').trim();
      const meta = {
        code: normalizeCode(readyPlaceOrder?.code || readyPlaceOrder?.fullOrder?.code || ''),
        name: (readyPlaceOrder?.name || readyPlaceOrder?.fullOrder?.client?.name || readyPlaceOrder?.fullOrder?.client_name || '').trim(),
      };
      const finalNoteString = selectedSlots.length > 0 ? `📍 [${selectedSlots.join(', ')}] ${txt}`.trim() : txt;
      try {
        const cur = loadSlotMap();
        const released = releaseSlotsOwnedBy(cur, readyPlaceOrder.id);
        const reserved = reserveSlots(released, readyPlaceOrder.id, meta, selectedSlots);
        saveSlotMap(reserved);
        setSlotMap(reserved);
      } catch {}
      setReadyPlaceSheet(false);
      await handleMarkReady(readyPlaceOrder, { readyNote: finalNoteString, readyNoteText: txt, readySlots: selectedSlots });
      setReadyPlaceOrder(null);
      setReadyPlaceText('');
      setSelectedSlots([]);
    } catch (e) {
      setReadyPlaceErr("S'u ruajt pozicioni. Provo prap.");
    } finally {
      setReadyPlaceBusy(false);
    }
  }

  async function handleMarkReady(o, opts = {}) {
    if (o._outboxPending) {
       alert("⏳ Kjo porosi është në pritje për internet. Prit sa të sinkronizohet lart.");
       return;
    }
    const btnId = `btn-${o.id}`;
    const btn = document.getElementById(btnId);
    if(btn) { btn.disabled = true; btn.innerText = "⏳..."; }

    try {
      const now = new Date().toISOString();
      setOrders(prev => prev.filter(x => x.id !== o.id));

      if (o.source === 'LOCAL') {
        const { updateOrderStatus } = await import('@/lib/ordersDb');
        await updateOrderStatus(o.id, 'gati');
      } else {
        const table = o.source;
        const { data: currentRow, error: fetchErr } = await withTimeout(
          supabase.from(table).select('data').eq('id', o.id).single()
        );
        if (fetchErr) throw fetchErr;

        const updatedJson = {
          ...(currentRow.data || {}),
          status: 'gati',
          ready_at: now,
          ...(opts?.readyNote ? { ready_note: String(opts.readyNote).trim(), ready_location: String(opts.readyNote).trim() } : {}),
          ...(typeof opts?.readyNoteText === 'string' ? { ready_note_text: opts.readyNoteText } : {}),
          ...(Array.isArray(opts?.readySlots) ? { ready_slots: opts.readySlots } : {}),
        };
        if (table === 'transport_orders') {
          await supabase.from('transport_orders').update({ status: 'gati', data: updatedJson, updated_at: now, ready_at: now }).eq('id', o.id);
          alert(`✅ U bë GATI!\nShoferi u njoftua në listën e tij.`);
        } else {
          await supabase.from('orders').update({ status: 'gati', ready_at: now, data: updatedJson }).eq('id', o.id);
        }
      }

      if (o.source !== 'transport_orders') {
        const totalAmount = Number(o.total || 0);
        const paidAmount = Number(o.paid || 0);
        const debt = Math.max(0, Number((totalAmount - paidAmount).toFixed(2)));
        let pagesaTxt = (o.paidUpfront || (totalAmount > 0 && debt <= 0) || o.isPaid) ? 'E PAGUAR ✅' : `${debt.toFixed(2)} €`;
        const msg = `Përshëndetje ${o.name || 'klient'},\n\nPorosia juaj (KODI: ${normalizeCode(o.code)}) është GATI për marrje.\n\n📦 Sasia: ${o.cope || 0} copë\n💶 Për të paguar: ${pagesaTxt}\n\n⚠️ JU LUTEMI: Tërhiqni tepihat tuaj brenda 24-48 orëve.\n\nFaleminderit,\nKOMPANIA JONI`;
        const url = `sms:${sanitizePhone(o.phone)}?&body=${encodeURIComponent(msg)}`;
        const link = document.createElement('a');
        link.href = url;
        link.click();
      }
    } catch (e) {
      alert("❌ Diçka shkoi keq. Provo prapë.");
      refreshOrders(); 
    }
  }

  const totalM2 = useMemo(() => {
    const t = tepihaRows.reduce((sum, r) => sum + (Number(r.m2) || 0) * (Number(r.qty) || 0), 0);
    const s = stazaRows.reduce((sum, r) => sum + (Number(r.m2) || 0) * (Number(r.qty) || 0), 0);
    const sh = (Number(stairsQty) || 0) * (Number(stairsPer) || 0);
    return Number((t + s + sh).toFixed(2));
  }, [tepihaRows, stazaRows, stairsQty, stairsPer]);

  const totalEuro = useMemo(() => Number((totalM2 * (Number(pricePerM2) || 0)).toFixed(2)), [totalM2, pricePerM2]);
  const diff = useMemo(() => Number((totalEuro - clientPaid).toFixed(2)), [totalEuro, clientPaid]);
  const currentDebt = diff > 0 ? diff : 0;

  function addRow(kind) {
    const setter = kind === 'tepiha' ? setTepihaRows : setStazaRows;
    const prefix = kind === 'tepiha' ? 't' : 's';
    setter(rows => [...rows, { id: `${prefix}${rows.length + 1}`, m2: '', qty: '', photoUrl: '' }]);
  }
  function removeRow(kind) {
    const setter = kind === 'tepiha' ? setTepihaRows : setStazaRows;
    setter(rows => (rows.length > 1 ? rows.slice(0, -1) : rows));
  }
  function handleRowChange(kind, id, field, value) {
    const setter = kind === 'tepiha' ? setTepihaRows : setStazaRows;
    setter(rows => rows.map(r => (r.id === id ? { ...r, [field]: value } : r)));
  }

  async function handleRowPhotoChange(kind, id, file) {
    if (!file || !oid) return;
    setPhotoUploading(true);
    try {
      const url = await uploadPhoto(file, oid, `${kind}_${id}`);
      if (url) handleRowChange(kind, id, 'photoUrl', url);
    } catch (e) {
      alert('❌ Gabim foto!');
    } finally {
      setPhotoUploading(false);
    }
  }

  function openPay() {
    const dueNow = Number((totalEuro - Number(clientPaid || 0)).toFixed(2));
    setPayAdd(dueNow > 0 ? dueNow : 0);
    setPayMethod("CASH");
    setShowPaySheet(true);
  }

  async function applyPayAndClose() {
    const cashGiven = Number((Number(payAdd) || 0).toFixed(2));
    const due = Math.max(0, Number((Number(totalEuro || 0) - Number(clientPaid || 0)).toFixed(2)));
    if (due <= 0) {
      alert('KJO POROSI ËSHTË E PAGUAR PLOTËSISHT.');
      return;
    }
    if (cashGiven < due) {
      alert('KLIENTI DHA MË PAK SE BORXHI! JU LUTEM PLOTËSONI SHUMËN OSE ANULONI.');
      return;
    }

    const applied = due;
    const kusuri = Math.max(0, cashGiven - due);
    const pinLabel = `PAGESË: ${applied.toFixed(2)}€\nKLIENTI DHA: ${cashGiven.toFixed(2)}€\nKUSURI (RESTO): ${kusuri.toFixed(2)}€\n\n👉 SHKRUAJ PIN-IN TËND PËR TË KRYER PAGESËN:`;

    const pinData = await requirePaymentPin({ label: pinLabel });
    if (!pinData) return;

    // OPTIMISTIC UI: përditëso menjëherë UI dhe mbyll modalin
    const newPaid = Number((Number(clientPaid || 0) + applied).toFixed(2));
    setClientPaid(newPaid);

    if (payMethod === 'CASH') {
      setArkaRecordedPaid(Number((Number(arkaRecordedPaid || 0) + applied).toFixed(2)));
    }

    setShowPaySheet(false);

    // Background network work (mos blloko UI)
    void (async () => {
      try {
        if (payMethod === 'CASH') {
          const extId = `pay_${oid}_${Date.now()}`;
          await recordCashMove({
            externalId: extId,
            orderId: oid,
            code: normalizeCode(codeRaw),
            name: name.trim(),
            amount: applied,
            note: `PAGESA ${applied}€ • #${normalizeCode(codeRaw)} • ${name.trim()}`,
            source: 'ORDER_PAY',
            method: 'cash_pay',
            type: 'IN',
          });
        }
      } catch (e) {}
    })();
  }

  // ==== UI EDIT MODE ====
  if (editMode) {
    return (
      <div className="wrap">
        <header className="header-row" style={{ alignItems: 'flex-start' }}>
          <div><h1 className="title">PASTRIMI</h1><div className="subtitle">EDITIMI ({normalizeCode(codeRaw)})</div></div>
          <div className="code-badge"><span className="badge">{normalizeCode(codeRaw)}</span></div>
        </header>

        <section className="card">
          <h2 className="card-title">Klienti</h2>
          <div className="field-group">
            <label className="label">EMRI</label>
            <div className="row" style={{ alignItems: 'center', gap: 10 }}>
              <input className="input" value={name} onChange={e => setName(e.target.value)} style={{ flex: 1 }} />
            </div>
          </div>
          <div className="field-group"><label className="label">TELEFONI</label><div className="row"><input className="input small" value={phonePrefix} readOnly /><input className="input" value={phone} onChange={e => setPhone(e.target.value)} /></div></div>
        </section>

        {['tepiha', 'staza'].map(kind => (
          <section className="card" key={kind}>
            <h2 className="card-title">{kind.toUpperCase()}</h2>
            <div className="chip-row">
              {(kind === 'tepiha' ? TEPIHA_CHIPS : STAZA_CHIPS).map(val => (
                <button key={val} className="chip" onClick={() => {
                    const rows = kind === 'tepiha' ? tepihaRows : stazaRows;
                    const setter = kind === 'tepiha' ? setTepihaRows : setStazaRows;
                    const emptyIdx = rows.findIndex(r => !r.m2);
                    if (emptyIdx !== -1) { const nr = [...rows]; nr[emptyIdx].m2 = String(val); setter(nr); } 
                    else { setter([...rows, { id: `${kind[0]}${rows.length + 1}`, m2: String(val), qty: '1', photoUrl: '' }]); }
                  }}>{val}</button>
              ))}
            </div>
            {(kind === 'tepiha' ? tepihaRows : stazaRows).map(row => (
              <div className="piece-row" key={row.id}>
                <div className="row">
                  <input className="input small" type="number" value={row.m2} onChange={e => handleRowChange(kind, row.id, 'm2', e.target.value)} placeholder="m²" />
                  <input className="input small" type="number" value={row.qty} onChange={e => handleRowChange(kind, row.id, 'qty', e.target.value)} placeholder="copë" />
                  <label className="camera-btn">📷<input type="file" accept="image/*" style={{ display: 'none' }} onChange={e => handleRowPhotoChange(kind, row.id, e.target.files?.[0])} /></label>
                </div>
                {row.photoUrl && (<div style={{ marginTop: 8 }}><img src={row.photoUrl} className="photo-thumb" alt="" /><button className="btn secondary" style={{ display: 'block', fontSize: 10, padding: '4px 8px', marginTop: 4 }} onClick={() => handleRowChange(kind, row.id, 'photoUrl', '')}>🗑️ FSHI FOTO</button></div>)}
              </div>
            ))}
            <div className="row btn-row"><button className="btn secondary" onClick={() => addRow(kind)}>+ RRESHT</button><button className="btn secondary" onClick={() => removeRow(kind)}>− RRESHT</button></div>
          </section>
        ))}

        <section className="card">
          <div className="row util-row" style={{ gap: '10px' }}><button className="btn secondary" style={{ flex: 1 }} onClick={openPay}>€ PAGESA</button></div>
          <div className="tot-line">M² Total: <strong>{totalM2}</strong></div>
          <div className="tot-line">Total: <strong>{totalEuro.toFixed(2)} €</strong></div>
          <div className="tot-line" style={{ borderTop: '1px solid #eee', marginTop: 10, paddingTop: 10 }}>Paguar: <strong style={{ color: '#16a34a' }}>{Number(clientPaid || 0).toFixed(2)} €</strong></div>
          {currentDebt > 0 && (<div className="tot-line">Borxh: <strong style={{ color: '#dc2626' }}>{currentDebt.toFixed(2)} €</strong></div>)}
        </section>

        <footer className="footer-bar"><button className="btn secondary" onClick={() => setEditMode(false)}>← ANULO</button><button className="btn primary" onClick={handleSave} disabled={saving}>{saving ? 'RUHET...' : 'RUAJ'}</button></footer>

        {/* MODALI I ARKËS POS */}
        <PosModal
          open={showPaySheet}
          onClose={() => setShowPaySheet(false)}
          title="PAGESA (ARKË)"
          subtitle={`KODI: ${normalizeCode(codeRaw)} • ${name}`}
          total={totalEuro}
          alreadyPaid={Number(clientPaid || 0)}
          amount={payAdd}
          setAmount={setPayAdd}
          payChips={PAY_CHIPS}
          confirmText="KRYEJ PAGESËN"
          cancelText="ANULO"
          disabled={saving}
          onConfirm={applyPayAndClose}
        />

        <style jsx>{`
          .client-mini{ width: 34px; height: 34px; border-radius: 999px; object-fit: cover; border: 1px solid rgba(255,255,255,0.18); }
          .photo-thumb { width: 60px; height: 60px; object-fit: cover; border-radius: 8px; }
          .camera-btn { background: rgba(255,255,255,0.1); width: 44px; height: 44px; display: flex; align-items: center; justify-content: center; border-radius: 12px; }
        `}</style>
      </div>
    );
  }

  // ==== UI LIST (MAIN) ====
  const streamPct = Math.min(100, (Number(streamPastrimM2 || 0) / STREAM_MAX_M2) * 100);

  return (
    <div className="wrap">
      <header className="header-row" style={{ alignItems: 'center', flexWrap: 'wrap', gap: '10px' }}>
        <div><h1 className="title" style={{ margin: 0 }}>PASTRIMI</h1></div>
        <div style={{ display: 'flex', alignItems: 'center', marginLeft: 'auto' }}>
          <button
            onClick={() => {
              if (window.confirm("A jeni të sigurt që doni të fshini Cache?")) {
                localStorage.removeItem('tepiha_offline_queue_v1');
                localStorage.removeItem('tepiha_local_orders_v1');
                window.location.reload();
              }
            }}
            style={{ background: 'rgba(239, 68, 68, 0.2)', border: '1px solid rgba(239, 68, 68, 0.5)', color: '#fca5a5', padding: '6px 10px', borderRadius: '8px', fontWeight: '900', fontSize: '11px' }}>🧹 FSHI CACHE</button>
        </div>
      </header>

      <section className="cap-card">
        <div className="cap-title">TOTAL M² NË PROCES</div>
        <div className="cap-value">{Number(streamPastrimM2 || 0).toFixed(1)}</div>
        <div className="cap-bar"><div className="cap-fill" style={{ width: `${streamPct}%` }} /></div>
        <div className="cap-row"><span>0 m²</span><span>MAX: {STREAM_MAX_M2} m²</span></div>
      </section>

      <input className="input" placeholder="🔎 Kërko emrin ose kodin..." value={search} onChange={e => setSearch(e.target.value)} />

      <section className="card" style={{ padding: '10px' }}>
        {loading ? <p style={{ textAlign: 'center' }}>Duke u ngarkuar...</p> : 
          orders
            .filter(o => {
              const s = String(search || '').toLowerCase();
              const name = String(o.name || '').toLowerCase();
              const code = normalizeCode(o.code || '');
              const scode = normalizeCode(search || '');
              return name.includes(s) || code.includes(scode);
            })
            .map(o => {
              // SHTUAR: Përmirësimi i Kodit
              const codeLabel = o?.code != null ? String(o.code).trim() : '—';

              return (
              <div key={o.id + o.source} className="list-item-compact" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 4px', borderBottom: '1px solid rgba(255,255,255,0.08)', opacity: o.isReturn ? 0.92 : 1 }}>
                <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flex: 1 }}>
                  <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:4, flexShrink:0 }}>
                    <div
                      onMouseDown={() => startLongPress(o)}
                      onTouchStart={() => startLongPress(o)}
                      onMouseUp={cancelLongPress}
                      onTouchEnd={cancelLongPress}
                      style={{ background: badgeColorByAge(o.ts), color: '#fff', width: 40, height: 40, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 8, fontWeight: 800, fontSize: 14, flexShrink: 0 }}>
                      {codeLabel}
                    </div>
                    <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.75)', fontWeight: 800 }}>{formatDayMonth(o.ts)}</div>
                  </div>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 14 }}>
                      {o.name} 
                      {/* SHTUAR: Etiketa NË PRITJE për Offline */}
                      {o._outboxPending && <span style={{ color: '#f59e0b', fontWeight: 800, marginLeft: 6 }}>⏳ PRITJE</span>}
                      {o.isReturn && <span style={{color:'#f59e0b'}}>• KTHIM</span>}
                    </div>
                    <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.65)' }}>{o.cope} copë • {o.m2} m²</div>
                    {o.total > o.paid && <div style={{ fontSize: 11, color: '#dc2626', fontWeight: 'bold' }}>Borxh: {(Number(o.total)-Number(o.paid)).toFixed(2)}€</div>}
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  {o.isPaid && <span>✅</span>}
                  <button id={`btn-${o.id}`} className="btn primary" style={{ padding: '6px 10px', fontSize: 12, backgroundColor: o.source === 'transport_orders' ? '#2563eb' : '#16a34a' }} onClick={() => openReadyPlaceSheet(o)}>
                    {o.source === 'transport_orders' ? 'GATI (SHOPFER)' : 'SMS KLIENTIT'}
                  </button>
                </div>
              </div>
            )})}
      </section>


      <RackLocationModal
        open={readyPlaceSheet}
        busy={readyPlaceBusy}
        title="POZICIONI"
        subtitle="Zgjidh një ose më shumë vende. Pastaj porosia kalon në GATI dhe hapet SMS-ja."
        orderId={readyPlaceOrder?.id}
        orderCode={normalizeCode(readyPlaceOrder?.code || readyPlaceOrder?.fullOrder?.code || '')}
        slotMap={slotMap}
        selectedSlots={selectedSlots}
        onToggleSlot={toggleReadySlot}
        placeText={readyPlaceText}
        onPlaceTextChange={setReadyPlaceText}
        placeErr={readyPlaceErr}
        onClose={closeReadyPlaceSheet}
        onClear={() => {
          setSelectedSlots([]);
          setReadyPlaceText('');
        }}
        onSave={confirmReadyPlaceAndSend}
        saveLabel="RUAJ POZICIONIN & HAP SMS"
      />

      <footer className="dock"><Link href="/" className="btn secondary" style={{ width: '100%' }}>🏠 HOME</Link></footer>


      <style jsx>{`
        .list-item-compact:last-child { border-bottom: none; }
        .cap-card { margin-top: 8px; padding: 8px; border-radius: 14px; background: #0b0b0b; border: 1px solid rgba(255, 255, 255, 0.1); }
        .cap-title { text-align: center; font-size: 10px; color: rgba(255, 255, 255, 0.65); font-weight: 800; }
        .cap-value { text-align: center; font-size: 26px; font-weight: 900; margin-top: 4px; color: #16a34a; }
        .cap-bar { height: 6px; border-radius: 999px; background: rgba(255, 255, 255, 0.12); overflow: hidden; margin-top: 6px; }
        .cap-fill { height: 100%; background: #16a34a; }
        .cap-row { display: flex; justifyContent: space-between; font-size: 10px; color: rgba(255, 255, 255, 0.65); margin-top: 5px; }
        .dock { position: sticky; bottom: 0; padding: 10px 0 6px 0; background: linear-gradient(to top, rgba(0, 0, 0, 0.9), rgba(0, 0, 0, 0)); margin-top: 10px; }
      `}</style>
    </div>
  );
}
