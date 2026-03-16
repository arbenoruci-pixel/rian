"use client";

import {
  normalizeCode,
  reserveSharedCode,
  ensureBasePool,
  markCodeUsed,
} from '@/lib/baseCodes';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient';
import { saveOrderLocal } from '@/lib/offlineStore';
import { fetchOrdersFromDb, fetchClientsFromDb } from '@/lib/ordersDb';
import { enqueueBaseOrder, syncNow } from '@/lib/syncManager';
import { recordCashMove } from '@/lib/arkaCashSync';
import PosModal from '@/components/PosModal';
import { getActor } from '@/lib/actorSession';
import { requirePaymentPin } from '@/lib/paymentPin';

const BUCKET = 'tepiha-photos';

const TEPIHA_CHIPS = [2.0, 2.5, 3.0, 3.2, 3.5, 3.7, 6.0];
const STAZA_CHIPS = [1.5, 2.0, 2.2, 3.0];

const SHKALLORE_QTY_CHIPS = [5, 10, 15, 20, 25, 30];
const SHKALLORE_PER_CHIPS = [0.25, 0.3, 0.35, 0.4];

const SHKALLORE_M2_PER_STEP_DEFAULT = 0.3;
const PRICE_DEFAULT = 3.0;
const PAY_CHIPS = [5, 10, 20, 30, 50];
const DAILY_CAPACITY_M2 = 400;
const DRAFT_LIST_KEY = 'draft_orders_v1';
const DRAFT_ITEM_PREFIX = 'draft_order_';
const COMPANY_PHONE_DISPLAY = '+383 44 735 312';
const COMPANY_PHONE_RAW = '+383447353312';
const AUTO_MSG_KEY = 'pranimi_auto_msg_after_save';
const PRICE_KEY = 'pranimi_price_per_m2';
const OFFLINE_MODE_KEY = 'tepiha_offline_mode_v1';
const OFFLINE_QUEUE_KEY = 'tepiha_offline_queue_v1';
const LS_BASE_EPOCH_KEY = 'tepiha_base_epoch_v1';
const LS_BASE_POOL_PREFIX = 'base_code_pool:';
const LS_BASE_USED_QUEUE_PREFIX = 'base_code_used_queue:';
const LS_BASE_ORDER_CODE_PREFIX = 'base_order_code:';
const APP_META_KEY = 'global';
const DRAFTS_FOLDER = 'drafts';
const SETTINGS_FOLDER = 'settings';
const LOCK_MINUTES_AFTER_INFO = 60 * 24 * 365 * 10;

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

function extractDigitsFromFilename(name) {
  if (!name) return null;
  const m = String(name).match(/\d+/);
  if (!m) return null;
  return parseInt(m[0], 10);
}

function chipStyleForVal(v, active) {
  const n = Number(v);

  let a = 'rgba(59,130,246,0.18)';
  let b = 'rgba(59,130,246,0.06)';
  let br = 'rgba(59,130,246,0.35)';

  if (n >= 5.8) {
    a = 'rgba(249,115,22,0.20)';
    b = 'rgba(249,115,22,0.08)';
    br = 'rgba(249,115,22,0.38)';
  } else if (Math.abs(n - 3.2) < 0.051) {
    a = 'rgba(239,68,68,0.20)';
    b = 'rgba(239,68,68,0.08)';
    br = 'rgba(239,68,68,0.38)';
  } else if (n >= 3.5) {
    a = 'rgba(236,72,153,0.18)';
    b = 'rgba(236,72,153,0.06)';
    br = 'rgba(236,72,153,0.35)';
  } else if (n >= 2.2) {
    a = 'rgba(245,158,11,0.18)';
    b = 'rgba(245,158,11,0.06)';
    br = 'rgba(245,158,11,0.35)';
  } else {
    a = 'rgba(168,85,247,0.18)';
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

function safeJsonParse(s, fallback) {
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

async function fetchBaseDbEpoch() {
  try {
    const { data, error } = await supabase
      .from('app_meta')
      .select('db_epoch')
      .eq('key', APP_META_KEY)
      .maybeSingle();
    if (error) throw error;
    const n = Number(data?.db_epoch || 0);
    return Number.isFinite(n) && n > 0 ? n : 1;
  } catch {
    return null;
  }
}

function clearPranimiLocalDraftsAndCodeState(pin = '') {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    const p = String(pin || '').trim();
    const toRemove = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (!k) continue;
      if (
        k === DRAFT_LIST_KEY ||
        k.startsWith(DRAFT_ITEM_PREFIX) ||
        k.startsWith(LS_BASE_ORDER_CODE_PREFIX) ||
        (p && k === `${LS_BASE_POOL_PREFIX}${p}`) ||
        (p && k === `${LS_BASE_USED_QUEUE_PREFIX}${p}`)
      ) {
        toRemove.push(k);
      }
    }
    toRemove.forEach((k) => {
      try { window.localStorage.removeItem(k); } catch {}
    });
  } catch {}
}

async function ensureFreshPranimiEpoch(pin = '') {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return false;
    const dbEpoch = await fetchBaseDbEpoch();
    if (!dbEpoch) return false;
    const localEpoch = Number(window.localStorage.getItem(LS_BASE_EPOCH_KEY) || '0');
    if (!localEpoch || localEpoch !== dbEpoch) {
      clearPranimiLocalDraftsAndCodeState(pin);
      try { window.localStorage.setItem(LS_BASE_EPOCH_KEY, String(dbEpoch)); } catch {}
      return true;
    }
    return false;
  } catch {
    return false;
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

    let totalM2 = 0;
    (d.tepihaRows || []).forEach(r => totalM2 += (Number(r.m2) || 0) * (Number(r.qty) || 0));
    (d.stazaRows || []).forEach(r => totalM2 += (Number(r.m2) || 0) * (Number(r.qty) || 0));
    totalM2 += (Number(d.stairsQty) || 0) * (Number(d.stairsPer) || 0);
    
    const euro = Number((totalM2 * (Number(d.pricePerM2) || PRICE_DEFAULT)).toFixed(2));

    out.push({
      id: d.id,
      ts: d.ts || 0,
      code: formatKod(normalizeCode(d.codeRaw || d.code || ''), true),
      m2: totalM2,
      euro,
    });
  });

  await Promise.allSettled(tasks);
  out.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  return out;
}

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

