'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { supabase } from '@/lib/supabaseClient';
import { getAllOrdersLocal, saveOrderLocal } from '@/lib/offlineStore';
import { recordCashMove } from '@/lib/arkaCashSync';

// --- CONFIG ---
const BUCKET = 'tepiha-photos';
const LOCAL_ORDERS_KEY = 'tepiha_local_orders_v1';
// PRANIMI stores offline-created orders here before sync
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


function normalizeOrder(input){
  // Accept {data:<payload>} or raw payload
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
  // parse JSON string
  if (typeof o === 'string') { try { o = JSON.parse(o); } catch { o = {}; } }
  // some rows store payload under .data (object or JSON string)
  if (o && o.data) {
    let d = o.data;
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch { d = null; } }
    if (d && (d.client || d.tepiha || d.pay || d.transport)) {
      o = d;
    }
  }
  return (o && typeof o === 'object') ? o : {};
}

async function readLocalOrdersByStatus(status) {
  const out = [];

  const pushRow = (id, fullOrder, ts, source, synced) => {
    if (!id || !fullOrder) return;
    const st = String(fullOrder.status || '').toLowerCase();
    if (normalizeStatus(st) !== normalizeStatus(status)) return;
    out.push({
      id,
      source,
      ts: Number(ts || fullOrder.ts || Date.now()),
      fullOrder,
      synced: !!synced,
    });
  };

  // 1) IndexedDB local store (authoritative offline mirror)
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

  // 2) Legacy localStorage offline queue (backward compatibility)
  try {
    const rawQ = localStorage.getItem(OFFLINE_QUEUE_KEY);
    const q = rawQ ? JSON.parse(rawQ) : [];
    (Array.isArray(q) ? q : []).forEach((it) => {
      const raw = it?.order || it?.payload || it;
      if (!raw) return;
      const full = normalizeOrder(raw?.data ? raw.data : raw);
      full.status = String(raw?.status || full.status || 'pastrim').toLowerCase();
      const id = raw?.id || raw?.order_id || full.id || '';
      const ts = raw?.updated_at || raw?.created_at || Date.now();
      pushRow(id, full, ts, 'lsq', false);
    });
  } catch {}

  // De-dupe by id: keep newest ts
  const byId = new Map();
  for (const row of out) {
    const prev = byId.get(row.id);
    if (!prev || (Number(row.ts) >= Number(prev.ts))) byId.set(row.id, row);
  }
  return Array.from(byId.values());
}

