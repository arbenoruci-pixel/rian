'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient';
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

  // rows
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

  // capacity (from Pastrimi cache)
  const [etaText, setEtaText] = useState('GATI DITËN E 2-TË (NESËR)');
  const [todayPastrimM2, setTodayPastrimM2] = useState(0);

  // debounce autosave draft
  const draftTimer = useRef(null);

  // ✅ long press refs
  const payHoldTimerRef = useRef(null);
  const payHoldTriggeredRef = useRef(false);

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

  // ✅ IMPORTANT: build + flush draft NOW (fix: photos missing in TË PA PLOTSUARAT)
  function buildDraftSnapshot(overrides = {}) {
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
      ...overrides,
    };
  }

  async function flushDraftNow(overrides = {}) {
    try {
      if (!oid) return;

      const draft = buildDraftSnapshot(overrides);

      const started =
        (draft.name || '').trim() ||
        (draft.phone || '').trim() ||
        (draft.clientPhotoUrl || '') ||
        (draft.notes || '').trim() ||
        (draft.tepihaRows || []).some((r) => String(r.m2 || '').trim() || String(r.qty || '').trim() !== '0' || r.photoUrl) ||
        (draft.stazaRows || []).some((r) => String(r.m2 || '').trim() || String(r.qty || '').trim() !== '0' || r.photoUrl) ||
        Number(draft.stairsQty) > 0 ||
        Number(draft.clientPaid) > 0 ||
        (draft.stairsPhotoUrl || '');

      if (!started) return;

      upsertDraftLocal(draft);
      await upsertDraftRemote(draft);
      await refreshDrafts();
    } catch {}
  }

  async function refreshDrafts() {
    try {
      // ✅ SHARED list (remote)
      const remote = await fetchRemoteDraftsSummary();
      setDrafts(remote);
    } catch {
      setDrafts([]);
    }
  }

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
          (tepihaRows || []).some((r) => String(r.m2 || '').trim() || String(r.qty || '').trim() !== '0' || r.photoUrl) ||
          (stazaRows || []).some((r) => String(r.m2 || '').trim() || String(r.qty || '').trim() !== '0' || r.photoUrl) ||
          Number(stairsQty) > 0 ||
          Number(clientPaid) > 0 ||
          (stairsPhotoUrl || '');

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

  // ✅ FIXED: row photo now flushes draft immediately (so it shows in TË PA PLOTSUARAT)
  async function handleRowPhotoChange(kind, id, file) {
    if (!file || !oid) return;
    setPhotoUploading(true);
    try {
      const url = await uploadPhoto(file, oid, `${kind}_${id}`);
      if (!url) return;

      const rows = kind === 'tepiha' ? tepihaRows : stazaRows;
      const nextRows = (rows || []).map((r) => (r.id === id ? { ...r, photoUrl: url } : r));

      if (kind === 'tepiha') setTepihaRows(nextRows);
      else setStazaRows(nextRows);

      await flushDraftNow(kind === 'tepiha' ? { tepihaRows: nextRows } : { stazaRows: nextRows });
    } catch {
      alert('❌ Gabim foto!');
    } finally {
      setPhotoUploading(false);
    }
  }

  // ✅ FIXED: client photo now flushes draft immediately
  async function handleClientPhotoChange(file) {
    if (!file || !oid) return;
    setPhotoUploading(true);
    try {
      const url = await uploadPhoto(file, oid, 'client');
      if (url) {
        setClientPhotoUrl(url);
        await flushDraftNow({ clientPhotoUrl: url });
      }
    } catch {
      alert('❌ Gabim foto!');
    } finally {
      setPhotoUploading(false);
    }
  }

  // ✅ FIXED: stairs photo now flushes draft immediately
  async function handleStairsPhotoChange(file) {
    if (!file || !oid) return;
    setPhotoUploading(true);
    try {
      const url = await uploadPhoto(file, oid, 'shkallore');
      if (url) {
        setStairsPhotoUrl(url);
        await flushDraftNow({ stairsPhotoUrl: url });
      }
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
    }, 3000);
  }

  function endPayHold() {
    if (payHoldTimerRef.current) clearTimeout(payHoldTimerRef.current);
    payHoldTimerRef.current = null;

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
      setShowPaySheet(false);
      return;
    }

    const due = Math.max(0, Number((Number(totalEuro || 0) - Number(clientPaid || 0)).toFixed(2)));
    const applied = Number(Math.min(cashGiven, due).toFixed(2));
    if (applied <= 0) {
      setShowPaySheet(false);
      return;
    }

    const newPaid = Number((Number(clientPaid || 0) + applied).toFixed(2));
    setClientPaid(newPaid);

    // ✅ ARKA delta only if CASH (local cache + Supabase arka_moves if day open)
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

      const finalArka = Number((Number(arkaRecordedPaid || 0) + applied).toFixed(2));
      setArkaRecordedPaid(finalArka);
    }

    // ✅ flush draft so paid + arkaRecordedPaid is always saved (even if you open drafts right away)
    await flushDraftNow({
      clientPaid: newPaid,
      arkaRecordedPaid: payMethod === 'CASH'
        ? Number((Number(arkaRecordedPaid || 0) + applied).toFixed(2))
        : Number(arkaRecordedPaid || 0),
      payMethod,
    });

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

      const blob = new Blob([JSON.stringify(order)], { type: 'application/json' });
      const { error: uploadError } = await supabase.storage.from(BUCKET).upload(`orders/${oid}.json`, blob, {
        upsert: true,
        cacheControl: '0',
        contentType: 'application/json',
      });
      if (uploadError) throw uploadError;

      localStorage.setItem(`order_${oid}`, JSON.stringify(order));

      // ✅ remove draft (completed) both local + shared
      removeDraftLocal(oid);
      await deleteDraftRemote(oid);
      await refreshDrafts();

      await markCodeUsed(order.client.code);
      await releaseLocksForCode(order.client.code);

      // ✅ after save: open message automatically (toggle)
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

  // ✅ FIXED: opening drafts now flushes instantly so photos/fields never “miss”
  async function openDrafts() {
    await flushDraftNow();
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
      <header className="header-row" style={{ alignItems: 'flex-start' }}>
        <div>
          <h1 className="title">PRANIMI</h1>
          <div className="subtitle">KRIJO POROSI</div>
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
              onClick={(e) => applyChip('tepiha', v, e)}
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
              onClick={(e) => applyChip('staza', v, e)}
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
            onMouseDown={startPayHold}
            onMouseUp={endPayHold}
            onMouseLeave={cancelPayHold}
            onTouchStart={(e) => {
              e.preventDefault();
              startPayHold();
            }}
            onTouchEnd={(e) => {
              e.preventDefault();
              endPayHold();
            }}
            onTouchCancel={cancelPayHold}
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
        <button className="btn secondary" onClick={() => router.push('/')}>🏠 HOME</button>
        <button className="btn primary" onClick={handleContinue} disabled={photoUploading}>
          ▶ VAZHDO
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
                const paidAfter = Number((Number(clientPaid || 0) + Number(payAdd || 0)).toFixed(2));
                const d = Number((totalEuro - paidAfter).toFixed(2));
                const debtNow = d > 0 ? d : 0;
                const changeNow = d < 0 ? Math.abs(d) : 0;

                return (
                  <>
                    <div className="tot-line">
                      PAGUAR PAS KËSAJ: <strong style={{ color: '#16a34a' }}>{paidAfter.toFixed(2)} €</strong>
                    </div>
                    {debtNow > 0 && (
                      <div className="tot-line">BORXH: <strong style={{ color: '#dc2626' }}>{debtNow.toFixed(2)} €</strong></div>
                    )}
                    {changeNow > 0 && (
                      <div className="tot-line">KTHIM: <strong style={{ color: '#2563eb' }}>{changeNow.toFixed(2)} €</strong></div>
                    )}
                  </>
                );
              })()}
            </div>

            <div className="card">
              <div className="field-group">
                <label className="label">SHTO PAGESË (€) — VETËM SOT</label>

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
                    <button key={v} className="chip" type="button" onClick={() => setPayAdd(Number((Number(payAdd || 0) + v).toFixed(2)))}>
                      +{v}€
                    </button>
                  ))}
                  <button className="chip" type="button" onClick={() => setPayAdd(0)} style={{ opacity: 0.9 }}>
                    FSHI
                  </button>
                </div>
              </div>

              <div className="field-group">
                <label className="label">METODA</label>
                <div className="row" style={{ gap: 10 }} data-noswipe="1">
                  <button
                    type="button"
                    className="btn secondary"
                    style={{ flex: 1, outline: payMethod === "CASH" ? "2px solid rgba(255,255,255,0.35)" : "none" }}
                    onClick={() => setPayMethod("CASH")}
                  >
                    CASH
                  </button>
                  <button
                    type="button"
                    className="btn secondary"
                    style={{ flex: 1, outline: payMethod === "CARD" ? "2px solid rgba(255,255,255,0.35)" : "none" }}
                    onClick={() => setPayMethod("CARD")}
                  >
                    CARD / TRANSFER
                  </button>
                </div>
                <div style={{ fontSize: 12, color: "rgba(255,255,255,0.65)", marginTop: 8 }}>
                  * CASH regjistrohet në ARKË. CARD/TRANSFER nuk hyn në ARKË.
                </div>
              </div>

              <div style={{ fontSize: 12, color: '#666', marginTop: 8 }}>
                * Nëse sot nuk pagun, veç mbylle. Borxhi rritet automatikisht nëse shton m².
              </div>
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
      `}</style>
    </div>
  );
}