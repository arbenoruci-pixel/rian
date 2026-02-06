"use client";

import {
  computeM2FromRows,
  normalizeCode,
  reserveSharedCode,
  markCodeUsed,
  releaseLocksForCode,
} from '@/lib/tepihaCode';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient';
import { fetchOrdersFromDb, fetchClientsFromDb, saveOrderToDb } from '@/lib/ordersDb';
import { recordCashMove } from '@/lib/arkaCashSync';
import { getActor } from '@/lib/actorSession';

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

// Capacity cache keys written by Pastrimi
const DAILY_CAPACITY_M2 = 400;

// Draft keys (local only)
const DRAFT_LIST_KEY = 'draft_orders_v1';
const DRAFT_ITEM_PREFIX = 'draft_order_';

// company contact footer for messages
const COMPANY_PHONE_DISPLAY = '+383 44 735 312';
const COMPANY_PHONE_RAW = '+383447353312';

// settings keys
const AUTO_MSG_KEY = 'pranimi_auto_msg_after_save';
const PRICE_KEY = 'pranimi_price_per_m2';

// OFFLINE safety (Pranimi)
const OFFLINE_MODE_KEY = 'tepiha_offline_mode_v1';
const OFFLINE_QUEUE_KEY = 'tepiha_offline_queue_v1';

// ✅ remote folders (shared between workers)
const DRAFTS_FOLDER = 'drafts';
const SETTINGS_FOLDER = 'settings';

// When a draft has client info, we don't want the reserved code to expire.
const LOCK_MINUTES_AFTER_INFO = 60 * 24 * 365 * 10;

// ---------------- HELPERS ----------------
function sanitizePhone(phone) {
  return String(phone || '').replace(/\D+/g, '');
}

function normDigits(s) {
  return String(s || '').replace(/\D+/g, '');
}

