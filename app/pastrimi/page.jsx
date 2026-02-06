'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabaseClient';
import TaskInbox from '@/components/TaskInbox';
import { listUsers } from '@/lib/usersDb';
import { createTask } from '@/lib/tasksDb';
import { recordCashMove } from '@/lib/arkaCashSync';

function readActor() {
  try {
    const raw = localStorage.getItem('CURRENT_USER_DATA');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

const BUCKET = 'tepiha-photos';
const TEPIHA_CHIPS = [2.0, 2.5, 3.0, 3.2, 3.5, 3.7, 6.0];
const STAZA_CHIPS = [1.5, 2.0, 2.2, 3.0];

// SHKALLORE CHIPS
const SHKALLORE_QTY_CHIPS = [5, 10, 15, 20, 25, 30];
const SHKALLORE_PER_CHIPS = [0.25, 0.3, 0.35, 0.4];

const SHKALLORE_M2_PER_STEP_DEFAULT = 0.3;
const PRICE_DEFAULT = 3.0;

// PAGESA CHIPS
const PAY_CHIPS = [5, 10, 20, 30, 50];

// DAILY CAPACITY (për afatin “nesër/mbasnesër”)
const DAILY_CAPACITY_M2 = 400;

// STREAM MAX (për bar “MAX: … m²”)
const STREAM_MAX_M2 = 450;

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

function etaTextByCapacity(totalTodayM2) {
  return totalTodayM2 > DAILY_CAPACITY_M2
    ? 'GATI DITËN E 3-TË (MBASNESËR)'
    : 'GATI DITËN E 2-TË (NESËR)';
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

async function downloadJsonNoCache(path) {
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, 60);
  if (error || !data?.signedUrl) throw error || new Error('No signedUrl');
  const res = await fetch(`${data.signedUrl}&t=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error('Fetch failed');
  return await res.json();
}

// ---------------- COMPONENT ----------------
export default function PastrimiPage() {
  const phonePrefix = '+383';
  const longPressTimer = useRef(null);

  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  // tasks (DISPATCH/ADMIN)
  const [taskOpenById, setTaskOpenById] = useState({});
  const [showTaskSheet, setShowTaskSheet] = useState(false);
  const [taskOrder, setTaskOrder] = useState(null);
  const [taskUsers, setTaskUsers] = useState([]);
  const [taskToId, setTaskToId] = useState('');
  const [taskBusy, setTaskBusy] = useState(false);
  const [taskErr, setTaskErr] = useState('');
  const [taskItems, setTaskItems] = useState([]);
  const holdTaskTimer = useRef(null);

  const [editMode, setEditMode] = useState(false);
  const [saving, setSaving] = useState(false);
  const [photoUploading, setPhotoUploading] = useState(false);

  const [oid, setOid] = useState('');
  const [origTs, setOrigTs] = useState(null);

  const [codeRaw, setCodeRaw] = useState('');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [clientPhotoUrl, setClientPhotoUrl] = useState('');

  // ✅ empty qty by default (prevents ghost pieces when opening empty editor)
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

  // ✅ RETURN (KTHIM) — read-only info
  const [returnActive, setReturnActive] = useState(false);
  const [returnAt, setReturnAt] = useState(0);
  const [returnReason, setReturnReason] = useState('');
  const [returnNote, setReturnNote] = useState('');
  const [returnPhoto, setReturnPhoto] = useState('');

  // Full screen sheets
  const [showPaySheet, setShowPaySheet] = useState(false);
  const [showStairsSheet, setShowStairsSheet] = useState(false);

  // pagesë e sotme (delta)
  const [payAdd, setPayAdd] = useState(0);

  // capacity today (pastrim)
  const [todayPastrimM2, setTodayPastrimM2] = useState(0);

  // stream total m² (krejt pastrim)
  const [streamPastrimM2, setStreamPastrimM2] = useState(0);

  useEffect(() => {
    refreshOrders();
    return () => {
      if (longPressTimer.current) clearTimeout(longPressTimer.current);
    };
  }, []);

  async function dbFetchOrderById(idNum) {
  // try base orders first
  const { data, error } = await supabase
    .from('orders')
    .select('id,status,ready_at,picked_up_at,created_at,data')
    .eq('id', idNum)
    .single();

  if (!error && data) {
    const order = { ...(data.data || {}) };
    order.id = data.id;
    order.status = data.status;
    if (order?.status && order?.status !== data.status) order.status = data.status;
    return { row: data, order };
  }

  // fallback: transport_orders (pre-offload)
  const { data: tdata, error: terr } = await supabase
    .from('transport_orders')
    .select('id,status,created_at,data')
    .eq('id', idNum)
    .single();

  if (terr || !tdata) throw terr || new Error('ORDER_NOT_FOUND');

  const torder = { ...(tdata.data || {}) };
  torder.id = tdata.id;
  torder.status = tdata.status || 'pickup';
  return { row: tdata, order: torder };
}


  async function refreshOrders() {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('orders')
        .select('id,status,created_at,data')
        .eq('status', 'pastrim')
        .order('created_at', { ascending: false })
        .limit(500);
      if (error) throw error;

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
        order.id = row.id;
        order.status = row.status;

        // mirror locally for fast open/edit
        try {
          localStorage.setItem(`order_${row.id}`, JSON.stringify(order));
        } catch {}

        const total = Number(order.pay?.euro || 0);
        const paid = Number(order.pay?.paid || 0);
        const tCope = order.tepiha?.reduce((a, b) => a + (Number(b.qty) || 0), 0) || 0;
        const sCope = order.staza?.reduce((a, b) => a + (Number(b.qty) || 0), 0) || 0;
        const totalCope = tCope + sCope + (Number(order.shkallore?.qty) > 0 ? 1 : 0);
        const isReturn = !!order?.returnInfo?.active;

        return {
          id: row.id,
          ts: Number(order.ts || Date.parse(row.created_at) || 0) || 0,
          name: order.client?.name || order.client_name || '',
          phone: order.client?.phone || order.client_phone || '',
          code: order.client?.code || order.code || '',
          m2: computeM2(order),
          cope: totalCope,
          total,
          paid,
          isPaid: paid >= total && total > 0,
          isReturn,
        };
      });
      setOrders(list);
      refreshTaskOpen(list);

      // STREAM TOTAL (krejt PASTRIMI)
      const streamTotal = list.reduce((sum, o) => sum + (Number(o.m2) || 0), 0);
      const streamVal = Number(streamTotal.toFixed(2));
      setStreamPastrimM2(streamVal);
      localStorage.setItem('capacity_stream_pastrim_m2', String(streamVal));

      // TODAY LOAD (për afat “nesër/mbasnesër”)
      const today = dayKey(Date.now());
      const todayLoad = list
        .filter(o => dayKey(o.ts) === today)
        .reduce((sum, o) => sum + (Number(o.m2) || 0), 0);

      const val = Number(todayLoad.toFixed(2));
      setTodayPastrimM2(val);

      // cache për PRANIMI
      localStorage.setItem('capacity_today_key', today);
      localStorage.setItem('capacity_today_pastrim_m2', String(val));
      localStorage.setItem('capacity_eta_text', etaTextByCapacity(val));
    } finally {
      setLoading(false);
    }
  }

  function startLongPress(id) {
    if (longPressTimer.current) clearTimeout(longPressTimer.current);
    longPressTimer.current = setTimeout(() => openEdit(id), 600);
  }
  function cancelLongPress() {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }

  async function openEdit(id) {
    try {
      const { row, order: ord } = await dbFetchOrderById(id);
      try {
        localStorage.setItem(`order_${row.id}`, JSON.stringify(ord));
      } catch {}

      setOid(String(row.id));
      setOrigTs(ord.ts || Date.parse(row.created_at) || Date.now());
      setCodeRaw(normalizeCode(ord.client?.code || ord.code || ''));

      setName(ord.client?.name || '');

      const p = String(ord.client?.phone || '');
      setPhone(p.startsWith(phonePrefix) ? p.slice(phonePrefix.length) : p.replace(/\D+/g, ''));

      // ✅ client photo compatibility (pranimi-style)
      const clientPhoto =
        ord?.client?.photoUrl ||
        ord?.client?.photo ||
        ord?.clientPhotoUrl ||
        ord?.client_photo_url ||
        '';
      setClientPhotoUrl(clientPhoto);

      setTepihaRows(
        ord.tepiha?.length
          ? ord.tepiha.map((x, i) => ({ id: `t${i + 1}`, m2: String(x.m2 || ''), qty: String(x.qty || ''), photoUrl: x.photoUrl || '' }))
          : [{ id: 't1', m2: '', qty: '', photoUrl: '' }]
      );

      setStazaRows(
        ord.staza?.length
          ? ord.staza.map((x, i) => ({ id: `s${i + 1}`, m2: String(x.m2 || ''), qty: String(x.qty || ''), photoUrl: x.photoUrl || '' }))
          : [{ id: 's1', m2: '', qty: '', photoUrl: '' }]
      );

      setStairsQty(Number(ord.shkallore?.qty) || 0);
      setStairsPer(Number(ord.shkallore?.per) || SHKALLORE_M2_PER_STEP_DEFAULT);
      setStairsPhotoUrl(ord.shkallore?.photoUrl || '');

      setPricePerM2(Number(ord.pay?.rate ?? PRICE_DEFAULT));

      const paid = Number(ord.pay?.paid ?? 0);
      const method = ord.pay?.method || 'CASH';

      setClientPaid(paid);
      setPaidUpfront(!!ord.pay?.paidUpfront);
      setPayMethod(method);

      // FIX: Arka init
      const arkaFromFile = ord.pay?.arkaRecordedPaid;
      let arkaInit = Number(arkaFromFile ?? 0);

      if ((arkaFromFile === undefined || arkaFromFile === null) && method === 'CASH' && paid > 0) {
        arkaInit = paid;
      }
      if (method === 'CASH' && arkaInit === 0 && paid > 0) {
        arkaInit = paid;
      }
      setArkaRecordedPaid(Number(arkaInit || 0));

      setNotes(ord.notes || '');

      // ✅ KTHIM: read from returnInfo OR fallback returnLog[0]
      const ri = ord?.returnInfo;
      const rl0 = Array.isArray(ord?.returnLog) && ord.returnLog.length ? ord.returnLog[0] : null;

      const active = !!(ri?.active || rl0);
      setReturnActive(active);

      const at = Number(ri?.at || rl0?.ts || 0);
      setReturnAt(at);

      setReturnReason(String(ri?.reason || rl0?.reason || ''));
      setReturnNote(String(ri?.note || rl0?.note || ''));
      setReturnPhoto(String(ri?.photoUrl || rl0?.photoUrl || ''));

      setPayAdd(0);
      setShowPaySheet(false);
      setShowStairsSheet(false);

      setEditMode(true);
    } catch (e) {
      alert('❌ Gabim gjatë hapjes!');
    }

  }
  
  async function refreshTaskOpen(list) {
    try {
      const ids = (list || []).map((x) => Number(x.id)).filter((n) => Number.isFinite(n));
      if (ids.length === 0) {
        setTaskOpenById({});
        return;
      }
      const { data, error } = await supabase
        .from('tepiha_tasks')
        .select('id,related_order_id,status')
        .in('related_order_id', ids)
        .in('status', ['SENT', 'ACCEPTED', 'NEED_INFO'])
        .limit(1000);
      if (error) return;
      const map = {};
      for (const t of data || []) {
        const oid = String(t.related_order_id || '');
        if (oid) map[oid] = true;
      }
      setTaskOpenById(map);
    } catch {}
  }

  async function openOrderTasks(row) {
    try {
      setTaskErr('');
      setTaskItems([]);
      setTaskOrder(row);
      setShowTaskSheet(true);

      if (taskUsers.length === 0) {
        const u = await listUsers();
        if (u?.ok) setTaskUsers(u.items || []);
      }

      const oid = Number(row.id);
      const { data, error } = await supabase
        .from('tepiha_tasks')
        .select('id,status,type,title,body,to_user_id,from_user_id,created_at,updated_at,reject_reason,outcome,not_ready_reason')
        .eq('related_order_id', oid)
        .order('created_at', { ascending: false })
        .limit(50);
      if (!error) setTaskItems(data || []);
    } catch {
      setTaskErr("S'MUN U HAP TASK.");
    }
  }

  async function sendCheckReadyTask() {
    if (!taskOrder) return;
    if (!taskToId) {
      setTaskErr('Zgjidh puntorin.');
      return;
    }
    setTaskBusy(true);
    setTaskErr('');
    try {
      const code = Number(String(taskOrder.code || '').replace(/\D/g, '')) || null;
      const title = 'KQYR A ËSHTË GATI';
      const body = `Shiko porosinë ${code ? '#' + code : ''} — a është GATI tani?`;
      const res = await createTask({
        to_user_id: taskToId,
        from_user_id: readActor()?.id || null,
        type: 'CHECK_READY',
        title,
        body,
        related_order_id: taskOrder.id,
        order_code: code,
        priority: 'MED',
      });
      if (!res.ok) throw res.error;

      refreshOrders();
      setTaskToId('');
      setTaskErr('U DËRGUA ✅');
      setTimeout(() => setTaskErr(''), 900);
    } catch {
      setTaskErr("S'U DËRGUA TASK.");
    } finally {
      setTaskBusy(false);
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
  const currentChange = diff < 0 ? Math.abs(diff) : 0;

  function addRow(kind) {
    const setter = kind === 'tepiha' ? setTepihaRows : setStazaRows;
    const prefix = kind === 'tepiha' ? 't' : 's';
    // ✅ empty qty by default; chips add qty=1
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

  async function handleClientPhotoChange(file) {
    if (!file || !oid) return;
    setPhotoUploading(true);
    try {
      const url = await uploadPhoto(file, oid, 'client');
      if (url) setClientPhotoUrl(url);
    } catch (e) {
      alert('❌ Gabim foto!');
    } finally {
      setPhotoUploading(false);
    }
  }

  async function handleStairsPhotoChange(file) {
    if (!file || !oid) return;
    setPhotoUploading(true);
    try {
      const url = await uploadPhoto(file, oid, 'shkallore');
      if (url) setStairsPhotoUrl(url);
    } catch (e) {
      alert('❌ Gabim foto!');
    } finally {
      setPhotoUploading(false);
    }
  }

  // ---------- FULLSCREEN PAY ----------
  function openPay() {
    const dueNow = Number((totalEuro - Number(clientPaid || 0)).toFixed(2));
    setPayAdd(dueNow > 0 ? dueNow : 0);
    setPayMethod("CASH");
    setShowPaySheet(true);
  }

  async function applyPayAndClose() {
    const cashGiven = Number((Number(payAdd) || 0).toFixed(2));
    if (cashGiven <= 0) {
      alert('SHUMA NUK VLEN (0 €).');
      return;
    }

    const due = Math.max(0, Number((Number(totalEuro || 0) - Number(clientPaid || 0)).toFixed(2)));
    const applied = Number(Math.min(cashGiven, due).toFixed(2));
    if (applied <= 0) {
      alert(due <= 0 ? 'KJO POROSI ESHTE PAGUAR (SKA BORXH).' : 'SHUMA NUK VLEN (0 €).');
      return;
    }

    const newPaid = Number((Number(clientPaid || 0) + applied).toFixed(2));
    setClientPaid(newPaid);

    // ✅ ARKA delta only if CASH (local cache + Supabase arka_moves if day open)
    if (payMethod === 'CASH') {
      const actor = readActor();
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
        createdByPin: actor?.pin ? String(actor.pin) : null,
        createdBy: actor?.name ? String(actor.name) : null,
      });

      const finalArka = Number((Number(arkaRecordedPaid || 0) + applied).toFixed(2));
      setArkaRecordedPaid(finalArka);
    }

    setShowPaySheet(false);
  }

  async function handleSave() {
    setSaving(true);
    try {
      // ✅ pull original to preserve returnInfo/returnLog and any other future fields
      let prev = null;
      try {
        const raw = localStorage.getItem(`order_${oid}`);
        if (raw) prev = JSON.parse(raw);
      } catch {
        prev = null;
      }
      if (!prev) {
        try {
          prev = await downloadJsonNoCache(`orders/${oid}.json`);
        } catch {
          prev = null;
        }
      }

      const currentPaidAmount = Number((Number(clientPaid) || 0).toFixed(2));
      let finalArka = Number(arkaRecordedPaid) || 0;

      // logjikë ekzistuese (për raste të vjetra)
      if (paidUpfront === true && payMethod === 'CASH') {
        const delta = Number((currentPaidAmount - finalArka).toFixed(2));
        if (delta > 0) {
          const actor = readActor();
          const extId = `front_${oid}_${Date.now()}`;
          await recordCashMove({
            externalId: extId,
            orderId: oid,
            code: normalizeCode(codeRaw),
            name: name.trim(),
            amount: delta,
            note: `AVANS ${delta}€ • #${normalizeCode(codeRaw)} • ${name.trim()}`,
            source: 'ORDER_FRONT',
            method: 'cash_front',
            type: 'IN',
            createdByPin: actor?.pin ? String(actor.pin) : null,
            createdBy: actor?.name ? String(actor.name) : null,
          });
          finalArka = Number((finalArka + delta).toFixed(2));
        }
      }

      // ✅ preserve return fields from previous
      const preservedReturnInfo = prev?.returnInfo || (returnActive ? { active: true, at: returnAt || Date.now(), from: 'gati' } : undefined);
      const preservedReturnLog = Array.isArray(prev?.returnLog) ? prev.returnLog : undefined;

      const order = {
        ...(prev || {}),
        id: oid,
        ts: origTs || prev?.ts || Date.now(),
        status: 'pastrim',
        client: {
          ...(prev?.client || {}),
          name: name.trim(),
          phone: phonePrefix + (phone || ''),
          code: normalizeCode(codeRaw),
          photoUrl: clientPhotoUrl || '',
          // ✅ kompatibilitet
          photo: clientPhotoUrl || ''
        },
        tepiha: tepihaRows.map(r => ({ m2: Number(r.m2) || 0, qty: Number(r.qty) || 0, photoUrl: r.photoUrl || '' })),
        staza: stazaRows.map(r => ({ m2: Number(r.m2) || 0, qty: Number(r.qty) || 0, photoUrl: r.photoUrl || '' })),
        shkallore: { qty: Number(stairsQty) || 0, per: Number(stairsPer) || 0, photoUrl: stairsPhotoUrl || '' },
        pay: {
          ...(prev?.pay || {}),
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
        // ✅ keep return info/log ALWAYS
        returnInfo: preservedReturnInfo,
        returnLog: preservedReturnLog
      };

      // ✅ DB is source of truth (orders table)
      const nowIso = new Date().toISOString();
      const { error: dbErr } = await supabase
        .from('orders')
        .update({
          status: 'pastrim',
          data: { ...order, status: 'pastrim' },
          updated_at: nowIso,
        })
        .eq('id', oid);
      if (dbErr) throw dbErr;

      localStorage.setItem(`order_${oid}`, JSON.stringify(order));
      setArkaRecordedPaid(finalArka);
      setEditMode(false);
      await refreshOrders();
    } catch (e) {
      alert('❌ Gabim ruajtja!');
    } finally {
         setSaving(false);
    }
  }

       async function handleSendSMS(o) {
    try {
      const msg = `Pershendetje ${o.name}, porosia (kodi ${normalizeCode(o.code)}) eshte GATI. Keni ${o.cope} cope • ${o.m2} m². Ju lutem ejani sot ose neser. Faleminderit!`;
      const url = `sms:${sanitizePhone(o.phone)}?&body=${encodeURIComponent(msg)}`;
      
      // ✅ 1. HAPJA DIREKTE (I jep urdher iPhone-it menjere pa prit asnje await)
      const link = document.createElement('a');
      link.href = url;
      link.click();

      // ✅ 2. UPDATE NE BACKGROUND (Ndryshon statusin pa e ndalu procesin e SMS)
      fetch('/api/orders/set-status', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: Number(o.id), status: 'gati' }),
      }).then(() => {
        refreshOrders(); // E fshin nga lista sapo kryhet update-i
      });

    } catch (e) {
      console.error("SMS Error:", e);
    }
  }

  // ---------------- EDIT MODE ----------------


  // ---------------- EDIT MODE ----------------
  if (editMode) {
    return (
      <div className="wrap">
        <header className="header-row" style={{ alignItems: 'flex-start' }}>
          <div>
            <h1 className="title">PASTRIMI</h1>
            <div className="subtitle">EDITIMI</div>
          </div>
          <div className="code-badge">
            <span className="badge">{`KODI: ${normalizeCode(codeRaw)}`}</span>
          </div>
        </header>

        <section className="card">
          <h2 className="card-title">Klienti</h2>

          <div className="field-group">
            <label className="label">EMRI</label>

            {/* ✅ pranimi-style: photo next to name + camera */}
            <div className="row" style={{ alignItems: 'center', gap: 10 }}>
              <input className="input" value={name} onChange={e => setName(e.target.value)} style={{ flex: 1 }} />
              {clientPhotoUrl ? <img src={clientPhotoUrl} alt="" className="client-mini" /> : null}
              <label className="camera-btn" title="FOTO KLIENTI" style={{ marginLeft: 2 }}>
                📷
                <input
                  type="file"
                  accept="image/*"
                  style={{ display: 'none' }}
                  onChange={e => handleClientPhotoChange(e.target.files?.[0])}
                />
              </label>
            </div>

            {clientPhotoUrl && (
              <button
                className="btn secondary"
                style={{ display: 'block', fontSize: 10, padding: '4px 8px', marginTop: 8 }}
                onClick={() => setClientPhotoUrl('')}
              >
                🗑️ FSHI FOTO
              </button>
            )}
          </div>

          <div className="field-group">
            <label className="label">TELEFONI</label>
            <div className="row">
              <input className="input small" value={phonePrefix} readOnly />
              <input className="input" value={phone} onChange={e => setPhone(e.target.value)} />
            </div>
          </div>
        </section>

        {/* ✅ KTHIM CARD (read-only) */}
        {returnActive && (
          <section className="card">
            <h2 className="card-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              KTHIM
              <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.65)' }}>
                {returnAt ? new Date(returnAt).toLocaleString() : ''}
              </span>
            </h2>

            {returnReason && (
              <div className="tot-line">
                Arsye: <strong>{returnReason}</strong>
              </div>
            )}

            {returnNote && (
              <div className="tot-line" style={{ marginTop: 6, whiteSpace: 'pre-wrap' }}>
                Shënim: <strong>{returnNote}</strong>
              </div>
            )}

            {returnPhoto && (
              <div style={{ marginTop: 10 }}>
                <img src={returnPhoto} className="photo-thumb" alt="" />
              </div>
            )}

            <div style={{ marginTop: 10, fontSize: 12, color: 'rgba(255,255,255,0.65)' }}>
              * Ky KTHIM është read-only në PASTRIMI.
            </div>
          </section>
        )}

        {['tepiha', 'staza'].map(kind => (
          <section className="card" key={kind}>
            <h2 className="card-title">{kind.toUpperCase()}</h2>
            <div className="chip-row">
              {(kind === 'tepiha' ? TEPIHA_CHIPS : STAZA_CHIPS).map(val => (
                <button
                  key={val}
                  className="chip"
                  onClick={() => {
                    const rows = kind === 'tepiha' ? tepihaRows : stazaRows;
                    const setter = kind === 'tepiha' ? setTepihaRows : setStazaRows;
                    const emptyIdx = rows.findIndex(r => !r.m2);
                    if (emptyIdx !== -1) {
                      const nr = [...rows];
                      nr[emptyIdx].m2 = String(val);
                      setter(nr);
                    } else {
                      setter([...rows, { id: `${kind[0]}${rows.length + 1}`, m2: String(val), qty: '1', photoUrl: '' }]);
                    }
                  }}
                >
                  {val}
                </button>
              ))}
            </div>

            {(kind === 'tepiha' ? tepihaRows : stazaRows).map(row => (
              <div className="piece-row" key={row.id}>
                <div className="row">
                  <input className="input small" type="number" value={row.m2} onChange={e => handleRowChange(kind, row.id, 'm2', e.target.value)} placeholder="m²" />
                  <input className="input small" type="number" value={row.qty} onChange={e => handleRowChange(kind, row.id, 'qty', e.target.value)} placeholder="copë" />
                  <label className="camera-btn">
                    📷
                    <input type="file" accept="image/*" style={{ display: 'none' }} onChange={e => handleRowPhotoChange(kind, row.id, e.target.files?.[0])} />
                  </label>
                </div>

                {row.photoUrl && (
                  <div style={{ marginTop: 8 }}>
                    <img src={row.photoUrl} className="photo-thumb" alt="" />
                    <button
                      className="btn secondary"
                      style={{ display: 'block', fontSize: 10, padding: '4px 8px', marginTop: 4 }}
                      onClick={() => handleRowChange(kind, row.id, 'photoUrl', '')}
                    >
                      🗑️ FSHI FOTO
                    </button>
                  </div>
                )}
              </div>
            ))}

            <div className="row btn-row">
              <button className="btn secondary" onClick={() => addRow(kind)}>
                + RRESHT
              </button>
              <button className="btn secondary" onClick={() => removeRow(kind)}>
                − RRESHT
              </button>
            </div>
          </section>
        ))}

        <section className="card">
          <div className="row util-row" style={{ gap: '10px' }}>
            <button className="btn secondary" style={{ flex: 1 }} onClick={() => setShowStairsSheet(true)}>
              🪜 SHKALLORE
            </button>
            <button className="btn secondary" style={{ flex: 1 }} onClick={openPay}>
              € PAGESA
            </button>
          </div>

          <div className="tot-line">
            M² Total: <strong>{totalM2}</strong>
          </div>
          <div className="tot-line">
            Total: <strong>{totalEuro.toFixed(2)} €</strong>
          </div>

          <div className="tot-line" style={{ borderTop: '1px solid #eee', marginTop: 10, paddingTop: 10 }}>
            Paguar: <strong style={{ color: '#16a34a' }}>{Number(clientPaid || 0).toFixed(2)} €</strong>
          </div>

          <div className="tot-line" style={{ fontSize: 12, color: '#666' }}>
            Regjistru n&apos;ARKË: <strong>{Number(arkaRecordedPaid || 0).toFixed(2)} €</strong>
          </div>

          {currentDebt > 0 && (
            <div className="tot-line">
              Borxh: <strong style={{ color: '#dc2626' }}>{currentDebt.toFixed(2)} €</strong>
            </div>
          )}
          {currentChange > 0 && (
            <div className="tot-line">
              Kthim: <strong style={{ color: '#2563eb' }}>{currentChange.toFixed(2)} €</strong>
            </div>
          )}
        </section>

        <section className="card">
          <h2 className="card-title">SHËNIME</h2>
          <textarea className="input" rows={3} value={notes} onChange={e => setNotes(e.target.value)} />
        </section>

        <footer className="footer-bar">
          <button className="btn secondary" onClick={() => setEditMode(false)}>
            ← ANULO
          </button>
          <button className="btn primary" onClick={handleSave} disabled={saving || photoUploading}>
            {saving ? 'RUHET...' : 'RUAJ'}
          </button>
        </footer>

        {/* FULL SCREEN PAGESA */}
        {showPaySheet && (
          <div className="payfs">
            <div className="payfs-top">
              <div>
                <div className="payfs-title">PAGESA</div>
                <div className="payfs-sub">
                  KODI: {normalizeCode(codeRaw)} • {name}
                </div>
              </div>
              <button className="btn secondary" onClick={() => setShowPaySheet(false)}>
                ✕
              </button>
            </div>

            <div className="payfs-body">
              <div className="card" style={{ marginTop: 0 }}>
                <div className="tot-line">
                  TOTAL: <strong>{totalEuro.toFixed(2)} €</strong>
                </div>
                <div className="tot-line">
                  PAGUAR DERI TANI: <strong style={{ color: '#16a34a' }}>{Number(clientPaid || 0).toFixed(2)} €</strong>
                </div>
                <div className="tot-line" style={{ fontSize: 12, color: '#666' }}>
                  REGJISTRU N&apos;ARKË DERI TANI: <strong>{Number(arkaRecordedPaid || 0).toFixed(2)} €</strong>
                </div>

                <div className="tot-line" style={{ borderTop: '1px solid #eee', marginTop: 10, paddingTop: 10 }}>
                  SOT PAGUAN: <strong>{Number(payAdd || 0).toFixed(2)} €</strong>
                </div>

                {(() => {
                  const dueNow = Number((totalEuro - Number(clientPaid || 0)).toFixed(2));
                  const dueSafe = dueNow > 0 ? dueNow : 0;
                  const given = Number((Number(payAdd || 0)).toFixed(2));
                  const applied = Number((Math.min(given, dueSafe)).toFixed(2));
                  const paidAfter = Number((Number(clientPaid || 0) + applied).toFixed(2));
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

              <div className="card">
                <div className="field-group">
                  <label className="label">KLIENTI DHA (€)</label>

                  <input
                    type="text"
                  inputMode="decimal"
                  pattern="[0-9]*"
                    className="input"
                    value={Number(payAdd || 0) === 0 ? '' : payAdd}
                    onChange={e => {
                      const v = e.target.value;
                      setPayAdd(v === '' ? 0 : Number(v));
                    }}
                    placeholder=""
                  />

                  <div className="chip-row" style={{ marginTop: 10 }}>
                    {/* EXACT = SHUMA E MBETUR */}
                    <button
                      className="chip"
                      type="button"
                      onClick={() => {
                        const dueNow = Number((totalEuro - Number(clientPaid || 0)).toFixed(2));
                        setPayAdd(dueNow > 0 ? dueNow : 0);
                      }}
                    >
                      EXACT
                    </button>
                    {PAY_CHIPS.map(v => (
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
            </div>

            <div className="payfs-footer">
              <button className="btn secondary" onClick={() => setShowPaySheet(false)}>
                ANULO
              </button>
              <button className="btn primary" onClick={applyPayAndClose}>
                RUJ PAGESËN
              </button>
            </div>
          </div>
        )}

        {/* SHKALLORE (DARK + CHIPS) */}
        {showStairsSheet && (
          <div className="modal-overlay" onClick={() => setShowStairsSheet(false)}>
            <div className="modal-content dark" onClick={e => e.stopPropagation()}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h3 className="card-title" style={{ margin: 0, color: '#fff' }}>
                  SHKALLORE
                </h3>
                <button className="btn secondary" onClick={() => setShowStairsSheet(false)}>
                  ✕
                </button>
              </div>

              <div className="field-group" style={{ marginTop: 12 }}>
                <label className="label" style={{ color: 'rgba(255,255,255,0.8)' }}>
                  COPE
                </label>

                <div className="chip-row">
                  {SHKALLORE_QTY_CHIPS.map(n => (
                    <button
                      key={n}
                      className="chip"
                      type="button"
                      onClick={() => setStairsQty(n)}
                      style={Number(stairsQty) === n ? { outline: '2px solid rgba(255,255,255,0.35)' } : null}
                    >
                      {n}
                    </button>
                  ))}
                </div>

                <input
                  type="text"
                  inputMode="decimal"
                  pattern="[0-9]*"
                  className="input"
                  value={stairsQty === 0 ? '' : stairsQty}
                  onChange={e => {
                    const v = e.target.value;
                    setStairsQty(v === '' ? 0 : Number(v));
                  }}
                  placeholder=""
                  style={{ marginTop: 10 }}
                />
              </div>

              <div className="field-group">
                <label className="label" style={{ color: 'rgba(255,255,255,0.8)' }}>
                  m² PËR COPË
                </label>

                <div className="chip-row">
                  {SHKALLORE_PER_CHIPS.map(v => (
                    <button
                      key={v}
                      className="chip"
                      type="button"
                      onClick={() => setStairsPer(v)}
                      style={Number(stairsPer) === v ? { outline: '2px solid rgba(255,255,255,0.35)' } : null}
                    >
                      {v}
                    </button>
                  ))}
                </div>

                <input
                  type="number"
                  step="0.01"
                  className="input"
                  value={Number(stairsPer || 0) === 0 ? '' : stairsPer}
                  onChange={e => {
                    const v = e.target.value;
                    setStairsPer(v === '' ? 0 : Number(v));
                  }}
                  style={{ marginTop: 10 }}
                />
              </div>

              <div className="field-group">
                <label className="label" style={{ color: 'rgba(255,255,255,0.8)' }}>
                  FOTO
                </label>
                <label className="camera-btn">
                  📷
                  <input type="file" accept="image/*" style={{ display: 'none' }} onChange={e => handleStairsPhotoChange(e.target.files?.[0])} />
                </label>

                {stairsPhotoUrl && (
                  <div style={{ marginTop: 8 }}>
                    <img src={stairsPhotoUrl} className="photo-thumb" alt="" />
                    <button
                      className="btn secondary"
                      style={{ display: 'block', fontSize: 10, padding: '4px 8px', marginTop: 4 }}
                      onClick={() => setStairsPhotoUrl('')}
                    >
                      🗑️ FSHI FOTO
                    </button>
                  </div>
                )}
              </div>

              <button className="btn primary" style={{ width: '100%', marginTop: 12 }} onClick={() => setShowStairsSheet(false)}>
                MBYLL
              </button>
            </div>
          </div>
        )}

        {/* Styles për modals + client-mini */}
        <style jsx>{`
          .client-mini{
            width: 34px;
            height: 34px;
            border-radius: 999px;
            object-fit: cover;
            border: 1px solid rgba(255,255,255,0.18);
            box-shadow: 0 6px 14px rgba(0,0,0,0.35);
          }

          .modal-overlay {
            position: fixed;
            inset: 0;
            background: rgba(0, 0, 0, 0.6);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 9999;
            padding: 20px;
          }
          .modal-content {
            width: 100%;
            max-width: 420px;
            padding: 18px;
            border-radius: 18px;
            box-shadow: 0 10px 25px rgba(0, 0, 0, 0.35);
            background: white;
          }
          .modal-content.dark {
            background: #0b0b0b;
            color: #fff;
            border: 1px solid rgba(255, 255, 255, 0.1);
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
            display: flex;
            gap: 10px;
            padding: 12px 14px;
            border-top: 1px solid rgba(255, 255, 255, 0.08);
            background: #0b0b0b;
          }
          .payfs-footer .btn {
            flex: 1;
          }
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

        <div className="cap-bar">
          <div className="cap-fill" style={{ width: `${streamPct}%` }} />
        </div>

        <div className="cap-row">
          <span>0 m²</span>
          <span>MAX: {STREAM_MAX_M2} m²</span>
        </div>
      </section>

      <input className="input" placeholder="🔎 Kërko emrin ose kodin..." value={search} onChange={e => setSearch(e.target.value)} />

      <section className="card" style={{ padding: '10px' }}>
        {loading ? (
          <p style={{ textAlign: 'center' }}>Duke u ngarkuar...</p>
        ) : (
          orders
            .filter(o => o.name?.toLowerCase().includes(search.toLowerCase()) || normalizeCode(o.code).includes(normalizeCode(search)))
            .map(o => (
              <div
                key={o.id}
                className="list-item-compact"
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '8px 4px',
                  borderBottom: '1px solid rgba(255,255,255,0.08)',
                  opacity: o.isReturn ? 0.92 : 1
                }}
              >
                <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flex: 1 }}>
                  <div
                    onMouseDown={() => startLongPress(o.id)}
                    onTouchStart={() => startLongPress(o.id)}
                    onMouseUp={cancelLongPress}
                    onTouchEnd={cancelLongPress}
                    onMouseLeave={cancelLongPress}
                    onTouchMove={cancelLongPress}
                    style={{
                      background: badgeColorByAge(o.ts),
                      color: '#fff',
                      width: 40,
                      height: 40,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      borderRadius: 8,
                      position: 'relative',
                      cursor: taskOpenById[o.id] ? 'pointer' : 'default',
                      fontWeight: 800,
                      fontSize: 14,
                      flexShrink: 0
                    }}
                  >
                    {normalizeCode(o.code)}
                  </div>

                  <div>
                    <div style={{ fontWeight: 600, fontSize: 14 }}>
                      {o.name} {o.isReturn ? <span style={{ fontSize: 12, color: '#f59e0b', fontWeight: 900 }}>• KTHIM</span> : null}
                    </div>
                    <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.65)' }}>
                      {o.cope} copë • {o.m2} m²
                    </div>
                    {o.paid > 0 && (
                      <div style={{ fontSize: 11, color: '#16a34a', fontWeight: 'bold' }}>
                        Paguar: {Number(o.paid || 0).toFixed(2)}€
                      </div>
                    )}
                    {o.total > o.paid && (
                      <div style={{ fontSize: 11, color: '#dc2626', fontWeight: 'bold' }}>
                        Borxh: {(Number(o.total || 0) - Number(o.paid || 0)).toFixed(2)}€
                      </div>
                    )}
                  </div>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  {o.isPaid && <span style={{ fontSize: 14 }}>✅</span>}
                  <button className="btn primary" style={{ padding: '6px 10px', fontSize: 12 }} onClick={() => handleSendSMS(o)}>
                    SMS
                  </button>
                </div>
              </div>
            ))
        )}
      </section>


      {/* ============ TASK SHEET (DISPATCH/ADMIN) ============ */}
      {showTaskSheet && taskOrder && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.55)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 9999,
            padding: 14,
          }}
          onClick={() => {
            setShowTaskSheet(false);
            setTaskOrder(null);
            setTaskItems([]);
            setTaskErr('');
          }}
        >
          <div
            style={{
              width: 'min(520px, 100%)',
              background: 'rgba(8,10,18,0.96)',
              border: '1px solid rgba(255,255,255,0.10)',
              borderRadius: 14,
              padding: 14,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
              <div style={{ fontWeight: 900, letterSpacing: 1 }}>
                TASK • #{normalizeCode(taskOrder.code)}
              </div>
              <button
                className="btn secondary"
                style={{ padding: '6px 10px', fontSize: 12 }}
                onClick={() => {
                  setShowTaskSheet(false);
                  setTaskOrder(null);
                  setTaskItems([]);
                  setTaskErr('');
                }}
              >
                MBYLL
              </button>
            </div>

            <div style={{ marginTop: 10, fontSize: 12, opacity: 0.85 }}>
              {taskOrder.name || 'Pa emër'} • {taskOrder.cope} copë • {Number(taskOrder.m2 || 0).toFixed(2)} m²
            </div>

            <div style={{ marginTop: 12 }}>
              {taskItems.length === 0 ? (
                <div style={{ fontSize: 12, opacity: 0.7 }}>S’ka task për këtë porosi.</div>
              ) : (
                <div style={{ display: 'grid', gap: 8 }}>
                  {taskItems.map((t) => (
                    <div
                      key={t.id}
                      style={{
                        border: '1px solid rgba(255,255,255,0.08)',
                        borderRadius: 12,
                        padding: 10,
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 12 }}>
                        <div style={{ fontWeight: 900 }}>{(t.title || 'TASK').toUpperCase()}</div>
                        <div style={{ opacity: 0.8 }}>{String(t.status || '').toUpperCase()}</div>
                      </div>
                      {t.body ? <div style={{ marginTop: 6, fontSize: 12, opacity: 0.85 }}>{t.body}</div> : null}
                      {t.not_ready_reason ? (
                        <div style={{ marginTop: 6, fontSize: 12, color: '#f59e0b', fontWeight: 800 }}>
                          {t.not_ready_reason}
                        </div>
                      ) : null}
                      {t.reject_reason ? (
                        <div style={{ marginTop: 6, fontSize: 12, color: '#ef4444', fontWeight: 800 }}>
                          {t.reject_reason}
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div style={{ marginTop: 14, borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: 12 }}>
              <div style={{ fontSize: 12, fontWeight: 900, opacity: 0.9 }}>DËRGO “KQYR A ËSHTË GATI”</div>

              <select
                className="input"
                value={taskToId}
                onChange={(e) => setTaskToId(e.target.value)}
                style={{ marginTop: 8 }}
              >
                <option value="">ZGJIDH PUNTORIN…</option>
                {taskUsers.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name || u.username || u.email || u.id}
                  </option>
                ))}
              </select>

              {taskErr ? (
                <div style={{ marginTop: 8, fontSize: 12, color: taskErr.includes('✅') ? '#22c55e' : '#ef4444', fontWeight: 900 }}>
                  {taskErr}
                </div>
              ) : null}

              <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
                <button className="btn primary" style={{ flex: 1, padding: '10px 12px', fontSize: 13 }} disabled={taskBusy} onClick={sendCheckReadyTask}>
                  {taskBusy ? 'DUKE DËRGUAR…' : 'DËRGO'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <footer className="dock">
        <Link href="/" className="btn secondary" style={{ width: '100%' }}>
          🏠 HOME
        </Link>
      </footer>

      <style jsx>{`
        .list-item-compact:last-child {
          border-bottom: none;
        }

        .cap-card {
          margin-top: 8px;
          padding: 8px 8px;
          border-radius: 14px;
          background: #0b0b0b;
          border: 1px solid rgba(255, 255, 255, 0.1);
        }
        .cap-title {
          text-align: center;
          font-size: 10px;
          letter-spacing: 0.6px;
          color: rgba(255, 255, 255, 0.65);
          font-weight: 800;
        }
        .cap-value {
          text-align: center;
          font-size: 26px;
          font-weight: 900;
          margin-top: 4px;
          line-height: 1;
          color: #16a34a;
        }
        .cap-bar {
          height: 6px;
          border-radius: 999px;
          background: rgba(255, 255, 255, 0.12);
          overflow: hidden;
          margin-top: 6px;
        }
        .cap-fill {
          height: 100%;
          background: #16a34a;
          width: 0%;
        }
        .cap-row {
          display: flex;
          justifyContent: 'space-between';
          font-size: 10px;
          color: rgba(255, 255, 255, 0.65);
          margin-top: 5px;
        }

        .dock {
          position: sticky;
          bottom: 0;
          padding: 10px 0 6px 0;
          background: linear-gradient(to top, rgba(0, 0, 0, 0.9), rgba(0, 0, 0, 0));
          margin-top: 10px;
        }
      `}</style>
    </div>
  );
}