function sanitizePhone(phone) {
  return String(phone || '').replace(/\D+/g, '');
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
  if (d <= 0) return '#16a34a'; // green
  if (d === 1) return '#f59e0b'; // orange
  return '#dc2626'; // red
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

  // Prefill search from URL (?q=123)
  useEffect(() => {
    try {
      const q = sp?.get('q') || '';
      if (q) setSearch(String(q));
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sp]);

  
  const [editMode, setEditMode] = useState(false);
  const [saving, setSaving] = useState(false);
  const [photoUploading, setPhotoUploading] = useState(false);

  // Edit State
  const [oid, setOid] = useState('');
  const [orderSource, setOrderSource] = useState('orders'); // 'orders' or 'transport_orders'
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

  // Return info
  const [returnActive, setReturnActive] = useState(false);
  const [returnAt, setReturnAt] = useState(0);
  const [returnReason, setReturnReason] = useState('');
  const [returnNote, setReturnNote] = useState('');
  const [returnPhoto, setReturnPhoto] = useState('');

  // Sheets
  const [showPaySheet, setShowPaySheet] = useState(false);
  const [showStairsSheet, setShowStairsSheet] = useState(false);
  const [payAdd, setPayAdd] = useState(0);

  // Stats
  const [todayPastrimM2, setTodayPastrimM2] = useState(0);
  const [streamPastrimM2, setStreamPastrimM2] = useState(0);

  useEffect(() => {
    refreshOrders();
    return () => {
      if (longPressTimer.current) clearTimeout(longPressTimer.current);
    };
  }, []);

  // LIVE SYNC: if another user moves an order (pastrim <-> gati), refresh + mirror to offline store
  useEffect(() => {
    const ch1 = supabase
      .channel('pastrim-live-orders')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'orders' },
        async (payload) => {
          try {
            const row = payload?.new || payload?.old;
            if (row?.id) {
              await saveOrderLocal({
                id: row.id,
                status: normalizeStatus(row.status),
                data: row.data ?? null,
                updated_at: row.updated_at || row.ready_at || new Date().toISOString(),
                _synced: true,
                _table: 'orders',
              });
            }
          } catch {}
          refreshOrders();
        }
      )
      .subscribe();

    const ch2 = supabase
      .channel('pastrim-live-transport')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'transport_orders' },
        async (payload) => {
          try {
            const row = payload?.new || payload?.old;
            if (row?.id) {
              await saveOrderLocal({
                id: row.id,
                status: normalizeStatus(row.status),
                data: row.data ?? null,
                updated_at: row.updated_at || row.ready_at || new Date().toISOString(),
                _synced: true,
                _table: 'transport_orders',
              });
            }
          } catch {}
          refreshOrders();
        }
      )
      .subscribe();

    const onFocus = () => refreshOrders();
    if (typeof window !== 'undefined') window.addEventListener('focus', onFocus);

    return () => {
      try { supabase.removeChannel(ch1); } catch {}
      try { supabase.removeChannel(ch2); } catch {}
      if (typeof window !== 'undefined') window.removeEventListener('focus', onFocus);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);


  // --- DATA FETCHING (Unified Logic) ---
  async function refreshOrders() {
    setLoading(true);
    try {
      // OFFLINE fallback: show locally saved orders (from PRANIMI offline)
      try {
        if (typeof navigator !== 'undefined' && navigator.onLine === false) {
          const locals = (await readLocalOrdersByStatus('pastrim')).map((x) => {
            const order = unwrapOrderData(x.fullOrder);
            const total = Number(order.pay?.euro || 0);
            const paid = Number(order.pay?.paid || 0);
            const cope = (order.tepiha?.reduce((a,b)=>a+(Number(b.qty)||0),0)||0) +
                         (order.staza?.reduce((a,b)=>a+(Number(b.qty)||0),0)||0) +
                         (Number(order.shkallore?.qty)>0?1:0);
            return {
              id: x.id,
              source: 'LOCAL',
              ts: Number(order.ts || x.ts || Date.now()),
              name: order.client?.name || '',
              phone: order.client?.phone || '',
              code: normalizeCode(order.client?.code || order.code || ''),
              m2: computeM2(order),
              cope,
              total,
              paid,
              isPaid: paid >= total && total > 0,
              isReturn: !!order?.returnInfo?.active,
              fullOrder: order,
              localOnly: true,
            };
          });
          setOrders(locals);
          setLoading(false);
          return;
        }
      } catch {}
      // 1. Fetch from NORMAL orders
      const { data: normalData, error: normalError } = await supabase
        .from('orders')
        .select('id,status,created_at,data,code')
        .in('status', ['pastrim','pastrimi'])
                .order('created_at', { ascending: false })
        .limit(300);
      
      if (normalError) console.error("Normal orders error", normalError);

      // 2. Fetch from TRANSPORT orders
      const { data: transportData, error: transError } = await supabase
        .from('transport_orders')
        .select('id,status,created_at,data,code_str')
        .in('status', ['pastrim','pastrimi'])
                .order('created_at', { ascending: false })
        .limit(300);

      if (transError) console.error("Transport orders error", transError);

      const allOrders = [];

      // Process Normal Orders
      (normalData || []).forEach(row => {
        const order = unwrapOrderData(row.data);
        
        // Normalize rows
        if (!Array.isArray(order.tepiha) && Array.isArray(order.tepihaRows)) {
          order.tepiha = order.tepihaRows.map(r => ({ m2: Number(r?.m2)||0, qty: Number(r?.qty||r?.pieces)||0, photoUrl: r?.photoUrl||'' }));
        }
        if (!Array.isArray(order.staza) && Array.isArray(order.stazaRows)) {
          order.staza = order.stazaRows.map(r => ({ m2: Number(r?.m2)||0, qty: Number(r?.qty||r?.pieces)||0, photoUrl: r?.photoUrl||'' }));
        }

        const total = Number(order.pay?.euro || 0);
        const paid = Number(order.pay?.paid || 0);
        const cope = (order.tepiha?.reduce((a,b)=>a+(Number(b.qty)||0),0)||0) + 
                     (order.staza?.reduce((a,b)=>a+(Number(b.qty)||0),0)||0) + 
                     (Number(order.shkallore?.qty)>0?1:0);

        allOrders.push({
          id: row.id,
          source: 'orders', // Burimi: Lokal
          ts: Number(order.ts || Date.parse(row.created_at) || 0) || 0,
          name: order.client?.name || order.client_name || '',
          phone: order.client?.phone || order.client_phone || '',
          code: normalizeCode(order.client?.code || order.code || row.code),
          m2: computeM2(order),
          cope,
          total,
          paid,
          isPaid: paid >= total && total > 0,
          isReturn: !!order?.returnInfo?.active,
          fullOrder: order
        });
      });

      // Process Transport Orders
      (transportData || []).forEach(row => {
        const order = unwrapOrderData(row.data);

        const total = Number(order.pay?.euro || 0);
        const paid = Number(order.pay?.paid || 0);
        const cope = (order.tepiha?.reduce((a,b)=>a+(Number(b.qty)||0),0)||0) + 
                     (order.staza?.reduce((a,b)=>a+(Number(b.qty)||0),0)||0) + 
                     (Number(order.shkallore?.qty)>0?1:0);

        allOrders.push({
          id: row.id,
          source: 'transport_orders', // Burimi: Transport
          ts: Number(order.created_at ? Date.parse(order.created_at) : (Date.parse(row.created_at) || 0)),
          name: order.client?.name || '',
          phone: order.client?.phone || '',
          code: normalizeCode(row.code_str || order.client?.code), // Përdorim T-kodin
          m2: computeM2(order),
          cope,
          total,
          paid,
          isPaid: paid >= total && total > 0,
          isReturn: false,
          fullOrder: order
        });
      });

      // Sort combined list by date desc
      allOrders.sort((a, b) => b.ts - a.ts);
      // Merge local unsynced (offline-created) so they remain visible until synced
      try {
        const locals = await readLocalOrdersByStatus('pastrim');
        for (const x of locals) {
          const order = unwrapOrderData(x.fullOrder);
          const id = x.id;
          if (allOrders.some((o) => o.id === id)) continue;
          const total = Number(order.pay?.euro || 0);
          const paid = Number(order.pay?.paid || 0);
          const cope = (order.tepiha?.reduce((a,b)=>a+(Number(b.qty)||0),0)||0) +
                       (order.staza?.reduce((a,b)=>a+(Number(b.qty)||0),0)||0) +
                       (Number(order.shkallore?.qty)>0?1:0);
          allOrders.unshift({
            id,
            source: 'LOCAL',
            ts: Number(order.ts || x.ts || Date.now()),
            name: order.client?.name || '',
            phone: order.client?.phone || '',
            code: normalizeCode(order.client?.code || order.code || ''),
            m2: computeM2(order),
            cope,
            total,
            paid,
            isPaid: paid >= total && total > 0,
            isReturn: !!order?.returnInfo?.active,
            fullOrder: order,
            localOnly: true,
          });
        }
      } catch {}
      setOrders(allOrders);

      // Calc Totals
      const streamTotal = allOrders.reduce((sum, o) => sum + (Number(o.m2) || 0), 0);
      const streamVal = Number(streamTotal.toFixed(2));
      setStreamPastrimM2(streamVal);

      const today = dayKey(Date.now());
      const todayLoad = allOrders.filter(o => dayKey(o.ts) === today).reduce((sum, o) => sum + (Number(o.m2) || 0), 0);
      setTodayPastrimM2(Number(todayLoad.toFixed(2)));

    } finally {
      setLoading(false);
    }
  }

  // --- OPEN EDIT ---
  async function openEdit(item) {
    try {
      let ord = item.fullOrder;
      
      if (!ord) {
        // Prefer local cached payload for BASE orders (avoids DB mismatch when list was built from local mirror)
        if (item.source === 'orders' && item.raw_data) {
          ord = item.raw_data;
        } else {
          const { data, error } = await supabase
            .from(item.source)
            .select('data')
            .eq('id', item.id)
            .single();
          if (error || !data) throw new Error('Not found');
          ord = data.data;
          if (typeof ord === 'string') ord = JSON.parse(ord);
        }
      }

      setOid(String(item.id));
      setOrderSource(item.source); // E ruajmë burimin (orders apo transport_orders)
      setOrigTs(ord.ts || Date.now());
      setCodeRaw(normalizeCode(item.code));

      setName(ord.client?.name || '');
      const p = String(ord.client?.phone || '');
      setPhone(p.startsWith(phonePrefix) ? p.slice(phonePrefix.length) : p.replace(/\D+/g, ''));
      setClientPhotoUrl(ord.client?.photoUrl || ord.client?.photo || '');

      setTepihaRows(ord.tepiha?.length ? ord.tepiha.map((x,i)=>({id:`t${i+1}`, m2:String(x.m2||''), qty:String(x.qty||''), photoUrl:x.photoUrl||''})) : [{id:'t1', m2:'', qty:'', photoUrl:''}]);
      setStazaRows(ord.staza?.length ? ord.staza.map((x,i)=>({id:`s${i+1}`, m2:String(x.m2||''), qty:String(x.qty||''), photoUrl:x.photoUrl||''})) : [{id:'s1', m2:'', qty:'', photoUrl:''}]);

      setStairsQty(Number(ord.shkallore?.qty)||0);
      setStairsPer(Number(ord.shkallore?.per)||SHKALLORE_M2_PER_STEP_DEFAULT);
      setStairsPhotoUrl(ord.shkallore?.photoUrl||'');

      // Transport PRANIMI historically saved €/m² under `pay.price`.
      // Base system uses `pay.rate`. Support both so EDIT + PAGESA works for both sources.
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

  // --- SAVE ---
  async function handleSave() {
    setSaving(true);
    try {
      const currentPaidAmount = Number((Number(clientPaid) || 0).toFixed(2));
      let finalArka = Number(arkaRecordedPaid) || 0;

      // Reconstruct Object
      const order = {
        id: oid,
        ts: origTs,
        status: 'pastrim',
        client: {
          name: name.trim(),
          phone: phonePrefix + (phone || ''),
          code: normalizeCode(codeRaw),
          photoUrl: clientPhotoUrl || '',
        },
        tepiha: tepihaRows.map(r => ({ m2: Number(r.m2) || 0, qty: Number(r.qty) || 0, photoUrl: r.photoUrl || '' })),
        staza: stazaRows.map(r => ({ m2: Number(r.m2) || 0, qty: Number(r.qty) || 0, photoUrl: r.photoUrl || '' })),
        shkallore: { qty: Number(stairsQty) || 0, per: Number(stairsPer) || 0, photoUrl: stairsPhotoUrl || '' },
        pay: {
          m2: totalM2,
          rate: Number(pricePerM2) || PRICE_DEFAULT,
          euro: totalEuro,
          paid: currentPaidAmount,
          debt: currentDebt,
          paidUpfront: paidUpfront,
          method: payMethod,
          arkaRecordedPaid: finalArka
        },
        notes: notes || '',
        returnInfo: returnActive ? { active: true, at: returnAt, reason: returnReason, note: returnNote, photoUrl: returnPhoto } : undefined
      };

      // UPDATE DB (Dynamic Table)
      const { error: dbErr } = await supabase
        .from(orderSource) // 'orders' or 'transport_orders'
        .update({
          status: 'pastrim',
          data: order,
          updated_at: new Date().toISOString(),
        })
        .eq('id', oid);

      if (dbErr) throw dbErr;

      setEditMode(false);
      await refreshOrders();
    } catch (e) {
      alert('❌ Gabim ruajtja: ' + e.message);
    } finally {
      setSaving(false);
    }
  }

  // --- LOGJIKA "SMART" PËR STATUSIN GATI ---
  async function handleMarkReady(o) {
    const btnId = `btn-${o.id}`;
    const btn = document.getElementById(btnId);
    if(btn) { btn.disabled = true; btn.innerText = "⏳..."; }

    try {
      const table = o.source; // 'orders' ose 'transport_orders'
      const now = new Date().toISOString();

      const { data: currentRow, error: fetchErr } = await supabase
        .from(table)
        .select('data')
        .eq('id', o.id)
        .single();

      if (fetchErr) throw fetchErr;

      const updatedJson = {
        ...(currentRow.data || {}),
        status: 'gati',
        ready_at: now
      };

      // 1. UPDATE DB
      if (table === 'transport_orders') {
        // Transport: Vetëm statusin 'gati'
        await supabase
          .from('transport_orders')
          .update({ status: 'gati', data: updatedJson, updated_at: now, ready_at: now })
          .eq('id', o.id);
        
        alert(`✅ U bë GATI!\nShoferi u njoftua në listën e tij.`);
      } else {
        // Lokal: Update + SMS
        await supabase
          .from('orders')
          .update({ status: 'gati', ready_at: now, data: updatedJson })
          .eq('id', o.id);

        const msg = `Pershendetje ${o.name}, porosia (kodi ${o.code}) eshte GATI. Keni ${o.cope} cope • ${o.m2} m². Ju lutem ejani sot ose neser. Faleminderit!`;
        const url = `sms:${sanitizePhone(o.phone)}?&body=${encodeURIComponent(msg)}`;
        const link = document.createElement('a');
        link.href = url;
        link.click();
      }
      
      refreshOrders();

    } catch (e) {
      console.error("Error:", e);
      alert("❌ Diçka shkoi keq. Provo prapë.");
      if(btn) { btn.disabled = false; btn.innerText = o.source === 'transport_orders' ? 'NJOFTO SHOFERIN' : 'SMS KLIENTIT'; }
    }
  }

  // --- CALCULATIONS ---
  const totalM2 = useMemo(() => {
    const t = tepihaRows.reduce((sum, r) => sum + (Number(r.m2) || 0) * (Number(r.qty) || 0), 0);
    const s = stazaRows.reduce((sum, r) => sum + (Number(r.m2) || 0) * (Number(r.qty) || 0), 0);
    const sh = (Number(stairsQty) || 0) * (Number(stairsPer) || 0);
    return Number((t + s + sh).toFixed(2));
  }, [tepihaRows, stazaRows, stairsQty, stairsPer]);

  const totalEuro = useMemo(() => Number((totalM2 * (Number(pricePerM2) || 0)).toFixed(2)), [totalM2, pricePerM2]);
  const diff = useMemo(() => Number((totalEuro - clientPaid).toFixed(2)), [totalEuro, clientPaid]);
  const currentDebt = diff > 0 ? diff : 0;
  const currentChange = diff < 0 ? Math.abs(diff) : 0;

  // --- ROW ACTIONS ---
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

  // --- ROW PHOTOS ---
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

  // --- FULLSCREEN PAY ---
  function openPay() {
    const dueNow = Number((totalEuro - Number(clientPaid || 0)).toFixed(2));
    setPayAdd(dueNow > 0 ? dueNow : 0);
    setPayMethod("CASH");
    setShowPaySheet(true);
  }

  async function applyPayAndClose() {
    const cashGiven = Number((Number(payAdd) || 0).toFixed(2));
    if (cashGiven <= 0) { alert('SHUMA NUK VLEN (0 €).'); return; }
    const due = Math.max(0, Number((Number(totalEuro || 0) - Number(clientPaid || 0)).toFixed(2)));
    const applied = Number(Math.min(cashGiven, due).toFixed(2));
    if (applied <= 0) { alert(due <= 0 ? 'KJO POROSI ESHTE PAGUAR.' : 'SHUMA NUK VLEN.'); return; }

    const newPaid = Number((Number(clientPaid || 0) + applied).toFixed(2));
    setClientPaid(newPaid);

    if (payMethod === 'CASH') {
      const extId = `pay_${oid}_${Date.now()}`;
      await recordCashMove({
        externalId: extId, orderId: oid, code: normalizeCode(codeRaw), name: name.trim(), amount: applied,
        note: `PAGESA ${applied}€ • #${normalizeCode(codeRaw)} • ${name.trim()}`,
        source: 'ORDER_PAY', method: 'cash_pay', type: 'IN'
      });
      setArkaRecordedPaid(Number((Number(arkaRecordedPaid || 0) + applied).toFixed(2)));
    }
    setShowPaySheet(false);
  }

  // --- RENDER EDIT ---
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
              {clientPhotoUrl ? <img src={clientPhotoUrl} alt="" className="client-mini" /> : null}
              <label className="camera-btn">📷<input type="file" accept="image/*" style={{ display: 'none' }} onChange={e => handleClientPhotoChange(e.target.files?.[0])} /></label>
            </div>
            {clientPhotoUrl && <button className="btn secondary" style={{ display: 'block', fontSize: 10, padding: '4px 8px', marginTop: 8 }} onClick={() => setClientPhotoUrl('')}>🗑️ FSHI FOTO</button>}
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
          <div className="row util-row" style={{ gap: '10px' }}><button className="btn secondary" style={{ flex: 1 }} onClick={() => setShowStairsSheet(true)}>🪜 SHKALLORE</button><button className="btn secondary" style={{ flex: 1 }} onClick={openPay}>€ PAGESA</button></div>
          <div className="tot-line">M² Total: <strong>{totalM2}</strong></div>
          <div className="tot-line">Total: <strong>{totalEuro.toFixed(2)} €</strong></div>
          <div className="tot-line" style={{ borderTop: '1px solid #eee', marginTop: 10, paddingTop: 10 }}>Paguar: <strong style={{ color: '#16a34a' }}>{Number(clientPaid || 0).toFixed(2)} €</strong></div>
          {currentDebt > 0 && (<div className="tot-line">Borxh: <strong style={{ color: '#dc2626' }}>{currentDebt.toFixed(2)} €</strong></div>)}
        </section>

        <footer className="footer-bar"><button className="btn secondary" onClick={() => setEditMode(false)}>← ANULO</button><button className="btn primary" onClick={handleSave} disabled={saving}>{saving ? 'RUHET...' : 'RUAJ'}</button></footer>
        
        {showPaySheet && (<div className="payfs"><div className="payfs-top"><div><div className="payfs-title">PAGESA</div></div><button className="btn secondary" onClick={() => setShowPaySheet(false)}>✕</button></div><div className="payfs-body"><div className="card"><div className="tot-line">TOTAL: <strong>{totalEuro.toFixed(2)} €</strong></div><div className="tot-line">PAGUAR: <strong style={{ color: '#16a34a' }}>{Number(clientPaid).toFixed(2)} €</strong></div><div className="field-group" style={{marginTop:20}}><label className="label">SHTO PAGESË</label><input className="input" type="number" value={payAdd} onChange={e=>setPayAdd(e.target.value)} /><div className="chip-row">{PAY_CHIPS.map(c=><button key={c} className="chip" onClick={()=>setPayAdd(c)}>{c}€</button>)}</div></div></div></div><div className="payfs-footer"><button className="btn primary" onClick={applyPayAndClose}>RUAJ</button></div></div>)}
        
        <style jsx>{`
          .client-mini{ width: 34px; height: 34px; border-radius: 999px; object-fit: cover; border: 1px solid rgba(255,255,255,0.18); }
          .photo-thumb { width: 60px; height: 60px; object-fit: cover; border-radius: 8px; }
          .camera-btn { background: rgba(255,255,255,0.1); width: 44px; height: 44px; display: flex; align-items: center; justify-content: center; border-radius: 12px; }
          .payfs { position: fixed; inset: 0; background: #0b0b0b; z-index: 10000; display: flex; flex-direction: column; }
          .payfs-top { display: flex; justify-content: space-between; align-items: center; padding: 14px; background: #0b0b0b; border-bottom: 1px solid rgba(255,255,255,0.08); }
          .payfs-body { flex: 1; padding: 14px; }
          .payfs-footer { padding: 14px; border-top: 1px solid rgba(255,255,255,0.08); }
        `}</style>
      </div>
    );
  }

  // ---------------- LIST VIEW ----------------
  const streamPct = Math.min(100, (Number(streamPastrimM2 || 0) / STREAM_MAX_M2) * 100);

  return (
    <div className="wrap">
      <header className="header-row">
        <h1 className="title">PASTRIMI</h1>
        <div style={{ width: 40 }} />
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
            .map(o => (
              <div key={o.id + o.source} className="list-item-compact" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 4px', borderBottom: '1px solid rgba(255,255,255,0.08)', opacity: o.isReturn ? 0.92 : 1 }}>
                <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flex: 1 }}>
                  <div
                    onMouseDown={() => startLongPress(o)}
                    onTouchStart={() => startLongPress(o)}
                    onMouseUp={cancelLongPress}
                    onTouchEnd={cancelLongPress}
                    style={{
                      background: badgeColorByAge(o.ts),
                      color: '#fff', width: 40, height: 40, display: 'flex', alignItems: 'center', justifyContent: 'center',
                      borderRadius: 8, fontWeight: 800, fontSize: 14, flexShrink: 0
                    }}>
                    {normalizeCode(o.code)}
                  </div>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 14 }}>{o.name} {o.isReturn && <span style={{color:'#f59e0b'}}>• KTHIM</span>}</div>
                    <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.65)' }}>{o.cope} copë • {o.m2} m²</div>
                    {o.total > o.paid && <div style={{ fontSize: 11, color: '#dc2626', fontWeight: 'bold' }}>Borxh: {(Number(o.total)-Number(o.paid)).toFixed(2)}€</div>}
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  {o.isPaid && <span>✅</span>}
                  <button 
                    id={`btn-${o.id}`}
                    className="btn primary" 
                    style={{ padding: '6px 10px', fontSize: 12, backgroundColor: o.source === 'transport_orders' ? '#2563eb' : '#16a34a' }} 
                    onClick={() => handleMarkReady(o)}
                  >
                    {o.source === 'transport_orders' ? 'NJOFTO SHOFERIN' : 'SMS KLIENTIT'}
                  </button>
                </div>
              </div>
            ))
        }
      </section>

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