async function searchClientsLive(q) {
  const qq = String(q || '').trim();
  if (!qq) return [];

  const qDigits = normDigits(qq);
  const qText = qq.toLowerCase();

  let query = supabase
    .from('clients')
    .select('id, code, full_name, first_name, last_name, phone, photo_url, updated_at')
    .order('updated_at', { ascending: false })
    .limit(15);

  if (qDigits) {
    query = query.or(
      `code.eq.${Number(qDigits)},phone.ilike.%${qDigits}%,first_name.ilike.%${qText}%,last_name.ilike.%${qText}%`
    );
  } else {
    query = query.or(`first_name.ilike.%${qText}%,last_name.ilike.%${qText}%,phone.ilike.%${qText}%`);
  }

  const { data: clients, error } = await query;
  if (error) throw error;

  const list = Array.isArray(clients) ? clients : [];
  if (!list.length) return [];

  const codes = list.map((c) => Number(c?.code)).filter((n) => Number.isFinite(n));
  const activeByCode = new Map();

  if (codes.length) {
    const { data: orders, error: e2 } = await supabase
      .from('orders')
      .select('code, status, updated_at, created_at')
      .in('code', codes)
      .neq('status', 'dorzim')
      .limit(5000);

    if (!e2 && Array.isArray(orders)) {
      for (const o of orders) {
        const c = Number(o?.code);
        if (!Number.isFinite(c)) continue;
        const cur = activeByCode.get(c) || { active: 0, last_seen: null };
        cur.active += 1;
        const ts = o?.updated_at || o?.created_at || null;
        if (!cur.last_seen || (ts && String(ts) > String(cur.last_seen))) cur.last_seen = ts;
        activeByCode.set(c, cur);
      }
    }
  }

  function dedupeName(raw) {
    const s = String(raw || '').trim().replace(/\s+/g, ' ');
    if (!s) return '';
    const parts = s.split(' ').filter(Boolean);
    if (parts.length >= 2 && parts[parts.length - 1].toLowerCase() === parts[parts.length - 2].toLowerCase()) {
      parts.pop();
    }
    return parts.join(' ').trim();
  }

  return list.map((c) => {
    const codeStr = String(c?.code || '').trim();
    const fromFull = dedupeName(c?.full_name);
    const fromParts = dedupeName(`${c?.first_name || ''} ${c?.last_name || ''}`.trim());
    const full = fromFull || fromParts;
    const phoneFull = String(c?.phone || '');
    const phoneShort = phoneFull.replace('+383', '');
    const info = activeByCode.get(Number(c?.code)) || { active: 0, last_seen: null };
    return {
      code: codeStr,
      name: full || 'Pa Emër',
      phone: phoneShort,
      active: info.active,
      last_seen: info.last_seen,
    };
  });
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

function chipStyleForVal(v, active) {
  const n = Number(v);
  let a = 'rgba(59,130,246,0.18)', b = 'rgba(59,130,246,0.06)', br = 'rgba(59,130,246,0.35)';
  if (n >= 5.8) { a = 'rgba(249,115,22,0.20)'; b = 'rgba(249,115,22,0.08)'; br = 'rgba(249,115,22,0.38)'; } 
  else if (Math.abs(n - 3.2) < 0.051) { a = 'rgba(239,68,68,0.20)'; b = 'rgba(239,68,68,0.08)'; br = 'rgba(239,68,68,0.38)'; } 
  else if (n >= 3.5) { a = 'rgba(236,72,153,0.18)'; b = 'rgba(236,72,153,0.06)'; br = 'rgba(236,72,153,0.35)'; } 
  else if (n >= 2.2) { a = 'rgba(245,158,11,0.18)'; b = 'rgba(245,158,11,0.06)'; br = 'rgba(245,158,11,0.35)'; } 
  else { a = 'rgba(168,85,247,0.18)'; b = 'rgba(168,85,247,0.06)'; br = 'rgba(168,85,247,0.35)'; }
  return { background: `linear-gradient(180deg, ${a}, ${b})`, border: `1px solid ${br}`, outline: active ? '2px solid rgba(255,255,255,0.22)' : 'none', boxShadow: active ? '0 10px 18px rgba(0,0,0,0.32), inset 0 1px 0 rgba(255,255,255,0.18)' : '0 8px 14px rgba(0,0,0,0.26), inset 0 1px 0 rgba(255,255,255,0.14)' };
}

// ... (Draft helpers) ...
function safeJsonParse(s, f) { try { return JSON.parse(s); } catch { return f; } }
function rebuildDraftIdsByScan() { try { const ids = []; for(let i=0; i<localStorage.length; i++) { const k=localStorage.key(i); if(k.startsWith(DRAFT_ITEM_PREFIX)) ids.push(k.replace(DRAFT_ITEM_PREFIX,'')); } return ids; } catch{ return []; } }
function loadDraftIds() { const raw=localStorage.getItem(DRAFT_LIST_KEY); const arr=safeJsonParse(raw||'[]',[]); return (!arr.length) ? rebuildDraftIdsByScan() : arr; }
function saveDraftIds(ids) { localStorage.setItem(DRAFT_LIST_KEY, JSON.stringify(ids)); }
function upsertDraftLocal(d) { if(!d?.id) return; localStorage.setItem(`${DRAFT_ITEM_PREFIX}${d.id}`, JSON.stringify(d)); const ids=loadDraftIds(); if(!ids.includes(d.id)) { ids.unshift(d.id); saveDraftIds(ids); } }
function removeDraftLocal(id) { localStorage.removeItem(`${DRAFT_ITEM_PREFIX}${id}`); saveDraftIds(loadDraftIds().filter(x=>x!==id)); }
function readAllDraftsLocal() { return loadDraftIds().map(id=>safeJsonParse(localStorage.getItem(`${DRAFT_ITEM_PREFIX}${id}`), null)).filter(Boolean).sort((a,b)=>(b.ts||0)-(a.ts||0)); }

// ... (Remote helpers) ...
async function upsertDraftRemote(d) { try { if(!d?.id) return; const b=new Blob([JSON.stringify(d)],{type:'application/json'}); await supabase.storage.from(BUCKET).upload(`${DRAFTS_FOLDER}/${d.id}.json`,b,{upsert:true}); } catch{} }
async function deleteDraftRemote(id) { try { await supabase.storage.from(BUCKET).remove([`${DRAFTS_FOLDER}/${id}.json`]); } catch{} }
async function listDraftsRemote(limit = 200) { try { const { data, error } = await supabase.storage.from(BUCKET).list(DRAFTS_FOLDER, { limit }); if (error) throw error; return (data || []).filter((x) => x?.name?.endsWith('.json')); } catch { return []; } }
async function readDraftRemote(id) { try { const {data}=await supabase.storage.from(BUCKET).download(`${DRAFTS_FOLDER}/${id}.json`); if(data) return JSON.parse(await data.text()); } catch{ return null; } }
async function fetchRemoteDraftsSummary() { try { const {data}=await supabase.storage.from(BUCKET).list(DRAFTS_FOLDER,{limit:200}); if(!data) return []; const out=[]; for(const f of data) { if(!f.name.endsWith('.json')) continue; const id=f.name.replace('.json',''); const d=await readDraftRemote(id); if(d) out.push(d); } return out.sort((a,b)=>b.ts-a.ts); } catch { return []; } }

async function readSharedPrice() { try { const {data}=await supabase.storage.from(BUCKET).download(`${SETTINGS_FOLDER}/price.json`); if(data) { const j=JSON.parse(await data.text()); if(Number(j?.pricePerM2)>0) return Number(j.pricePerM2); } } catch{} return null; }
async function writeSharedPrice(v) { const b=new Blob([JSON.stringify({pricePerM2:v, at:new Date().toISOString()})],{type:'application/json'}); await supabase.storage.from(BUCKET).upload(`${SETTINGS_FOLDER}/price.json`,b,{upsert:true}); }

// ---------------- COMPONENT ----------------
export default function PranimiPage() {
  const router = useRouter();
  const phonePrefix = '+383';

  // --- SMART DEBUG STATE ---
  const [showDebug, setShowDebug] = useState(false);
  const [logs, setLogs] = useState([]);
  const debugPressTimer = useRef(null);

  function addLog(msg) {
      const t = new Date().toLocaleTimeString();
      setLogs(prev => [`[${t}] ${msg}`, ...prev]);
      console.log(`[DEBUG] ${msg}`);
  }

  function startDebugPress() {
    debugPressTimer.current = setTimeout(() => {
      setShowDebug(prev => !prev);
      if(navigator.vibrate) navigator.vibrate(50);
    }, 3000); 
  }

  function cancelDebugPress() {
    if (debugPressTimer.current) {
        clearTimeout(debugPressTimer.current);
        debugPressTimer.current = null;
    }
  }

  const [creating, setCreating] = useState(true);
  const [photoUploading, setPhotoUploading] = useState(false);
  const [savingContinue, setSavingContinue] = useState(false);

  const [oid, setOid] = useState('');
  const [codeRaw, setCodeRaw] = useState('');

  // drafts UI
  const [drafts, setDrafts] = useState([]);
  const [showDraftsSheet, setShowDraftsSheet] = useState(false);

  // client
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [clientPhotoUrl, setClientPhotoUrl] = useState('');

  // client search
  const [clientQuery, setClientQuery] = useState('');
  const [clientsIndex, setClientsIndex] = useState([]);
  const [clientHits, setClientHits] = useState([]);
  const [clientsLoading, setClientsLoading] = useState(false);

  // rows
  const [tepihaRows, setTepihaRows] = useState([]);
  const [stazaRows, setStazaRows] = useState([]);

  // shkallore
  const [stairsQty, setStairsQty] = useState(0);
  const [stairsPer, setStairsPer] = useState(SHKALLORE_M2_PER_STEP_DEFAULT);
  const [stairsPhotoUrl, setStairsPhotoUrl] = useState('');

  // pay
  const [pricePerM2, setPricePerM2] = useState(PRICE_DEFAULT);
  const [clientPaid, setClientPaid] = useState(0);
  const [arkaRecordedPaid, setArkaRecordedPaid] = useState(0);
  const [payMethod, setPayMethod] = useState('CASH');

  // sheets
  const [showPaySheet, setShowPaySheet] = useState(false);
  const [showStairsSheet, setShowStairsSheet] = useState(false);
  const [showMsgSheet, setShowMsgSheet] = useState(false);
  const [showPriceSheet, setShowPriceSheet] = useState(false);
  const [priceTmp, setPriceTmp] = useState(PRICE_DEFAULT);

  // settings
  const [autoMsgAfterSave, setAutoMsgAfterSave] = useState(true);
  const [pendingNavTo, setPendingNavTo] = useState('');
  const [payAdd, setPayAdd] = useState(0);
  const [notes, setNotes] = useState('');

  // ✅ ERRORI U RREGULLUA KËTU: Shtova variablat që mungonin
  const [todayPastrimM2, setTodayPastrimM2] = useState(0);
  const [etaText, setEtaText] = useState('GATI DITËN E 2-TË (NESËR)');

  // offline mode
  const [offlineMode, setOfflineMode] = useState(false);
  const [netState, setNetState] = useState({ ok: true, reason: '' });
  const [showOfflinePrompt, setShowOfflinePrompt] = useState(false);

  const RESET_ON_SHOW_KEY = 'tepiha_pranimi_reset_on_show_v1';

  async function resetForNewOrder() {
    try {
      const id = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `ord_${Date.now()}`;
      setOid(id);
      addLog("Getting new code...");
      const c = await reserveSharedCode(id);
      setCodeRaw(c);
      addLog(`Code reserved: ${c}`);

      setName(''); setPhone(''); setClientPhotoUrl(''); setClientQuery(''); setClientHits([]);
      setTepihaRows([]); setStazaRows([]);
      setStairsQty(0); setStairsPer(SHKALLORE_M2_PER_STEP_DEFAULT); setStairsPhotoUrl('');
      setClientPaid(0); setArkaRecordedPaid(0); setPayMethod('CASH'); setNotes('');
      setSavingContinue(false); setPhotoUploading(false);
    } catch (e) {
        addLog(`Reset Error: ${e.message}`);
    }
  }

  // --- INIT ---
  useEffect(() => {
    (async () => {
        addLog("Initializing...");
        const initOff = localStorage.getItem(OFFLINE_MODE_KEY) === '1';
        setOfflineMode(initOff);
        
        try { await refreshDrafts(); } catch {}

        try {
            const shared = await readSharedPrice();
            if (shared) setPricePerM2(shared);
        } catch {}

        try {
            const cached = Number(localStorage.getItem('capacity_today_pastrim_m2') || '0');
            const text = localStorage.getItem('capacity_eta_text');
            setTodayPastrimM2(Number.isFinite(cached) ? cached : 0);
            setEtaText(text || (cached > DAILY_CAPACITY_M2 ? 'GATI DITËN E 3-TË (MBASNESËR)' : 'GATI DITËN E 2-TË (NESËR)'));
        } catch {}

        await resetForNewOrder();
        setCreating(false);
    })();
  }, []);

  // Net check
  useEffect(() => {
    let alive = true;
    async function run() {
        if(typeof navigator !== 'undefined' && navigator.onLine === false) { setNetState({ok:false, reason:'NO_NET'}); return; }
        setNetState({ok:true, reason:''});
    }
    run();
    const t = setInterval(run, 15000);
    return () => clearInterval(t);
  }, []);

  const totalM2 = useMemo(() => computeM2FromRows(tepihaRows, stazaRows, stairsQty, stairsPer), [tepihaRows, stazaRows, stairsQty, stairsPer]);
  const totalEuro = useMemo(() => Number((totalM2 * (Number(pricePerM2) || 0)).toFixed(2)), [totalM2, pricePerM2]);
  const diff = useMemo(() => Number((totalEuro - Number(clientPaid || 0)).toFixed(2)), [totalEuro, clientPaid]);
  const currentDebt = diff > 0 ? diff : 0;
  const currentChange = diff < 0 ? Math.abs(diff) : 0;
  const copeCount = useMemo(() => {
    return tepihaRows.reduce((a, b) => a + (Number(b.qty) || 0), 0) +
           stazaRows.reduce((a, b) => a + (Number(b.qty) || 0), 0) +
           (Number(stairsQty) > 0 ? 1 : 0);
  }, [tepihaRows, stazaRows, stairsQty]);

  // Autosave
  const draftTimer = useRef(null);
  useEffect(() => {
    if (creating || !oid) return;
    if (draftTimer.current) clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => {
        const hasData = name || phone || tepihaRows.length > 0;
        if (hasData) {
            upsertDraftLocal({ id: oid, codeRaw, name, phone, tepihaRows, stazaRows, stairsQty, pricePerM2, clientPaid });
            // Sync remote too
            upsertDraftRemote({ id: oid, codeRaw, name, phone, tepihaRows, stazaRows, stairsQty, pricePerM2, clientPaid }).catch(()=>{});
        }
    }, 1000);
    return () => clearTimeout(draftTimer.current);
  }, [name, phone, tepihaRows, stazaRows, stairsQty, clientPaid, oid]);

  function addRow(kind) { const setter = kind === 'tepiha' ? setTepihaRows : setStazaRows; const prefix = kind === 'tepiha' ? 't' : 's'; setter((rows) => [...rows, { id: `${prefix}${rows.length + 1}`, m2: '', qty: '0', photoUrl: '' }]); }
  function removeRow(kind) { const setter = kind === 'tepiha' ? setTepihaRows : setStazaRows; setter((rows) => (rows.length ? rows.slice(0, -1) : rows)); }
  function handleRowChange(kind, id, field, value) { const setter = kind === 'tepiha' ? setTepihaRows : setStazaRows; setter((rows) => rows.map((r) => (r.id === id ? { ...r, [field]: value } : r))); }
  async function handleRowPhotoChange(kind, id, file) { if (!file || !oid) return; setPhotoUploading(true); try { const url = await uploadPhoto(file, oid, `${kind}_${id}`); if (url) handleRowChange(kind, id, 'photoUrl', url); } catch { alert('❌ Gabim foto!'); } finally { setPhotoUploading(false); } }
  async function handleClientPhotoChange(file) { if (!file || !oid) return; setPhotoUploading(true); try { const url = await uploadPhoto(file, oid, 'client'); if (url) setClientPhotoUrl(url); } catch { alert('❌ Gabim foto!'); } finally { setPhotoUploading(false); } }
  async function handleStairsPhotoChange(file) { if (!file || !oid) return; setPhotoUploading(true); try { const url = await uploadPhoto(file, oid, 'shkallore'); if (url) setStairsPhotoUrl(url); } catch { alert('❌ Gabim foto!'); } finally { setPhotoUploading(false); } }
  function vibrateTap(ms = 15) { try { if (typeof navigator !== 'undefined' && navigator.vibrate) navigator.vibrate(ms); } catch {} }
  function bumpEl(el) { try { if (!el) return; el.classList.remove('chip-bump'); void el.offsetWidth; el.classList.add('chip-bump'); setTimeout(() => el.classList.remove('chip-bump'), 140); } catch {} }
  function applyChip(kind, val, ev) {
    vibrateTap(15); if (ev?.currentTarget) bumpEl(ev.currentTarget);
    const setter = kind === 'tepiha' ? setTepihaRows : setStazaRows; const rows = kind === 'tepiha' ? tepihaRows : stazaRows;
    if (!rows || rows.length === 0) { const prefix = kind === 'tepiha' ? 't' : 's'; setter([{ id: `${prefix}1`, m2: String(val), qty: '1', photoUrl: '' }]); return; }
    const emptyIdx = rows.findIndex((r) => !r.m2);
    if (emptyIdx !== -1) { const nr = [...rows]; const curQty = String(nr[emptyIdx]?.qty ?? '').trim(); nr[emptyIdx] = { ...nr[emptyIdx], m2: String(val), qty: curQty && curQty !== '0' ? curQty : '1' }; setter(nr); } else { const prefix = kind === 'tepiha' ? 't' : 's'; setter([...rows, { id: `${prefix}${rows.length + 1}`, m2: String(val), qty: '1', photoUrl: '' }]); }
  }

  function openPay() { const dueNow = Number((totalEuro - Number(clientPaid || 0)).toFixed(2)); setPayAdd(dueNow > 0 ? dueNow : 0); setPayMethod("CASH"); setShowPaySheet(true); }
  function openPriceEditor() { setPriceTmp(Number(pricePerM2) || PRICE_DEFAULT); setShowPriceSheet(true); }
  async function savePriceAndClose() { const v = Number(priceTmp); if (!Number.isFinite(v) || v <= 0) { alert('Shkruaj një çmim të vlefshëm.'); return; } setPricePerM2(v); try { localStorage.setItem(PRICE_KEY, String(v)); } catch {} try { await writeSharedPrice(v); } catch {} setShowPriceSheet(false); }
  
  const payHoldTimerRef = useRef(null);
  const payHoldTriggeredRef = useRef(false);
  function startPayHold() { payHoldTriggeredRef.current = false; if (payHoldTimerRef.current) clearTimeout(payHoldTimerRef.current); payHoldTimerRef.current = setTimeout(() => { payHoldTriggeredRef.current = true; vibrateTap(25); openPriceEditor(); }, 1200); }
  function endPayHold() { if (payHoldTimerRef.current) clearTimeout(payHoldTimerRef.current); payHoldTimerRef.current = null; if (!payHoldTriggeredRef.current) openPay(); payHoldTriggeredRef.current = false; }
  function cancelPayHold() { if (payHoldTimerRef.current) clearTimeout(payHoldTimerRef.current); payHoldTimerRef.current = null; payHoldTriggeredRef.current = false; }

  async function applyPayAndClose() {
    const cashGiven = Number((Number(payAdd) || 0).toFixed(2)); if (cashGiven <= 0) { alert('SHUMA NUK VLEN (0 €).'); return; }
    const due = Math.max(0, Number((Number(totalEuro || 0) - Number(clientPaid || 0)).toFixed(2))); const applied = Number(Math.min(cashGiven, due).toFixed(2)); if (applied <= 0) { alert(due <= 0 ? "KJO POROSI ESHTE PAGUAR." : 'SHUMA NUK VLEN.'); return; }
    const newPaid = Number((Number(clientPaid || 0) + applied).toFixed(2)); setClientPaid(newPaid);
    if (payMethod === 'CASH') {
      const actor = (() => { try { const raw = localStorage.getItem('CURRENT_USER_DATA'); return raw ? JSON.parse(raw) : null; } catch { return null; } })();
      const extId = `pay_${oid}_${Date.now()}`;
      await recordCashMove({ externalId: extId, orderId: oid, code: normalizeCode(codeRaw), name: name.trim(), amount: applied, note: `PAGESA ${applied}€ • #${normalizeCode(codeRaw)} • ${name.trim()}`, source: 'ORDER_PAY', method: 'cash_pay', type: 'IN', createdByPin: (actor?.pin ? String(actor.pin) : (getActor()?.pin ? String(getActor().pin) : null)), createdBy: (actor?.name ? String(actor.name) : (getActor()?.name ? String(getActor().name) : null)) });
      const finalArka = Number((Number(arkaRecordedPaid || 0) + applied).toFixed(2)); setArkaRecordedPaid(finalArka);
    }
    setShowPaySheet(false);
  }

  function validateBeforeContinue() {
    if (!name.trim()) return alert('Shkruaj emrin dhe mbiemrin.'), false;
    const ph = sanitizePhone(phonePrefix + phone);
    if (!ph || ph.length < 6) return alert('Shkruaj një numër telefoni të vlefshëm.'), false;
    if (totalM2 <= 0) return alert('Shto të paktën 1 m².'), false;
    return true;
  }

  function saveOfflineQueueItem(order) { try { const raw = localStorage.getItem(OFFLINE_QUEUE_KEY); const list = raw ? JSON.parse(raw) : []; const item = { local_id: order?.id || `offline_${Date.now()}`, created_at: new Date().toISOString(), name: order?.client?.name || '', phone: order?.client?.phone || '', code: order?.client?.code || '', pieces: Number(order?.tepiha?.reduce((s, r) => s + (Number(r.qty) || 0), 0) || 0) + Number(order?.staza?.reduce((s, r) => s + (Number(r.qty) || 0), 0) || 0) + Number(order?.shkallore?.qty || 0), total: Number(order?.pay?.euro || 0), paid: Number(order?.pay?.paid || 0), debt: Number(order?.pay?.debt || 0), status: 'OFFLINE', order, synced: false }; list.unshift(item); localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(list.slice(0, 2000))); return true; } catch { return false; } }

  async function handleContinue() {
    addLog("--- START HANDLE CONTINUE ---");
    if (!validateBeforeContinue()) { addLog("Validation Failed"); return; }
    if (savingContinue) return;
    setSavingContinue(true);
    addLog("Processing order object...");

    try {
      const order = {
        id: oid, ts: Date.now(), status: 'pastrim',
        client: { name: name.trim(), phone: phonePrefix + (phone || ''), code: normalizeCode(codeRaw), photoUrl: clientPhotoUrl || '' },
        tepiha: tepihaRows.map((r) => ({ m2: Number(r.m2) || 0, qty: Number(r.qty) || 0, photoUrl: r.photoUrl || '' })),
        staza: stazaRows.map((r) => ({ m2: Number(r.m2) || 0, qty: Number(r.qty) || 0, photoUrl: r.photoUrl || '' })),
        shkallore: { qty: Number(stairsQty) || 0, per: Number(stairsPer) || 0, photoUrl: stairsPhotoUrl || '' },
        pay: { m2: totalM2, rate: Number(pricePerM2) || PRICE_DEFAULT, euro: totalEuro, paid: Number((Number(clientPaid) || 0).toFixed(2)), debt: currentDebt, method: payMethod, arkaRecordedPaid: Number((Number(arkaRecordedPaid) || 0).toFixed(2)) },
        notes: notes || '',
      };

      if (offlineMode) {
        addLog("Offline mode active. Saving locally.");
        saveOfflineQueueItem(order);
        alert('✅ U RUAJT OFFLINE.');
        setSavingContinue(false);
        return;
      }

      addLog("Sending to saveOrderToDb...");
      const db = await saveOrderToDb(order);
      addLog(`DB Save Result: ${JSON.stringify(db)}`);

      try { await markCodeUsed(codeRaw, oid); } catch {}
      try { removeDraftLocal(oid); } catch {}

      if (autoMsgAfterSave) {
        setPendingNavTo('/pastrimi');
        setShowMsgSheet(true);
        setSavingContinue(false);
        return;
      }

      setSavingContinue(false);
      router.push('/pastrimi');
    } catch (e) {
      console.error(e);
      const msg = e.message || JSON.stringify(e);
      addLog(`ERROR CATCH: ${msg}`);
      
      let userMsg = `❌ RUJTJA DËSHTOI: ${msg}`;
      if (msg.includes("duplicate key") || msg.includes("clients_phone_uniq")) {
          userMsg = "❌ Numri i telefonit ekziston te një klient tjetër!\n(Sistemi s'mund ta krijojë klientin e ri me këtë numër).";
          addLog("DIAGNOSIS: Duplicate phone number in clients table.");
      }
      alert(userMsg);
      setSavingContinue(false);
    }
  }

  function openDrafts() { void refreshDrafts(); setShowDraftsSheet(true); }
  async function loadDraftIntoForm(id) {
    try { let d = await readDraftRemote(id); if (!d) { const raw = localStorage.getItem(`${DRAFT_ITEM_PREFIX}${id}`); if (!raw) return; d = JSON.parse(raw); }
      setOid(d.id || id); setCodeRaw(d.codeRaw || d.code || codeRaw); setName(d.name || ''); setPhone(d.phone || ''); setClientPhotoUrl(d.clientPhotoUrl || '');
      setTepihaRows(Array.isArray(d.tepihaRows) && d.tepihaRows.length ? d.tepihaRows.map((r) => ({ ...r, qty: String(r?.qty ?? '0') })) : []);
      setStazaRows(Array.isArray(d.stazaRows) && d.stazaRows.length ? d.stazaRows.map((r) => ({ ...r, qty: String(r?.qty ?? '0') })) : []);
      setStairsQty(Number(d.stairsQty) || 0); setStairsPer(Number(d.stairsPer) || SHKALLORE_M2_PER_STEP_DEFAULT); setStairsPhotoUrl(d.stairsPhotoUrl || '');
      setPricePerM2(Number(d.pricePerM2) || PRICE_DEFAULT); setClientPaid(Number(d.clientPaid) || 0); setArkaRecordedPaid(Number(d.arkaRecordedPaid) || 0); setPayMethod(d.payMethod || 'CASH'); setNotes(d.notes || ''); setShowDraftsSheet(false);
    } catch {}
  }
  async function deleteDraft(id) { removeDraftLocal(id); await deleteDraftRemote(id); await refreshDrafts(); }

  function buildStartMessage() {
    const kod = normalizeCode(codeRaw); const m2 = Number(totalM2 || 0).toFixed(2); const euro = Number(totalEuro || 0).toFixed(2); const debt = Number(currentDebt || 0).toFixed(2);
    const debtLine = Number(currentDebt || 0) > 0 ? `BORXH: ${debt} €.` : `BORXH: 0.00 €.`; const nm = (name || '').trim() ? `Përshëndetje ${name.trim()},` : 'Përshëndetje,';
    return [`${nm} procesi i pastrimit ka filluar.`, `KODI: ${kod} • TEPIHA: ${copeCount} COPË • ${m2} m² • TOTAL: ${euro} €.`, debtLine, `SIPAS KAPACITETIT: ${etaText}.`, `DO T'JU LAJMËROJMË KUR BËHEN GATI.`, `NËSE KENI PYTJE THIRR ${COMPANY_PHONE_DISPLAY}.`].join('\n');
  }
  function openLinkSafe(url) { try { window.location.href = url; } catch {} }
  function sendViaSMS() { const to = sanitizePhone(phonePrefix + phone); const body = encodeURIComponent(buildStartMessage()); if (!to) return alert('Shkruaj numrin e klientit.'); openLinkSafe(`sms:${to}?&body=${body}`); }
  function sendViaWhatsApp() { const to = sanitizePhone(phonePrefix + phone); const text = encodeURIComponent(buildStartMessage()); if (!to) return alert('Shkruaj numrin e klientit.'); openLinkSafe(`https://wa.me/${to}?text=${text}`); }
  function sendViaViber() { const to = sanitizePhone(phonePrefix + phone); if (!to) return alert('Shkruaj numrin e klientit.'); openLinkSafe(`viber://chat?number=%2B${to}`); try { navigator.clipboard?.writeText(buildStartMessage()); } catch {} setTimeout(() => { alert('Mesazhi u kopjua. Hap Viber dhe paste te klienti.'); }, 120); }
  function closeMsgSheet() { setShowMsgSheet(false); if (pendingNavTo) { const next = pendingNavTo; setPendingNavTo(''); router.push(next); } }
  function toggleAutoMsg() { const next = !autoMsgAfterSave; setAutoMsgAfterSave(next); try { localStorage.setItem(AUTO_MSG_KEY, next ? '1' : '0'); } catch {} }

  if (creating) { return (<div className="wrap"><p style={{ textAlign: 'center', paddingTop: 30 }}>Duke u përgatitur PRANIMI...</p></div>); }

  return (
    <div className="wrap" style={{paddingBottom: 200}}>
      {/* HEADER */}
      <header className="header-row" style={{ alignItems: 'flex-start' }}>
        <div><h1 className="title">PRANIMI</h1><div className="subtitle">KRIJO POROSI</div></div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end' }}>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer', userSelect: 'none' }}>
            <input type="checkbox" checked={offlineMode} onChange={(e) => { const v = e.target.checked; setOfflineMode(v); try { localStorage.setItem(OFFLINE_MODE_KEY, v ? '1' : '0'); } catch {} }} />
            <span style={{ fontWeight: 900, letterSpacing: 0.5 }}>OFFLINE MODE</span>
          </label>
          <div style={{ fontSize: 12, opacity: 0.75 }}>{netState.ok ? 'ONLINE' : `LIDHJA: ${netState.reason}`}</div>
        </div>
        
        {/* ✅ TRIGGER PËR DOKTORIN: Long Press 3s */}
        <div 
            className="code-badge"
            onMouseDown={startDebugPress}
            onTouchStart={startDebugPress}
            onMouseUp={cancelDebugPress}
            onTouchEnd={cancelDebugPress}
            onMouseLeave={cancelDebugPress}
        >
          <span className="badge">{`KODI: ${normalizeCode(codeRaw)}`}</span>
        </div>
      </header>

      {/* Capacity & Drafts Button (unchanged) */}
      <section className="cap-mini">
        <div className="cap-mini-top"><div className="cap-mini-title">SOT NË PASTRIM</div><div className="cap-mini-val">{Number(todayPastrimM2 || 0).toFixed(1)} m²</div></div>
        <div className="cap-mini-eta">{etaText}</div>
      </section>
      <section style={{ marginTop: 10 }}>
        <button type="button" className="btn secondary" style={{ width: '100%', padding: '12px 14px', borderRadius: 18 }} onClick={openDrafts}>📝 TË PA PLOTSUARAT {drafts.length > 0 ? `(${drafts.length})` : ''}</button>
      </section>

      {/* CLIENT Section (unchanged) */}
      <section className="card">
        <h2 className="card-title">KLIENTI</h2>
        <div className="field-group">
          <label className="label">KËRKO KLIENTIN (KOD / EMËR / TELEFON)</label>
          <input className="input" value={clientQuery} onChange={(e) => setClientQuery(e.target.value)} placeholder="p.sh. 98 / arben / 045..." />
          {clientsLoading ? (<div style={{ fontSize: 10, opacity: 0.7, marginTop: 6 }}>DUKE NGARKUAR KLIENTËT...</div>) : null}
          {clientHits && clientHits.length ? (
            <div className="list" style={{ marginTop: 8, maxHeight: 180, overflow: 'auto' }}>
              {clientHits.map((c) => (
                <button key={`${c.code}_${c.phone}`} type="button" className="rowbtn" onClick={() => { if (c.code != null) setCodeRaw(String(c.code)); if (c.name) setName(String(c.name)); setPhone(String(c.phone || '').replace(/\D/g,'')); setClientQuery(''); setClientHits([]); }} style={{ width: '100%', textAlign: 'left', padding: '10px 12px', borderRadius: 12, marginBottom: 8 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}><div style={{ fontWeight: 800 }}>{String(c.code || '')} • {String(c.name || '').toLowerCase()}</div><div style={{ opacity: 0.85 }}>{String(c.phonePrefix || '')}{String(c.phone || '')}</div></div>
                </button>
              ))}
            </div>
          ) : null}
        </div>
        <div className="field-group">
          <label className="label">EMRI & MBIEMRI</label>
          <div className="row" style={{ alignItems: 'center', gap: 10 }}>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} style={{ flex: 1 }} />
            {clientPhotoUrl ? <img src={clientPhotoUrl} alt="" className="client-mini" /> : null}
            <label className="camera-btn" title="FOTO KLIENTI" style={{ marginLeft: 2 }}>📷<input type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => handleClientPhotoChange(e.target.files?.[0])} /></label>
          </div>
          {clientPhotoUrl && (<button className="btn secondary" style={{ display: 'block', fontSize: 10, padding: '4px 8px', marginTop: 8 }} onClick={() => setClientPhotoUrl('')}>🗑️ FSHI FOTO</button>)}
        </div>
        <div className="field-group"><label className="label">TELEFONI</label><div className="row"><input className="input small" value={phonePrefix} readOnly /><input className="input" value={phone} onChange={(e) => setPhone(e.target.value)} /></div></div>
      </section>

      {/* TEPIHA & STAZA Sections (unchanged) */}
      <section className="card">
        <h2 className="card-title">TEPIHA</h2>
        <div className="chip-row modern">{TEPIHA_CHIPS.map((v) => (<button key={v} type="button" className="chip chip-modern" onClick={(e) => applyChip('tepiha', v, e)} style={chipStyleForVal(v, false)}>{v.toFixed(1)}</button>))}</div>
        {tepihaRows.map((row) => (<div className="piece-row" key={row.id}><div className="row"><input className="input small" type="number" value={row.m2} onChange={(e) => handleRowChange('tepiha', row.id, 'm2', e.target.value)} placeholder="m²" /><input className="input small" type="number" value={row.qty} onChange={(e) => handleRowChange('tepiha', row.id, 'qty', e.target.value)} placeholder="copë" /><label className="camera-btn">📷<input type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => handleRowPhotoChange('tepiha', row.id, e.target.files?.[0])} /></label></div>{row.photoUrl && (<div style={{ marginTop: 8 }}><img src={row.photoUrl} className="photo-thumb" alt="" /><button className="btn secondary" style={{ display: 'block', fontSize: 10, padding: '4px 8px', marginTop: 4 }} onClick={() => handleRowChange('tepiha', row.id, 'photoUrl', '')}>🗑️ FSHI FOTO</button></div>)}</div>))}
        <div className="row btn-row"><button className="btn secondary" onClick={() => addRow('tepiha')}>+ RRESHT</button><button className="btn secondary" onClick={() => removeRow('tepiha')}>− RRESHT</button></div>
      </section>

      <section className="card">
        <h2 className="card-title">STAZA</h2>
        <div className="chip-row modern">{STAZA_CHIPS.map((v) => (<button key={v} type="button" className="chip chip-modern" onClick={(e) => applyChip('staza', v, e)} style={chipStyleForVal(v, false)}>{v.toFixed(1)}</button>))}</div>
        {stazaRows.map((row) => (<div className="piece-row" key={row.id}><div className="row"><input className="input small" type="number" value={row.m2} onChange={(e) => handleRowChange('staza', row.id, 'm2', e.target.value)} placeholder="m²" /><input className="input small" type="number" value={row.qty} onChange={(e) => handleRowChange('staza', row.id, 'qty', e.target.value)} placeholder="copë" /><label className="camera-btn">📷<input type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => handleRowPhotoChange('staza', row.id, e.target.files?.[0])} /></label></div>{row.photoUrl && (<div style={{ marginTop: 8 }}><img src={row.photoUrl} className="photo-thumb" alt="" /><button className="btn secondary" style={{ display: 'block', fontSize: 10, padding: '4px 8px', marginTop: 4 }} onClick={() => handleRowChange('staza', row.id, 'photoUrl', '')}>🗑️ FSHI FOTO</button></div>)}</div>))}
        <div className="row btn-row"><button className="btn secondary" onClick={() => addRow('staza')}>+ RRESHT</button><button className="btn secondary" onClick={() => removeRow('staza')}>− RRESHT</button></div>
      </section>

      {/* UTIL, NOTES, FOOTER (unchanged) */}
      <section className="card">
        <div className="row util-row" style={{ gap: 10 }}><button className="btn secondary" style={{ flex: 1 }} onClick={() => setShowStairsSheet(true)}>🪜 SHKALLORE</button><button className="btn secondary" style={{ flex: 1 }} onMouseDown={startPayHold} onMouseUp={endPayHold} onMouseLeave={cancelPayHold} onTouchStart={(e) => { e.preventDefault(); startPayHold(); }} onTouchEnd={(e) => { e.preventDefault(); endPayHold(); }} onTouchCancel={cancelPayHold}>€ PAGESA</button></div>
        <div style={{ marginTop: 10 }}><button className="btn secondary" style={{ width: '100%' }} onClick={() => setShowMsgSheet(true)}>📩 DËRGO MESAZH — FILLON PASTRIMI</button></div>
        <div className="tot-line">M² Total: <strong>{totalM2}</strong></div><div className="tot-line">Copë: <strong>{copeCount}</strong></div><div className="tot-line">Total: <strong>{totalEuro.toFixed(2)} €</strong></div><div className="tot-line" style={{ borderTop: '1px solid rgba(255,255,255,0.08)', marginTop: 10, paddingTop: 10 }}>Paguar: <strong style={{ color: '#16a34a' }}>{Number(clientPaid || 0).toFixed(2)} €</strong></div>
        <div className="tot-line" style={{ fontSize: 12, color: 'rgba(255,255,255,0.65)' }}>Regjistru n&apos;ARKË: <strong>{Number(arkaRecordedPaid || 0).toFixed(2)} €</strong></div>
        {currentDebt > 0 && <div className="tot-line">Borxh: <strong style={{ color: '#dc2626' }}>{currentDebt.toFixed(2)} €</strong></div>}{currentChange > 0 && <div className="tot-line">Kthim: <strong style={{ color: '#2563eb' }}>{currentChange.toFixed(2)} €</strong></div>}
      </section>
      <section className="card"><h2 className="card-title">SHËNIME</h2><textarea className="input" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} /></section>
      <footer className="footer-bar"><button className="btn secondary" onClick={() => router.push('/')}>🏠 HOME</button><button className="btn primary" onClick={handleContinue} disabled={photoUploading || savingContinue}>{savingContinue ? '⏳ DUKE RUJT...' : '▶ VAZHDO'}</button></footer>

      {/* ✅ DOKTORI (DEBUG BOX) - Hapet vetëm me long press te kodi */}
      {showDebug && (
        <div style={{background: '#000', color: '#0f0', padding: 10, fontSize: 10, fontFamily: 'monospace', maxHeight: 200, overflow: 'auto', borderTop: '1px solid #333', marginTop: 20}}>
            <div style={{fontWeight: 'bold', borderBottom: '1px solid #333', marginBottom: 5, display: 'flex', justifyContent: 'space-between'}}>
                <span>LOGU I DIAGNOSTIKIMIT:</span>
                <button onClick={()=>setShowDebug(false)} style={{color:'#fff', fontWeight:'bold'}}>X</button>
            </div>
            {logs.length === 0 ? <div style={{opacity:0.5}}>...Duke pritur veprim...</div> : logs.map((l, i) => <div key={i}>{l}</div>)}
        </div>
      )}

      {/* SHEETS (FIXED UI) */}
      {showDraftsSheet && (<div className="payfs"><div className="payfs-top"><div><div className="payfs-title">TË PA PLOTSUARAT</div><div className="payfs-sub">HAP ose FSHI draftat</div></div><button className="btn secondary" onClick={() => setShowDraftsSheet(false)}>✕</button></div><div className="payfs-body"><div className="card" style={{ marginTop: 0 }}>{drafts.length === 0 ? (<div style={{ textAlign: 'center', padding: '18px 0', color: 'rgba(255,255,255,0.7)' }}>S’ka “të pa plotsuara”.</div>) : (drafts.map((d) => (<div key={d.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 4px', borderBottom: '1px solid rgba(255,255,255,0.08)' }}><div style={{ display: 'flex', gap: 10, alignItems: 'center' }}><div style={{ background: '#16a34a', color: '#0b0b0b', padding: '8px 10px', borderRadius: 10, fontWeight: 900, minWidth: 56, textAlign: 'center' }}>{d.code || '—'}</div><div style={{ fontSize: 12, color: 'rgba(255,255,255,0.8)' }}><div style={{ fontWeight: 800 }}>KODI: {d.code || '—'}</div><div style={{ opacity: 0.85 }}>{Number(d.m2 || 0).toFixed(2)} m² • {Number(d.euro || 0).toFixed(2)} €</div></div></div><div style={{ display: 'flex', gap: 10 }}><button className="btn secondary" onClick={() => loadDraftIntoForm(d.id)}>HAP</button><button className="btn secondary" onClick={() => deleteDraft(d.id)}>FSHI</button></div></div>)))}</div><div style={{ height: 14 }} /><button className="btn secondary" style={{ width: '100%' }} onClick={() => setShowDraftsSheet(false)}>MBYLL</button></div></div>)}
      {showMsgSheet && (<div className="payfs"><div className="payfs-top"><div><div className="payfs-title">DËRGO MESAZH</div><div className="payfs-sub">VIBER / WHATSAPP / SMS</div></div><button className="btn secondary" onClick={closeMsgSheet}>✕</button></div><div className="payfs-body"><div className="card" style={{ marginTop: 0 }}><div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}><div style={{ fontSize: 12, color: 'rgba(255,255,255,0.8)', fontWeight: 900 }}>AUTO PAS “VAZHDO”</div><button className="btn secondary" style={{ padding: '6px 10px', fontSize: 11, borderRadius: 12 }} onClick={toggleAutoMsg}>{autoMsgAfterSave ? 'ON' : 'OFF'}</button></div><div className="tot-line" style={{ fontSize: 12, color: 'rgba(255,255,255,0.8)', marginTop: 10 }}><strong>PREVIEW</strong></div><pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', marginTop: 10, fontSize: 12, color: 'rgba(255,255,255,0.85)', lineHeight: 1.35 }}>{buildStartMessage()}</pre></div><div className="card"><div className="row" style={{ gap: 10 }}><button className="btn secondary" style={{ flex: 1 }} onClick={sendViaViber}>VIBER</button><button className="btn secondary" style={{ flex: 1 }} onClick={sendViaWhatsApp}>WHATSAPP</button><button className="btn secondary" style={{ flex: 1 }} onClick={sendViaSMS}>SMS</button></div><div style={{ marginTop: 12, fontSize: 12, color: 'rgba(255,255,255,0.65)' }}>* Numri i kompanisë në fund: {COMPANY_PHONE_DISPLAY}</div></div><button className="btn secondary" style={{ width: '100%' }} onClick={closeMsgSheet}>MBYLL</button></div></div>)}
      {showPriceSheet && (<div className="payfs"><div className="payfs-top"><div><div className="payfs-title">NDËRRO QMIMIN</div><div className="payfs-sub">€/m² (ruhet & sinkronizohet)</div></div><button className="btn secondary" onClick={() => setShowPriceSheet(false)}>✕</button></div><div className="payfs-body"><div className="card" style={{ marginTop: 0 }}><div className="tot-line">QMIMI AKTUAL: <strong>{Number(pricePerM2 || 0).toFixed(2)} € / m²</strong></div><div style={{ height: 10 }} /><label className="label">QMIMI I RI (€ / m²)</label><input type="number" step="0.1" className="input" value={priceTmp} onChange={(e) => setPriceTmp(e.target.value === '' ? '' : Number(e.target.value))} /><div style={{ marginTop: 10, fontSize: 12, color: 'rgba(255,255,255,0.65)' }}>* Long-press 3 sek te “€ PAGESA” për me ardh këtu.</div></div></div><div className="payfs-footer"><button className="btn secondary" onClick={() => setShowPriceSheet(false)}>ANULO</button><button className="btn primary" onClick={savePriceAndClose}>RUJ</button></div></div>)}
      {showPaySheet && (<div className="payfs"><div className="payfs-top"><div><div className="payfs-title">PAGESA</div><div className="payfs-sub">KODI: {normalizeCode(codeRaw)} • {name || '—'}</div></div><button className="btn secondary" onClick={() => setShowPaySheet(false)}>✕</button></div><div className="payfs-body"><div className="card" style={{ marginTop: 0 }}><div className="tot-line">TOTAL: <strong>{totalEuro.toFixed(2)} €</strong></div><div className="tot-line">PAGUAR DERI TANI: <strong style={{ color: '#16a34a' }}>{Number(clientPaid || 0).toFixed(2)} €</strong></div><div className="tot-line" style={{ fontSize: 12, color: '#666' }}>REGJISTRU N&apos;ARKË DERI TANI: <strong>{Number(arkaRecordedPaid || 0).toFixed(2)} €</strong></div><div className="tot-line" style={{ borderTop: '1px solid #eee', marginTop: 10, paddingTop: 10 }}>SOT PAGUAN: <strong>{Number(payAdd || 0).toFixed(2)} €</strong></div>{(() => { const dueNow = Number((totalEuro - Number(clientPaid || 0)).toFixed(2)); const dueSafe = dueNow > 0 ? dueNow : 0; const given = Number((Number(payAdd || 0)).toFixed(2)); const applied = Number((Math.min(given, dueSafe)).toFixed(2)); const paidAfter = Number((Number(clientPaid || 0) + applied).toFixed(2)); const debtNow = Number((totalEuro - paidAfter).toFixed(2)); const debtSafe = debtNow > 0 ? debtNow : 0; const changeNow = given > dueSafe ? Number((given - dueSafe).toFixed(2)) : 0; return (<><div className="tot-line">NË SISTEM REGJISTROHET: <strong>{applied.toFixed(2)} €</strong></div><div className="tot-line">PAGUAR PAS KËSAJ: <strong style={{ color: '#16a34a' }}>{paidAfter.toFixed(2)} €</strong></div>{debtSafe > 0 && (<div className="tot-line">BORXH: <strong style={{ color: '#dc2626' }}>{debtSafe.toFixed(2)} €</strong></div>)}{changeNow > 0 && (<div className="tot-line">KTHIM: <strong style={{ color: '#2563eb' }}>{changeNow.toFixed(2)} €</strong></div>)}</>); })()}</div><div className="card"><div className="field-group"><label className="label">KLIENTI DHA (€)</label><input type="text" inputMode="decimal" pattern="[0-9]*" className="input" value={Number(payAdd || 0) === 0 ? '' : payAdd} onChange={(e) => { const v = e.target.value; setPayAdd(v === '' ? 0 : Number(v)); }} placeholder="" /><div className="chip-row" style={{ marginTop: 10 }}>{PAY_CHIPS.map((v) => (<button key={v} className="chip" type="button" onClick={() => setPayAdd(v)}>{v}€</button>))}<button className="chip" type="button" onClick={() => setPayAdd(0)} style={{ opacity: 0.9 }}>FSHI</button></div></div><div style={{ fontSize: 12, color: "#666", marginTop: 8 }}>* CASH VETËM — pagesa regjistrohet në ARKË (ose WAITING kur ARKA është e mbyllur).</div></div></div><div className="payfs-footer"><button className="btn secondary" onClick={() => setShowPaySheet(false)}>ANULO</button><button className="btn primary" onClick={applyPayAndClose}>RUJ PAGESËN</button></div></div>)}
      {showStairsSheet && (<div className="modal-overlay" onClick={() => setShowStairsSheet(false)}><div className="modal-content dark" onClick={(e) => e.stopPropagation()}><div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}><h3 className="card-title" style={{ margin: 0, color: '#fff' }}>SHKALLORE</h3><button className="btn secondary" onClick={() => setShowStairsSheet(false)}>✕</button></div><div className="field-group" style={{ marginTop: 12 }}><label className="label" style={{ color: 'rgba(255,255,255,0.8)' }}>COPE</label><div className="chip-row">{SHKALLORE_QTY_CHIPS.map((n) => (<button key={n} className="chip" type="button" onClick={() => { setStairsQty(n); vibrateTap(15); }} style={Number(stairsQty) === n ? { outline: '2px solid rgba(255,255,255,0.35)' } : null}>{n}</button>))}</div><input type="number" className="input" value={stairsQty === 0 ? '' : stairsQty} onChange={(e) => { const v = e.target.value; setStairsQty(v === '' ? 0 : Number(v)); }} placeholder="" style={{ marginTop: 10 }} /></div><div className="field-group"><label className="label" style={{ color: 'rgba(255,255,255,0.8)' }}>m² PËR COPË</label><div className="chip-row">{SHKALLORE_PER_CHIPS.map((v) => (<button key={v} className="chip" type="button" onClick={() => { setStairsPer(v); vibrateTap(15); }} style={Number(stairsPer) === v ? { outline: '2px solid rgba(255,255,255,0.35)' } : null}>{v}</button>))}</div><input type="number" step="0.01" className="input" value={Number(stairsPer || 0) === 0 ? '' : stairsPer} onChange={(e) => { const v = e.target.value; setStairsPer(v === '' ? 0 : Number(v)); }} style={{ marginTop: 10 }} /></div><div className="field-group"><label className="label" style={{ color: 'rgba(255,255,255,0.8)' }}>FOTO</label><label className="camera-btn">📷<input type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => handleStairsPhotoChange(e.target.files?.[0])} /></label>{stairsPhotoUrl && (<div style={{ marginTop: 8 }}><img src={stairsPhotoUrl} className="photo-thumb" alt="" /><button className="btn secondary" style={{ display: 'block', fontSize: 10, padding: '4px 8px', marginTop: 4 }} onClick={() => setStairsPhotoUrl('')}>🗑️ FSHI FOTO</button></div>)}</div><button className="btn primary" style={{ width: '100%', marginTop: 12 }} onClick={() => setShowStairsSheet(false)}>MBYLL</button></div></div>)}

      <style jsx>{`
        .client-mini{ width: 34px; height: 34px; border-radius: 999px; object-fit: cover; border: 1px solid rgba(255,255,255,0.18); box-shadow: 0 6px 14px rgba(0,0,0,0.35); }
        .cap-mini { margin-top: 8px; padding: 10px 12px; border-radius: 16px; background: #0b0b0b; border: 1px solid rgba(255,255,255,0.1); }
        .cap-mini-top { display: flex; justifyContent: space-between; alignItems: baseline; }
        .cap-mini-title { font-size: 10px; letter-spacing: 0.7px; color: rgba(255,255,255,0.65); font-weight: 900; }
        .cap-mini-val { font-size: 12px; color: #16a34a; font-weight: 900; }
        .cap-mini-eta { margin-top: 6px; font-size: 12px; color: rgba(255,255,255,0.85); font-weight: 800; }
        .chip-row.modern { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
        .chip-modern { padding: 10px 14px; border-radius: 14px; font-weight: 900; letter-spacing: 0.2px; color: rgba(255,255,255,0.92); backdrop-filter: blur(8px); }
        .chip-modern:active { transform: translateY(1px); }
        .chip-bump { animation: chipBump 140ms ease-in-out; }
        @keyframes chipBump { 0% { transform: translateY(0) scale(1); } 40% { transform: translateY(1px) scale(0.98); } 70% { transform: translateY(0) scale(1.02); } 100% { transform: translateY(0) scale(1); } }
        .modal-overlay { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.6); display: flex; alignItems: center; justifyContent: center; z-index: 9999; padding: 20px; }
        .modal-content { width: 100%; max-width: 420px; padding: 18px; border-radius: 18px; box-shadow: 0 10px 25px rgba(0, 0, 0, 0.35); background: white; }
        .modal-content.dark { background: #0b0b0b; color: #fff; border: 1px solid rgba(255, 255, 255, 0.1); }
        .payfs { position: fixed; inset: 0; background: #0b0b0b; z-index: 10000; display: flex; flexDirection: column; }
        .payfs-top { display: flex; justifyContent: space-between; alignItems: center; padding: 14px 14px; background: #0b0b0b; border-bottom: 1px solid rgba(255, 255, 255, 0.08); }
        .payfs-title { color: #fff; font-weight: 900; font-size: 18px; }
        .payfs-sub { color: rgba(255, 255, 255, 0.7); font-size: 12px; margin-top: 2px; }
        .payfs-body { flex: 1; overflow: auto; padding: 14px; }
        .payfs-footer { display: flex; gap: 10px; padding: 12px 14px; border-top: 1px solid rgba(255, 255, 255, 0.08); background: #0b0b0b; }
        .payfs-footer .btn { flex: 1; }
      `}</style>
    </div>
  );
}