function ensureCodePair(obj){
  const n = Number(obj?.code ?? obj?.code_n ?? 0) || 0;
  const code = obj?.code != null ? String(obj.code) : (n ? String(n) : null);
  const out = { ...obj, code };
  if ('code_n' in out) delete out.code_n;
  return out;
}

function formatKod(v, isOnline){
  const s = v == null ? "" : String(v).trim();
  if (s && s !== "null" && s !== "undefined") return s;
  return isOnline ? "…" : "—";
}

export default function PranimiPage() {
  const actor = getActor();
  const router = useRouter();
  const phonePrefix = '+383';

  const [creating, setCreating] = useState(true);
  const [photoUploading, setPhotoUploading] = useState(false);
  const [savingContinue, setSavingContinue] = useState(false);

  const [oid, setOid] = useState('');
  const [codeRaw, setCodeRaw] = useState('');

  const [drafts, setDrafts] = useState([]);
  const [showDraftsSheet, setShowDraftsSheet] = useState(false);

  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [clientPhotoUrl, setClientPhotoUrl] = useState('');

  const [clientQuery, setClientQuery] = useState('');
  const [clientsIndex, setClientsIndex] = useState([]);
  const [clientHits, setClientHits] = useState([]);
  const [clientsLoading, setClientsLoading] = useState(false);

  const [tepihaRows, setTepihaRows] = useState([]);
  const [stazaRows, setStazaRows] = useState([]);

  const [stairsQty, setStairsQty] = useState(0);
  const [stairsPer, setStairsPer] = useState(SHKALLORE_M2_PER_STEP_DEFAULT);
  const [stairsPhotoUrl, setStairsPhotoUrl] = useState('');

  const [pricePerM2, setPricePerM2] = useState(PRICE_DEFAULT);
  const [clientPaid, setClientPaid] = useState(0);
  const [arkaRecordedPaid, setArkaRecordedPaid] = useState(0);
  const [payMethod, setPayMethod] = useState('CASH');

  const [showPaySheet, setShowPaySheet] = useState(false);
  const [showStairsSheet, setShowStairsSheet] = useState(false);
  const [showStairsArea, setShowStairsArea] = useState(false);
  const [showMsgSheet, setShowMsgSheet] = useState(false);

  const [autoMsgAfterSave, setAutoMsgAfterSave] = useState(true);
  const [pendingNavTo, setPendingNavTo] = useState('');

  const [showPriceSheet, setShowPriceSheet] = useState(false);
  const [priceTmp, setPriceTmp] = useState(PRICE_DEFAULT);

  const [payAdd, setPayAdd] = useState(0);
  const [notes, setNotes] = useState('');

  const [offlineMode, setOfflineMode] = useState(false);
  const [netState, setNetState] = useState({ ok: true, reason: '' });
  const [showOfflinePrompt, setShowOfflinePrompt] = useState(false);
  const [epochReady, setEpochReady] = useState(false);

  const RESET_ON_SHOW_KEY = 'tepiha_pranimi_reset_on_show_v1';

  async function resetForNewOrder() {
    try {
      setCreating(true);
      const id = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `ord_${Date.now()}`;
      setOid(id);

      let urlCode = '';
      let urlName = '';
      let urlPhone = '';
      if (typeof window !== 'undefined') {
        const params = new URLSearchParams(window.location.search);
        urlCode = params.get('code') || '';
        urlName = params.get('name') || '';
        urlPhone = params.get('phone') || '';
      }

      const permanentCode = String(normalizeCode(urlCode || '') || '').trim();

      if (permanentCode) {
        setCodeRaw(permanentCode);
        try {
          const online = typeof navigator === 'undefined' ? true : navigator.onLine;
          setNetState({ ok: !!online, reason: online ? null : 'OFFLINE' });
        } catch {}
        try { setShowOfflinePrompt(false); } catch {}
      } else {
        try {
          const c = await reserveSharedCode(id);
          setCodeRaw(String(c));
          try { setNetState({ ok: true, reason: null }); } catch {}
          try { localStorage.removeItem(OFFLINE_MODE_KEY); } catch {}
          try { setOfflineMode(false); } catch {}
          try { setShowOfflinePrompt(false); } catch {}
        } catch (e) {
          setCodeRaw('');
          setNetState({ ok: false, reason: 'CODE_RESERVE_FAILED' });
          setShowOfflinePrompt(true);
          try { localStorage.setItem(OFFLINE_MODE_KEY, '1'); } catch {}
          setOfflineMode(true);
        }
      }

      setName(urlName ? String(urlName) : '');
      if (urlPhone) {
        let p = String(urlPhone).trim();
        if (p.startsWith('+383')) p = p.slice(4);
        setPhone(p.replace(/\D+/g, ''));
      } else {
        setPhone('');
      }
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

      setSavingContinue(false);
      setPhotoUploading(false);
    } catch {
    } finally {
      setCreating(false);
    }
  }

  useEffect(() => {
    try {
      const init = loadOfflineModeInit();
      setOfflineMode(init);
    } catch {}

    let alive = true;

    (async () => {
      try {
        const activePin = actor?.pin || actor?.pinCode || actor?.id || '2380';
        const epochChanged = await ensureFreshPranimiEpoch(activePin);
        if (!alive) return;

        if (epochChanged) {
          try { setDrafts([]); } catch {}
          try { setOid(''); } catch {}
          try { setCodeRaw(''); } catch {}
          try { setName(''); } catch {}
          try { setPhone(''); } catch {}
          try { setClientPhotoUrl(''); } catch {}
          try { setTepihaRows([]); } catch {}
          try { setStazaRows([]); } catch {}
          try { setStairsQty(0); } catch {}
          try { setStairsPer(SHKALLORE_M2_PER_STEP_DEFAULT); } catch {}
          try { setStairsPhotoUrl(''); } catch {}
          try { setClientPaid(0); } catch {}
          try { setArkaRecordedPaid(0); } catch {}
          try { setNotes(''); } catch {}
          try { setShowDraftsSheet(false); } catch {}
        }

        try {
          if (typeof navigator !== 'undefined' && navigator.onLine) {
            try {
              await ensureBasePool(activePin);
            } catch {}
            try { localStorage.removeItem(OFFLINE_MODE_KEY); } catch {}
            try { setOfflineMode(false); } catch {}
            try { setShowOfflinePrompt(false); } catch {}
            try { setNetState({ ok: true, reason: null }); } catch {}
          }
        } catch {}

        try { if (!oid) { await resetForNewOrder(); } } catch {}
      } finally {
        if (alive) setEpochReady(true);
      }
    })();

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

  const [etaText, setEtaText] = useState('GATI DITËN E 2-TË (NESËR)');
  const [todayPastrimM2, setTodayPastrimM2] = useState(0);

  const draftTimer = useRef(null);
  const payHoldTimerRef = useRef(null);
  const payHoldTriggeredRef = useRef(false);

  const payTapRef = useRef({ sx: 0, sy: 0, moved: false, t0: 0 });
  const chipTapRef = useRef({ sx: 0, sy: 0, moved: false, t0: 0 });

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
    if (!isRealTap(chipTapRef)) return;
    applyChip(kind, val, ev);
  }

  const [showWizard, setShowWizard] = useState(false);
  const [wizStep, setWizStep] = useState(1);
  const [wizTab, setWizTab] = useState('TEPIHA');

  function openWizard() {
    setWizStep(1);
    setWizTab('TEPIHA');
    setShowWizard(true);
  }
  function closeWizard() { setShowWizard(false); }
  function wizNext() { setWizStep((s) => Math.min(5, s + 1)); }
  function wizBack() { setWizStep((s) => Math.max(1, s - 1)); }

  async function refreshDrafts() {
    try {
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

  async function loadClientsIndexOnce() {
    if (clientsLoading) return;
    if (clientsIndex && clientsIndex.length) return;

    setClientsLoading(true);
    try {
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

      const clients = await fetchClientsFromDb(10000);
      const orders = await fetchOrdersFromDb(10000);

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
    void loadClientsIndexOnce();
  }, []);

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

    return () => { alive = false; };
  }, [clientQuery, clientsIndex]);

  useEffect(() => {
    if (!epochReady) return;
    (async () => {
      try { await refreshDrafts(); } catch {}

      try {
        const a = localStorage.getItem(AUTO_MSG_KEY);
        if (a === '0') setAutoMsgAfterSave(false);
        if (a === '1') setAutoMsgAfterSave(true);
      } catch {}

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

      try {
        const cached = Number(localStorage.getItem('capacity_today_pastrim_m2') || '0');
        const text = localStorage.getItem('capacity_eta_text');
        setTodayPastrimM2(Number.isFinite(cached) ? cached : 0);
        setEtaText(text || (cached > DAILY_CAPACITY_M2 ? 'GATI DITËN E 3-TË (MBASNESËR)' : 'GATI DITËN E 2-TË (NESËR)'));
      } catch {}
    })();
  }, [epochReady]);

  useEffect(() => {
    try { router?.prefetch?.('/pastrimi'); } catch {}
  }, [router]);

  const totalM2 = useMemo(() => {
    let t = 0, s = 0;
    (tepihaRows || []).forEach(r => { t += (Number(r.m2) || 0) * (Number(r.qty) || 0); });
    (stazaRows || []).forEach(r => { s += (Number(r.m2) || 0) * (Number(r.qty) || 0); });
    const sh = (Number(stairsQty) || 0) * (Number(stairsPer) || 0);
    return Number((t + s + sh).toFixed(2));
  }, [tepihaRows, stazaRows, stairsQty, stairsPer]);
  
  const totalEuro = useMemo(() => Number((totalM2 * (Number(pricePerM2) || 0)).toFixed(2)), [totalM2, pricePerM2]);
  const diff = useMemo(() => Number((totalEuro - Number(clientPaid || 0)).toFixed(2)), [totalEuro, clientPaid]);
  const currentDebt = diff > 0 ? diff : 0;
  const currentChange = diff < 0 ? Math.abs(diff) : 0;

  const copeCount = useMemo(() => {
    const t = tepihaRows.reduce((a, b) => a + (Number(b.qty) || 0), 0);
    const s = stazaRows.reduce((a, b) => a + (Number(b.qty) || 0), 0);
    const sh = Number(stairsQty) || 0;
    return t + s + sh;
  }, [tepihaRows, stazaRows, stairsQty]);

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

      try { if (draftTimer.current) clearTimeout(draftTimer.current); } catch {}

      const draft = buildDraftSnapshot();

      try { upsertDraftLocal(draft); } catch {}
      try { void upsertDraftRemote(draft); } catch {}
      try { void refreshDrafts(); } catch {}

      const n = Number(normalizeCode(codeRaw));
      if (Number.isFinite(n) && n > 0) {
        try { await markCodeUsed(n, oid); } catch {}
}
    } catch {}
  }

  useEffect(() => {
    if (creating) return;
    if (!oid) return;

    if (draftTimer.current) clearTimeout(draftTimer.current);

    draftTimer.current = setTimeout(() => {
      try {
        const draft = buildDraftSnapshot();
        if (hasStartedWork()) {
          upsertDraftLocal(draft);
          upsertDraftRemote(draft).finally(() => { void refreshDrafts(); });
        }
      } catch {}
    }, 700);

    return () => { if (draftTimer.current) clearTimeout(draftTimer.current); };
  }, [creating, oid, codeRaw, name, phone, clientPhotoUrl, tepihaRows, stazaRows, stairsQty, stairsPer, stairsPhotoUrl, pricePerM2, clientPaid, arkaRecordedPaid, payMethod, notes]);

  function addRow(kind) {
    const setter = kind === 'tepiha' ? setTepihaRows : setStazaRows;
    const prefix = kind === 'tepiha' ? 't' : 's';
    setter((rows) => [...rows, { id: `${prefix}${rows.length + 1}`, m2: '', qty: '0', photoUrl: '' }]);
  }

  function removeRow(kind) {
    const setter = kind === 'tepiha' ? setTepihaRows : setStazaRows;
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
    try { if (typeof navigator !== 'undefined' && navigator.vibrate) navigator.vibrate(ms); } catch {}
  }

  function bumpEl(el) {
    try {
      if (!el) return;
      el.classList.remove('chip-bump');
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
    try { localStorage.setItem(PRICE_KEY, String(v)); } catch {}
    try { await writeSharedPrice(v); } catch {}
    setShowPriceSheet(false);
  }

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
    if (payTapRef.current?.moved) { payHoldTriggeredRef.current = false; return; }
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
    const due = Math.max(0, Number((Number(totalEuro || 0) - Number(clientPaid || 0)).toFixed(2)));
    if (due <= 0) { alert('KJO POROSI ËSHTË E PAGUAR PLOTËSISHT.'); return; }
    if (cashGiven < due) { alert('KLIENTI DHA MË PAK SE BORXHI! JU LUTEM PLOTËSONI SHUMËN OSE ANULONI.'); return; }

    const applied = due;
    const kusuri = Math.max(0, cashGiven - due);
    const pinLabel = `PAGESË: ${applied.toFixed(2)}€\nKLIENTI DHA: ${cashGiven.toFixed(2)}€\nKUSURI (RESTO): ${kusuri.toFixed(2)}€\n\n👉 SHKRUAJ PIN-IN TËND PËR TË KRYER PAGESËN:`;

    const pinData = await requirePaymentPin({ label: pinLabel });
    if (!pinData) return;

    const newPaid = Number((Number(clientPaid || 0) + applied).toFixed(2));
    setClientPaid(newPaid);
    if (payMethod === 'CASH') {
      setArkaRecordedPaid(Number((Number(arkaRecordedPaid || 0) + applied).toFixed(2)));
    }
    setShowPaySheet(false);

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
      } catch {}
    })();
  }

  function validateBeforeContinue() {
    if (!name.trim()) return alert('Shkruaj emrin dhe mbiemrin.'), false;
    if (name.trim().split(/\s+/).length < 2) return alert('Shkruaj edhe mbiemrin.'), false;

    const ph = sanitizePhone(phonePrefix + phone);
    if (!ph || ph.length < 6) return alert('Shkruaj një numër telefoni të vlefshëm.'), false;

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
    try { return localStorage.getItem(OFFLINE_MODE_KEY) === '1'; } catch { return false; }
  }

  async function checkConnectivity() {
    try {
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return { ok: false, reason: 'NO_INTERNET' };
      await supabase.auth.getSession();
      return { ok: true, reason: '' };
    } catch { return { ok: false, reason: 'FETCH_FAILED' }; }
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
    } catch { return false; }
  }

  async function handleContinue() {
    if (!validateBeforeContinue()) return;
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
          code: formatKod(normalizeCode(codeRaw), netState.ok),
          photoUrl: clientPhotoUrl || '',
        },
        tepiha: tepihaRows.map((r) => ({ m2: Number(r.m2) || 0, qty: Number(r.qty) || 0, photoUrl: r.photoUrl || '' })),
        staza: stazaRows.map((r) => ({ m2: Number(r.m2) || 0, qty: Number(r.qty) || 0, photoUrl: r.photoUrl || '' })),
        shkallore: { qty: Number(stairsQty) || 0, per: Number(stairsPer) || 0, photoUrl: stairsPhotoUrl || '' },
        tepihaRows: tepihaRows.map((r) => ({ m2: Number(r.m2) || 0, qty: Number(r.qty) || 0, photoUrl: r.photoUrl || '' })),
        stazaRows: stazaRows.map((r) => ({ m2: Number(r.m2) || 0, qty: Number(r.qty) || 0, photoUrl: r.photoUrl || '' })),
        stairsQty: Number(stairsQty) || 0,
        stairsPer: Number(stairsPer) || 0,
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

      const normCodeNow = formatKod(normalizeCode(codeRaw), netState.ok);
      const outboxRow = {
        code: Number(normCodeNow || 0) || null,
        local_oid: String(oid),
        status: 'pastrim',
        client_name: name || null,
        client_phone: String(phone || ''),
        total: Number(totalEuro || 0),
        paid: Number(clientPaid || 0),
        data: order,
        updated_at: new Date().toISOString(),
      };

      if (!normCodeNow || normCodeNow === '0') {
        const conn = await checkConnectivity();
        const browserOffline = (typeof navigator !== 'undefined' && navigator.onLine === false);
        if (!browserOffline && conn?.ok) {
          setNetState({ ok: false, reason: 'CODE_MISSING_ONLINE' });
          setShowOfflinePrompt(true);
          alert('❌ NUK U MOR KOD NGA DB (ONLINE). Provo “PROVO PRAP” ose kontrollo RPC/RLS në Supabase.');
          setSavingContinue(false);
          return;
        }

        const ok = saveOfflineQueueItem(order);
        try { localStorage.setItem(OFFLINE_MODE_KEY, '1'); } catch {}
        setOfflineMode(true);
        if (!ok) { alert('❌ S’KEMI KOD + OFFLINE: nuk u ruajt lokalisht!'); setSavingContinue(false); return; }
        alert('⚠️ S’MORI KOD NGA SERVERI. U RUAJT OFFLINE. Provo prap kur të ketë lidhje.');
        try { sessionStorage.setItem(RESET_ON_SHOW_KEY, '1'); } catch {}
        setSavingContinue(false);
        router.push('/pastrimi');
        return;
      }

      const conn = await checkConnectivity();
      const browserOffline = (typeof navigator !== 'undefined' && navigator.onLine === false);
      if (offlineMode || (browserOffline && !conn.ok)) {
        const ok = saveOfflineQueueItem(order);
        try { saveOrderLocal(order); } catch {}
        try { enqueueBaseOrder(outboxRow); } catch {}
        try { localStorage.setItem(OFFLINE_MODE_KEY, '1'); } catch {}
        setOfflineMode(true);
        if (!ok) { alert('❌ OFFLINE: nuk u ruajt lokalisht!'); setSavingContinue(false); return; }
        alert('✅ U RUAJT OFFLINE. Kur të kthehet interneti, do të sinkronizohet automatikisht.');
        try { sessionStorage.setItem(RESET_ON_SHOW_KEY, '1'); } catch {}
        setSavingContinue(false);
        router.push('/pastrimi');
        return;
      }

      try {
        enqueueBaseOrder(outboxRow);
        await syncNow();
      } catch {
        try { enqueueBaseOrder(outboxRow); } catch {}
        try { localStorage.setItem(OFFLINE_MODE_KEY, '1'); } catch {}
        setOfflineMode(true);
        alert('⚠️ SERVERI DËSHTOI. U RUAJT LOKALISHT (SYNC MË VONË).');
        try { sessionStorage.setItem(RESET_ON_SHOW_KEY, '1'); } catch {}
        setSavingContinue(false);
        router.push('/pastrimi');
        return;
      }

      try { localStorage.setItem(`order_${oid}`, JSON.stringify(order)); } catch {}
      
      void (async () => {
        try {
          const blob = new Blob([JSON.stringify(order)], { type: 'application/json' });
          await supabase.storage.from(BUCKET).upload(`orders/${oid}.json`, blob, {
            upsert: true, cacheControl: '0', contentType: 'application/json',
          });
        } catch {}
        try { removeDraftLocal(oid); } catch {}
        try { await deleteDraftRemote(oid); } catch {}
        try {
          const codeToFinalize = order?.client?.code;
          if (codeToFinalize !== null && codeToFinalize !== undefined && String(codeToFinalize).trim() !== '') {
}
        } catch {}
      })();

      try { sessionStorage.setItem(RESET_ON_SHOW_KEY, '1'); } catch {}

      if (autoMsgAfterSave) {
        setPendingNavTo('/pastrimi');
        setShowWizard(false);
        setShowMsgSheet(true);
        setSavingContinue(false);
        return;
      }

      setSavingContinue(false);
      router.push('/pastrimi');
    } catch {
      alert(`❌ RUJTJA DËSHTOI`);
      setSavingContinue(false);
    }
  }

  function openDrafts() {
    void refreshDrafts();
    setShowDraftsSheet(true);
  }

  async function loadDraftIntoForm(id) {
    try {
      let d = await readDraftRemote(id);
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

      setTepihaRows(Array.isArray(d.tepihaRows) && d.tepihaRows.length ? d.tepihaRows.map((r) => ({ ...r, qty: String(r?.qty ?? '0') })) : []);
      setStazaRows(Array.isArray(d.stazaRows) && d.stazaRows.length ? d.stazaRows.map((r) => ({ ...r, qty: String(r?.qty ?? '0') })) : []);
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
  const kod = formatKod(normalizeCode(codeRaw), netState.ok);
  const m2 = Number(totalM2 || 0).toFixed(2);
  const euro = Number(totalEuro || 0).toFixed(2);
  const debt = Number(currentDebt || 0).toFixed(2);

  return `Përshëndetje ${name || 'klient'},

Porosia juaj u pranua!
KODI: ${kod}
SASIA: ${copeCount} copë (${m2} m²)
TOTALI: ${euro} €
BORXHI: ${debt} €

⚠️ SHËNIM:
Sapo t'ju njoftojmë që janë gati, ju lutemi t'i merrni. Ne nuk mbajmë përgjegjësi për humbjen e tyre pas ditës që jeni njoftuar, pasi nuk kemi hapësirë për t'i lënë gjatë.

Faleminderit!`;
}


  const summaryCardBase = {
    borderRadius: 18,
    padding: '14px 16px',
    border: '1px solid rgba(255,255,255,0.12)',
    boxShadow: '0 14px 30px rgba(0,0,0,0.26), inset 0 1px 0 rgba(255,255,255,0.08)',
    backdropFilter: 'blur(8px)',
  };

  const summaryCardStyles = {
    pieces: {
      ...summaryCardBase,
      background: 'linear-gradient(135deg, rgba(59,130,246,0.24) 0%, rgba(139,92,246,0.22) 100%)',
      border: '1px solid rgba(147,197,253,0.32)',
    },
    m2: {
      ...summaryCardBase,
      background: 'linear-gradient(135deg, rgba(251,146,60,0.24) 0%, rgba(239,68,68,0.18) 100%)',
      border: '1px solid rgba(251,191,36,0.30)',
    },
    total: {
      ...summaryCardBase,
      background: 'linear-gradient(135deg, rgba(16,185,129,0.24) 0%, rgba(34,197,94,0.18) 100%)',
      border: '1px solid rgba(74,222,128,0.30)',
    },
  };

  const SectionCard = ({ title, children, style }) => (
    <section className="card" style={{ marginTop: 16, ...style }}>
      {title ? <h2 className="card-title">{title}</h2> : null}
      {children}
    </section>
  );

  const renderRows = (kind, rows) => (
    <>
      {(rows || []).map((row) => (
        <div className="piece-row" key={row.id}>
          <div className="row">
            <input
              className="input small"
              type="number"
              value={row.m2}
              onChange={(e) => handleRowChange(kind, row.id, 'm2', e.target.value)}
              placeholder="m²"
            />
            <input
              className="input small"
              type="number"
              value={row.qty}
              onChange={(e) => handleRowChange(kind, row.id, 'qty', e.target.value)}
              placeholder="copë"
            />
            <label className="camera-btn">
              {row.photoUrl ? <img src={row.photoUrl} alt="foto" style={{ width: '100%', height: '100%', borderRadius: 12, objectFit: 'cover' }} /> : '📷'}
              <input type="file" hidden accept="image/*" onChange={(e) => handleRowPhotoChange(kind, row.id, e.target.files?.[0])} />
            </label>
          </div>
        </div>
      ))}
      <div className="row btn-row">
        <button className="btn secondary" onClick={() => addRow(kind)}>+ RRESHT</button>
        <button className="btn secondary" onClick={() => removeRow(kind)}>− RRESHT</button>
      </div>
    </>
  );

  return (
    <>
      <div style={{ padding: 16, color: '#fff' }}>
        <div className="card" style={{ marginTop: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <div>
              <div className="card-title" style={{ marginBottom: 6 }}>PRANIMI</div>
              <div style={{ opacity: 0.8, fontSize: 13 }}>KODI: <strong>{formatKod(normalizeCode(codeRaw), netState.ok)}</strong></div>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button className="btn secondary" onClick={openDrafts}>DRAFTS</button>
              <button className="btn primary" onClick={openWizard}>HAP WIZARD</button>
            </div>
          </div>
          {!showWizard && (
            <div style={{ marginTop: 12, opacity: 0.78, fontSize: 13 }}>
              ETA: {etaText} • KAPACITETI SOT: {Number(todayPastrimM2 || 0).toFixed(2)} m²
            </div>
          )}
        </div>

        {showOfflinePrompt && (
          <div className="card" style={{ marginTop: 12, border: '1px solid rgba(239,68,68,0.35)', background: 'rgba(127,29,29,0.28)' }}>
            ⚠️ OFFLINE / PROBLEM ME KODIN. RUJESE BEST-EFFORT MBETET AKTIVE.
          </div>
        )}

        {showWizard && (
          <div className="card" style={{ marginTop: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, marginBottom: 14 }}>
              <div className="card-title" style={{ margin: 0 }}>HAPI {wizStep} / 5</div>
              <button className="btn secondary" onClick={closeWizard}>MBYLLE</button>
            </div>

            {wizStep === 1 && (
              <>
                <SectionCard title="KLIENTI" style={{ marginTop: 0 }}>
                  <div style={{ display: 'grid', gap: 10 }}>
                    <input className="input" value={clientQuery} onChange={(e) => setClientQuery(e.target.value)} placeholder="KËRKO KLIENTIN" />
                    {clientHits.length > 0 && (
                      <div style={{ display: 'grid', gap: 8 }}>
                        {clientHits.map((c, idx) => (
                          <button
                            key={`${c.code}_${idx}`}
                            type="button"
                            className="btn secondary"
                            style={{ justifyContent: 'flex-start', textAlign: 'left' }}
                            onClick={() => {
                              setName(c.name || '');
                              setPhone(String(c.phone || '').replace(/^\+?383/, '').replace(/\D+/g, ''));
                              setClientQuery(c.name || c.code || '');
                            }}
                          >
                            {c.code} • {c.name} • {c.phone}
                          </button>
                        ))}
                      </div>
                    )}
                    <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="EMRI DHE MBIEMRI" />
                    <div className="row">
                      <div className="input small" style={{ display: 'flex', alignItems: 'center', opacity: 0.8 }}>{phonePrefix}</div>
                      <input className="input small" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="NUMRI I TELEFONIT" />
                      <label className="camera-btn">
                        {clientPhotoUrl ? <img src={clientPhotoUrl} alt="client" style={{ width: '100%', height: '100%', borderRadius: 12, objectFit: 'cover' }} /> : '📷'}
                        <input type="file" hidden accept="image/*" onChange={(e) => handleClientPhotoChange(e.target.files?.[0])} />
                      </label>
                    </div>
                  </div>
                </SectionCard>
              </>
            )}

            {wizStep === 2 && (
              <SectionCard title="TEPIHA" style={{ marginTop: 0 }}>
                <div className="chip-row modern">
                  {TEPIHA_CHIPS.map((v) => (
                    <button
                      key={v}
                      type="button"
                      className="chip chip-modern"
                      style={chipStyleForVal(v, false)}
                      onMouseDown={(e) => tapStart(chipTapRef, e)}
                      onMouseMove={(e) => tapMove(chipTapRef, e)}
                      onTouchStart={(e) => tapStart(chipTapRef, e.touches?.[0])}
                      onTouchMove={(e) => tapMove(chipTapRef, e.touches?.[0])}
                      onClick={(e) => guardedApplyChip('tepiha', v, e)}
                    >
                      {v.toFixed(1)}
                    </button>
                  ))}
                </div>
                {renderRows('tepiha', tepihaRows)}
              </SectionCard>
            )}

            {wizStep === 3 && (
              <SectionCard title="STAZA" style={{ marginTop: 0 }}>
                <div className="chip-row modern">
                  {STAZA_CHIPS.map((v) => (
                    <button
                      key={v}
                      type="button"
                      className="chip chip-modern"
                      style={chipStyleForVal(v, false)}
                      onMouseDown={(e) => tapStart(chipTapRef, e)}
                      onMouseMove={(e) => tapMove(chipTapRef, e)}
                      onTouchStart={(e) => tapStart(chipTapRef, e.touches?.[0])}
                      onTouchMove={(e) => tapMove(chipTapRef, e.touches?.[0])}
                      onClick={(e) => guardedApplyChip('staza', v, e)}
                    >
                      {v.toFixed(1)}
                    </button>
                  ))}
                </div>
                {renderRows('staza', stazaRows)}
              </SectionCard>
            )}
              {wizStep === 4 ? (
                <div>
                  <div className="wiz-h" style={{ color:'#fff' }}>HAPI 4 — SHKALLORE & SHËNIME</div>
                  
                  <button type="button" className="btn secondary" style={{ width: '100%', marginBottom: 14, padding: '14px 0', fontWeight: 900, border: showStairsArea ? '1px solid rgba(248,113,113,0.4)' : '1px dashed rgba(255,255,255,0.3)', color: showStairsArea ? '#fca5a5' : '#fff', background: showStairsArea ? 'rgba(239,68,68,0.1)' : 'transparent' }} onClick={() => setShowStairsArea(!showStairsArea)}>
                    {showStairsArea ? '[-] MBYLL SHKALLOREN' : '[+] SHTO SHKALLORE (OPSIONALE)'}
                  </button>

                  {showStairsArea && (
                    <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 16, padding: '14px 14px 2px 14px', marginBottom: 14 }}>
                      <div className="field-group" style={{ marginTop: 0 }}>
                        <label className="label" style={{ color:'rgba(255,255,255,.7)' }}>SHKALLORE — COPË</label>
                        <div className="chip-row modern">
                          {SHKALLORE_QTY_CHIPS.map((n) => (
                            <button key={`ws_q_${n}`} type="button" className="chip chip-modern" onPointerDown={(e) => tapDown(chipTapRef, e)} onPointerMove={(e) => tapMove(chipTapRef, e)} onPointerUp={() => { if (isRealTap(chipTapRef)) setStairsQty(Number(n)); }} style={chipStyleForVal(2.5, false)}>{n}</button>
                          ))}
                        </div>
                        <input className="input" type="number" value={stairsQty === 0 ? '' : stairsQty} onChange={(e) => setStairsQty(e.target.value === '' ? 0 : Number(e.target.value))} placeholder="p.sh. 20" style={{ background:'rgba(255,255,255,.06)', color:'#fff', border:'1px solid rgba(255,255,255,.1)', marginTop: 8 }} />
                      </div>
                      <div className="field-group">
                        <label className="label" style={{ color:'rgba(255,255,255,.7)' }}>SHKALLORE — m² PËR COPË</label>
                        <div className="chip-row modern">
                          {SHKALLORE_PER_CHIPS.map((n) => (
                            <button key={`ws_p_${n}`} type="button" className="chip chip-modern" onPointerDown={(e) => tapDown(chipTapRef, e)} onPointerMove={(e) => tapMove(chipTapRef, e)} onPointerUp={() => { if (isRealTap(chipTapRef)) setStairsPer(Number(n)); }} style={chipStyleForVal(3.0, false)}>{Number(n).toFixed(2)}</button>
                          ))}
                        </div>
                        <input className="input" type="number" step="0.01" value={stairsPer === 0 ? '' : stairsPer} onChange={(e) => setStairsPer(e.target.value === '' ? 0 : Number(e.target.value))} placeholder="p.sh. 0.30" style={{ background:'rgba(255,255,255,.06)', color:'#fff', border:'1px solid rgba(255,255,255,.1)', marginTop: 8 }} />
                      </div>
                      <div className="field-group">
                        <label className="label" style={{ color:'rgba(255,255,255,.7)' }}>FOTO SHKALLORE</label>
                        <div className="row" style={{ alignItems:'center', gap:10 }}>
                          <label className="camera-btn">📷<input type="file" accept="image/*" style={{ display:'none' }} onChange={(e) => handleStairsPhotoChange(e.target.files?.[0])} /></label>
                          {stairsPhotoUrl ? <img src={stairsPhotoUrl} className="photo-thumb" alt="" style={{ height:54, width:78, objectFit:'cover', borderRadius: 8 }} /> : <div style={{ fontSize:11, opacity:.7, color:'#fff' }}>PA FOTO</div>}
                          {stairsPhotoUrl ? <button type="button" className="btn secondary" style={{ marginLeft:'auto', fontSize:10, padding:'6px 10px' }} onClick={() => setStairsPhotoUrl('')}>🗑️ FSHI</button> : null}
                        </div>
                      </div>
                    </div>
                  )}

                  <div className="field-group">
                    <label className="label" style={{ color:'rgba(255,255,255,.7)' }}>SHËNIME</label>
                    <textarea className="input" rows={4} value={notes} onChange={(e)=>setNotes(e.target.value)} placeholder="Shënime për pranimin..." style={{ background:'rgba(255,255,255,.06)', color:'#fff', border:'1px solid rgba(255,255,255,.1)' }} />
                  </div>
                  <div className="row" style={{ gap:10, marginTop:12 }}>
                    <button type="button" className="btn secondary" style={{ flex:1 }} onClick={() => setShowDraftsSheet(true)}>🗂 TË PA PLOTËSUARAT</button>
                    <button type="button" className="btn secondary" style={{ flex:1 }} onClick={openPay}>€ PAGESA</button>
                  </div>
                </div>
              ) : null}

              {wizStep === 5 ? (
              <>
                <SectionCard title="PËRMBLEDHJE" style={{ marginTop: 0 }}>
                  <div style={{ display: 'grid', gap: 12 }}>
                    <div style={summaryCardStyles.pieces}>
                      <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 6 }}>COPË</div>
                      <div style={{ fontSize: 28, fontWeight: 900 }}>{copeCount}</div>
                    </div>
                    <div style={summaryCardStyles.m2}>
                      <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 6 }}>M² TOTAL</div>
                      <div style={{ fontSize: 28, fontWeight: 900 }}>{Number(totalM2 || 0).toFixed(2)}</div>
                    </div>
                    <div style={summaryCardStyles.total}>
                      <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 6 }}>TOTAL €</div>
                      <div style={{ fontSize: 28, fontWeight: 900 }}>{Number(totalEuro || 0).toFixed(2)} €</div>
                    </div>
                    <div className="tot-line">PAGUAR: <strong style={{ color: '#4ade80' }}>{Number(clientPaid || 0).toFixed(2)} €</strong></div>
                    {!!currentDebt && <div className="tot-line">BORXHI: <strong style={{ color: '#f87171' }}>{Number(currentDebt || 0).toFixed(2)} €</strong></div>}
                    {!!currentChange && <div className="tot-line">KUSURI: <strong>{Number(currentChange || 0).toFixed(2)} €</strong></div>}
                    <div className="tot-line" style={{ fontSize: 12, color: 'rgba(255,255,255,0.7)' }}>REGJISTRU N'ARKË: <strong>{Number(arkaRecordedPaid || 0).toFixed(2)} €</strong></div>
                  </div>
                </SectionCard>

                <SectionCard title="SHËNIME">
                  <textarea className="input" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
                </SectionCard>
              </>
            ) : null}

            <footer className="wiz-actions" style={{ display: 'flex', gap: 10, marginTop: 16 }}>
              <button className="btn secondary" onClick={wizStep === 1 ? closeWizard : wizBack}>
                {wizStep === 1 ? 'MBYLLE' : 'MBRAPA'}
              </button>
              {wizStep < 5 ? (
                <button className="btn primary" onClick={wizNext}>VAZHDO</button>
              ) : (
                <button className="btn primary" onClick={handleContinue} disabled={photoUploading || savingContinue}>
                  {savingContinue ? '⏳ DUKE RUJT...' : 'RUAJ & VAZHDO'}
                </button>
              )}
            </footer>
          </div>
        )}
      </div>

      {showPaySheet && (
        <PosModal
          open={showPaySheet}
          onClose={() => setShowPaySheet(false)}
          title="PAGESA (ARKË)"
          subtitle={`KODI: ${formatKod(normalizeCode(codeRaw), netState.ok)} • ${name}`}
          total={totalEuro}
          alreadyPaid={Number(clientPaid || 0)}
          amount={Number(payAdd || 0)}
          setAmount={(v) => setPayAdd(Number(v || 0))}
          payChips={PAY_CHIPS}
          confirmText="KRYEJ PAGESËN"
          cancelText="ANULO"
          disabled={savingContinue}
          onConfirm={applyPayAndClose}
          footerNote={`BORXHI: ${Number(currentDebt || 0).toFixed(2)}€ • KUSURI: ${Number(Math.max(0, Number(payAdd || 0) - Number(currentDebt || 0))).toFixed(2)}€`}
        />
      )}

      {showPriceSheet && (
        <div className="modal-overlay" onClick={() => setShowPriceSheet(false)}>
          <div className="modal-content dark" onClick={(e) => e.stopPropagation()}>
            <h3 className="card-title" style={{ marginTop: 0 }}>NDRYSHO ÇMIMIN / m²</h3>
            <input type="number" step="0.1" className="input" value={priceTmp} onChange={(e) => setPriceTmp(e.target.value)} />
            <div className="row" style={{ gap: 10, marginTop: 12 }}>
              <button className="btn secondary" onClick={() => setShowPriceSheet(false)}>ANULO</button>
              <button className="btn primary" onClick={savePriceAndClose}>RUAJ</button>
            </div>
          </div>
        </div>
      )}

      {showDraftsSheet && (
        <div className="modal-overlay" onClick={() => setShowDraftsSheet(false)}>
          <div className="modal-content dark" onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
              <h3 className="card-title" style={{ margin: 0 }}>TË PA PLOTËSUARAT</h3>
              <button className="btn secondary" onClick={() => setShowDraftsSheet(false)}>MBYLLE</button>
            </div>
            <div style={{ display: 'grid', gap: 10, marginTop: 14, maxHeight: '60vh', overflow: 'auto' }}>
              {drafts.length === 0 ? (
                <div style={{ opacity: 0.7 }}>NUK KA DRAFTS.</div>
              ) : drafts.map((d) => (
                <div key={d.id} className="card" style={{ marginTop: 0 }}>
                  <div style={{ fontWeight: 900 }}>{d.code || '—'} • {d.name || 'PA EMËR'}</div>
                  <div style={{ opacity: 0.72, fontSize: 13, marginTop: 4 }}>{d.phone || ''}</div>
                  <div className="row" style={{ gap: 10, marginTop: 10 }}>
                    <button className="btn secondary" onClick={() => loadDraftIntoForm(d.id)}>HAP</button>
                    <button className="btn secondary" onClick={() => deleteDraft(d.id)}>FSHIJ</button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {showMsgSheet && (
        <div className="modal-overlay" onClick={() => {
          setShowMsgSheet(false);
          if (pendingNavTo) {
            const to = pendingNavTo;
            setPendingNavTo('');
            router.push(to);
          }
        }}>
          <div className="modal-content dark" onClick={(e) => e.stopPropagation()}>
            <h3 className="card-title" style={{ marginTop: 0 }}>MESAZHI</h3>
            <textarea className="input" rows={12} value={buildStartMessage()} readOnly />
            <div className="row" style={{ gap: 10, marginTop: 12 }}>
              <button className="btn secondary" onClick={async () => {
                try { await navigator.clipboard.writeText(buildStartMessage()); } catch {}
              }}>COPY</button>
              <button className="btn primary" onClick={() => {
                setShowMsgSheet(false);
                if (pendingNavTo) {
                  const to = pendingNavTo;
                  setPendingNavTo('');
                  router.push(to);
                }
              }}>VAZHDO</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
