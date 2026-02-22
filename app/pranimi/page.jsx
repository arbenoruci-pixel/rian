"use client";

import {
  computeM2FromRows,
  normalizeCode,
  reserveSharedCode,
  markCodeUsed,
  releaseLocksForCode,
} from '@/lib/baseCodes';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient';
import { saveOrderLocal, pushOp } from '@/lib/offlineStore';
import { fetchOrdersFromDb, fetchClientsFromDb, saveOrderToDb } from '@/lib/ordersDb';
import { recordCashMove } from '@/lib/arkaCashSync';
import { getActor } from '@/lib/actorSession';

const BUCKET = 'tepiha-photos';

const TEPIHA_CHIPS = [2.0, 2.5, 3.0, 3.2, 3.5, 3.7, 6.0];
const STAZA_CHIPS = [1.5, 2.0, 2.2, 3.0];

// SHKALLORE CHIPS (same vibe as Pastrimi)
const SHKALLORE_QTY_CHIPS = [5, 10, 15, 20, 25, 30];
const SHKALLORE_PER_CHIPS = [0.25, 0.3, 0.35, 0.4];

const SHKALLORE_M2_PER_STEP_DEFAULT = 0.3;
const PRICE_DEFAULT = 3.0;

// PAGESA CHIPS (same as Pastrmi)
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
// Extend the lease for 10 years (in minutes).
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
    // search by code OR phone digits OR name
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
    // Fix common typo: "oruci oruci" -> "oruci"
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

// ---------- Code reserve (migrimi) ----------
// extractDigitsFromFilename() u la këtu sepse përdoret për migrime të fotove/legacy.
function extractDigitsFromFilename(name) {
  if (!name) return null;
  const m = String(name).match(/\d+/);
  if (!m) return null;
  return parseInt(m[0], 10);
}


// ---------- Modern chip colors ----------
function chipStyleForVal(v, active) {
  const n = Number(v);

  let a = 'rgba(59,130,246,0.18)'; // blue
  let b = 'rgba(59,130,246,0.06)';
  let br = 'rgba(59,130,246,0.35)';

  if (n >= 5.8) {
    a = 'rgba(249,115,22,0.20)'; // orange
    b = 'rgba(249,115,22,0.08)';
    br = 'rgba(249,115,22,0.38)';
  } else if (Math.abs(n - 3.2) < 0.051) {
    a = 'rgba(239,68,68,0.20)'; // red (3.2)
    b = 'rgba(239,68,68,0.08)';
    br = 'rgba(239,68,68,0.38)';
  } else if (n >= 3.5) {
    a = 'rgba(236,72,153,0.18)'; // pink
    b = 'rgba(236,72,153,0.06)';
    br = 'rgba(236,72,153,0.35)';
  } else if (n >= 2.2) {
    a = 'rgba(245,158,11,0.18)'; // amber
    b = 'rgba(245,158,11,0.06)';
    br = 'rgba(245,158,11,0.35)';
  } else {
    a = 'rgba(168,85,247,0.18)'; // purple
    b = 'rgba(168,85,247,0.06)';
    br = 'rgba(168,85,247,0.35)';
  }

  return {
    background: `linear-gradient(180deg, ${a}, ${b})`,
    border: `1px solid ${br}`,
    outline: active ? '2px solid rgba(255,255,255,0.22)' : 'none',
    boxShadow: active
      ? '0 10px 18px rgba(0,0,0,0.32), inset 0 1px 0 rgba(255,255,255,0.18)'
      : '0 8px 14px rgba(0,0,0,0.26), inset 0 1px 0 rgba(255,255,255,0.14)',
  };
}

// ---------- DRAFT LOCAL HELPERS ----------
function safeJsonParse(s, fallback) {
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

function rebuildDraftIdsByScan() {
  try {
    const ids = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k) continue;
      if (k.startsWith(DRAFT_ITEM_PREFIX)) {
        const id = k.replace(DRAFT_ITEM_PREFIX, '');
        if (id) ids.push(id);
      }
    }
    const list = [];
    for (const id of ids) {
      const raw = localStorage.getItem(`${DRAFT_ITEM_PREFIX}${id}`);
      const d = safeJsonParse(raw, null);
      if (d && d.id) list.push(d);
    }
    list.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    const out = list.map((x) => x.id);
    localStorage.setItem(DRAFT_LIST_KEY, JSON.stringify(out));
    return out;
  } catch {
    return [];
  }
}

function loadDraftIds() {
  const raw = localStorage.getItem(DRAFT_LIST_KEY);
  const arr = safeJsonParse(raw || '[]', []);
  const ids = Array.isArray(arr) ? arr : [];
  if (ids.length === 0) {
    // ✅ fixes “old drafts not showing”
    return rebuildDraftIdsByScan();
  }
  return ids;
}

function saveDraftIds(ids) {
  localStorage.setItem(DRAFT_LIST_KEY, JSON.stringify(ids));
}

function upsertDraftLocal(draft) {
  if (!draft?.id) return;
  localStorage.setItem(`${DRAFT_ITEM_PREFIX}${draft.id}`, JSON.stringify(draft));
  const ids = loadDraftIds();
  if (!ids.includes(draft.id)) {
    ids.unshift(draft.id);
    saveDraftIds(ids);
  } else {
    const next = [draft.id, ...ids.filter((x) => x !== draft.id)];
    saveDraftIds(next);
  }
}

function removeDraftLocal(id) {
  if (!id) return;
  localStorage.removeItem(`${DRAFT_ITEM_PREFIX}${id}`);
  const ids = loadDraftIds().filter((x) => x !== id);
  saveDraftIds(ids);
}

function readAllDraftsLocal() {
  const ids = loadDraftIds();
  const list = [];
  for (const id of ids) {
    const raw = localStorage.getItem(`${DRAFT_ITEM_PREFIX}${id}`);
    if (!raw) continue;
    const d = safeJsonParse(raw, null);
    if (d && d.id) list.push(d);
  }
  list.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  return list;
}

// ---------- DRAFT REMOTE HELPERS (SHARED) ----------
async function upsertDraftRemote(draft) {
  try {
    if (!draft?.id) return;
    const blob = new Blob([JSON.stringify(draft)], { type: 'application/json' });
    await supabase.storage.from(BUCKET).upload(`${DRAFTS_FOLDER}/${draft.id}.json`, blob, {
      upsert: true,
      cacheControl: '0',
      contentType: 'application/json',
    });
  } catch {}
}

async function deleteDraftRemote(id) {
  try {
    if (!id) return;
    await supabase.storage.from(BUCKET).remove([`${DRAFTS_FOLDER}/${id}.json`]);
  } catch {}
}

async function listDraftsRemote(limit = 200) {
  try {
    const { data, error } = await supabase.storage.from(BUCKET).list(DRAFTS_FOLDER, { limit });
    if (error) throw error;
    return (data || []).filter((x) => x?.name?.endsWith('.json'));
  } catch {
    return [];
  }
}

