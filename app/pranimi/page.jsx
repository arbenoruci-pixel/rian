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
import { getClientBalanceByPhone } from '@/lib/clientBalanceDb';

const BUCKET = 'tepiha-photos';

const TEPIHA_CHIPS = [2.0, 2.5, 3.0, 3.5, 3.7, 4.0, 5.0, 6.0, 8.0, 12.0];
const STAZA_CHIPS = [0.5, 0.8, 0.9, 1.2, 1.5, 1.6, 2.0, 2.4, 2.5, 3.0, 4.0, 5.0];

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

  let a = 'rgba(56,189,248,0.28)';
  let b = 'rgba(59,130,246,0.14)';
  let br = 'rgba(125,211,252,0.70)';

  if (n >= 5.8) {
    a = 'rgba(251,146,60,0.28)';
    b = 'rgba(249,115,22,0.14)';
    br = 'rgba(253,186,116,0.72)';
  } else if (Math.abs(n - 3.2) < 0.051) {
    a = 'rgba(248,113,113,0.28)';
    b = 'rgba(239,68,68,0.14)';
    br = 'rgba(252,165,165,0.72)';
  } else if (n >= 3.5) {
    a = 'rgba(244,114,182,0.26)';
    b = 'rgba(236,72,153,0.12)';
    br = 'rgba(249,168,212,0.68)';
  } else if (n >= 2.2) {
    a = 'rgba(250,204,21,0.26)';
    b = 'rgba(245,158,11,0.12)';
    br = 'rgba(253,224,71,0.68)';
  } else {
    a = 'rgba(192,132,252,0.26)';
    b = 'rgba(168,85,247,0.12)';
    br = 'rgba(216,180,254,0.68)';
  }

  return {
    background: `linear-gradient(180deg, ${a}, ${b})`,
    border: `1.5px solid ${br}`,
    outline: active ? '2px solid rgba(255,255,255,0.42)' : 'none',
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

  const uniqueDrafts = useMemo(() => {
    const sorted = [...(Array.isArray(drafts) ? drafts : [])].sort((a, b) => Number(b?.ts || 0) - Number(a?.ts || 0));
    const byCode = new Map();
    for (const d of sorted) {
      const codeNum = Number(d?.code);
      const key = Number.isFinite(codeNum) && codeNum > 0 ? `code:${codeNum}` : `id:${String(d?.id || '')}`;
      if (!byCode.has(key)) byCode.set(key, d);
    }
    return Array.from(byCode.values());
  }, [drafts]);

  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [oldClientDebt, setOldClientDebt] = useState(0);
  const [clientPhotoUrl, setClientPhotoUrl] = useState('');

  const [clientQuery, setClientQuery] = useState('');
  const [clientsIndex, setClientsIndex] = useState([]);
  const [clientHits, setClientHits] = useState([]);
  const [clientsLoading, setClientsLoading] = useState(false);
  const [showClientSearch, setShowClientSearch] = useState(false);
  const [recentAddedRows, setRecentAddedRows] = useState({});
  const [removingRows, setRemovingRows] = useState({});

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
  const [activeChipKey, setActiveChipKey] = useState('');
  const [wizStep, setWizStep] = useState(1);
  const [wizTab, setWizTab] = useState('TEPIHA');
  const [showStairsArea, setShowStairsArea] = useState(false);

  function openWizard() {
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
      const byCode = new Map();
      for (const d of merged) {
        const key = Number(d?.code) > 0 ? `code:${Number(d.code)}` : `id:${String(d?.id || '')}`;
        if (!byCode.has(key)) byCode.set(key, d);
      }
      setDrafts(Array.from(byCode.values()));
    } catch {
      const local = readAllDraftsLocal().map((d) => ({
        id: d.id,
        code: Number(d.code) || 0,
        name: `${d?.client?.first_name || ''} ${d?.client?.last_name || ''}`.trim(),
        phone: d?.client?.phone || '',
        ts: Number(d.ts) || 0,
      }));
      const sorted = local.sort((a, b) => Number(b.ts) - Number(a.ts));
      const byCode = new Map();
      for (const d of sorted) {
        const key = Number(d?.code) > 0 ? `code:${Number(d.code)}` : `id:${String(d?.id || '')}`;
        if (!byCode.has(key)) byCode.set(key, d);
      }
      setDrafts(Array.from(byCode.values()));
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

  useEffect(() => {
    let alive = true;
    const phoneFull = sanitizePhone(phonePrefix + (phone || ''));
    if (!phoneFull || phoneFull.length < 6) { setOldClientDebt(0); return; }
    (async () => {
      try {
        const res = await getClientBalanceByPhone(phoneFull);
        if (!alive) return;
        setOldClientDebt(Number(res?.debt_eur || 0) || 0);
      } catch {
        if (alive) setOldClientDebt(0);
      }
    })();
    return () => { alive = false; };
  }, [phonePrefix, phone]);
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

  function flashAddedRow(id) {
    try {
      setRecentAddedRows((prev) => ({ ...prev, [id]: true }));
      setTimeout(() => {
        setRecentAddedRows((prev) => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
      }, 1800);
    } catch {}
  }

  function animateRemoveRow(kind) {
    const rows = kind === 'tepiha' ? tepihaRows : stazaRows;
    const last = rows && rows.length ? rows[rows.length - 1] : null;
    if (!last?.id) return;

    const rowId = last.id;
    setRemovingRows((prev) => ({ ...prev, [rowId]: true }));

    setTimeout(() => {
      const setter = kind === 'tepiha' ? setTepihaRows : setStazaRows;
      setter((cur) => (cur.length ? cur.slice(0, -1) : cur));
      setRemovingRows((prev) => {
        const next = { ...prev };
        delete next[rowId];
        return next;
      });
    }, 240);
  }

  function addRow(kind) {
    const setter = kind === 'tepiha' ? setTepihaRows : setStazaRows;
    const prefix = kind === 'tepiha' ? 't' : 's';
    setter((rows) => {
      const newRow = { id: `${prefix}${rows.length + 1}`, m2: '', qty: '0', photoUrl: '' };
      setTimeout(() => flashAddedRow(newRow.id), 10);
      return [...rows, newRow];
    });
  }

  function removeRow(kind) {
    animateRemoveRow(kind);
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
    vibrateTap(30);
    setActiveChipKey(`${kind}:${Number(val)}`);
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
      if (!normCodeNow || normCodeNow === '0') {
        alert('DB ERROR: Kodi mungon ose nuk u rezervua saktë.');
        setSavingContinue(false);
        return;
      }

      const nowIso = new Date().toISOString();
      const payload = {
        status: 'pastrim',
        code: Number(normCodeNow || 0) || null,
        client_name: name?.trim() || null,
        client_phone: phonePrefix + (phone || ''),
        pieces: Number(copeCount || 0),
        m2_total: Number(totalM2 || 0),
        price_total: Number(totalEuro || 0),
        paid_cash: Number(clientPaid || 0),
        is_paid_upfront: Number(clientPaid || 0) > 0,
        note: notes || null,
        updated_at: nowIso,
        data: {
          ...order,
          status: 'pastrim',
          updated_at: nowIso,
          client_name: name?.trim() || null,
          client_phone: phonePrefix + (phone || ''),
          pieces: Number(copeCount || 0),
          m2_total: Number(totalM2 || 0),
          price_total: Number(totalEuro || 0),
          paid_cash: Number(clientPaid || 0),
          is_paid_upfront: Number(clientPaid || 0) > 0,
          note: notes || null,
          local_oid: String(oid),
        },
      };

      const { error } = await supabase.from('orders').upsert(payload);
      if (error) throw error;

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
    } catch (err) {
      alert('DB ERROR: ' + (err?.message || 'Unknown error'));
      setSavingContinue(false);
      return;
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
  
Porosia juaj u pranua dhe procesi i pastrimit ka filluar.

KODI: ${kod}
SASIA: ${copeCount} copë (${m2} m²)
TOTALI: ${euro} €
BORXHI: ${debt} €

Sapo të jenë gati për t'u tërhequr, do t'ju njoftojmë me një mesazh tjetër.

⚠️ SHËNIM: Sapo t'ju njoftojmë që janë gati, ju lutemi t'i merrni. Ne nuk mbajmë përgjegjësi për humbjen e tyre pas ditës që jeni njoftuar.

Faleminderit që zgjodhët shërbimet tona,
KOMPANIA JONI`;
  }

  function openLinkSafe(url) { try { window.location.href = url; } catch {} }

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
    try { navigator.clipboard?.writeText(buildStartMessage()); } catch {}
    setTimeout(() => { alert('Mesazhi u kopjua. Hap Viber dhe paste te klienti.'); }, 120);
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
    try { localStorage.setItem(AUTO_MSG_KEY, next ? '1' : '0'); } catch {}
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
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999, padding: 16 }}>
          <div style={{ maxWidth: 520, width: '100%', borderRadius: 14, border: '1px solid rgba(255,255,255,0.12)', background: '#0d0f14', padding: 14 }}>
            <div style={{ fontWeight: 900, letterSpacing: 1 }}>S’KA LIDHJE</div>
            <div style={{ opacity: 0.85, marginTop: 8, lineHeight: 1.35 }}>
              Interneti ose serveri nuk po përgjigjet. A don me vazhdu në <b>OFFLINE MODE</b> që mos me i humb klientat?
            </div>
            <div style={{ display: 'flex', gap: 10, marginTop: 12, flexWrap: 'wrap' }}>
              <button onClick={() => { setOfflineMode(true); try { localStorage.setItem(OFFLINE_MODE_KEY, '1'); } catch {} setShowOfflinePrompt(false); }} style={{ padding: '10px 12px', borderRadius: 10, fontWeight: 900 }}>KALO NË OFFLINE</button>
              <button onClick={async () => { const s = await checkConnectivity(); setNetState(s); if (s.ok) setShowOfflinePrompt(false); }} style={{ padding: '10px 12px', borderRadius: 10, fontWeight: 900, opacity: 0.9 }}>PROVO PRAP</button>
              <button onClick={() => setShowOfflinePrompt(false)} style={{ padding: '10px 12px', borderRadius: 10, fontWeight: 800, opacity: 0.75 }}>MBYLL</button>
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
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer', userSelect: 'none' }}>
              <input type="checkbox" checked={offlineMode} onChange={(e) => { const v = e.target.checked; setOfflineMode(v); try { localStorage.setItem(OFFLINE_MODE_KEY, v ? '1' : '0'); } catch {} }} />
              <span style={{ fontWeight: 900, letterSpacing: 0.5 }}>OFFLINE MODE</span>
            </label>
          </div>
          <div style={{ fontSize: 12, opacity: 0.75 }}>{netState.ok ? 'ONLINE' : `LIDHJA: ${netState.reason}`}</div>
        </div>
        <div className="code-badge">
          <span className="badge">{`KODI: ${formatKod(normalizeCode(codeRaw), netState.ok)}`}</span>
        </div>
      </header>

      <section className="card">
        <h2 className="card-title">KLIENTI</h2>

        <div className="client-toolbar">
          <button type="button" className="icon-chip search" onClick={() => setShowClientSearch(true)} aria-label="Kërko klient" title="KËRKO KLIENT">
            <svg viewBox="0 0 24 24" aria-hidden="true" width="28" height="28" className="icon-svg">
              <circle cx="11" cy="11" r="5.5" fill="none" stroke="currentColor" strokeWidth="2.2" />
              <path d="M16 16L21 21" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
            </svg>
          </button>
          <button
            type="button"
            className="icon-chip drafts"
            onClick={openDrafts}
            aria-label="Të pa plotsuarat"
            title={`TË PA PLOTSUARAT${uniqueDrafts.length > 0 ? ` (${uniqueDrafts.length})` : ''}`}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" width="28" height="28" className="icon-svg">
              <path d="M6 7.5h12M6 12h12M6 16.5h12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"/>
            </svg>
            {uniqueDrafts.length > 0 ? <span className="header-icon-badge">{uniqueDrafts.length}</span> : null}
          </button>
          <button type="button" className="icon-chip add" onClick={openWizard} aria-label="Shto klient" title="SHTO KLIENT">
            <svg viewBox="0 0 64 64" aria-hidden="true" width="34" height="34" className="icon-svg add-contact-svg">
              <circle cx="24" cy="22" r="10" fill="currentColor" opacity="0.92" />
              <path d="M10 48c1.8-8 8-13 15-13s13.2 5 15 13" fill="none" stroke="currentColor" strokeWidth="5" strokeLinecap="round"/>
              <circle cx="46" cy="42" r="13" fill="none" stroke="currentColor" strokeWidth="5"/>
              <path d="M46 35v14M39 42h14" fill="none" stroke="currentColor" strokeWidth="5" strokeLinecap="round"/>
            </svg>
          </button>
        </div>

        {(name || phone || clientPhotoUrl) ? (
          <div className="client-selected-card">
            <button
              type="button"
              className="client-card-close"
              aria-label="Mbyll klientin"
              title="ANULO KLIENTIN"
              onClick={() => {
                try { setName(''); } catch {}
                try { setPhone(''); } catch {}
                try { setClientPhotoUrl(''); } catch {}
                try { setOldClientDebt(0); } catch {}
                try { setClientQuery(''); } catch {}
                try { setClientHits([]); } catch {}
                try { setCodeRaw(''); } catch {}
                try {
                  setTimeout(() => {
                    try { window.location.reload(); } catch {}
                  }, 40);
                } catch {}
              }}
            >
              ✕
            </button>
            <div className="client-selected-main">
              {clientPhotoUrl ? <img src={clientPhotoUrl} alt="" className="client-mini large" /> : <div className="client-avatar-fallback">👤</div>}
              <div className="client-selected-copy">
                <div className="client-code-pill">{`NR ${formatKod(normalizeCode(codeRaw), netState.ok)}`}</div>
                <div className="client-selected-name">{name || 'KLIENT I RI'}</div>
                <div className="client-selected-phone">{phone ? `${phonePrefix} ${phone}` : 'PA TELEFON'}</div>
              </div>
            </div>
          </div>
        ) : null}

        {oldClientDebt > 0 && <div style={{ marginTop:12, padding:'10px 12px', borderRadius:12, background:'rgba(239,68,68,0.16)', border:'1px solid rgba(239,68,68,0.35)', color:'#fecaca', fontWeight:900, fontSize:12 }}>⚠️ KUJDES: KY KLIENT KA {oldClientDebt.toFixed(2)}€ BORXH TË VJETËR!</div>}
      </section>
      <section className="card">
        <h2 className="card-title">TEPIHA</h2>
        <div className="chip-row modern">
          {TEPIHA_CHIPS.map((v) => {
            const isActive = activeChipKey === `tepiha:${Number(v)}`;
            return (
            <button key={v} type="button" className={`chip chip-modern ${isActive ? 'selected' : ''}`} onPointerDown={(e) => tapDown(chipTapRef, e)} onPointerMove={(e) => tapMove(chipTapRef, e)} onPointerUp={(e) => guardedApplyChip('tepiha', v, e)} style={chipStyleForVal(v, isActive)}>
              <span className="chip-text">{v.toFixed(1)}</span>
              
            </button>
          )})}
        </div>
        {tepihaRows.map((row) => (
          <div className={`piece-row ${recentAddedRows[row.id] ? 'row-flash-add' : ''} ${removingRows[row.id] ? 'row-flash-remove' : ''}`} key={row.id}>
            <div className="row">
              <input className="input small" type="number" value={row.m2} onChange={(e) => handleRowChange('tepiha', row.id, 'm2', e.target.value)} placeholder="m²" />
              <input className="input small" type="number" value={row.qty} onChange={(e) => handleRowChange('tepiha', row.id, 'qty', e.target.value)} placeholder="copë" />
              <label className="camera-btn">📷<input type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => handleRowPhotoChange('tepiha', row.id, e.target.files?.[0])} /></label>
            </div>
            {row.photoUrl && (
              <div style={{ marginTop: 8 }}>
                <img src={row.photoUrl} className="photo-thumb" alt="" />
                <button className="btn secondary" style={{ display: 'block', fontSize: 10, padding: '4px 8px', marginTop: 4 }} onClick={() => handleRowChange('tepiha', row.id, 'photoUrl', '')}>🗑️ FSHI FOTO</button>
              </div>
            )}
          </div>
        ))}
        <div className="row btn-row">
          <button className="rbtn add" onClick={(e) => { e.currentTarget.classList.remove('pulse'); void e.currentTarget.offsetWidth; e.currentTarget.classList.add('pulse'); addRow('tepiha'); }}>+ RRESHT</button>
          <button className="rbtn remove" onClick={(e) => { e.currentTarget.classList.remove('pulse'); void e.currentTarget.offsetWidth; e.currentTarget.classList.add('pulse'); removeRow('tepiha'); }}>− RRESHT</button>
        </div>
      </section>

      <section className="card">
        <h2 className="card-title">STAZA</h2>
        <div className="chip-row modern">
          {STAZA_CHIPS.map((v) => {
            const isActive = activeChipKey === `staza:${Number(v)}`;
            return (
            <button key={v} type="button" className={`chip chip-modern ${isActive ? 'selected' : ''}`} onPointerDown={(e) => tapDown(chipTapRef, e)} onPointerMove={(e) => tapMove(chipTapRef, e)} onPointerUp={(e) => guardedApplyChip('staza', v, e)} style={chipStyleForVal(v, isActive)}>
              <span className="chip-text">{v.toFixed(1)}</span>
              
            </button>
          )})}
        </div>
        {stazaRows.map((row) => (
          <div className={`piece-row ${recentAddedRows[row.id] ? 'row-flash-add' : ''} ${removingRows[row.id] ? 'row-flash-remove' : ''}`} key={row.id}>
            <div className="row">
              <input className="input small" type="number" value={row.m2} onChange={(e) => handleRowChange('staza', row.id, 'm2', e.target.value)} placeholder="m²" />
              <input className="input small" type="number" value={row.qty} onChange={(e) => handleRowChange('staza', row.id, 'qty', e.target.value)} placeholder="copë" />
              <label className="camera-btn">📷<input type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => handleRowPhotoChange('staza', row.id, e.target.files?.[0])} /></label>
            </div>
            {row.photoUrl && (
              <div style={{ marginTop: 8 }}>
                <img src={row.photoUrl} className="photo-thumb" alt="" />
                <button className="btn secondary" style={{ display: 'block', fontSize: 10, padding: '4px 8px', marginTop: 4 }} onClick={() => handleRowChange('staza', row.id, 'photoUrl', '')}>🗑️ FSHI FOTO</button>
              </div>
            )}
          </div>
        ))}
        <div className="row btn-row">
          <button className="rbtn add" onClick={(e) => { e.currentTarget.classList.remove('pulse'); void e.currentTarget.offsetWidth; e.currentTarget.classList.add('pulse'); addRow('staza'); }}>+ RRESHT</button>
          <button className="rbtn remove" onClick={(e) => { e.currentTarget.classList.remove('pulse'); void e.currentTarget.offsetWidth; e.currentTarget.classList.add('pulse'); removeRow('staza'); }}>− RRESHT</button>
        </div>
      </section>

      <section className="card">
        <div className="row util-row" style={{ gap: 10 }}>
          <button className="btn secondary" style={{ flex: 1 }} onClick={() => setShowStairsSheet(true)}>🪜 SHKALLORE</button>
          <button className="btn secondary" style={{ flex: 1 }} onPointerDown={(e) => { tapDown(payTapRef, e); startPayHold(); }} onPointerMove={(e) => { tapMove(payTapRef, e); if (payTapRef.current?.moved) cancelPayHold(); }} onPointerUp={() => { endPayHold(); }} onPointerCancel={cancelPayHold} onMouseDown={(e) => { tapDown(payTapRef, e); startPayHold(); }} onMouseMove={(e) => { tapMove(payTapRef, e); if (payTapRef.current?.moved) cancelPayHold(); }} onMouseUp={endPayHold} onMouseLeave={cancelPayHold}>
            € PAGESA
          </button>
        </div>
        <div style={{ marginTop: 10 }}>
          <button className="btn secondary" style={{ width: '100%' }} onClick={() => setShowMsgSheet(true)}>📩 DËRGO MESAZH — FILLON PASTRIMI</button>
        </div>
        <div className="tot-line">M² Total: <strong>{totalM2}</strong></div>
        <div className="tot-line">Copë: <strong>{copeCount}</strong></div>
        <div className="tot-line">Total: <strong>{totalEuro.toFixed(2)} €</strong></div>
        <div className="tot-line" style={{ borderTop: '1px solid rgba(255,255,255,0.08)', marginTop: 10, paddingTop: 10 }}>Paguar: <strong style={{ color: '#16a34a' }}>{Number(clientPaid || 0).toFixed(2)} €</strong></div>
        <div className="tot-line" style={{ fontSize: 12, color: 'rgba(255,255,255,0.65)' }}>Regjistru n&apos;ARKË: <strong>{Number(arkaRecordedPaid || 0).toFixed(2)} €</strong></div>
        {currentDebt > 0 && <div className="tot-line">Borxh: <strong style={{ color: '#dc2626' }}>{currentDebt.toFixed(2)} €</strong></div>}
        {currentChange > 0 && <div className="tot-line">Kthim: <strong style={{ color: '#2563eb' }}>{currentChange.toFixed(2)} €</strong></div>}
      </section>

      <section className="card">
        <h2 className="card-title">SHËNIME</h2>
        <textarea className="input" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </section>

      <footer className="footer-bar">
        <button className="btn secondary" onClick={async () => { await commitDraftAndAdvanceCodeBestEffort(); try { sessionStorage.setItem(RESET_ON_SHOW_KEY, '1'); } catch {} router.push('/'); }}>🏠 HOME</button>
        <button className="btn primary" onClick={handleContinue} disabled={photoUploading || savingContinue}>{savingContinue ? '⏳ DUKE RUJT...' : '▶ VAZHDO'}</button>
      </footer>

      {showDraftsSheet && (
        <div className="payfs">
          <div className="payfs-top">
            <div><div className="payfs-title">TË PA PLOTSUARAT</div><div className="payfs-sub">HAP ose FSHI draftat</div></div>
            <button className="btn secondary" onClick={() => setShowDraftsSheet(false)}>✕</button>
          </div>
          <div className="payfs-body">
            <div className="card" style={{ marginTop: 0 }}>
              {drafts.length === 0 ? <div style={{ textAlign: 'center', padding: '18px 0', color: 'rgba(255,255,255,0.7)' }}>S’ka “të pa plotsuara”.</div> : (
                uniqueDrafts.map((d) => (
                  <div key={d.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 4px', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
                    <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                      <div style={{ background: '#16a34a', color: '#0b0b0b', padding: '8px 10px', borderRadius: 10, fontWeight: 900, minWidth: 56, textAlign: 'center' }}>{d.code || '—'}</div>
                      <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.8)' }}>
                        <div style={{ fontWeight: 800 }}>KODI: {d.code || '—'}</div>
                        <div style={{ opacity: 0.85 }}>{Number(d.m2 || 0).toFixed(2)} m² • {Number(d.euro || 0).toFixed(2)} €</div>
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
            <button className="btn secondary" style={{ width: '100%' }} onClick={() => setShowDraftsSheet(false)}>MBYLL</button>
          </div>
        </div>
      )}

      {showMsgSheet && (
        <div className="payfs">
          <div className="payfs-top">
            <div><div className="payfs-title">DËRGO MESAZH</div><div className="payfs-sub">VIBER / WHATSAPP / SMS</div></div>
            <button className="btn secondary" onClick={closeMsgSheet}>✕</button>
          </div>
          <div className="payfs-body">
            <div className="card" style={{ marginTop: 0 }}>
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.8)', fontWeight: 900 }}>AUTO PAS “VAZHDO”</div>
                <button className="btn secondary" style={{ padding: '6px 10px', fontSize: 11, borderRadius: 12 }} onClick={toggleAutoMsg}>{autoMsgAfterSave ? 'ON' : 'OFF'}</button>
              </div>
              <div className="tot-line" style={{ fontSize: 12, color: 'rgba(255,255,255,0.8)', marginTop: 10 }}><strong>PREVIEW</strong></div>
              <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', marginTop: 10, fontSize: 12, color: 'rgba(255,255,255,0.85)', lineHeight: 1.35 }}>{buildStartMessage()}</pre>
            </div>
            <div className="card">
              <div className="row" style={{ gap: 10 }}>
                <button className="btn secondary" style={{ flex: 1 }} onClick={sendViaViber}>VIBER</button>
                <button className="btn secondary" style={{ flex: 1 }} onClick={sendViaWhatsApp}>WHATSAPP</button>
                <button className="btn secondary" style={{ flex: 1 }} onClick={sendViaSMS}>SMS</button>
              </div>
              <div style={{ marginTop: 12, fontSize: 12, color: 'rgba(255,255,255,0.65)' }}>* Numri i kompanisë në fund: {COMPANY_PHONE_DISPLAY}</div>
            </div>
            <button className="btn secondary" style={{ width: '100%' }} onClick={closeMsgSheet}>MBYLL</button>
          </div>
        </div>
      )}

      {showPriceSheet && (
        <div className="payfs">
          <div className="payfs-top">
            <div><div className="payfs-title">NDËRRO QMIMIN</div><div className="payfs-sub">€/m² (ruhet & sinkronizohet)</div></div>
            <button className="btn secondary" onClick={() => setShowPriceSheet(false)}>✕</button>
          </div>
          <div className="payfs-body">
            <div className="card" style={{ marginTop: 0 }}>
              <div className="tot-line">QMIMI AKTUAL: <strong>{Number(pricePerM2 || 0).toFixed(2)} € / m²</strong></div>
              <div style={{ height: 10 }} />
              <label className="label">QMIMI I RI (€ / m²)</label>
              <input type="number" step="0.1" className="input" value={priceTmp} onChange={(e) => setPriceTmp(e.target.value === '' ? '' : Number(e.target.value))} />
              <div style={{ marginTop: 10, fontSize: 12, color: 'rgba(255,255,255,0.65)' }}>* Long-press 3 sek te “€ PAGESA” për me ardh këtu.</div>
            </div>
          </div>
          <div className="payfs-footer">
            <button className="btn secondary" onClick={() => setShowPriceSheet(false)}>ANULO</button>
            <button className="btn primary" onClick={savePriceAndClose}>RUJ</button>
          </div>
        </div>
      )}

      {showPaySheet && (
        <PosModal open={showPaySheet} onClose={() => setShowPaySheet(false)} title="PAGESA (ARKË)" subtitle={`KODI: ${formatKod(codeRaw, netState.ok)} • ${name}`} total={totalEuro} alreadyPaid={Number(clientPaid || 0)} amount={payAdd} setAmount={setPayAdd} payChips={PAY_CHIPS} confirmText="KRYEJ PAGESËN" cancelText="ANULO" disabled={savingContinue} onConfirm={applyPayAndClose} />
      )}

      {showStairsSheet && (
        <div className="modal-overlay" onClick={() => setShowStairsSheet(false)}>
          <div className="modal-content dark" onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3 className="card-title" style={{ margin: 0, color: '#fff' }}>SHKALLORE</h3>
              <button className="btn secondary" onClick={() => setShowStairsSheet(false)}>✕</button>
            </div>
            <div className="field-group" style={{ marginTop: 12 }}>
              <label className="label" style={{ color: 'rgba(255,255,255,0.8)' }}>COPE</label>
              <div className="chip-row">
                {SHKALLORE_QTY_CHIPS.map((n) => (
                  <button key={n} className="chip" type="button" onClick={() => { setStairsQty(n); vibrateTap(30); }} style={Number(stairsQty) === n ? { outline: '2px solid rgba(255,255,255,0.35)' } : null}>{n}</button>
                ))}
              </div>
              <input type="number" className="input" value={stairsQty === 0 ? '' : stairsQty} onChange={(e) => { const v = e.target.value; setStairsQty(v === '' ? 0 : Number(v)); }} style={{ marginTop: 10 }} />
            </div>
            <div className="field-group">
              <label className="label" style={{ color: 'rgba(255,255,255,0.8)' }}>m² PËR COPË</label>
              <div className="chip-row">
                {SHKALLORE_PER_CHIPS.map((v) => (
                  <button key={v} className="chip" type="button" onClick={() => { setStairsPer(v); vibrateTap(30); }} style={Number(stairsPer) === v ? { outline: '2px solid rgba(255,255,255,0.35)' } : null}>{v}</button>
                ))}
              </div>
              <input type="number" step="0.01" className="input" value={Number(stairsPer || 0) === 0 ? '' : stairsPer} onChange={(e) => { const v = e.target.value; setStairsPer(v === '' ? 0 : Number(v)); }} style={{ marginTop: 10 }} />
            </div>
            <div className="field-group">
              <label className="label" style={{ color: 'rgba(255,255,255,0.8)' }}>FOTO</label>
              <label className="camera-btn">📷<input type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => handleStairsPhotoChange(e.target.files?.[0])} /></label>
              {stairsPhotoUrl && (
                <div style={{ marginTop: 8 }}>
                  <img src={stairsPhotoUrl} className="photo-thumb" alt="" />
                  <button className="btn secondary" style={{ display: 'block', fontSize: 10, padding: '4px 8px', marginTop: 4 }} onClick={() => setStairsPhotoUrl('')}>🗑️ FSHI FOTO</button>
                </div>
              )}
            </div>
            <button className="btn primary" style={{ width: '100%', marginTop: 12 }} onClick={() => setShowStairsSheet(false)}>MBYLL</button>
          </div>
        </div>
      )}

      {showClientSearch ? (
        <div className="wiz-backdrop" onClick={() => setShowClientSearch(false)}>
          <div className="apple-sheet compact" onClick={(e) => e.stopPropagation()}>
            <div className="apple-sheet-top">
              <div>
                <div className="apple-sheet-title">KËRKO KLIENT</div>
                <div className="apple-sheet-sub">KOD • EMËR • TELEFON</div>
              </div>
              <button type="button" className="apple-close" onClick={() => setShowClientSearch(false)}>✕</button>
            </div>

            <div className="apple-sheet-body">
              <div className="field-group" style={{ marginTop: 0 }}>
                <input className="input apple-search-input" id="clientSearchInput" value={clientQuery} onChange={(e) => setClientQuery(e.target.value)} placeholder="p.sh. 98 / arben / 045..." />
                {clientsLoading ? <div className="apple-help-text" style={{ marginTop: 8 }}>DUKE NGARKUAR KLIENTËT...</div> : null}
              </div>

              {clientHits && clientHits.length ? (
                <div className="apple-results-list">
                  {clientHits.map((c) => (
                    <button
                      key={`${c.code}_${c.phone}`}
                      type="button"
                      className="apple-result-row"
                      onClick={() => {
                        if (c.name) setName(String(c.name));
                        if (c.code) setCodeRaw(String(c.code));
                        setPhone(String(c.phone || '').replace(/\D/g, ''));
                        setClientQuery('');
                        setClientHits([]);
                        setShowClientSearch(false);
                      }}
                    >
                      <div className="apple-result-title"><span className="result-code-badge">NR {String(c.code || '')}</span> <span>{String(c.name || '').toUpperCase()}</span></div>
                      <div className="apple-result-sub">{phonePrefix} {String(c.phone || '')}</div>
                    </button>
                  ))}
                </div>
              ) : clientQuery ? (
                <div className="client-empty-state" style={{ marginTop: 8 }}>NUK U GJET ASNJË KLIENT.</div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {showWizard ? (
        <div className="wiz-backdrop" onClick={closeWizard}>
          <div className="apple-sheet compact" onClick={(e) => e.stopPropagation()}>
            <div className="apple-sheet-top">
              <div>
                <div className="apple-sheet-title">KLIENT I RI</div>
                <div className="apple-sheet-sub">FORMË E THJESHTË</div>
              </div>
              <button type="button" className="apple-close" onClick={closeWizard}>✕</button>
            </div>

            <div className="apple-sheet-body">
              <div className="apple-photo-row">
                <label className="apple-photo-picker">
                  {clientPhotoUrl ? <img src={clientPhotoUrl} alt="" className="apple-photo-preview" /> : <span>📸</span>}
                  <input type="file" hidden accept="image/*" onChange={(e) => handleClientPhotoChange(e.target.files?.[0])} />
                </label>
                <div className="apple-help-text">FOTO</div>
              </div>

              <div className="field-group">
                <label className="label">EMRI & MBIEMRI</label>
                <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="EMRI I KLIENTIT" />
              </div>

              <div className="field-group">
                <label className="label">TELEFONI</label>
                <div className="row">
                  <input className="input small" value={phonePrefix} readOnly />
                  <input className="input" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="44XXXXXX" />
                </div>
              </div>

              {oldClientDebt > 0 && <div style={{ marginTop:8, padding:'10px 12px', borderRadius:12, background:'rgba(239,68,68,0.16)', border:'1px solid rgba(239,68,68,0.35)', color:'#fecaca', fontWeight:900, fontSize:12 }}>⚠️ KUJDES: KY KLIENT KA {oldClientDebt.toFixed(2)}€ BORXH TË VJETËR!</div>}
            </div>

            <div className="apple-sheet-actions">
              <button type="button" className="btn secondary" onClick={closeWizard}>ANULO</button>
              <button type="button" className="btn" onClick={closeWizard}>RUAJ KLIENTIN</button>
            </div>
          </div>
        </div>
      ) : null}

      <style jsx>{`

        .client-toolbar{ display:flex; gap:10px; margin-top:8px; }
        .icon-chip{ width:54px; height:54px; border:none; border-radius:999px; background:#f2f2f7; color:#111; display:flex; align-items:center; justify-content:center; font-size:28px; font-weight:900; box-shadow:0 10px 26px rgba(0,0,0,0.24); transition:transform .18s ease, box-shadow .18s ease, background .18s ease; }
        .icon-chip:active{ transform:scale(.97); }
        .icon-chip svg{ width:28px; height:28px; display:block; flex:0 0 28px; overflow:visible; }
        .icon-chip.add svg{ width:34px; height:34px; flex-basis:34px; }
        .icon-chip.plus{ background:#ffffff; }
        .header-icon-btn{ position:relative; width:42px; height:42px; border:none; border-radius:999px; background:#f2f2f7; color:#111; display:flex; align-items:center; justify-content:center; font-size:18px; font-weight:900; box-shadow:0 8px 20px rgba(0,0,0,0.18); transition:transform .18s ease, box-shadow .18s ease, background .18s ease; }
        .header-icon-btn:active{ transform:scale(.97); }
        .header-icon-badge{ position:absolute; top:-4px; right:-4px; min-width:18px; height:18px; padding:0 5px; border-radius:999px; background:#34c759; color:#fff; display:flex; align-items:center; justify-content:center; font-size:11px; line-height:1; font-weight:900; box-shadow:0 4px 10px rgba(52,199,89,0.35); }
        .client-selected-card{ margin-top:12px; padding:14px; border-radius:20px; background:linear-gradient(180deg, rgba(255,255,255,0.08), rgba(255,255,255,0.04)); border:1px solid rgba(255,255,255,0.12); display:flex; align-items:center; justify-content:space-between; gap:12px; }
        .client-selected-main{ display:flex; align-items:center; gap:12px; min-width:0; }
        .client-selected-name{ font-size:16px; font-weight:900; color:#fff; letter-spacing:.02em; }
        .client-selected-phone{ font-size:12px; font-weight:800; color:rgba(255,255,255,0.72); margin-top:3px; }
        .client-selected-actions{ display:flex; gap:8px; align-items:center; }
        .mini-action{ min-height:38px; padding:0 12px; border:none; border-radius:999px; background:#f2f2f7; color:#111; font-size:11px; font-weight:900; letter-spacing:.04em; }
        .mini-action.primary{ background:#007aff; color:#fff; }
        .client-empty-state{ margin-top:12px; padding:14px; border-radius:18px; background:rgba(255,255,255,0.05); border:1px dashed rgba(255,255,255,0.16); color:rgba(255,255,255,0.78); font-size:12px; font-weight:800; line-height:1.4; text-align:center; }
        .client-avatar-fallback{ width:44px; height:44px; border-radius:999px; display:flex; align-items:center; justify-content:center; background:#f2f2f7; color:#111; font-size:20px; }
        .client-mini.large{ width:44px; height:44px; }
        .row-flash-add{ background:rgba(52,199,89,0.16); border-color:rgba(52,199,89,0.45)!important; box-shadow:0 0 0 1px rgba(52,199,89,0.22), 0 10px 26px rgba(52,199,89,0.12); transition:background .35s ease, border-color .35s ease, opacity .22s ease, transform .22s ease; }
        .row-flash-remove{ background:rgba(255,59,48,0.16); border-color:rgba(255,59,48,0.45)!important; opacity:.25; transform:scale(.985); transition:background .22s ease, border-color .22s ease, opacity .22s ease, transform .22s ease; }
        .apple-sheet{ width:min(100%, 398px); max-width:398px; border-radius:26px; background:linear-gradient(180deg, #151518 0%, #0c0c0f 100%); border:1px solid rgba(255,255,255,0.10); box-shadow:0 24px 70px rgba(0,0,0,0.48); overflow:hidden; }
        .apple-sheet.compact{ max-width:398px; }
        .apple-sheet-top{ display:flex; align-items:flex-start; justify-content:space-between; gap:10px; padding:16px 14px 10px; border-bottom:1px solid rgba(255,255,255,0.08); }
        .apple-sheet-title{ color:#fff; font-size:17px; font-weight:900; letter-spacing:.02em; line-height:1.05; }
        .apple-sheet-sub{ color:rgba(255,255,255,0.7); font-size:10px; font-weight:800; margin-top:3px; letter-spacing:.08em; }
        .apple-close{ width:44px; height:44px; flex:0 0 44px; border:none; border-radius:999px; background:#2c2c2e; color:#fff; font-size:18px; font-weight:900; }
        .apple-sheet-body{ padding:12px 14px 14px; max-height:min(72vh, 620px); overflow:auto; }
        .apple-sheet-actions{ display:grid; grid-template-columns:1fr 1fr; gap:10px; padding:0 14px 14px; }
        .apple-sheet-actions .btn{ flex:1; }
        .apple-search-input{ border-radius:20px; }
        .apple-help-text{ font-size:11px; font-weight:800; color:rgba(255,255,255,0.68); letter-spacing:.04em; }
        .apple-results-list{ display:flex; flex-direction:column; gap:10px; margin-top:8px; }
        .apple-result-row{ width:100%; text-align:left; padding:14px 14px; border:none; border-radius:20px; background:#f2f2f7; color:#111; box-shadow:0 8px 22px rgba(0,0,0,0.18); }
        .apple-result-title{ font-size:14px; font-weight:900; display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
        .apple-result-sub{ font-size:12px; font-weight:700; color:#4b5563; margin-top:4px; }
        .result-code-badge{ display:inline-flex; align-items:center; min-height:24px; padding:0 10px; border-radius:999px; background:linear-gradient(180deg,#3fe07e 0%, #26b85d 100%); color:#fff; font-size:11px; font-weight:900; letter-spacing:.06em; box-shadow:0 8px 18px rgba(52,199,89,0.22); }
        .apple-photo-row{ display:flex; flex-direction:column; align-items:center; justify-content:center; gap:8px; margin-bottom:10px; }
        .apple-photo-picker{ width:84px; height:84px; border-radius:999px; background:#f2f2f7; color:#111; display:flex; align-items:center; justify-content:center; overflow:hidden; font-size:30px; box-shadow:0 12px 28px rgba(0,0,0,0.22); cursor:pointer; }
        .apple-photo-preview{ width:100%; height:100%; object-fit:cover; }
        .client-mini{ width: 34px; height: 34px; border-radius: 999px; object-fit: cover; border: 1px solid rgba(255,255,255,0.18); box-shadow: 0 6px 14px rgba(0,0,0,0.35); }
        .chip-row.modern { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
        .chip-modern { padding: 10px 14px; border-radius: 14px; font-weight: 900; letter-spacing: 0.2px; color: rgba(255,255,255,0.92); backdrop-filter: blur(8px); }
        .chip-modern:active { transform: translateY(1px); }
        .chip-bump { animation: chipBump 140ms ease-in-out; }
        @keyframes chipBump { 0% { transform: translateY(0) scale(1); } 40% { transform: translateY(1px) scale(0.98); } 70% { transform: translateY(0) scale(1.02); } 100% { transform: translateY(0) scale(1); } }
        .modal-overlay { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.6); display: flex; align-items: center; justify-content: center; z-index: 9999; padding: 20px; }
        .modal-content { width: 100%; max-width: 420px; padding: 18px; border-radius: 18px; box-shadow: 0 10px 25px rgba(0, 0, 0, 0.35); background: white; }
        .modal-content.dark { background: #0b0b0b; color: #fff; border: 1px solid rgba(255, 255, 255, 0.1); }
        .payfs { position: fixed; inset: 0; z-index: 9999; background: #0b0f14; display: flex; flex-direction: column; }
        .payfs-top { display: flex; justify-content: space-between; align-items: center; padding: 14px 14px; background: #0b0f14; border-bottom: 1px solid rgba(255, 255, 255, 0.08); }
        .payfs-title { color: #fff; font-weight: 900; font-size: 18px; }
        .payfs-sub { color: rgba(255, 255, 255, 0.72); font-size: 12px; margin-top: 2px; }
        .payfs-body { flex: 1; overflow: auto; padding: 14px; }
        .payfs-footer { display: flex; gap: 10px; padding: 12px 14px; border-top: 1px solid rgba(255, 255, 255, 0.08); background: #0b0f14; }
        .payfs-footer .btn { flex: 1; }
        .wiz-backdrop{ position:fixed; inset:0; background: rgba(0,0,0,0.72); display:flex; align-items:center; justify-content:center; z-index:9999; padding: 14px; }
        .pill{ border: 1px solid rgba(255,255,255,0.14); background: rgba(255,255,255,0.06); color: rgba(255,255,255,0.9); padding: 10px 12px; border-radius: 14px; font-weight: 900; letter-spacing: 0.4px; font-size: 11px; }
        .wiz-card{ width:100%; max-width:480px; max-height:92vh; overflow:hidden; display:flex; flex-direction:column; border-radius:24px; background:linear-gradient(180deg, #0f141b 0%, #090c10 100%); border:1px solid rgba(255,255,255,0.12); box-shadow: 0 22px 70px rgba(0,0,0,0.48); }

        .client-toolbar{ display:flex; justify-content:space-between; align-items:center; gap:14px; margin-top:12px; }
        .icon-chip{ position:relative; width:62px; height:62px; border:none; border-radius:999px; display:flex; align-items:center; justify-content:center; font-size:25px; font-weight:900; box-shadow:0 14px 28px rgba(0,0,0,0.26), inset 0 2px 0 rgba(255,255,255,0.78), inset 0 -10px 18px rgba(255,255,255,0.12); transition:transform .18s ease, box-shadow .18s ease, filter .18s ease; }
        .icon-chip:active{ transform:scale(.965); }
        .icon-chip.search{ background:linear-gradient(180deg, #eff7ff 0%, #cfe4ff 100%); color:#0a66ff; }
        .icon-chip.add{ background:linear-gradient(180deg, #f0fff4 0%, #c9f7d6 100%); color:#10a34a; }
        .icon-chip.drafts{ background:linear-gradient(180deg, #fff6ea 0%, #ffd7b0 100%); color:#b35b00; }
        .header-icon-btn{ position:relative; width:42px; height:42px; border:none; border-radius:999px; background:linear-gradient(180deg,#fff6d8 0%, #ffe8a3 100%); color:#8a5a00; display:flex; align-items:center; justify-content:center; font-size:18px; font-weight:900; box-shadow:0 8px 20px rgba(0,0,0,0.18), inset 0 1px 0 rgba(255,255,255,0.7); transition:transform .18s ease, box-shadow .18s ease, background .18s ease; }
        .client-selected-card{ margin-top:14px; padding:16px; border-radius:22px; background:linear-gradient(180deg, rgba(255,255,255,0.10), rgba(255,255,255,0.05)); border:1px solid rgba(255,255,255,0.14); display:flex; align-items:center; justify-content:space-between; gap:12px; }
        .client-selected-copy{ min-width:0; }
        .client-code-pill{ display:inline-flex; align-items:center; min-height:28px; padding:0 12px; border-radius:999px; background:linear-gradient(180deg,#3fe07e 0%, #26b85d 100%); color:#fff; font-size:12px; font-weight:900; letter-spacing:.08em; box-shadow:0 10px 22px rgba(52,199,89,0.24), inset 0 1px 0 rgba(255,255,255,0.45); margin-bottom:8px; }
        .client-selected-name{ font-size:24px; font-weight:900; color:#fff; letter-spacing:.01em; line-height:1.08; }
        .client-selected-phone{ font-size:19px; font-weight:850; color:#eef2ff; margin-top:6px; letter-spacing:.01em; }
        .mini-action{ min-height:42px; padding:0 14px; border:none; border-radius:999px; background:#f2f2f7; color:#111; font-size:11px; font-weight:900; letter-spacing:.04em; }
        .client-avatar-fallback{ width:50px; height:50px; border-radius:16px; display:flex; align-items:center; justify-content:center; background:#f2f2f7; color:#111; font-size:22px; }
        .client-mini.large{ width:50px; height:50px; border-radius:16px; }
        .apple-photo-row{ display:flex; flex-direction:row; align-items:center; justify-content:flex-start; gap:10px; margin-bottom:8px; }
        .apple-photo-picker{ width:42px; height:42px; flex:0 0 42px; border-radius:12px; background:linear-gradient(180deg,#f2f2f7 0%, #e5e5ea 100%); color:#111; display:flex; align-items:center; justify-content:center; overflow:hidden; font-size:15px; box-shadow:0 8px 18px rgba(0,0,0,0.18), inset 0 1px 0 rgba(255,255,255,0.72); cursor:pointer; }
        .apple-help-text{ font-size:10px; font-weight:900; color:rgba(255,255,255,0.92); letter-spacing:.03em; line-height:1.1; }
        .field-group .label{ font-size:14px; font-weight:900; color:#fff; margin-bottom:7px; display:block; }
        .field-group .input{ min-height:64px; width:100%; font-size:22px; font-weight:900; border-radius:20px; }
        .field-group .row{ display:grid; grid-template-columns:78px minmax(0,1fr); align-items:stretch; gap:8px; }
        .field-group .input.small{ width:78px; min-width:78px; max-width:78px; padding-left:10px; padding-right:10px; font-size:16px; text-align:center; letter-spacing:0; }
        .chip-row.modern { display:flex; flex-wrap:wrap; gap:10px; margin-top:10px; }
        .chip-modern { min-height:53px; padding:13px 18px; border-radius:18px; font-size:17px; font-weight:900; letter-spacing:0.2px; color:#fff; backdrop-filter:blur(8px); box-shadow:0 12px 22px rgba(0,0,0,0.20), inset 0 1px 0 rgba(255,255,255,0.22); }
        .camera-btn{ width:32px; min-width:32px; height:32px; border-radius:10px; font-size:13px; box-shadow:0 8px 18px rgba(0,0,0,0.18), inset 0 1px 0 rgba(255,255,255,0.6); }

        .wiz-top{ display:flex; align-items:center; justify-content:space-between; gap:12px; padding:16px 16px 12px; border-bottom:1px solid rgba(255,255,255,0.08); }
        .wiz-title{ color:#fff; font-size:18px; font-weight:900; letter-spacing:0.6px; }
        .wiz-sub{ color:rgba(255,255,255,0.6); font-size:11px; font-weight:800; margin-top:2px; }
        .wiz-x{ min-width:42px; height:42px; border:none; border-radius:12px; background:rgba(255,255,255,0.08); color:#fff; font-size:18px; font-weight:900; }
        .wiz-transport-steps{ display:grid; grid-template-columns:repeat(5, minmax(0,1fr)); gap:8px; padding:12px 16px 0; }
        .wiz-step-btn{ min-height:42px; border-radius:12px; border:1px solid rgba(255,255,255,0.12); background:rgba(255,255,255,0.04); color:#fff; font-size:11px; font-weight:800; padding:8px 6px; }
        .wiz-step-btn.active{ border-color:rgba(14,165,233,.9); background:rgba(14,165,233,.14); }
        .wiz-step-btn.done{ background:rgba(34,197,94,.14); }
        .wiz-body.transport-like{ flex:1; overflow:auto; padding:0 16px 16px; }
        .wiz-section{ margin-top:16px; }
        .wiz-premium-grid{ display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:10px; }
        .wiz-premium-box{ padding:14px 10px; border-radius:18px; border:1px solid rgba(255,255,255,0.14); background:linear-gradient(180deg, rgba(14,165,233,.18) 0%, rgba(255,255,255,.04) 100%); box-shadow: inset 0 1px 0 rgba(255,255,255,0.06), 0 12px 24px rgba(0,0,0,0.24); }
        .wiz-premium-label{ font-size:10px; color:rgba(255,255,255,0.68); font-weight:900; letter-spacing:0.7px; margin-bottom:8px; }
        .wiz-premium-value{ font-size:20px; color:#fff; font-weight:900; letter-spacing:0.2px; }
        .wiz-actions{ display:flex; gap:10px; padding:12px 16px 16px; border-top:1px solid rgba(255,255,255,0.08); background:#0b0f14; }
        .wiz-actions .btn{ flex:1; }
        .pill.on{ background: rgba(34,197,94,0.16); border-color: rgba(34,197,94,0.28); color: rgba(255,255,255,0.95); }
        .wiz-card{ width: min(92vw, 560px); max-height: 88vh; overflow: hidden; background:#0b0f14; border:1px solid rgba(255,255,255,0.14); border-radius: 16px; box-shadow: 0 20px 60px rgba(0,0,0,0.55); display:flex; flex-direction: column; }
        .wiz-top{ display:flex; align-items:center; justify-content:space-between; padding: 12px 12px 8px 12px; border-bottom: 1px solid rgba(255,255,255,0.08); }
        .wiz-title{ font-weight: 900; letter-spacing: .08em; }
        .wiz-x{ background: transparent; border: 0; color: #fff; font-size: 18px; padding: 8px 10px; }
        .wiz-steps{ display:flex; gap: 8px; padding: 10px 12px; }
        .wiz-dot{ width: 28px; height: 28px; border-radius: 999px; display:flex; align-items:center; justify-content:center; font-weight: 900; border: 1px solid rgba(255,255,255,0.22); opacity: .65; }
        .wiz-dot.on{ opacity: 1; border-color: rgba(34,197,94,0.8); box-shadow: 0 0 0 2px rgba(34,197,94,0.18); }
        .wiz-body{ flex:1; overflow:auto; padding: 12px; }
        .wiz-h{ font-weight: 900; letter-spacing: .06em; margin-bottom: 10px; }
        .wiz-tabs{ display:flex; gap: 8px; margin-bottom: 10px; }
        .wiz-tab{ flex:1; padding: 10px 10px; border-radius: 12px; border: 1px solid rgba(255,255,255,0.12); background: transparent; color: #fff; font-weight: 900; letter-spacing: .06em; opacity: .85; }
        .wiz-tab.on{ opacity: 1; background: rgba(59,130,246,0.18); border-color: rgba(59,130,246,0.35); }
        .wiz-actions{ display:flex; gap: 10px; padding: 12px; border-top: 1px solid rgba(255,255,255,0.08); background: #0b0b0b; }
        .wiz-actions .btn{ flex:1; }
        .footer-bar { position: fixed; left: 0; right: 0; bottom: 0; display: flex; gap: 10px; padding: 12px 14px calc(12px + env(safe-area-inset-bottom, 0px)); background: #0b0f14; border-top: 1px solid rgba(255,255,255,0.08); z-index: 1000; }
        .footer-bar .btn { flex: 1; }
        .wrap { padding-bottom: 140px; }

        @media (max-width: 430px){
          .wiz-backdrop{ padding:10px; align-items:flex-start; }
          .apple-sheet{ width:100%; max-width:none; margin-top:70px; border-radius:24px; }
          .apple-sheet.compact{ max-width:none; }
          .apple-sheet-top{ padding:14px 12px 10px; }
          .apple-sheet-body{ padding:10px 12px 12px; }
          .apple-sheet-actions{ padding:0 12px 12px; }
          .field-group{ margin-top:12px; }
          .field-group .input{ min-height:60px; font-size:20px; }
          .field-group .input.small{ width:72px; min-width:72px; max-width:72px; font-size:15px; }
          .field-group .row{ grid-template-columns:72px minmax(0,1fr); gap:8px; }
          .apple-photo-row{ margin-bottom:6px; }
          .apple-close{ width:42px; height:42px; flex-basis:42px; }
          .apple-sheet-actions .btn{ min-height:56px; font-size:18px; }
        }
      `}</style>
    </div>
  );
}
