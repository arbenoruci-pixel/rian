"use client";

import {
  normalizeCode,
  reserveSharedCode,
  ensureBasePool,
  ensureUniqueBaseCodeForSave,
} from '@/lib/baseCodes';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from '@/lib/routerCompat.jsx';
import { supabase, storageWithTimeout, withSupabaseTimeout } from '@/lib/supabaseClient';
import { listOrderRecords, upsertOrderRecord, updateOrderRecord } from '@/lib/ordersService';
import { fetchOrdersFromDb, fetchClientsFromDb } from '@/lib/ordersDb';
import { enqueueBaseOrder, enqueueOutboxItem, syncNow } from '@/lib/syncManager';
import { getAllOrdersLocal, getPendingOps, saveOrderLocal } from '@/lib/offlineStore';
import { recordCashMove } from '@/lib/arkaCashSync';
import PosModal from '@/components/PosModal';
import { getActor } from '@/lib/actorSession';
import { requirePaymentPin } from '@/lib/paymentPin';
import { getClientBalanceByPhone } from '@/lib/clientBalanceDb';
import SmartSmsModal from '@/components/SmartSmsModal';
import { buildSmartSmsText, buildSmsLink } from '@/lib/smartSms';
import { logDebugEvent, trackRender } from '@/lib/sensor';
import { bootLog, bootMarkReady } from '@/lib/bootLog';
import { patchBaseMasterRow } from '@/lib/baseMasterCache';
import { isDiagEnabled } from '@/lib/diagMode';
import useRouteAlive from '@/lib/routeAlive';

const BUCKET = 'tepiha-photos';

const TEPIHA_CHIPS = [2.0, 2.5, 3.0, 3.5, 3.7, 4.0, 5.0, 6.0, 8.0, 12.0];
const STAZA_CHIPS = [0.5, 0.8, 0.9, 1.2, 1.5, 1.6, 2.0, 2.4, 2.5, 3.0, 4.0, 5.0];

const SHKALLORE_QTY_CHIPS = [5, 10, 15, 20, 25, 30];
const SHKALLORE_PER_CHIPS = [0.25, 0.3, 0.35, 0.4];

const SHKALLORE_M2_PER_STEP_DEFAULT = 0.3;
const PRICE_DEFAULT = 1.3;
const LEGACY_BASE_PRICE_DEFAULTS = new Set([1, 3]);
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
const PASRTRIMI_EDIT_TO_PRANIMI_KEY = 'tepiha_pastrim_edit_to_pranimi_v1';
const PASRTRIMI_EDIT_TO_PRANIMI_BACKUP_KEY = 'tepiha_pastrim_edit_to_pranimi_backup_v1';
const GATI_EDIT_TO_PRANIMI_KEY = 'tepiha_gati_edit_to_pranimi_v1';
const GATI_EDIT_TO_PRANIMI_BACKUP_KEY = 'tepiha_gati_edit_to_pranimi_backup_v1';
const PRANIMI_ACTIVE_EDIT_BRIDGE_KEY = 'tepiha_pranimi_active_edit_bridge_v1';
const CURRENT_SESSION_KEY = 'tepiha_pranimi_current_session_v1';
const CURRENT_SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const PRANIMI_BG_META_TIMEOUT_MS = 2500;
const PRANIMI_BG_POOL_TIMEOUT_MS = 3000;
const PRANIMI_BG_SYNC_MIN_GAP_MS = 6000;
const PRANIMI_CONTINUE_CLIENT_LOOKUP_MS = 1000;
const PRANIMI_CONTINUE_CODE_VERIFY_MS = 350;
const PRANIMI_CONTINUE_CODE_RESERVE_MS = 650;
const PRANIMI_CONTINUE_MASTER_SYNC_MS = 1000;

function sanitizePhone(phone) {
  return String(phone || '').replace(/\D+/g, '');
}

function splitFullNameLoose(fullName) {
  const clean = String(fullName || '').trim().replace(/\s+/g, ' ');
  if (!clean) return { first_name: '', last_name: '' };
  const parts = clean.split(' ').filter(Boolean);
  if (parts.length <= 1) return { first_name: clean, last_name: '' };
  return { first_name: parts.slice(0, -1).join(' '), last_name: parts.slice(-1).join('') };
}

function pranimiDiagLog(...args) {
  if (!isDiagEnabled()) return;
  try { console.log(...args); } catch {}
}

function normDigits(s) {
  return String(s || '').replace(/\D+/g, '');
}

function normalizeMatchPhone(raw) {
  let digits = String(raw || '').replace(/\D+/g, '');
  if (digits.startsWith('00383')) digits = digits.slice(5);
  else if (digits.startsWith('383')) digits = digits.slice(3);
  if (digits.startsWith('0') && digits.length >= 8) digits = digits.replace(/^0+/, '');
  return digits;
}

function normalizeMatchName(raw) {
  return String(raw || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function isValidClientPhoneDigits(raw) {
  const digits = normalizeMatchPhone(raw);
  return digits.length >= 8;
}

function pranimiIsOnline() {
  try { return typeof navigator === 'undefined' || navigator.onLine !== false; } catch { return true; }
}

function baseNamesMatchStrong(inputName, candidateName) {
  const a = normalizeMatchName(inputName);
  const b = normalizeMatchName(candidateName);
  if (!a || !b) return false;
  if (a === b) return true;
  const ap = a.split(' ').filter(Boolean);
  const bp = b.split(' ').filter(Boolean);
  if (ap.length < 2 || bp.length < 2) return false;
  const aFirst = ap[0];
  const aLast = ap[ap.length - 1];
  const bFirst = bp[0];
  const bLast = bp[bp.length - 1];
  return aFirst === bFirst && aLast === bLast;
}

function isStrongBaseClientNamePhoneMatch(candidate = {}, { name, phone } = {}) {
  const inputPhone = normalizeMatchPhone(phone);
  const candidatePhone = normalizeMatchPhone(candidate?.phone || candidate?.client_phone || '');
  // BASE now follows the same safety rule as TRANSPORT: a valid phone number is the primary identity.
  // Names may be typed differently by staff, so name mismatch must not cause a new client/code.
  return !!(isValidClientPhoneDigits(inputPhone) && candidatePhone && candidatePhone === inputPhone);
}

function buildClientMatchKey({ reason, phoneDigits, fullName, code, id }) {
  const codeKey = String(normalizeCode(code) || '').trim() || String(id || '').trim() || 'na';
  if (reason === 'phone_exact') return `phone:${String(phoneDigits || '').trim()}:client:${codeKey}`;
  return `name:${String(fullName || '').trim()}:client:${codeKey}`;
}

async function detectExistingClientSmart({ name, phone, clientsIndex, allowLive = true, liveTimeoutMs = 700 } = {}) {
  const phoneDigits = normalizeMatchPhone(phone);
  const fullName = normalizeMatchName(name);
  const fullNameParts = fullName ? fullName.split(' ').filter(Boolean) : [];
  const canCheckPhone = isValidClientPhoneDigits(phoneDigits);
  const canCheckFullName = fullNameParts.length >= 2;
  if (!canCheckPhone) return null;

  const seen = new Map();
  const addCandidate = (row = {}) => {
    const codeVal = normalizeCode(row?.code ?? row?.client_code ?? null);
    const codeKey = codeVal != null ? String(codeVal) : '';
    const idKey = String(row?.id || '').trim();
    const key = idKey || (codeKey ? `code:${codeKey}` : '');
    if (!key || seen.has(key)) return;
    const phoneNorm = normalizeMatchPhone(row?.phone || row?.client_phone || '');
    const nameNorm = normalizeMatchName(row?.name || row?.full_name || row?.client_name || `${row?.first_name || ''} ${row?.last_name || ''}`.trim());
    seen.set(key, {
      id: row?.id || null,
      code: codeVal != null ? String(codeVal) : '',
      name: String(row?.name || row?.full_name || row?.client_name || `${row?.first_name || ''} ${row?.last_name || ''}`.trim() || '').trim(),
      phone: String(row?.phone || row?.client_phone || '').trim(),
      photo_url: String(row?.photo_url || row?.client_photo_url || row?.photoUrl || '').trim(),
      active: Number(row?.active || 0) || 0,
      last_seen: row?.last_seen || row?.updated_at || null,
      phoneNorm,
      nameNorm,
    });
  };

  for (const item of (Array.isArray(clientsIndex) ? clientsIndex : [])) addCandidate(item);

  try {
    if (allowLive !== false && (typeof navigator === 'undefined' || navigator.onLine !== false)) {
      if (canCheckPhone) {
        const hits = await withSupabaseTimeout(
          searchClientsLive(phoneDigits),
          Number(liveTimeoutMs || 700),
          'PRANIMI_DUPLICATE_PHONE_LOOKUP_TIMEOUT',
          { source: 'detectExistingClientSmart', mode: 'phone' }
        ).catch(() => []);
        for (const item of (Array.isArray(hits) ? hits : [])) addCandidate(item);
      }
      if (canCheckFullName) {
        const hits = await withSupabaseTimeout(
          searchClientsLive(fullName),
          Number(liveTimeoutMs || 700),
          'PRANIMI_DUPLICATE_NAME_LOOKUP_TIMEOUT',
          { source: 'detectExistingClientSmart', mode: 'name' }
        ).catch(() => []);
        for (const item of (Array.isArray(hits) ? hits : [])) addCandidate(item);
      }
    }
  } catch {}

  const all = Array.from(seen.values());
  const sortBest = (a, b) => {
    if ((Number(b?.active || 0) - Number(a?.active || 0)) !== 0) return Number(b?.active || 0) - Number(a?.active || 0);
    return String(b?.last_seen || '').localeCompare(String(a?.last_seen || ''));
  };

  if (canCheckPhone) {
    const phoneMatches = all
      .filter((item) => item.phoneNorm && item.phoneNorm === phoneDigits)
      .sort(sortBest);
    if (phoneMatches.length) {
      const winner = phoneMatches[0];
      return {
        open: true,
        reason: 'phone_exact',
        phoneDigits,
        fullName,
        matchKey: buildClientMatchKey({ reason: 'phone_exact', phoneDigits, fullName, code: winner.code, id: winner.id }),
        candidate: winner,
      };
    }
  }

  return null;
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
    try {
      const orders = await listOrderRecords('orders', {
        select: 'code, status, updated_at, created_at',
        in: { code: codes },
        limit: 5000,
      });
      for (const o of orders) {
        if (String(o?.status || '').toLowerCase() === 'dorzim') continue;
        const c = Number(o?.code);
        if (!Number.isFinite(c)) continue;
        const cur = activeByCode.get(c) || { active: 0, last_seen: null };
        cur.active += 1;
        const ts = o?.updated_at || o?.created_at || null;
        if (!cur.last_seen || (ts && String(ts) > String(cur.last_seen))) cur.last_seen = ts;
        activeByCode.set(c, cur);
      }
    } catch {}
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
      id: c?.id || null,
      code: codeStr,
      name: full || 'Pa Emër',
      phone: phoneShort,
      photo_url: c?.photo_url || '',
      full_name: c?.full_name || full || '',
      first_name: c?.first_name || '',
      last_name: c?.last_name || '',
      active: info.active,
      last_seen: info.last_seen,
    };
  });
}
 