async function readDraftRemote(id) {
  try {
    const { data, error } = await supabase.storage.from(BUCKET).download(`${DRAFTS_FOLDER}/${id}.json`);
    if (error) throw error;
    const text = await data.text();
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function fetchRemoteDraftsSummary() {
  const files = await listDraftsRemote(200);
  const out = [];

  const tasks = files.map(async (f) => {
    const id = f.name.replace('.json', '');
    const d = await readDraftRemote(id);
    if (!d?.id) return;

    const m2 = computeM2FromRows(d.tepihaRows || [], d.stazaRows || [], d.stairsQty || 0, d.stairsPer || 0);
    const euro = Number((m2 * (Number(d.pricePerM2) || PRICE_DEFAULT)).toFixed(2));

    out.push({
      id: d.id,
      ts: d.ts || 0,
      code: normalizeCode(d.codeRaw || d.code || ''),
      m2,
      euro,
    });
  });

  await Promise.allSettled(tasks);
  out.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  return out;
}

// ---------- SETTINGS REMOTE (SHARED PRICE) ----------
async function readSharedPrice() {
  try {
    const { data, error } = await supabase.storage.from(BUCKET).download(`${SETTINGS_FOLDER}/price.json`);
    if (error) throw error;
    const text = await data.text();
    const j = JSON.parse(text);
    const v = Number(j?.pricePerM2);
    if (Number.isFinite(v) && v > 0) return v;
  } catch {}
  return null;
}

async function writeSharedPrice(pricePerM2) {
  const v = Number(pricePerM2);
  if (!Number.isFinite(v) || v <= 0) return;
  const blob = new Blob([JSON.stringify({ pricePerM2: v, at: new Date().toISOString() })], { type: 'application/json' });
  await supabase.storage.from(BUCKET).upload(`${SETTINGS_FOLDER}/price.json`, blob, {
    upsert: true,
    cacheControl: '0',
    contentType: 'application/json',
  });
}

// ---------------- COMPONENT ----------------
export default function PranimiPage() {
  const router = useRouter();
  const phonePrefix = '+383';

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

  // client search (rikthime)
  const [clientQuery, setClientQuery] = useState('');
  const [clientsIndex, setClientsIndex] = useState([]);
  const [clientHits, setClientHits] = useState([]);
  const [clientsLoading, setClientsLoading] = useState(false);

  // rows
  // ✅ Start with EMPTY qty so "Copë" doesn't show ghost pieces before user inputs anything
  // ✅ Start with NO rows so we don't show "COPË: 2" by default.
  // Rows appear only after user action (chip or +RRESHT).
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

  // messaging
  const [showMsgSheet, setShowMsgSheet] = useState(false);

  // ✅ auto message after save (ON/OFF)
  const [autoMsgAfterSave, setAutoMsgAfterSave] = useState(true);
  const [pendingNavTo, setPendingNavTo] = useState('');

  // ✅ price editor (long-press on € PAGESA)
  const [showPriceSheet, setShowPriceSheet] = useState(false);
  const [priceTmp, setPriceTmp] = useState(PRICE_DEFAULT);

  // payAdd (same as Pastrimi)
  const [payAdd, setPayAdd] = useState(0);

  // notes
  const [notes, setNotes] = useState('');

  // offline mode (saves to local queue when server/internet fails)
  const [offlineMode, setOfflineMode] = useState(false);
  const [netState, setNetState] = useState({ ok: true, reason: '' });

const [showOfflinePrompt, setShowOfflinePrompt] = useState(false);

  // If the user returns to PRANIMI via browser history, Next.js can restore old component state.
  // This flag lets us reset the form (new OID + new code) when the page becomes visible again.
  const RESET_ON_SHOW_KEY = 'tepiha_pranimi_reset_on_show_v1';

  // 3) Kur hapet PRANIMI dhe kur thirret resetForNewOrder() (MODIFIKUAR)
  async function resetForNewOrder() {
    try {
      // gjenero oid
      const id =
        (typeof crypto !== 'undefined' && crypto.randomUUID)
          ? crypto.randomUUID()
          : `ord_${Date.now()}`;
      setOid(id);

      // menjëherë thirr reserveSharedCode(oid)
      try {
        const c = await reserveSharedCode(id);

        // vendose rezultatin në codeRaw
        setCodeRaw(c);
      } catch (e) {
        // Nëse s’po arrijmë me marrë KOD (RPC/Pool/Permision), mos e blloko formën.
        // Lejo punë OFFLINE (ruajtje lokale) dhe jep opsion "PROVO PRAP".
        // (Mos krijo/ruaj "order" këtu — nuk ekziston ende dhe kjo e prish PRANIMI-n.)
        try { console.warn('[PRANIMI] reserveSharedCode failed', e); } catch {}
        setCodeRaw('');
        setNetState({ ok: false, reason: 'CODE_RESERVE_FAILED' });
        setShowOfflinePrompt(true);
        try { localStorage.setItem(OFFLINE_MODE_KEY, '1'); } catch {}
        setOfflineMode(true);
      }

      // reset form fields (minimal)
      setName('');
      setPhone('');
      setClientPhotoUrl('');
      setClientQuery('');
      setClientHits([]);

      setTepihaRows([]);
      setStazaRows([]);
      setStairsQty(0);
      setStairsPer(SHKALLORE_M2_PER_STEP_DEFAULT);
      setStairsPhotoUrl('');

      setClientPaid(0);
      setArkaRecordedPaid(0);
      setPayMethod('CASH');
      setNotes('');

      // safety: ensure the button is clickable
      setSavingContinue(false);
      setPhotoUploading(false);
    } catch {}
  }

// init offline mode + monitor connectivity
useEffect(() => {
  try {
    const init = loadOfflineModeInit();
    setOfflineMode(init);
  } catch {}

  // Reset the form when coming back to PRANIMI via browser history.
  try {
    const need = sessionStorage.getItem(RESET_ON_SHOW_KEY) === '1';
    if (need) {
      sessionStorage.removeItem(RESET_ON_SHOW_KEY);
      void resetForNewOrder();
    }
  } catch {}

  const onVis = () => {
    try {
      if (document.visibilityState !== 'visible') return;
      const need = sessionStorage.getItem(RESET_ON_SHOW_KEY) === '1';
      if (!need) return;
      sessionStorage.removeItem(RESET_ON_SHOW_KEY);
      void resetForNewOrder();
    } catch {}
  };
  document.addEventListener('visibilitychange', onVis);

  let alive = true;

  async function run() {
    const s = await checkConnectivity();
    if (!alive) return;
    setNetState(s);
    if (!s.ok && !offlineMode) setShowOfflinePrompt(true);
  }

  run();

  const onOnline = () => run();
  const onOffline = () => run();
  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOffline);

  const t = setInterval(run, 20000);

  return () => {
    alive = false;
    window.removeEventListener('online', onOnline);
    window.removeEventListener('offline', onOffline);
    clearInterval(t);
    document.removeEventListener('visibilitychange', onVis);
  };
}, [offlineMode]);

// capacity (from Pastrimi cache)
  const [etaText, setEtaText] = useState('GATI DITËN E 2-TË (NESËR)');
  const [todayPastrimM2, setTodayPastrimM2] = useState(0);

  // debounce autosave draft
  const draftTimer = useRef(null);

  // ✅ long press refs
  const payHoldTimerRef = useRef(null);
  const payHoldTriggeredRef = useRef(false);


// ✅ tap/scroll guard (iOS): prevent accidental actions while scrolling
const payTapRef = useRef({ sx: 0, sy: 0, moved: false, t0: 0 });
const chipTapRef = useRef({ sx: 0, sy: 0, moved: false, t0: 0 });
  const stazaQuickInputRef = useRef(null);


const TAP_MOVE_PX = 12;
const TAP_MIN_MS = 30;

function tapDown(ref, e) {
  try {
    ref.current = { sx: e?.clientX ?? 0, sy: e?.clientY ?? 0, moved: false, t0: Date.now() };
  } catch {}
}

function tapMove(ref, e) {
  try {
    const r = ref.current || {};
    const dx = Math.abs((e?.clientX ?? 0) - (r.sx ?? 0));
    const dy = Math.abs((e?.clientY ?? 0) - (r.sy ?? 0));
    if (dx > TAP_MOVE_PX || dy > TAP_MOVE_PX) r.moved = true;
    ref.current = r;
  } catch {}
}

function isRealTap(ref) {
  try {
    const r = ref.current || {};
    const dt = Date.now() - (r.t0 || 0);
    return !r.moved && dt >= TAP_MIN_MS;
  } catch {
    return true;
  }
}

function guardedApplyChip(kind, val, ev) {
  // Only apply if user actually tapped (not scrolled)
  if (!isRealTap(chipTapRef)) return;
  applyChip(kind, val, ev);
}

// ✅ Wizard (client info + photos)
const [showWizard, setShowWizard] = useState(false);
const [wizStep, setWizStep] = useState(1); // 1=KLIENTI, 2=FOTOT, 3=GATI
const [wizTab, setWizTab] = useState('TEPIHA'); // TEPIHA | STAZA | SHKALLORE

function openWizard() {
  setWizStep(1);
  setWizTab('TEPIHA');
  setShowWizard(true);
}
function closeWizard() {
  setShowWizard(false);
}
function wizNext() {
  setWizStep((s) => Math.min(3, s + 1));
}
function wizBack() {
  setWizStep((s) => Math.max(1, s - 1));
}

  async function refreshDrafts() {
    try {
      // Merge local (offline-safe) + remote (cross-device). If remote list fails due to
      // storage policies, local drafts still show so you don't get stuck.
      const local = readAllDraftsLocal().map((d) => ({
        id: d.id,
        code: Number(d.code) || 0,
        name: `${d?.client?.first_name || ''} ${d?.client?.last_name || ''}`.trim(),
        phone: d?.client?.phone || '',
        ts: Number(d.ts) || 0,
      }));

      let remote = [];
      try {
        remote = await fetchRemoteDraftsSummary();
      } catch {
        remote = [];
      }

      const byId = new Map();
      for (const d of [...remote, ...local]) {
        if (!d?.id) continue;
        if (!byId.has(d.id)) byId.set(d.id, d);
      }
      const merged = Array.from(byId.values()).sort((a, b) => Number(b.ts) - Number(a.ts));
      setDrafts(merged);
    } catch {
      // worst-case fallback
      const local = readAllDraftsLocal().map((d) => ({
        id: d.id,
        code: Number(d.code) || 0,
        name: `${d?.client?.first_name || ''} ${d?.client?.last_name || ''}`.trim(),
        phone: d?.client?.phone || '',
        ts: Number(d.ts) || 0,
      }));
      setDrafts(local.sort((a, b) => Number(b.ts) - Number(a.ts)));
    }
  }

  // ---------- CLIENT SEARCH (rikthime) ----------
  async function loadClientsIndexOnce() {
    if (clientsLoading) return;
    if (clientsIndex && clientsIndex.length) return;

    setClientsLoading(true);
    try {
      // cache 24h
      const cacheKey = 'tepiha_clients_index_v1';
      const cachedRaw = localStorage.getItem(cacheKey);
      if (cachedRaw) {
        try {
          const cached = JSON.parse(cachedRaw);
          if (cached && Array.isArray(cached.items) && Date.now() - Number(cached.ts || 0) < 24 * 3600 * 1000) {
            setClientsIndex(cached.items);
            return;
          }
        } catch {}
      }

      // ✅ Source of truth: `clients` table (permanent client registry)
      const clients = await fetchClientsFromDb(10000);
      const orders = await fetchOrdersFromDb(10000);

      // Map active orders + last seen per client_code (based on orders table)
      const byCode = new Map();
      for (const r of (orders || [])) {
        const code = Number(r?.code);
        if (!Number.isFinite(code)) continue;
        const codeStr = String(code);
        const cur = byCode.get(codeStr) || { active: 0, last_seen: null };
        const st = String(r?.status || r?.data?.status || '').toLowerCase();
        if (st && st !== 'dorzim') cur.active += 1;
        const ts = r?.updated_at || r?.created_at || null;
        if (!cur.last_seen || (ts && String(ts) > String(cur.last_seen))) cur.last_seen = ts;
        byCode.set(codeStr, cur);
      }

      const items = [];
      for (const c of (clients || [])) {
        const codeStr = String(c?.code || '').trim();
        if (!codeStr) continue;
        const first = String(c?.first_name || '').trim();
        const last = String(c?.last_name || '').trim();
        const name = (first + ' ' + last).trim();
        const phone = String(c?.phone || '').trim();
        const info = byCode.get(codeStr) || { active: 0, last_seen: null };
        items.push({ code: codeStr, name, phone, active: info.active ? 1 : 0, last_seen: info.last_seen });
        if (items.length >= 2000) break;
      }

      setClientsIndex(items);
      try {
        localStorage.setItem(cacheKey, JSON.stringify({ ts: Date.now(), items }));
      } catch {}
    } catch {
      // fallback: keep old cached list if any
      try {
        const cacheKey = 'tepiha_clients_index_v1';
        const cachedRaw = localStorage.getItem(cacheKey);
        if (cachedRaw) {
          const cached = JSON.parse(cachedRaw);
          if (cached && Array.isArray(cached.items)) setClientsIndex(cached.items);
        }
      } catch {}
    } finally {
      setClientsLoading(false);
    }
  }

  useEffect(() => {
    const q = String(clientQuery || '').trim();
    if (!q) {
      setClientHits([]);
      return;
    }

    let alive = true;

    (async () => {
      try {
        const hits = await searchClientsLive(q);
        if (!alive) return;
        setClientHits(Array.isArray(hits) ? hits.slice(0, 15) : []);
      } catch (e) {
        // fallback: old local filter if live search fails
        try {
          const qLow = q.toLowerCase();
          const matches = (clientsIndex || [])
            .filter((c) => {
              return (
                String(c.code).includes(qLow) ||
                String(c.name).toLowerCase().includes(qLow) ||
                String(c.phone).includes(qLow)
              );
            })
            .slice(0, 15);
          if (!alive) return;
          setClientHits(matches);
        } catch {
          if (!alive) return;
          setClientHits([]);
        }
      }
    })();

    return () => {
      alive = false;
    };
  }, [clientQuery]);

useEffect(() => {
    (async () => {
      try {
        await refreshDrafts();
      } catch {}

      // load settings
      try {
        const a = localStorage.getItem(AUTO_MSG_KEY);
        if (a === '0') setAutoMsgAfterSave(false);
        if (a === '1') setAutoMsgAfterSave(true);
      } catch {}

      // ✅ shared price first, fallback local
      try {
        const shared = await readSharedPrice();
        if (shared) {
          setPricePerM2(shared);
          localStorage.setItem(PRICE_KEY, String(shared));
        } else {
          const p = Number(localStorage.getItem(PRICE_KEY) || '');
          if (Number.isFinite(p) && p > 0) setPricePerM2(p);
        }
      } catch {}

      // MODIFIKUAR PIKA 3: Initial Load
      const id =
        (typeof crypto !== "undefined" && crypto.randomUUID)
          ? crypto.randomUUID()
          : `ord_${Date.now()}`;
      setOid(id);

      // CODE: try server reservation, but never block PRANIMI
let c = '';
try {
  const TIMEOUT_MS = 2500;
  c = await Promise.race([
    reserveSharedCode(id),
    new Promise((_, rej) => setTimeout(() => rej(new Error('CODE_TIMEOUT')), TIMEOUT_MS)),
  ]);
} catch (e) {
  c = '';
  try { localStorage.setItem(OFFLINE_MODE_KEY, '1'); } catch {}
  setOfflineMode(true);
  setNetState({ ok: false, reason: (e && e.message) ? e.message : 'CODE_FAIL' });
  setShowOfflinePrompt(true);
}
setCodeRaw(c || '');


      try {
        const cached = Number(localStorage.getItem('capacity_today_pastrim_m2') || '0');
        const text = localStorage.getItem('capacity_eta_text');
        setTodayPastrimM2(Number.isFinite(cached) ? cached : 0);
        setEtaText(text || (cached > DAILY_CAPACITY_M2 ? 'GATI DITËN E 3-TË (MBASNESËR)' : 'GATI DITËN E 2-TË (NESËR)'));
      } catch {}

      setCreating(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Prefetch next step (perceived speed)
  useEffect(() => {
    try {
      router?.prefetch?.('/pastrimi');
    } catch {}
  }, [router]);

  const totalM2 = useMemo(() => computeM2FromRows(tepihaRows, stazaRows, stairsQty, stairsPer), [tepihaRows, stazaRows, stairsQty, stairsPer]);
  const totalEuro = useMemo(() => Number((totalM2 * (Number(pricePerM2) || 0)).toFixed(2)), [totalM2, pricePerM2]);

  const diff = useMemo(() => Number((totalEuro - Number(clientPaid || 0)).toFixed(2)), [totalEuro, clientPaid]);
  const currentDebt = diff > 0 ? diff : 0;
  const currentChange = diff < 0 ? Math.abs(diff) : 0;

  const copeCount = useMemo(() => {
    const t = tepihaRows.reduce((a, b) => a + (Number(b.qty) || 0), 0);
    const s = stazaRows.reduce((a, b) => a + (Number(b.qty) || 0), 0);
    const sh = Number(stairsQty) > 0 ? 1 : 0;
    return t + s + sh;
  }, [tepihaRows, stazaRows, stairsQty]);

  // If user started entering data and then taps HOME (or leaves PRANIMI),
  // we want that work to appear under "TË PA PLOTSUARAT" and we also want
  // the next PRANIMI to take the NEXT code (advance code) — matching the
  // expected workflow.
  function buildDraftSnapshot() {
    return {
      id: oid,
      ts: Date.now(),
      codeRaw,
      name,
      phone,
      clientPhotoUrl,
      tepihaRows,
      stazaRows,
      stairsQty,
      stairsPer,
      stairsPhotoUrl,
      pricePerM2,
      clientPaid,
      arkaRecordedPaid,
      payMethod,
      notes,
    };
  }

  function hasStartedWork() {
    return (
      (name || '').trim() ||
      (phone || '').trim() ||
      (clientPhotoUrl || '') ||
      (notes || '').trim() ||
      (tepihaRows || []).some((r) => String(r.m2 || '').trim() || String(r.qty || '').trim() !== '1' || r.photoUrl) ||
      (stazaRows || []).some((r) => String(r.m2 || '').trim() || String(r.qty || '').trim() !== '1' || r.photoUrl) ||
      Number(stairsQty) > 0 ||
      Number(clientPaid) > 0
    );
  }

  async function commitDraftAndAdvanceCodeBestEffort() {
    try {
      if (!oid) return;
      if (!hasStartedWork()) return;

      // Flush any pending debounce autosave immediately.
      try {
        if (draftTimer.current) clearTimeout(draftTimer.current);
      } catch {}

      const draft = buildDraftSnapshot();

      // Always store locally (offline-safe) and also try remote (cross-device).
      try {
        upsertDraftLocal(draft);
      } catch {}
      try {
        void upsertDraftRemote(draft);
      } catch {}
      try {
        void refreshDrafts();
      } catch {}

      // Advance the code (consume it) because user has started a real intake.
      // This makes returning to PRANIMI show the next code.
      const n = Number(normalizeCode(codeRaw));
      if (Number.isFinite(n) && n > 0) {
        try {
          await markCodeUsed(n, oid);
        } catch {}
        try {
          await releaseLocksForCode(String(n));
        } catch {}
      }
    } catch {}
  }

  // ---------- AUTO-SAVE DRAFT (local + remote shared) ----------
  useEffect(() => {
    if (creating) return;
    if (!oid) return;

    if (draftTimer.current) clearTimeout(draftTimer.current);

    draftTimer.current = setTimeout(() => {
      try {
        const draft = {
          id: oid,
          ts: Date.now(),
          codeRaw,
          name,
          phone,
          clientPhotoUrl,
          tepihaRows,
          stazaRows,
          stairsQty,
          stairsPer,
          stairsPhotoUrl,
          pricePerM2,
          clientPaid,
          arkaRecordedPaid,
          payMethod,
          notes,
        };

        const started =
          (name || '').trim() ||
          (phone || '').trim() ||
          (clientPhotoUrl || '') ||
          (notes || '').trim() ||
          (tepihaRows || []).some((r) => String(r.m2 || '').trim() || String(r.qty || '').trim() !== '1' || r.photoUrl) ||
          (stazaRows || []).some((r) => String(r.m2 || '').trim() || String(r.qty || '').trim() !== '1' || r.photoUrl) ||
          Number(stairsQty) > 0 ||
          Number(clientPaid) > 0;

        if (started) {
          // IMPORTANT:
          // Draft autosave MUST NOT mark the code as USED.
          // The code-lease system reserves a code per OID; we only mark USED
          // after a successful DB save.

          upsertDraftLocal(draft); // backup offline
          // ✅ shared draft
          upsertDraftRemote(draft).finally(() => {
            void refreshDrafts();
          });
        }
      } catch {}
    }, 700);

    return () => {
      if (draftTimer.current) clearTimeout(draftTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    creating,
    oid,
    codeRaw,
    name,
    phone,
    clientPhotoUrl,
    tepihaRows,
    stazaRows,
    stairsQty,
    stairsPer,
    stairsPhotoUrl,
    pricePerM2,
    clientPaid,
    arkaRecordedPaid,
    payMethod,
    notes,
  ]);

  function addRow(kind) {
    const setter = kind === 'tepiha' ? setTepihaRows : setStazaRows;
    const prefix = kind === 'tepiha' ? 't' : 's';
    // ✅ Rows are user-triggered only. Default COPË must be 0 (not 1).
    setter((rows) => [...rows, { id: `${prefix}${rows.length + 1}`, m2: '', qty: '0', photoUrl: '' }]);
  }

  function removeRow(kind) {
    const setter = kind === 'tepiha' ? setTepihaRows : setStazaRows;
    // allow removing down to 0 rows (so inputs can be fully "closed")
    setter((rows) => (rows.length ? rows.slice(0, -1) : rows));
  }

  function handleRowChange(kind, id, field, value) {
    const setter = kind === 'tepiha' ? setTepihaRows : setStazaRows;
    setter((rows) => rows.map((r) => (r.id === id ? { ...r, [field]: value } : r)));
  }

  async function handleRowPhotoChange(kind, id, file) {
    if (!file || !oid) return;
    setPhotoUploading(true);
    try {
      const url = await uploadPhoto(file, oid, `${kind}_${id}`);
      if (url) handleRowChange(kind, id, 'photoUrl', url);
    } catch {
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
    } catch {
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
    } catch {
      alert('❌ Gabim foto!');
    } finally {
      setPhotoUploading(false);
    }
  }

  function vibrateTap(ms = 15) {
    try {
      if (typeof navigator !== 'undefined' && navigator.vibrate) navigator.vibrate(ms);
    } catch {}
  }

  function bumpEl(el) {
    try {
      if (!el) return;
      el.classList.remove('chip-bump');
      // eslint-disable-next-line no-unused-expressions
      el.offsetWidth;
      el.classList.add('chip-bump');
      setTimeout(() => el.classList.remove('chip-bump'), 140);
    } catch {}
  }

  function applyChip(kind, val, ev) {
    vibrateTap(15);
    if (ev?.currentTarget) bumpEl(ev.currentTarget);

    const setter = kind === 'tepiha' ? setTepihaRows : setStazaRows;
    const rows = kind === 'tepiha' ? tepihaRows : stazaRows;

    // If no rows yet, create the first row.
    // Chip click is an explicit user action, so default COPË=1.
    if (!rows || rows.length === 0) {
      const prefix = kind === 'tepiha' ? 't' : 's';
      setter([{ id: `${prefix}1`, m2: String(val), qty: '1', photoUrl: '' }]);
      return;
    }

    const emptyIdx = rows.findIndex((r) => !r.m2);
    if (emptyIdx !== -1) {
      const nr = [...rows];
      const curQty = String(nr[emptyIdx]?.qty ?? '').trim();
      nr[emptyIdx] = { ...nr[emptyIdx], m2: String(val), qty: curQty && curQty !== '0' ? curQty : '1' };
      setter(nr);
    } else {
      const prefix = kind === 'tepiha' ? 't' : 's';
      setter([...rows, { id: `${prefix}${rows.length + 1}`, m2: String(val), qty: '1', photoUrl: '' }]);
    }
  }

  // ---------- PAY + PRICE ----------
  function openPay() {
    const dueNow = Number((totalEuro - Number(clientPaid || 0)).toFixed(2));
    setPayAdd(dueNow > 0 ? dueNow : 0);
    setPayMethod("CASH");
    setShowPaySheet(true);
  }

  function openPriceEditor() {
    setPriceTmp(Number(pricePerM2) || PRICE_DEFAULT);
    setShowPriceSheet(true);
  }

  async function savePriceAndClose() {
    const v = Number(priceTmp);
    if (!Number.isFinite(v) || v <= 0) {
      alert('Shkruaj një çmim të vlefshëm (p.sh. 3).');
      return;
    }
    setPricePerM2(v);

    try {
      localStorage.setItem(PRICE_KEY, String(v));
    } catch {}

    // ✅ shared price for all workers
    try {
      await writeSharedPrice(v);
    } catch {}

    setShowPriceSheet(false);
  }

  // ✅ long-press (3s) on € PAGESA
  function startPayHold() {
    payHoldTriggeredRef.current = false;
    if (payHoldTimerRef.current) clearTimeout(payHoldTimerRef.current);

    payHoldTimerRef.current = setTimeout(() => {
      payHoldTriggeredRef.current = true;
      vibrateTap(25);
      openPriceEditor();
    }, 1200);
  }

  function endPayHold() {
    if (payHoldTimerRef.current) clearTimeout(payHoldTimerRef.current);
    payHoldTimerRef.current = null;

    // ✅ if user was scrolling, never open
    if (payTapRef.current?.moved) {
      payHoldTriggeredRef.current = false;
      return;
    }

    // if long-press DIDN'T trigger → open normal PAGESA
    if (!payHoldTriggeredRef.current) openPay();
    payHoldTriggeredRef.current = false;
  }

  function cancelPayHold() {
    if (payHoldTimerRef.current) clearTimeout(payHoldTimerRef.current);
    payHoldTimerRef.current = null;
    payHoldTriggeredRef.current = false;
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
      alert(due <= 0 ? "KJO POROSI ESHTE PAGUAR (S'KA BORXH)." : 'SHUMA NUK VLEN (0 €).');
      return;
    }

    const newPaid = Number((Number(clientPaid || 0) + applied).toFixed(2));
    setClientPaid(newPaid);

    // ✅ ARKA delta only if CASH (local cache + Supabase arka_moves if day open)
    if (payMethod === 'CASH') {
      const actor = (() => {
        try {
          const raw = localStorage.getItem('CURRENT_USER_DATA');
          return raw ? JSON.parse(raw) : null;
        } catch {
          return null;
        }
      })();

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
        // Fallback te session-i (actorSession) nëse prop `actor` nuk vjen
        createdByPin: (actor?.pin ? String(actor.pin) : (getActor()?.pin ? String(getActor().pin) : null)),
        createdBy: (actor?.name ? String(actor.name) : (getActor()?.name ? String(getActor().name) : null)),
      });

      const finalArka = Number((Number(arkaRecordedPaid || 0) + applied).toFixed(2));
      setArkaRecordedPaid(finalArka);
    }

    setShowPaySheet(false);
  }

  function validateBeforeContinue() {
    if (!name.trim()) return alert('Shkruaj emrin dhe mbiemrin.'), false;
    if (name.trim().split(/\s+/).length < 2) return alert('Shkruaj edhe mbiemrin.'), false;

    const ph = sanitizePhone(phonePrefix + phone);
    if (!ph || ph.length < 6) return alert('Shkruaj një numër telefoni të vlefshëm.'), false;

	// qty must be > 0 for any row that has m² (prevents saving 0 COPË by mistake)
	const allRows = [...(tepihaRows || []), ...(stazaRows || [])];
	for (const r of allRows) {
    const m2 = parseFloat(String(r.m2 || '0').replace(',', '.')) || 0;
    const q = parseInt(String(r.qty || '0'), 10) || 0;
    if (m2 > 0 && q <= 0) return alert('COPË duhet me qenë > 0 për çdo rresht që ka m².'), false;
  }

    if (totalM2 <= 0) return alert('Shto të paktën 1 m².'), false;
    return true;
  }


function loadOfflineModeInit() {
  try {
    const v = localStorage.getItem(OFFLINE_MODE_KEY);
    return v === '1';
  } catch {
    return false;
  }
}

async function checkConnectivity() {
  try {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      return { ok: false, reason: 'NO_INTERNET' };
    }

    // light ping without touching RLS-protected tables
    await supabase.auth.getSession();
    return { ok: true, reason: '' };
  } catch {
    return { ok: false, reason: 'FETCH_FAILED' };
  }
}

function saveOfflineQueueItem(order) {
  try {
    const raw = localStorage.getItem(OFFLINE_QUEUE_KEY);
    const list = raw ? JSON.parse(raw) : [];
    const item = {
      local_id: order?.id || `offline_${Date.now()}`,
      created_at: new Date().toISOString(),
      name: order?.client?.name || '',
      phone: order?.client?.phone || '',
      code: order?.client?.code || '',
      pieces:
        Number(order?.tepiha?.reduce((s, r) => s + (Number(r.qty) || 0), 0) || 0) +
        Number(order?.staza?.reduce((s, r) => s + (Number(r.qty) || 0), 0) || 0) +
        Number(order?.shkallore?.qty || 0),
      total: Number(order?.pay?.euro || 0),
      paid: Number(order?.pay?.paid || 0),
      debt: Number(order?.pay?.debt || 0),
      status: 'OFFLINE',
      order,
      synced: false,
    };
    list.unshift(item);
    localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(list.slice(0, 2000)));
    return true;
  } catch {
    return false;
  }
}

  async function handleContinue() {
    if (!validateBeforeContinue()) return;

    // instant UI feedback (prevents double taps)
    if (savingContinue) return;
    setSavingContinue(true);

    try {
      const order = {
        id: oid,
        ts: Date.now(),
        status: 'pastrim',
        client: {
          name: name.trim(),
          phone: phonePrefix + (phone || ''),
          code: normalizeCode(codeRaw),
          photoUrl: clientPhotoUrl || '',
        },
        tepiha: tepihaRows.map((r) => ({ m2: Number(r.m2) || 0, qty: Number(r.qty) || 0, photoUrl: r.photoUrl || '' })),
        staza: stazaRows.map((r) => ({ m2: Number(r.m2) || 0, qty: Number(r.qty) || 0, photoUrl: r.photoUrl || '' })),
        shkallore: { qty: Number(stairsQty) || 0, per: Number(stairsPer) || 0, photoUrl: stairsPhotoUrl || '' },
        pay: {
          m2: totalM2,
          rate: Number(pricePerM2) || PRICE_DEFAULT,
          euro: totalEuro,
          paid: Number((Number(clientPaid) || 0).toFixed(2)),
          debt: currentDebt,
          method: payMethod,
          arkaRecordedPaid: Number((Number(arkaRecordedPaid) || 0).toFixed(2)),
        },
        notes: notes || '',
      };


      // ✅ Nëse s’kemi KOD (p.sh. pool/RPC ra), mos e blloko — ruaje OFFLINE si draft/queue.
      const normCodeNow = normalizeCode(codeRaw);
      if (!normCodeNow || normCodeNow === '0') {
        const ok = saveOfflineQueueItem(order);
        try { localStorage.setItem(OFFLINE_MODE_KEY, '1'); } catch {}
        setOfflineMode(true);
        if (!ok) {
          alert('❌ S’KEMI KOD + OFFLINE: nuk u ruajt lokalisht!');
          setSavingContinue(false);
          return;
        }
        alert('⚠️ S’MORI KOD NGA SERVERI. U RUAJT OFFLINE. Provo prap kur të ketë lidhje.');
// go forward anyway so workflow continues
try { sessionStorage.setItem(RESET_ON_SHOW_KEY, '1'); } catch {}
setSavingContinue(false);
router.push('/pastrimi');
return;
// keep draft for extra safety

        try {
          localStorage.setItem(`${DRAFT_ITEM_PREFIX}${oid}`, JSON.stringify({
            id: oid,
            codeRaw,
            name,
            phone,
            clientPhotoUrl,
            tepihaRows,
            stazaRows,
            stairsQty,
            stairsPer,
            stairsPhotoUrl,
            pricePerM2,
            clientPaid,
            arkaRecordedPaid,
            payMethod,
            notes,
          }));
        } catch {}
        setSavingContinue(false);
        return;
      }


// ✅ OFFLINE MODE: save locally (no Supabase) so you never lose clients
const conn = await checkConnectivity();
// Only auto-fall back to OFFLINE when the browser is actually offline.
const browserOffline = (typeof navigator !== 'undefined' && navigator.onLine === false);
if (offlineMode || (browserOffline && !conn.ok)) {
  // 1) Legacy offline queue (kept)
  const ok = saveOfflineQueueItem(order);
  // 2) Local orders mirror for immediate UI lists
  try { saveOrderLocal(order); } catch {}
  // 3) ✅ Primary offline sync path (offline_store_v1 via ordersDb)
  //    This is what SyncStarter/syncEngine will flush to Supabase when online.
  try {
    const dbOrder = {
      id: oid,
      code: Number(normCodeNow),
      code_n: Number(normCodeNow),
      status: 'pastrim',
      is_offline: true,
      notes: notes || null,
      client_name: name || null,
      client_phone: phone || '',
      total: Number(totalEuro || 0),
      // paid = "Klienti dha" (cash) so totals/debt stay consistent offline
      paid: Number(clientPaid || 0),
      client_photo_url: clientPhotoUrl || null,
      data: order,
    };
    await saveOrderToDb(dbOrder);
  } catch {}
  try { localStorage.setItem(OFFLINE_MODE_KEY, '1'); } catch {}
  setOfflineMode(true);
  if (!ok) {
    alert('❌ OFFLINE: nuk u ruajt lokalisht!');
    setSavingContinue(false);
    return;
  }

  // ✅ IMPORTANT: even OFFLINE we must mark the code as USED so the lease is cleared
  // (otherwise the next order will re-use the same code)
  try { await markCodeUsed(Number(normCodeNow), oid); } catch {}

  alert('✅ U RUAJT OFFLINE. Kur të kthehet interneti, mund t’i integroni/sync më vonë.');
// go forward anyway so workflow continues
try { sessionStorage.setItem(RESET_ON_SHOW_KEY, '1'); } catch {}
setSavingContinue(false);
router.push('/pastrimi');
return;
// keep draft for extra safety

  try {
    localStorage.setItem(`${DRAFT_ITEM_PREFIX}${oid}`, JSON.stringify({
      id: oid,
      codeRaw,
      name,
      phone,
      clientPhotoUrl,
      tepihaRows,
      stazaRows,
      stairsQty,
      stairsPer,
      stairsPhotoUrl,
      pricePerM2,
      clientPaid,
      arkaRecordedPaid,
      payMethod,
      notes,
    }));
  } catch {}
  setSavingContinue(false);
  return;
}

      // ✅ CRITICAL PATH: save to DB first so the client appears in PASTRIMI immediately.
      let db = null;
      try {
        db = await saveOrderToDb(order);
      } catch (e) {
        // Fallback: keep it locally + sync later (do NOT block workflow)
        try { await saveOrderToDb({ ...order, is_offline: true }, 'PRANIMI_FAILOVER'); } catch {}
        try { localStorage.setItem(OFFLINE_MODE_KEY, '1'); } catch {}
        setOfflineMode(true);
        try { await markCodeUsed(codeRaw, oid); } catch {}
        alert('⚠️ SERVERI DËSHTOI. U RUAJT LOKALISHT (SYNC MË VONË).');
        try { sessionStorage.setItem(RESET_ON_SHOW_KEY, '1'); } catch {}
        setSavingContinue(false);
        router.push('/pastrimi');
        return;
      }
      if (db && db.order_id) {
        order.db_id = db.order_id;
        order.client_id = db.client_id || null;
        if (order.client && db.client_id) order.client.id = db.client_id;
      }

      // local mirror (fast)
      try { localStorage.setItem(`order_${oid}`, JSON.stringify(order)); } catch {}
      
      // ✅ MODIFIKUAR PIKA 5: PAS saveOrderToDb(order)
      try { await markCodeUsed(codeRaw, oid); } catch {}

      // ✅ NON-BLOCKING: do backups + cleanup in background
      void (async () => {
        try {
          const blob = new Blob([JSON.stringify(order)], { type: 'application/json' });
          await supabase.storage.from(BUCKET).upload(`orders/${oid}.json`, blob, {
            upsert: true,
            cacheControl: '0',
            contentType: 'application/json',
          });
        } catch {}

        // best-effort cleanup
        try { removeDraftLocal(oid); } catch {}
        try { await deleteDraftRemote(oid); } catch {}
        // no setState here (might run after navigation/unmount)

        // finalize code lock
        try {
          const codeToFinalize = order?.client?.code;
          if (codeToFinalize !== null && codeToFinalize !== undefined && String(codeToFinalize).trim() !== '') {
            await releaseLocksForCode(codeToFinalize);
          }
        } catch {}
      })();

      // Mark: next time PRANIMI becomes visible (back button), reset to a fresh order.
      try {
        sessionStorage.setItem(RESET_ON_SHOW_KEY, '1');
      } catch {}

      // ✅ after save: open message automatically (toggle)
      if (autoMsgAfterSave) {
        setPendingNavTo('/pastrimi');
        setShowMsgSheet(true);
        setSavingContinue(false);
        return;
      }

      // Important: if user navigates back later, we don't want VAZHDO to stay disabled.
      setSavingContinue(false);
      // Important: if user later returns via browser history, don't keep the button stuck disabled.
      setSavingContinue(false);
      router.push('/pastrimi');
    } catch (e) {
      console.error('PRANIMI_SAVE_ERROR', e);
      const msg = (e && (e.message || e.error_description || e.toString())) ? (e.message || e.error_description || e.toString()) : 'Gabim i panjohur';
      // ✅ Build-safe: avoid nested quotes inside template literals
      const details = (e && (e.details || e.hint))
        ? `\n${e.details || ''}${e.hint ? `\n${e.hint}` : ''}`
        : '';
      alert(`❌ RUJTJA DËSHTOI:
${msg}${details}`);
      setSavingContinue(false);
    }
  }

  function openDrafts() {
    void refreshDrafts();
    setShowDraftsSheet(true);
  }

  async function loadDraftIntoForm(id) {
    try {
      // ✅ try remote first
      let d = await readDraftRemote(id);

      // fallback local
      if (!d) {
        const raw = localStorage.getItem(`${DRAFT_ITEM_PREFIX}${id}`);
        if (!raw) return;
        d = JSON.parse(raw);
      }

      setOid(d.id || id);
      setCodeRaw(d.codeRaw || d.code || codeRaw);

      setName(d.name || '');
      setPhone(d.phone || '');
      setClientPhotoUrl(d.clientPhotoUrl || '');

      // ✅ Allow empty arrays so inputs stay "closed" unless user actually adds rows
      // ✅ Force default COPË to '0' if missing
      setTepihaRows(
        Array.isArray(d.tepihaRows) && d.tepihaRows.length
          ? d.tepihaRows.map((r) => ({ ...r, qty: String(r?.qty ?? '0') }))
          : []
      );
      setStazaRows(
        Array.isArray(d.stazaRows) && d.stazaRows.length
          ? d.stazaRows.map((r) => ({ ...r, qty: String(r?.qty ?? '0') }))
          : []
      );

      setStairsQty(Number(d.stairsQty) || 0);
      setStairsPer(Number(d.stairsPer) || SHKALLORE_M2_PER_STEP_DEFAULT);
      setStairsPhotoUrl(d.stairsPhotoUrl || '');

      setPricePerM2(Number(d.pricePerM2) || PRICE_DEFAULT);
      setClientPaid(Number(d.clientPaid) || 0);
      setArkaRecordedPaid(Number(d.arkaRecordedPaid) || 0);
      setPayMethod(d.payMethod || 'CASH');

      setNotes(d.notes || '');

      setShowDraftsSheet(false);
    } catch {}
  }

  async function deleteDraft(id) {
    removeDraftLocal(id);
    await deleteDraftRemote(id);
    await refreshDrafts();
  }

  function buildStartMessage() {
    const kod = normalizeCode(codeRaw);
    const m2 = Number(totalM2 || 0).toFixed(2);
    const euro = Number(totalEuro || 0).toFixed(2);
    const debt = Number(currentDebt || 0).toFixed(2);
    const debtLine = Number(currentDebt || 0) > 0 ? `BORXH: ${debt} €.` : `BORXH: 0.00 €.`;

    const nm = (name || '').trim() ? `Përshëndetje ${name.trim()},` : 'Përshëndetje,';
    const line1 = `${nm} procesi i pastrimit ka filluar.`;
    const line2 = `KODI: ${kod} • TEPIHA: ${copeCount} COPË • ${m2} m² • TOTAL: ${euro} €.`;
    const line3 = debtLine;
    const line4 = `SIPAS KAPACITETIT: ${etaText}.`;
    const line5 = `DO T'JU LAJMËROJMË KUR BËHEN GATI.`;
    const line6 = `NËSE KENI PYTJE THIRR ${COMPANY_PHONE_DISPLAY}.`;

    return [line1, line2, line3, line4, line5, line6].join('\n');
  }

  function openLinkSafe(url) {
    try {
      window.location.href = url;
    } catch {}
  }

  function sendViaSMS() {
    const to = sanitizePhone(phonePrefix + phone);
    const body = encodeURIComponent(buildStartMessage());
    if (!to) return alert('Shkruaj numrin e klientit.');
    openLinkSafe(`sms:${to}?&body=${body}`);
  }

  function sendViaWhatsApp() {
    const to = sanitizePhone(phonePrefix + phone);
    const text = encodeURIComponent(buildStartMessage());
    if (!to) return alert('Shkruaj numrin e klientit.');
    openLinkSafe(`https://wa.me/${to}?text=${text}`);
  }

  function sendViaViber() {
    const to = sanitizePhone(phonePrefix + phone);
    if (!to) return alert('Shkruaj numrin e klientit.');
    openLinkSafe(`viber://chat?number=%2B${to}`);
    try {
      navigator.clipboard?.writeText(buildStartMessage());
    } catch {}
    setTimeout(() => {
      alert('Mesazhi u kopjua. Hap Viber dhe paste te klienti.');
    }, 120);
  }

  function closeMsgSheet() {
    setShowMsgSheet(false);
    if (pendingNavTo) {
      const next = pendingNavTo;
      setPendingNavTo('');
      router.push(next);
    }
  }

  function toggleAutoMsg() {
    const next = !autoMsgAfterSave;
    setAutoMsgAfterSave(next);
    try {
      localStorage.setItem(AUTO_MSG_KEY, next ? '1' : '0');
    } catch {}
  }

  if (creating) {
    return (
      <div className="wrap">
        <p style={{ textAlign: 'center', paddingTop: 30 }}>Duke u përgatitur PRANIMI...</p>
      </div>
    );
  }


return (
  <div className="wrap">
    {showOfflinePrompt ? (
      <div
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0,0,0,0.6)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 9999,
          padding: 16,
        }}
      >
        <div
          style={{
            maxWidth: 520,
            width: '100%',
            borderRadius: 14,
            border: '1px solid rgba(255,255,255,0.12)',
            background: '#0d0f14',
            padding: 14,
          }}
        >
          <div style={{ fontWeight: 900, letterSpacing: 1 }}>S’KA LIDHJE</div>
          <div style={{ opacity: 0.85, marginTop: 8, lineHeight: 1.35 }}>
            Interneti ose serveri nuk po përgjigjet. A don me vazhdu në <b>OFFLINE MODE</b> që mos me i humb klientat?
          </div>

          <div style={{ display: 'flex', gap: 10, marginTop: 12, flexWrap: 'wrap' }}>
            <button
              onClick={() => {
                setOfflineMode(true);
                try { localStorage.setItem(OFFLINE_MODE_KEY, '1'); } catch {}
                setShowOfflinePrompt(false);
              }}
              style={{ padding: '10px 12px', borderRadius: 10, fontWeight: 900 }}
            >
              KALO NË OFFLINE
            </button>

            <button
              onClick={async () => {
                const s = await checkConnectivity();
                setNetState(s);
                if (s.ok) setShowOfflinePrompt(false);
              }}
              style={{ padding: '10px 12px', borderRadius: 10, fontWeight: 900, opacity: 0.9 }}
            >
              PROVO PRAP
            </button>

            <button
              onClick={() => setShowOfflinePrompt(false)}
              style={{ padding: '10px 12px', borderRadius: 10, fontWeight: 800, opacity: 0.75 }}
            >
              MBYLL
            </button>
          </div>

          <div style={{ marginTop: 10, opacity: 0.7, fontSize: 12 }}>Status: {netState.ok ? 'ONLINE' : netState.reason}</div>
        </div>
      </div>
    ) : null}

      <header className="header-row" style={{ alignItems: 'flex-start' }}>
        <div>
          <h1 className="title">PRANIMI</h1>
          <div className="subtitle">KRIJO POROSI</div>
        </div>
        
<div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end' }}>
  <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer', userSelect: 'none' }}>
    <input
      type="checkbox"
      checked={offlineMode}
      onChange={(e) => {
        const v = e.target.checked;
        setOfflineMode(v);
        try { localStorage.setItem(OFFLINE_MODE_KEY, v ? '1' : '0'); } catch {}
      }}
    />
    <span style={{ fontWeight: 900, letterSpacing: 0.5 }}>OFFLINE MODE</span>
  </label>
  <div style={{ fontSize: 12, opacity: 0.75 }}>
    {netState.ok ? 'ONLINE' : `LIDHJA: ${netState.reason}`}
  </div>
</div>

<div className="code-badge">
          <span className="badge">{`KODI: ${normalizeCode(codeRaw)}`}</span>
        </div>
      </header>

      {/* Capacity line (from Pastrimi) */}
      <section className="cap-mini">
        <div className="cap-mini-top">
          <div className="cap-mini-title">SOT NË PASTRIM</div>
          <div className="cap-mini-val">{Number(todayPastrimM2 || 0).toFixed(1)} m²</div>
        </div>
        <div className="cap-mini-eta">{etaText}</div>
      </section>

      {/* ✅ BUTTON ONLY (no inline list) */}
      <section style={{ marginTop: 10 }}>
        <button
          type="button"
          className="btn secondary"
          style={{ width: '100%', padding: '12px 14px', borderRadius: 18 }}
          onClick={openDrafts}
        >
          📝 TË PA PLOTSUARAT {drafts.length > 0 ? `(${drafts.length})` : ''}
        </button>
      </section>

      {/* CLIENT */}
      <section className="card">
        <h2 className="card-title">KLIENTI</h2>

        <div className="row" style={{ gap: 10, marginTop: 8 }}>
          <button type="button" className="btn secondary" onClick={openWizard} style={{ flex: 1, background: 'rgba(34,197,94,0.18)', border: '1px solid rgba(34,197,94,0.45)', color: '#eafff2' }}>
            KLIENTI I RI
          </button>
        </div>


	        {/* Search për klienta që rikthehen (KOD / EMËR / TELEFON) */}
	        <div className="field-group">
	          <label className="label">KËRKO KLIENTIN (KOD / EMËR / TELEFON)</label>
	          <input
	            className="input" id="clientSearchInput"
	            value={clientQuery}
	            onChange={(e) => setClientQuery(e.target.value)}
	            placeholder="p.sh. 98 / arben / 045..."
	          />
	          {clientsLoading ? (
	            <div style={{ fontSize: 10, opacity: 0.7, marginTop: 6 }}>DUKE NGARKUAR KLIENTËT...</div>
	          ) : null}
	          {clientHits && clientHits.length ? (
	            <div className="list" style={{ marginTop: 8, maxHeight: 180, overflow: 'auto' }}>
	              {clientHits.map((c) => (
	                <button
	                  key={`${c.code}_${c.phone}`}
	                  type="button"
	                  className="rowbtn"
	                  onClick={() => {
	                    // MODIFIKUAR PIKA 6: Client search click FIX
	                    if (c.code != null) setCodeRaw(String(c.code));
	                    if (c.name) setName(String(c.name));
	                    
                        // TELEFONI: mos vendos +383, vetëm digits
                        setPhone(String(c.phone || '').replace(/\D/g,''));
	                    
                        setClientQuery('');
	                    setClientHits([]);
	                  }}
	                  style={{ width: '100%', textAlign: 'left', padding: '10px 12px', borderRadius: 12, marginBottom: 8 }}
	                >
	                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
	                    <div style={{ fontWeight: 800 }}>{String(c.code || '')} • {String(c.name || '').toLowerCase()}</div>
	                    <div style={{ opacity: 0.85 }}>{String(c.phonePrefix || '')}{String(c.phone || '')}</div>
	                  </div>
	                </button>
	              ))}
	            </div>
	          ) : null}
	        </div>

        <div className="field-group">
          <label className="label">EMRI & MBIEMRI</label>

          {/* ✅ photo next to last name */}
          <div className="row" style={{ alignItems: 'center', gap: 10 }}>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} style={{ flex: 1 }} />
            {clientPhotoUrl ? <img src={clientPhotoUrl} alt="" className="client-mini" /> : null}
            <label className="camera-btn" title="FOTO KLIENTI" style={{ marginLeft: 2 }}>
              📷
              <input type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => handleClientPhotoChange(e.target.files?.[0])} />
            </label>
          </div>

          {clientPhotoUrl && (
            <button className="btn secondary" style={{ display: 'block', fontSize: 10, padding: '4px 8px', marginTop: 8 }} onClick={() => setClientPhotoUrl('')}>
              🗑️ FSHI FOTO
            </button>
          )}
        </div>

        <div className="field-group">
          <label className="label">TELEFONI</label>
          <div className="row">
            <input className="input small" value={phonePrefix} readOnly />
            <input className="input" value={phone} onChange={(e) => setPhone(e.target.value)} />
          </div>
        </div>
      </section>

      {/* TEPIHA */}
      <section className="card">
        <h2 className="card-title">TEPIHA</h2>

        <div className="chip-row modern">
          {TEPIHA_CHIPS.map((v) => (
            <button
              key={v}
              type="button"
              className="chip chip-modern"
              onPointerDown={(e) => tapDown(chipTapRef, e)}
              onPointerMove={(e) => tapMove(chipTapRef, e)}
              onPointerUp={(e) => guardedApplyChip('tepiha', v, e)}
              style={chipStyleForVal(v, false)}
            >
              {v.toFixed(1)}
            </button>
          ))}
        </div>

        {tepihaRows.map((row) => (
          <div className="piece-row" key={row.id}>
            <div className="row">
              <input className="input small" type="number" value={row.m2} onChange={(e) => handleRowChange('tepiha', row.id, 'm2', e.target.value)} placeholder="m²" />
              <input className="input small" type="number" value={row.qty} onChange={(e) => handleRowChange('tepiha', row.id, 'qty', e.target.value)} placeholder="copë" />
              <label className="camera-btn">
                📷
                <input type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => handleRowPhotoChange('tepiha', row.id, e.target.files?.[0])} />
              </label>
            </div>

            {row.photoUrl && (
              <div style={{ marginTop: 8 }}>
                <img src={row.photoUrl} className="photo-thumb" alt="" />
                <button className="btn secondary" style={{ display: 'block', fontSize: 10, padding: '4px 8px', marginTop: 4 }} onClick={() => handleRowChange('tepiha', row.id, 'photoUrl', '')}>
                  🗑️ FSHI FOTO
                </button>
              </div>
            )}
          </div>
        ))}

        <div className="row btn-row">
          <button className="btn secondary" onClick={() => addRow('tepiha')}>+ RRESHT</button>
          <button className="btn secondary" onClick={() => removeRow('tepiha')}>− RRESHT</button>
        </div>
      </section>

      {/* STAZA */}
      <section className="card">
        <h2 className="card-title">STAZA</h2>

        <div className="chip-row modern">
          {STAZA_CHIPS.map((v) => (
            <button
              key={v}
              type="button"
              className="chip chip-modern"
              onPointerDown={(e) => tapDown(chipTapRef, e)}
              onPointerMove={(e) => tapMove(chipTapRef, e)}
              onPointerUp={(e) => guardedApplyChip('staza', v, e)}
              style={chipStyleForVal(v, false)}
            >
              {v.toFixed(1)}
            </button>
          ))}
        </div>

        {stazaRows.map((row) => (
          <div className="piece-row" key={row.id}>
            <div className="row">
              <input className="input small" type="number" value={row.m2} onChange={(e) => handleRowChange('staza', row.id, 'm2', e.target.value)} placeholder="m²" />
              <input className="input small" type="number" value={row.qty} onChange={(e) => handleRowChange('staza', row.id, 'qty', e.target.value)} placeholder="copë" />
              <label className="camera-btn">
                📷
                <input type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => handleRowPhotoChange('staza', row.id, e.target.files?.[0])} />
              </label>
            </div>

            {row.photoUrl && (
              <div style={{ marginTop: 8 }}>
                <img src={row.photoUrl} className="photo-thumb" alt="" />
                <button className="btn secondary" style={{ display: 'block', fontSize: 10, padding: '4px 8px', marginTop: 4 }} onClick={() => handleRowChange('staza', row.id, 'photoUrl', '')}>
                  🗑️ FSHI FOTO
                </button>
              </div>
            )}
          </div>
        ))}

        <div className="row btn-row">
          <button className="btn secondary" onClick={() => addRow('staza')}>+ RRESHT</button>
          <button className="btn secondary" onClick={() => removeRow('staza')}>− RRESHT</button>
        </div>
      </section>

      {/* UTIL */}
      <section className="card">
        <div className="row util-row" style={{ gap: 10 }}>
          <button className="btn secondary" style={{ flex: 1 }} onClick={() => setShowStairsSheet(true)}>
            🪜 SHKALLORE
          </button>

          {/* ✅ click = pagesa, long-press 3s = ndrrim qmimi */}
          <button
            className="btn secondary"
            style={{ flex: 1 }}
            onPointerDown={(e) => {
              tapDown(payTapRef, e);
              startPayHold();
            }}
            onPointerMove={(e) => {
              tapMove(payTapRef, e);
              if (payTapRef.current?.moved) cancelPayHold();
            }}
            onPointerUp={(e) => {
              // treat scroll as cancel; endPayHold() itself checks moved
              endPayHold();
            }}
            onPointerCancel={cancelPayHold}
            // desktop fallback
            onMouseDown={(e) => {
              tapDown(payTapRef, e);
              startPayHold();
            }}
            onMouseMove={(e) => {
              tapMove(payTapRef, e);
              if (payTapRef.current?.moved) cancelPayHold();
            }}
            onMouseUp={endPayHold}
            onMouseLeave={cancelPayHold}
          >
            € PAGESA
          </button>
        </div>

        {/* ✅ message button back in PRANIMI */}
        <div style={{ marginTop: 10 }}>
          <button className="btn secondary" style={{ width: '100%' }} onClick={() => setShowMsgSheet(true)}>
            📩 DËRGO MESAZH — FILLON PASTRIMI
          </button>
        </div>

        <div className="tot-line">M² Total: <strong>{totalM2}</strong></div>
        <div className="tot-line">Copë: <strong>{copeCount}</strong></div>
        <div className="tot-line">Total: <strong>{totalEuro.toFixed(2)} €</strong></div>

        <div className="tot-line" style={{ borderTop: '1px solid rgba(255,255,255,0.08)', marginTop: 10, paddingTop: 10 }}>
          Paguar: <strong style={{ color: '#16a34a' }}>{Number(clientPaid || 0).toFixed(2)} €</strong>
        </div>

        <div className="tot-line" style={{ fontSize: 12, color: 'rgba(255,255,255,0.65)' }}>
          Regjistru n&apos;ARKË: <strong>{Number(arkaRecordedPaid || 0).toFixed(2)} €</strong>
        </div>

        {currentDebt > 0 && <div className="tot-line">Borxh: <strong style={{ color: '#dc2626' }}>{currentDebt.toFixed(2)} €</strong></div>}
        {currentChange > 0 && <div className="tot-line">Kthim: <strong style={{ color: '#2563eb' }}>{currentChange.toFixed(2)} €</strong></div>}
      </section>

      {/* NOTES */}
      <section className="card">
        <h2 className="card-title">SHËNIME</h2>
        <textarea className="input" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </section>

      {/* FOOTER */}
      <footer className="footer-bar">
        <button
          className="btn secondary"
          onClick={async () => {
            await commitDraftAndAdvanceCodeBestEffort();
            try {
              sessionStorage.setItem(RESET_ON_SHOW_KEY, '1');
            } catch {}
            router.push('/');
          }}
        >
          🏠 HOME
        </button>
        <button className="btn primary" onClick={handleContinue} disabled={photoUploading || savingContinue}>
          {savingContinue ? '⏳ DUKE RUJT...' : '▶ VAZHDO'}
        </button>
      </footer>

      {/* ✅ FULL SCREEN: TË PA PLOTSUARAT */}
      {showDraftsSheet && (
        <div className="payfs">
          <div className="payfs-top">
            <div>
              <div className="payfs-title">TË PA PLOTSUARAT</div>
              <div className="payfs-sub">HAP ose FSHI draftat</div>
            </div>
            <button className="btn secondary" onClick={() => setShowDraftsSheet(false)}>✕</button>
          </div>

          <div className="payfs-body">
            <div className="card" style={{ marginTop: 0 }}>
              {drafts.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '18px 0', color: 'rgba(255,255,255,0.7)' }}>
                  S’ka “të pa plotsuara”.
                </div>
              ) : (
                drafts.map((d) => (
                  <div
                    key={d.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '10px 4px',
                      borderBottom: '1px solid rgba(255,255,255,0.08)',
                    }}
                  >
                    <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                      <div
                        style={{
                          background: '#16a34a',
                          color: '#0b0b0b',
                          padding: '8px 10px',
                          borderRadius: 10,
                          fontWeight: 900,
                          minWidth: 56,
                          textAlign: 'center',
                        }}
                      >
                        {d.code || '—'}
                      </div>
                      <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.8)' }}>
                        <div style={{ fontWeight: 800 }}>KODI: {d.code || '—'}</div>
                        <div style={{ opacity: 0.85 }}>
                          {Number(d.m2 || 0).toFixed(2)} m² • {Number(d.euro || 0).toFixed(2)} €
                        </div>
                      </div>
                    </div>

                    <div style={{ display: 'flex', gap: 10 }}>
                      <button className="btn secondary" onClick={() => loadDraftIntoForm(d.id)}>HAP</button>
                      <button className="btn secondary" onClick={() => deleteDraft(d.id)}>FSHI</button>
                    </div>
                  </div>
                ))
              )}
            </div>

            <div style={{ height: 14 }} />
            <button className="btn secondary" style={{ width: '100%' }} onClick={() => setShowDraftsSheet(false)}>
              MBYLL
            </button>
          </div>
        </div>
      )}

      {/* ✅ FULL SCREEN: MESAZHI */}
      {showMsgSheet && (
        <div className="payfs">
          <div className="payfs-top">
            <div>
              <div className="payfs-title">DËRGO MESAZH</div>
              <div className="payfs-sub">VIBER / WHATSAPP / SMS</div>
            </div>
            <button className="btn secondary" onClick={closeMsgSheet}>✕</button>
          </div>

          <div className="payfs-body">
            <div className="card" style={{ marginTop: 0 }}>
              {/* ✅ toggle */}
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.8)', fontWeight: 900 }}>
                  AUTO PAS “VAZHDO”
                </div>
                <button
                  className="btn secondary"
                  style={{ padding: '6px 10px', fontSize: 11, borderRadius: 12 }}
                  onClick={toggleAutoMsg}
                >
                  {autoMsgAfterSave ? 'ON' : 'OFF'}
                </button>
              </div>

              <div className="tot-line" style={{ fontSize: 12, color: 'rgba(255,255,255,0.8)', marginTop: 10 }}>
                <strong>PREVIEW</strong>
              </div>

              <pre
                style={{
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  marginTop: 10,
                  fontSize: 12,
                  color: 'rgba(255,255,255,0.85)',
                  lineHeight: 1.35,
                }}
              >
                {buildStartMessage()}
              </pre>
            </div>

            <div className="card">
              <div className="row" style={{ gap: 10 }}>
                <button className="btn secondary" style={{ flex: 1 }} onClick={sendViaViber}>
                  VIBER
                </button>
                <button className="btn secondary" style={{ flex: 1 }} onClick={sendViaWhatsApp}>
                  WHATSAPP
                </button>
                <button className="btn secondary" style={{ flex: 1 }} onClick={sendViaSMS}>
                  SMS
                </button>
              </div>

              <div style={{ marginTop: 12, fontSize: 12, color: 'rgba(255,255,255,0.65)' }}>
                * Numri i kompanisë në fund: {COMPANY_PHONE_DISPLAY}
              </div>
            </div>

            <button className="btn secondary" style={{ width: '100%' }} onClick={closeMsgSheet}>
              MBYLL
            </button>
          </div>
        </div>
      )}

      {/* ✅ FULL SCREEN: NDËRRO QMIMIN (long-press 3s te € PAGESA) */}
      {showPriceSheet && (
        <div className="payfs">
          <div className="payfs-top">
            <div>
              <div className="payfs-title">NDËRRO QMIMIN</div>
              <div className="payfs-sub">€/m² (ruhet & sinkronizohet)</div>
            </div>
            <button className="btn secondary" onClick={() => setShowPriceSheet(false)}>✕</button>
          </div>

          <div className="payfs-body">
            <div className="card" style={{ marginTop: 0 }}>
              <div className="tot-line">QMIMI AKTUAL: <strong>{Number(pricePerM2 || 0).toFixed(2)} € / m²</strong></div>
              <div style={{ height: 10 }} />
              <label className="label">QMIMI I RI (€ / m²)</label>
              <input
                type="number"
                step="0.1"
                className="input"
                value={priceTmp}
                onChange={(e) => setPriceTmp(e.target.value === '' ? '' : Number(e.target.value))}
              />
              <div style={{ marginTop: 10, fontSize: 12, color: 'rgba(255,255,255,0.65)' }}>
                * Long-press 3 sek te “€ PAGESA” për me ardh këtu.
              </div>
            </div>
          </div>

          <div className="payfs-footer">
            <button className="btn secondary" onClick={() => setShowPriceSheet(false)}>ANULO</button>
            <button className="btn primary" onClick={savePriceAndClose}>RUJ</button>
          </div>
        </div>
      )}

      {/* FULL SCREEN PAGESA */}
      {showPaySheet && (
        <div className="payfs">
          <div className="payfs-top">
            <div>
              <div className="payfs-title">PAGESA</div>
              <div className="payfs-sub">
                KODI: {normalizeCode(codeRaw)} • {name || '—'}
              </div>
            </div>
            <button className="btn secondary" onClick={() => setShowPaySheet(false)}>✕</button>
          </div>

          <div className="payfs-body">
            <div className="card" style={{ marginTop: 0 }}>
              <div className="tot-line">TOTAL: <strong>{totalEuro.toFixed(2)} €</strong></div>
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
                  onChange={(e) => {
                    const v = e.target.value;
                    setPayAdd(v === '' ? 0 : Number(v));
                  }}
                  placeholder=""
                />

                <div className="chip-row" style={{ marginTop: 10 }}>
                  {PAY_CHIPS.map((v) => (
                    <button key={v} className="chip" type="button" onClick={() => setPayAdd(v)}>
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
            <button className="btn secondary" onClick={() => setShowPaySheet(false)}>ANULO</button>
            <button className="btn primary" onClick={applyPayAndClose}>RUJ PAGESËN</button>
          </div>
        </div>
      )}

      {/* SHKALLORE */}
      {showStairsSheet && (
        <div className="modal-overlay" onClick={() => setShowStairsSheet(false)}>
          <div className="modal-content dark" onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3 className="card-title" style={{ margin: 0, color: '#fff' }}>
                SHKALLORE
              </h3>
              <button className="btn secondary" onClick={() => setShowStairsSheet(false)}>✕</button>
            </div>

            <div className="field-group" style={{ marginTop: 12 }}>
              <label className="label" style={{ color: 'rgba(255,255,255,0.8)' }}>COPE</label>

              <div className="chip-row">
                {SHKALLORE_QTY_CHIPS.map((n) => (
                  <button
                    key={n}
                    className="chip"
                    type="button"
                    onClick={() => {
                      setStairsQty(n);
                      vibrateTap(15);
                    }}
                    style={Number(stairsQty) === n ? { outline: '2px solid rgba(255,255,255,0.35)' } : null}
                  >
                    {n}
                  </button>
                ))}
              </div>

              <input
                type="number"
                className="input"
                value={stairsQty === 0 ? '' : stairsQty}
                onChange={(e) => {
                  const v = e.target.value;
                  setStairsQty(v === '' ? 0 : Number(v));
                }}
                placeholder=""
                style={{ marginTop: 10 }}
              />
            </div>

            <div className="field-group">
              <label className="label" style={{ color: 'rgba(255,255,255,0.8)' }}>m² PËR COPË</label>

              <div className="chip-row">
                {SHKALLORE_PER_CHIPS.map((v) => (
                  <button
                    key={v}
                    className="chip"
                    type="button"
                    onClick={() => {
                      setStairsPer(v);
                      vibrateTap(15);
                    }}
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
                onChange={(e) => {
                  const v = e.target.value;
                  setStairsPer(v === '' ? 0 : Number(v));
                }}
                style={{ marginTop: 10 }}
              />
            </div>

            <div className="field-group">
              <label className="label" style={{ color: 'rgba(255,255,255,0.8)' }}>FOTO</label>
              <label className="camera-btn">
                📷
                <input type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => handleStairsPhotoChange(e.target.files?.[0])} />
              </label>

              {stairsPhotoUrl && (
                <div style={{ marginTop: 8 }}>
                  <img src={stairsPhotoUrl} className="photo-thumb" alt="" />
                  <button className="btn secondary" style={{ display: 'block', fontSize: 10, padding: '4px 8px', marginTop: 4 }} onClick={() => setStairsPhotoUrl('')}>
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

      {/* Styles */}
      
{/* ✅ WIZARD: KLIENTI + FOTOT (no accidental scroll taps) */}
{showWizard ? (
  <div className="wiz-backdrop" onClick={closeWizard}>
    <div className="wiz-card" onClick={(e) => e.stopPropagation()}>
      <div className="wiz-top">
        <div className="wiz-title">KLIENTI — WIZARD</div>
        <button type="button" className="wiz-x" onClick={closeWizard}>✕</button>
      </div>

      <div className="wiz-steps">
        <div className={`wiz-dot ${wizStep === 1 ? 'on' : ''}`}>1</div>
        <div className={`wiz-dot ${wizStep === 2 ? 'on' : ''}`}>2</div>
        <div className={`wiz-dot ${wizStep === 3 ? 'on' : ''}`}>3</div>
      </div>

      <div className="wiz-body">
        {wizStep === 1 ? (
          <div>
            <div className="wiz-h">HAPI 1 — KLIENTI</div>
            <div className="row" style={{ gap: 10, marginTop: 8 }}>
              <div className="pill on">KLIENTI I RI</div>
              <button
                type="button"
                className="pill"
                onClick={() => {
                  closeWizard();
                  setTimeout(() => {
                    try { document.getElementById('clientSearchInput')?.focus(); } catch {}
                  }, 180);
                }}
              >
                KLIENTI (KËRKO)
              </button>
            </div>

            <div className="field-group">
              <label className="label">EMRI & MBIEMRI</label>
              <div className="row" style={{ alignItems: 'center', gap: 10 }}>
                <input className="input" value={name} onChange={(e) => setName(e.target.value)} style={{ flex: 1 }} />
                {clientPhotoUrl ? <img src={clientPhotoUrl} alt="" className="client-mini" /> : null}
                <label className="camera-btn" title="FOTO KLIENTI" style={{ marginLeft: 2 }}>
                  📷
                  <input type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => handleClientPhotoChange(e.target.files?.[0])} />
                </label>
              </div>
              {clientPhotoUrl ? (
                <button type="button" className="btn secondary" style={{ display: 'block', fontSize: 10, padding: '4px 8px', marginTop: 8 }} onClick={() => setClientPhotoUrl('')}>
                  🗑️ FSHI FOTO
                </button>
              ) : null}
            </div>

            <div className="field-group">
              <label className="label">TELEFONI</label>
              <div className="row">
                <input className="input small" value={phonePrefix} readOnly />
                <input className="input" value={phone} onChange={(e) => setPhone(e.target.value)} />
              </div>
            </div>

            <div style={{ fontSize: 11, opacity: 0.75, marginTop: 6 }}>
              KËSHILLË: Mbush EMËR + TEL, pastaj vazhdo te FOTOT.
            </div>
          </div>
        ) : null}

        {wizStep === 2 ? (
          <div>
            <div className="wiz-h">HAPI 2 — FOTOT</div>

            <div className="wiz-tabs">
              <button type="button" className={`wiz-tab ${wizTab === 'TEPIHA' ? 'on' : ''}`} onClick={() => setWizTab('TEPIHA')}>TEPIHA</button>
              <button type="button" className={`wiz-tab ${wizTab === 'STAZA' ? 'on' : ''}`} onClick={() => setWizTab('STAZA')}>STAZA</button>
              <button type="button" className={`wiz-tab ${wizTab === 'SHKALLORE' ? 'on' : ''}`} onClick={() => setWizTab('SHKALLORE')}>SHKALLORE</button>
            </div>

            {wizTab === 'TEPIHA' ? (
              <div>
                <div className="chip-row modern">
                  {TEPIHA_CHIPS.map((v) => (
                    <button
                      key={`w_t_${v}`}
                      type="button"
                      className="chip chip-modern"
                      onPointerDown={(e) => tapDown(chipTapRef, e)}
                      onPointerMove={(e) => tapMove(chipTapRef, e)}
                      onPointerUp={(e) => guardedApplyChip('tepiha', v, e)}
                      style={chipStyleForVal(v, false)}
                    >
                      {v.toFixed(1)}
                    </button>
                  ))}
                </div>

                {tepihaRows.map((row) => (
                  <div className="piece-row" key={`w_tepiha_${row.id}`}>
                    <div className="row">
                      <input className="input small" type="number" value={row.m2} onChange={(e) => handleRowChange('tepiha', row.id, 'm2', e.target.value)} placeholder="m²" />
                      <input className="input small" type="number" value={row.qty} onChange={(e) => handleRowChange('tepiha', row.id, 'qty', e.target.value)} placeholder="copë" />
                      <label className="camera-btn">
                        📷
                        <input type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => handleRowPhotoChange('tepiha', row.id, e.target.files?.[0])} />
                      </label>
                    </div>
                    {row.photoUrl ? (
                      <div style={{ marginTop: 8 }}>
                        <img src={row.photoUrl} className="photo-thumb" alt="" />
                        <button type="button" className="btn secondary" style={{ display: 'block', fontSize: 10, padding: '4px 8px', marginTop: 4 }} onClick={() => handleRowChange('tepiha', row.id, 'photoUrl', '')}>
                          🗑️ FSHI FOTO
                        </button>
                      </div>
                    ) : null}
                  </div>
                ))}

                <div className="row btn-row">
                  <button type="button" className="btn secondary" onClick={() => addRow('tepiha')}>+ RRESHT</button>
                  <button type="button" className="btn secondary" onClick={() => removeRow('tepiha')}>− RRESHT</button>
                </div>
              </div>
            ) : null}

            {wizTab === 'STAZA' ? (
              <div>
                <div className="chip-row modern">
                  {STAZA_CHIPS.map((v) => (
                    <button
                      key={`w_s_${v}`}
                      type="button"
                      className="chip chip-modern"
                      onPointerDown={(e) => tapDown(chipTapRef, e)}
                      onPointerMove={(e) => tapMove(chipTapRef, e)}
                      onPointerUp={(e) => guardedApplyChip('staza', v, e)}
                      style={chipStyleForVal(v, false)}
                    >
                      {v.toFixed(1)}
                    </button>
                  ))}
                </div>

                {stazaRows.map((row) => (
                  <div className="piece-row" key={`w_staza_${row.id}`}>
                    <div className="row">
                      <input className="input small" type="number" value={row.m2} onChange={(e) => handleRowChange('staza', row.id, 'm2', e.target.value)} placeholder="m²" />
                      <input className="input small" type="number" value={row.qty} onChange={(e) => handleRowChange('staza', row.id, 'qty', e.target.value)} placeholder="copë" />
                      <label className="camera-btn">
                        📷
                        <input type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => handleRowPhotoChange('staza', row.id, e.target.files?.[0])} />
                      </label>
                    </div>
                    {row.photoUrl ? (
                      <div style={{ marginTop: 8 }}>
                        <img src={row.photoUrl} className="photo-thumb" alt="" />
                        <button type="button" className="btn secondary" style={{ display: 'block', fontSize: 10, padding: '4px 8px', marginTop: 4 }} onClick={() => handleRowChange('staza', row.id, 'photoUrl', '')}>
                          🗑️ FSHI FOTO
                        </button>
                      </div>
                    ) : null}
                  </div>
                ))}

                <div className="row btn-row">
                  <button type="button" className="btn secondary" onClick={() => addRow('staza')}>+ RRESHT</button>
                  <button type="button" className="btn secondary" onClick={() => removeRow('staza')}>− RRESHT</button>
                </div>
              </div>
            ) : null}

            {wizTab === 'SHKALLORE' ? (
              <div>
                <div className="field-group">
                  <label className="label">SHKALLORE — COPË</label>
                  <div className="chip-row modern">
                    {SHKALLORE_QTY_CHIPS.map((n) => (
                      <button
                        key={`w_q_${n}`}
                        type="button"
                        className="chip chip-modern"
                        onPointerDown={(e) => tapDown(chipTapRef, e)}
                        onPointerMove={(e) => tapMove(chipTapRef, e)}
                        onPointerUp={() => { if (isRealTap(chipTapRef)) setStairsQty(String(n)); }}
                        style={chipStyleForVal(2.5, false)}
                      >
                        {n}
                      </button>
                    ))}
                  </div>
                  <input className="input" type="number" value={stairsQty} onChange={(e) => setStairsQty(e.target.value)} placeholder="p.sh. 20" />
                </div>

                <div className="field-group">
                  <label className="label">SHKALLORE — m² PËR COPË</label>
                  <div className="chip-row modern">
                    {SHKALLORE_PER_CHIPS.map((n) => (
                      <button
                        key={`w_p_${n}`}
                        type="button"
                        className="chip chip-modern"
                        onPointerDown={(e) => tapDown(chipTapRef, e)}
                        onPointerMove={(e) => tapMove(chipTapRef, e)}
                        onPointerUp={() => { if (isRealTap(chipTapRef)) setStairsPer(String(n)); }}
                        style={chipStyleForVal(3.0, false)}
                      >
                        {Number(n).toFixed(2)}
                      </button>
                    ))}
                  </div>
                  <input className="input" type="number" value={stairsPer} onChange={(e) => setStairsPer(e.target.value)} placeholder="p.sh. 0.30" />
                </div>

                <div className="field-group">
                  <label className="label">FOTO SHKALLORE</label>
                  <div className="row" style={{ alignItems: 'center', gap: 10 }}>
                    <label className="camera-btn">
                      📷
                      <input type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => handleStairsPhotoChange(e.target.files?.[0])} />
                    </label>
                    {stairsPhotoUrl ? <img src={stairsPhotoUrl} className="photo-thumb" alt="" style={{ height: 54, width: 78, objectFit: 'cover' }} /> : <div style={{ fontSize: 11, opacity: 0.7 }}>PA FOTO</div>}
                    {stairsPhotoUrl ? (
                      <button type="button" className="btn secondary" style={{ marginLeft: 'auto', fontSize: 10, padding: '6px 10px' }} onClick={() => setStairsPhotoUrl('')}>
                        🗑️ FSHI
                      </button>
                    ) : null}
                  </div>
                </div>
              </div>
            ) : null}

          </div>
        ) : null}

        {wizStep === 3 ? (
          <div>
            <div className="wiz-h">HAPI 3 — GATI</div>
            <div style={{ fontSize: 12, opacity: 0.85, lineHeight: 1.4 }}>
              • Emri: <b>{String(name || '').trim() || '—'}</b><br/>
              • Tel: <b>{phonePrefix}{String(phone || '').trim() || '—'}</b><br/>
              • m² total: <b>{Number(totalM2 || 0).toFixed(2)}</b><br/>
              • Totali: <b>€{Number(totalEuro || 0).toFixed(2)}</b>
            </div>

            <div className="row" style={{ gap: 10, marginTop: 12 }}>
              <button type="button" className="btn secondary" style={{ flex: 1 }} onClick={openPay}>€ PAGESA</button>
              <button type="button" className="btn" style={{ flex: 1 }} onClick={closeWizard}>MBYLL</button>
            </div>
          </div>
        ) : null}
      </div>

      <div className="wiz-actions">
        <button type="button" className="btn secondary" onClick={wizBack} disabled={wizStep === 1}>MBRAPA</button>
        <button type="button" className="btn" onClick={wizStep === 3 ? handleContinue : wizNext} disabled={photoUploading || savingContinue}>{wizStep === 3 ? (savingContinue ? '⏳ DUKE RUJT...' : 'RUAJ & VAZHDO') : 'VAZHDO'}</button>
      </div>
    </div>
  </div>
) : null}

<style jsx>{`
        .client-mini{
          width: 34px;
          height: 34px;
          border-radius: 999px;
          object-fit: cover;
          border: 1px solid rgba(255,255,255,0.18);
          box-shadow: 0 6px 14px rgba(0,0,0,0.35);
        }

        .cap-mini {
          margin-top: 8px;
          padding: 10px 12px;
          border-radius: 16px;
          background: #0b0b0b;
          border: 1px solid rgba(255,255,255,0.1);
        }
        .cap-mini-top {
          display: flex;
          justify-content: space-between;
          align-items: baseline;
        }
        .cap-mini-title {
          font-size: 10px;
          letter-spacing: 0.7px;
          color: rgba(255,255,255,0.65);
          font-weight: 900;
        }
        .cap-mini-val {
          font-size: 12px;
          color: #16a34a;
          font-weight: 900;
        }
        .cap-mini-eta {
          margin-top: 6px;
          font-size: 12px;
          color: rgba(255,255,255,0.85);
          font-weight: 800;
        }

        .chip-row.modern {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
          margin-top: 8px;
        }

        .chip-modern {
          padding: 10px 14px;
          border-radius: 14px;
          font-weight: 900;
          letter-spacing: 0.2px;
          color: rgba(255,255,255,0.92);
          backdrop-filter: blur(8px);
        }
        .chip-modern:active {
          transform: translateY(1px);
        }

        .chip-bump {
          animation: chipBump 140ms ease-in-out;
        }
        @keyframes chipBump {
          0% { transform: translateY(0) scale(1); }
          40% { transform: translateY(1px) scale(0.98); }
          70% { transform: translateY(0) scale(1.02); }
          100% { transform: translateY(0) scale(1); }
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
      
/* WIZARD */
.wiz-backdrop{
  position:fixed; inset:0;
  background: rgba(0,0,0,0.72);
  display:flex; align-items:center; justify-content:center;
  z-index:9999;
  padding: 14px;
}
.pill{
          border: 1px solid rgba(255,255,255,0.14);
          background: rgba(255,255,255,0.06);
          color: rgba(255,255,255,0.9);
          padding: 10px 12px;
          border-radius: 14px;
          font-weight: 900;
          letter-spacing: 0.4px;
          font-size: 11px;
        }
        .pill.on{
          background: rgba(34,197,94,0.16);
          border-color: rgba(34,197,94,0.28);
          color: rgba(255,255,255,0.95);
        }

.wiz-card{
  width: min(92vw, 560px);
  max-height: 88vh;
  overflow: hidden;
  background:#0b0f14;
  border:1px solid rgba(255,255,255,0.14);
  border-radius: 16px;
  box-shadow: 0 20px 60px rgba(0,0,0,0.55);
  display:flex;
  flex-direction: column;
}
.wiz-top{
  display:flex; align-items:center; justify-content:space-between;
  padding: 12px 12px 8px 12px;
  border-bottom: 1px solid rgba(255,255,255,0.08);
}
.wiz-title{ font-weight: 900; letter-spacing: .08em; }
.wiz-x{
  background: transparent;
  border: 0;
  color: #fff;
  font-size: 18px;
  padding: 8px 10px;
}
.wiz-steps{
  display:flex; gap: 8px;
  padding: 10px 12px;
}
.wiz-dot{
  width: 28px; height: 28px;
  border-radius: 999px;
  display:flex; align-items:center; justify-content:center;
  font-weight: 900;
  border: 1px solid rgba(255,255,255,0.22);
  opacity: .65;
}
.wiz-dot.on{
  opacity: 1;
  border-color: rgba(34,197,94,0.8);
  box-shadow: 0 0 0 2px rgba(34,197,94,0.18);
}
.wiz-body{
  flex:1;
  overflow:auto;
  padding: 12px;
}
.wiz-h{
  font-weight: 900;
  letter-spacing: .06em;
  margin-bottom: 10px;
}
.wiz-tabs{
  display:flex;
  gap: 8px;
  margin-bottom: 10px;
}
.wiz-tab{
  flex:1;
  padding: 10px 10px;
  border-radius: 12px;
  border: 1px solid rgba(255,255,255,0.12);
  background: transparent;
  color: #fff;
  font-weight: 900;
  letter-spacing: .06em;
  opacity: .85;
}
.wiz-tab.on{
  opacity: 1;
  background: rgba(59,130,246,0.18);
  border-color: rgba(59,130,246,0.35);
}
.wiz-actions{
  display:flex;
  gap: 10px;
  padding: 12px;
  border-top: 1px solid rgba(255,255,255,0.08);
  background: #0b0b0b;
}
.wiz-actions .btn{
  flex:1;
}
`}</style>
    </div>
  );
}
