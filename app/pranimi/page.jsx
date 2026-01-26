'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient';
import { fetchOrdersFromDb, fetchClientsFromDb, saveOrderToDb } from '@/lib/ordersDb';
import { recordCashMove } from '@/lib/arkaCashSync';

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

function computeM2FromRows(tepihaRows, stazaRows, stairsQty, stairsPer) {
  // ✅ if m2 empty -> contributes 0 (so no ghost numbers)
  const t = (tepihaRows || []).reduce((sum, r) => sum + (Number(r.m2) || 0) * (Number(r.qty) || 0), 0);
  const s = (stazaRows || []).reduce((sum, r) => sum + (Number(r.m2) || 0) * (Number(r.qty) || 0), 0);
  const sh = (Number(stairsQty) || 0) * (Number(stairsPer) || 0);
  return Number((t + s + sh).toFixed(2));
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

// ---------- Code reserve ----------
function extractDigitsFromFilename(name) {
  if (!name) return null;
  const m = String(name).match(/\d+/);
  if (!m) return null;
  return parseInt(m[0], 10);
}

async function reserveSharedCode() {
  try {
    const { data, error } = await supabase.storage.from(BUCKET).list('codes', { limit: 1000 });
    if (error) throw error;

    const used = new Set();
    const active = new Set();
    const now = Date.now();
    const LEASE_MIN = 30;

    for (const item of data || []) {
      const name = item.name;
      const n = extractDigitsFromFilename(name);
      if (!n) continue;

      if (name.endsWith('.used')) used.add(n);

      if (name.endsWith('.lock')) {
        const parts = name.split('.');
        const ts = parts?.[1] ? parseInt(parts[1], 10) : 0;
        const ageMin = ts ? (now - ts) / 60000 : 0;

        if (ageMin > LEASE_MIN) {
          supabase.storage.from(BUCKET).remove([`codes/${name}`]).catch(() => {});
        } else {
          active.add(n);
        }
      }
    }

    let candidate = 1;
    while (used.has(candidate) || active.has(candidate)) candidate++;

    const lockName = `codes/${candidate}.${Date.now()}.lock`;
    const file =
      typeof File !== 'undefined'
        ? new File([String(Date.now())], 'lock.txt', { type: 'text/plain' })
        : null;

    if (file) {
      const { error: upErr } = await supabase.storage.from(BUCKET).upload(lockName, file, { upsert: false });
      if (upErr) {
        const key = 'client_code_counter';
        const n = (parseInt(localStorage.getItem(key) || '0', 10) || 0) + 1;
        localStorage.setItem(key, String(n));
        return String(n);
      }
    }

    return String(candidate);
  } catch {
    const key = 'client_code_counter';
    const n = (parseInt(localStorage.getItem(key) || '0', 10) || 0) + 1;
    localStorage.setItem(key, String(n));
    return String(n);
  }
}

async function markCodeUsed(code) {
  try {
    const n = normalizeCode(code);
    const usedPath = `codes/${n}.used`;
    const blob = new Blob([JSON.stringify({ at: new Date().toISOString() })], { type: 'application/json' });
    await supabase.storage.from(BUCKET).upload(usedPath, blob, { upsert: true, cacheControl: '0' });
  } catch {}
}

async function releaseLocksForCode(code) {
  try {
    const n = normalizeCode(code);
    const { data } = await supabase.storage.from(BUCKET).list('codes', { limit: 1000 });
    const toRemove = [];
    for (const item of data || []) {
      const name = item.name;
      if (!name.endsWith('.lock')) continue;
      const digits = extractDigitsFromFilename(name);
      if (digits && String(digits) === String(n)) toRemove.push(`codes/${name}`);
    }
    if (toRemove.length) await supabase.storage.from(BUCKET).remove(toRemove);
  } catch {}
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

// init offline mode + monitor connectivity
useEffect(() => {
  try {
    const init = loadOfflineModeInit();
    setOfflineMode(init);
  } catch {}

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

  async function refreshDrafts() {
    try {
      // ✅ SHARED list (remote)
      const remote = await fetchRemoteDraftsSummary();
      setDrafts(remote);
    } catch {
      setDrafts([]);
    }
  }

  // ---------- CLIENT SEARCH (rikthime) ----------
  async function loadClientsIndexOnce() {
    if (clientsLoading) return;
    // Don't skip if index is empty
    setClientsLoading(true);
    try {
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
        const name = `${c.first_name || ''} ${c.last_name || ''}`.trim();
        const info = byCode.get(codeStr) || { active: 0, last_seen: null };
        items.push({
          code: codeStr,
          name: name || 'Pa Emër',
          phone: String(c?.phone || '').replace('+383', ''),
          active: info.active,
          last_seen: info.last_seen
        });
      }
      setClientsIndex(items);
    } catch (err) {
      console.error("Index load error", err);
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

    if (clientsIndex.length === 0) {
      loadClientsIndexOnce();
    }

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

    setClientHits(matches);
  }, [clientQuery, clientsIndex]);

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

      const id = `ord_${Date.now()}`;
      setOid(id);

      const c = await reserveSharedCode();
      setCodeRaw(c);

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
    setPayAdd(0);
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
      await writeSharedPrice(v);
    } catch {}
    setShowPriceSheet(false);
  }

  function startPayHold() {
    payHoldTriggeredRef.current = false;
    if (payHoldTimerRef.current) clearTimeout(payHoldTimerRef.current);
    payHoldTimerRef.current = setTimeout(() => {
      payHoldTriggeredRef.current = true;
      vibrateTap(25);
      openPriceEditor();
    }, 3000);
  }

  function endPayHold() {
    if (payHoldTimerRef.current) clearTimeout(payHoldTimerRef.current);
    payHoldTimerRef.current = null;
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

    if (payMethod === 'CASH') {
      const actor = (() => {
        try {
          const raw = localStorage.getItem('CURRENT_USER_DATA');
          if (raw) return JSON.parse(raw);
        } catch {}
        return null;
      })();

      if (!actor?.pin) {
        alert('DUHET ME QENE I KYQUR (ME PIN) PER ME REGJISTRU PAGESA CASH.');
        return;
      }

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
        createdByPin: String(actor.pin),
        createdBy: actor?.name ? String(actor.name) : null,
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
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return { ok: false, reason: 'NO_INTERNET' };
      const r = await fetch('/api/backup/ping', { cache: 'no-store' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j?.ok) return { ok: false, reason: j?.error || 'PING_FAILED' };
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
        pieces: copeCount,
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

      const conn = await checkConnectivity();
      if (offlineMode || !conn.ok) {
        saveOfflineQueueItem(order);
        setOfflineMode(true);
        alert('✅ U RUAJT OFFLINE.');
        return;
      }

      const blob = new Blob([JSON.stringify(order)], { type: 'application/json' });
      await supabase.storage.from(BUCKET).upload(`orders/${oid}.json`, blob, {
        upsert: true, cacheControl: '0', contentType: 'application/json'
      });

      // ✅ SAVE TO DB (TRICK: Force activation here)
      const db = await saveOrderToDb(order);
      
      removeDraftLocal(oid);
      await deleteDraftRemote(oid);
      await markCodeUsed(order.client.code);
      await releaseLocksForCode(order.client.code);

      if (autoMsgAfterSave) {
        setPendingNavTo('/pastrimi');
        setShowMsgSheet(true);
        return;
      }
      router.push('/pastrimi');
    } catch (e) {
      alert('❌ Gabim ruajtja!');
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
      setTepihaRows(Array.isArray(d.tepihaRows) ? d.tepihaRows : []);
      setStazaRows(Array.isArray(d.stazaRows) ? d.stazaRows : []);
      setStairsQty(Number(d.stairsQty) || 0);
      setStairsPer(Number(d.stairsPer) || SHKALLORE_M2_PER_STEP_DEFAULT);
      setPricePerM2(Number(d.pricePerM2) || PRICE_DEFAULT);
      setClientPaid(Number(d.clientPaid) || 0);
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
    const nm = (name || '').trim() ? `Përshëndetje ${name.trim()},` : 'Përshëndetje,';
    return `${nm} procesi i pastrimit ka filluar.\nKODI: ${kod} • TEPIHA: ${copeCount} COPË • ${m2} m² • TOTAL: ${euro} €.\nBORXH: ${debt} €.\nSIPAS KAPACITETIT: ${etaText}.\nDO T'JU LAJMËROJMË KUR BËHEN GATI.`;
  }

  function sendViaSMS() {
    const to = sanitizePhone(phonePrefix + phone);
    const body = encodeURIComponent(buildStartMessage());
    window.location.href = `sms:${to}?&body=${body}`;
  }

  function sendViaWhatsApp() {
    const to = sanitizePhone(phonePrefix + phone);
    const text = encodeURIComponent(buildStartMessage());
    window.location.href = `https://wa.me/${to}?text=${text}`;
  }

  function sendViaViber() {
    const to = sanitizePhone(phonePrefix + phone);
    window.location.href = `viber://chat?number=%2B${to}`;
    navigator.clipboard?.writeText(buildStartMessage());
    alert('Mesazhi u kopjua.');
  }

  return (
    <div className="wrap">
      {showOfflinePrompt && (
        <div className="modal-overlay">
          <div className="modal-content dark">
            <div style={{ fontWeight: 900 }}>S’KA LIDHJE</div>
            <p>A don me vazhdu në OFFLINE MODE?</p>
            <div className="row" style={{ gap: 10 }}>
              <button className="btn primary" onClick={() => { setOfflineMode(true); setShowOfflinePrompt(false); }}>PO</button>
              <button className="btn secondary" onClick={() => setShowOfflinePrompt(false)}>JO</button>
            </div>
          </div>
        </div>
      )}

      <header className="header-row">
        <div>
          <h1 className="title">PRANIMI</h1>
          <div className="subtitle">KRIJO POROSI</div>
        </div>
        <div className="code-badge">
          <span className="badge">{`KODI: ${normalizeCode(codeRaw)}`}</span>
        </div>
      </header>

      <section className="cap-mini">
        <div className="cap-mini-top">
          <div className="cap-mini-title">SOT NË PASTRIM</div>
          <div className="cap-mini-val">{Number(todayPastrimM2 || 0).toFixed(1)} m²</div>
        </div>
        <div className="cap-mini-eta">{etaText}</div>
      </section>

      <section style={{ marginTop: 10 }}>
        <button className="btn secondary" style={{ width: '100%' }} onClick={openDrafts}>
          📝 TË PA PLOTSUARAT {drafts.length > 0 ? `(${drafts.length})` : ''}
        </button>
      </section>

      <section className="card">
        <h2 className="card-title">KLIENTI</h2>
        <div className="field-group">
          <label className="label">KËRKO KLIENTIN (KOD / EMËR / TELEFON)</label>
          <input className="input" value={clientQuery} onChange={(e) => setClientQuery(e.target.value)} placeholder="Kërko..." />
          {clientHits.length > 0 && (
            <div className="list" style={{ marginTop: 8, maxHeight: 200, overflow: 'auto' }}>
              {clientHits.map((c) => (
                <button
                  key={c.code}
                  className="rowbtn"
                  style={{ width: '100%', marginBottom: 5, padding: 10, borderRadius: 8, textAlign: 'left' }}
                  onClick={() => {
                    setCodeRaw(c.code);
                    setName(c.name);
                    setPhone(c.phone);
                    setClientQuery('');
                    setClientHits([]);
                  }}
                >
                  <strong>{c.code}</strong> • {c.name.toLowerCase()} ({c.phone})
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="field-group">
          <label className="label">EMRI & MBIEMRI</label>
          <div className="row" style={{ alignItems: 'center', gap: 10 }}>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} style={{ flex: 1 }} />
            {clientPhotoUrl && <img src={clientPhotoUrl} alt="" className="client-mini" />}
            <label className="camera-btn">📷<input type="file" accept="image/*" style={{ display: 'none' }} onChange={(e) => handleClientPhotoChange(e.target.files?.[0])} /></label>
          </div>
        </div>

        <div className="field-group">
          <label className="label">TELEFONI</label>
          <div className="row">
            <input className="input small" value={phonePrefix} readOnly />
            <input className="input" value={phone} onChange={(e) => setPhone(e.target.value)} />
          </div>
        </div>
      </section>

      <section className="card">
        <h2 className="card-title">TEPIHA</h2>
        <div className="chip-row modern">
          {TEPIHA_CHIPS.map((v) => (
            <button key={v} className="chip chip-modern" onClick={(e) => applyChip('tepiha', v, e)} style={chipStyleForVal(v, false)}>{v.toFixed(1)}</button>
          ))}
        </div>
        {tepihaRows.map((row) => (
          <div className="piece-row" key={row.id}>
            <div className="row">
              <input className="input small" type="number" value={row.m2} onChange={(e) => handleRowChange('tepiha', row.id, 'm2', e.target.value)} placeholder="m²" />
              <input className="input small" type="number" value={row.qty} onChange={(e) => handleRowChange('tepiha', row.id, 'qty', e.target.value)} placeholder="copë" />
            </div>
          </div>
        ))}
        <div className="row btn-row">
          <button className="btn secondary" onClick={() => addRow('tepiha')}>+ RRESHT</button>
          <button className="btn secondary" onClick={() => removeRow('tepiha')}>− RRESHT</button>
        </div>
      </section>

      <section className="card">
        <h2 className="card-title">STAZA</h2>
        <div className="chip-row modern">
          {STAZA_CHIPS.map((v) => (
            <button key={v} className="chip chip-modern" onClick={(e) => applyChip('staza', v, e)} style={chipStyleForVal(v, false)}>{v.toFixed(1)}</button>
          ))}
        </div>
        {stazaRows.map((row) => (
          <div className="piece-row" key={row.id}>
            <div className="row">
              <input className="input small" type="number" value={row.m2} onChange={(e) => handleRowChange('staza', row.id, 'm2', e.target.value)} placeholder="m²" />
              <input className="input small" type="number" value={row.qty} onChange={(e) => handleRowChange('staza', row.id, 'qty', e.target.value)} placeholder="copë" />
            </div>
          </div>
        ))}
        <div className="row btn-row">
          <button className="btn secondary" onClick={() => addRow('staza')}>+ RRESHT</button>
          <button className="btn secondary" onClick={() => removeRow('staza')}>− RRESHT</button>
        </div>
      </section>

      <section className="card">
        <div className="row util-row" style={{ gap: 10 }}>
          <button className="btn secondary" style={{ flex: 1 }} onClick={() => setShowStairsSheet(true)}>🪜 SHKALLORE</button>
          <button className="btn secondary" style={{ flex: 1 }} onMouseDown={startPayHold} onMouseUp={endPayHold}>€ PAGESA</button>
        </div>
        <div className="tot-line">M² Total: <strong>{totalM2}</strong></div>
        <div className="tot-line">Total: <strong>{totalEuro.toFixed(2)} €</strong></div>
        <div className="tot-line">Paguar: <strong style={{ color: '#16a34a' }}>{Number(clientPaid || 0).toFixed(2)} €</strong></div>
        {currentDebt > 0 && <div className="tot-line">Borxh: <strong style={{ color: '#dc2626' }}>{currentDebt.toFixed(2)} €</strong></div>}
      </section>

      <footer className="footer-bar">
        <button className="btn secondary" onClick={() => router.push('/')}>🏠 HOME</button>
        <button className="btn primary" onClick={handleContinue} disabled={photoUploading}>▶ VAZHDO</button>
      </footer>

      {showPaySheet && (
        <div className="payfs">
          <div className="payfs-top">
            <div className="payfs-title">PAGESA</div>
            <button className="btn secondary" onClick={() => setShowPaySheet(false)}>✕</button>
          </div>
          <div className="payfs-body">
            <div className="card">
              <label className="label">SHTO PAGESË (€)</label>
              <input type="number" className="input" value={payAdd || ''} onChange={(e) => setPayAdd(Number(e.target.value))} />
              <div className="chip-row" style={{ marginTop: 10 }}>
                {PAY_CHIPS.map(v => <button key={v} className="chip" onClick={() => setPayAdd(payAdd + v)}>+{v}€</button>)}
              </div>
            </div>
          </div>
          <div className="payfs-footer">
            <button className="btn primary" onClick={applyPayAndClose}>RUJ PAGESËN</button>
          </div>
        </div>
      )}

      {/* SHKALLORE MODAL (simplified) */}
      {showStairsSheet && (
        <div className="modal-overlay">
          <div className="modal-content dark">
            <h3 className="card-title">SHKALLORE</h3>
            <input type="number" className="input" placeholder="Cope" value={stairsQty || ''} onChange={e => setStairsQty(Number(e.target.value))} />
            <button className="btn primary" style={{ marginTop: 10, width: '100%' }} onClick={() => setShowStairsSheet(false)}>MBYLL</button>
          </div>
        </div>
      )}

      <style jsx>{`
        .client-mini{ width: 34px; height: 34px; border-radius: 999px; object-fit: cover; }
        .cap-mini { margin-top: 8px; padding: 10px; border-radius: 12px; background: #0b0b0b; border: 1px solid #222; }
        .cap-mini-val { color: #16a34a; font-weight: 900; }
        .chip-row.modern { display: flex; flex-wrap: wrap; gap: 8px; margin: 10px 0; }
        .chip-modern { padding: 8px 12px; border-radius: 10px; font-weight: 900; }
        .modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.8); z-index: 9999; display: flex; align-items: center; justify-content: center; padding: 20px; }
        .modal-content.dark { background: #0b0b0b; padding: 20px; border-radius: 15px; width: 100%; max-width: 400px; border: 1px solid #333; }
        .payfs { position: fixed; inset: 0; background: #0b0b0b; z-index: 10000; display: flex; flex-direction: column; }
        .payfs-top { display: flex; justify-content: space-between; padding: 15px; border-bottom: 1px solid #222; }
        .payfs-body { flex: 1; padding: 15px; }
        .payfs-footer { padding: 15px; border-top: 1px solid #222; }
      `}</style>
    </div>
  );
}