async function uploadPhoto(file, oid, key) {
  if (!file || !oid) return null;
  const ext = file.name.split('.').pop() || 'jpg';
  const path = `photos/${oid}/${key}_${Date.now()}.${ext}`;

  const { data, error } = await storageWithTimeout(supabase.storage.from(BUCKET).upload(path, file, { upsert: true, cacheControl: '0' }), 9000, 'PRANIMI_PHOTO_UPLOAD_TIMEOUT', { bucket: BUCKET, path });
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

async function settleWithin(promise, ms, fallbackValue) {
  let timer = null;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(fallbackValue), Math.max(1, Number(ms) || 1));
      }),
    ]);
  } finally {
    try { if (timer) clearTimeout(timer); } catch {}
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

function clearAllLocalDraftMirrors() {
  try {
    const ids = loadDraftIds();
    for (const id of ids) {
      try { localStorage.removeItem(`${DRAFT_ITEM_PREFIX}${id}`); } catch {}
    }
    try { localStorage.removeItem(DRAFT_LIST_KEY); } catch {}
  } catch {}
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


function readCurrentSessionLocal() {
  try {
    const raw = localStorage.getItem(CURRENT_SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const ts = Number(parsed?.ts || 0);
    if (ts > 0 && (Date.now() - ts) > CURRENT_SESSION_MAX_AGE_MS) {
      try { localStorage.removeItem(CURRENT_SESSION_KEY); } catch {}
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeCurrentSessionLocal(snapshot) {
  try {
    if (!snapshot || typeof snapshot !== 'object') return;
    if (!String(snapshot?.id || '').trim()) return;
    localStorage.setItem(CURRENT_SESSION_KEY, JSON.stringify({ ...snapshot, ts: Date.now() }));
  } catch {}
}

function clearCurrentSessionLocal() {
  try { localStorage.removeItem(CURRENT_SESSION_KEY); } catch {}
}

function isStandaloneLike() {
  try {
    if (typeof window === 'undefined') return false;
    if (window.navigator?.standalone === true) return true;
    try {
      if (window.matchMedia('(display-mode: standalone)').matches) return true;
      if (window.matchMedia('(display-mode: fullscreen)').matches) return true;
      if (window.matchMedia('(display-mode: minimal-ui)').matches) return true;
    } catch {}
    return false;
  } catch {
    return false;
  }
}

function snapshotHasMeaningfulWork(d) {
  try {
    if (!d || typeof d !== 'object') return false;
    if (String(d?.clientPhotoUrl || '').trim()) return true;
    if (String(d?.notes || '').trim()) return true;
    if (Number(d?.clientPaid || 0) > 0) return true;
    if (Number(d?.arkaRecordedPaid || 0) > 0) return true;
    if (Number(d?.stairsQty || 0) > 0) return true;
    if (String(d?.stairsPhotoUrl || '').trim()) return true;
    if (Array.isArray(d?.tepihaRows) && d.tepihaRows.some((r) => Number(r?.qty || 0) > 0 || Number(r?.m2 || 0) > 0 || String(r?.photoUrl || '').trim())) return true;
    if (Array.isArray(d?.stazaRows) && d.stazaRows.some((r) => Number(r?.qty || 0) > 0 || Number(r?.m2 || 0) > 0 || String(r?.photoUrl || '').trim())) return true;
    return false;
  } catch {
    return false;
  }
}

function sessionSnapshotHasContent(d) {
  return snapshotHasMeaningfulWork(d);
}

async function upsertDraftRemote(draft) {
  try {
    if (!draft?.id) return;
    const blob = new Blob([JSON.stringify(draft)], { type: 'application/json' });
    await storageWithTimeout(supabase.storage.from(BUCKET).upload(`${DRAFTS_FOLDER}/${draft.id}.json`, blob, {
      upsert: true,
      cacheControl: '0',
      contentType: 'application/json',
    }), 6500, 'PRANIMI_DRAFT_UPLOAD_TIMEOUT', { bucket: BUCKET, path: `${DRAFTS_FOLDER}/${draft.id}.json` });
  } catch {}
}

async function deleteDraftRemote(id) {
  try {
    if (!id) return;
    await storageWithTimeout(supabase.storage.from(BUCKET).remove([`${DRAFTS_FOLDER}/${id}.json`]), 5000, 'PRANIMI_DRAFT_REMOVE_TIMEOUT', { bucket: BUCKET, path: `${DRAFTS_FOLDER}/${id}.json` });
  } catch {}
}

async function listDraftsRemote(limit = 200) {
  try {
    const safeLimit = Math.min(Number(limit) || 80, 80);
    const { data, error } = await storageWithTimeout(supabase.storage.from(BUCKET).list(DRAFTS_FOLDER, { limit: safeLimit }), 6500, 'PRANIMI_DRAFT_LIST_TIMEOUT', { bucket: BUCKET, folder: DRAFTS_FOLDER });
    if (error) throw error;
    return (data || []).filter((x) => x?.name?.endsWith('.json'));
  } catch {
    return [];
  }
}

async function readDraftRemote(id) {
  try {
    const { data, error } = await storageWithTimeout(supabase.storage.from(BUCKET).download(`${DRAFTS_FOLDER}/${id}.json`), 6500, 'PRANIMI_DRAFT_DOWNLOAD_TIMEOUT', { bucket: BUCKET, path: `${DRAFTS_FOLDER}/${id}.json` });
    if (error) throw error;
    const text = await data.text();
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function mapDraftsWithLimit(items = [], limit = 4, worker) {
  const arr = Array.isArray(items) ? items : [];
  const width = Math.max(1, Math.min(Number(limit) || 4, 6));
  let index = 0;
  const runners = Array.from({ length: Math.min(width, arr.length) }, async () => {
    while (index < arr.length) {
      const item = arr[index++];
      try { await worker(item); } catch {}
    }
  });
  await Promise.allSettled(runners);
}

async function fetchRemoteDraftsSummary() {
  const files = await listDraftsRemote(80);
  const out = [];

  await mapDraftsWithLimit(files, 4, async (f) => {
    const id = f.name.replace('.json', '');
    const d = await readDraftRemote(id);
    if (!d?.id) return;

    let totalM2 = 0;
    (d.tepihaRows || []).forEach(r => totalM2 += (Number(r.m2) || 0) * (Number(r.qty) || 0));
    (d.stazaRows || []).forEach(r => totalM2 += (Number(r.m2) || 0) * (Number(r.qty) || 0));
    totalM2 += (Number(d.stairsQty) || 0) * (Number(d.stairsPer) || 0);
    
    const euro = Number((totalM2 * (Number(d.pricePerM2) || PRICE_DEFAULT)).toFixed(2));

    if (!snapshotHasMeaningfulWork(d)) return;

    out.push({
      id: d.id,
      ts: d.ts || 0,
      code: formatKod(normalizeCode(d.codeRaw || d.code || ''), true),
      name: String(d.name || d?.client?.full_name || '').trim(),
      phone: String(d.phone || d?.client?.phone || '').replace(/^\+383\s*/, '').replace(/\D+/g, ''),
      m2: totalM2,
      euro,
    });
  });
  out.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  return out;
}

async function readSharedPrice() {
  try {
    const { data, error } = await storageWithTimeout(supabase.storage.from(BUCKET).download(`${SETTINGS_FOLDER}/price.json`), 4500, 'PRANIMI_PRICE_DOWNLOAD_TIMEOUT', { bucket: BUCKET, path: `${SETTINGS_FOLDER}/price.json` });
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
  await storageWithTimeout(supabase.storage.from(BUCKET).upload(`${SETTINGS_FOLDER}/price.json`, blob, {
    upsert: true,
    cacheControl: '0',
    contentType: 'application/json',
  }), 5000, 'PRANIMI_PRICE_UPLOAD_TIMEOUT', { bucket: BUCKET, path: `${SETTINGS_FOLDER}/price.json` });
}

function normalizeNewBasePricePerM2(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return PRICE_DEFAULT;
  for (const legacy of LEGACY_BASE_PRICE_DEFAULTS) {
    if (Math.abs(n - legacy) < 0.001) return PRICE_DEFAULT;
  }
  return n;
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
  useRouteAlive('pranimi_page');
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
  const [noPhone, setNoPhone] = useState(false);
  const [oldClientDebt, setOldClientDebt] = useState(0);
  const [clientPhotoUrl, setClientPhotoUrl] = useState('');
  const [selectedClient, setSelectedClient] = useState(null);
  const [clientMatchPrompt, setClientMatchPrompt] = useState({ open: false, reason: '', matchKey: '', candidate: null, phoneDigits: '', fullName: '' });
  const [clientMatchDecision, setClientMatchDecision] = useState({ matchKey: '', mode: '' });
  const [isBridgeEditMode, setIsBridgeEditMode] = useState(false);

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
  const [smsModal, setSmsModal] = useState({ open: false, phone: '', text: '' });
  const [resetAfterSmsClose, setResetAfterSmsClose] = useState(false);

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
  const editBridgeRef = useRef(null);
  const startupCodeReserveTimerRef = useRef(null);
  const connectivityDebounceRef = useRef(null);
  const clientsIndexRequestedRef = useRef(false);
  const remoteDraftTimerRef = useRef(null);
  const pranimiBgSyncTimerRef = useRef(null);
  const pranimiBgSyncStateRef = useRef({ running: false, lastAt: 0, lastReason: '' });
  const codeRawRef = useRef('');
  const newOrderUrlClientRef = useRef({ code: '', name: '', phone: '' });
  const oidRef = useRef('');
  const uiReadyMarkedRef = useRef(false);
  const priceSourceRef = useRef('new');

  useEffect(() => {
    codeRawRef.current = String(codeRaw || '');
  }, [codeRaw]);

  function getPhoneDigitsRaw(value = phone) {
    try { return String(value || '').replace(/\D+/g, ''); } catch { return ''; }
  }

  function getCanonicalClientPhone(value = phone, forceNoPhone = noPhone) {
    const digits = getPhoneDigitsRaw(value);
    if (forceNoPhone || !digits) return '';
    return `${phonePrefix}${digits}`;
  }

  useEffect(() => {
    oidRef.current = String(oid || '');
  }, [oid]);

  async function runBackgroundMetaSync(reason = 'manual') {
    try {
      const activePin = String(actor?.pin || actor?.pinCode || actor?.id || '').trim();
      if (!activePin) return;
      const isOnline = (() => {
        try { return typeof navigator === 'undefined' ? true : navigator.onLine !== false; } catch { return true; }
      })();
      if (!isOnline) return;

      const now = Date.now();
      const state = pranimiBgSyncStateRef.current || { running: false, lastAt: 0, lastReason: '' };
      if (state.running) return;
      if (now - Number(state.lastAt || 0) < PRANIMI_BG_SYNC_MIN_GAP_MS) return;

      pranimiBgSyncStateRef.current = { ...state, running: true, lastAt: now, lastReason: String(reason || 'manual') };
      try { logDebugEvent('pranimi_bg_sync_start', { reason: String(reason || 'manual'), hasActorPin: !!activePin }); } catch {}

      let epochChanged = false;
      let poolStatus = null;

      try {
        epochChanged = await settleWithin(
          ensureFreshPranimiEpoch(activePin),
          PRANIMI_BG_META_TIMEOUT_MS,
          false
        );
      } catch {}

      try {
        poolStatus = await settleWithin(
          ensureBasePool(activePin),
          PRANIMI_BG_POOL_TIMEOUT_MS,
          { ok: false, reason: 'TIMEOUT' }
        );
      } catch {}

      try {
        logDebugEvent('pranimi_bg_sync_end', {
          reason: String(reason || 'manual'),
          epochChanged: !!epochChanged,
          poolOk: !!poolStatus?.ok,
          poolReason: poolStatus?.reason || '',
          poolHave: Number(poolStatus?.have || 0) || 0,
          poolReserved: Number(poolStatus?.reserved || 0) || 0,
          poolSkipped: !!poolStatus?.skipped,
        });
      } catch {}
    } catch {}
    finally {
      const prev = pranimiBgSyncStateRef.current || {};
      pranimiBgSyncStateRef.current = { ...prev, running: false };
    }
  }

  function queueBackgroundMetaSync(reason = 'manual', delayMs = 250) {
    try {
      if (pranimiBgSyncTimerRef.current) clearTimeout(pranimiBgSyncTimerRef.current);
    } catch {}
    pranimiBgSyncTimerRef.current = setTimeout(() => {
      void runBackgroundMetaSync(reason);
    }, Math.max(0, Number(delayMs) || 0));
  }

  useEffect(() => {
    try { trackRender('PranimiBasePage'); } catch {}
    try { logDebugEvent('pranimi_mount', { path: typeof window !== 'undefined' ? window.location?.pathname || '' : '' }); } catch {}
    return () => {
      try { logDebugEvent('pranimi_unmount', { path: typeof window !== 'undefined' ? window.location?.pathname || '' : '' }); } catch {}
    };
  }, []);

  useEffect(() => {
    if (creating) return;
    const code = String(codeRaw || '').trim();
    try {
      bootLog('ui_ready', {
        page: 'pranimi',
        path: typeof window !== 'undefined' ? (window.location.pathname || '/pranimi') : '/pranimi',
        oid: String(oid || ''),
        code,
        source: uiReadyMarkedRef.current ? 'state_repeat' : 'state_first',
      });
    } catch {}
    if (uiReadyMarkedRef.current) return;
    uiReadyMarkedRef.current = true;
    try {
      bootMarkReady({
        source: 'pranimi_page',
        page: 'pranimi',
        path: typeof window !== 'undefined' ? (window.location.pathname || '/pranimi') : '/pranimi',
        oid: String(oid || ''),
        code,
      });
    } catch {}
  }, [creating, oid, codeRaw]);

  async function ensureClientsIndexLoaded() {
    if (clientsIndexRequestedRef.current) return;
    clientsIndexRequestedRef.current = true;
    try { await loadClientsIndexOnce(); } catch {}
  }

  async function tryReserveCodeInBackground(nextOid) {
    const id = String(nextOid || '').trim();
    if (!id) return;
    try { if (startupCodeReserveTimerRef.current) clearTimeout(startupCodeReserveTimerRef.current); } catch {}
    startupCodeReserveTimerRef.current = setTimeout(() => {
      void (async () => {
        try {
          if (String(oidRef.current || '') !== id) return;
          const currentCode = String(normalizeCode(codeRawRef.current) || '').trim();
          if (currentCode) return;
          const c = await reserveSharedCode(id);
          if (String(oidRef.current || '') !== id) return;
          setCodeRaw(String(c));
          try { setNetState({ ok: true, reason: null }); } catch {}
          try { localStorage.removeItem(OFFLINE_MODE_KEY); } catch {}
          try { setOfflineMode(false); } catch {}
          try { setShowOfflinePrompt(false); } catch {}
        } catch (e) {
          try {
            const online = typeof navigator === 'undefined' ? true : navigator.onLine;
            if (!online) {
              setNetState({ ok: false, reason: 'NO_INTERNET' });
              setShowOfflinePrompt(true);
            }
          } catch {}
        }
      })();
    }, 150);
  }

  function clearActiveEditBridge() {
    try {
      if (typeof window === 'undefined') return;
      try { window.localStorage.removeItem(PASRTRIMI_EDIT_TO_PRANIMI_KEY); } catch {}
      try { window.localStorage.removeItem(GATI_EDIT_TO_PRANIMI_KEY); } catch {}
      try { window.sessionStorage.removeItem(PASRTRIMI_EDIT_TO_PRANIMI_BACKUP_KEY); } catch {}
      try { window.sessionStorage.removeItem(GATI_EDIT_TO_PRANIMI_BACKUP_KEY); } catch {}
      try { window.sessionStorage.removeItem(PRANIMI_ACTIVE_EDIT_BRIDGE_KEY); } catch {}
      try { delete window.__TEPIHA_ACTIVE_EDIT_BRIDGE__; } catch {}
    } catch {}
  }

  function consumePastrimiEditPayload() {
    try {
      if (typeof window === 'undefined') return null;
      const search = String(window.location?.search || '');
      const wantsEditBridge = search.includes('from=pastrimi-edit') || search.includes('from=gati-edit');
      const memoryBridge = wantsEditBridge ? window.__TEPIHA_ACTIVE_EDIT_BRIDGE__ : null;
      if (memoryBridge && typeof memoryBridge === 'object') return memoryBridge;
      const activeRaw = wantsEditBridge ? window.sessionStorage.getItem(PRANIMI_ACTIVE_EDIT_BRIDGE_KEY) : null;
      if (activeRaw) {
        const activeParsed = safeJsonParse(activeRaw, null);
        if (activeParsed) {
          try { window.__TEPIHA_ACTIVE_EDIT_BRIDGE__ = activeParsed; } catch {}
          return activeParsed;
        }
      }

      if (!wantsEditBridge) return null;

      const keys = [
        [PASRTRIMI_EDIT_TO_PRANIMI_KEY, PASRTRIMI_EDIT_TO_PRANIMI_BACKUP_KEY],
        [GATI_EDIT_TO_PRANIMI_KEY, GATI_EDIT_TO_PRANIMI_BACKUP_KEY],
      ];
      for (const [primaryKey, backupKey] of keys) {
        const rawPrimary = window.localStorage.getItem(primaryKey);
        const rawBackup = window.sessionStorage.getItem(backupKey);
        const raw = rawPrimary || rawBackup;
        if (!raw) continue;
        const parsed = safeJsonParse(raw, null);
        if (!parsed) continue;
        try { window.sessionStorage.setItem(PRANIMI_ACTIVE_EDIT_BRIDGE_KEY, raw); } catch {}
        try { window.__TEPIHA_ACTIVE_EDIT_BRIDGE__ = parsed; } catch {}
        // Keep the primary/backup bridge until the edit is saved or an explicit reset clears it.
        // iOS PWA can remount /pranimi after the first read; deleting here can open a blank form.
        return parsed;
      }
      return null;
    } catch {
      return null;
    }
  }

  function hydrateFromPastrimiEdit(payload) {
    try {
      if (typeof window !== 'undefined' && payload) {
        const raw = JSON.stringify(payload);
        try { window.sessionStorage.setItem(PRANIMI_ACTIVE_EDIT_BRIDGE_KEY, raw); } catch {}
        try { window.__TEPIHA_ACTIVE_EDIT_BRIDGE__ = payload; } catch {}
      }
    } catch {}
    setIsBridgeEditMode(true);
    const ord = payload?.order || {};
    const ordData = (ord && typeof ord.data === 'object' && ord.data) ? ord.data : {};
    const client = ord?.client || ordData?.client || {};
    const codeVal = payload?.code || ord?.code || ord?.code_n || client?.code || '';
    const rawPhone = String(client?.phone || ord?.client_phone || ordData?.client_phone || '');
    const cleanPhone = rawPhone.startsWith(phonePrefix) ? rawPhone.slice(phonePrefix.length) : rawPhone.replace(/\D+/g, '');

    const tepiha = Array.isArray(ord?.tepiha) ? ord.tepiha : (Array.isArray(ordData?.tepiha) ? ordData.tepiha : []);
    const staza = Array.isArray(ord?.staza) ? ord.staza : (Array.isArray(ordData?.staza) ? ordData.staza : []);
    const shkallore = ord?.shkallore || ordData?.shkallore || {};

    setCreating(true);
    editBridgeRef.current = {
      ...(payload || {}),
      local_oid: String(
        payload?.local_oid ||
        ord?.local_oid ||
        ordData?.local_oid ||
        ord?.oid ||
        ''
      ).trim(),
    };
    const nextOid = String(payload?.id || payload?.db_id || ord?.db_id || ord?.id || ord?.oid || '');
    oidRef.current = nextOid;
    setOid(nextOid);
    codeRawRef.current = String(codeVal || '');
    setCodeRaw(String(codeVal || ''));
    setName(String(client?.name || ord?.client_name || ordData?.client_name || ''));
    setPhone(cleanPhone);
    setNoPhone(!cleanPhone);
    setClientPhotoUrl(String(client?.photoUrl || client?.photo || ord?.client_photo_url || ordData?.client_photo_url || ''));
    newOrderUrlClientRef.current = { code: '', name: '', phone: '' };
    setSelectedClient(null);
    setClientQuery('');
    setClientHits([]);

    setTepihaRows(Array.isArray(tepiha) ? tepiha.map((r, i) => ({ id: `t${i+1}`, m2: String(r?.m2 ?? r?.m ?? r?.area ?? ''), qty: String(r?.qty ?? r?.pieces ?? ''), photoUrl: r?.photoUrl || '' })) : []);
    setStazaRows(Array.isArray(staza) ? staza.map((r, i) => ({ id: `s${i+1}`, m2: String(r?.m2 ?? r?.m ?? r?.area ?? ''), qty: String(r?.qty ?? r?.pieces ?? ''), photoUrl: r?.photoUrl || '' })) : []);

    setStairsQty(Number(shkallore?.qty ?? ord?.stairsQty ?? ordData?.stairsQty ?? 0) || 0);
    setStairsPer(Number(shkallore?.per ?? ord?.stairsPer ?? ordData?.stairsPer ?? SHKALLORE_M2_PER_STEP_DEFAULT) || SHKALLORE_M2_PER_STEP_DEFAULT);
    setStairsPhotoUrl(String(shkallore?.photoUrl || ord?.stairsPhotoUrl || ordData?.stairsPhotoUrl || ''));
    setShowStairsArea(Number(shkallore?.qty ?? ord?.stairsQty ?? ordData?.stairsQty ?? 0) > 0);

    const pay = ord?.pay || ordData?.pay || {};
    const rate = Number(pay?.rate ?? pay?.price ?? ord?.pricePerM2 ?? ordData?.pricePerM2 ?? PRICE_DEFAULT) || PRICE_DEFAULT;
    const paid = Number(pay?.paid ?? ord?.clientPaid ?? ordData?.clientPaid ?? 0) || 0;
    const arkaPaid = Number(pay?.arkaRecordedPaid ?? ord?.arkaRecordedPaid ?? ordData?.arkaRecordedPaid ?? 0) || 0;
    priceSourceRef.current = 'existing';
    setPricePerM2(rate);
    setPriceTmp(rate);
    setClientPaid(paid);
    setArkaRecordedPaid(arkaPaid);
    setPayMethod(String(pay?.method || ord?.payMethod || ordData?.payMethod || 'CASH'));
    setNotes(String(ord?.notes || ordData?.notes || ''));
    setSavingContinue(false);
    setPhotoUploading(false);
    setShowWizard(false);
    setShowDraftsSheet(false);
    setCreating(false);
  }

  async function resetForNewOrder() {
    try {
      setCreating(true);
      setIsBridgeEditMode(false);
      editBridgeRef.current = null;
      clearActiveEditBridge();
      try { clearCurrentSessionLocal(); } catch {}
      const id = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `ord_${Date.now()}`;
      oidRef.current = String(id);
      setOid(id);
      unsuppressDraftId(id);

      let urlCode = '';
      let urlName = '';
      let urlPhone = '';
      if (typeof window !== 'undefined') {
        const params = new URLSearchParams(window.location.search);
        urlCode = params.get('code') || '';
        urlName = params.get('name') || '';
        urlPhone = params.get('phone') || '';
      }

      try {
        if (typeof window !== 'undefined' && (urlCode || urlName || urlPhone)) {
          const next = new URL(window.location.href);
          next.searchParams.delete('code');
          next.searchParams.delete('name');
          next.searchParams.delete('phone');
          window.history.replaceState({}, '', `${next.pathname}${next.search}`);
        }
      } catch {}

      const permanentCode = String(normalizeCode(urlCode || '') || '').trim();
      newOrderUrlClientRef.current = {
        code: permanentCode || '',
        name: urlName ? String(urlName) : '',
        phone: urlPhone ? String(urlPhone) : '',
      };

      if (permanentCode) {
        codeRawRef.current = String(permanentCode || '');
        setCodeRaw(permanentCode);
        try {
          const online = typeof navigator === 'undefined' ? true : navigator.onLine;
          setNetState({ ok: !!online, reason: online ? '' : 'NO_INTERNET' });
        } catch {}
        try { setShowOfflinePrompt(false); } catch {}
      } else {
        codeRawRef.current = '';
        setCodeRaw('');
        try {
          const online = typeof navigator === 'undefined' ? true : navigator.onLine;
          setNetState({ ok: !!online, reason: online ? '' : 'NO_INTERNET' });
          if (!online) {
            try { localStorage.setItem(OFFLINE_MODE_KEY, '1'); } catch {}
            try { setOfflineMode(true); } catch {}
            try { setShowOfflinePrompt(true); } catch {}
            void (async () => {
              try {
                const c = await reserveSharedCode(id);
                codeRawRef.current = String(c || '');
                setCodeRaw(String(c));
              } catch {}
            })();
          } else {
            try { localStorage.removeItem(OFFLINE_MODE_KEY); } catch {}
            try { setOfflineMode(false); } catch {}
            try { setShowOfflinePrompt(false); } catch {}
            void tryReserveCodeInBackground(id);
          }
        } catch {
          setNetState({ ok: false, reason: 'CODE_RESERVE_DEFERRED' });
        }
      }

      const nextNamePrefill = urlName ? String(urlName) : '';
      let nextPhonePrefill = '';
      if (urlPhone) {
        let p = String(urlPhone).trim();
        if (p.startsWith('+383')) p = p.slice(4);
        nextPhonePrefill = p.replace(/\D+/g, '');
      }

      setName(nextNamePrefill);
      if (nextPhonePrefill) {
        setPhone(nextPhonePrefill);
        setNoPhone(false);
      } else {
        setPhone('');
        setNoPhone(false);
      }
      setClientPhotoUrl('');
      setSelectedClient(permanentCode || nextNamePrefill || nextPhonePrefill ? {
        id: null,
        code: permanentCode || '',
        name: nextNamePrefill || '',
        phone: nextPhonePrefill ? `${phonePrefix}${nextPhonePrefill}` : '',
      } : null);
      setClientMatchPrompt({ open: false, reason: '', matchKey: '', candidate: null, phoneDigits: '', fullName: '' });
      setClientQuery('');
      setClientHits([]);

      setTepihaRows([]);
      setStazaRows([]);
      setStairsQty(0);
      setStairsPer(SHKALLORE_M2_PER_STEP_DEFAULT);
      setStairsPhotoUrl('');

      priceSourceRef.current = 'new';
      setPricePerM2(PRICE_DEFAULT);
      setPriceTmp(PRICE_DEFAULT);

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
    let forceResetOnShow = false;
    let editBridgeUrl = false;
    try {
      const search = String(window?.location?.search || '');
      editBridgeUrl = search.includes('from=pastrimi-edit') || search.includes('from=gati-edit');
      forceResetOnShow = !editBridgeUrl && sessionStorage.getItem(RESET_ON_SHOW_KEY) === '1';
      if (forceResetOnShow || editBridgeUrl) sessionStorage.removeItem(RESET_ON_SHOW_KEY);
    } catch {}

    (async () => {
      let localBootMode = 'idle';
      let localBootMeta = {};
      try {
        const activePin = String(actor?.pin || actor?.pinCode || actor?.id || '').trim();
        try {
          bootLog('before_local_read', {
            page: 'pranimi',
            path: typeof window !== 'undefined' ? (window.location.pathname || '/pranimi') : '/pranimi',
            source: 'init_local_boot',
            hasActorPin: !!activePin,
          });
        } catch {}
        const isOnline = (() => {
          try { return typeof navigator === 'undefined' ? true : navigator.onLine !== false; } catch { return true; }
        })();
        try { logDebugEvent('pranimi_init_local_boot', { hasActorPin: !!activePin, isOnline }); } catch {}

        try {
          if (isOnline) {
            try { localStorage.removeItem(OFFLINE_MODE_KEY); } catch {}
            try { setOfflineMode(false); } catch {}
            try { setShowOfflinePrompt(false); } catch {}
            try { setNetState({ ok: true, reason: '' }); } catch {}
          } else {
            try { localStorage.setItem(OFFLINE_MODE_KEY, '1'); } catch {}
            try { setOfflineMode(true); } catch {}
            try { setShowOfflinePrompt(false); } catch {}
            try { setNetState({ ok: false, reason: 'NO_INTERNET' }); } catch {}
          }
        } catch {}

        try {
          if (!oid || forceResetOnShow) {
            const pastrimEdit = forceResetOnShow ? null : consumePastrimiEditPayload();
            if (pastrimEdit) {
              try { logDebugEvent('pranimi_hydrate_bridge_found', { hasPayload: true }); } catch {}
              hydrateFromPastrimiEdit(pastrimEdit);
              localBootMode = 'bridge_edit';
              localBootMeta = { hasPayload: true };
            } else {
              const currentSession = forceResetOnShow ? null : readCurrentSessionLocal();
              if (currentSession?.id && sessionSnapshotHasContent(currentSession)) {
                try { logDebugEvent('pranimi_resume_current_session', { id: String(currentSession?.id || ''), hasCode: !!String(currentSession?.codeRaw || currentSession?.code || '').trim() }); } catch {}
                applyDraftSnapshotToForm(currentSession, currentSession?.id || '');
                setCreating(false);
                localBootMode = 'resume_current_session';
                localBootMeta = { id: String(currentSession?.id || ''), hasCode: !!String(currentSession?.codeRaw || currentSession?.code || '').trim() };
              } else {
                try { logDebugEvent('pranimi_reset_for_new_order_start', {}); } catch {}
                await resetForNewOrder();
                localBootMode = 'reset_new_order';
                localBootMeta = { forced: !!forceResetOnShow };
                try { logDebugEvent('pranimi_reset_for_new_order_end', {}); } catch {}
              }
            }
          }
        } catch {}
      } finally {
        try {
          bootLog('after_local_read', {
            page: 'pranimi',
            path: typeof window !== 'undefined' ? (window.location.pathname || '/pranimi') : '/pranimi',
            source: 'init_local_boot',
            mode: String(localBootMode || 'idle'),
            ...(localBootMeta || {}),
          });
        } catch {}
        try { logDebugEvent('pranimi_epoch_ready_set', { alive: !!alive }); } catch {}
        if (alive) {
          setEpochReady(true);
          queueBackgroundMetaSync('init_post_local_boot', 300);
        }
      }
    })();

    const onOnline = () => {
      try { logDebugEvent('pranimi_online_passive', {}); } catch {}
      try { localStorage.removeItem(OFFLINE_MODE_KEY); } catch {}
      try { setOfflineMode(false); } catch {}
      try { setNetState({ ok: true, reason: '' }); } catch {}
      try { setShowOfflinePrompt(false); } catch {}
      queueBackgroundMetaSync('online', 150);
    };

    const onOffline = () => {
      try { logDebugEvent('pranimi_offline_passive', {}); } catch {}
      try { localStorage.setItem(OFFLINE_MODE_KEY, '1'); } catch {}
      try { setOfflineMode(true); } catch {}
      try { setNetState({ ok: false, reason: 'NO_INTERNET' }); } catch {}
      try { setShowOfflinePrompt(false); } catch {}
    };

    const onPageShow = () => {
      queueBackgroundMetaSync('pageshow_resume', 150);
    };

    const onVisible = () => {
      try {
        if (document.visibilityState === 'visible') {
          queueBackgroundMetaSync('visibility_resume', 200);
        }
      } catch {}
    };

    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    window.addEventListener('pageshow', onPageShow);
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      alive = false;
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('pageshow', onPageShow);
      document.removeEventListener('visibilitychange', onVisible);
      try { if (connectivityDebounceRef.current) clearTimeout(connectivityDebounceRef.current); } catch {}
      try { if (startupCodeReserveTimerRef.current) clearTimeout(startupCodeReserveTimerRef.current); } catch {}
      try { if (pranimiBgSyncTimerRef.current) clearTimeout(pranimiBgSyncTimerRef.current); } catch {}
    };
  }, []);

  const [etaText, setEtaText] = useState('GATI DITËN E 2-TË (NESËR)');
  const [todayPastrimM2, setTodayPastrimM2] = useState(0);

  const draftTimer = useRef(null);
  const payHoldTimerRef = useRef(null);
  const payHoldTriggeredRef = useRef(false);
  const draftRemoteCacheRef = useRef({ ts: 0, items: [] });
  const draftRemoteInflightRef = useRef(false);
  const suppressedDraftIdsRef = useRef(new Set());

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
  function saveClientFromWizard() {
    try { setShowWizard(false); } catch {}
  }
  function wizNext() { setWizStep((s) => Math.min(5, s + 1)); }
  function wizBack() { setWizStep((s) => Math.max(1, s - 1)); }

  async function refreshDrafts(opts = {}) {
    const includeRemote = opts?.includeRemote !== false;
    const forceRemote = !!opts?.forceRemote;

    if (!includeRemote) {
      pushDraftsToState([]);
      return [];
    }

    const now = Date.now();
    const cacheFresh = !forceRemote && (now - Number(draftRemoteCacheRef.current?.ts || 0) < 30000);
    if (cacheFresh) {
      const cached = (Array.isArray(draftRemoteCacheRef.current?.items) ? draftRemoteCacheRef.current.items : [])
        .filter((d) => d?.id && !isDraftSuppressed(d.id));
      pushDraftsToState(cached);
      return cached;
    }

    if (draftRemoteInflightRef.current) {
      const cached = (Array.isArray(draftRemoteCacheRef.current?.items) ? draftRemoteCacheRef.current.items : [])
        .filter((d) => d?.id && !isDraftSuppressed(d.id));
      pushDraftsToState(cached);
      return cached;
    }

    draftRemoteInflightRef.current = true;

    try {
      const remote = (await fetchRemoteDraftsSummary())
        .filter((d) => d?.id && !isDraftSuppressed(d.id));

      draftRemoteCacheRef.current = {
        ts: Date.now(),
        items: remote,
      };

      pushDraftsToState(remote);
      try { clearAllLocalDraftMirrors(); } catch {}
      return remote;
    } catch {
      const local = readLocalDraftSummaries();
      pushDraftsToState(local);
      return local;
    } finally {
      draftRemoteInflightRef.current = false;
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

      const clients = await fetchClientsFromDb(100);
      const orders = await fetchOrdersFromDb(100);

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
          if (cached && Array.isArray(cached.items) && cached.items.length) {
            setClientsIndex(cached.items);
            return;
          }
        }
      } catch {}

      try {
        const cacheKey = 'tepiha_clients_index_v1';
        const localOrders = await getAllOrdersLocal();
        const byCode = new Map();
        for (const row of (Array.isArray(localOrders) ? localOrders : [])) {
          let data = row?.data;
          if (typeof data === 'string') {
            try { data = JSON.parse(data); } catch { data = {}; }
          }
          if (!data || typeof data !== 'object') data = {};
          const codeStr = String(row?.client_code || row?.code || data?.client?.code || data?.client_code || '').trim();
          if (!codeStr) continue;
          const name = String(row?.client_name || data?.client?.name || data?.client_name || '').trim();
          const phone = String(row?.client_phone || data?.client?.phone || data?.client_phone || '').trim();
          const status = String(row?.status || data?.status || '').toLowerCase();
          const ts = row?.updated_at || row?.created_at || data?.updated_at || data?.created_at || null;
          const prev = byCode.get(codeStr) || { code: codeStr, name: '', phone: '', active: 0, last_seen: null };
          if (!prev.name && name) prev.name = name;
          if (!prev.phone && phone) prev.phone = phone;
          if (status && status !== 'dorzim') prev.active = 1;
          if (!prev.last_seen || (ts && String(ts) > String(prev.last_seen))) prev.last_seen = ts;
          byCode.set(codeStr, prev);
        }
        const items = Array.from(byCode.values()).slice(0, 2000);
        if (items.length) {
          setClientsIndex(items);
          try { localStorage.setItem(cacheKey, JSON.stringify({ ts: Date.now(), items })); } catch {}
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
    const t = setTimeout(() => {
      void (async () => {
        try {
          await ensureClientsIndexLoaded();
          const hits = await searchClientsLive(q);
          if (!alive) return;
          setClientHits(Array.isArray(hits) ? hits.slice(0, 15) : []);
        } catch (e) {
          try {
            const qLow = q.toLowerCase();
            const matches = (clientsIndex || [])
              .filter((c) => {
                return (
                  String(c.code).toLowerCase().includes(qLow) ||
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
    }, 400);

    return () => { alive = false; try { clearTimeout(t); } catch {} };
  }, [clientQuery, clientsIndex]);


  function sameSelectedClientCode(candidate) {
    const selectedCode = normalizeCode(selectedClient?.code || null);
    const candidateCode = normalizeCode(candidate?.code || null);
    return selectedCode != null && candidateCode != null && String(selectedCode) === String(candidateCode);
  }

  function applyClientMatchChoice(mode, payload = clientMatchPrompt) {
    const matchKey = String(payload?.matchKey || '').trim();
    const cand = payload?.candidate || null;
    setClientMatchDecision({ matchKey, mode: String(mode || '') });
    setClientMatchPrompt({ open: false, reason: '', matchKey: '', candidate: null, phoneDigits: '', fullName: '' });

    if (!cand || mode === 'create_new_anyway') return;

    const codeVal = String(cand?.code || '').trim();
    const candPhone = normalizeMatchPhone(cand?.phone || '');
    const candName = String(cand?.name || '').trim();

    setSelectedClient({
      id: cand?.id || null,
      code: codeVal || '',
      name: candName || '',
      phone: cand?.phone || '',
    });
    if (codeVal) setCodeRaw(codeVal);
    if (candName) setName(candName);
    if (candPhone) { setPhone(candPhone); setNoPhone(false); } else { setPhone(''); setNoPhone(true); }
    if (cand?.photo_url) setClientPhotoUrl(String(cand.photo_url || ''));
  }

  useEffect(() => {
    const phoneDigits = normalizeMatchPhone(phone);
    const fullName = normalizeMatchName(name);
    const canCheckPhone = isValidClientPhoneDigits(phoneDigits);
    const canCheckFullName = fullName.split(' ').filter(Boolean).length >= 2;

    if (isBridgeEditMode || noPhone) {
      if (clientMatchPrompt?.open) setClientMatchPrompt({ open: false, reason: '', matchKey: '', candidate: null, phoneDigits: '', fullName: '' });
      return;
    }

    if (!canCheckPhone) {
      if (clientMatchPrompt?.open) setClientMatchPrompt({ open: false, reason: '', matchKey: '', candidate: null, phoneDigits: '', fullName: '' });
      return;
    }

    let alive = true;
    const t = setTimeout(() => {
      void (async () => {
        try {
          await ensureClientsIndexLoaded();
          const found = await detectExistingClientSmart({ name, phone, clientsIndex });
          if (!alive) return;
          if (!found) {
            if (clientMatchPrompt?.open) setClientMatchPrompt({ open: false, reason: '', matchKey: '', candidate: null, phoneDigits: '', fullName: '' });
            return;
          }
          if (sameSelectedClientCode(found.candidate)) return;
          if (String(clientMatchDecision?.matchKey || '') === String(found.matchKey || '')) return;
          if (String(clientMatchPrompt?.matchKey || '') === String(found.matchKey || '') && clientMatchPrompt?.open) return;
          setClientMatchPrompt(found);
        } catch {}
      })();
    }, 650);

    return () => { alive = false; try { clearTimeout(t); } catch {} };
  }, [name, phone, noPhone, clientsIndex, selectedClient, clientMatchDecision, clientMatchPrompt?.open, clientMatchPrompt?.matchKey, isBridgeEditMode]);

  useEffect(() => {
    if (!epochReady) return;
    (async () => {
      try { await refreshDrafts({ includeRemote: true, forceRemote: true }); } catch {}

      try {
        const a = localStorage.getItem(AUTO_MSG_KEY);
        if (a === '0') setAutoMsgAfterSave(false);
        if (a === '1') setAutoMsgAfterSave(true);
      } catch {}

      try {
        if (priceSourceRef.current === 'new') {
          const shared = await readSharedPrice();
          if (shared) {
            const nextPrice = normalizeNewBasePricePerM2(shared);
            setPricePerM2(nextPrice);
            setPriceTmp(nextPrice);
            localStorage.setItem(PRICE_KEY, String(nextPrice));
          } else {
            const p = Number(localStorage.getItem(PRICE_KEY) || '');
            const nextPrice = normalizeNewBasePricePerM2(Number.isFinite(p) && p > 0 ? p : PRICE_DEFAULT);
            setPricePerM2(nextPrice);
            setPriceTmp(nextPrice);
            localStorage.setItem(PRICE_KEY, String(nextPrice));
          }
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
    const t = setTimeout(() => { try { router?.prefetch?.('/pastrimi'); } catch {} }, 3000);
    return () => { try { clearTimeout(t); } catch {} };
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
    const phoneFull = sanitizePhone(getCanonicalClientPhone());
    if (!phoneFull || phoneFull.length < 6) { setOldClientDebt(0); return; }
    const t = setTimeout(() => {
      void (async () => {
        try {
          const res = await getClientBalanceByPhone(phoneFull);
          if (!alive) return;
          setOldClientDebt(Number(res?.debt_eur || 0) || 0);
        } catch {
          if (alive) setOldClientDebt(0);
        }
      })();
    }, 500);
    return () => { alive = false; try { clearTimeout(t); } catch {} };
  }, [phonePrefix, phone, noPhone]);
  const currentChange = diff < 0 ? Math.abs(diff) : 0;

  const copeCount = useMemo(() => {
    const t = tepihaRows.reduce((a, b) => a + (Number(b.qty) || 0), 0);
    const s = stazaRows.reduce((a, b) => a + (Number(b.qty) || 0), 0);
    const sh = Number(stairsQty) || 0;
    return t + s + sh;
  }, [tepihaRows, stazaRows, stairsQty]);

  function buildDraftSnapshot() {
    const safePhone = noPhone ? '' : String(phone || '').replace(/\D+/g, '');
    return {
      id: oid,
      ts: Date.now(),
      codeRaw,
      name,
      phone: safePhone,
      noPhone: !!noPhone,
      client: {
        full_name: String(name || '').trim(),
        phone: safePhone ? `${phonePrefix}${safePhone}` : '',
      },
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
    return snapshotHasMeaningfulWork(buildDraftSnapshot());
  }

  function suppressDraftId(id) {
    const v = String(id || '').trim();
    if (!v) return;
    try { suppressedDraftIdsRef.current.add(v); } catch {}
  }

  function unsuppressDraftId(id) {
    const v = String(id || '').trim();
    if (!v) return;
    try { suppressedDraftIdsRef.current.delete(v); } catch {}
  }

  function isDraftSuppressed(id) {
    const v = String(id || '').trim();
    if (!v) return false;
    try { return suppressedDraftIdsRef.current.has(v); } catch { return false; }
  }

  function pushDraftsToState(list) {
    const sorted = [...(Array.isArray(list) ? list : [])].sort((a, b) => Number(b?.ts || 0) - Number(a?.ts || 0));
    const byCode = new Map();
    for (const d of sorted) {
      if (!d?.id) continue;
      const key = Number(d?.code) > 0 ? `code:${Number(d.code)}` : `id:${String(d?.id || '')}`;
      if (!byCode.has(key)) byCode.set(key, d);
    }
    setDrafts(Array.from(byCode.values()));
  }

  function readLocalDraftSummaries() {
    return readAllDraftsLocal()
      .filter((d) => d?.id && !isDraftSuppressed(d.id) && snapshotHasMeaningfulWork(d))
      .map((d) => {
        let totalM2 = 0;
        (d?.tepihaRows || []).forEach((r) => { totalM2 += (Number(r?.m2) || 0) * (Number(r?.qty) || 0); });
        (d?.stazaRows || []).forEach((r) => { totalM2 += (Number(r?.m2) || 0) * (Number(r?.qty) || 0); });
        totalM2 += (Number(d?.stairsQty) || 0) * (Number(d?.stairsPer) || 0);
        return {
          id: d?.id,
          code: Number(d?.codeRaw || d?.code) || 0,
          name: (d?.name || d?.client?.full_name || '').trim(),
          phone: String(d?.phone || d?.client?.phone || '').replace(/^\+383\s*/, '').replace(/\D+/g, ''),
          ts: Number(d?.ts) || 0,
          m2: totalM2,
          euro: Number((totalM2 * (Number(d?.pricePerM2) || PRICE_DEFAULT)).toFixed(2)),
        };
      });
  }

  async function commitDraftAndAdvanceCodeBestEffort() {
    try {
      if (!oid) return;
      if (!hasStartedWork()) return;
      try { if (draftTimer.current) clearTimeout(draftTimer.current); } catch {}
      const draft = buildDraftSnapshot();
      try { await upsertDraftRemote(draft); } catch {}
      try { if (showDraftsSheet) void refreshDrafts({ includeRemote: true, forceRemote: true }); } catch {}
    } catch {}
  }

  useEffect(() => {
    if (creating) return;
    if (!oid) return;
    if (isDraftSuppressed(oid)) return;

    if (draftTimer.current) clearTimeout(draftTimer.current);
    if (remoteDraftTimerRef.current) clearTimeout(remoteDraftTimerRef.current);

    draftTimer.current = setTimeout(() => {
      try {
        if (isDraftSuppressed(oid)) return;
        const draft = buildDraftSnapshot();
        if (hasStartedWork()) {
          void upsertDraftRemote(draft).finally(() => {
            try { if (showDraftsSheet) void refreshDrafts({ includeRemote: true }); } catch {}
          });
        }
      } catch {}
    }, 1200);

    remoteDraftTimerRef.current = setTimeout(() => {
      try {
        if (isDraftSuppressed(oid)) return;
        const draft = buildDraftSnapshot();
        if (hasStartedWork()) {
          void upsertDraftRemote(draft).finally(() => {
            try { if (showDraftsSheet) void refreshDrafts({ includeRemote: true }); } catch {}
          });
        }
      } catch {}
    }, 3200);

    return () => {
      if (draftTimer.current) clearTimeout(draftTimer.current);
      if (remoteDraftTimerRef.current) clearTimeout(remoteDraftTimerRef.current);
    };
  }, [creating, oid, codeRaw, name, phone, noPhone, clientPhotoUrl, tepihaRows, stazaRows, stairsQty, stairsPer, stairsPhotoUrl, pricePerM2, clientPaid, arkaRecordedPaid, payMethod, notes, showDraftsSheet]);


  useEffect(() => {
    if (creating) return;
    if (!oid) return;
    try {
      const snapshot = buildDraftSnapshot();
      if (sessionSnapshotHasContent(snapshot)) {
        writeCurrentSessionLocal(snapshot);
      } else {
        clearCurrentSessionLocal();
      }
    } catch {}
  }, [creating, oid, codeRaw, name, phone, noPhone, clientPhotoUrl, tepihaRows, stazaRows, stairsQty, stairsPer, stairsPhotoUrl, pricePerM2, clientPaid, arkaRecordedPaid, payMethod, notes]);

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
      alert('Shkruaj një çmim të vlefshëm (p.sh. 1.30).');
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
            actor: { pin: pinData.pin, name: pinData.name, role: pinData.role },
            created_by_pin: pinData.pin,
            created_by_name: pinData.name,
          });
        }
      } catch {}
    })();
  }

  function validateBeforeContinue() {
    if (!name.trim()) return alert('Shkruaj emrin dhe mbiemrin.'), false;
    if (name.trim().split(/\s+/).length < 2) return alert('Shkruaj edhe mbiemrin.'), false;

    const ph = sanitizePhone(getCanonicalClientPhone());
    if (!noPhone && (!ph || ph.length < 6)) return alert('Shkruaj një numër telefoni të vlefshëm ose zgjedh PA NUMËR.'), false;

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
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        return { ok: false, reason: 'NO_INTERNET' };
      }
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = typeof window !== 'undefined' ? window.setTimeout(() => { try { controller?.abort(); } catch {} }, 2500) : null;
      try {
        const res = await fetch(`/api/version?_t=${Date.now()}`, {
          method: 'GET',
          cache: 'no-store',
          signal: controller?.signal,
          headers: { Accept: 'application/json, text/plain, */*' },
        });
        if (res && res.ok) return { ok: true, reason: '' };
        return { ok: false, reason: 'REFRESH_FAILED' };
      } catch {
        return { ok: false, reason: 'REFRESH_FAILED' };
      } finally {
        try { if (timer) clearTimeout(timer); } catch {}
      }
    } catch {
      return { ok: true, reason: '' };
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
    } catch { return false; }
  }

  async function findReturningClientByPhone(rawPhone = '', { allowLive = true, liveTimeoutMs = 700 } = {}) {
    const digits = String(rawPhone || '').replace(/\D+/g, '');
    if (!isValidClientPhoneDigits(digits)) return null;
    const phoneFull = `${phonePrefix}${normalizeMatchPhone(digits)}`;
    const phoneKey = normalizeMatchPhone(phoneFull);
    const shortDigits = phoneKey.startsWith('383') ? phoneKey.slice(3) : phoneKey;
    const online = pranimiIsOnline();
    const useLiveAsTruth = allowLive !== false && online;
    const seen = new Map();

    const addCandidate = (row = {}) => {
      const codeNum = Number(normalizeCode(row?.code) || 0);
      if (!codeNum) return;
      const rowPhone = normalizeMatchPhone(row?.phone || row?.client_phone || phoneFull || '');
      if (!isValidClientPhoneDigits(rowPhone) || rowPhone !== phoneKey) return;
      const key = String(row?.id || `code:${codeNum}`);
      if (seen.has(key)) return;
      seen.set(key, {
        id: row?.id || null,
        code: codeNum,
        name: String(row?.name || row?.full_name || row?.client_name || '').trim(),
        phone: String(row?.phone || row?.client_phone || phoneFull || '').trim(),
        updated_at: row?.updated_at || null,
        source: useLiveAsTruth ? 'live' : 'cache',
      });
    };

    if (useLiveAsTruth) {
      const { data, error } = await withSupabaseTimeout(
        supabase
          .from('clients')
          .select('id, code, full_name, first_name, last_name, phone, updated_at')
          .eq('phone', phoneFull)
          .order('updated_at', { ascending: false })
          .limit(5),
        Number(liveTimeoutMs || 700),
        'PRANIMI_RETURNING_CLIENT_LOOKUP_TIMEOUT',
        { source: 'findReturningClientByPhone', mode: 'live_only' }
      );
      if (error) throw error;
      for (const row of Array.isArray(data) ? data : []) {
        addCandidate({
          id: row?.id || null,
          code: row?.code,
          name: row?.full_name || [row?.first_name || '', row?.last_name || ''].filter(Boolean).join(' ').trim(),
          phone: row?.phone || phoneFull,
          updated_at: row?.updated_at || null,
        });
      }
    } else {
      try {
        const localPool = Array.isArray(clientsIndex) ? clientsIndex : [];
        for (const item of localPool) {
          const p = normalizeMatchPhone(item?.phone || '');
          if (p && (p === shortDigits || p === phoneKey || p === `383${shortDigits}`)) addCandidate(item);
        }
      } catch {}

      try {
        const cached = safeJsonParse(localStorage.getItem('tepiha_clients_index_v1') || '{}', {});
        const items = Array.isArray(cached?.items) ? cached.items : [];
        for (const item of items) {
          const p = normalizeMatchPhone(item?.phone || '');
          if (p && (p === shortDigits || p === phoneKey || p === `383${shortDigits}`)) addCandidate(item);
        }
      } catch {}
    }

    const matches = Array.from(seen.values());
    const uniqueCodes = Array.from(new Set(matches.map((m) => Number(normalizeCode(m?.code) || 0)).filter((n) => Number.isFinite(n) && n > 0)));
    if (uniqueCodes.length !== 1) return null;
    const winnerCode = uniqueCodes[0];
    const sorted = matches
      .filter((m) => Number(normalizeCode(m?.code) || 0) === winnerCode)
      .sort((a, b) => String(b?.updated_at || '').localeCompare(String(a?.updated_at || '')));
    return sorted[0] || null;
  }

  async function findBaseClientByNameAndPhone({ name: rawName, phone: rawPhone, clientsIndex: indexArg, allowLive = true, liveTimeoutMs = 700 } = {}) {
    const phoneDigits = normalizeMatchPhone(rawPhone);
    if (!isValidClientPhoneDigits(phoneDigits)) return null;
    const phoneFull = `${phonePrefix}${phoneDigits}`;
    const online = pranimiIsOnline();
    const useLiveAsTruth = allowLive !== false && online;

    const seen = new Map();
    const addCandidate = (row = {}, source = '') => {
      const candidatePhone = normalizeMatchPhone(row?.phone || row?.client_phone || '');
      if (!isValidClientPhoneDigits(candidatePhone) || candidatePhone !== phoneDigits) return;
      const candidateName = row?.name || row?.full_name || row?.client_name || `${row?.first_name || ''} ${row?.last_name || ''}`.trim();
      const codeNum = normalizeCode(row?.code ?? row?.client_code ?? null);
      if (codeNum == null) return;
      const key = String(row?.id || `code:${codeNum}`);
      if (!key || seen.has(key)) return;
      seen.set(key, {
        id: row?.id || null,
        code: codeNum,
        name: String(candidateName || rawName || '').trim(),
        phone: String(row?.phone || row?.client_phone || rawPhone || '').trim(),
        updated_at: row?.updated_at || row?.last_seen || null,
        source,
      });
    };

    if (useLiveAsTruth) {
      const phoneHits = await withSupabaseTimeout(
        searchClientsLive(phoneDigits),
        Number(liveTimeoutMs || 700),
        'PRANIMI_FINAL_CLIENT_PHONE_LOOKUP_TIMEOUT',
        { source: 'findBaseClientByNameAndPhone', mode: 'live_only_phone' }
      );
      for (const item of (Array.isArray(phoneHits) ? phoneHits : [])) addCandidate(item, 'livePhone');
      const matches = Array.from(seen.values()).sort((a, b) => String(b?.updated_at || '').localeCompare(String(a?.updated_at || '')));
      return matches[0] || null;
    }

    // Offline path: preserve the existing local/cache behavior. Cache is only authoritative offline.
    try {
      for (const item of (Array.isArray(indexArg) ? indexArg : [])) addCandidate(item, 'clientsIndex');
    } catch {}

    try {
      const cached = safeJsonParse(localStorage.getItem('tepiha_clients_index_v1') || '{}', {});
      for (const item of (Array.isArray(cached?.items) ? cached.items : [])) addCandidate(item, 'clientsIndexCache');
    } catch {}

    const matches = Array.from(seen.values()).sort((a, b) => String(b?.updated_at || '').localeCompare(String(a?.updated_at || '')));
    return matches[0] || null;
  }

  async function syncClientMasterForCode({ code, name: rawName, phone: rawPhone, photoUrl, selected } = {}) {
    const requestedCodeNum = Number(normalizeCode(code) || 0);
    if (!requestedCodeNum) return null;

    const phoneDigits = normalizeMatchPhone(rawPhone || '');
    const hasValidPhone = isValidClientPhoneDigits(phoneDigits);
    const phoneFull = hasValidPhone ? `${phonePrefix}${phoneDigits}` : '';
    const safeName = String(rawName || '').trim().replace(/\s+/g, ' ');
    const parts = splitFullNameLoose(safeName);
    const selectedId = String(selected?.id || '').trim();
    const selectedCodeNum = normalizeCode(selected?.code ?? null);

    const rowName = (row = {}) => String(
      row?.full_name ||
      row?.name ||
      [row?.first_name || '', row?.last_name || ''].filter(Boolean).join(' ') ||
      ''
    ).trim();

    const buildConflict = (row = {}, reason = 'CODE_CONFLICT') => {
      const existingCode = normalizeCode(row?.code ?? selectedCodeNum ?? null);
      return {
        id: String(row?.id || selectedId || '').trim() || null,
        code: existingCode != null ? existingCode : requestedCodeNum,
        phone: String(row?.phone || phoneFull || '').trim(),
        name: rowName(row) || safeName,
        codeConflict: true,
        conflictReason: reason,
        requestedCode: requestedCodeNum,
        existingCode: existingCode != null ? existingCode : null,
      };
    };

    const updateClient = async (row = {}, lockedCodeNum = requestedCodeNum, reason = 'strong') => {
      const targetId = String(row?.id || selectedId || '').trim();
      if (!targetId) return null;

      const existingCodeNum = normalizeCode(row?.code ?? null);
      const finalLockedCode = normalizeCode(lockedCodeNum ?? existingCodeNum ?? requestedCodeNum);
      if (existingCodeNum != null && finalLockedCode != null && String(existingCodeNum) !== String(finalLockedCode)) {
        return buildConflict(row, `${reason}_EXISTING_CODE_DIFFERS_FROM_LOCK`);
      }
      if (finalLockedCode != null && String(finalLockedCode) !== String(requestedCodeNum)) {
        return buildConflict({ ...row, code: finalLockedCode }, `${reason}_REQUESTED_CODE_DIFFERS_FROM_PERMANENT_CODE`);
      }

      const patch = {
        full_name: safeName || rowName(row) || null,
        first_name: parts.first_name || null,
        last_name: parts.last_name || null,
        updated_at: new Date().toISOString(),
      };
      if (finalLockedCode != null) patch.code = finalLockedCode;
      if (phoneFull) patch.phone = phoneFull;
      if (photoUrl) patch.photo_url = photoUrl;

      const { data: updated, error: updateErr } = await supabase
        .from('clients')
        .update(patch)
        .eq('id', targetId)
        .select('id, code, full_name, first_name, last_name, phone, photo_url')
        .maybeSingle();
      if (updateErr) throw updateErr;

      const out = updated || { ...row, ...patch, id: targetId };
      return {
        id: targetId,
        code: normalizeCode(out?.code ?? finalLockedCode ?? requestedCodeNum),
        phone: String(out?.phone || phoneFull || '').trim(),
        name: rowName(out) || safeName,
        matchReason: reason,
      };
    };

    // 1) Selected client is the only phone-independent hard lock.
    //    If DB already has another permanent code for this selected id, do not overwrite it.
    if (selectedId) {
      const { data: selectedRow, error: selectedErr } = await supabase
        .from('clients')
        .select('id, code, full_name, first_name, last_name, phone, photo_url')
        .eq('id', selectedId)
        .maybeSingle();
      if (selectedErr) throw selectedErr;
      if (!selectedRow?.id) {
        return buildConflict({ id: selectedId, code: selectedCodeNum ?? requestedCodeNum, phone: selected?.phone || phoneFull, full_name: selected?.name || safeName }, 'SELECTED_CLIENT_NOT_CONFIRMED_LIVE');
      }
      const lockedCode = normalizeCode(selectedRow?.code ?? selectedCodeNum ?? requestedCodeNum);
      if (lockedCode != null && String(lockedCode) !== String(requestedCodeNum)) {
        return buildConflict({ ...(selectedRow || {}), id: selectedId, code: lockedCode }, 'SELECTED_CLIENT_CODE_CONFLICT');
      }
      return updateClient(selectedRow || { id: selectedId, code: lockedCode, phone: selected?.phone || phoneFull, full_name: selected?.name || safeName }, lockedCode, 'selected');
    }

    let phoneHits = [];
    if (hasValidPhone && phoneFull) {
      const { data: byPhone, error: byPhoneErr } = await supabase
        .from('clients')
        .select('id, code, full_name, first_name, last_name, phone, photo_url, updated_at')
        .eq('phone', phoneFull)
        .order('updated_at', { ascending: false })
        .limit(5);
      if (byPhoneErr) throw byPhoneErr;
      phoneHits = Array.isArray(byPhone) ? byPhone : [];
    }

    // 2) Valid phone match may sync, but it may never replace an existing permanent code.
    const strongHits = phoneHits.filter((row) => isStrongBaseClientNamePhoneMatch(row, { name: safeName, phone: phoneFull }));
    if (strongHits.length > 0) {
      const strongRow = strongHits[0];
      const permanentCode = normalizeCode(strongRow?.code ?? null);
      if (permanentCode != null && String(permanentCode) !== String(requestedCodeNum)) {
        return buildConflict(strongRow, 'STRONG_MATCH_CODE_CONFLICT');
      }
      return updateClient(strongRow, permanentCode ?? requestedCodeNum, 'phone_match');
    }

    // 3) Phone-only hit is a warning/conflict source only. It cannot update clients.code.
    if (phoneHits.length === 1) {
      const phoneOnlyRow = phoneHits[0];
      const phoneOnlyCode = normalizeCode(phoneOnlyRow?.code ?? null);
      if (phoneOnlyCode != null && String(phoneOnlyCode) !== String(requestedCodeNum)) {
        return buildConflict(phoneOnlyRow, 'PHONE_ONLY_CODE_CONFLICT');
      }
      return null;
    }

    // 4) A row found by the same code can be refreshed, because code is already the permanent key.
    const { data: existingByCode, error: codeErr } = await supabase
      .from('clients')
      .select('id, code, full_name, first_name, last_name, phone, photo_url')
      .eq('code', requestedCodeNum)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (codeErr) throw codeErr;

    if (existingByCode?.id) {
      const existingPhone = normalizeMatchPhone(existingByCode?.phone || '');
      if (!existingPhone || !hasValidPhone || existingPhone === phoneDigits) {
        return updateClient(existingByCode, requestedCodeNum, 'code_owner');
      }
    }

    return null;
  }

  async function handleContinue() {
    if (!validateBeforeContinue()) return;
    if (savingContinue || photoUploading) return;

    try {
      if (!isBridgeEditMode && !noPhone) {
        const pendingMatch = await detectExistingClientSmart({ name, phone, clientsIndex, allowLive: false });
        if (pendingMatch && !sameSelectedClientCode(pendingMatch.candidate) && String(clientMatchDecision?.matchKey || '') !== String(pendingMatch.matchKey || '')) {
          setClientMatchPrompt(pendingMatch);
          return;
        }
      }
    } catch {}

    setSavingContinue(true);

    try {
      const editSource = String(editBridgeRef.current?.source || '').trim();
      const isBaseEdit = ['orders', 'BASE_CACHE', 'LOCAL', 'OUTBOX'].includes(editSource);
      const editTargetId = String(editBridgeRef.current?.id || oid || '').trim();
      const editLocalOid = String(
        editBridgeRef.current?.local_oid ||
        editBridgeRef.current?.order?.local_oid ||
        editBridgeRef.current?.order?.data?.local_oid ||
        editBridgeRef.current?.order?.oid ||
        ''
      ).trim();
      const stableLocalOid = String((isBaseEdit ? (editLocalOid || oid) : oid) || '').trim();
      const shadowOrderId = String((isBaseEdit ? (editTargetId || oid) : oid) || '').trim();

      // 1. ZBULIMI I SIGURT PËRMES URL
      let isFromGati = false;
      try {
        if (typeof window !== 'undefined') isFromGati = window.location.search.includes('from=gati-edit');
      } catch {}

      const rawEditStatus = String(
        editBridgeRef.current?.order?.status ||
        editBridgeRef.current?.order?.data?.status ||
        ''
      ).trim().toLowerCase();

      // 2. KUSHTI I RI I FORCUAR
      const keepStageOnEdit = isBaseEdit && (rawEditStatus === 'gati' || isFromGati);
      const targetStatus = keepStageOnEdit ? 'gati' : 'pastrim';
      const targetNav = keepStageOnEdit ? '/gati' : '/pastrimi';

      // 3. RUAJTJA E HISTORIKUT (LOKACIONI I RAFTEVE ETJ)
      const oldData = editBridgeRef.current?.order || {};
      const oldDataInner = oldData.data || {};

      const order = {
        ...(keepStageOnEdit ? oldData : {}),
        ...(keepStageOnEdit ? oldDataInner : {}),
        id: oid,
        ts: Date.now(),
        status: targetStatus,
        client: {
          name: name.trim(),
          phone: getCanonicalClientPhone(),
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
          ...(oldDataInner?.pay || oldData?.pay || {}),
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

      const urlClientPrefill = (() => {
        const raw = (newOrderUrlClientRef.current && typeof newOrderUrlClientRef.current === 'object') ? newOrderUrlClientRef.current : {};
        const urlClientCode = normalizeCode(raw?.code || codeRawRef.current || codeRaw || null);
        if (urlClientCode == null) return null;
        return {
          id: null,
          code: urlClientCode,
          name: String(raw?.name || name || '').trim(),
          phone: String(raw?.phone || `${phonePrefix}${phone || ''}` || '').trim(),
        };
      })();

      const onlineForClientLookup = pranimiIsOnline();
      const currentCanonicalPhone = getCanonicalClientPhone();
      const currentPhoneDigits = normalizeMatchPhone(currentCanonicalPhone || phone || '');
      const canUsePhoneForClientMatch = !noPhone && isValidClientPhoneDigits(currentPhoneDigits);
      let resolvedSelectedClient = (selectedClient && (isBaseEdit || isStrongBaseClientNamePhoneMatch(selectedClient, { name, phone: currentCanonicalPhone }))) ? selectedClient : null;
      let returningClient = null;
      let finalNamePhoneClient = null;
      let finalLiveLookupFailed = false;
      let finalLiveLookupError = null;

      if (!isBaseEdit && canUsePhoneForClientMatch) {
        try {
          finalNamePhoneClient = await findBaseClientByNameAndPhone({
            name,
            phone: currentCanonicalPhone,
            clientsIndex,
            allowLive: onlineForClientLookup,
            liveTimeoutMs: PRANIMI_CONTINUE_CLIENT_LOOKUP_MS,
          });
        } catch (err) {
          finalLiveLookupFailed = onlineForClientLookup;
          finalLiveLookupError = err;
        }

        if (finalNamePhoneClient?.code != null) {
          resolvedSelectedClient = {
            id: finalNamePhoneClient?.id || null,
            code: normalizeCode(finalNamePhoneClient?.code || null),
            name: finalNamePhoneClient?.name || '',
            phone: finalNamePhoneClient?.phone || currentCanonicalPhone,
          };
          setSelectedClient(resolvedSelectedClient);
        }
      }

      if (!isBaseEdit && canUsePhoneForClientMatch && !resolvedSelectedClient && !finalLiveLookupFailed) {
        try {
          returningClient = await findReturningClientByPhone(phone, {
            allowLive: onlineForClientLookup,
            liveTimeoutMs: PRANIMI_CONTINUE_CLIENT_LOOKUP_MS,
          });
        } catch (err) {
          finalLiveLookupFailed = onlineForClientLookup;
          finalLiveLookupError = err;
        }
        if (returningClient?.code != null && isStrongBaseClientNamePhoneMatch(returningClient, { name, phone: currentCanonicalPhone })) {
          resolvedSelectedClient = {
            id: returningClient?.id || null,
            code: normalizeCode(returningClient?.code || null),
            name: returningClient?.name || '',
            phone: returningClient?.phone || '',
          };
          setSelectedClient(resolvedSelectedClient);
        }
      }

      if (finalLiveLookupFailed && !resolvedSelectedClient?.id) {
        try {
          logDebugEvent('pranimi_final_client_live_lookup_failed_block_save', {
            phoneDigits: currentPhoneDigits || null,
            hasSelectedClientId: !!resolvedSelectedClient?.id,
            errorName: finalLiveLookupError?.name || null,
            errorMessage: finalLiveLookupError?.message || String(finalLiveLookupError || ''),
          });
        } catch {}
        alert('Nuk u verifikua klienti ekzistues. Kontrollo internetin ose zgjedhe klientin nga popup-i.');
        setSavingContinue(false);
        return;
      }

      if (!resolvedSelectedClient && urlClientPrefill?.code != null) {
        const urlPrefillStrong = isStrongBaseClientNamePhoneMatch(urlClientPrefill, { name, phone: getCanonicalClientPhone() });
        if (urlPrefillStrong || isBaseEdit) resolvedSelectedClient = urlClientPrefill;
      }

      const resolvedSelectedClientId = String(resolvedSelectedClient?.id || '').trim() || null;
      const resolvedSelectedClientCodeNum = normalizeCode(resolvedSelectedClient?.code ?? (isBaseEdit ? urlClientPrefill?.code : null) ?? null);
      const resolvedSelectedClientCode = resolvedSelectedClientCodeNum != null ? String(resolvedSelectedClientCodeNum) : '';

      let resolvedCodeRaw = codeRaw;
      if (resolvedSelectedClientCode) resolvedCodeRaw = resolvedSelectedClientCode;
      let normCodeNow = formatKod(normalizeCode(resolvedCodeRaw), netState.ok);

      const markReadyDebugBase = {
        urlCode: String(newOrderUrlClientRef.current?.code || '').trim() || null,
        selectedClient: selectedClient ? { id: selectedClient?.id || null, code: normalizeCode(selectedClient?.code || null), name: selectedClient?.name || '', phone: selectedClient?.phone || '' } : null,
        returningClient: returningClient ? { id: returningClient?.id || null, code: normalizeCode(returningClient?.code || null), name: returningClient?.name || '', phone: returningClient?.phone || '' } : null,
        finalNamePhoneClient: finalNamePhoneClient ? { id: finalNamePhoneClient?.id || null, code: normalizeCode(finalNamePhoneClient?.code || null), name: finalNamePhoneClient?.name || '', phone: finalNamePhoneClient?.phone || '' } : null,
        resolvedSelectedClient: resolvedSelectedClient ? { id: resolvedSelectedClient?.id || null, code: normalizeCode(resolvedSelectedClient?.code || null), name: resolvedSelectedClient?.name || '', phone: resolvedSelectedClient?.phone || '' } : null,
        resolvedSelectedClientCode: resolvedSelectedClientCode || null,
      };
      try {
        window.__tepihaPranimiContinueDebug = {
          ...(window.__tepihaPranimiContinueDebug || {}),
          start: markReadyDebugBase,
        };
      } catch {}
      try {
        pranimiDiagLog('[PRANIMI handleContinue] start', markReadyDebugBase);
      } catch {}

      if (resolvedSelectedClientCode) {
        codeRawRef.current = resolvedSelectedClientCode;
        setCodeRaw(resolvedSelectedClientCode);
        normCodeNow = formatKod(normalizeCode(resolvedSelectedClientCode), true);
      }

      if ((!normCodeNow || normCodeNow === '0' || normCodeNow === '—' || normCodeNow === '…') && !resolvedSelectedClientCode) {
        try {
          try {
            pranimiDiagLog('[PRANIMI handleContinue] reserveSharedCode', { oid: shadowOrderId || oid, existingCode: normalizeCode(resolvedCodeRaw), resolvedSelectedClientCode: resolvedSelectedClientCode || null });
          } catch {}
          const c = await withSupabaseTimeout(
            reserveSharedCode(shadowOrderId || oid),
            PRANIMI_CONTINUE_CODE_RESERVE_MS,
            'PRANIMI_CONTINUE_CODE_RESERVE_TIMEOUT',
            { source: 'handleContinue' }
          );
          resolvedCodeRaw = String(c || '');
          codeRawRef.current = resolvedCodeRaw;
          setCodeRaw(resolvedCodeRaw);
          normCodeNow = formatKod(normalizeCode(resolvedCodeRaw), true);
          try { setNetState({ ok: true, reason: null }); } catch {}
          try { localStorage.removeItem(OFFLINE_MODE_KEY); } catch {}
          try { setOfflineMode(false); } catch {}
          try { setShowOfflinePrompt(false); } catch {}
        } catch {}
      }

      if (!normCodeNow || normCodeNow === '0' || normCodeNow === '—' || normCodeNow === '…') {
        alert('DB ERROR: Kodi mungon ose nuk u rezervua saktë.');
        setSavingContinue(false);
        return;
      }

      let verifiedCodeResult = null;
      try {
        const ensureArgs = {
          oid: shadowOrderId || oid,
          code: resolvedCodeRaw,
          clientPhone: getCanonicalClientPhone(),
          clientName: name?.trim() || '',
          selectedClientId: resolvedSelectedClientId,
          selectedClientCode: resolvedSelectedClientCode || null,
          lockedClientCode: resolvedSelectedClientCode || null,
          editOrderId: isBaseEdit ? editTargetId : '',
        };
        try {
          window.__tepihaPranimiContinueDebug = {
            ...(window.__tepihaPranimiContinueDebug || {}),
            start: { ...((window.__tepihaPranimiContinueDebug || {}).start || {}) },
            ensureArgs,
          };
        } catch {}
        pranimiDiagLog('[PRANIMI handleContinue] ensureUniqueBaseCodeForSave args', ensureArgs);
        const verified = await withSupabaseTimeout(
          ensureUniqueBaseCodeForSave(ensureArgs),
          PRANIMI_CONTINUE_CODE_VERIFY_MS,
          'PRANIMI_CONTINUE_CODE_VERIFY_TIMEOUT',
          { source: 'handleContinue', code: normalizeCode(resolvedCodeRaw) }
        );
        verifiedCodeResult = verified || null;

        const verifiedCode = normalizeCode(verified?.code);
        if (verifiedCode != null && String(verifiedCode) !== String(normalizeCode(resolvedCodeRaw) ?? '')) {
          resolvedCodeRaw = String(verifiedCode);
          codeRawRef.current = resolvedCodeRaw;
          setCodeRaw(resolvedCodeRaw);
        }

        normCodeNow = formatKod(normalizeCode(resolvedCodeRaw), true);

        try {
          logDebugEvent('pranimi_code_verify_result', {
            requestedCode: normalizeCode(codeRaw),
            resolvedCode: normalizeCode(resolvedCodeRaw),
            changed: !!verified?.changed,
            verified: !!verified?.verified,
            offline: !!verified?.offline,
            isBaseEdit: !!isBaseEdit,
            editTargetId: editTargetId || null,
          });
        } catch {}
      } catch (verifyErr) {
        const verifyMsg = String(verifyErr?.message || verifyErr || '');
        const verifyIsNetworkish = Boolean(
          verifyErr?.isSupabaseTimeout ||
          /timeout|load failed|failed to fetch|fetch failed|networkerror|network request failed|abort/i.test(verifyMsg)
        );
        try {
          logDebugEvent('pranimi_code_verify_error', {
            message: verifyMsg,
            requestedCode: normalizeCode(resolvedCodeRaw),
            isBaseEdit: !!isBaseEdit,
            editTargetId: editTargetId || null,
            continuedLocalFirst: verifyIsNetworkish,
          });
        } catch {}
        if (!verifyIsNetworkish) {
          alert('DB ERROR: Kodi nuk u verifikua para ruajtjes.');
          setSavingContinue(false);
          return;
        }
        verifiedCodeResult = { code: normalizeCode(resolvedCodeRaw), verified: false, offline: true, localFirstFast: true };
        normCodeNow = formatKod(normalizeCode(resolvedCodeRaw), true);
      }

      if (!normCodeNow || normCodeNow === '0' || normCodeNow === '—' || normCodeNow === '…') {
        alert('DB ERROR: Kodi final mungon pas verifikimit.');
        setSavingContinue(false);
        return;
      }

      const nowIso = new Date().toISOString();
      const persistedClientCode = Number(normCodeNow || 0) || null;
      const canonicalSelectedName = String(resolvedSelectedClient?.name || '').trim();
      const canonicalSelectedPhone = String(resolvedSelectedClient?.phone || '').trim();
      const finalClientName = canonicalSelectedName || (name?.trim() || null);
      const finalClientPhone = canonicalSelectedPhone || getCanonicalClientPhone();

      const payload = {
        status: targetStatus,
        code: persistedClientCode,
        client_id: resolvedSelectedClientId || null,
        client_code: persistedClientCode,
        client_name: finalClientName,
        client_phone: finalClientPhone,
        pieces: Number(copeCount || 0),
        m2_total: Number(totalM2 || 0),
        price_total: Number(totalEuro || 0),
        paid_cash: Number(clientPaid || 0),
        is_paid_upfront: Number(clientPaid || 0) > 0,
        note: notes || null,
        updated_at: nowIso,
        data: {
          ...order,
          status: targetStatus,
          updated_at: nowIso,
          client_name: finalClientName,
          client_phone: finalClientPhone,
          phone_digits: normalizeMatchPhone(finalClientPhone || ''),
          client_code: persistedClientCode,
          pieces: Number(copeCount || 0),
          m2_total: Number(totalM2 || 0),
          price_total: Number(totalEuro || 0),
          paid_cash: Number(clientPaid || 0),
          is_paid_upfront: Number(clientPaid || 0) > 0,
          note: notes || null,
          local_oid: stableLocalOid || String(shadowOrderId || oid),
          client: {
            ...(order?.client || {}),
            id: resolvedSelectedClientId || order?.client?.id || null,
            code: persistedClientCode,
            name: finalClientName,
            phone: finalClientPhone,
            photoUrl: clientPhotoUrl || null,
          },
          client_master_id: resolvedSelectedClientId || null,
          client_id: resolvedSelectedClientId || null,
        },
      };

      const verifiedOwner = verifiedCodeResult?.owner && typeof verifiedCodeResult.owner === 'object' ? verifiedCodeResult.owner : null;
      const verifiedOwnerPhone = normalizeMatchPhone(verifiedOwner?.phone || '');
      const finalPhoneDigits = normalizeMatchPhone(finalClientPhone || '');
      const verifiedOwnerStrongMatch = verifiedOwner?.id &&
        isValidClientPhoneDigits(finalPhoneDigits) &&
        verifiedOwnerPhone &&
        verifiedOwnerPhone === finalPhoneDigits &&
        isStrongBaseClientNamePhoneMatch(verifiedOwner, { name: finalClientName || name, phone: finalClientPhone });
      if (!payload?.client_id && verifiedOwnerStrongMatch) {
        payload.client_id = String(verifiedOwner.id || '').trim() || null;
        payload.data.client_master_id = payload.client_id || null;
        payload.data.client = {
          ...(payload.data.client || {}),
          id: payload.client_id || null,
          code: persistedClientCode,
          name: payload.data.client?.name || String(verifiedOwner?.full_name || verifiedOwner?.name || [verifiedOwner?.first_name, verifiedOwner?.last_name].filter(Boolean).join(' ') || finalClientName || '').trim(),
          phone: payload.data.client?.phone || String(verifiedOwner?.phone || finalClientPhone || '').trim(),
        };
        payload.client_name = payload.client_name || payload.data.client.name || null;
        payload.client_phone = payload.client_phone || payload.data.client.phone || '';
      }

      try {
        const payloadDebug = {
          finalSelectedClient: resolvedSelectedClient ? { id: resolvedSelectedClient?.id || null, code: normalizeCode(resolvedSelectedClient?.code || null), name: resolvedSelectedClient?.name || '', phone: resolvedSelectedClient?.phone || '' } : null,
          finalSelectedClientCode: resolvedSelectedClientCode || null,
          payloadFinalCode: persistedClientCode,
          payloadClientCode: persistedClientCode,
          payloadClientId: payload?.data?.client?.id || null,
          payloadClientMasterId: payload?.data?.client_master_id || null,
          payload,
        };
        window.__tepihaPranimiContinueDebug = {
          ...(window.__tepihaPranimiContinueDebug || {}),
          start: { ...((window.__tepihaPranimiContinueDebug || {}).start || {}) },
          ensureArgs: ((window.__tepihaPranimiContinueDebug || {}).ensureArgs || null),
          payloadDebug,
        };
        pranimiDiagLog('[PRANIMI handleContinue] payload', payloadDebug);
      } catch {}

      let syncedClientMaster = null;
      try {
        if (typeof navigator === 'undefined' || navigator.onLine !== false) {
          let masterSyncFailed = false;
          let masterSyncError = null;
          const masterSyncPhoneDigits = normalizeMatchPhone(finalClientPhone || getCanonicalClientPhone() || phone || '');
          const mustVerifyMasterClientBeforeSave = !isBaseEdit &&
            !noPhone &&
            isValidClientPhoneDigits(masterSyncPhoneDigits) &&
            !resolvedSelectedClientId;

          syncedClientMaster = await withSupabaseTimeout(
            syncClientMasterForCode({
              code: persistedClientCode || normCodeNow,
              name: finalClientName || '',
              phone: finalClientPhone || '',
              photoUrl: clientPhotoUrl || '',
              selected: resolvedSelectedClient,
            }),
            PRANIMI_CONTINUE_MASTER_SYNC_MS,
            'PRANIMI_CONTINUE_MASTER_SYNC_TIMEOUT',
            { source: 'handleContinue' }
          ).catch((err) => {
            masterSyncFailed = true;
            masterSyncError = err;
            return null;
          });

          if (masterSyncFailed && mustVerifyMasterClientBeforeSave) {
            try {
              logDebugEvent('pranimi_client_master_sync_required_failed', {
                code: persistedClientCode || normCodeNow || null,
                phoneDigits: masterSyncPhoneDigits || null,
                hasSelectedClientId: !!resolvedSelectedClientId,
                hasSelectedClientCode: !!resolvedSelectedClientCode,
                errorName: masterSyncError?.name || null,
                errorMessage: masterSyncError?.message || String(masterSyncError || ''),
              });
            } catch {}
            alert('Nuk u verifikua klienti ekzistues. Kontrollo internetin ose zgjedhe klientin nga popup-i.');
            setSavingContinue(false);
            return;
          }

          if (syncedClientMaster?.codeConflict) {
            try {
              logDebugEvent('pranimi_client_master_code_conflict', {
                requestedCode: syncedClientMaster?.requestedCode || persistedClientCode || null,
                existingCode: syncedClientMaster?.existingCode || syncedClientMaster?.code || null,
                clientId: syncedClientMaster?.id || null,
                reason: syncedClientMaster?.conflictReason || 'CODE_CONFLICT',
              });
            } catch {}
            alert(`KUJDES: Ky numër/emër duket se i takon klientit ekzistues me kod ${syncedClientMaster?.existingCode || syncedClientMaster?.code || '—'}. Kodi permanent nuk u ndryshua. Zgjedhe klientin ekzistues nga popup-i ose kontrollo emrin/telefonin para ruajtjes.`);
            setSavingContinue(false);
            return;
          }

          if (syncedClientMaster?.id) {
            const syncedClientMasterName = String(
              syncedClientMaster?.full_name ||
              syncedClientMaster?.name ||
              [syncedClientMaster?.first_name, syncedClientMaster?.last_name].filter(Boolean).join(' ') ||
              finalClientName ||
              ''
            ).trim() || finalClientName;
            const syncedClientMasterPhone = String(syncedClientMaster?.phone || finalClientPhone || '').trim() || finalClientPhone;

            payload.client_id = syncedClientMaster.id;
            payload.client_name = syncedClientMasterName || payload.client_name || null;
            payload.client_phone = syncedClientMasterPhone || payload.client_phone || '';

            const syncedClientCode = normalizeCode(syncedClientMaster?.code ?? persistedClientCode) || persistedClientCode;
            if (syncedClientCode && String(syncedClientCode) !== String(persistedClientCode)) {
              alert('KUJDES: Kodi i klientit permanent nuk përputhet me kodin e porosisë. Ruajtja u ndal për siguri.');
              setSavingContinue(false);
              return;
            }

            payload.data.client = {
              ...(payload.data.client || {}),
              id: syncedClientMaster.id,
              code: persistedClientCode,
              name: syncedClientMasterName || null,
              phone: syncedClientMasterPhone || '',
              photoUrl: clientPhotoUrl || null,
            };
            payload.data.client_master_id = syncedClientMaster.id;
            payload.data.client_name = syncedClientMasterName || payload.data.client_name || null;
            payload.data.client_phone = syncedClientMasterPhone || payload.data.client_phone || '';
          }
        }
      } catch {}

      const finishSuccess = () => {
        const finishedId = String(oid || '').trim();
        if (finishedId) suppressDraftId(finishedId);
        try { if (draftTimer.current) clearTimeout(draftTimer.current); } catch {}
        try { if (remoteDraftTimerRef.current) clearTimeout(remoteDraftTimerRef.current); } catch {}
        try { removeDraftLocal(finishedId); } catch {}
        try {
          draftRemoteCacheRef.current = {
            ts: Date.now(),
            items: (Array.isArray(draftRemoteCacheRef.current?.items) ? draftRemoteCacheRef.current.items : []).filter((d) => String(d?.id || '') !== finishedId),
          };
        } catch {}
        setDrafts((prev) => (Array.isArray(prev) ? prev.filter((d) => String(d?.id || '') !== finishedId) : []));

        clearActiveEditBridge();
        try { clearCurrentSessionLocal(); } catch {}
        try { sessionStorage.setItem(RESET_ON_SHOW_KEY, '1'); } catch {}
        try { codeRawRef.current = ''; } catch {}
        try { patchBaseMasterRow({ id: String(shadowOrderId || oid), local_oid: stableLocalOid || String(shadowOrderId || oid), table: 'orders', ...payload }); } catch {}
        try {
          const shadowOrder = {
            ...order,
            local_oid: stableLocalOid || String(shadowOrderId || oid),
            data: {
              ...((order && typeof order === 'object') ? order : {}),
              ...(((payload?.data) && typeof payload.data === 'object') ? payload.data : {}),
              local_oid: stableLocalOid || String(shadowOrderId || oid),
            },
          };
          localStorage.setItem(`order_${shadowOrderId || oid}`, JSON.stringify(shadowOrder));
        } catch {}

        void (async () => {
          try {
            const shadowOrder = {
              ...order,
              local_oid: stableLocalOid || String(shadowOrderId || oid),
              data: {
                ...((order && typeof order === 'object') ? order : {}),
                ...(((payload?.data) && typeof payload.data === 'object') ? payload.data : {}),
                local_oid: stableLocalOid || String(shadowOrderId || oid),
              },
            };
            const blob = new Blob([JSON.stringify(shadowOrder)], { type: 'application/json' });
            await storageWithTimeout(supabase.storage.from(BUCKET).upload(`orders/${shadowOrderId || oid}.json`, blob, {
              upsert: true, cacheControl: '0', contentType: 'application/json',
            }), 6500, 'PRANIMI_ORDER_SHADOW_UPLOAD_TIMEOUT', { bucket: BUCKET, path: `orders/${shadowOrderId || oid}.json` });
          } catch {}
          try { removeDraftLocal(finishedId); } catch {}
          try { await deleteDraftRemote(finishedId); } catch {}
        })();

        const smsPublicId = String(payload?.code || normCodeNow || codeRaw || '').trim();
        const smsOrderPayload = JSON.parse(JSON.stringify({
          id: String(shadowOrderId || oid || ''),
          local_oid: stableLocalOid || String(shadowOrderId || oid || ''),
          public_id: smsPublicId,
          publicId: smsPublicId,
          confirm_id: smsPublicId,
          code: persistedClientCode,
          client_name: payload?.client_name || name?.trim() || '',
          client_phone: payload?.client_phone || getCanonicalClientPhone(),
          pieces: Number(payload?.pieces || copeCount || 0),
          m2_total: Number(payload?.m2_total || totalM2 || 0),
          price_total: Number(payload?.price_total || totalEuro || 0),
          pay: {
            ...(payload?.data?.pay || order?.pay || {}),
            m2: Number(payload?.m2_total || totalM2 || 0),
            euro: Number(payload?.price_total || totalEuro || 0),
          },
          client: {
            name: payload?.client_name || name?.trim() || '',
            phone: payload?.client_phone || getCanonicalClientPhone(),
            code: persistedClientCode,
          },
          tepiha: Array.isArray(order?.tepiha) ? order.tepiha : [],
          staza: Array.isArray(order?.staza) ? order.staza : [],
          shkallore: order?.shkallore || { qty: 0, per: Number(stairsPer) || 0, photoUrl: '' },
          totals: {
            pieces: Number(payload?.pieces || copeCount || 0),
            m2: Number(payload?.m2_total || totalM2 || 0),
            euro: Number(payload?.price_total || totalEuro || 0),
          },
          data: {
            ...(payload?.data || {}),
            id: String(shadowOrderId || oid || ''),
            local_oid: stableLocalOid || String(shadowOrderId || oid || ''),
            public_id: smsPublicId,
            publicId: smsPublicId,
            confirm_id: smsPublicId,
            code: persistedClientCode,
            client_name: payload?.client_name || name?.trim() || '',
            client_phone: payload?.client_phone || getCanonicalClientPhone(),
            pieces: Number(payload?.pieces || copeCount || 0),
            m2_total: Number(payload?.m2_total || totalM2 || 0),
            price_total: Number(payload?.price_total || totalEuro || 0),
            client: {
              name: payload?.client_name || name?.trim() || '',
              phone: payload?.client_phone || getCanonicalClientPhone(),
              code: persistedClientCode,
            },
            tepiha: Array.isArray(order?.tepiha) ? order.tepiha : [],
            staza: Array.isArray(order?.staza) ? order.staza : [],
            shkallore: order?.shkallore || { qty: 0, per: Number(stairsPer) || 0, photoUrl: '' },
            pay: {
              ...(payload?.data?.pay || order?.pay || {}),
              m2: Number(payload?.m2_total || totalM2 || 0),
              euro: Number(payload?.price_total || totalEuro || 0),
            },
            totals: {
              pieces: Number(payload?.pieces || copeCount || 0),
              m2: Number(payload?.m2_total || totalM2 || 0),
              euro: Number(payload?.price_total || totalEuro || 0),
            },
          },
        }));

        const smsPhone = sanitizePhone(
          smsOrderPayload?.client_phone ||
          smsOrderPayload?.client?.phone ||
          smsOrderPayload?.data?.client_phone ||
          smsOrderPayload?.data?.client?.phone ||
          getCanonicalClientPhone()
        );

        const smsText = buildSmartSmsText(smsOrderPayload, 'pranimi_baze');

        if (smsText && smsPhone && !isBaseEdit) {
          try { sessionStorage.setItem(RESET_ON_SHOW_KEY, '1'); } catch {}
          try { setPendingNavTo(targetNav); } catch {}
          try { setShowMsgSheet(false); } catch {}
          setResetAfterSmsClose(true);
          setSmsModal({ open: true, phone: smsPhone, text: smsText });
          setSavingContinue(false);
          return;
        }

        try { sessionStorage.setItem(RESET_ON_SHOW_KEY, '1'); } catch {}
        try { setPendingNavTo(targetNav); } catch {}
        try { setShowWizard(false); } catch {}
        try { setShowMsgSheet(false); } catch {}
        setSavingContinue(false);
        void resetForNewOrder();
        try { router.push(targetNav); } catch {}
      };

      try {
        if (isBaseEdit && editTargetId) {
          pranimiDiagLog('[PRANIMI handleContinue] save body', { mode: 'edit', table: 'orders', id: String(editTargetId), payload });
          if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new Error('OFFLINE_ENQUEUE');
          await updateOrderRecord('orders', editTargetId, payload);
          try { patchBaseMasterRow({ id: String(editTargetId), local_oid: stableLocalOid || String(editTargetId), table: 'orders', ...payload, _synced: true, _local: false }); } catch {}
          finishSuccess();
          return;
        }

        pranimiDiagLog('[PRANIMI handleContinue] save body', { mode: 'create', table: 'orders', id: String(oid), payload: { id: String(oid), local_oid: String(oid), ...payload } });
        await enqueueBaseOrder({ id: String(oid), local_oid: String(oid), ...payload });
        try {
          syncNow({ source: 'pranimi_continue_background_instant' }).catch(() => {});
        } catch {}

        finishSuccess();
        return;
      } catch (err) {
        const isOffline =
          offlineMode ||
          (typeof navigator !== 'undefined' && navigator.onLine === false) ||
          /load failed|failed to fetch|fetch failed|networkerror|network request failed|offline_enqueue/i.test(String(err?.message || err || ''));

        if (!isOffline) {
          alert('DB ERROR: ' + (err?.message || 'Unknown error'));
          setSavingContinue(false);
          return;
        }

        try {
          if (isBaseEdit && editTargetId) {
            await saveOrderLocal({ id: String(editTargetId), local_oid: stableLocalOid || String(editTargetId), table: 'orders', ...payload, _synced: false, _local: true, _syncPending: true, _syncing: false, _syncFailed: false });
            try { patchBaseMasterRow({ id: String(editTargetId), local_oid: stableLocalOid || String(editTargetId), table: 'orders', ...payload, _synced: false, _local: true, _syncPending: true, _syncing: false, _syncFailed: false }); } catch {}
            await enqueueOutboxItem({
              op: 'patch_order_data',
              kind: 'base_order_patch',
              id: String(editTargetId),
              uniqueValue: payload?.code || editTargetId,
              payload: { id: String(editTargetId), local_oid: stableLocalOid || String(editTargetId), table: 'orders', ...payload },
            }).catch(() => {});
          } else {
            await enqueueBaseOrder({ id: String(oid), local_oid: String(oid), ...payload });
          }
        } catch {}
        try { syncNow().catch(()=>{}); } catch {}

        finishSuccess();
        return;
      }
    } catch (err) {
      alert('DB ERROR: ' + (err?.message || 'Unknown error'));
      setSavingContinue(false);
      return;
    }
  }

  function openDrafts() {
    setShowDraftsSheet(true);
    void refreshDrafts({ includeRemote: true, forceRemote: true });
  }


  function applyDraftSnapshotToForm(d, fallbackId = '') {
    const nextId = String(d?.id || fallbackId || '').trim();
    if (!nextId) return;
    oidRef.current = nextId;
    setOid(nextId);
    const nextCode = String(d?.codeRaw || d?.code || '');
    codeRawRef.current = nextCode;
    setCodeRaw(nextCode);
    const nextName = String(d?.name || '').trim();
    setName(nextName);
    const nextPhone = String(d?.phone || d?.client?.phone || '').replace(/^\+383\s*/, '').replace(/\D+/g, '');
    setPhone(nextPhone);
    setNoPhone(Boolean(d?.noPhone) || !nextPhone);
    setClientPhotoUrl(d?.clientPhotoUrl || '');
    newOrderUrlClientRef.current = { code: '', name: '', phone: '' };
    setSelectedClient(nextCode || nextName || nextPhone ? {
      id: null,
      code: nextCode || '',
      name: nextName || '',
      phone: nextPhone ? `${phonePrefix}${nextPhone}` : '',
    } : null);
    setClientMatchPrompt({ open: false, reason: '', matchKey: '', candidate: null, phoneDigits: '', fullName: '' });

    setTepihaRows(Array.isArray(d?.tepihaRows) && d.tepihaRows.length ? d.tepihaRows.map((r) => ({ ...r, qty: String(r?.qty ?? '0') })) : []);
    setStazaRows(Array.isArray(d?.stazaRows) && d.stazaRows.length ? d.stazaRows.map((r) => ({ ...r, qty: String(r?.qty ?? '0') })) : []);
    setStairsQty(Number(d?.stairsQty) || 0);
    setStairsPer(Number(d?.stairsPer) || SHKALLORE_M2_PER_STEP_DEFAULT);
    setStairsPhotoUrl(d?.stairsPhotoUrl || '');

    priceSourceRef.current = 'draft';
    setPricePerM2(Number(d?.pricePerM2) || PRICE_DEFAULT);
    setPriceTmp(Number(d?.pricePerM2) || PRICE_DEFAULT);
    setClientPaid(Number(d?.clientPaid) || 0);
    setArkaRecordedPaid(Number(d?.arkaRecordedPaid) || 0);
    setPayMethod(d?.payMethod || 'CASH');
    setNotes(d?.notes || '');
    setShowDraftsSheet(false);
  }

  async function loadDraftIntoForm(id) {
    try {
      unsuppressDraftId(id);
      if (draftTimer.current) clearTimeout(draftTimer.current);
      if (remoteDraftTimerRef.current) clearTimeout(remoteDraftTimerRef.current);

      let remoteDraft = null;
      try { remoteDraft = await readDraftRemote(id); } catch {}

      if (!remoteDraft) {
        let localDraft = null;
        try {
          const raw = localStorage.getItem(`${DRAFT_ITEM_PREFIX}${id}`);
          if (raw) localDraft = JSON.parse(raw);
        } catch {}
        if (!localDraft) return;
        applyDraftSnapshotToForm(localDraft, id);
        try { if (sessionSnapshotHasContent(localDraft)) writeCurrentSessionLocal(localDraft); } catch {}
        return;
      }

      applyDraftSnapshotToForm(remoteDraft, id);
      try { removeDraftLocal(id); } catch {}
      try { if (sessionSnapshotHasContent(remoteDraft)) writeCurrentSessionLocal(remoteDraft); } catch {}
    } catch {}
  }

  async function deleteDraft(id) {
    const targetId = String(id || '').trim();
    if (!targetId) return;

    suppressDraftId(targetId);

    try { if (draftTimer.current) clearTimeout(draftTimer.current); } catch {}
    try { if (remoteDraftTimerRef.current) clearTimeout(remoteDraftTimerRef.current); } catch {}
    try { removeDraftLocal(targetId); } catch {}
    try {
      draftRemoteCacheRef.current = {
        ts: Date.now(),
        items: (Array.isArray(draftRemoteCacheRef.current?.items) ? draftRemoteCacheRef.current.items : []).filter((d) => String(d?.id || '') !== targetId),
      };
    } catch {}

    setDrafts((prev) => (Array.isArray(prev) ? prev.filter((d) => String(d?.id || '') !== targetId) : []));

    if (String(oid || '') === targetId) {
      try {
        setOid('');
        setCodeRaw('');
        setName('');
        setPhone('');
        setNoPhone(false);
        setClientPhotoUrl('');
        setSelectedClient(null);
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
      } catch {}
      void resetForNewOrder();
    }

    void deleteDraftRemote(targetId);
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

  function openSmartSms(actionType = 'pranimi_baze', orderOverride = null) {
    const fallbackPhone = getCanonicalClientPhone();
    const targetPhone = sanitizePhone(
      orderOverride?.client_phone ||
      orderOverride?.phone ||
      orderOverride?.client?.phone ||
      orderOverride?.data?.client_phone ||
      orderOverride?.data?.client?.phone ||
      fallbackPhone
    );
    if (!targetPhone) return alert('Shkruaj numrin e telefonit.');

    const pieces = Number(
      orderOverride?.pieces ??
      orderOverride?.data?.pieces ??
      orderOverride?.totals?.pieces ??
      orderOverride?.data?.totals?.pieces ??
      copeCount ??
      0
    );

    const smsPublicId = String(normalizeCode(codeRaw) || '').trim();
    const orderForSms = orderOverride || {
      id: String(oid || ''),
      local_oid: oid || '',
      public_id: smsPublicId,
      publicId: smsPublicId,
      confirm_id: smsPublicId,
      code: Number(normalizeCode(codeRaw) || 0) || null,
      phone: targetPhone,
      client_phone: targetPhone,
      client_name: name || '',
      pieces,
      m2_total: Number(totalM2 || 0),
      price_total: Number(totalEuro || 0),
      pay: {
        m2: Number(totalM2 || 0),
        euro: Number(totalEuro || 0),
      },
      data: {
        client: {
          phone: targetPhone,
          name: name || '',
          code: Number(normalizeCode(codeRaw) || 0) || null,
        },
        tepiha: tepihaRows.map((r) => ({ m2: Number(r?.m2) || 0, qty: Number(r?.qty) || 0, photoUrl: r?.photoUrl || '' })),
        staza: stazaRows.map((r) => ({ m2: Number(r?.m2) || 0, qty: Number(r?.qty) || 0, photoUrl: r?.photoUrl || '' })),
        shkallore: { qty: Number(stairsQty) || 0, per: Number(stairsPer) || 0, photoUrl: stairsPhotoUrl || '' },
        pay: {
          m2: Number(totalM2 || 0),
          euro: Number(totalEuro || 0),
        },
        totals: {
          pieces,
          m2: Number(totalM2 || 0),
          euro: Number(totalEuro || 0),
        },
      },
      totals: {
        pieces,
        m2: Number(totalM2 || 0),
        euro: Number(totalEuro || 0),
      },
    };

    const text = buildSmartSmsText(orderForSms, actionType);
    setSmsModal({ open: true, phone: targetPhone, text });
  }

  function sendViaSMS() {
    const to = sanitizePhone(getCanonicalClientPhone());
    if (!to) return alert('Shkruaj numrin e klientit.');
    openLinkSafe(buildSmsLink(to, buildStartMessage()));
  }

  function sendViaWhatsApp() {
    const to = sanitizePhone(getCanonicalClientPhone());
    const text = encodeURIComponent(buildStartMessage());
    if (!to) return alert('Shkruaj numrin e klientit.');
    openLinkSafe(`https://wa.me/${to}?text=${text}`);
  }

  function sendViaViber() {
    const to = sanitizePhone(getCanonicalClientPhone());
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
            <div style={{ fontWeight: 900, letterSpacing: 1 }}>{netState?.reason === 'REFRESH_FAILED' ? 'DËSHTOI RIFRESKIMI' : 'S’KA LIDHJE'}</div>
            <div style={{ opacity: 0.85, marginTop: 8, lineHeight: 1.35 }}>
              {netState?.reason === 'REFRESH_FAILED' ? 'Interneti është aktiv, por rifreskimi me serverin dështoi. Mundesh me vazhdu në ' : 'Interneti mungon ose je jashtë rrjetit. Mundesh me vazhdu në '}<b>OFFLINE MODE</b> që mos me i humb klientat?
            </div>
            <div style={{ display: 'flex', gap: 10, marginTop: 12, flexWrap: 'wrap' }}>
              <button onClick={() => { setOfflineMode(true); try { localStorage.setItem(OFFLINE_MODE_KEY, '1'); } catch {} setShowOfflinePrompt(false); }} style={{ padding: '10px 12px', borderRadius: 10, fontWeight: 900 }}>KALO NË OFFLINE</button>
              <button onClick={async () => { const s = await checkConnectivity(); setNetState(s); if (s.ok) setShowOfflinePrompt(false); }} style={{ padding: '10px 12px', borderRadius: 10, fontWeight: 900, opacity: 0.9 }}>PROVO PRAP</button>
              <button onClick={() => setShowOfflinePrompt(false)} style={{ padding: '10px 12px', borderRadius: 10, fontWeight: 800, opacity: 0.75 }}>MBYLL</button>
            </div>
            <div style={{ marginTop: 10, opacity: 0.7, fontSize: 12 }}>Status: {netState.ok ? 'ONLINE' : (netState.reason === 'REFRESH_FAILED' ? 'RIFRESKIMI DËSHTOI' : netState.reason)}</div>
          </div>
        </div>
      ) : null}

      <header className="header-row pranim-top-header" style={{ alignItems: 'flex-start' }}>
        <div className="pranim-top-left">
          <h1 className="title">PRANIMI</h1>
          <div className="subtitle">KRIJO POROSI</div>
        </div>

        <div className="code-badge pranim-top-code-wrap">
          <span
            className="badge pranim-top-code-badge"
            title={`KODI: ${formatKod(normalizeCode(codeRaw), netState.ok)}`}
            aria-label={`KODI: ${formatKod(normalizeCode(codeRaw), netState.ok)}`}
          >
            {formatKod(normalizeCode(codeRaw), netState.ok)}
          </span>
        </div>

        <div className="pranim-top-offline" style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end' }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer', userSelect: 'none' }}>
              <input type="checkbox" checked={offlineMode} onChange={(e) => { const v = e.target.checked; setOfflineMode(v); try { localStorage.setItem(OFFLINE_MODE_KEY, v ? '1' : '0'); } catch {} }} />
              <span style={{ fontWeight: 900, letterSpacing: 0.5 }}>OFFLINE MODE</span>
            </label>
          </div>
          <div style={{ fontSize: 12, opacity: 0.75 }}>{netState.ok ? 'ONLINE' : `LIDHJA: ${netState.reason === 'REFRESH_FAILED' ? 'RIFRESKIMI DËSHTOI' : netState.reason}`}</div>
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
                try { setNoPhone(false); } catch {}
                try { setClientPhotoUrl(''); } catch {}
                try { setOldClientDebt(0); } catch {}
                try { setClientQuery(''); } catch {}
                try { setClientHits([]); } catch {}
                try { setCodeRaw(''); } catch {}
              }}
            >
              ✕
            </button>
            <div className="client-selected-main">
              {clientPhotoUrl ? <img src={clientPhotoUrl} alt="" className="client-mini large" /> : <div className="client-avatar-fallback">👤</div>}
              <div className="client-selected-copy">
                <div className="client-copy-topline">
                  <div className="client-code-pill">{`NR ${formatKod(normalizeCode(codeRaw), netState.ok)}`}</div>
                  <button
                    type="button"
                    className="client-inline-edit"
                    aria-label="Ndrysho klientin"
                    title="NDRYSHO KLIENTIN"
                    onClick={openWizard}
                  >
                    ✎
                  </button>
                </div>
                <div className="client-selected-name">{name || 'KLIENT I RI'}</div>
                <div className="client-selected-phone">{noPhone ? 'PA NUMËR' : (String(phone || '').replace(/\D+/g, '') ? `${phonePrefix} ${String(phone || '').replace(/\D+/g, '')}` : 'PA TELEFON')}</div>
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
          <button className="rbtn add" onClick={() => addRow('tepiha')}>+ RRESHT</button>
          <button className="rbtn remove" onClick={() => removeRow('tepiha')}>− RRESHT</button>
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
          <button className="rbtn add" onClick={() => addRow('staza')}>+ RRESHT</button>
          <button className="rbtn remove" onClick={() => removeRow('staza')}>− RRESHT</button>
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
          <button className="btn secondary" style={{ width: '100%' }} onClick={() => openSmartSms('pranimi_baze')}>📩 DËRGO MESAZH — FILLON PASTRIMI</button>
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
        <button className="btn secondary" onClick={async () => { await commitDraftAndAdvanceCodeBestEffort(); try { clearCurrentSessionLocal(); } catch {} try { sessionStorage.setItem(RESET_ON_SHOW_KEY, '1'); } catch {} router.push('/'); }}>🏠 HOME</button>
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
              {uniqueDrafts.length === 0 ? <div style={{ textAlign: 'center', padding: '18px 0', color: 'rgba(255,255,255,0.7)' }}>S’ka “të pa plotsuara”.</div> : (
                uniqueDrafts.map((d) => (
                  <div key={d.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 4px', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
                    <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                      <div style={{ background: '#16a34a', color: '#0b0b0b', padding: '8px 10px', borderRadius: 10, fontWeight: 900, minWidth: 56, textAlign: 'center' }}>{d.code || '—'}</div>
                      <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.8)' }}>
                        <div style={{ fontWeight: 800 }}>KODI: {d.code || '—'}</div>
                        <div style={{ opacity: 0.92, fontWeight: 700 }}>{d.name || 'PA EMËR'}</div>
                        <div style={{ opacity: 0.82 }}>{d.phone ? `${phonePrefix} ${d.phone}` : 'PA TELEFON'}</div>
                        <div style={{ opacity: 0.78 }}>{Number(d.m2 || 0).toFixed(2)} m² • {Number(d.euro || 0).toFixed(2)} €</div>
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
                <button className="btn secondary" style={{ flex: 1 }} onClick={() => openSmartSms('pranimi_baze')}>VIBER</button>
                <button className="btn secondary" style={{ flex: 1 }} onClick={() => openSmartSms('pranimi_baze')}>WHATSAPP</button>
                <button className="btn secondary" style={{ flex: 1 }} onClick={() => openSmartSms('pranimi_baze')}>SMS</button>
              </div>
              <div style={{ marginTop: 12, fontSize: 12, color: 'rgba(255,255,255,0.65)' }}>* Numri i kompanisë në fund: {COMPANY_PHONE_DISPLAY}</div>
            </div>
            <button className="btn secondary" style={{ width: '100%' }} onClick={closeMsgSheet}>MBYLL</button>
          </div>
        </div>
      )}

      <SmartSmsModal
        isOpen={smsModal.open}
        onClose={() => {
          const shouldReset = !!resetAfterSmsClose;
          const next = pendingNavTo || '';
          setSmsModal((s) => ({ ...s, open: false }));
          setResetAfterSmsClose(false);
          if (shouldReset) {
            try { setShowWizard(false); } catch {}
            try { setShowMsgSheet(false); } catch {}
            void resetForNewOrder();
            if (next) {
              try { setPendingNavTo(''); } catch {}
              router.push(next);
            }
          }
        }}
        onAction={() => {
          const shouldReset = !!resetAfterSmsClose;
          const next = pendingNavTo || '';
          setTimeout(() => {
            setSmsModal((s) => ({ ...s, open: false }));
            setResetAfterSmsClose(false);
            if (shouldReset) {
              try { setShowWizard(false); } catch {}
              try { setShowMsgSheet(false); } catch {}
              void resetForNewOrder();
              if (next) {
                try { setPendingNavTo(''); } catch {}
                try { router.push(next); } catch {}
              }
            }
          }, 900);
        }}
        phone={smsModal.phone}
        messageText={smsModal.text}
      />

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

      {clientMatchPrompt?.open ? (
        <div className="wiz-backdrop" onClick={() => setClientMatchPrompt({ open: false, reason: '', matchKey: '', candidate: null, phoneDigits: '', fullName: '' })}>
          <div className="apple-sheet compact" onClick={(e) => e.stopPropagation()}>
            <div className="apple-sheet-top">
              <div>
                <div className="apple-sheet-title">KLIENT EKZISTUES U GJET</div>
                <div className="apple-sheet-sub">{clientMatchPrompt?.reason === 'phone_exact' ? 'MATCH SIPAS TELEFONIT' : 'MATCH SIPAS EMRIT DHE MBIEMRIT'}</div>
              </div>
              <button type="button" className="apple-close" onClick={() => setClientMatchPrompt({ open: false, reason: '', matchKey: '', candidate: null, phoneDigits: '', fullName: '' })}>✕</button>
            </div>

            <div className="apple-sheet-body">
              <div className="client-selected-card" style={{ marginTop: 0 }}>
                <div className="client-selected-main">
                  {clientMatchPrompt?.candidate?.photo_url ? (
                    <img src={clientMatchPrompt.candidate.photo_url} alt="" className="client-mini large" />
                  ) : (
                    <div className="client-avatar-fallback">👤</div>
                  )}
                  <div>
                    <div className="client-selected-name">{String(clientMatchPrompt?.candidate?.name || 'PA EMËR').toUpperCase()}</div>
                    <div className="client-selected-phone">{phonePrefix} {String(normalizeMatchPhone(clientMatchPrompt?.candidate?.phone || '')) || '—'} • KODI {String(clientMatchPrompt?.candidate?.code || '—')}</div>
                  </div>
                </div>
              </div>

              <div className="client-empty-state" style={{ marginTop: 12, textAlign: 'left' }}>
                {clientMatchPrompt?.reason === 'phone_exact'
                  ? 'Ky numër telefoni ekziston në databazë. Zgjidh si don me vazhdu.'
                  : 'Ky emër dhe mbiemër ekziston në databazë. Verifiko telefonin dhe zgjedh mënyrën e vazhdimit.'}
              </div>
            </div>

            <div className="apple-sheet-actions" style={{ gridTemplateColumns: '1fr' }}>
              <button type="button" className="btn primary" onClick={() => applyClientMatchChoice('new_order_same_client')}>POROSI E RE PËR KËTË KLIENT</button>
              <button type="button" className="btn secondary" onClick={() => applyClientMatchChoice('existing_client')}>PËRDOR KLIENTIN EKZISTUES</button>
              <button type="button" className="btn" onClick={() => applyClientMatchChoice('create_new_anyway')}>KRIJO KLIENT TË RI GJITHSESI</button>
            </div>
          </div>
        </div>
      ) : null}

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
                <input className="input apple-search-input" id="clientSearchInput" value={clientQuery} onFocus={() => { void ensureClientsIndexLoaded(); }} onChange={(e) => setClientQuery(e.target.value)} placeholder="p.sh. 98 / arben / 045..." />
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
                        if (c.photo_url) setClientPhotoUrl(String(c.photo_url || ''));
                        setSelectedClient({
                          id: c?.id || null,
                          code: c?.code || '',
                          name: c?.name || '',
                          phone: c?.phone || '',
                        });
                        const nextPhone = String(c.phone || '').replace(/\D/g, '');
                      setPhone(nextPhone);
                      setNoPhone(!nextPhone);
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
                  <input className="input small" value={phonePrefix} readOnly disabled={noPhone} />
                  <input className="input" value={noPhone ? '' : phone} onChange={(e) => { const digits = String(e.target.value || '').replace(/\D+/g, ''); setPhone(digits); if (digits) setNoPhone(false); }} inputMode="numeric" placeholder={noPhone ? 'PA NUMËR' : '44XXXXXX'} disabled={noPhone} />
                </div>
                <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    className={`btn secondary ${noPhone ? 'active' : ''}`}
                    onClick={() => {
                      if (noPhone) {
                        setNoPhone(false);
                      } else {
                        setNoPhone(true);
                        setPhone('');
                        setSelectedClient(null);
                        setOldClientDebt(0);
                        setClientMatchPrompt({ open: false, reason: '', matchKey: '', candidate: null, phoneDigits: '', fullName: '' });
                      }
                    }}
                  >
                    {noPhone ? 'PA NUMËR ✓' : 'PA NUMËR'}
                  </button>
                  <div style={{ alignSelf: 'center', fontSize: 12, color: 'rgba(255,255,255,0.68)', fontWeight: 700 }}>RUAJE KLIENTIN PA NUMËR REAL</div>
                </div>
              </div>

              {oldClientDebt > 0 && <div style={{ marginTop:8, padding:'10px 12px', borderRadius:12, background:'rgba(239,68,68,0.16)', border:'1px solid rgba(239,68,68,0.35)', color:'#fecaca', fontWeight:900, fontSize:12 }}>⚠️ KUJDES: KY KLIENT KA {oldClientDebt.toFixed(2)}€ BORXH TË VJETËR!</div>}
            </div>

            <div className="apple-sheet-actions">
              <button type="button" className="btn secondary" onClick={closeWizard}>ANULO</button>
              <button type="button" className="btn" onClick={saveClientFromWizard}>RUAJ KLIENTIN</button>
            </div>
          </div>
        </div>
      ) : null}

      <style jsx>{`

        .client-toolbar{ display:flex; gap:10px; margin-top:8px; }
        .pranim-top-header{ display:grid; grid-template-columns:minmax(0,1fr) auto minmax(0,1fr); align-items:start; column-gap:12px; }
        .pranim-top-left{ min-width:0; }
        .pranim-top-code-wrap{ justify-self:center; align-self:start; display:flex; align-items:center; justify-content:center; }
        .pranim-top-offline{ justify-self:end; min-width:0; }
        .pranim-top-code-badge{ min-width:110px; min-height:58px; padding:0 20px; border-radius:22px; display:flex; align-items:center; justify-content:center; text-align:center; font-size:30px; line-height:1; font-weight:1000; letter-spacing:.01em; color:#f7fff9; text-shadow:0 2px 10px rgba(0,0,0,0.28); box-shadow:0 10px 24px rgba(18,169,90,0.22); }
        @media (max-width: 640px){ .pranim-top-header{ grid-template-columns:minmax(0,1fr) auto minmax(0,1fr); column-gap:8px; } .pranim-top-code-badge{ min-width:108px; min-height:56px; padding:0 18px; font-size:28px; border-radius:20px; } }
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

        .rbtn{
          width:100%;
          min-height:46px;
          border-radius:16px;
          border:none;
          outline:none;
          display:flex;
          align-items:center;
          justify-content:center;
          text-align:center;
          font-size:14px;
          font-weight:900;
          letter-spacing:.2px;
          color:#ffffff;
          -webkit-appearance:none;
          appearance:none;
          -webkit-tap-highlight-color: transparent;
          transition:transform .14s ease, box-shadow .18s ease, filter .18s ease, opacity .18s ease;
          position:relative;
          overflow:hidden;
        }
        .rbtn::before{
          content:'';
          position:absolute;
          inset:1px;
          border-radius:15px;
          background:linear-gradient(180deg, rgba(255,255,255,.18), rgba(255,255,255,.03));
          pointer-events:none;
        }
        .rbtn.add{
          background:linear-gradient(180deg, #39d98a 0%, #26c66f 55%, #18a957 100%) !important;
          box-shadow:
            inset 0 1px 0 rgba(255,255,255,.18),
            0 6px 16px rgba(24,169,87,.18),
            0 0 0 1px rgba(97,230,155,.10) !important;
        }
        .rbtn.remove{
          background:linear-gradient(180deg, #ff8a80 0%, #ff6b61 55%, #f04438 100%) !important;
          box-shadow:
            inset 0 1px 0 rgba(255,255,255,.16),
            0 6px 16px rgba(240,68,56,.16),
            0 0 0 1px rgba(255,138,128,.10) !important;
        }
        .rbtn:hover{
          filter:brightness(1.02);
        }
        .rbtn:active{
          transform:scale(.97);
        }

        .client-copy-topline{
          display:flex;
          align-items:center;
          justify-content:space-between;
          gap:10px;
          margin-bottom:6px;
        }
        .client-inline-edit{
          min-width:38px;
          height:38px;
          padding:0 12px;
          border-radius:999px;
          border:1.5px solid rgba(255,255,255,.16);
          background:rgba(59,130,246,.14);
          color:#eaf2ff;
          font-size:20px;
          font-weight:900;
          line-height:1;
          display:flex;
          align-items:center;
          justify-content:center;
          box-shadow:0 8px 18px rgba(37,99,235,.18);
          -webkit-tap-highlight-color: transparent;
          flex-shrink:0;
        }
        .client-inline-edit:active{
          transform:scale(.96);
        }
      `}</style>
    </div>
  );
}
