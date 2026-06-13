"use client";

import {
  normalizeCode,
  reserveSharedCode,
  ensureBasePool,
  ensureUniqueBaseCodeForSave,
  markCodeUsed,
  releaseLocksForCode,
  holdBaseCodeForDraft,
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

const TEPIHA_CHIPS = [1.0, 1.2, 1.5, 1.8, 2.0, 2.1, 2.2, 2.5, 2.8, 3.0, 3.2, 3.5, 3.7, 4.0, 4.5, 5.0, 5.8, 6.0, 8.0, 10.0, 12.0];
const STAZA_CHIPS = [0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.2, 1.5, 1.6, 1.8, 2.0, 2.2, 2.4, 2.5, 2.8, 3.0, 3.5, 4.0, 4.5, 5.0, 6.0];

const SHKALLORE_QTY_CHIPS = [5, 8, 10, 12, 13, 14, 15, 16, 17, 18, 20, 25, 30];
const SHKALLORE_PER_CHIPS = [0.25, 0.3, 0.35, 0.4, 0.45, 0.5];

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
const PRANIMI_DRAFT_ORDER_SELECT = 'id,status,local_oid,code,client_name,client_phone,updated_at,created_at,data';
const PRANIMI_DRAFT_LIKE_STATUSES = new Set([
  'draft',
  'incomplete',
  'paplotesuar',
  'pa_plotesuar',
  'pa_plotsuar',
  'e_paplotesuar',
  'e_pa_plotesuar',
  'e_pa_plotsuar',
  'te_paplotesuara',
  'te_pa_plotesuara',
  'te_pa_plotsuara',
  'local_draft',
  'pending_draft',
]);
const LOCK_MINUTES_AFTER_INFO = 60 * 24 * 365 * 10;
const PASRTRIMI_EDIT_TO_PRANIMI_KEY = 'tepiha_pastrim_edit_to_pranimi_v1';
const PASRTRIMI_EDIT_TO_PRANIMI_BACKUP_KEY = 'tepiha_pastrim_edit_to_pranimi_backup_v1';
const GATI_EDIT_TO_PRANIMI_KEY = 'tepiha_gati_edit_to_pranimi_v1';
const GATI_EDIT_TO_PRANIMI_BACKUP_KEY = 'tepiha_gati_edit_to_pranimi_backup_v1';
const PRANIMI_ACTIVE_EDIT_BRIDGE_KEY = 'tepiha_pranimi_active_edit_bridge_v1';
const CURRENT_SESSION_KEY = 'tepiha_pranimi_current_session_v1';
const CURRENT_SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const PRANIMI_BLANK_DRAFT_RELEASE_MS = 60 * 60 * 1000;
const PRANIMI_DRAFT_RESERVATION_PREFIX = 'pranimi_draft_reservation:';
const PRANIMI_BG_META_TIMEOUT_MS = 2500;
const PRANIMI_BG_POOL_TIMEOUT_MS = 3000;
const PRANIMI_BG_SYNC_MIN_GAP_MS = 6000;
const PRANIMI_DB_DRAFT_SAVE_TIMEOUT_MS = 5000;
const PRANIMI_DB_DRAFT_VERIFY_TIMEOUT_MS = 3500;
const PRANIMI_DB_DRAFT_STATUS = 'incomplete';
const PRANIMI_DB_DRAFT_FALLBACK_TOP_STATUS = 'pranim';
const PRANIMI_CONTINUE_CLIENT_LOOKUP_MS = 1000;
const PRANIMI_DRAFT_GUARD_VERSION = 'v8_db_draft_api_backed_2026_06_05';
const PRANIMI_TEPAPLOTESUARA_UI_GUARD_VERSION = 'tepaplotesuara-v8-db-api-guarded-before-render';
const PRANIMI_CONTINUE_CODE_VERIFY_MS = 350;
const PRANIMI_CONTINUE_CODE_RESERVE_MS = 650;
const PRANIMI_CONTINUE_MASTER_SYNC_MS = 1000;
const PRANIMI_CONTINUE_ORDER_SAVE_MS = 5500;
const PRANIMI_CONTINUE_ORDER_LINK_MS = 3500;

function sanitizePhone(phone) {
  return String(phone || '').replace(/\D+/g, '');
}

function normalizeKosovoPhone(raw, prefix = '+383') {
  const digits = normalizeMatchPhone(raw);
  if (!digits) return '';
  return `${prefix}${digits}`;
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

function appendPranimiCodeDebug(event, payload = {}) {
  try {
    if (typeof window === 'undefined') return;
    const key = 'tepiha_debug_log_v1';
    const current = JSON.parse(window.localStorage.getItem(key) || '[]');
    const arr = Array.isArray(current) ? current : [];
    arr.unshift({
      ts: new Date().toISOString(),
      event: String(event || 'pranimi_code_lifecycle'),
      ...(payload && typeof payload === 'object' ? payload : {}),
    });
    window.localStorage.setItem(key, JSON.stringify(arr.slice(0, 500)));
  } catch {}
}

function makePranimiLocalOid() {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  } catch {}
  return `ord_${Date.now()}_${Math.random().toString(16).slice(2)}`;
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

function isNoPhonePlaceholder(phone) {
  const text = String(phone || '').trim().replace(/\s+/g, ' ').toUpperCase();
  return /^PA NUM(?:E|Ë)R \d+$/.test(text);
}

function buildNoPhonePlaceholderPhone(code) {
  const n = normalizeCode(code);
  const codeText = n != null ? String(n).trim() : String(code || '').replace(/\D+/g, '').trim();
  return codeText ? `PA NUMER ${codeText}` : '';
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

function isSameCodeAsCurrentPranimiDraft(candidate = {}, currentCode = null) {
  const candidateCode = normalizeCode(candidate?.code ?? candidate?.client_code ?? null);
  const activeCode = normalizeCode(currentCode ?? null);
  return candidateCode != null && activeCode != null && String(candidateCode) === String(activeCode);
}

function buildClientMatchKey({ reason, phoneDigits, fullName, code, id }) {
  const codeKey = String(normalizeCode(code) || '').trim() || String(id || '').trim() || 'na';
  if (reason === 'phone_exact') return `phone:${String(phoneDigits || '').trim()}:client:${codeKey}`;
  return `name:${String(fullName || '').trim()}:client:${codeKey}`;
}

async function detectExistingClientSmart({ name, phone, clientsIndex, allowLive = true, liveTimeoutMs = 700, currentCode = null } = {}) {
  const phoneDigits = normalizeMatchPhone(phone);
  const fullName = normalizeMatchName(name);
  const fullNameParts = fullName ? fullName.split(' ').filter(Boolean) : [];
  const canCheckPhone = isValidClientPhoneDigits(phoneDigits);
  const canCheckFullName = fullNameParts.length >= 2;
  if (!canCheckPhone) return null;

  const seen = new Map();
  const addCandidate = (row = {}) => {
    const codeVal = normalizeCode(row?.code ?? row?.client_code ?? null);
    if (isSameCodeAsCurrentPranimiDraft({ code: codeVal }, currentCode)) return;
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

function extractPranimiSyncSafety(payload = {}, fallback = {}) {
  const data = (payload?.data && typeof payload.data === 'object') ? payload.data : {};
  const life = (data?.pranimi_code_lifecycle && typeof data.pranimi_code_lifecycle === 'object') ? data.pranimi_code_lifecycle : {};
  const client = (data?.client && typeof data.client === 'object') ? data.client : {};
  return {
    local_oid: String(life?.local_oid || data?.local_oid || payload?.local_oid || fallback?.local_oid || fallback?.id || '').trim(),
    save_attempt_id: String(life?.save_attempt_id || data?.save_attempt_id || payload?.save_attempt_id || fallback?.save_attempt_id || '').trim(),
    outbox_op_id: String(life?.outbox_op_id || life?.op_id || data?.outbox_op_id || payload?.outbox_op_id || fallback?.outbox_op_id || fallback?.op_id || '').trim(),
    code: payload?.code || data?.code || life?.final_code || client?.code || fallback?.code || '',
    client_name: payload?.client_name || data?.client_name || client?.name || fallback?.client_name || '',
    client_phone: payload?.client_phone || data?.client_phone || client?.phone || fallback?.client_phone || '',
  };
}

async function findBaseOrderByLocalOidAny(localOid = '', selectCols = 'id,local_oid,code,status,client_name,client_phone,price_total,m2_total,pieces,paid_cash,is_paid_upfront,updated_at,data') {
  const oid = String(localOid || '').trim();
  if (!oid) return null;

  async function tryQuery(label, apply) {
    try {
      const base = supabase.from('orders').select(selectCols);
      const query = apply(base);
      const { data, error } = await query.order('updated_at', { ascending: false }).limit(1).maybeSingle();
      if (!error && data) return { found: true, row: data, via: label };
    } catch {}
    return null;
  }

  const checks = [
    ['local_oid', (q) => q.eq('local_oid', oid)],
    ['data_local_oid', (q) => q.filter('data->>local_oid', 'eq', oid)],
    ['pranimi_lifecycle_local_oid', (q) => q.filter('data->pranimi_code_lifecycle->>local_oid', 'eq', oid)],
    ['draft_lifecycle_local_oid', (q) => q.filter('data->draft_lifecycle->>local_oid', 'eq', oid)],
  ];

  for (const [label, apply] of checks) {
    const found = await tryQuery(label, apply);
    if (found) return found;
  }
  return null;
}

async function verifyBaseOrderInDbBySafetyIds(payload = {}, fallback = {}) {
  const ids = extractPranimiSyncSafety(payload, fallback);
  const selectCols = 'id,local_oid,code,status,client_name,client_phone,price_total,m2_total,pieces,paid_cash,is_paid_upfront,updated_at,data';

  async function tryQuery(label, apply) {
    try {
      const base = supabase.from('orders').select(selectCols);
      const query = apply(base);
      const { data, error } = await query.maybeSingle();
      if (!error && data) return { found: true, row: data, via: label, ids };
    } catch {}
    return null;
  }

  if (ids.local_oid) {
    const found = await findBaseOrderByLocalOidAny(ids.local_oid, selectCols);
    if (found?.row) return { found: true, row: found.row, via: found.via || 'local_oid_any', ids };
  }

  if (ids.save_attempt_id) {
    const found = await tryQuery('save_attempt_id', (q) => q.filter('data->pranimi_code_lifecycle->>save_attempt_id', 'eq', ids.save_attempt_id));
    if (found) return found;
  }

  // Fallback is debug-only: never treat code/phone/name alone as a verified success.
  return { found: false, row: null, via: '', ids };
}

function readVerifiedBaseOrderCode(row = {}) {
  const data = (row?.data && typeof row.data === 'object') ? row.data : {};
  const client = (data?.client && typeof data.client === 'object') ? data.client : {};
  const life = (data?.pranimi_code_lifecycle && typeof data.pranimi_code_lifecycle === 'object') ? data.pranimi_code_lifecycle : {};
  return String(normalizeCode(row?.code ?? row?.client_code ?? data?.code ?? data?.client_code ?? client?.code ?? life?.final_code ?? '') || '').trim();
}

function readVerifiedBaseOrderLocalOid(row = {}) {
  const data = (row?.data && typeof row.data === 'object') ? row.data : {};
  const life = (data?.pranimi_code_lifecycle && typeof data.pranimi_code_lifecycle === 'object') ? data.pranimi_code_lifecycle : {};
  return String(row?.local_oid || data?.local_oid || life?.local_oid || '').trim();
}


function readSessionReservedBaseCode(localOid = '') {
  const oid = String(localOid || '').trim();
  if (!oid || typeof window === 'undefined') return null;
  try {
    return normalizeCode(window.localStorage?.getItem(`base_order_code:${oid}`));
  } catch {
    return null;
  }
}

function draftReservationKey(localOid = '') {
  const id = String(localOid || '').trim();
  return id ? `${PRANIMI_DRAFT_RESERVATION_PREFIX}${id}` : '';
}

function readDraftReservationLocal(localOid = '') {
  try {
    const key = draftReservationKey(localOid);
    if (!key || typeof window === 'undefined') return null;
    const parsed = safeJsonParse(window.localStorage?.getItem(key) || 'null', null);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function writeDraftReservationLocal(meta = {}) {
  try {
    const id = String(meta?.local_oid || meta?.id || '').trim();
    if (!id || typeof window === 'undefined') return null;
    const prev = readDraftReservationLocal(id) || {};
    const now = Date.now();
    const next = {
      ...prev,
      local_oid: id,
      draft_id: id,
      code: normalizeCode(meta?.code ?? prev?.code ?? null),
      created_by_pin: String(meta?.created_by_pin || prev?.created_by_pin || '').trim(),
      created_at: Number(meta?.created_at || prev?.created_at || now),
      created_at_iso: String(meta?.created_at_iso || prev?.created_at_iso || new Date(Number(meta?.created_at || prev?.created_at || now)).toISOString()),
      last_activity_at: Number(meta?.last_activity_at || now),
      last_activity_at_iso: String(meta?.last_activity_at_iso || new Date(Number(meta?.last_activity_at || now)).toISOString()),
      has_meaningful_work: !!meta?.has_meaningful_work,
      reason: String(meta?.reason || prev?.reason || 'pranimi_draft_reservation'),
    };
    window.localStorage.setItem(draftReservationKey(id), JSON.stringify(next));
    return next;
  } catch {
    return null;
  }
}

function removeDraftReservationLocal(localOid = '') {
  try {
    const key = draftReservationKey(localOid);
    if (key && typeof window !== 'undefined') window.localStorage?.removeItem(key);
  } catch {}
}

function listDraftReservationsLocal() {
  const out = [];
  try {
    if (typeof window === 'undefined' || !window.localStorage) return out;
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      if (!key || !key.startsWith(PRANIMI_DRAFT_RESERVATION_PREFIX)) continue;
      const parsed = safeJsonParse(window.localStorage.getItem(key) || 'null', null);
      if (parsed && typeof parsed === 'object') out.push(parsed);
    }
  } catch {}
  return out;
}

function getDraftCreatedAt(localOid = '') {
  const meta = readDraftReservationLocal(localOid);
  return Number(meta?.created_at || 0) || Date.now();
}

function readPranimiBaseOrderData(row = {}) {
  return (row?.data && typeof row.data === 'object') ? row.data : {};
}

function readPranimiBaseOrderStatus(row = {}) {
  const data = readPranimiBaseOrderData(row);
  return String(row?.status || data?.status || '').trim();
}

function readPranimiBaseOrderDataStatus(row = {}) {
  const data = readPranimiBaseOrderData(row);
  return String(data?.status || '').trim();
}

function readPranimiBaseOrderPhone(row = {}) {
  const data = readPranimiBaseOrderData(row);
  const client = (data?.client && typeof data.client === 'object') ? data.client : {};
  return String(row?.client_phone || data?.client_phone || client?.phone || '').trim();
}

function readPranimiBaseOrderClientName(row = {}) {
  const data = readPranimiBaseOrderData(row);
  const client = (data?.client && typeof data.client === 'object') ? data.client : {};
  return String(row?.client_name || data?.client_name || client?.name || '').trim();
}

function readPranimiBaseOrderNumber(row = {}, key = '') {
  const data = readPranimiBaseOrderData(row);
  const pay = (data?.pay && typeof data.pay === 'object') ? data.pay : {};
  const client = (data?.client && typeof data.client === 'object') ? data.client : {};
  const value = row?.[key] ?? data?.[key] ?? (key === 'm2_total' ? pay?.m2 : undefined) ?? (key === 'price_total' ? pay?.euro : undefined) ?? client?.[key];
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function nearlySameNumber(a, b, tolerance = 0.01) {
  const an = Number(a);
  const bn = Number(b);
  if (!Number.isFinite(an) || !Number.isFinite(bn)) return false;
  return Math.abs(an - bn) <= tolerance;
}

function assertBaseOrderReservationMatch(row = {}, expected = {}) {
  const data = readPranimiBaseOrderData(row);
  const expectedCode = String(normalizeCode(expected?.code || '') || '').trim();
  const expectedLocalOid = String(expected?.local_oid || '').trim();
  const expectedPhone = normalizeMatchPhone(expected?.client_phone || '');
  const expectedStatus = String(expected?.status || expected?.data_status || '').trim();
  const expectedName = String(expected?.client_name || '').trim().replace(/\s+/g, ' ').toLowerCase();
  const dbCode = readVerifiedBaseOrderCode(row);
  const dbLocalOid = readVerifiedBaseOrderLocalOid(row);
  const serverId = String(row?.id || '').trim();
  const dbPhone = normalizeMatchPhone(readPranimiBaseOrderPhone(row));
  const dbStatus = readPranimiBaseOrderStatus(row);
  const dbDataStatus = readPranimiBaseOrderDataStatus(row);
  const dbName = readPranimiBaseOrderClientName(row).replace(/\s+/g, ' ').toLowerCase();

  if (!serverId) {
    return { ok: false, reason: 'MISSING_SERVER_ID', expectedCode, dbCode, expectedLocalOid, dbLocalOid, serverId };
  }
  if (!dbLocalOid) {
    return { ok: false, reason: 'MISSING_LOCAL_OID', expectedCode, dbCode, expectedLocalOid, dbLocalOid, serverId };
  }
  if (expectedCode && dbCode && dbCode !== expectedCode) {
    return {
      ok: false,
      reason: 'CODE_MISMATCH',
      expectedCode,
      dbCode,
      expectedLocalOid,
      dbLocalOid,
      serverId,
    };
  }
  if (expectedCode && !dbCode) {
    return { ok: false, reason: 'MISSING_CODE', expectedCode, dbCode, expectedLocalOid, dbLocalOid, serverId };
  }
  if (expectedLocalOid && dbLocalOid && dbLocalOid !== expectedLocalOid) {
    return {
      ok: false,
      reason: 'LOCAL_OID_MISMATCH',
      expectedCode,
      dbCode,
      expectedLocalOid,
      dbLocalOid,
      serverId,
    };
  }
  if (expectedPhone && (!dbPhone || dbPhone !== expectedPhone)) {
    return { ok: false, reason: 'CLIENT_PHONE_MISMATCH', expectedPhone, dbPhone, expectedCode, dbCode, expectedLocalOid, dbLocalOid, serverId };
  }
  if (expectedName && !dbName) {
    return { ok: false, reason: 'MISSING_CLIENT_NAME', expectedName, dbName, expectedCode, dbCode, expectedLocalOid, dbLocalOid, serverId };
  }
  if (expectedStatus && dbStatus && dbStatus !== expectedStatus) {
    return { ok: false, reason: 'STATUS_MISMATCH', expectedStatus, dbStatus, dbDataStatus, expectedCode, dbCode, expectedLocalOid, dbLocalOid, serverId };
  }
  if (expectedStatus && !dbStatus) {
    return { ok: false, reason: 'MISSING_STATUS', expectedStatus, dbStatus, dbDataStatus, expectedCode, dbCode, expectedLocalOid, dbLocalOid, serverId };
  }
  if (expectedStatus && dbDataStatus && dbDataStatus !== expectedStatus) {
    return { ok: false, reason: 'DATA_STATUS_MISMATCH', expectedStatus, dbStatus, dbDataStatus, expectedCode, dbCode, expectedLocalOid, dbLocalOid, serverId };
  }
  if (expectedStatus && !dbDataStatus) {
    return { ok: false, reason: 'MISSING_DATA_STATUS', expectedStatus, dbStatus, dbDataStatus, expectedCode, dbCode, expectedLocalOid, dbLocalOid, serverId };
  }

  const expectedPieces = Number(expected?.pieces || 0);
  if (expectedPieces > 0) {
    const dbPieces = readPranimiBaseOrderNumber(row, 'pieces');
    if (dbPieces == null || Number(dbPieces) !== expectedPieces) return { ok: false, reason: 'PIECES_MISMATCH', expectedPieces, dbPieces, expectedCode, dbCode, expectedLocalOid, dbLocalOid, serverId };
  }

  const expectedM2 = Number(expected?.m2_total || 0);
  if (expectedM2 > 0) {
    const dbM2 = readPranimiBaseOrderNumber(row, 'm2_total');
    if (dbM2 == null || !nearlySameNumber(dbM2, expectedM2, 0.01)) return { ok: false, reason: 'M2_TOTAL_MISMATCH', expectedM2, dbM2, expectedCode, dbCode, expectedLocalOid, dbLocalOid, serverId };
  }

  const expectedPrice = Number(expected?.price_total || 0);
  if (expectedPrice > 0) {
    const dbPrice = readPranimiBaseOrderNumber(row, 'price_total');
    if (dbPrice == null || !nearlySameNumber(dbPrice, expectedPrice, 0.01)) return { ok: false, reason: 'PRICE_TOTAL_MISMATCH', expectedPrice, dbPrice, expectedCode, dbCode, expectedLocalOid, dbLocalOid, serverId };
  }

  return { ok: true, expectedCode, dbCode, expectedLocalOid, dbLocalOid, serverId, dbStatus, dbDataStatus, dbPhone, data };
}


async function releaseExistingClientTempCodeAfterVerifiedSave({ tempCode, finalCode, localOid, reason = 'EXISTING_CLIENT_TEMP_CODE_RELEASE' } = {}) {
  const temp = normalizeCode(tempCode ?? null);
  const final = normalizeCode(finalCode ?? null);
  if (temp == null) return { ok: true, skipped: true, reason: 'NO_TEMP_CODE' };
  if (final != null && String(temp) === String(final)) return { ok: true, skipped: true, reason: 'TEMP_EQUALS_FINAL_CODE' };

  const localOidText = String(localOid || '').trim();
  const placeholderPhone = buildNoPhonePlaceholderPhone(temp);

  const log = (event, extra = {}) => {
    try {
      appendPranimiCodeDebug(event, {
        temp_code: temp,
        final_code: final,
        local_oid: localOidText || null,
        reason,
        ...extra,
      });
    } catch {}
  };

  try {
    // Server-side cleanup is required because placeholder clients may be created by DB triggers
    // while draft autosave runs, and frontend delete can be blocked by RLS. The RPC verifies
    // the final existing-client order by local_oid + final_code before touching temp artifacts.
    try {
      const { data: rpcData, error: rpcError } = await supabase.rpc('cleanup_existing_client_temp_code_after_verify', {
        p_temp_code: temp,
        p_final_code: final,
        p_local_oid: localOidText || null,
      });

      if (rpcError) {
        const msg = String(rpcError?.message || '');
        const code = String(rpcError?.code || '');
        const missingRpc = code === '42883' || msg.toLowerCase().includes('cleanup_existing_client_temp_code_after_verify');
        log('existing_client_temp_code_release_rpc_error', {
          dbcode: code || null,
          message: msg || null,
          missing_rpc: missingRpc,
        });
        if (!missingRpc) {
          return { ok: false, skipped: true, reason: 'RPC_ERROR', error: rpcError };
        }
        // Development fallback only when the RPC has not been installed yet; production deploys SQL first.
      } else {
        log('existing_client_temp_code_release_rpc_result', { result: rpcData || null });
        if (!rpcData || rpcData.ok !== true) {
          return { ok: false, skipped: true, reason: rpcData?.reason || 'RPC_REFUSED', rpc_result: rpcData || null };
        }
        return { ok: true, released: !!rpcData.released_pool, temp_code: temp, final_code: final, rpc_result: rpcData };
      }
    } catch (rpcThrow) {
      log('existing_client_temp_code_release_rpc_throw', { error: String(rpcThrow?.message || rpcThrow || '') });
      return { ok: false, skipped: true, reason: 'RPC_THROW', error: rpcThrow };
    }

    // Fallback path is kept only for old environments without the RPC.
    // If a real order uses the temporary code, do not release or delete anything.
    const { data: orderRows, error: orderErr } = await supabase
      .from('orders')
      .select('id, code, client_id, status, client_name, client_phone, data')
      .eq('code', temp)
      .limit(5);
    if (orderErr) throw orderErr;
    if (Array.isArray(orderRows) && orderRows.length > 0) {
      log('existing_client_temp_code_release_skip_order_exists', { order_count: orderRows.length });
      return { ok: false, skipped: true, reason: 'ORDER_EXISTS_FOR_TEMP_CODE' };
    }

    // Remove only placeholder clients created by draft autosave for the temporary code.
    // Never touch a real client with a real phone/name.
    const { data: clients, error: clientsErr } = await supabase
      .from('clients')
      .select('id, code, name, full_name, first_name, last_name, phone')
      .eq('code', temp)
      .limit(10);
    if (clientsErr) throw clientsErr;

    const deletedClientIds = [];
    for (const c of Array.isArray(clients) ? clients : []) {
      const clientId = String(c?.id || '').trim();
      if (!clientId) continue;
      const phoneText = String(c?.phone || '').trim();
      const isPlaceholder = phoneText === placeholderPhone || isNoPhonePlaceholder(phoneText);
      if (!isPlaceholder) {
        log('existing_client_temp_code_release_skip_real_client', { client_id: clientId, phone: phoneText || null });
        return { ok: false, skipped: true, reason: 'REAL_CLIENT_EXISTS_FOR_TEMP_CODE' };
      }

      const linkedChecks = [
        supabase.from('orders').select('id').eq('client_id', clientId).limit(1),
        supabase.from('orders').select('id').filter('data->>client_master_id', 'eq', clientId).limit(1),
        supabase.from('orders').select('id').filter('data->client->>id', 'eq', clientId).limit(1),
      ];
      let linked = false;
      for (const check of linkedChecks) {
        try {
          const { data, error } = await check;
          if (!error && Array.isArray(data) && data.length > 0) {
            linked = true;
            break;
          }
        } catch {}
      }
      if (linked) {
        log('existing_client_temp_code_release_skip_client_linked', { client_id: clientId });
        return { ok: false, skipped: true, reason: 'PLACEHOLDER_CLIENT_LINKED_TO_ORDER' };
      }

      const { error: deleteErr } = await supabase.from('clients').delete().eq('id', clientId);
      if (deleteErr) throw deleteErr;
      deletedClientIds.push(clientId);
    }

    // Re-check after placeholder cleanup. If anything remains, leave the pool as-is.
    const { data: remainingClients, error: remainingErr } = await supabase
      .from('clients')
      .select('id, code, phone')
      .eq('code', temp)
      .limit(1);
    if (remainingErr) throw remainingErr;
    if (Array.isArray(remainingClients) && remainingClients.length > 0) {
      log('existing_client_temp_code_release_skip_remaining_client', { deleted_client_ids: deletedClientIds });
      return { ok: false, skipped: true, reason: 'CLIENT_STILL_EXISTS_FOR_TEMP_CODE', deleted_client_ids: deletedClientIds };
    }

    // Release with live-schema compatibility. Current live DB uses owner_id; some code branches use reserved_by.
    let released = false;
    let releaseError = null;
    try {
      const { error } = await supabase
        .from('base_code_pool')
        .update({ status: 'available', owner_id: '' })
        .eq('code', temp)
        .neq('status', 'used');
      if (error) throw error;
      released = true;
    } catch (error) {
      releaseError = error;
      try {
        const { error: fallbackErr } = await supabase
          .from('base_code_pool')
          .update({ status: 'available', reserved_by: null, reserved_at: null, lease_expires_at: null })
          .eq('code', temp)
          .neq('status', 'used');
        if (fallbackErr) throw fallbackErr;
        released = true;
        releaseError = null;
      } catch (fallbackError) {
        releaseError = fallbackError || releaseError;
      }
    }

    if (!released) {
      log('existing_client_temp_code_release_pool_failed', {
        deleted_client_ids: deletedClientIds,
        error: String(releaseError?.message || releaseError || ''),
      });
      return { ok: false, skipped: true, reason: 'POOL_RELEASE_FAILED', deleted_client_ids: deletedClientIds, error: releaseError };
    }

    try { clearOrderCodeCache(localOidText); } catch {}
    log('existing_client_temp_code_released_after_verified_save', { deleted_client_ids: deletedClientIds });
    return { ok: true, released: true, temp_code: temp, final_code: final, deleted_client_ids: deletedClientIds };
  } catch (error) {
    log('existing_client_temp_code_release_failed', { error: String(error?.message || error || '') });
    return { ok: false, skipped: true, reason: 'THROW', error };
  }
}

async function safeCleanupPranimiClientCreatedInThisFlow({ client, expected = {}, reason = 'ORDER_SAVE_FAILED' } = {}) {
  const clientId = String(client?.id || '').trim();
  const createdHere = !!(client?.createdInThisFlow || client?.created_in_this_flow || client?.insertedInThisFlow);
  if (!clientId || !createdHere) return { ok: false, skipped: true, reason: 'CLIENT_NOT_CREATED_IN_THIS_FLOW' };

  const expectedCode = normalizeCode(expected?.code ?? client?.code ?? null);
  const expectedPhone = normalizeMatchPhone(expected?.client_phone || expected?.phone || client?.phone || '');

  try {
    const { data: currentClient, error: clientErr } = await supabase
      .from('clients')
      .select('id, code, phone')
      .eq('id', clientId)
      .maybeSingle();
    if (clientErr) throw clientErr;
    if (!currentClient?.id) return { ok: true, skipped: true, reason: 'CLIENT_ALREADY_GONE' };

    const currentCode = normalizeCode(currentClient?.code ?? null);
    const currentPhone = normalizeMatchPhone(currentClient?.phone || '');
    if (expectedCode != null && currentCode != null && String(currentCode) !== String(expectedCode)) {
      return { ok: false, skipped: true, reason: 'CLIENT_CODE_CHANGED' };
    }
    if (expectedPhone && currentPhone && currentPhone !== expectedPhone) {
      return { ok: false, skipped: true, reason: 'CLIENT_PHONE_CHANGED' };
    }

    const linkedChecks = [];
    linkedChecks.push(supabase.from('orders').select('id').eq('client_id', clientId).limit(1));
    linkedChecks.push(supabase.from('orders').select('id').filter('data->>client_master_id', 'eq', clientId).limit(1));
    linkedChecks.push(supabase.from('orders').select('id').filter('data->client->>id', 'eq', clientId).limit(1));
    if (expectedCode != null) linkedChecks.push(supabase.from('orders').select('id').eq('code', expectedCode).limit(1));

    for (const check of linkedChecks) {
      try {
        const { data, error } = await check;
        if (error) continue;
        if (Array.isArray(data) && data.length > 0) return { ok: false, skipped: true, reason: 'CLIENT_HAS_ORDER_LINK' };
      } catch {}
    }

    const { error: deleteErr } = await supabase.from('clients').delete().eq('id', clientId);
    if (deleteErr) throw deleteErr;
    appendPranimiCodeDebug('client_cleanup_after_order_failure', {
      client_id: clientId,
      code: expectedCode ?? null,
      reason,
    });
    return { ok: true, deleted: true, client_id: clientId };
  } catch (error) {
    appendPranimiCodeDebug('client_cleanup_after_order_failure_failed', {
      client_id: clientId,
      code: expectedCode ?? null,
      reason,
      error: String(error?.message || error || ''),
    });
    return { ok: false, skipped: true, reason: 'CLEANUP_FAILED', error };
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
  const meaningful = snapshotHasMeaningfulWork(draft);
  if (!meaningful) return;
  const withMeta = {
    ...draft,
    has_meaningful_work: true,
    draft_lifecycle: {
      ...((draft?.draft_lifecycle && typeof draft.draft_lifecycle === 'object') ? draft.draft_lifecycle : {}),
      has_meaningful_work: true,
      last_activity_at: Date.now(),
    },
  };
  localStorage.setItem(`${DRAFT_ITEM_PREFIX}${draft.id}`, JSON.stringify(withMeta));
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
    if (String(d?.name || d?.client?.full_name || d?.client?.name || '').trim()) return true;
    if (normalizeMatchPhone(d?.phone || d?.client?.phone || '')) return true;
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
    if (!snapshotHasMeaningfulWork(draft)) return;
    const withMeta = {
      ...draft,
      has_meaningful_work: true,
      draft_lifecycle: {
        ...((draft?.draft_lifecycle && typeof draft.draft_lifecycle === 'object') ? draft.draft_lifecycle : {}),
        has_meaningful_work: true,
        last_activity_at: Date.now(),
      },
    };
    const blob = new Blob([JSON.stringify(withMeta)], { type: 'application/json' });
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

async function deleteDraftRemoteMany(ids = []) {
  try {
    const paths = Array.from(new Set((Array.isArray(ids) ? ids : [])
      .map((x) => String(x || '').replace(/\.json$/i, '').trim())
      .filter(Boolean)))
      .map((id) => `${DRAFTS_FOLDER}/${id}.json`);
    if (!paths.length) return false;
    await storageWithTimeout(
      supabase.storage.from(BUCKET).remove(paths),
      6500,
      'PRANIMI_DRAFT_MULTI_REMOVE_TIMEOUT',
      { bucket: BUCKET, paths }
    );
    return true;
  } catch {
    return false;
  }
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

function computePranimiDraftTotals(draft = {}) {
  let m2 = 0;
  try {
    const tepiha = Array.isArray(draft?.tepihaRows) ? draft.tepihaRows : (Array.isArray(draft?.tepiha) ? draft.tepiha : []);
    const staza = Array.isArray(draft?.stazaRows) ? draft.stazaRows : (Array.isArray(draft?.staza) ? draft.staza : []);
    tepiha.forEach((r) => { m2 += (Number(r?.m2) || 0) * (Number(r?.qty) || 0); });
    staza.forEach((r) => { m2 += (Number(r?.m2) || 0) * (Number(r?.qty) || 0); });
    const stairsQty = Number(draft?.stairsQty ?? draft?.shkallore?.qty ?? 0) || 0;
    const stairsPer = Number(draft?.stairsPer ?? draft?.shkallore?.per ?? 0) || 0;
    m2 += stairsQty * stairsPer;
  } catch {}
  const rate = Number(draft?.pricePerM2 ?? draft?.pay?.rate ?? PRICE_DEFAULT) || PRICE_DEFAULT;
  const euro = Number((m2 * rate).toFixed(2));
  const pieces = Number(
    draft?.pieces ??
    draft?.totals?.pieces ??
    (Array.isArray(draft?.tepihaRows) ? draft.tepihaRows.reduce((a, r) => a + (Number(r?.qty) || 0), 0) : 0) +
    (Array.isArray(draft?.stazaRows) ? draft.stazaRows.reduce((a, r) => a + (Number(r?.qty) || 0), 0) : 0) +
    (Number(draft?.stairsQty ?? draft?.shkallore?.qty ?? 0) || 0)
  ) || 0;
  return { m2, euro, pieces, rate };
}

function buildPranimiDbDraftRow(draft = {}, reason = 'draft_db_save') {
  const localOid = String(draft?.local_oid || draft?.draft_lifecycle?.local_oid || draft?.id || '').trim();
  const code = normalizeCode(
    draft?.codeRaw ??
    draft?.code ??
    draft?.draft_lifecycle?.code ??
    draft?.draft_lifecycle?.final_code ??
    draft?.client?.code ??
    null
  );
  if (!localOid || code == null || !snapshotHasMeaningfulWork(draft)) return null;

  const nowIso = new Date().toISOString();
  const canonicalPhone = String(draft?.client?.phone || draft?.phone || '').trim();
  const phoneDigits = normalizeMatchPhone(canonicalPhone);
  const clientName = String(draft?.name || draft?.client?.full_name || draft?.client?.name || '').trim();
  const totals = computePranimiDraftTotals(draft);
  const life = {
    ...((draft?.draft_lifecycle && typeof draft.draft_lifecycle === 'object') ? draft.draft_lifecycle : {}),
    code,
    local_oid: localOid,
    draft_id: localOid,
    has_meaningful_work: true,
    db_draft: true,
    db_draft_status: PRANIMI_DB_DRAFT_STATUS,
    db_draft_reason: reason,
    db_draft_saved_at: nowIso,
    last_activity_at: Date.now(),
    last_activity_at_iso: nowIso,
  };
  const data = {
    ...(draft && typeof draft === 'object' ? draft : {}),
    id: localOid,
    local_oid: localOid,
    status: PRANIMI_DB_DRAFT_STATUS,
    code,
    client_code: code,
    client_name: clientName || null,
    client_phone: canonicalPhone || '',
    phone_digits: phoneDigits || '',
    has_meaningful_work: true,
    is_pranimi_incomplete_draft: true,
    pranimi_db_draft: true,
    source: 'DB_DRAFT',
    updated_at: nowIso,
    pieces: totals.pieces,
    m2_total: totals.m2,
    price_total: totals.euro,
    note: draft?.notes || draft?.note || null,
    draft_lifecycle: life,
    pranimi_code_lifecycle: life,
    client: {
      ...((draft?.client && typeof draft.client === 'object') ? draft.client : {}),
      code,
      name: clientName || null,
      full_name: clientName || '',
      phone: canonicalPhone || '',
    },
  };
  return {
    local_oid: localOid,
    status: PRANIMI_DB_DRAFT_STATUS,
    code,
    client_code: code,
    client_name: clientName || null,
    client_phone: canonicalPhone || '',
    pieces: totals.pieces,
    m2_total: totals.m2,
    price_total: totals.euro,
    paid_cash: Number(draft?.clientPaid || draft?.arkaRecordedPaid || 0) || 0,
    is_paid_upfront: Number(draft?.clientPaid || draft?.arkaRecordedPaid || 0) > 0,
    note: draft?.notes || draft?.note || null,
    updated_at: nowIso,
    data,
  };
}


function isPranimiDbDraftFlaggedOrder(row = {}) {
  const data = readPlainObject(row?.data);
  const life = { ...readPlainObject(data?.pranimi_code_lifecycle), ...readPlainObject(data?.draft_lifecycle) };
  return data?.pranimi_db_draft === true
    || data?.is_pranimi_incomplete_draft === true
    || String(data?.source || data?.pranimi_draft_source || '').toUpperCase().includes('DB_DRAFT')
    || String(data?.source || data?.pranimi_draft_source || '').toUpperCase().includes('DB DRAFT')
    || life?.db_draft === true
    || String(life?.db_draft || '').toLowerCase() === 'true'
    || String(life?.db_draft_status || '').trim().toLowerCase() === PRANIMI_DB_DRAFT_STATUS;
}

function readPranimiDbDraftPreferredStatus(row = {}) {
  const data = readPlainObject(row?.data);
  const life = { ...readPlainObject(data?.pranimi_code_lifecycle), ...readPlainObject(data?.draft_lifecycle) };
  if (isPranimiDbDraftFlaggedOrder(row)) return String(data?.status || life?.db_draft_status || PRANIMI_DB_DRAFT_STATUS).trim();
  return String(row?.status || data?.status || data?.order_status || '').trim();
}

function buildPranimiDbDraftRowForTopStatus(row = {}, topStatus = PRANIMI_DB_DRAFT_STATUS) {
  const data = readPlainObject(row?.data);
  const life = { ...readPlainObject(data?.pranimi_code_lifecycle), ...readPlainObject(data?.draft_lifecycle) };
  return {
    ...(row || {}),
    status: String(topStatus || PRANIMI_DB_DRAFT_STATUS).trim(),
    data: {
      ...data,
      status: PRANIMI_DB_DRAFT_STATUS,
      is_pranimi_incomplete_draft: true,
      pranimi_db_draft: true,
      source: data?.source || 'DB_DRAFT',
      pranimi_draft_source: data?.pranimi_draft_source || 'DB DRAFT / SYNCED',
      pranimi_code_lifecycle: {
        ...life,
        db_draft: true,
        db_draft_status: PRANIMI_DB_DRAFT_STATUS,
      },
      draft_lifecycle: {
        ...readPlainObject(data?.draft_lifecycle),
        db_draft: true,
        db_draft_status: PRANIMI_DB_DRAFT_STATUS,
      },
    },
  };
}

async function savePranimiDbDraftViaApi(row = {}, reason = 'autosave_db_draft') {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  let timer = null;
  try {
    if (!row?.local_oid) return { ok: false, reason: 'NO_LOCAL_OID_FOR_API_DRAFT' };
    if (controller) timer = setTimeout(() => controller.abort(), 12000);
    const res = await fetch('/api/pranimi/draft', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      cache: 'no-store',
      signal: controller?.signal,
      body: JSON.stringify({ action: 'upsert', row, reason }),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json?.ok) return { ok: false, reason: json?.error || `API_STATUS_${res.status}`, status: res.status, details: json || null };
    return { ok: true, row: json?.row || null, verified: json?.verified !== false, via: json?.via || 'api' };
  } catch (error) {
    return { ok: false, reason: 'API_DRAFT_SAVE_FAILED', error };
  } finally {
    try { if (timer) clearTimeout(timer); } catch {}
  }
}

async function deletePranimiDbDraftViaApi(draft = {}) {
  const localOid = String(draft?.local_oid || draft?.draft_lifecycle?.local_oid || draft?.id || '').trim();
  const dbOrderId = String(draft?.db_order_id || draft?.server_id || '').trim();
  if (!localOid && !dbOrderId) return { ok: false, reason: 'NO_DRAFT_ID_FOR_API_DELETE' };
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  let timer = null;
  try {
    if (controller) timer = setTimeout(() => controller.abort(), 9000);
    const res = await fetch('/api/pranimi/draft', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      cache: 'no-store',
      signal: controller?.signal,
      body: JSON.stringify({ action: 'delete', local_oid: localOid, db_order_id: dbOrderId }),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json?.ok) return { ok: false, reason: json?.error || `API_STATUS_${res.status}`, status: res.status, details: json || null };
    return { ok: true, deleted: !!json?.deleted, row: json?.row || null };
  } catch (error) {
    return { ok: false, reason: 'API_DRAFT_DELETE_FAILED', error };
  } finally {
    try { if (timer) clearTimeout(timer); } catch {}
  }
}

async function verifyPranimiDbDraftSaved(draft = {}) {
  try {
    const localOid = String(draft?.local_oid || draft?.draft_lifecycle?.local_oid || draft?.id || '').trim();
    const code = normalizeCode(draft?.codeRaw ?? draft?.code ?? draft?.draft_lifecycle?.code ?? null);
    if (!localOid || code == null) return { ok: false, row: null, reason: 'MISSING_LOCAL_OID_OR_CODE' };
    const { data, error } = await withSupabaseTimeout(
      supabase.from('orders').select(PRANIMI_DRAFT_ORDER_SELECT).eq('local_oid', localOid).maybeSingle(),
      PRANIMI_DB_DRAFT_VERIFY_TIMEOUT_MS,
      'PRANIMI_DB_DRAFT_VERIFY_TIMEOUT',
      { source: 'verifyPranimiDbDraftSaved', local_oid: localOid, code }
    );
    if (error) throw error;
    const row = data || null;
    if (!row) return { ok: false, row: null, reason: 'DB_DRAFT_NOT_FOUND' };
    const rowCode = normalizeCode(row?.code ?? row?.data?.code ?? row?.data?.client?.code ?? null);
    const rowStatus = readPranimiDraftOrderStatus(row);
    if (String(rowCode) !== String(code)) return { ok: false, row, reason: 'DB_DRAFT_CODE_MISMATCH' };
    if (!isPranimiDraftLikeOrderStatus(rowStatus)) return { ok: false, row, reason: 'DB_ROW_NOT_DRAFT_STATUS' };
    return { ok: true, row, reason: 'DB_DRAFT_VERIFIED' };
  } catch (error) {
    return { ok: false, row: null, reason: String(error?.message || error || 'DB_DRAFT_VERIFY_FAILED') };
  }
}

async function upsertDraftDb(draft = {}, reason = 'autosave_db_draft') {
  try {
    if (!draft?.id || !snapshotHasMeaningfulWork(draft)) return false;
    const row = buildPranimiDbDraftRow(draft, reason);
    if (!row) return false;

    const block = await findBlockingOrderForDraftInDb({ ...draft, codeRaw: row.code, code: row.code }, { id: row.local_oid });
    if (block?.blocked) {
      appendPranimiCodeDebug('db_draft_save_blocked_by_existing_order', {
        local_oid: row.local_oid,
        code: row.code,
        order_id: block?.row?.id || null,
        order_status: readPranimiDraftOrderStatus(block?.row || {}),
        match_type: block?.match_type || null,
        reason,
      });
      return false;
    }

    // Primary path: server API with service client. This avoids the client-side
    // RLS/status-policy failure that prevented shared DB drafts from saving.
    const apiSave = await savePranimiDbDraftViaApi(row, reason);
    if (apiSave?.ok && apiSave?.verified !== false && apiSave?.row) {
      appendPranimiCodeDebug('db_draft_api_saved_verified', {
        local_oid: row.local_oid,
        code: row.code,
        order_id: apiSave?.row?.id || null,
        status: readPranimiDraftOrderStatus(apiSave?.row || {}),
        via: apiSave?.via || 'api',
        reason,
      });
      return true;
    }

    appendPranimiCodeDebug('db_draft_api_failed_fallback_direct', {
      local_oid: row.local_oid,
      code: row.code,
      api_reason: apiSave?.reason || null,
      api_status: apiSave?.status || null,
      reason,
    });

    let primaryError = null;
    try {
      await withSupabaseTimeout(
        upsertOrderRecord('orders', buildPranimiDbDraftRowForTopStatus(row, PRANIMI_DB_DRAFT_STATUS), { onConflict: 'local_oid' }),
        9000,
        'PRANIMI_DB_DRAFT_UPSERT_TIMEOUT',
        { source: 'upsertDraftDb:directIncomplete', local_oid: row.local_oid, code: row.code, reason }
      );
    } catch (error) {
      primaryError = error;
      appendPranimiCodeDebug('db_draft_direct_incomplete_failed_try_pranim', {
        local_oid: row.local_oid,
        code: row.code,
        error: String(error?.message || error || ''),
        reason,
      });
      await withSupabaseTimeout(
        upsertOrderRecord('orders', buildPranimiDbDraftRowForTopStatus(row, PRANIMI_DB_DRAFT_FALLBACK_TOP_STATUS), { onConflict: 'local_oid' }),
        9000,
        'PRANIMI_DB_DRAFT_UPSERT_FALLBACK_TIMEOUT',
        { source: 'upsertDraftDb:directPranimFallback', local_oid: row.local_oid, code: row.code, reason }
      );
    }

    const verify = await verifyPranimiDbDraftSaved({ ...draft, local_oid: row.local_oid, codeRaw: row.code, code: row.code });
    if (!verify?.ok) {
      appendPranimiCodeDebug('db_draft_verify_failed', {
        local_oid: row.local_oid,
        code: row.code,
        verify_reason: verify?.reason || 'UNKNOWN',
        direct_primary_error: primaryError ? String(primaryError?.message || primaryError || '') : null,
        reason,
      });
      return false;
    }
    appendPranimiCodeDebug('db_draft_saved_verified', {
      local_oid: row.local_oid,
      code: row.code,
      order_id: verify?.row?.id || null,
      reason,
    });
    return true;
  } catch (error) {
    appendPranimiCodeDebug('db_draft_save_failed', {
      local_oid: draft?.local_oid || draft?.id || null,
      code: normalizeCode(draft?.codeRaw ?? draft?.code ?? draft?.draft_lifecycle?.code ?? null),
      reason,
      error: String(error?.message || error || ''),
    });
    return false;
  }
}

function orderRowToPranimiDbDraftSummary(row = {}) {
  const data = readPlainObject(row?.data);
  const life = { ...readPlainObject(data?.pranimi_code_lifecycle), ...readPlainObject(data?.draft_lifecycle) };
  const localOid = String(row?.local_oid || data?.local_oid || life?.local_oid || life?.draft_id || '').trim();
  const code = normalizeCode(row?.code ?? data?.code ?? data?.client_code ?? data?.client?.code ?? life?.code ?? life?.final_code ?? null);
  if (!localOid || code == null) return null;
  if (!isPranimiDraftLikeOrderStatus(readPranimiDraftOrderStatus(row))) return null;

  const merged = {
    ...data,
    id: localOid,
    local_oid: localOid,
    codeRaw: code,
    code,
    name: String(row?.client_name || data?.client_name || data?.name || data?.client?.name || data?.client?.full_name || '').trim(),
    phone: String(row?.client_phone || data?.client_phone || data?.phone || data?.client?.phone || '').trim(),
    draft_lifecycle: { ...life, code, local_oid: localOid, draft_id: localOid, db_order_id: row?.id || null },
    data,
    source: 'DB DRAFT',
    server_id: row?.id || null,
    db_order_id: row?.id || null,
    has_meaningful_work: true,
    ts: Date.parse(row?.updated_at || data?.updated_at || row?.created_at || data?.last_activity_at_iso || '') || Number(data?.ts || data?.last_activity_at || 0) || 0,
  };
  const totals = computePranimiDraftTotals(merged);
  return {
    ...merged,
    code: Number(code) || code,
    codeRaw: code,
    m2: Number(row?.m2_total ?? data?.m2_total ?? totals.m2) || 0,
    euro: Number(row?.price_total ?? data?.price_total ?? totals.euro) || 0,
    pieces: Number(row?.pieces ?? data?.pieces ?? totals.pieces) || 0,
  };
}

async function fetchDbDraftsSummary(limit = 120) {
  const out = [];
  const seen = new Set();
  const safeLimit = Math.max(20, Math.min(Number(limit) || 120, 250));

  async function collect(label, applyQuery) {
    try {
      const { data, error } = await withSupabaseTimeout(
        applyQuery(supabase.from('orders').select(PRANIMI_DRAFT_ORDER_SELECT))
          .order('updated_at', { ascending: false })
          .limit(safeLimit),
        PRANIMI_DB_DRAFT_VERIFY_TIMEOUT_MS,
        'PRANIMI_DB_DRAFT_LIST_TIMEOUT',
        { source: 'fetchDbDraftsSummary', label }
      );
      if (error) throw error;
      for (const row of Array.isArray(data) ? data : []) {
        const key = String(row?.id || '');
        if (key && seen.has(key)) continue;
        const summary = orderRowToPranimiDbDraftSummary(row);
        if (!summary?.id || !snapshotHasMeaningfulWork(summary)) continue;
        if (key) seen.add(key);
        out.push(summary);
      }
    } catch (error) {
      appendPranimiCodeDebug('db_draft_list_failed', { label, error: String(error?.message || error || '') });
    }
  }

  const statuses = Array.from(PRANIMI_DRAFT_LIKE_STATUSES);
  await collect('TOP_STATUS_DRAFT_LIKE', (q) => q.in('status', statuses));
  await collect('DATA_STATUS_DRAFT_LIKE', (q) => q.in('data->>status', statuses));
  await collect('DATA_PRANIMI_DB_DRAFT_TRUE', (q) => q.filter('data->>pranimi_db_draft', 'eq', 'true'));
  await collect('DATA_PRANIMI_INCOMPLETE_DRAFT_TRUE', (q) => q.filter('data->>is_pranimi_incomplete_draft', 'eq', 'true'));
  out.sort((a, b) => Number(b?.ts || 0) - Number(a?.ts || 0));
  return out;
}

async function deletePranimiDbDraft(draft = {}) {
  try {
    const localOid = String(draft?.local_oid || draft?.draft_lifecycle?.local_oid || draft?.id || '').trim();
    const dbOrderId = String(draft?.db_order_id || draft?.server_id || '').trim();
    if (!localOid && !dbOrderId) return false;

    const apiDelete = await deletePranimiDbDraftViaApi(draft);
    if (apiDelete?.ok) {
      appendPranimiCodeDebug('db_draft_api_deleted', { local_oid: localOid || null, db_order_id: dbOrderId || null, deleted: !!apiDelete?.deleted });
      return !!apiDelete?.deleted;
    }

    let q = supabase.from('orders').delete();
    if (dbOrderId && /^\d+$/.test(dbOrderId)) q = q.eq('id', Number(dbOrderId));
    else q = q.eq('local_oid', localOid);
    // Direct fallback only deletes rows explicitly marked as DB drafts or draft-like.
    const { error } = await withSupabaseTimeout(
      q,
      PRANIMI_DB_DRAFT_VERIFY_TIMEOUT_MS,
      'PRANIMI_DB_DRAFT_DELETE_TIMEOUT',
      { source: 'deletePranimiDbDraft', local_oid: localOid, db_order_id: dbOrderId }
    );
    if (error) throw error;
    appendPranimiCodeDebug('db_draft_deleted', { local_oid: localOid || null, db_order_id: dbOrderId || null });
    return true;
  } catch (error) {
    appendPranimiCodeDebug('db_draft_delete_failed', {
      local_oid: draft?.local_oid || draft?.id || null,
      db_order_id: draft?.db_order_id || draft?.server_id || null,
      error: String(error?.message || error || ''),
    });
    return false;
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

function readPlainObject(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {}
  }
  return {};
}

function normalizePranimiOrderStatus(raw = '') {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function isPranimiDraftLikeOrderStatus(status = '') {
  const s = normalizePranimiOrderStatus(status);
  if (!s) return false;
  if (PRANIMI_DRAFT_LIKE_STATUSES.has(s)) return true;
  return s.includes('draft') || s.includes('incomplete') || s.includes('paplotes') || s.includes('pa_plotes') || s.includes('pa_plots');
}

function readPranimiDraftOrderStatus(row = {}) {
  return readPranimiDbDraftPreferredStatus(row);
}

function isBlockingPranimiDraftOrder(row = {}) {
  // Fail-safe rule: once a matching public.orders row exists, it blocks the draft
  // unless DB explicitly says that order row is itself a draft/incomplete row.
  return !isPranimiDraftLikeOrderStatus(readPranimiDraftOrderStatus(row));
}

function normalizeLegacyOrderIdCandidate(value) {
  const raw = String(value || '').replace(/\.json$/i, '').trim();
  if (!/^\d+$/.test(raw)) return '';
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) return '';
  return String(n);
}

function legacyOrderIdForSupabase(value) {
  const normalized = normalizeLegacyOrderIdCandidate(value);
  if (!normalized) return null;
  const n = Number(normalized);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function getPranimiDraftFileKey(draft = {}, fallback = {}) {
  return String(
    fallback?.file_key ||
    fallback?.remote_file_key ||
    draft?._draft_file_key ||
    draft?.remote_file_key ||
    draft?.file_key ||
    ''
  ).replace(/\.json$/i, '').trim();
}

function isPranimiRemoteDraftLike(draft = {}, fallback = {}) {
  const src = String(draft?.source || fallback?.source || '').toUpperCase();
  return src.includes('REMOTE') || !!getPranimiDraftFileKey(draft, fallback);
}

function isPranimiLegacyNumericRemoteDraft(draft = {}, fallback = {}) {
  const fileKey = getPranimiDraftFileKey(draft, fallback);
  return !!fileKey && /^\d+$/.test(fileKey) && isPranimiRemoteDraftLike(draft, fallback);
}

function collectExplicitRemoteDraftPayloadIds(draft = {}) {
  const data = readPlainObject(draft?.data);
  const rootLife = readPlainObject(draft?.draft_lifecycle);
  const dataLife = readPlainObject(data?.pranimi_code_lifecycle);
  return Array.from(new Set([
    draft?.id,
    draft?.local_oid,
    data?.local_oid,
    rootLife?.local_oid,
    rootLife?.draft_id,
    dataLife?.local_oid,
    dataLife?.draft_id,
  ].map((x) => String(x || '').replace(/\.json$/i, '').trim()).filter(Boolean)));
}

function isPranimiCanonicalRemoteDraftFile(draft = {}, fallback = {}) {
  if (!isPranimiRemoteDraftLike(draft, fallback)) return true;
  const fileKey = getPranimiDraftFileKey(draft, fallback);
  if (!fileKey) return false;
  if (normalizeLegacyOrderIdCandidate(fileKey)) return false;
  const explicitIds = collectExplicitRemoteDraftPayloadIds(draft);
  // Canonical PRANIMI remote drafts are uploaded as drafts/<local_oid>.json.
  // If payload identity does not explicitly match the Storage file key, fail closed.
  return explicitIds.includes(fileKey);
}

function isPranimiUnsafeRemoteDraftSummary(draft = {}, fallback = {}) {
  const remote = isPranimiRemoteDraftLike(draft, fallback);
  if (!remote) return false;
  const fileKey = getPranimiDraftFileKey(draft, fallback);
  // A remote summary must carry the real Storage file key. Without it HAP/FSHI
  // cannot safely DB-check or clean the original object, so fail closed.
  if (!fileKey) return true;
  if (isPranimiLegacyNumericRemoteDraft(draft, fallback)) return true;
  return !isPranimiCanonicalRemoteDraftFile(draft, fallback);
}

function isPranimiRemoteDraftUiVerified(draft = {}) {
  if (!isPranimiRemoteDraftLike(draft)) return true;
  return String(draft?._draft_ui_guard || '') === PRANIMI_TEPAPLOTESUARA_UI_GUARD_VERSION;
}

function markPranimiDraftUiVerified(draft = {}) {
  if (!draft || typeof draft !== 'object') return draft;
  const remote = isPranimiRemoteDraftLike(draft);
  return {
    ...draft,
    _draft_ui_guard: remote ? PRANIMI_TEPAPLOTESUARA_UI_GUARD_VERSION : (draft?._draft_ui_guard || ''),
    source: remote ? 'REMOTE / DB CHECKED' : (draft?.source || 'LOCAL / NOT SYNCED'),
  };
}

function collectPranimiDraftAliasKeys(draft = {}, fallback = {}) {
  const ids = extractPranimiDraftSafetyIds(draft, fallback);
  return Array.from(new Set([
    draft?.id,
    draft?.local_oid,
    fallback?.id,
    fallback?.file_key,
    fallback?.remote_file_key,
    ids?.id,
    ids?.local_oid,
    ids?.file_key,
    ids?.legacy_order_id_candidate,
    ...(Array.isArray(ids?.oid_candidates) ? ids.oid_candidates : []),
  ].map((x) => String(x || '').replace(/\.json$/i, '').trim()).filter(Boolean)));
}

function rowMatchesLegacyDraftFilename(row = {}, legacyCandidate = '') {
  const normalized = normalizeLegacyOrderIdCandidate(legacyCandidate);
  return !!normalized && String(row?.id || '').trim() === normalized;
}

function extractPranimiDraftSafetyIds(draft = {}, fallback = {}) {
  const data = readPlainObject(draft?.data);
  const rootLife = readPlainObject(draft?.draft_lifecycle);
  const dataLife = readPlainObject(data?.pranimi_code_lifecycle);
  const life = { ...dataLife, ...rootLife };
  const client = { ...readPlainObject(data?.client), ...readPlainObject(draft?.client) };
  const fileKey = String(
    fallback?.file_key ||
    fallback?.remote_file_key ||
    draft?._draft_file_key ||
    draft?.remote_file_key ||
    draft?.file_key ||
    draft?.legacy_order_id_candidate ||
    ''
  ).replace(/\.json$/i, '').trim();
  const id = String(draft?.id || fallback?.id || '').replace(/\.json$/i, '').trim();
  const localOid = String(
    draft?.local_oid ||
    data?.local_oid ||
    life?.local_oid ||
    life?.draft_id ||
    life?.oid ||
    ''
  ).trim();
  const code = normalizeCode(
    draft?.codeRaw ??
    draft?.code ??
    data?.code ??
    data?.client_code ??
    client?.code ??
    life?.code ??
    life?.final_code ??
    null
  );
  const phone = normalizeMatchPhone(
    draft?.phone ||
    draft?.client_phone ||
    client?.phone ||
    data?.client_phone ||
    data?.phone ||
    ''
  );
  const oidCandidates = Array.from(new Set([
    localOid,
    String(life?.local_oid || '').trim(),
    String(life?.draft_id || '').trim(),
    String(data?.local_oid || '').trim(),
    id,
    fileKey,
  ].filter(Boolean)));
  const legacyOrderIdCandidate = [
    normalizeLegacyOrderIdCandidate(fileKey),
    normalizeLegacyOrderIdCandidate(id),
  ].find(Boolean) || '';

  return {
    id,
    file_key: fileKey,
    local_oid: localOid || id || fileKey,
    oid_candidates: oidCandidates,
    legacy_order_id_candidate: legacyOrderIdCandidate,
    code,
    phone,
  };
}

function orderRowMatchesPranimiDraft(row = {}, draftIds = {}) {
  if (!row) return false;
  const data = readPlainObject(row?.data);
  const life = readPlainObject(data?.pranimi_code_lifecycle);
  const rowId = String(row?.id || '').trim();
  const rowLocalOidCandidates = Array.from(new Set([
    String(row?.local_oid || '').trim(),
    String(data?.local_oid || '').trim(),
    String(life?.local_oid || '').trim(),
    String(life?.draft_id || '').trim(),
  ].filter(Boolean)));

  if (rowMatchesLegacyDraftFilename(row, draftIds?.legacy_order_id_candidate)) return true;

  const draftOidCandidates = Array.isArray(draftIds?.oid_candidates) ? draftIds.oid_candidates : [];
  if (draftOidCandidates.some((x) => rowLocalOidCandidates.includes(String(x || '').trim()))) return true;

  const rowCode = normalizeCode(
    row?.code ??
    data?.code ??
    data?.client_code ??
    data?.client?.code ??
    life?.code ??
    life?.final_code ??
    null
  );
  if (draftIds?.code != null && rowCode != null && String(rowCode) === String(draftIds.code)) return true;

  return false;
}

async function queryPranimiDraftOrders(label, applyQuery) {
  try {
    const query = applyQuery(supabase.from('orders').select(PRANIMI_DRAFT_ORDER_SELECT));
    const { data, error } = await query.limit(25);
    if (error) throw error;
    return { ok: true, label, rows: Array.isArray(data) ? data : [] };
  } catch (error) {
    return { ok: false, label, rows: [], error };
  }
}

async function findBlockingOrderForDraftInDb(draft = {}, fallback = {}) {
  const ids = extractPranimiDraftSafetyIds(draft, fallback);
  const candidates = [];
  let hadQuery = false;
  let hadOk = false;

  async function collect(label, applyQuery) {
    hadQuery = true;
    const res = await queryPranimiDraftOrders(label, applyQuery);
    if (res.ok) {
      hadOk = true;
      candidates.push(...res.rows.map((row) => ({ row, label })));
    }
    return res;
  }

  const oidCandidates = Array.from(new Set((ids.oid_candidates || []).map((x) => String(x || '').trim()).filter(Boolean))).slice(0, 6);
  for (const oidCandidate of oidCandidates) {
    await collect('MATCH_BY_LOCAL_OID_COLUMN', (q) => q.eq('local_oid', oidCandidate));
    await collect('MATCH_BY_DATA_LOCAL_OID', (q) => q.filter('data->>local_oid', 'eq', oidCandidate));
    await collect('MATCH_BY_DATA_LIFECYCLE_LOCAL_OID', (q) => q.filter('data->pranimi_code_lifecycle->>local_oid', 'eq', oidCandidate));
  }

  const legacyOrderIdForDb = legacyOrderIdForSupabase(ids.legacy_order_id_candidate);
  if (legacyOrderIdForDb != null) {
    await collect('MATCH_BY_ORDER_ID_LEGACY', (q) => q.eq('id', legacyOrderIdForDb));
  }

  if (ids.code != null) {
    await collect('MATCH_BY_CODE', (q) => q.eq('code', ids.code));
  }

  const seen = new Set();
  for (const item of candidates) {
    const row = item?.row || null;
    const rowKey = String(row?.id || '') || `${item?.label}:${JSON.stringify(row || {})}`;
    if (seen.has(rowKey)) continue;
    seen.add(rowKey);
    if (!orderRowMatchesPranimiDraft(row, ids)) continue;
    if (!isBlockingPranimiDraftOrder(row)) continue;
    return {
      blocked: true,
      uncertain: false,
      row,
      match_type: item?.label || 'MATCH_BY_ORDER',
      draft_ids: ids,
    };
  }

  return {
    blocked: false,
    uncertain: hadQuery && !hadOk,
    row: null,
    match_type: '',
    draft_ids: ids,
  };
}

function findBlockingOrderForDraftInRows(draft = {}, rows = [], fallback = {}) {
  const ids = extractPranimiDraftSafetyIds(draft, fallback);
  const seen = new Set();
  for (const row of (Array.isArray(rows) ? rows : [])) {
    const rowKey = String(row?.id || '') || JSON.stringify(row || {});
    if (seen.has(rowKey)) continue;
    seen.add(rowKey);
    if (!orderRowMatchesPranimiDraft(row, ids)) continue;
    if (!isBlockingPranimiDraftOrder(row)) continue;
    return {
      blocked: true,
      uncertain: false,
      row,
      match_type: rowMatchesLegacyDraftFilename(row, ids?.legacy_order_id_candidate)
        ? 'MATCH_BY_ORDER_ID_LEGACY'
        : 'MATCH_BY_BULK_DRAFT_ORDER_GUARD',
      draft_ids: ids,
    };
  }
  return { blocked: false, uncertain: false, row: null, match_type: '', draft_ids: ids };
}

async function fetchBlockingOrderRowsForDrafts(items = []) {
  const draftIdsList = (Array.isArray(items) ? items : []).map((item) => extractPranimiDraftSafetyIds(item, {
    id: item?.id,
    file_key: item?._draft_file_key || item?.remote_file_key || item?.file_key || '',
  }));
  const oidCandidates = Array.from(new Set(draftIdsList.flatMap((x) => x?.oid_candidates || []).map((x) => String(x || '').trim()).filter(Boolean))).slice(0, 120);
  const legacyOrderIds = Array.from(new Set(draftIdsList
    .map((x) => legacyOrderIdForSupabase(x?.legacy_order_id_candidate))
    .filter((x) => x != null))).slice(0, 120);
  const codes = Array.from(new Set(draftIdsList.map((x) => x?.code).filter((x) => x != null).map((x) => Number(x)).filter((x) => Number.isFinite(x)))).slice(0, 120);

  const rows = [];
  let hadQuery = false;
  let hadOk = false;

  async function collect(label, values, applyQuery) {
    if (!Array.isArray(values) || !values.length) return;
    hadQuery = true;
    try {
      const { data, error } = await applyQuery(supabase.from('orders').select(PRANIMI_DRAFT_ORDER_SELECT)).limit(500);
      if (error) throw error;
      hadOk = true;
      rows.push(...(Array.isArray(data) ? data : []));
    } catch (error) {
      appendPranimiCodeDebug('draft_bulk_order_guard_query_failed', {
        label,
        count: values.length,
        error: String(error?.message || error || ''),
      });
    }
  }

  await collect('BULK_MATCH_BY_LOCAL_OID_COLUMN', oidCandidates, (q) => q.in('local_oid', oidCandidates));
  await collect('BULK_MATCH_BY_DATA_LOCAL_OID', oidCandidates, (q) => q.in('data->>local_oid', oidCandidates));
  await collect('BULK_MATCH_BY_DATA_LIFECYCLE_LOCAL_OID', oidCandidates, (q) => q.in('data->pranimi_code_lifecycle->>local_oid', oidCandidates));
  await collect('BULK_MATCH_BY_ORDER_ID_LEGACY', legacyOrderIds, (q) => q.in('id', legacyOrderIds));
  await collect('BULK_MATCH_BY_CODE', codes, (q) => q.in('code', codes));

  const byId = new Map();
  for (const row of rows) {
    const key = String(row?.id || '') || JSON.stringify(row || {});
    if (!byId.has(key)) byId.set(key, row);
  }

  return { rows: Array.from(byId.values()), uncertain: hadQuery && !hadOk };
}


function readPranimiDraftCodeForGuard(draft = {}) {
  const data = readPlainObject(draft?.data);
  const life = { ...readPlainObject(data?.pranimi_code_lifecycle), ...readPlainObject(draft?.draft_lifecycle) };
  return normalizeCode(
    draft?.codeRaw ??
    draft?.code ??
    data?.code ??
    data?.client_code ??
    data?.client?.code ??
    life?.code ??
    life?.final_code ??
    null
  );
}

function normalizeBaseCodePoolStatus(raw = '') {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function readBaseCodePoolVerdict(row = null) {
  if (!row || typeof row !== 'object') return { state: 'missing', row: null };
  const status = normalizeBaseCodePoolStatus(row?.status || row?.state || row?.code_status || '');
  const usedFlag = row?.used === true || row?.is_used === true || row?.taken === true;
  if (usedFlag || status === 'used' || status === 'taken' || status === 'final' || status === 'finalized') {
    return { state: 'used', row };
  }
  if (status === 'available' || status === 'free' || status === 'unused') {
    return { state: 'available', row };
  }
  const reservedBy = String(row?.reserved_by || row?.reserved_for || row?.locked_by || '').trim();
  const leaseRaw = row?.lease_expires_at || row?.reserved_until || row?.expires_at || null;
  const leaseTime = leaseRaw ? Date.parse(String(leaseRaw)) : NaN;
  const hasActiveLease = Number.isFinite(leaseTime) ? leaseTime > Date.now() : false;
  if (status === 'reserved' || status === 'draft' || status === 'hold' || status === 'held' || reservedBy || hasActiveLease) {
    return { state: 'reserved', row };
  }
  return { state: status || 'unknown', row };
}

async function fetchBaseCodePoolRowsForDrafts(items = []) {
  const codes = Array.from(new Set((Array.isArray(items) ? items : [])
    .map((item) => readPranimiDraftCodeForGuard(item))
    .filter((code) => code != null)
    .map((code) => Number(code))
    .filter((code) => Number.isFinite(code) && code > 0))).slice(0, 160);

  if (!codes.length) return { ok: true, uncertain: false, byCode: new Map() };

  try {
    const { data, error } = await supabase
      .from('base_code_pool')
      .select('*')
      .in('code', codes)
      .limit(500);
    if (error) throw error;
    const byCode = new Map();
    for (const row of (Array.isArray(data) ? data : [])) {
      const code = normalizeCode(row?.code ?? row?.code_n ?? row?.base_code ?? null);
      if (code == null) continue;
      const key = String(code);
      const current = byCode.get(key);
      const nextVerdict = readBaseCodePoolVerdict(row);
      const currentVerdict = readBaseCodePoolVerdict(current);
      const rank = { used: 4, reserved: 3, available: 2, unknown: 1, missing: 0 };
      const nextRank = rank[nextVerdict.state] ?? 1;
      const currentRank = rank[currentVerdict.state] ?? 0;
      if (!current || nextRank >= currentRank) byCode.set(key, row);
    }
    return { ok: true, uncertain: false, byCode };
  } catch (error) {
    appendPranimiCodeDebug('draft_code_pool_guard_query_failed', {
      count: codes.length,
      error: String(error?.message || error || ''),
    });
    return { ok: false, uncertain: true, byCode: new Map() };
  }
}

function draftHasLocalReservationForCode(item = {}) {
  try {
    const ids = extractPranimiDraftSafetyIds(item, { id: item?.id, file_key: item?._draft_file_key || item?.remote_file_key || item?.file_key || '' });
    const expectedCode = readPranimiDraftCodeForGuard(item);
    const candidates = Array.from(new Set([
      item?.id,
      item?.local_oid,
      ids?.id,
      ids?.local_oid,
      ...(Array.isArray(ids?.oid_candidates) ? ids.oid_candidates : []),
    ].map((x) => String(x || '').trim()).filter(Boolean)));
    for (const candidate of candidates) {
      const meta = readDraftReservationLocal(candidate);
      if (!meta) continue;
      const metaCode = normalizeCode(meta?.code ?? meta?.codeRaw ?? null);
      if (expectedCode != null && metaCode != null && String(metaCode) !== String(expectedCode)) continue;
      if (meta?.has_meaningful_work === true || String(meta?.source || '').toLowerCase().includes('draft')) return true;
    }
  } catch {}
  return false;
}

function evaluateDraftCodePoolGuard(item = {}, pool = {}) {
  const code = readPranimiDraftCodeForGuard(item);
  const source = String(item?.source || '').toUpperCase();
  const remote = source.includes('REMOTE') || !!getPranimiDraftFileKey(item);
  const dbDraft = source.includes('DB DRAFT') || !!item?.db_order_id || !!item?.server_id || item?.data?.is_pranimi_incomplete_draft === true;
  const hasLocalReservation = draftHasLocalReservationForCode(item);

  if (code == null) return { allow: false, reason: 'NO_CODE' };
  if (pool?.uncertain) {
    if (dbDraft) return { allow: true, reason: 'CODE_POOL_UNCERTAIN_DB_DRAFT_ALLOWED', code, rehold: true };
    return remote
      ? { allow: false, reason: 'CODE_POOL_UNCERTAIN_REMOTE_FAIL_CLOSED', code }
      : { allow: true, reason: 'CODE_POOL_UNCERTAIN_LOCAL_ALLOWED', code };
  }

  const row = pool?.byCode instanceof Map ? pool.byCode.get(String(code)) : null;
  const verdict = readBaseCodePoolVerdict(row);

  if (verdict.state === 'used') {
    // DB-backed incomplete drafts are real draft rows in public.orders.
    // Their code may already be marked used by the orders trigger, and that is OK:
    // the code belongs to this incomplete draft and must remain blocked from reuse.
    // Storage/remote drafts still fail closed to avoid showing stale finalized orders.
    if (dbDraft && !remote) return { allow: true, reason: 'DB_DRAFT_POOL_USED_ALLOWED', code, row };
    return { allow: false, reason: 'CODE_POOL_USED', code, row };
  }
  if (verdict.state === 'available') {
    // DB-backed incomplete drafts are now the shared source of truth for TE PA PLOTESUARA.
    // If the pool lease is lagging, keep the draft visible and re-hold the code immediately.
    if (dbDraft) return { allow: true, reason: 'DB_DRAFT_POOL_AVAILABLE_REHOLD', code, row, rehold: true };
    // Local meaningful drafts are allowed to survive even if the DB lease has not
    // been updated yet. Re-hold the code below instead of deleting the user's draft.
    if (!remote && hasLocalReservation) return { allow: true, reason: 'LOCAL_RESERVATION_POOL_AVAILABLE_REHOLD', code, row, rehold: true };
    return { allow: false, reason: 'CODE_POOL_AVAILABLE_NOT_DRAFT', code, row };
  }
  if (verdict.state === 'reserved') return { allow: true, reason: 'CODE_POOL_RESERVED', code, row };

  if (dbDraft) return { allow: true, reason: `DB_DRAFT_CODE_POOL_${String(verdict.state || 'missing').toUpperCase()}_REHOLD`, code, row, rehold: true };

  // Remote Storage drafts are visible only when code lifecycle also says draft/reserved.
  // This kills Storage ghosts with valid-looking payloads but no draft ownership.
  if (remote) return { allow: false, reason: `REMOTE_CODE_POOL_${String(verdict.state || 'missing').toUpperCase()}`, code, row };

  // Local-only drafts can survive while offline/local, but only if this browser has a reservation marker.
  if (hasLocalReservation) return { allow: true, reason: 'LOCAL_RESERVATION_PRESENT', code, row };
  return { allow: false, reason: `LOCAL_CODE_POOL_${String(verdict.state || 'missing').toUpperCase()}`, code, row };
}

async function draftHasVerifiedOrderInDb(draft = {}) {
  const verdict = await findBlockingOrderForDraftInDb(draft);
  return !!verdict?.blocked;
}

async function filterDraftSummariesAgainstDb(items = []) {
  const input = Array.isArray(items) ? items : [];
  const out = [];
  const bulk = await fetchBlockingOrderRowsForDrafts(input);
  const codePool = await fetchBaseCodePoolRowsForDrafts(input);

  for (const item of input) {
    if (!item?.id) continue;
    if (isPranimiUnsafeRemoteDraftSummary(item)) {
      appendPranimiCodeDebug('incomplete_draft_hidden_legacy_numeric_remote_file', {
        local_oid: item?.local_oid || item?.id || null,
        draft_file_key: getPranimiDraftFileKey(item),
        code: item?.code || item?.codeRaw || null,
        source: item?.source || null,
      });
      continue;
    }
    if (normalizeCode(item?.codeRaw || item?.code || item?.draft_lifecycle?.code || null) == null) continue;

    const codePoolVerdict = evaluateDraftCodePoolGuard(item, codePool);
    if (codePoolVerdict?.rehold && codePoolVerdict?.code != null) {
      void holdBaseCodeForDraft(codePoolVerdict.code, item?.id || item?.local_oid || '', {
        minutes: LOCK_MINUTES_AFTER_INFO,
        reason: 'te_paplotesuara_local_rehold_after_available_pool',
      }).catch(() => false);
    }
    if (!codePoolVerdict?.allow) {
      const aliases = collectPranimiDraftAliasKeys(item, { id: item?.id, file_key: item?._draft_file_key || item?.remote_file_key || item?.file_key || '' });
      try { aliases.forEach((alias) => removeDraftLocal(alias)); } catch {}
      try { aliases.forEach((alias) => removeDraftReservationLocal(alias)); } catch {}
      appendPranimiCodeDebug('incomplete_draft_hidden_code_pool_guard', {
        local_oid: item?.local_oid || item?.id || null,
        draft_file_key: item?._draft_file_key || item?.remote_file_key || item?.file_key || null,
        code: codePoolVerdict?.code || item?.code || item?.codeRaw || null,
        source: item?.source || null,
        reason: codePoolVerdict?.reason || null,
        pool_status: codePoolVerdict?.row?.status || null,
        pool_used: codePoolVerdict?.row?.used ?? null,
      });
      continue;
    }

    const verdict = findBlockingOrderForDraftInRows(item, bulk.rows, { id: item?.id, file_key: item?._draft_file_key || item?.remote_file_key || item?.file_key || '' });
    if (verdict?.blocked) {
      const targetId = String(item?.id || item?.local_oid || '').trim();
      try { if (targetId) removeDraftLocal(targetId); } catch {}
      try { if (targetId) removeDraftReservationLocal(targetId); } catch {}
      appendPranimiCodeDebug('incomplete_draft_hidden_matching_order', {
        local_oid: targetId || null,
        draft_file_key: item?._draft_file_key || item?.remote_file_key || item?.file_key || null,
        code: item?.code || item?.codeRaw || null,
        order_id: verdict?.row?.id || null,
        order_status: readPranimiDraftOrderStatus(verdict?.row || {}),
        match_type: verdict?.match_type || null,
      });
      continue;
    }

    // Remote Storage drafts are never trusted without a DB anti-join check.
    if (bulk?.uncertain && String(item?.source || '').toUpperCase().includes('REMOTE')) {
      appendPranimiCodeDebug('remote_incomplete_draft_hidden_db_check_uncertain', {
        local_oid: item?.local_oid || item?.id || null,
        draft_file_key: item?._draft_file_key || item?.remote_file_key || item?.file_key || null,
        code: item?.code || item?.codeRaw || null,
      });
      continue;
    }

    out.push(markPranimiDraftUiVerified(item));
  }
  out.sort((a, b) => Number(b?.ts || 0) - Number(a?.ts || 0));
  return out;
}

async function fetchRemoteDraftsSummary() {
  const files = await listDraftsRemote(80);
  const out = [];

  await mapDraftsWithLimit(files, 4, async (f) => {
    const id = f.name.replace('.json', '');
    if (normalizeLegacyOrderIdCandidate(id)) {
      // Legacy Storage objects named drafts/<order_id>.json are not canonical PRANIMI drafts.
      // They can point to finalized orders with a completely different payload code/name.
      appendPranimiCodeDebug('remote_legacy_numeric_draft_file_hidden_pre_db', {
        draft_file_key: id,
        reason: 'LEGACY_NUMERIC_REMOTE_DRAFT_FILE',
      });
      return;
    }
    const rawDraft = await readDraftRemote(id);
    const dData = readPlainObject(rawDraft?.data);
    const dLife = { ...readPlainObject(dData?.pranimi_code_lifecycle), ...readPlainObject(rawDraft?.draft_lifecycle) };
    const rawIdentityKeys = collectExplicitRemoteDraftPayloadIds({ ...(rawDraft || {}), data: dData, draft_lifecycle: dLife });
    if (!rawIdentityKeys.includes(id)) {
      appendPranimiCodeDebug('remote_noncanonical_draft_file_hidden_pre_db', {
        draft_file_key: id,
        payload_ids: rawIdentityKeys.slice(0, 8),
        reason: 'REMOTE_FILE_KEY_DOES_NOT_MATCH_PAYLOAD_IDENTITY',
      });
      return;
    }
    const draftId = String(rawDraft?.id || rawDraft?.local_oid || dLife?.local_oid || dLife?.draft_id || dData?.local_oid || id || '').trim();
    if (!draftId) return;
    const d = { ...(rawDraft || {}), id: draftId, _draft_file_key: id, remote_file_key: id, file_key: id };

    let totalM2 = 0;
    (d.tepihaRows || []).forEach(r => totalM2 += (Number(r.m2) || 0) * (Number(r.qty) || 0));
    (d.stazaRows || []).forEach(r => totalM2 += (Number(r.m2) || 0) * (Number(r.qty) || 0));
    totalM2 += (Number(d.stairsQty) || 0) * (Number(d.stairsPer) || 0);
    
    const euro = Number((totalM2 * (Number(d.pricePerM2) || PRICE_DEFAULT)).toFixed(2));

    if (!snapshotHasMeaningfulWork(d)) return;
    const draftCode = normalizeCode(d.codeRaw || d.code || dLife?.code || dLife?.final_code || dData?.code || dData?.client_code || dData?.client?.code || readSessionReservedBaseCode(draftId) || null);
    if (draftCode == null) return;

    out.push({
      id: draftId,
      local_oid: String(d?.local_oid || dData?.local_oid || dLife?.local_oid || dLife?.draft_id || draftId || '').trim(),
      remote_file_key: id,
      file_key: id,
      _draft_file_key: id,
      legacy_order_id_candidate: /^\d+$/.test(String(id || '').trim()) ? String(id).trim() : '',
      draft_lifecycle: d?.draft_lifecycle || dData?.pranimi_code_lifecycle || null,
      data: dData && typeof dData === 'object' ? dData : null,
      codeRaw: draftCode,
      ts: d.ts || d.last_activity_at || dData?.last_activity_at || 0,
      code: formatKod(draftCode, true),
      name: String(d.name || d?.client?.full_name || d?.client?.name || dData?.client_name || dData?.client?.name || '').trim(),
      phone: String(d.phone || d?.client?.phone || dData?.client_phone || dData?.client?.phone || '').replace(/^\+383\s*/, '').replace(/\D+/g, ''),
      m2: totalM2,
      euro,
      source: 'REMOTE',
      has_meaningful_work: true,
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
  const [draftsRefreshing, setDraftsRefreshing] = useState(false);
  const [showDraftsSheet, setShowDraftsSheet] = useState(false);

  const uniqueDrafts = useMemo(() => {
    const sorted = [...(Array.isArray(drafts) ? drafts : [])]
      .filter((d) => shouldDraftSummaryRender(d))
      .sort((a, b) => Number(b?.ts || 0) - Number(a?.ts || 0));
    const byId = new Map();
    for (const d of sorted) {
      const idKey = String(d?.id || d?.local_oid || '').trim();
      if (!idKey) continue;
      const key = `id:${idKey}`;
      if (!byId.has(key)) byId.set(key, d);
    }
    return Array.from(byId.values());
  }, [drafts]);

  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [noPhone, setNoPhone] = useState(false);
  const [oldClientDebt, setOldClientDebt] = useState(0);
  const [clientPhotoUrl, setClientPhotoUrl] = useState('');
  const [selectedClient, setSelectedClient] = useState(null);
  const [clientMatchPrompt, setClientMatchPrompt] = useState({ open: false, reason: '', matchKey: '', candidate: null, phoneDigits: '', fullName: '' });
  const [clientMatchDecision, setClientMatchDecision] = useState({ matchKey: '', mode: '', candidate: null });
  const [localSyncWarning, setLocalSyncWarning] = useState(null);
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
  const [pendingUpfrontCashPayment, setPendingUpfrontCashPayment] = useState(null);

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
  const phoneInputRef = useRef(null);
  const latestDuplicateInputRef = useRef({ phoneDigits: '', fullName: '' });

  useEffect(() => {
    codeRawRef.current = String(codeRaw || '');
  }, [codeRaw]);

  function getPhoneDigitsRaw(value = phone) {
    try { return String(value || '').replace(/\D+/g, ''); } catch { return ''; }
  }

  function getCanonicalClientPhone(value = phone, forceNoPhone = noPhone) {
    if (forceNoPhone) return '';
    return normalizeKosovoPhone(value, phonePrefix);
  }

  useEffect(() => {
    oidRef.current = String(oid || '');
  }, [oid]);

  useEffect(() => {
    latestDuplicateInputRef.current = {
      phoneDigits: normalizeMatchPhone(phone),
      fullName: normalizeMatchName(name),
    };
  }, [phone, name]);

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

  async function tryReserveCodeInBackground(nextOid, reason = 'session_open') {
    const id = String(nextOid || '').trim();
    if (!id) return;
    try { if (startupCodeReserveTimerRef.current) clearTimeout(startupCodeReserveTimerRef.current); } catch {}
    startupCodeReserveTimerRef.current = setTimeout(() => {
      void (async () => {
        try {
          if (String(oidRef.current || '') !== id) return;
          const currentCode = String(normalizeCode(codeRawRef.current) || '').trim();
          if (currentCode) {
            writeDraftReservationLocal({
              local_oid: id,
              code: currentCode,
              created_by_pin: actor?.pin || actor?.pinCode || actor?.id || '',
              has_meaningful_work: false,
              reason: 'SESSION_RESERVED_CODE_ALREADY_PRESENT',
            });
            void holdBaseCodeForDraft(currentCode, id, {
              minutes: Math.ceil(PRANIMI_BLANK_DRAFT_RELEASE_MS / 60000),
              reason: 'blank_session_reserved_existing_code',
            }).catch(() => {});
            appendPranimiCodeDebug('session_reserved_code_kept', { local_oid: id, final_code: currentCode, final_code_reason: 'SESSION_RESERVED_CODE_ALREADY_PRESENT', reason });
            return;
          }
          const c = await reserveSharedCode(id);
          if (String(oidRef.current || '') !== id) return;
          const reserved = String(normalizeCode(c) || '').trim();
          if (!reserved) return;
          codeRawRef.current = reserved;
          setCodeRaw(reserved);
          writeDraftReservationLocal({
            local_oid: id,
            code: reserved,
            created_by_pin: actor?.pin || actor?.pinCode || actor?.id || '',
            has_meaningful_work: false,
            reason: 'SESSION_RESERVED_ON_OPEN',
          });
          void holdBaseCodeForDraft(reserved, id, {
            minutes: Math.ceil(PRANIMI_BLANK_DRAFT_RELEASE_MS / 60000),
            reason: 'blank_session_reserved_on_open',
          }).catch(() => {});
          appendPranimiCodeDebug('session_reserved_code_assigned', { local_oid: id, final_code: reserved, final_code_reason: 'SESSION_RESERVED_ON_OPEN', reason });
          const stillOnline = (() => { try { return typeof navigator === 'undefined' ? true : navigator.onLine !== false; } catch { return true; } })();
          if (stillOnline) {
            try { setNetState({ ok: true, reason: null }); } catch {}
            try { localStorage.removeItem(OFFLINE_MODE_KEY); } catch {}
            try { setOfflineMode(false); } catch {}
            try { setShowOfflinePrompt(false); } catch {}
          } else {
            try { setNetState({ ok: false, reason: 'NO_INTERNET' }); } catch {}
            try { localStorage.setItem(OFFLINE_MODE_KEY, '1'); } catch {}
            try { setOfflineMode(true); } catch {}
            try { setShowOfflinePrompt(true); } catch {}
          }
        } catch (e) {
          appendPranimiCodeDebug('session_reserved_code_failed', { local_oid: id, reason, error: String(e?.message || e || '') });
          try {
            const online = typeof navigator === 'undefined' ? true : navigator.onLine;
            if (!online) {
              setNetState({ ok: false, reason: 'NO_INTERNET' });
              setShowOfflinePrompt(true);
            }
          } catch {}
        }
      })();
    }, 0);
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
    const cleanPhone = normalizeMatchPhone(rawPhone);

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
      const id = makePranimiLocalOid();
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

      // URL/draft/session code is not authoritative for a new PRANIMI create.
      // Always display a fresh sessionReservedCode tied to this local_oid.
      codeRawRef.current = '';
      setCodeRaw('');
      appendPranimiCodeDebug('new_pranimi_session_started', {
        local_oid: id,
        url_code_ignored_for_new_create: permanentCode || null,
        final_code_reason: permanentCode ? 'URL_CODE_IGNORED_SESSION_RESERVED_PENDING' : 'SESSION_RESERVED_PENDING',
      });
      try {
        const online = typeof navigator === 'undefined' ? true : navigator.onLine;
        setNetState({ ok: !!online, reason: online ? '' : 'NO_INTERNET' });
        if (!online) {
          try { localStorage.setItem(OFFLINE_MODE_KEY, '1'); } catch {}
          try { setOfflineMode(true); } catch {}
          try { setShowOfflinePrompt(true); } catch {}
        } else {
          try { localStorage.removeItem(OFFLINE_MODE_KEY); } catch {}
          try { setOfflineMode(false); } catch {}
          try { setShowOfflinePrompt(false); } catch {}
        }
        void tryReserveCodeInBackground(id, online ? 'online_pranimi_open' : 'offline_pranimi_open');
      } catch {
        setNetState({ ok: false, reason: 'CODE_RESERVE_DEFERRED' });
        void tryReserveCodeInBackground(id, 'reserve_deferred_after_exception');
      }

      const nextNamePrefill = urlName ? String(urlName) : '';
      let nextPhonePrefill = '';
      if (urlPhone) {
        nextPhonePrefill = normalizeMatchPhone(urlPhone);
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
      // Never create a fake selectedClient with id:null from URL/draft/session code.
      // Existing-client code is trusted only after phone match + worker confirmation.
      setSelectedClient(null);
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
      setPendingUpfrontCashPayment(null);
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
    void releaseExpiredBlankDraftReservations('mount_expired_blank_sweep');

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
      void releaseExpiredBlankDraftReservations('online_expired_blank_sweep');
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
      void releaseExpiredBlankDraftReservations('pageshow_expired_blank_sweep');
      queueBackgroundMetaSync('pageshow_resume', 150);
    };

    const onVisible = () => {
      try {
        if (document.visibilityState === 'visible') {
          void releaseExpiredBlankDraftReservations('visibility_expired_blank_sweep');
          queueBackgroundMetaSync('visibility_resume', 200);
        }
      } catch {}
    };

    const blankReleaseTimer = window.setInterval(() => {
      void releaseExpiredBlankDraftReservations('interval_expired_blank_sweep');
    }, 5 * 60 * 1000);

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
      try { clearInterval(blankReleaseTimer); } catch {}
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
    const cacheFresh = !forceRemote && draftRemoteCacheRef.current?.version === PRANIMI_DRAFT_GUARD_VERSION && (now - Number(draftRemoteCacheRef.current?.ts || 0) < 30000);
    if (cacheFresh) {
      const cachedRaw = (Array.isArray(draftRemoteCacheRef.current?.items) ? draftRemoteCacheRef.current.items : [])
        .filter((d) => d?.id && !isAnyDraftAliasSuppressed(d, { id: d?.id, file_key: d?._draft_file_key || d?.remote_file_key || d?.file_key || '' }) && !isPranimiUnsafeRemoteDraftSummary(d));
      const cached = await filterDraftSummariesAgainstDb(cachedRaw);
      pushDraftsToState(cached);
      return cached;
    }

    if (draftRemoteInflightRef.current) {
      const cachedRaw = (Array.isArray(draftRemoteCacheRef.current?.items) ? draftRemoteCacheRef.current.items : [])
        .filter((d) => d?.id && !isAnyDraftAliasSuppressed(d, { id: d?.id, file_key: d?._draft_file_key || d?.remote_file_key || d?.file_key || '' }) && !isPranimiUnsafeRemoteDraftSummary(d));
      const cached = await filterDraftSummariesAgainstDb(cachedRaw);
      pushDraftsToState(cached);
      return cached;
    }

    draftRemoteInflightRef.current = true;

    try {
      const dbRaw = (await fetchDbDraftsSummary())
        .filter((d) => d?.id && !isAnyDraftAliasSuppressed(d, { id: d?.id, file_key: d?._draft_file_key || d?.remote_file_key || d?.file_key || '' }));
      // V7 source of truth for shared drafts is public.orders status=incomplete/draft.
      // Legacy Supabase Storage drafts are ignored in the list to prevent stale ghosts.
      const remoteRaw = [];
      const localRaw = readLocalDraftSummaries()
        .filter((d) => d?.id && !isAnyDraftAliasSuppressed(d, { id: d?.id, file_key: d?._draft_file_key || d?.remote_file_key || d?.file_key || '' }) && !isPranimiUnsafeRemoteDraftSummary(d));
      const merged = await filterDraftSummariesAgainstDb([...dbRaw, ...remoteRaw, ...localRaw]);

      draftRemoteCacheRef.current = {
        version: PRANIMI_DRAFT_GUARD_VERSION,
        ts: Date.now(),
        items: merged,
      };

      pushDraftsToState(merged);
      return merged;
    } catch {
      const fallbackDb = await fetchDbDraftsSummary().catch(() => []);
      const local = await filterDraftSummariesAgainstDb([...fallbackDb, ...readLocalDraftSummaries()]);
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


  function getCurrentPranimiCodeNumber() {
    return normalizeCode(
      codeRawRef.current ||
      codeRaw ||
      readSessionReservedBaseCode(oidRef.current) ||
      readSessionReservedBaseCode(oid) ||
      null
    );
  }

  function isCandidateCurrentPranimiCode(candidate) {
    const currentCode = getCurrentPranimiCodeNumber();
    const candidateCode = normalizeCode(candidate?.code || candidate?.client_code || null);
    return currentCode != null && candidateCode != null && String(currentCode) === String(candidateCode);
  }

  function sameSelectedClientCode(candidate) {
    if (!String(selectedClient?.id || '').trim()) return false;
    const selectedCode = normalizeCode(selectedClient?.code || null);
    const candidateCode = normalizeCode(candidate?.code || null);
    return selectedCode != null && candidateCode != null && String(selectedCode) === String(candidateCode);
  }

  function closeClientMatchPrompt(reason = 'close') {
    setClientMatchPrompt({ open: false, reason: '', matchKey: '', candidate: null, phoneDigits: '', fullName: '' });
    appendPranimiCodeDebug('existing_phone_client_prompt_closed', {
      local_oid: String(oidRef.current || oid || ''),
      reason,
      current_code: normalizeCode(codeRawRef.current || codeRaw || null),
      phone_digits: normalizeMatchPhone(phone),
    });
  }

  function resetClientMatchToPhoneEntry(payload = clientMatchPrompt) {
    const matchKey = String(payload?.matchKey || '').trim();
    const cand = payload?.candidate || null;
    const decisionCandidate = cand ? {
      id: String(cand?.id || '').trim() || null,
      code: normalizeCode(cand?.code || null),
      name: String(cand?.name || cand?.full_name || cand?.client_name || [cand?.first_name, cand?.last_name].filter(Boolean).join(' ') || '').trim(),
      phone: String(cand?.phone || cand?.client_phone || '').trim(),
    } : null;

    // Clear every match/selected-client state and send the worker back to phone entry.
    // This is local UI only: no retry, no DB write, no new code reservation.
    setClientMatchPrompt({ open: false, reason: '', matchKey: '', candidate: null, phoneDigits: '', fullName: '' });
    setClientMatchDecision({ matchKey: '', mode: '', candidate: null });
    setSelectedClient(null);
    setOldClientDebt(0);
    setClientQuery('');
    setClientHits([]);
    setShowClientSearch(false);
    setPhone('');
    setNoPhone(false);
    try { if (typeof window !== 'undefined') window.__tepiha_phone_match_declined = false; } catch {}

    appendPranimiCodeDebug('existing_phone_client_prompt_back_to_data', {
      local_oid: String(oidRef.current || oid || ''),
      matchKey,
      existing_phone_client_id: decisionCandidate?.id || null,
      existing_phone_client_code: decisionCandidate?.code || null,
      final_code: normalizeCode(codeRawRef.current || codeRaw || null),
      final_code_reason: 'PHONE_MATCH_RETURNED_TO_DATA_ENTRY',
    });

    try {
      setShowWizard(true);
      setWizStep(1);
      setTimeout(() => {
        try { phoneInputRef.current?.focus?.(); } catch {}
      }, 80);
    } catch {}
  }

  function applyClientMatchChoice(mode, payload = clientMatchPrompt) {
    const matchKey = String(payload?.matchKey || '').trim();
    const cand = payload?.candidate || null;
    const choiceMode = String(mode || '');
    const decisionCandidate = cand ? {
      id: String(cand?.id || '').trim() || null,
      code: normalizeCode(cand?.code || null),
      name: String(cand?.name || cand?.full_name || cand?.client_name || [cand?.first_name, cand?.last_name].filter(Boolean).join(' ') || '').trim(),
      phone: String(cand?.phone || cand?.client_phone || '').trim(),
    } : null;

    if (choiceMode === 'cancel_change_phone') {
      resetClientMatchToPhoneEntry(payload);
      return;
    }

    setClientMatchPrompt({ open: false, reason: '', matchKey: '', candidate: null, phoneDigits: '', fullName: '' });
    setClientMatchDecision({ matchKey, mode: 'use_existing', candidate: decisionCandidate });

    if (!cand) return;

    const candId = String(cand?.id || '').trim();
    const codeVal = String(normalizeCode(cand?.code || null) || '').trim();
    if (!candId || !codeVal) {
      appendPranimiCodeDebug('existing_phone_client_rejected_unverified', {
        local_oid: String(oidRef.current || oid || ''),
        matchKey,
        selected_client_id: candId || null,
        selected_client_code: codeVal || null,
        final_code: normalizeCode(codeRawRef.current || codeRaw || null),
        final_code_reason: 'SELECTED_CLIENT_CODE_REJECTED_ID_NULL',
      });
      alert('Ky klient nuk u verifikua me ID. Ndërro numrin ose provo përsëri. Nuk krijohet porosi me kod të ri për të njëjtin telefon.');
      return;
    }

    const candPhone = normalizeMatchPhone(cand?.phone || '');
    const candName = String(cand?.name || '').trim();

    setSelectedClient({
      id: candId,
      code: codeVal || '',
      name: candName || '',
      phone: cand?.phone || '',
    });
    if (codeVal) {
      codeRawRef.current = codeVal;
      setCodeRaw(codeVal);
    }
    appendPranimiCodeDebug('existing_phone_client_confirmed', {
      local_oid: String(oidRef.current || oid || ''),
      matchKey,
      selected_client_id: candId,
      selected_client_code: codeVal,
      final_code: codeVal,
      final_code_reason: 'VERIFIED_EXISTING_PHONE_CLIENT',
    });
    if (candName) setName(candName);
    if (candPhone) { setPhone(candPhone); setNoPhone(false); } else { setPhone(''); setNoPhone(true); }
    if (cand?.photo_url) setClientPhotoUrl(String(cand.photo_url || ''));
  }

  useEffect(() => {
    const phoneDigits = normalizeMatchPhone(phone);
    const fullName = normalizeMatchName(name);
    const canCheckPhone = isValidClientPhoneDigits(phoneDigits);
    const canCheckFullName = fullName.split(' ').filter(Boolean).length >= 2;

    if (clientMatchPrompt?.open) {
      const promptDigits = normalizeMatchPhone(clientMatchPrompt?.phoneDigits || clientMatchPrompt?.candidate?.phone || '');
      if (promptDigits && promptDigits !== phoneDigits) {
        closeClientMatchPrompt('phone_changed');
      }
    }

    if (isBridgeEditMode || noPhone) {
      if (clientMatchPrompt?.open) closeClientMatchPrompt('bridge_or_no_phone');
      return;
    }

    if (!canCheckPhone) {
      if (clientMatchPrompt?.open) closeClientMatchPrompt('invalid_phone');
      return;
    }

    let alive = true;
    const t = setTimeout(() => {
      void (async () => {
        try {
          await ensureClientsIndexLoaded();
          const found = await detectExistingClientSmart({ name, phone, clientsIndex, currentCode: getCurrentPranimiCodeNumber() });
          if (!alive) return;
          const latest = latestDuplicateInputRef.current || {};
          if (latest.phoneDigits && found?.phoneDigits && latest.phoneDigits !== found.phoneDigits) {
            appendPranimiCodeDebug('existing_phone_client_prompt_ignored_stale_phone', {
              local_oid: String(oidRef.current || oid || ''),
              found_phone_digits: found.phoneDigits,
              current_phone_digits: latest.phoneDigits,
            });
            return;
          }
          if (!found) {
            if (clientMatchPrompt?.open) closeClientMatchPrompt('no_match');
            return;
          }
          if (isCandidateCurrentPranimiCode(found.candidate)) {
            if (clientMatchPrompt?.open) closeClientMatchPrompt('current_draft_code_match');
            appendPranimiCodeDebug('existing_phone_client_prompt_ignored_current_code', {
              local_oid: String(oidRef.current || oid || ''),
              matchKey: found.matchKey || '',
              candidate_code: normalizeCode(found?.candidate?.code || null),
              current_code: normalizeCode(codeRawRef.current || codeRaw || null),
              phone_digits: found.phoneDigits || '',
            });
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
    const canonicalPhone = noPhone ? '' : getCanonicalClientPhone(phone, noPhone);
    const safePhone = canonicalPhone ? normalizeMatchPhone(canonicalPhone) : '';
    const activeOid = String(oid || oidRef.current || '').trim();
    const existingReservation = readDraftReservationLocal(activeOid) || {};
    const now = Date.now();
    const actorPin = String(actor?.pin || actor?.pinCode || actor?.id || existingReservation?.created_by_pin || '').trim();
    const base = {
      id: activeOid,
      local_oid: activeOid,
      ts: now,
      codeRaw,
      code: normalizeCode(codeRaw || existingReservation?.code || null),
      name,
      phone: safePhone,
      noPhone: !!noPhone,
      client: {
        full_name: String(name || '').trim(),
        name: String(name || '').trim(),
        phone: canonicalPhone,
        code: normalizeCode(codeRaw || existingReservation?.code || null),
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
    const meaningful = snapshotHasMeaningfulWork(base);
    const createdAt = Number(existingReservation?.created_at || 0) || now;
    return {
      ...base,
      created_by_pin: actorPin,
      created_at: createdAt,
      created_at_iso: existingReservation?.created_at_iso || new Date(createdAt).toISOString(),
      last_activity_at: now,
      last_activity_at_iso: new Date(now).toISOString(),
      has_meaningful_work: meaningful,
      draft_lifecycle: {
        code: normalizeCode(codeRaw || existingReservation?.code || null),
        local_oid: activeOid,
        draft_id: activeOid,
        created_by_pin: actorPin,
        created_at: createdAt,
        created_at_iso: existingReservation?.created_at_iso || new Date(createdAt).toISOString(),
        last_activity_at: now,
        last_activity_at_iso: new Date(now).toISOString(),
        has_meaningful_work: meaningful,
      },
    };
  }

  function hasStartedWork() {
    return snapshotHasMeaningfulWork(buildDraftSnapshot());
  }

  function markDraftReservationFromSnapshot(draft, reason = 'draft_activity') {
    try {
      const id = String(draft?.id || draft?.local_oid || oid || oidRef.current || '').trim();
      if (!id) return null;
      const meaningful = snapshotHasMeaningfulWork(draft);
      const code = normalizeCode(draft?.codeRaw || draft?.code || readSessionReservedBaseCode(id) || codeRawRef.current || codeRaw || null);
      const meta = writeDraftReservationLocal({
        local_oid: id,
        code,
        created_by_pin: actor?.pin || actor?.pinCode || actor?.id || '',
        has_meaningful_work: meaningful,
        last_activity_at: Date.now(),
        reason,
      });
      if (meaningful && code != null) {
        void holdBaseCodeForDraft(code, id, {
          minutes: LOCK_MINUTES_AFTER_INFO,
          reason,
        }).catch(() => {});
      }
      return meta;
    } catch {
      return null;
    }
  }

  async function persistMeaningfulDraft(draft, reason = 'autosave') {
    try {
      if (!draft?.id) return false;
      const meaningful = snapshotHasMeaningfulWork(draft);
      markDraftReservationFromSnapshot(draft, reason);
      if (!meaningful) return false;

      // The local draft is the first safety net. Save it synchronously before any
      // network/storage call so leaving PRANIMI immediately after typing still keeps
      // the incomplete draft visible on this device.
      upsertDraftLocal(draft);
      try { writeCurrentSessionLocal(draft); } catch {}

      const draftCode = normalizeCode(
        draft?.codeRaw ||
        draft?.code ||
        draft?.draft_lifecycle?.code ||
        readSessionReservedBaseCode(draft.id) ||
        null
      );
      if (draftCode != null) {
        // Best-effort, but awaited here so DB-backed drafts keep the code reserved
        // before other workers see them in TE PA PLOTESUARA.
        await holdBaseCodeForDraft(draftCode, draft.id, {
          minutes: LOCK_MINUTES_AFTER_INFO,
          reason,
        }).catch(() => false);
      }

      const onlineNow = (() => {
        try { return typeof navigator === 'undefined' ? true : navigator.onLine !== false; } catch { return true; }
      })();
      const dbDraftOk = onlineNow ? await upsertDraftDb(draft, reason) : false;
      // V7: shared incomplete drafts live in public.orders. Do not create new
      // Supabase Storage draft JSON objects; old Storage ghosts stay filtered out.
      try { if (showDraftsSheet) void refreshDrafts({ includeRemote: true, forceRemote: true }); } catch {}
      return onlineNow ? !!dbDraftOk : true;
    } catch {
      return false;
    }
  }

  async function releaseBlankDraftReservation(meta = {}, reason = 'blank_draft_release') {
    try {
      const id = String(meta?.local_oid || meta?.draft_id || meta?.id || '').trim();
      if (!id) return false;
      const activeId = String(oidRef.current || oid || '').trim();
      if (activeId === id && hasStartedWork()) {
        markDraftReservationFromSnapshot(buildDraftSnapshot(), 'blank_release_skipped_active_meaningful');
        return false;
      }
      let localDraft = null;
      try {
        const raw = localStorage.getItem(`${DRAFT_ITEM_PREFIX}${id}`);
        localDraft = raw ? JSON.parse(raw) : null;
      } catch {}
      if (snapshotHasMeaningfulWork(localDraft)) {
        markDraftReservationFromSnapshot(localDraft, 'blank_release_skipped_local_meaningful');
        return false;
      }
      const code = normalizeCode(meta?.code || readSessionReservedBaseCode(id) || (activeId === id ? codeRawRef.current || codeRaw : null));
      if (code != null) {
        await releaseLocksForCode(code, { oid: id, reason }).catch(() => false);
      }
      removeDraftReservationLocal(id);
      removeDraftLocal(id);
      if (activeId === id) {
        codeRawRef.current = '';
        setCodeRaw('');
      }
      appendPranimiCodeDebug('blank_draft_code_released', { local_oid: id, code, reason });
      return true;
    } catch (error) {
      appendPranimiCodeDebug('blank_draft_code_release_failed', {
        local_oid: meta?.local_oid || meta?.draft_id || meta?.id || null,
        code: meta?.code || null,
        reason,
        error: String(error?.message || error || ''),
      });
      return false;
    }
  }

  async function releaseExpiredBlankDraftReservations(reason = 'blank_draft_expiry_sweep') {
    try {
      const now = Date.now();
      const reservations = listDraftReservationsLocal();
      for (const meta of reservations) {
        if (!meta || meta.has_meaningful_work) continue;
        const createdAt = Number(meta?.created_at || meta?.last_activity_at || 0) || 0;
        const lastAt = Number(meta?.last_activity_at || createdAt || 0) || 0;
        const age = now - Math.max(createdAt, lastAt);
        if (age < PRANIMI_BLANK_DRAFT_RELEASE_MS) continue;
        await releaseBlankDraftReservation(meta, reason);
      }
    } catch {}
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

  function isAnyDraftAliasSuppressed(draft = {}, fallback = {}) {
    try {
      return collectPranimiDraftAliasKeys(draft, fallback).some((x) => isDraftSuppressed(x));
    } catch {
      return false;
    }
  }

  function suppressDraftAliases(draft = {}, fallback = {}) {
    try {
      collectPranimiDraftAliasKeys(draft, fallback).forEach((x) => suppressDraftId(x));
    } catch {}
  }

  function hideBlockedDraftFromUi(idOrDraft, verdict = {}, action = 'draft_guard') {
    const inputDraft = idOrDraft && typeof idOrDraft === 'object' ? idOrDraft : {};
    const targetId = String(
      typeof idOrDraft === 'string' || typeof idOrDraft === 'number'
        ? idOrDraft
        : (verdict?.draft_ids?.id || verdict?.draft_ids?.local_oid || inputDraft?.id || inputDraft?.local_oid || '')
    ).trim();
    const aliases = collectPranimiDraftAliasKeys(inputDraft, {
      id: targetId,
      file_key: verdict?.draft_ids?.file_key || inputDraft?._draft_file_key || inputDraft?.remote_file_key || inputDraft?.file_key || '',
      remote_file_key: verdict?.draft_ids?.file_key || inputDraft?._draft_file_key || inputDraft?.remote_file_key || inputDraft?.file_key || '',
    });
    if (!aliases.length && !targetId) return;
    aliases.forEach((x) => suppressDraftId(x));
    for (const alias of aliases) {
      try { removeDraftLocal(alias); } catch {}
      try { removeDraftReservationLocal(alias); } catch {}
    }
    const aliasSet = new Set(aliases);
    try {
      draftRemoteCacheRef.current = {
        version: PRANIMI_DRAFT_GUARD_VERSION,
        ts: Date.now(),
        items: (Array.isArray(draftRemoteCacheRef.current?.items) ? draftRemoteCacheRef.current.items : []).filter((d) => {
          const dAliases = collectPranimiDraftAliasKeys(d, { id: d?.id, file_key: d?._draft_file_key || d?.remote_file_key || d?.file_key || '' });
          return !dAliases.some((x) => aliasSet.has(x));
        }),
      };
    } catch {}
    setDrafts((prev) => (Array.isArray(prev) ? prev.filter((d) => {
      const dAliases = collectPranimiDraftAliasKeys(d, { id: d?.id, file_key: d?._draft_file_key || d?.remote_file_key || d?.file_key || '' });
      return !dAliases.some((x) => aliasSet.has(x));
    }) : []));
    appendPranimiCodeDebug('blocked_stale_incomplete_draft_action', {
      action,
      local_oid: targetId || null,
      aliases,
      code: verdict?.draft_ids?.code || inputDraft?.code || inputDraft?.codeRaw || null,
      draft_file_key: verdict?.draft_ids?.file_key || getPranimiDraftFileKey(inputDraft) || null,
      order_id: verdict?.row?.id || null,
      order_status: readPranimiDraftOrderStatus(verdict?.row || {}),
      match_type: verdict?.match_type || null,
    });
  }

  function shouldDraftSummaryRender(d = {}) {
    try {
      if (!d?.id) return false;
      if (isPranimiUnsafeRemoteDraftSummary(d)) return false;
      if (isPranimiRemoteDraftLike(d) && !isPranimiRemoteDraftUiVerified(d)) return false;
      if (isAnyDraftAliasSuppressed(d, { id: d?.id, file_key: d?._draft_file_key || d?.remote_file_key || d?.file_key || '' })) return false;
      if (!snapshotHasMeaningfulWork(d)) return false;
      if (normalizeCode(d?.codeRaw || d?.code || d?.draft_lifecycle?.code || readSessionReservedBaseCode(d.id) || null) == null) return false;
      return true;
    } catch {
      return false;
    }
  }

  function pushDraftsToState(list) {
    const sorted = [...(Array.isArray(list) ? list : [])]
      .filter((d) => shouldDraftSummaryRender(d))
      .sort((a, b) => Number(b?.ts || 0) - Number(a?.ts || 0));
    const byId = new Map();
    for (const d of sorted) {
      const idKey = String(d?.id || d?.local_oid || '').trim();
      if (!idKey) continue;
      const key = `id:${idKey}`;
      if (!byId.has(key)) byId.set(key, d);
    }
    setDrafts(Array.from(byId.values()));
  }


  function readLocalDraftSummaries() {
    return readAllDraftsLocal()
      .filter((d) => d?.id && !isAnyDraftAliasSuppressed(d, { id: d?.id, file_key: d?._draft_file_key || d?.remote_file_key || d?.file_key || '' }) && !isPranimiUnsafeRemoteDraftSummary(d) && snapshotHasMeaningfulWork(d) && normalizeCode(d?.codeRaw || d?.code || d?.draft_lifecycle?.code || readSessionReservedBaseCode(d.id) || null) != null)
      .map((d) => {
        let totalM2 = 0;
        (d?.tepihaRows || []).forEach((r) => { totalM2 += (Number(r?.m2) || 0) * (Number(r?.qty) || 0); });
        (d?.stazaRows || []).forEach((r) => { totalM2 += (Number(r?.m2) || 0) * (Number(r?.qty) || 0); });
        totalM2 += (Number(d?.stairsQty) || 0) * (Number(d?.stairsPer) || 0);
        const draftCode = normalizeCode(d?.codeRaw || d?.code || d?.draft_lifecycle?.code || readSessionReservedBaseCode(d.id) || null);
        return {
          id: d?.id,
          local_oid: String(d?.local_oid || d?.draft_lifecycle?.local_oid || d?.id || '').trim(),
          codeRaw: draftCode,
          code: Number(draftCode) || 0,
          draft_lifecycle: d?.draft_lifecycle || null,
          data: d?.data && typeof d.data === 'object' ? d.data : null,
          name: (d?.name || d?.client?.full_name || d?.client?.name || '').trim(),
          phone: String(d?.phone || d?.client?.phone || '').replace(/^\+383\s*/, '').replace(/\D+/g, ''),
          ts: Number(d?.ts || d?.last_activity_at) || 0,
          m2: totalM2,
          euro: Number((totalM2 * (Number(d?.pricePerM2) || PRICE_DEFAULT)).toFixed(2)),
          source: d?.source || 'LOCAL / NOT SYNCED',
          has_meaningful_work: true,
        };
      });
  }

  function persistCurrentDraftLocalSync(reason = 'local_exit_snapshot') {
    try {
      if (creating) return false;
      if (!oid) return false;
      if (isDraftSuppressed(oid)) return false;
      const draft = buildDraftSnapshot();
      markDraftReservationFromSnapshot(draft, reason);
      if (!snapshotHasMeaningfulWork(draft)) return false;
      upsertDraftLocal(draft);
      try { writeCurrentSessionLocal(draft); } catch {}
      return true;
    } catch {
      return false;
    }
  }

  async function commitDraftAndAdvanceCodeBestEffort() {
    try {
      if (!oid) return true;
      if (!hasStartedWork()) return true;
      try { if (draftTimer.current) clearTimeout(draftTimer.current); } catch {}
      try { if (remoteDraftTimerRef.current) clearTimeout(remoteDraftTimerRef.current); } catch {}
      const draft = buildDraftSnapshot();
      persistCurrentDraftLocalSync('home_or_exit_local_first');
      const ok = await persistMeaningfulDraft(draft, 'home_or_exit');
      try { if (showDraftsSheet) void refreshDrafts({ includeRemote: true, forceRemote: true }); } catch {}
      return !!ok;
    } catch {
      return false;
    }
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
          void persistMeaningfulDraft(draft, 'autosave_short');
        } else {
          markDraftReservationFromSnapshot(draft, 'autosave_blank');
        }
      } catch {}
    }, 1200);

    remoteDraftTimerRef.current = setTimeout(() => {
      try {
        if (isDraftSuppressed(oid)) return;
        const draft = buildDraftSnapshot();
        if (hasStartedWork()) {
          void persistMeaningfulDraft(draft, 'autosave_long');
        } else {
          markDraftReservationFromSnapshot(draft, 'autosave_blank_long');
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


  useEffect(() => {
    if (creating) return undefined;
    if (!oid) return undefined;

    const saveLocalOnExit = () => {
      try { persistCurrentDraftLocalSync('pagehide_or_hidden_local_first'); } catch {}
    };
    const saveLocalOnHidden = () => {
      try {
        if (document.visibilityState === 'hidden') saveLocalOnExit();
      } catch {}
    };

    try { window.addEventListener('pagehide', saveLocalOnExit); } catch {}
    try { window.addEventListener('beforeunload', saveLocalOnExit); } catch {}
    try { document.addEventListener('visibilitychange', saveLocalOnHidden); } catch {}

    return () => {
      try { window.removeEventListener('pagehide', saveLocalOnExit); } catch {}
      try { window.removeEventListener('beforeunload', saveLocalOnExit); } catch {}
      try { document.removeEventListener('visibilitychange', saveLocalOnHidden); } catch {}
    };
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
    const nextArkaRecordedPaid = Number((Number(arkaRecordedPaid || 0) + applied).toFixed(2));

    if (payMethod === 'CASH') {
      const clientActionId = pendingUpfrontCashPayment?.clientActionId || (() => {
        try { return (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `pranimi_pay_${Date.now()}`; } catch { return `pranimi_pay_${Date.now()}`; }
      })();
      setPendingUpfrontCashPayment({
        clientActionId,
        localOrderId: String(oid || ''),
        amount: applied,
        actor: { pin: pinData.pin, name: pinData.name, role: pinData.role },
        code: normalizeCode(codeRaw),
        name: name.trim(),
        note: `PAGESA ${applied}€ • #${normalizeCode(codeRaw)} • ${name.trim()}`,
      });
    }

    setClientPaid(newPaid);
    if (payMethod === 'CASH') setArkaRecordedPaid(nextArkaRecordedPaid);
    setShowPaySheet(false);
  }

  function numericDbOrderId(value) {
    const raw = String(value ?? '').trim();
    if (!/^\d+$/.test(raw)) return null;
    const num = Number(raw);
    return Number.isSafeInteger(num) && num > 0 ? num : null;
  }

  function readPendingUpfrontCashAmount() {
    const amt = Number(pendingUpfrontCashPayment?.amount || 0);
    return Number.isFinite(amt) && amt > 0 ? Number(amt.toFixed(2)) : 0;
  }

  async function recordPranimiUpfrontCashAfterDbSave({ dbOrderId, payment, payload }) {
    const realOrderId = numericDbOrderId(dbOrderId);
    const amount = Number(payment?.amount || 0);
    const actorPay = payment?.actor || {};
    if (!realOrderId) throw new Error('ORDER_ID_INVALID_FOR_ARKA_UPFRONT_PAYMENT');
    if (!(amount > 0)) return null;
    if (!actorPay?.pin) throw new Error('ACTOR_PIN_REQUIRED_FOR_ARKA_UPFRONT_PAYMENT');

    const codeForPayment = normalizeCode(payload?.code || payment?.code || codeRaw);
    const clientNameForPayment = String(payload?.client_name || payment?.name || name || '').trim();
    const clientActionId = String(payment?.clientActionId || '').trim() || `${realOrderId}_${amount.toFixed(2)}_${actorPay.pin}`;
    const extId = `BASE_ORDER_PAYMENT:${realOrderId}:${amount.toFixed(2)}:${actorPay.pin}:${clientActionId}`;
    const arkaResult = await recordCashMove({
      externalId: extId,
      orderId: realOrderId,
      order_id: realOrderId,
      code: codeForPayment,
      orderCode: codeForPayment,
      name: clientNameForPayment,
      clientName: clientNameForPayment,
      amount,
      note: payment?.note || `PAGESA ${amount}€ • #${codeForPayment} • ${clientNameForPayment}`,
      source: 'PRANIMI_UPFRONT_ORDER_PAY',
      method: 'CASH',
      type: 'IN',
      actor: { pin: actorPay.pin, name: actorPay.name, role: actorPay.role },
      created_by_pin: actorPay.pin,
      created_by_name: actorPay.name,
      idempotencyKey: extId,
    });
    if (!arkaResult?.ok) throw new Error(arkaResult?.error || 'ARKA_PAYMENT_FAILED');
    if (arkaResult?.needsManualRepair) throw new Error(arkaResult?.repairCode || 'ARKA_NEEDS_MANUAL_REPAIR');
    return arkaResult;
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

  async function findBaseClientByNameAndPhone({ name: rawName, phone: rawPhone, clientsIndex: indexArg, allowLive = true, liveTimeoutMs = 700, currentCode = null } = {}) {
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
      if (isSameCodeAsCurrentPranimiDraft({ code: codeNum }, currentCode)) return;
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

  async function syncClientMasterForCode({ code, name: rawName, phone: rawPhone, photoUrl, selected, noPhone: forceNoPhone = false, clientMode = '', noPhonePlaceholder = '' } = {}) {
    const requestedCodeNum = Number(normalizeCode(code) || 0);
    if (!requestedCodeNum) return null;

    const noPhoneMode = !!forceNoPhone || isNoPhonePlaceholder(rawPhone || noPhonePlaceholder);
    const placeholderPhone = noPhoneMode ? (noPhonePlaceholder || buildNoPhonePlaceholderPhone(requestedCodeNum)) : '';
    const phoneDigits = noPhoneMode ? '' : normalizeMatchPhone(rawPhone || '');
    const hasValidPhone = !noPhoneMode && isValidClientPhoneDigits(phoneDigits);
    const phoneFull = noPhoneMode ? placeholderPhone : (hasValidPhone ? `${phonePrefix}${phoneDigits}` : '');
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
        phone: isNoPhonePlaceholder(row?.phone || '') ? '' : String(row?.phone || phoneFull || '').trim(),
        name: rowName(row) || safeName,
        codeConflict: true,
        conflictReason: reason,
        requestedCode: requestedCodeNum,
        existingCode: existingCode != null ? existingCode : null,
      };
    };

    const normalizeClientOut = (row = {}, reason = '', flags = {}) => {
      const permanentCode = normalizeCode(row?.code ?? null);
      const orderCode = normalizeCode(flags?.orderCode ?? requestedCodeNum);
      return {
        id: String(row?.id || selectedId || '').trim() || null,
        code: normalizeCode(row?.code ?? requestedCodeNum),
        permanentCode,
        orderCode,
        allowOrderCodeDifferentFromClientCode: !!flags.allowOrderCodeDifferentFromClientCode,
        clientCodeDiffersFromOrderCode: !!(permanentCode != null && orderCode != null && String(permanentCode) !== String(orderCode)),
        phone: noPhoneMode ? placeholderPhone : String(row?.phone || phoneFull || '').trim(),
        name: rowName(row) || safeName,
        matchReason: reason || clientMode || (noPhoneMode ? 'no_phone_placeholder' : 'client_master'),
        no_phone_placeholder: noPhoneMode,
        createdInThisFlow: !!flags.createdInThisFlow,
      };
    };

    // Existing clients keep their permanent client.code. A NEW order may have a different order code.
    // Do not block final order save just because client.code != order.code. Link by client_id/phone instead.
    const linkExistingClientForOrder = async (row = {}, reason = 'existing_client_for_new_order') => {
      const targetId = String(row?.id || selectedId || '').trim();
      if (!targetId) return null;
      const patch = {
        full_name: safeName || rowName(row) || null,
        first_name: parts.first_name || safeName || null,
        last_name: parts.last_name || null,
        updated_at: new Date().toISOString(),
      };
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
      return normalizeClientOut(out, reason, {
        allowOrderCodeDifferentFromClientCode: true,
        orderCode: requestedCodeNum,
      });
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
      return normalizeClientOut(out, reason);
    };

    const insertClient = async (reason = noPhoneMode ? 'no_phone_placeholder' : 'phone_new_client') => {
      if (!phoneFull) throw new Error('CLIENT_PHONE_REQUIRED_FOR_MASTER_ROW');
      const insertRow = {
        code: requestedCodeNum,
        full_name: safeName || null,
        first_name: parts.first_name || safeName || null,
        last_name: parts.last_name || null,
        phone: phoneFull,
        updated_at: new Date().toISOString(),
      };
      if (photoUrl) insertRow.photo_url = photoUrl;

      const { data: inserted, error: insertErr } = await supabase
        .from('clients')
        .insert(insertRow)
        .select('id, code, full_name, first_name, last_name, phone, photo_url')
        .maybeSingle();
      if (insertErr) {
        const msg = String(insertErr?.message || insertErr?.details || insertErr || '').toLowerCase();
        if (/duplicate|23505|unique/.test(msg)) {
          if (hasValidPhone && phoneFull) {
            const { data: byPhone, error: byPhoneErr } = await supabase
              .from('clients')
              .select('id, code, full_name, first_name, last_name, phone, photo_url, updated_at')
              .eq('phone', phoneFull)
              .order('updated_at', { ascending: false })
              .limit(1)
              .maybeSingle();
            if (byPhoneErr) throw byPhoneErr;
            if (byPhone?.id) return normalizeClientOut(byPhone, 'phone_duplicate_existing_client', {
              allowOrderCodeDifferentFromClientCode: true,
              orderCode: requestedCodeNum,
            });
          }
          const { data: byCode, error: byCodeErr } = await supabase
            .from('clients')
            .select('id, code, full_name, first_name, last_name, phone, photo_url')
            .eq('code', requestedCodeNum)
            .limit(1)
            .maybeSingle();
          if (byCodeErr) throw byCodeErr;
          if (byCode?.id) return updateClient(byCode, requestedCodeNum, reason);
        }
        throw insertErr;
      }
      return normalizeClientOut(inserted || insertRow, reason, { createdInThisFlow: !!inserted?.id });
    };

    // 1) Selected client is the only phone-independent hard lock.
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
        return linkExistingClientForOrder(
          selectedRow || { id: selectedId, code: lockedCode, phone: selected?.phone || phoneFull, full_name: selected?.name || safeName },
          'selected_existing_client_for_new_order_code'
        );
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

    const strongHits = phoneHits.filter((row) => isStrongBaseClientNamePhoneMatch(row, { name: safeName, phone: phoneFull }));
    if (strongHits.length > 0) {
      const strongRow = strongHits[0];
      const permanentCode = normalizeCode(strongRow?.code ?? null);
      if (permanentCode != null && String(permanentCode) !== String(requestedCodeNum)) {
        return linkExistingClientForOrder(strongRow, 'phone_match_existing_client_for_new_order_code');
      }
      return updateClient(strongRow, permanentCode ?? requestedCodeNum, 'phone_match');
    }

    if (phoneHits.length === 1) {
      const phoneOnlyRow = phoneHits[0];
      const phoneOnlyCode = normalizeCode(phoneOnlyRow?.code ?? null);
      if (phoneOnlyCode != null && String(phoneOnlyCode) !== String(requestedCodeNum)) {
        return linkExistingClientForOrder(phoneOnlyRow, 'phone_only_existing_client_for_new_order_code');
      }
      return updateClient(phoneOnlyRow, phoneOnlyCode ?? requestedCodeNum, 'phone_match');
    }

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
      const existingIsNoPhone = isNoPhonePlaceholder(existingByCode?.phone || '');
      if (noPhoneMode && (!existingPhone || existingIsNoPhone)) return updateClient(existingByCode, requestedCodeNum, 'code_owner_no_phone');
      if (!noPhoneMode && (!existingPhone || existingPhone === phoneDigits)) return updateClient(existingByCode, requestedCodeNum, 'code_owner');
      return buildConflict(existingByCode, 'CODE_OWNER_PHONE_CONFLICT');
    }

    return await insertClient(noPhoneMode ? 'no_phone_placeholder' : 'phone_new_client');
  }

  async function handleContinue() {
    if (!validateBeforeContinue()) return;
    if (savingContinue || photoUploading) return;

    try {
      if (!isBridgeEditMode && !noPhone) {
        const pendingMatch = await detectExistingClientSmart({ name, phone, clientsIndex, allowLive: pranimiIsOnline(), liveTimeoutMs: PRANIMI_CONTINUE_CLIENT_LOOKUP_MS, currentCode: getCurrentPranimiCodeNumber() });
        if (pendingMatch && !isCandidateCurrentPranimiCode(pendingMatch.candidate) && !sameSelectedClientCode(pendingMatch.candidate) && String(clientMatchDecision?.matchKey || '') !== String(pendingMatch.matchKey || '')) {
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
      const pendingUpfrontAmount = readPendingUpfrontCashAmount();
      const hasPendingUpfrontCash = !!(payMethod === 'CASH' && pendingUpfrontAmount > 0 && pendingUpfrontCashPayment?.actor?.pin);
      const paidForInitialDbSave = hasPendingUpfrontCash ? Math.max(0, Number((Number(clientPaid || 0) - pendingUpfrontAmount).toFixed(2))) : Number((Number(clientPaid || 0)).toFixed(2));
      const arkaForInitialDbSave = hasPendingUpfrontCash ? Math.max(0, Number((Number(arkaRecordedPaid || 0) - pendingUpfrontAmount).toFixed(2))) : Number((Number(arkaRecordedPaid || 0)).toFixed(2));
      const debtForInitialDbSave = Math.max(0, Number((Number(totalEuro || 0) - paidForInitialDbSave).toFixed(2)));

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
          code: formatKod(getActivePranimiCodeForDisplay(), netState.ok),
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
          paid: paidForInitialDbSave,
          debt: debtForInitialDbSave,
          method: payMethod,
          arkaRecordedPaid: arkaForInitialDbSave,
        },
        notes: notes || '',
      };

      const urlClientPrefill = (() => {
        const raw = (newOrderUrlClientRef.current && typeof newOrderUrlClientRef.current === 'object') ? newOrderUrlClientRef.current : {};
        const urlClientCode = normalizeCode(raw?.code || null);
        if (urlClientCode == null) return null;
        return {
          id: null,
          code: urlClientCode,
          name: String(raw?.name || name || '').trim(),
          phone: String(raw?.phone || getCanonicalClientPhone() || '').trim(),
        };
      })();

      const onlineForClientLookup = pranimiIsOnline();
      const currentCanonicalPhone = getCanonicalClientPhone();
      const currentPhoneDigits = normalizeMatchPhone(currentCanonicalPhone || phone || '');
      const canUsePhoneForClientMatch = !noPhone && isValidClientPhoneDigits(currentPhoneDigits);
      const rawSelectedClientId = String(selectedClient?.id || '').trim();
      const rawSelectedClientCode = normalizeCode(selectedClient?.code || null);
      const rejectedNullSelectedClientCode = !!(!isBaseEdit && selectedClient && rawSelectedClientCode != null && !rawSelectedClientId);
      if (rejectedNullSelectedClientCode) {
        appendPranimiCodeDebug('selected_client_code_rejected_id_null', {
          local_oid: stableLocalOid || String(oid || ''),
          pin: actor?.pin || actor?.pinCode || actor?.id || null,
          online: onlineForClientLookup,
          draft_code_raw: normalizeCode(codeRawRef.current || codeRaw || null),
          selected_client_id: null,
          selected_client_code: rawSelectedClientCode,
          final_code: normalizeCode(codeRawRef.current || codeRaw || null),
          final_code_reason: 'SELECTED_CLIENT_CODE_REJECTED_ID_NULL',
        });
      }

      let resolvedSelectedClient = (selectedClient && (isBaseEdit || (rawSelectedClientId && isStrongBaseClientNamePhoneMatch(selectedClient, { name, phone: currentCanonicalPhone })))) ? selectedClient : null;
      let returningClient = null;
      let finalNamePhoneClient = null;
      let finalLiveLookupFailed = false;
      let finalLiveLookupError = null;

      const showExistingPhonePromptAndStop = (candidate) => {
        const codeNum = normalizeCode(candidate?.code || null);
        const candId = String(candidate?.id || '').trim();
        if (codeNum == null) return false;
        if (isCandidateCurrentPranimiCode(candidate)) {
          appendPranimiCodeDebug('existing_phone_client_prompt_self_match_skipped', {
            local_oid: stableLocalOid || String(oid || ''),
            phone_digits: currentPhoneDigits || null,
            selected_client_id: candId || null,
            selected_client_code: codeNum,
            final_code: getCurrentPranimiCodeNumber(),
            final_code_reason: 'CURRENT_DRAFT_SELF_MATCH_IGNORED',
          });
          return false;
        }
        const prompt = {
          open: true,
          reason: 'phone_exact',
          phoneDigits: currentPhoneDigits,
          fullName: normalizeMatchName(name || ''),
          matchKey: buildClientMatchKey({ reason: 'phone_exact', phoneDigits: currentPhoneDigits, fullName: normalizeMatchName(name || ''), code: codeNum, id: candId }),
          candidate: {
            id: candId || null,
            code: String(codeNum),
            name: String(candidate?.name || candidate?.full_name || candidate?.client_name || [candidate?.first_name, candidate?.last_name].filter(Boolean).join(' ') || '').trim(),
            phone: String(candidate?.phone || candidate?.client_phone || currentCanonicalPhone || '').trim(),
            photo_url: String(candidate?.photo_url || candidate?.client_photo_url || candidate?.photoUrl || '').trim(),
          },
        };
        const decisionSameMatch = String(clientMatchDecision?.matchKey || '') === String(prompt.matchKey || '');
        if (decisionSameMatch && clientMatchDecision?.mode === 'use_existing') {
          if (candId) {
            resolvedSelectedClient = prompt.candidate;
            setSelectedClient(prompt.candidate);
            return false;
          }
          appendPranimiCodeDebug('selected_client_code_rejected_id_null', {
            local_oid: stableLocalOid || String(oid || ''),
            selected_client_id: null,
            selected_client_code: codeNum,
            final_code: normalizeCode(codeRawRef.current || codeRaw || null),
            final_code_reason: 'SELECTED_CLIENT_CODE_REJECTED_ID_NULL',
          });
          return false;
        }
        setClientMatchPrompt(prompt);
        appendPranimiCodeDebug('existing_phone_client_prompted', {
          local_oid: stableLocalOid || String(oid || ''),
          phone_digits: currentPhoneDigits || null,
          selected_client_id: candId || null,
          selected_client_code: codeNum,
          final_code: normalizeCode(codeRawRef.current || codeRaw || null),
          final_code_reason: 'AWAITING_EXISTING_PHONE_CLIENT_CONFIRMATION',
        });
        setSavingContinue(false);
        return true;
      };

      if (!isBaseEdit && canUsePhoneForClientMatch && !resolvedSelectedClient?.id) {
        try {
          finalNamePhoneClient = await findBaseClientByNameAndPhone({
            name,
            phone: currentCanonicalPhone,
            clientsIndex,
            allowLive: onlineForClientLookup,
            liveTimeoutMs: PRANIMI_CONTINUE_CLIENT_LOOKUP_MS,
            currentCode: getCurrentPranimiCodeNumber(),
          });
        } catch (err) {
          finalLiveLookupFailed = onlineForClientLookup;
          finalLiveLookupError = err;
        }

        if (finalNamePhoneClient?.code != null && !isCandidateCurrentPranimiCode(finalNamePhoneClient) && showExistingPhonePromptAndStop(finalNamePhoneClient)) return;
      }

      if (!isBaseEdit && canUsePhoneForClientMatch && !resolvedSelectedClient?.id && !finalLiveLookupFailed) {
        try {
          returningClient = await findReturningClientByPhone(phone, {
            allowLive: onlineForClientLookup,
            liveTimeoutMs: PRANIMI_CONTINUE_CLIENT_LOOKUP_MS,
          });
        } catch (err) {
          finalLiveLookupFailed = onlineForClientLookup;
          finalLiveLookupError = err;
        }
        if (returningClient?.code != null && showExistingPhonePromptAndStop(returningClient)) return;
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

      if (!resolvedSelectedClient && urlClientPrefill?.code != null && isBaseEdit) {
        const urlPrefillStrong = isStrongBaseClientNamePhoneMatch(urlClientPrefill, { name, phone: getCanonicalClientPhone() });
        if (urlPrefillStrong || isBaseEdit) resolvedSelectedClient = urlClientPrefill;
      }

      const resolvedSelectedClientId = String(resolvedSelectedClient?.id || '').trim() || null;
      const resolvedSelectedClientCodeNum = resolvedSelectedClientId ? normalizeCode(resolvedSelectedClient?.code ?? (isBaseEdit ? urlClientPrefill?.code : null) ?? null) : null;
      const resolvedSelectedClientCode = resolvedSelectedClientCodeNum != null ? String(resolvedSelectedClientCodeNum) : '';
      const declinedPhoneCandidate = null;
      const clientSaveMode = noPhone
        ? 'NO_PHONE_PLACEHOLDER_CLIENT'
        : (resolvedSelectedClientId ? 'HAS_PHONE_EXISTING_CLIENT' : 'HAS_PHONE_NEW_CLIENT');

      let resolvedCodeRaw = codeRawRef.current || codeRaw;
      let finalCodeReason = resolvedSelectedClientCode ? 'VERIFIED_EXISTING_PHONE_CLIENT' : (noPhone ? 'NO_PHONE_PLACEHOLDER_CLIENT' : 'SESSION_RESERVED_NEW_CLIENT');
      if (resolvedSelectedClientCode) resolvedCodeRaw = resolvedSelectedClientCode;
      const sessionReservedCode = !resolvedSelectedClientCode ? readSessionReservedBaseCode(stableLocalOid || shadowOrderId || oid) : null;
      if (sessionReservedCode != null && String(normalizeCode(resolvedCodeRaw) || '') !== String(sessionReservedCode)) {
        appendPranimiCodeDebug('session_reserved_code_enforced_before_save', {
          local_oid: stableLocalOid || String(shadowOrderId || oid || ''),
          draft_code_raw: normalizeCode(resolvedCodeRaw),
          reserved_displayed_code: sessionReservedCode,
          final_code_reason: 'SESSION_RESERVED_CODE_ENFORCED',
        });
        resolvedCodeRaw = String(sessionReservedCode);
        codeRawRef.current = resolvedCodeRaw;
        setCodeRaw(resolvedCodeRaw);
        finalCodeReason = 'SESSION_RESERVED_CODE_ENFORCED';
      }
      let normCodeNow = formatKod(normalizeCode(resolvedCodeRaw), netState.ok);

      const markReadyDebugBase = {
        urlCode: String(newOrderUrlClientRef.current?.code || '').trim() || null,
        selectedClient: selectedClient ? { id: selectedClient?.id || null, code: normalizeCode(selectedClient?.code || null), name: selectedClient?.name || '', phone: selectedClient?.phone || '' } : null,
        returningClient: returningClient ? { id: returningClient?.id || null, code: normalizeCode(returningClient?.code || null), name: returningClient?.name || '', phone: returningClient?.phone || '' } : null,
        finalNamePhoneClient: finalNamePhoneClient ? { id: finalNamePhoneClient?.id || null, code: normalizeCode(finalNamePhoneClient?.code || null), name: finalNamePhoneClient?.name || '', phone: finalNamePhoneClient?.phone || '' } : null,
        resolvedSelectedClient: resolvedSelectedClient ? { id: resolvedSelectedClient?.id || null, code: normalizeCode(resolvedSelectedClient?.code || null), name: resolvedSelectedClient?.name || '', phone: resolvedSelectedClient?.phone || '' } : null,
        resolvedSelectedClientCode: resolvedSelectedClientCode || null,
        rejectedNullSelectedClientCode,
        draft_code_raw: normalizeCode(codeRawRef.current || codeRaw || null),
        final_code_reason: finalCodeReason,
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
          finalCodeReason = pranimiIsOnline() ? 'SESSION_RESERVED_NEW_CLIENT' : 'OFFLINE_LOCAL_RESERVED';
          appendPranimiCodeDebug('session_reserved_code_used_on_save', { local_oid: stableLocalOid || String(oid || ''), final_code: normalizeCode(resolvedCodeRaw), final_code_reason: finalCodeReason });
          if (pranimiIsOnline()) {
            try { setNetState({ ok: true, reason: null }); } catch {}
            try { localStorage.removeItem(OFFLINE_MODE_KEY); } catch {}
            try { setOfflineMode(false); } catch {}
            try { setShowOfflinePrompt(false); } catch {}
          } else {
            try { setNetState({ ok: false, reason: 'NO_INTERNET' }); } catch {}
            try { localStorage.setItem(OFFLINE_MODE_KEY, '1'); } catch {}
            try { setOfflineMode(true); } catch {}
            try { setShowOfflinePrompt(true); } catch {}
          }
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
          if (!resolvedSelectedClientCode) {
            appendPranimiCodeDebug('session_reserved_code_changed_blocked', {
              local_oid: stableLocalOid || String(oid || ''),
              requested_code: normalizeCode(resolvedCodeRaw),
              verified_code: verifiedCode,
              final_code_reason: 'SESSION_RESERVED_CODE_CHANGED_BLOCKED',
            });
            alert('KUJDES: Kodi i shfaqur nuk u verifikua si i njëjtë. Ruajtja u ndal për siguri. Hape PRANIMIN prapë dhe provo përsëri.');
            setSavingContinue(false);
            return;
          }
          resolvedCodeRaw = String(verifiedCode);
          codeRawRef.current = resolvedCodeRaw;
          setCodeRaw(resolvedCodeRaw);
        }

        normCodeNow = formatKod(normalizeCode(resolvedCodeRaw), true);
        finalCodeReason = resolvedSelectedClientCode
          ? 'VERIFIED_EXISTING_PHONE_CLIENT'
          : (noPhone ? 'NO_PHONE_PLACEHOLDER_CLIENT' : (verified?.offline ? 'OFFLINE_LOCAL_RESERVED' : 'SESSION_RESERVED_NEW_CLIENT'));

        try {
          logDebugEvent('pranimi_code_verify_result', {
            requestedCode: normalizeCode(codeRaw),
            resolvedCode: normalizeCode(resolvedCodeRaw),
            changed: !!verified?.changed,
            verified: !!verified?.verified,
            offline: !!verified?.offline,
            isBaseEdit: !!isBaseEdit,
            editTargetId: editTargetId || null,
            final_code_reason: finalCodeReason,
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
        finalCodeReason = 'OFFLINE_LOCAL_RESERVED';
        normCodeNow = formatKod(normalizeCode(resolvedCodeRaw), true);
      }

      if (!normCodeNow || normCodeNow === '0' || normCodeNow === '—' || normCodeNow === '…') {
        alert('DB ERROR: Kodi final mungon pas verifikimit.');
        setSavingContinue(false);
        return;
      }

      const browserOfflineForFinalSave = (() => {
        try { return typeof navigator !== 'undefined' && navigator.onLine === false; } catch { return false; }
      })();
      const appOfflineForFinalSave = !!(offlineMode && !pranimiIsOnline());
      // Code verification can fall back to OFFLINE_LOCAL_RESERVED when the code-check RPC/auth ping is slow,
      // but that must not force a local-only final save while the browser/app is actually online.
      // Final order save should be gated by real network/app state; DB verify after upsert remains the source of truth.
      const canAttemptDirectDbFinalSave = !(browserOfflineForFinalSave || appOfflineForFinalSave);
      if (verifiedCodeResult?.offline && canAttemptDirectDbFinalSave) {
        finalCodeReason = 'LOCAL_RESERVED_DIRECT_DB_SAVE';
      }

      const nowIso = new Date().toISOString();
      const persistedClientCode = Number(normCodeNow || 0) || null;
      try {
        order.code = persistedClientCode;
        order.client_code = persistedClientCode;
        if (order.client && typeof order.client === 'object') order.client.code = persistedClientCode;
      } catch {}
      const canonicalSelectedName = String(resolvedSelectedClient?.name || '').trim();
      const canonicalSelectedPhone = noPhone ? '' : String(resolvedSelectedClient?.phone || '').trim();
      const finalClientName = canonicalSelectedName || (name?.trim() || null);
      const noPhoneClientMasterPhone = noPhone ? buildNoPhonePlaceholderPhone(persistedClientCode) : '';
      const finalClientPhone = noPhone ? '' : (canonicalSelectedPhone || getCanonicalClientPhone());
      const finalClientPhoneDigits = noPhone ? '' : normalizeMatchPhone(finalClientPhone || '');

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
        paid_cash: paidForInitialDbSave,
        is_paid_upfront: paidForInitialDbSave > 0,
        note: notes || null,
        updated_at: nowIso,
        data: {
          ...order,
          status: targetStatus,
          updated_at: nowIso,
          code: persistedClientCode,
          client_name: finalClientName,
          client_phone: finalClientPhone,
          phone_digits: finalClientPhoneDigits,
          no_phone: !!noPhone,
          client_master_phone: noPhoneClientMasterPhone || null,
          client_code: persistedClientCode,
          reserved_displayed_code: persistedClientCode,
          saved_order_code: persistedClientCode,
          phone_match_declined: false,
          client_master_mode: clientSaveMode,
          existing_phone_client_id: declinedPhoneCandidate?.id || null,
          existing_phone_client_code: declinedPhoneCandidate?.code || null,
          existing_phone_client_name: declinedPhoneCandidate?.name || null,
          existing_phone_client_phone: declinedPhoneCandidate?.phone || null,
          local_sync_status: canAttemptDirectDbFinalSave ? 'DB_VERIFY_PENDING' : 'LOCAL / NOT SYNCED',
          pranimi_code_lifecycle: {
            save_attempt_id: (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `save_${Date.now()}_${Math.random().toString(16).slice(2)}`,
            local_oid: stableLocalOid || String(shadowOrderId || oid),
            pin: actor?.pin || actor?.pinCode || actor?.id || null,
            online: onlineForClientLookup,
            draft_code_raw: normalizeCode(codeRawRef.current || codeRaw || null),
            selected_client_id: resolvedSelectedClientId || null,
            selected_client_code: resolvedSelectedClientCode || null,
            selected_client_code_rejected_id_null: !!rejectedNullSelectedClientCode,
            phone_match_declined: false,
            client_master_mode: clientSaveMode,
            existing_phone_client_id: declinedPhoneCandidate?.id || null,
            existing_phone_client_code: declinedPhoneCandidate?.code || null,
            existing_phone_client_name: declinedPhoneCandidate?.name || null,
            final_code: persistedClientCode,
            reserved_displayed_code: persistedClientCode,
            saved_order_code: persistedClientCode,
            final_code_lifecycle: persistedClientCode,
            final_code_reason: finalCodeReason,
            db_verify_state: canAttemptDirectDbFinalSave ? 'DB_VERIFY_PENDING' : 'LOCAL / NOT SYNCED',
          },
          pieces: Number(copeCount || 0),
          m2_total: Number(totalM2 || 0),
          price_total: Number(totalEuro || 0),
          paid_cash: paidForInitialDbSave,
          is_paid_upfront: paidForInitialDbSave > 0,
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

      appendPranimiCodeDebug('order_started', {
        save_attempt_id: payload?.data?.pranimi_code_lifecycle?.save_attempt_id || null,
        local_oid: stableLocalOid || String(shadowOrderId || oid),
        pin: actor?.pin || actor?.pinCode || actor?.id || null,
        code: persistedClientCode,
        client_name: finalClientName || '',
        client_phone: finalClientPhone || '',
      });
      appendPranimiCodeDebug('code_assigned', {
        save_attempt_id: payload?.data?.pranimi_code_lifecycle?.save_attempt_id || null,
        local_oid: stableLocalOid || String(shadowOrderId || oid),
        final_code: persistedClientCode,
        final_code_reason: finalCodeReason,
      });

      appendPranimiCodeDebug('pranimi_final_code_selected', {
        save_attempt_id: payload?.data?.pranimi_code_lifecycle?.save_attempt_id || null,
        local_oid: stableLocalOid || String(shadowOrderId || oid),
        pin: actor?.pin || actor?.pinCode || actor?.id || null,
        online: onlineForClientLookup,
        draft_code_raw: payload?.data?.pranimi_code_lifecycle?.draft_code_raw || null,
        selected_client_id: resolvedSelectedClientId || null,
        selected_client_code: resolvedSelectedClientCode || null,
        phone_match_declined: false,
        client_master_mode: clientSaveMode,
        existing_phone_client_id: declinedPhoneCandidate?.id || null,
        existing_phone_client_code: declinedPhoneCandidate?.code || null,
        final_code: persistedClientCode,
        final_code_reason: finalCodeReason,
        db_verify_state: payload?.data?.pranimi_code_lifecycle?.db_verify_state || null,
      });

      const verifiedOwner = verifiedCodeResult?.owner && typeof verifiedCodeResult.owner === 'object' ? verifiedCodeResult.owner : null;
      const verifiedOwnerPhone = normalizeMatchPhone(verifiedOwner?.phone || '');
      const verifiedOwnerStrongMatch = !noPhone && verifiedOwner?.id &&
        isValidClientPhoneDigits(finalClientPhoneDigits) &&
        verifiedOwnerPhone &&
        verifiedOwnerPhone === finalClientPhoneDigits &&
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
      let clientMasterSyncBlockingFailure = false;
      let clientMasterSyncBlockingError = null;
      try {
        const canTouchClientMasterBeforeOrder = !!(isBaseEdit || resolvedSelectedClientId);
        const canTouchClientMasterOnline = canAttemptDirectDbFinalSave;
        if (canTouchClientMasterBeforeOrder && canTouchClientMasterOnline) {
          let masterSyncFailed = false;
          let masterSyncError = null;
          const masterSyncPhoneDigits = noPhone ? '' : normalizeMatchPhone(finalClientPhone || getCanonicalClientPhone() || phone || '');
          const mustVerifyMasterClientBeforeSave = !isBaseEdit && (
            noPhone ||
            (isValidClientPhoneDigits(masterSyncPhoneDigits) && !resolvedSelectedClientId)
          );

          syncedClientMaster = await withSupabaseTimeout(
            syncClientMasterForCode({
              code: persistedClientCode || normCodeNow,
              name: finalClientName || '',
              phone: finalClientPhone || '',
              photoUrl: clientPhotoUrl || '',
              selected: resolvedSelectedClient,
              noPhone: !!noPhone,
              clientMode: clientSaveMode,
              noPhonePlaceholder: noPhoneClientMasterPhone,
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
            clientMasterSyncBlockingFailure = false;
            clientMasterSyncBlockingError = masterSyncError || new Error('CLIENT_MASTER_SYNC_FAILED');
            try {
              payload.data.client_master_sync_state = 'DEFERRED_OR_FAILED_BEFORE_ORDER_VERIFY';
              payload.data.client_master_sync_error = String(masterSyncError?.message || masterSyncError || 'CLIENT_MASTER_SYNC_FAILED');
            } catch {}
            try {
              logDebugEvent('pranimi_client_master_sync_required_failed', {
                code: persistedClientCode || normCodeNow || null,
                phoneDigits: masterSyncPhoneDigits || null,
                clientMode: clientSaveMode,
                hasSelectedClientId: !!resolvedSelectedClientId,
                hasSelectedClientCode: !!resolvedSelectedClientCode,
                errorName: masterSyncError?.name || null,
                errorMessage: masterSyncError?.message || String(masterSyncError || ''),
              });
            } catch {}
          }

          if (!masterSyncFailed && mustVerifyMasterClientBeforeSave && !syncedClientMaster?.id) {
            clientMasterSyncBlockingFailure = false;
            clientMasterSyncBlockingError = new Error('CLIENT_MASTER_SYNC_EMPTY_RESULT');
            try {
              payload.data.client_master_sync_state = 'DEFERRED_OR_EMPTY_BEFORE_ORDER_VERIFY';
              payload.data.client_master_sync_error = 'CLIENT_MASTER_SYNC_EMPTY_RESULT';
            } catch {}
            try {
              logDebugEvent('pranimi_client_master_sync_empty_result', {
                code: persistedClientCode || normCodeNow || null,
                phoneDigits: masterSyncPhoneDigits || null,
                clientMode: clientSaveMode,
                hasSelectedClientId: !!resolvedSelectedClientId,
              });
            } catch {}
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
            const syncedClientMasterPhoneRaw = String(syncedClientMaster?.phone || finalClientPhone || '').trim() || finalClientPhone;
            const syncedClientMasterPhone = noPhone || isNoPhonePlaceholder(syncedClientMasterPhoneRaw) ? '' : syncedClientMasterPhoneRaw;

            payload.client_id = syncedClientMaster.id;
            payload.client_name = syncedClientMasterName || payload.client_name || null;
            payload.client_phone = syncedClientMasterPhone || payload.client_phone || '';

            const syncedClientCode = normalizeCode(syncedClientMaster?.code ?? persistedClientCode) || persistedClientCode;
            const allowExistingClientDifferentOrderCode = !!(
              syncedClientMaster?.allowOrderCodeDifferentFromClientCode ||
              syncedClientMaster?.clientCodeDiffersFromOrderCode
            );
            if (syncedClientCode && String(syncedClientCode) !== String(persistedClientCode) && !allowExistingClientDifferentOrderCode) {
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
            payload.data.client_phone = noPhone ? '' : (syncedClientMasterPhone || payload.data.client_phone || '');
            payload.data.no_phone = !!noPhone;
            payload.data.client_master_phone = noPhone ? (noPhoneClientMasterPhone || syncedClientMaster?.phone || null) : null;
          }
        }
      } catch {}

      const finishLocalOnlyWarning = (warning = {}) => {
        const finishedId = String(oid || '').trim();
        if (finishedId) suppressDraftId(finishedId);
        try { if (draftTimer.current) clearTimeout(draftTimer.current); } catch {}
        try { if (remoteDraftTimerRef.current) clearTimeout(remoteDraftTimerRef.current); } catch {}
        try { removeDraftLocal(finishedId); } catch {}
        try {
          draftRemoteCacheRef.current = {
            version: PRANIMI_DRAFT_GUARD_VERSION,
            ts: Date.now(),
            items: (Array.isArray(draftRemoteCacheRef.current?.items) ? draftRemoteCacheRef.current.items : []).filter((d) => String(d?.id || '') !== finishedId),
          };
        } catch {}
        setDrafts((prev) => (Array.isArray(prev) ? prev.filter((d) => String(d?.id || '') !== finishedId) : []));
        clearActiveEditBridge();
        try { clearCurrentSessionLocal(); } catch {}
        try { sessionStorage.setItem(RESET_ON_SHOW_KEY, '1'); } catch {}
        try { codeRawRef.current = ''; } catch {}
        try { setPendingNavTo(targetNav); } catch {}
        setLocalSyncWarning({
          severity: warning?.severity || 'yellow',
          title: warning?.title || 'RUAJTUR LOKALISHT — DO SINKRONIZOHET KUR TË KETË INTERNET',
          subtitle: warning?.subtitle || 'LOCAL / NOT SYNCED',
          status_label: warning?.status_label || warning?.subtitle || 'LOCAL / NOT SYNCED',
          message: warning?.message || 'KJO ORDER ENDE NUK KA HYRË NË DB',
          problem_title: warning?.problem_title || 'PROBLEM ME ORDER — NUK KA HYRË NË DB',
          allow_sms_after_ack: !!warning?.allow_sms_after_ack,
          is_base_edit: !!warning?.is_base_edit,
          targetNav,
          payload,
          code: persistedClientCode,
          local_oid: stableLocalOid || String(shadowOrderId || oid),
          save_attempt_id: payload?.data?.pranimi_code_lifecycle?.save_attempt_id || null,
          final_code_reason: payload?.data?.pranimi_code_lifecycle?.final_code_reason || finalCodeReason || null,
          db_verify_state: warning?.status_label || payload?.data?.pranimi_code_lifecycle?.db_verify_state || payload?.data?.local_sync_status || 'LOCAL / NOT SYNCED',
          online: onlineForClientLookup,
        });
        setSavingContinue(false);
      };

      const markPranimiLocalMirrorUnsynced = async (reason = 'DB_VERIFY_FAILED', extra = {}) => {
        try {
          const localOid = stableLocalOid || String(shadowOrderId || oid || '');
          const nextData = {
            ...((payload?.data && typeof payload.data === 'object') ? payload.data : {}),
            local_oid: localOid,
            local_sync_status: 'LOCAL / NOT SYNCED',
            sync_error: reason,
            pranimi_code_lifecycle: {
              ...(((payload?.data?.pranimi_code_lifecycle && typeof payload.data.pranimi_code_lifecycle === 'object') ? payload.data.pranimi_code_lifecycle : {})),
              local_oid: localOid,
              db_verify_state: reason,
              db_verify_failed_at: new Date().toISOString(),
            },
          };
          payload.data = nextData;
          const localRow = {
            id: String(shadowOrderId || oid || localOid),
            local_oid: localOid,
            table: 'orders',
            ...payload,
            data: nextData,
            _local: true,
            _synced: false,
            _syncPending: true,
            _syncing: false,
            _syncFailed: true,
            _syncError: reason,
            updated_at: new Date().toISOString(),
            ...((extra && typeof extra === 'object') ? extra : {}),
          };
          await saveOrderLocal(localRow);
          try { patchBaseMasterRow(localRow); } catch {}
          return localRow;
        } catch {
          return null;
        }
      };

      const applySyncedClientMasterToPayload = (client = {}) => {
        const clientId = String(client?.id || '').trim();
        if (!clientId) return false;
        const syncedClientMasterName = String(
          client?.full_name ||
          client?.name ||
          [client?.first_name, client?.last_name].filter(Boolean).join(' ') ||
          finalClientName ||
          ''
        ).trim() || finalClientName;
        const syncedClientMasterPhoneRaw = String(client?.phone || finalClientPhone || '').trim() || finalClientPhone;
        const syncedClientMasterPhone = noPhone || isNoPhonePlaceholder(syncedClientMasterPhoneRaw) ? '' : syncedClientMasterPhoneRaw;
        const syncedClientCode = normalizeCode(client?.code ?? persistedClientCode) || persistedClientCode;
        const allowExistingClientDifferentOrderCode = !!(
          client?.allowOrderCodeDifferentFromClientCode ||
          client?.clientCodeDiffersFromOrderCode
        );
        if (syncedClientCode && String(syncedClientCode) !== String(persistedClientCode) && !allowExistingClientDifferentOrderCode) return false;

        payload.client_id = clientId;
        payload.client_name = syncedClientMasterName || payload.client_name || null;
        payload.client_phone = syncedClientMasterPhone || payload.client_phone || '';
        payload.data = (payload.data && typeof payload.data === 'object') ? payload.data : {};
        payload.data.client = {
          ...(payload.data.client || {}),
          id: clientId,
          code: persistedClientCode,
          name: syncedClientMasterName || null,
          phone: syncedClientMasterPhone || '',
          photoUrl: clientPhotoUrl || null,
        };
        payload.data.client_master_id = clientId;
        payload.data.client_id = clientId;
        payload.data.client_name = syncedClientMasterName || payload.data.client_name || null;
        payload.data.client_phone = noPhone ? '' : (syncedClientMasterPhone || payload.data.client_phone || '');
        payload.data.no_phone = !!noPhone;
        payload.data.client_master_phone = noPhone ? (noPhoneClientMasterPhone || client?.phone || null) : null;
        return true;
      };

      const linkVerifiedOrderToClientMaster = async (verifiedDbRow = {}) => {
        if (isBaseEdit) return verifiedDbRow;
        if (payload?.client_id) return verifiedDbRow;
        if (!persistedClientCode) return verifiedDbRow;
        const canTouchClientMasterAfterOrder = canAttemptDirectDbFinalSave;
        if (!canTouchClientMasterAfterOrder) return verifiedDbRow;

        let createdClientForLink = null;
        try {
          const postOrderClient = await withSupabaseTimeout(
            syncClientMasterForCode({
              code: persistedClientCode || normCodeNow,
              name: finalClientName || '',
              phone: finalClientPhone || '',
              photoUrl: clientPhotoUrl || '',
              selected: null,
              noPhone: !!noPhone,
              clientMode: clientSaveMode,
              noPhonePlaceholder: noPhoneClientMasterPhone,
            }),
            PRANIMI_CONTINUE_MASTER_SYNC_MS,
            'PRANIMI_POST_ORDER_CLIENT_MASTER_SYNC_TIMEOUT',
            { source: 'handleContinue:postOrderClientMaster' }
          );

          if (postOrderClient?.codeConflict) {
            appendPranimiCodeDebug('post_order_client_master_code_conflict', {
              local_oid: stableLocalOid || String(shadowOrderId || oid),
              code: persistedClientCode,
              client_id: postOrderClient?.id || null,
              reason: postOrderClient?.conflictReason || 'CODE_CONFLICT',
            });
            return verifiedDbRow;
          }

          if (!postOrderClient?.id) return verifiedDbRow;
          createdClientForLink = postOrderClient?.createdInThisFlow ? postOrderClient : null;
          if (!applySyncedClientMasterToPayload(postOrderClient)) return verifiedDbRow;

          const linkPatch = {
            client_id: payload.client_id || null,
            client_name: payload.client_name || null,
            client_phone: payload.client_phone || '',
            data: payload.data,
            updated_at: new Date().toISOString(),
          };
          const dbOrderId = String(verifiedDbRow?.id || '').trim();
          if (!dbOrderId) return verifiedDbRow;

          await withSupabaseTimeout(
            updateOrderRecord('orders', dbOrderId, linkPatch),
            PRANIMI_CONTINUE_ORDER_LINK_MS,
            'PRANIMI_POST_ORDER_CLIENT_LINK_TIMEOUT',
            { source: 'handleContinue:postOrderClientLink', order_id: dbOrderId }
          );

          const afterLinkVerify = await verifyBaseOrderInDbBySafetyIds(payload, {
            local_oid: stableLocalOid || String(shadowOrderId || oid),
            save_attempt_id: payload?.data?.pranimi_code_lifecycle?.save_attempt_id || '',
            code: persistedClientCode,
          });
          if (afterLinkVerify?.found) {
            appendPranimiCodeDebug('post_order_client_master_linked', {
              local_oid: stableLocalOid || String(shadowOrderId || oid),
              server_id: String(afterLinkVerify?.row?.id || dbOrderId),
              client_id: payload.client_id || null,
              created_client: !!createdClientForLink,
            });
            return afterLinkVerify.row || verifiedDbRow;
          }
          throw new Error('POST_ORDER_CLIENT_LINK_VERIFY_FAILED');
        } catch (error) {
          if (createdClientForLink) {
            await safeCleanupPranimiClientCreatedInThisFlow({
              client: createdClientForLink,
              expected: { code: persistedClientCode, client_phone: finalClientPhone },
              reason: 'POST_ORDER_CLIENT_LINK_FAILED',
            });
          }
          appendPranimiCodeDebug('post_order_client_master_link_failed', {
            local_oid: stableLocalOid || String(shadowOrderId || oid),
            code: persistedClientCode,
            error: String(error?.message || error || ''),
          });
          return verifiedDbRow;
        }
      };

      if (clientMasterSyncBlockingFailure) {
        let blockingQueuedOpId = '';
        try {
          const queued = await enqueueBaseOrder({ id: String(oid), local_oid: String(oid), ...payload });
          blockingQueuedOpId = String(queued?.op_id || queued?.outbox_op_id || '').trim();
          if (blockingQueuedOpId) {
            payload.data = (payload.data && typeof payload.data === 'object') ? payload.data : {};
            payload.data.outbox_op_id = blockingQueuedOpId;
            payload.data.sync_safety = {
              ...((payload.data.sync_safety && typeof payload.data.sync_safety === 'object') ? payload.data.sync_safety : {}),
              outbox_op_id: blockingQueuedOpId,
            };
            payload.data.pranimi_code_lifecycle = {
              ...((payload.data.pranimi_code_lifecycle && typeof payload.data.pranimi_code_lifecycle === 'object') ? payload.data.pranimi_code_lifecycle : {}),
              outbox_op_id: blockingQueuedOpId,
            };
          }
        } catch {}
        await markPranimiLocalMirrorUnsynced('CLIENT_MASTER_SYNC_FAILED', {
          outbox_op_id: blockingQueuedOpId || null,
          last_error: String(clientMasterSyncBlockingError?.message || clientMasterSyncBlockingError || 'CLIENT_MASTER_SYNC_FAILED'),
        });
        finishLocalOnlyWarning({
          severity: 'red',
          title: 'KLIENTI NUK U VERIFIKUA NË DB',
          subtitle: 'LOCAL / NOT SYNCED',
          status_label: 'LOCAL / NOT SYNCED',
          message: 'KJO ORDER ËSHTË VETËM LOKALE\nKLIENTI NUK U RUAJT/VERIFIKUA NË DB\nLAJMËRO ADMININ',
          problem_title: 'PROBLEM ME ORDER — KLIENTI NUK U VERIFIKUA',
          allow_sms_after_ack: false,
          is_base_edit: !!isBaseEdit,
          last_error: String(clientMasterSyncBlockingError?.message || clientMasterSyncBlockingError || 'CLIENT_MASTER_SYNC_FAILED'),
        });
        return;
      }

      const finishSuccess = (verifiedRowForDraftCleanup = {}) => {
        const finishedId = String(oid || '').trim();
        const verifiedOrderIdForDraftCleanup = String(verifiedRowForDraftCleanup?.id || payload?.data?.pranimi_code_lifecycle?.server_id || '').trim();
        const draftCleanupIds = Array.from(new Set([
          finishedId,
          String(stableLocalOid || '').trim(),
          String(payload?.local_oid || '').trim(),
          String(payload?.id || '').trim(),
          String(order?.id || '').trim(),
          String(shadowOrderId || '').trim(),
          verifiedOrderIdForDraftCleanup,
        ].filter(Boolean)));
        if (finishedId) suppressDraftId(finishedId);
        try { if (draftTimer.current) clearTimeout(draftTimer.current); } catch {}
        try { if (remoteDraftTimerRef.current) clearTimeout(remoteDraftTimerRef.current); } catch {}
        try { removeDraftLocal(finishedId); } catch {}
        try { removeDraftReservationLocal(finishedId); } catch {}
        try {
          draftRemoteCacheRef.current = {
            version: PRANIMI_DRAFT_GUARD_VERSION,
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
          try { await deleteDraftRemoteMany(draftCleanupIds); } catch {}
          try {
            const finalCodeForTempCleanup = normalizeCode(payload?.code ?? persistedClientCode ?? null);
            const tempCodeCandidates = Array.from(new Set([
              normalizeCode(order?.codeRaw ?? null),
              normalizeCode(payload?.data?.codeRaw ?? null),
              normalizeCode(payload?.data?.pranimi_code_lifecycle?.draft_code_raw ?? null),
              normalizeCode(payload?.data?.draft_lifecycle?.code ?? null),
              normalizeCode(readSessionReservedBaseCode(finishedId) ?? null),
              normalizeCode(readSessionReservedBaseCode(stableLocalOid || String(shadowOrderId || oid || '')) ?? null),
            ].filter((x) => x != null)));
            for (const tempCode of tempCodeCandidates) {
              if (finalCodeForTempCleanup != null && String(tempCode) === String(finalCodeForTempCleanup)) continue;
              await releaseExistingClientTempCodeAfterVerifiedSave({
                tempCode,
                finalCode: finalCodeForTempCleanup,
                localOid: stableLocalOid || String(shadowOrderId || oid || ''),
                reason: 'existing_client_finalized_with_historical_code',
              }).catch(() => null);
            }
          } catch {}
          appendPranimiCodeDebug('finalized_order_remote_draft_cleanup_after_db_verify', {
            local_oid: finishedId || null,
            order_id: verifiedOrderIdForDraftCleanup || null,
            draft_cleanup_ids: draftCleanupIds,
          });
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

      if (noPhone) {
        try {
          payload.client_phone = '';
          payload.data.client_phone = '';
          payload.data.no_phone = true;
          payload.data.client_master_phone = noPhoneClientMasterPhone || buildNoPhonePlaceholderPhone(payload?.code || persistedClientCode);
          if (payload.data.client && typeof payload.data.client === 'object') payload.data.client.phone = '';
        } catch {}
      }

      try {
        if (isBaseEdit && editTargetId) {
          pranimiDiagLog('[PRANIMI handleContinue] save body', { mode: 'edit', table: 'orders', id: String(editTargetId), payload });
          if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new Error('OFFLINE_ENQUEUE');
          await updateOrderRecord('orders', editTargetId, payload);
          if (hasPendingUpfrontCash) {
            try {
              const arkaResult = await recordPranimiUpfrontCashAfterDbSave({ dbOrderId: editTargetId, payment: pendingUpfrontCashPayment, payload });
              if (arkaResult?.order?.data) payload.data = { ...((payload?.data && typeof payload.data === 'object') ? payload.data : {}), ...arkaResult.order.data };
              if (arkaResult?.order?.status) payload.status = arkaResult.order.status;
              setPendingUpfrontCashPayment(null);
            } catch (error) {
              alert(`ARKA PROBLEM: ndryshimi u ruajt, por pagesa nuk u verifikua. Mos e mbyll si sukses normal. ${String(error?.message || error || '')}`);
              setSavingContinue(false);
              return;
            }
          }
          try { patchBaseMasterRow({ id: String(editTargetId), local_oid: stableLocalOid || String(editTargetId), table: 'orders', ...payload, _synced: true, _local: false }); } catch {}
          finishSuccess({ id: editTargetId, local_oid: stableLocalOid || String(editTargetId) });
          return;
        }

        pranimiDiagLog('[PRANIMI handleContinue] save body', { mode: 'create', table: 'orders', id: String(oid), payload: { local_oid: stableLocalOid || String(oid), ...payload } });
        const queuedOpId = '';

        const trulyOfflineSave = !canAttemptDirectDbFinalSave;
        if (trulyOfflineSave) {
          try {
            payload.data.local_sync_status = 'LOCAL / NOT SYNCED';
            payload.data.pranimi_code_lifecycle.db_verify_state = 'LOCAL / NOT SYNCED';
          } catch {}
          await enqueueBaseOrder({ id: String(oid), local_oid: String(oid), ...payload }).catch(() => null);
          appendPranimiCodeDebug('db_verify_failed', {
            save_attempt_id: payload?.data?.pranimi_code_lifecycle?.save_attempt_id || null,
            local_oid: stableLocalOid || String(shadowOrderId || oid),
            outbox_op_id: null,
            reason: 'offline_or_code_verify_offline',
          });
          finishLocalOnlyWarning({
            severity: 'yellow',
            title: 'RUAJTUR LOKALISHT — DO SINKRONIZOHET KUR TË KETË INTERNET',
            subtitle: 'LOCAL / NOT SYNCED',
            status_label: 'LOCAL / NOT SYNCED',
            message: 'KJO ORDER ËSHTË VETËM LOKALE\nNUK KA HYRË ENDE NË DB\nLAJMËRO ADMININ',
            problem_title: 'PROBLEM ME ORDER — NUK KA HYRË NË DB',
            allow_sms_after_ack: false,
            is_base_edit: !!isBaseEdit,
          });
          return;
        }

        try {
          payload.data.local_sync_status = 'DB_VERIFY_PENDING';
          payload.data.pranimi_code_lifecycle.db_verify_state = 'DB_VERIFY_PENDING';
          payload.data.sync_safety = {
            ...((payload.data.sync_safety && typeof payload.data.sync_safety === 'object') ? payload.data.sync_safety : {}),
            local_oid: stableLocalOid || String(shadowOrderId || oid),
            save_attempt_id: payload?.data?.pranimi_code_lifecycle?.save_attempt_id || null,
            order_save_path: 'direct_upsert_before_client_master',
          };
        } catch {}

        appendPranimiCodeDebug('supabase_insert_attempt', {
          save_attempt_id: payload?.data?.pranimi_code_lifecycle?.save_attempt_id || null,
          local_oid: stableLocalOid || String(shadowOrderId || oid),
          outbox_op_id: null,
          code: persistedClientCode,
          save_path: 'direct_upsert_before_client_master',
        });

        const directOrderLocalOid = stableLocalOid || String(shadowOrderId || oid);
        const directOrderRow = {
          local_oid: directOrderLocalOid,
          ...payload,
          data: {
            ...((payload?.data && typeof payload.data === 'object') ? payload.data : {}),
            local_oid: directOrderLocalOid,
            status: payload.status || targetStatus,
          },
        };
        const existingDraftForFinalSave = await findBaseOrderByLocalOidAny(
          directOrderLocalOid,
          'id,local_oid,code,status,client_name,client_phone,updated_at,data'
        );
        if (existingDraftForFinalSave?.row?.id) {
          appendPranimiCodeDebug('final_save_updates_existing_db_draft', {
            local_oid: directOrderLocalOid,
            order_id: existingDraftForFinalSave.row.id,
            previous_status: existingDraftForFinalSave.row.status || existingDraftForFinalSave.row?.data?.status || null,
            code: persistedClientCode,
          });
          await withSupabaseTimeout(
            updateOrderRecord('orders', existingDraftForFinalSave.row.id, directOrderRow),
            PRANIMI_CONTINUE_ORDER_SAVE_MS,
            'PRANIMI_ORDER_DIRECT_UPDATE_EXISTING_DRAFT_TIMEOUT',
            { source: 'handleContinue:directOrderUpdateExistingDraft', local_oid: directOrderLocalOid, code: persistedClientCode, order_id: existingDraftForFinalSave.row.id }
          );
        } else {
          await withSupabaseTimeout(
            upsertOrderRecord('orders', directOrderRow, { onConflict: 'local_oid' }),
            PRANIMI_CONTINUE_ORDER_SAVE_MS,
            'PRANIMI_ORDER_DIRECT_SAVE_TIMEOUT',
            { source: 'handleContinue:directOrderSave', local_oid: directOrderLocalOid, code: persistedClientCode }
          );
        }

        appendPranimiCodeDebug('supabase_insert_success', {
          save_attempt_id: payload?.data?.pranimi_code_lifecycle?.save_attempt_id || null,
          local_oid: stableLocalOid || String(shadowOrderId || oid),
          outbox_op_id: null,
          done: 1,
          save_path: 'direct_upsert_before_client_master',
        });

        const syncRes = { done: 1, failed: 0, pending: 0, direct: true };
        const verifyRes = await verifyBaseOrderInDbBySafetyIds(payload, {
          local_oid: stableLocalOid || String(shadowOrderId || oid),
          save_attempt_id: payload?.data?.pranimi_code_lifecycle?.save_attempt_id || '',
          outbox_op_id: queuedOpId || '',
          code: persistedClientCode,
        });

        if (verifyRes?.found) {
          const strictVerify = assertBaseOrderReservationMatch(verifyRes?.row || {}, {
            local_oid: stableLocalOid || String(shadowOrderId || oid),
            code: persistedClientCode,
            client_name: payload?.client_name || '',
            client_phone: payload?.client_phone || '',
            status: payload?.status || targetStatus,
            pieces: payload?.pieces,
            m2_total: payload?.m2_total,
            price_total: payload?.price_total,
          });
          if (!strictVerify.ok) {
            try {
              payload.data.local_sync_status = 'DB_VERIFY_MISMATCH';
              payload.data.pranimi_code_lifecycle.db_verify_state = 'DB_VERIFY_MISMATCH';
              payload.data.pranimi_code_lifecycle.db_verify_mismatch = strictVerify;
            } catch {}
            appendPranimiCodeDebug('db_verify_mismatch', {
              save_attempt_id: payload?.data?.pranimi_code_lifecycle?.save_attempt_id || null,
              local_oid: stableLocalOid || String(shadowOrderId || oid),
              outbox_op_id: queuedOpId || null,
              code: persistedClientCode,
              via: verifyRes?.via || '',
              strictVerify,
            });
            if (syncedClientMaster?.createdInThisFlow) {
              await safeCleanupPranimiClientCreatedInThisFlow({
                client: syncedClientMaster,
                expected: { code: persistedClientCode, client_phone: finalClientPhone },
                reason: 'ORDER_DB_VERIFY_MISMATCH',
              });
            }
            finishLocalOnlyWarning({
              severity: 'red',
              title: 'PROBLEM ME KODIN — NUK U KONFIRMUA SI SUKSES',
              subtitle: 'DB VERIFY MISMATCH',
              status_label: 'DB VERIFY MISMATCH',
              message: `Kodi i rezervuar/shfaqur ishte ${strictVerify.expectedCode || persistedClientCode}, por DB ktheu ${strictVerify.dbCode || 'pa kod'} për order #${strictVerify.serverId || '—'}. Mos e trajto si të ruajtur pa kontroll administrativ.`,
              problem_title: 'PROBLEM ME ORDER — KODI I RUAJTUR NUK PËRPUTHET',
              allow_sms_after_ack: false,
              is_base_edit: !!isBaseEdit,
            });
            setSavingContinue(false);
            return;
          }

          try {
            payload.data.local_sync_status = 'DB VERIFIED';
            payload.data.pranimi_code_lifecycle.db_verify_state = 'DB_VERIFIED';
            payload.data.pranimi_code_lifecycle.db_verify_via = verifyRes?.via || '';
            payload.data.pranimi_code_lifecycle.server_id = String(verifyRes?.row?.id || '');
            payload.data.pranimi_code_lifecycle.db_verified_code = strictVerify.dbCode || '';
            payload.data.pranimi_code_lifecycle.db_verified_local_oid = strictVerify.dbLocalOid || '';
          } catch {}
          appendPranimiCodeDebug('db_verify_success', {
            save_attempt_id: payload?.data?.pranimi_code_lifecycle?.save_attempt_id || null,
            local_oid: stableLocalOid || String(shadowOrderId || oid),
            outbox_op_id: queuedOpId || null,
            via: verifyRes?.via || '',
            server_id: String(verifyRes?.row?.id || ''),
            message: 'ORDER U RUAJT NË SISTEM',
          });
          try {
            await markCodeUsed(persistedClientCode, stableLocalOid || String(shadowOrderId || oid));
            appendPranimiCodeDebug('base_code_pool_marked_used_after_order_verify', {
              local_oid: stableLocalOid || String(shadowOrderId || oid),
              code: persistedClientCode,
            });
          } catch (markErr) {
            appendPranimiCodeDebug('base_code_pool_mark_used_after_order_verify_failed', {
              local_oid: stableLocalOid || String(shadowOrderId || oid),
              code: persistedClientCode,
              error: String(markErr?.message || markErr || ''),
            });
          }
          let verifiedDbRow = verifyRes.row || {};
          if (hasPendingUpfrontCash) {
            try {
              const arkaResult = await recordPranimiUpfrontCashAfterDbSave({
                dbOrderId: verifiedDbRow?.id,
                payment: pendingUpfrontCashPayment,
                payload,
              });
              if (arkaResult?.order) verifiedDbRow = arkaResult.order;
              const paidAfterArka = Number((Math.max(Number(clientPaid || 0), Number(arkaResult?.order?.data?.pay?.paid || 0), Number(arkaResult?.order?.data?.pay?.arkaRecordedPaid || 0))).toFixed(2));
              const arkaAfterArka = Number((Math.max(Number(arkaRecordedPaid || 0), Number(arkaResult?.order?.data?.pay?.arkaRecordedPaid || 0))).toFixed(2));
              const debtAfterArka = Math.max(0, Number((Number(totalEuro || 0) - Math.max(paidAfterArka, arkaAfterArka)).toFixed(2)));
              payload.paid_cash = paidAfterArka;
              payload.is_paid_upfront = paidAfterArka > 0;
              payload.status = arkaResult?.order?.status || (debtAfterArka <= 0.01 ? 'dorzim' : payload.status);
              payload.data = {
                ...((payload?.data && typeof payload.data === 'object') ? payload.data : {}),
                ...((arkaResult?.order?.data && typeof arkaResult.order.data === 'object') ? arkaResult.order.data : {}),
                status: payload.status,
                paid_cash: paidAfterArka,
                is_paid_upfront: paidAfterArka > 0,
                pay: {
                  ...((payload?.data?.pay && typeof payload.data.pay === 'object') ? payload.data.pay : {}),
                  ...((arkaResult?.order?.data?.pay && typeof arkaResult.order.data.pay === 'object') ? arkaResult.order.data.pay : {}),
                  paid: paidAfterArka,
                  arkaRecordedPaid: arkaAfterArka,
                  debt: debtAfterArka,
                  method: 'CASH',
                },
                clientPaid: paidAfterArka,
                paid: paidAfterArka,
                debt: debtAfterArka,
                isPaid: debtAfterArka <= 0.01,
              };
              setPendingUpfrontCashPayment(null);
            } catch (error) {
              alert(`ARKA PROBLEM: order-i u ruajt në DB, por pagesa upfront nuk u verifikua. Mos e mbyll si sukses normal. ${String(error?.message || error || '')}`);
              setSavingContinue(false);
              return;
            }
          }
          verifiedDbRow = await linkVerifiedOrderToClientMaster(verifiedDbRow);
          try {
            const verifiedLocalData = {
              ...(((verifiedDbRow?.data && typeof verifiedDbRow.data === 'object') ? verifiedDbRow.data : {})),
              ...(((payload?.data && typeof payload.data === 'object') ? payload.data : {})),
            };
            await saveOrderLocal({
              ...payload,
              ...verifiedDbRow,
              data: verifiedLocalData,
              id: String(verifiedDbRow?.id || oid),
              local_oid: stableLocalOid || String(oid),
              table: 'orders',
              _local: false,
              _synced: true,
              _syncPending: false,
              _syncing: false,
              _syncFailed: false,
              _syncError: null,
              server_id: String(verifiedDbRow?.id || ''),
            });
          } catch {}
          finishSuccess(verifiedDbRow);
          return;
        }

        try {
          payload.data.local_sync_status = 'LOCAL / NOT SYNCED';
          payload.data.pranimi_code_lifecycle.db_verify_state = 'DB_VERIFY_FAILED';
        } catch {}
        appendPranimiCodeDebug('db_verify_failed', {
          save_attempt_id: payload?.data?.pranimi_code_lifecycle?.save_attempt_id || null,
          local_oid: stableLocalOid || String(shadowOrderId || oid),
          outbox_op_id: queuedOpId || null,
          code: persistedClientCode,
          sync_done: Number(syncRes?.done || 0),
          sync_failed: Number(syncRes?.failed || 0),
          pending: Number(syncRes?.pending || 0),
        });
        if (syncedClientMaster?.createdInThisFlow) {
          await safeCleanupPranimiClientCreatedInThisFlow({
            client: syncedClientMaster,
            expected: { code: persistedClientCode, client_phone: finalClientPhone },
            reason: 'ORDER_DB_VERIFY_FAILED',
          });
        }
        await markPranimiLocalMirrorUnsynced('DB_VERIFY_FAILED', {
          last_sync_result: { done: Number(syncRes?.done || 0), failed: Number(syncRes?.failed || 0), pending: Number(syncRes?.pending || 0) },
        });
        finishLocalOnlyWarning({
          severity: Number(syncRes?.failed || 0) > 0 ? 'red' : 'yellow',
          title: 'KJO ORDER ËSHTË VETËM LOKALE',
          subtitle: 'LOCAL / NOT SYNCED',
          status_label: 'LOCAL / NOT SYNCED',
          message: 'KJO ORDER ËSHTË VETËM LOKALE\nNUK KA HYRË ENDE NË DB\nLAJMËRO ADMININ',
          problem_title: 'PROBLEM ME ORDER — NUK KA HYRË NË DB',
          allow_sms_after_ack: false,
          is_base_edit: !!isBaseEdit,
          last_error: syncRes?.error || (Number(syncRes?.failed || 0) > 0 ? 'SYNC_FAILED' : 'DB_VERIFY_FAILED'),
        });
        return;
      } catch (err) {
        const isOffline =
          offlineMode ||
          (typeof navigator !== 'undefined' && navigator.onLine === false) ||
          /load failed|failed to fetch|fetch failed|networkerror|network request failed|offline_enqueue/i.test(String(err?.message || err || ''));

        if (!isOffline) {
          try {
            payload.data.local_sync_status = 'LOCAL / NOT SYNCED';
            payload.data.pranimi_code_lifecycle.db_verify_state = 'DB_VERIFY_FAILED';
          } catch {}
          if (syncedClientMaster?.createdInThisFlow) {
            await safeCleanupPranimiClientCreatedInThisFlow({
              client: syncedClientMaster,
              expected: { code: persistedClientCode, client_phone: finalClientPhone },
              reason: 'ORDER_SAVE_THROW_BEFORE_VERIFY',
            });
          }
          await markPranimiLocalMirrorUnsynced('DB_VERIFY_FAILED', {
            last_error: String(err?.message || err || 'DB_VERIFY_FAILED'),
          });
          finishLocalOnlyWarning({
            severity: 'red',
            title: 'DB VERIFY FAIL / SYNC ERROR',
            subtitle: 'DB VERIFY FAILED',
            status_label: 'DB VERIFY FAILED',
            message: 'KJO ORDER NUK KA HYRË NË DB',
            problem_title: 'PROBLEM ME ORDER — NUK KA HYRË NË DB',
            allow_sms_after_ack: false,
            is_base_edit: !!isBaseEdit,
          });
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

        finishLocalOnlyWarning({
          severity: 'yellow',
          title: 'RUAJTUR LOKALISHT — DO SINKRONIZOHET KUR TË KETË INTERNET',
          subtitle: 'LOCAL / NOT SYNCED',
          status_label: 'LOCAL / NOT SYNCED',
          message: 'KJO ORDER ËSHTË VETËM LOKALE\nNUK KA HYRË ENDE NË DB\nLAJMËRO ADMININ',
          problem_title: 'PROBLEM ME ORDER — NUK KA HYRË NË DB',
          allow_sms_after_ack: false,
          is_base_edit: !!isBaseEdit,
        });
        return;
      }
    } catch (err) {
      alert('DB ERROR: ' + (err?.message || 'Unknown error'));
      setSavingContinue(false);
      return;
    }
  }

  function openDrafts() {
    try { draftRemoteCacheRef.current = { version: PRANIMI_DRAFT_GUARD_VERSION, ts: 0, items: [] }; } catch {}
    try { setDrafts([]); } catch {}
    setDraftsRefreshing(true);
    setShowDraftsSheet(true);
    void refreshDrafts({ includeRemote: true, forceRemote: true })
      .finally(() => setDraftsRefreshing(false));
  }


  function applyDraftSnapshotToForm(d, fallbackId = '') {
    const nextId = String(d?.local_oid || d?.draft_lifecycle?.local_oid || d?.id || fallbackId || '').trim() || makePranimiLocalOid();
    if (!nextId) return;
    const previousId = String(oidRef.current || oid || '').trim();
    if (previousId && previousId !== nextId && !hasStartedWork()) {
      const prevMeta = readDraftReservationLocal(previousId);
      if (prevMeta && !prevMeta.has_meaningful_work) void releaseBlankDraftReservation(prevMeta, 'open_meaningful_draft_replaced_blank_session');
    }

    setCreating(true);
    setIsBridgeEditMode(false);
    editBridgeRef.current = null;
    oidRef.current = nextId;
    setOid(nextId);
    unsuppressDraftId(nextId);

    const restoredDraftCode = normalizeCode(
      d?.codeRaw ??
      d?.code ??
      d?.draft_lifecycle?.code ??
      d?.draft_lifecycle?.final_code ??
      d?.pranimi_code_lifecycle?.code ??
      d?.data?.code ??
      d?.data?.client_code ??
      d?.data?.client?.code ??
      d?.data?.draft_lifecycle?.code ??
      d?.data?.draft_lifecycle?.final_code ??
      d?.data?.pranimi_code_lifecycle?.code ??
      d?.data?.pranimi_code_lifecycle?.final_code ??
      readSessionReservedBaseCode(nextId) ??
      null
    );
    if (restoredDraftCode != null) {
      codeRawRef.current = String(restoredDraftCode);
      setCodeRaw(String(restoredDraftCode));
      writeDraftReservationLocal({
        local_oid: nextId,
        code: restoredDraftCode,
        created_by_pin: d?.created_by_pin || d?.draft_lifecycle?.created_by_pin || actor?.pin || actor?.pinCode || actor?.id || '',
        created_at: d?.created_at || d?.draft_lifecycle?.created_at || getDraftCreatedAt(nextId),
        created_at_iso: d?.created_at_iso || d?.draft_lifecycle?.created_at_iso || '',
        has_meaningful_work: snapshotHasMeaningfulWork(d),
        reason: 'DRAFT_CODE_RESTORED',
      });
      appendPranimiCodeDebug('draft_code_raw_restored', {
        local_oid: nextId,
        draft_id: String(d?.id || fallbackId || '').trim() || null,
        final_code: restoredDraftCode,
        final_code_reason: 'DRAFT_CODE_RESTORED',
      });
    } else {
      codeRawRef.current = '';
      setCodeRaw('');
      void tryReserveCodeInBackground(nextId, 'draft_loaded_missing_code_repair');
    }

    const nextName = String(d?.name || d?.client?.full_name || d?.client?.name || '').trim();
    setName(nextName);
    const nextPhone = normalizeMatchPhone(d?.phone || d?.client?.phone || '');
    setPhone(nextPhone);
    setNoPhone(Boolean(d?.noPhone) || !nextPhone);
    setClientPhotoUrl(d?.clientPhotoUrl || '');
    newOrderUrlClientRef.current = { code: '', name: '', phone: '' };
    // Draft/session/cache code is non-authoritative. Phone match + worker confirmation is required.
    setSelectedClient(null);
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
    setPendingUpfrontCashPayment(null);
    setPayMethod(d?.payMethod || 'CASH');
    setNotes(d?.notes || '');
    setShowDraftsSheet(false);
    setCreating(false);
  }

  async function loadDraftIntoForm(input) {
    const inputDraft = input && typeof input === 'object' ? input : null;
    const targetId = String(inputDraft?.id || input || '').trim();
    const targetFileKey = getPranimiDraftFileKey(inputDraft || {}, { id: targetId, file_key: inputDraft?._draft_file_key || inputDraft?.remote_file_key || inputDraft?.file_key || '' });
    if (!targetId && !targetFileKey) return;

    try {
      if (draftTimer.current) clearTimeout(draftTimer.current);
      if (remoteDraftTimerRef.current) clearTimeout(remoteDraftTimerRef.current);

      if (isPranimiUnsafeRemoteDraftSummary(inputDraft || {}, { id: targetId, file_key: targetFileKey, source: inputDraft?.source || '' })) {
        hideBlockedDraftFromUi(inputDraft || targetId || targetFileKey, { match_type: 'LEGACY_NUMERIC_REMOTE_DRAFT_FILE' }, 'open_blocked_legacy_numeric_remote_file');
        alert('Ky draft është legacy remote stale dhe nuk hapet. Lista do rifreskohet.');
        void refreshDrafts({ includeRemote: true, forceRemote: true });
        return;
      }

      const inputSource = String(inputDraft?.source || '').toUpperCase();
      const preferInputDraft = !!(inputDraft && (inputSource.includes('DB DRAFT') || inputDraft?.db_order_id || inputDraft?.server_id));

      let remoteDraft = null;
      if (!preferInputDraft) {
        const remoteReadIds = Array.from(new Set([targetFileKey, targetId].filter(Boolean)));
        for (const remoteReadId of remoteReadIds) {
          try {
            remoteDraft = await readDraftRemote(remoteReadId);
            if (remoteDraft && typeof remoteDraft === 'object') {
              remoteDraft = { ...remoteDraft, _draft_file_key: remoteReadId, remote_file_key: remoteReadId, file_key: remoteReadId };
              break;
            }
          } catch {}
        }
      }

      let localDraft = null;
      if (!remoteDraft && !preferInputDraft) {
        for (const localReadId of Array.from(new Set([targetId, targetFileKey].filter(Boolean)))) {
          try {
            const raw = localStorage.getItem(`${DRAFT_ITEM_PREFIX}${localReadId}`);
            if (raw) { localDraft = JSON.parse(raw); break; }
          } catch {}
        }
      }

      const draftToOpen = preferInputDraft ? inputDraft : (remoteDraft || localDraft || inputDraft);
      if (!draftToOpen) return;

      const openCodePool = await fetchBaseCodePoolRowsForDrafts([draftToOpen]);
      const openCodePoolVerdict = evaluateDraftCodePoolGuard(draftToOpen, openCodePool);
      if (!openCodePoolVerdict?.allow) {
        hideBlockedDraftFromUi(draftToOpen, { match_type: openCodePoolVerdict?.reason || 'CODE_POOL_GUARD' }, 'open_blocked_code_pool_guard');
        alert('Ky draft nuk hapet sepse kodi nuk është më i rezervuar si draft. Lista do rifreskohet.');
        void refreshDrafts({ includeRemote: true, forceRemote: true });
        return;
      }

      const verdict = await findBlockingOrderForDraftInDb(draftToOpen, { id: targetId, file_key: targetFileKey || targetId, remote_file_key: targetFileKey || targetId });
      if (verdict?.blocked) {
        hideBlockedDraftFromUi(targetId, verdict, 'open_blocked_matching_order');
        alert(`Ky draft nuk mund të hapet sepse public.orders tashmë ka order #${verdict?.row?.id || '—'} me status ${readPranimiDraftOrderStatus(verdict?.row || {}) || 'aktiv/final'}.`);
        void refreshDrafts({ includeRemote: true, forceRemote: true });
        return;
      }
      if (verdict?.uncertain && remoteDraft) {
        hideBlockedDraftFromUi(targetId, verdict, 'open_blocked_db_check_uncertain');
        alert('Nuk u verifikua public.orders për këtë remote draft. Për siguri, HAP u ndal. Provo refresh/online dhe hape vetëm nëse nuk ka order final.');
        void refreshDrafts({ includeRemote: true, forceRemote: true });
        return;
      }

      unsuppressDraftId(targetId);
      applyDraftSnapshotToForm(draftToOpen, targetId);
      if (remoteDraft) {
        try { collectPranimiDraftAliasKeys(draftToOpen, { id: targetId, file_key: targetFileKey }).forEach((alias) => removeDraftLocal(alias)); } catch {}
      }
      try { if (sessionSnapshotHasContent(draftToOpen)) writeCurrentSessionLocal(draftToOpen); } catch {}
    } catch {}
  }

  async function deleteDraft(input) {
    const inputDraft = input && typeof input === 'object' ? input : null;
    const targetId = String(inputDraft?.id || input || '').trim();
    const targetFileKey = getPranimiDraftFileKey(inputDraft || {}, { id: targetId, file_key: inputDraft?._draft_file_key || inputDraft?.remote_file_key || inputDraft?.file_key || '' });
    if (!targetId && !targetFileKey) return;

    let draftForDelete = inputDraft || null;
    let draftSource = inputDraft ? String(inputDraft?.source || 'SUMMARY') : '';

    if (draftForDelete && isPranimiUnsafeRemoteDraftSummary(draftForDelete, { id: targetId, file_key: targetFileKey, source: draftSource })) {
      hideBlockedDraftFromUi(draftForDelete, { match_type: 'LEGACY_NUMERIC_REMOTE_DRAFT_FILE' }, 'delete_blocked_legacy_numeric_remote_file');
      alert('FSHI u ndal: ky draft është legacy remote stale. Nuk lirohet kodi dhe nuk bëhet cleanup masiv.');
      void refreshDrafts({ includeRemote: true, forceRemote: true });
      return;
    }

    if (!draftForDelete) {
      for (const localReadId of Array.from(new Set([targetId, targetFileKey].filter(Boolean)))) {
        try {
          const raw = localStorage.getItem(`${DRAFT_ITEM_PREFIX}${localReadId}`);
          draftForDelete = raw ? JSON.parse(raw) : null;
          if (draftForDelete) { draftSource = 'LOCAL'; break; }
        } catch {}
      }
    }
    if (!draftForDelete) {
      for (const remoteReadId of Array.from(new Set([targetFileKey, targetId].filter(Boolean)))) {
        try {
          const remote = await readDraftRemote(remoteReadId);
          if (remote && typeof remote === 'object') {
            draftForDelete = { ...remote, _draft_file_key: remoteReadId, remote_file_key: remoteReadId, file_key: remoteReadId };
            draftSource = 'REMOTE';
            break;
          }
        } catch {}
      }
    }
    if (!draftForDelete) {
      try {
        draftForDelete = uniqueDrafts.find((d) => collectPranimiDraftAliasKeys(d, { id: d?.id, file_key: d?._draft_file_key || d?.remote_file_key || d?.file_key || '' }).includes(targetId) || (targetFileKey && collectPranimiDraftAliasKeys(d, { id: d?.id, file_key: d?._draft_file_key || d?.remote_file_key || d?.file_key || '' }).includes(targetFileKey))) || null;
        if (draftForDelete) draftSource = String(draftForDelete?.source || 'SUMMARY');
      } catch {}
    }

    if (draftForDelete) {
      if (isPranimiUnsafeRemoteDraftSummary(draftForDelete, { id: targetId, file_key: targetFileKey, source: draftSource })) {
        hideBlockedDraftFromUi(draftForDelete, { match_type: 'LEGACY_NUMERIC_REMOTE_DRAFT_FILE' }, 'delete_blocked_legacy_numeric_remote_file');
        alert('FSHI u ndal: ky draft është legacy remote stale. Nuk lirohet kodi dhe nuk bëhet cleanup masiv.');
        void refreshDrafts({ includeRemote: true, forceRemote: true });
        return;
      }
      const deleteCodePool = await fetchBaseCodePoolRowsForDrafts([draftForDelete]);
      const deleteCodePoolVerdict = evaluateDraftCodePoolGuard(draftForDelete, deleteCodePool);
      if (!deleteCodePoolVerdict?.allow) {
        hideBlockedDraftFromUi(draftForDelete, { match_type: deleteCodePoolVerdict?.reason || 'CODE_POOL_GUARD' }, 'delete_blocked_code_pool_guard');
        alert('FSHI u ndal: kodi nuk është draft/reserved. Nuk lirohet kodi dhe lista do rifreskohet.');
        void refreshDrafts({ includeRemote: true, forceRemote: true });
        return;
      }

      const verdict = await findBlockingOrderForDraftInDb(draftForDelete, { id: targetId, file_key: targetFileKey || targetId, remote_file_key: targetFileKey || targetId });
      if (verdict?.blocked) {
        hideBlockedDraftFromUi(targetId, verdict, 'delete_blocked_matching_order');
        alert(`FSHI u ndal: ky draft përputhet me public.orders #${verdict?.row?.id || '—'} (${readPranimiDraftOrderStatus(verdict?.row || {}) || 'aktiv/final'}). Nuk u lirua kodi dhe nuk u fshi remote draft si cleanup masiv.`);
        void refreshDrafts({ includeRemote: true, forceRemote: true });
        return;
      }
      if (verdict?.uncertain && String(draftSource || '').toUpperCase().includes('REMOTE')) {
        hideBlockedDraftFromUi(targetId, verdict, 'delete_blocked_db_check_uncertain');
        alert('FSHI u ndal: nuk u verifikua public.orders për këtë remote draft. Për siguri nuk lirohet kodi pa DB check.');
        void refreshDrafts({ includeRemote: true, forceRemote: true });
        return;
      }
    }

    const deleteAliases = collectPranimiDraftAliasKeys(draftForDelete || inputDraft || {}, { id: targetId, file_key: targetFileKey || targetId });
    deleteAliases.forEach((alias) => suppressDraftId(alias));

    try { if (draftTimer.current) clearTimeout(draftTimer.current); } catch {}
    try { if (remoteDraftTimerRef.current) clearTimeout(remoteDraftTimerRef.current); } catch {}
    deleteAliases.forEach((alias) => { try { removeDraftLocal(alias); } catch {} });
    const deleteAliasSet = new Set(deleteAliases);
    try {
      draftRemoteCacheRef.current = {
        version: PRANIMI_DRAFT_GUARD_VERSION,
        ts: Date.now(),
        items: (Array.isArray(draftRemoteCacheRef.current?.items) ? draftRemoteCacheRef.current.items : []).filter((d) => {
          const aliases = collectPranimiDraftAliasKeys(d, { id: d?.id, file_key: d?._draft_file_key || d?.remote_file_key || d?.file_key || '' });
          return !aliases.some((x) => deleteAliasSet.has(x));
        }),
      };
    } catch {}

    setDrafts((prev) => (Array.isArray(prev) ? prev.filter((d) => {
      const aliases = collectPranimiDraftAliasKeys(d, { id: d?.id, file_key: d?._draft_file_key || d?.remote_file_key || d?.file_key || '' });
      return !aliases.some((x) => deleteAliasSet.has(x));
    }) : []));

    await deletePranimiDbDraft(draftForDelete || inputDraft || { id: targetId, local_oid: targetId });

    const releasedCode = normalizeCode(draftForDelete?.codeRaw || draftForDelete?.code || draftForDelete?.draft_lifecycle?.code || readSessionReservedBaseCode(targetId) || null);
    if (releasedCode != null) {
      await releaseLocksForCode(releasedCode, { oid: targetId, reason: 'delete_incomplete_draft' }).catch(() => false);
    }
    deleteAliases.forEach((alias) => { try { removeDraftReservationLocal(alias); } catch {} });

    if (String(oid || '') === targetId) {
      try {
        setOid('');
        setCodeRaw('');
        codeRawRef.current = '';
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
        setPendingUpfrontCashPayment(null);
        setPayMethod('CASH');
        setNotes('');
      } catch {}
      void resetForNewOrder();
    }

    void deleteDraftRemoteMany(deleteAliases.length ? deleteAliases : [targetId]);
    appendPranimiCodeDebug('incomplete_draft_deleted', { local_oid: targetId, aliases: deleteAliases, code: releasedCode, reason: 'delete_incomplete_draft' });
  }

  function getActivePranimiCodeForDisplay() {
    return normalizeCode(
      codeRaw ||
      codeRawRef.current ||
      readSessionReservedBaseCode(oid) ||
      readSessionReservedBaseCode(oidRef.current) ||
      null
    );
  }

  function buildStartMessage() {
    const kod = formatKod(getActivePranimiCodeForDisplay(), netState.ok);
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

    const smsPublicId = String(getActivePranimiCodeForDisplay() || '').trim();
    const orderForSms = orderOverride || {
      id: String(oid || ''),
      local_oid: oid || '',
      public_id: smsPublicId,
      publicId: smsPublicId,
      confirm_id: smsPublicId,
      code: Number(getActivePranimiCodeForDisplay() || 0) || null,
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
          code: Number(getActivePranimiCodeForDisplay() || 0) || null,
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

  function buildLocalSyncProblemText(w = localSyncWarning) {
    const payload = (w?.payload && typeof w.payload === 'object') ? w.payload : {};
    const data = (payload?.data && typeof payload.data === 'object') ? payload.data : {};
    const life = (data?.pranimi_code_lifecycle && typeof data.pranimi_code_lifecycle === 'object') ? data.pranimi_code_lifecycle : {};
    const code = payload?.code || data?.code || life?.final_code || w?.code || codeRaw || '';
    const clientName = payload?.client_name || data?.client_name || data?.client?.name || name || '';
    const clientPhone = payload?.client_phone || data?.client_phone || data?.client?.phone || getCanonicalClientPhone() || '';
    const pieces = payload?.pieces ?? data?.pieces ?? copeCount ?? '';
    const m2 = payload?.m2_total ?? data?.m2_total ?? totalM2 ?? '';
    const euro = payload?.price_total ?? data?.price_total ?? totalEuro ?? '';
    const localOid = life?.local_oid || data?.local_oid || payload?.local_oid || w?.local_oid || oid || '';
    const saveAttemptId = life?.save_attempt_id || data?.save_attempt_id || w?.save_attempt_id || '';
    const outboxOpId = life?.outbox_op_id || life?.op_id || data?.outbox_op_id || w?.outbox_op_id || w?.op_id || '';
    const pin = life?.pin || actor?.pin || actor?.pinCode || actor?.id || '';
    const onlineState = life?.online === false || w?.online === false ? 'OFFLINE' : 'ONLINE';
    const finalCodeReason = life?.final_code_reason || w?.final_code_reason || '';
    const dbVerifyState = life?.db_verify_state || data?.local_sync_status || w?.db_verify_state || w?.status_label || 'LOCAL / NOT SYNCED';
    const statusLabel = w?.status_label || dbVerifyState || 'LOCAL / NOT SYNCED';
    return [
      w?.problem_title || (statusLabel === 'DB VERIFIED' ? 'ORDER U RUAJT NË SISTEM' : 'PROBLEM ME ORDER — NUK KA HYRË NË DB'),
      '',
      `Kodi: ${code || '—'}`,
      `Klienti: ${clientName || '—'}`,
      `Telefoni: ${clientPhone || '—'}`,
      `Copë: ${pieces || '—'}`,
      `M2: ${m2 || '—'}`,
      `Shuma: ${euro || '—'} €`,
      `Status: ${statusLabel}`,
      `Local OID: ${localOid || '—'}`,
      `Save Attempt ID: ${saveAttemptId || '—'}`,
      `Outbox OP ID: ${outboxOpId || '—'}`,
      `Worker PIN: ${pin || '—'}`,
      `Device ID: ${(() => { try { return localStorage.getItem('tepiha_device_id_v1') || localStorage.getItem('device_id') || '—'; } catch { return '—'; } })()}`,
      `Error: ${w?.last_error || w?.error || w?.retry_result?.error || '—'}`,
      `Created At: ${payload?.created_at || data?.created_at || life?.created_at || '—'}`,
      `Last Retry At: ${w?.retry_result?.at || w?.last_retry_at || '—'}`,
      `Online/offline: ${onlineState}`,
      `Final code reason: ${finalCodeReason || '—'}`,
      `DB verify state: ${dbVerifyState || '—'}`,
    ].join('\n');
  }

  async function copyLocalSyncProblem() {
    const text = buildLocalSyncProblemText(localSyncWarning);
    try { await navigator.clipboard?.writeText(text); alert('Problemi u kopjua. Dërgoja adminit.'); }
    catch { alert(text); }
  }

  async function exportLocalSyncDebug() {
    const out = {
      exported_at: new Date().toISOString(),
      warning: localSyncWarning || null,
      problem_text: buildLocalSyncProblemText(localSyncWarning),
      local_storage: {},
    };
    try {
      const keys = ['tepiha_debug_log_v1', CURRENT_SESSION_KEY, DRAFT_LIST_KEY, OFFLINE_QUEUE_KEY];
      for (const k of keys) out.local_storage[k] = localStorage.getItem(k);
      const oidKey = String(localSyncWarning?.local_oid || localSyncWarning?.payload?.local_oid || localSyncWarning?.payload?.data?.local_oid || oid || '').trim();
      if (oidKey) {
        out.local_storage[`order_${oidKey}`] = localStorage.getItem(`order_${oidKey}`);
        out.local_storage[`${LS_BASE_ORDER_CODE_PREFIX}${oidKey}`] = localStorage.getItem(`${LS_BASE_ORDER_CODE_PREFIX}${oidKey}`);
      }
    } catch {}
    const text = JSON.stringify(out, null, 2);
    try { await navigator.clipboard?.writeText(text); } catch {}
    try {
      const blob = new Blob([text], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `pranimi-local-not-synced-${Date.now()}.json`;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { try { URL.revokeObjectURL(url); a.remove(); } catch {} }, 1000);
    } catch {}
    alert('Debug u kopjua. Nëse pajisja e lejon, u shkarkua edhe JSON.');
  }

  async function retryLocalSyncWarning() {
    const current = localSyncWarning || {};
    const payload = (current?.payload && typeof current.payload === 'object') ? current.payload : {};
    const safety = extractPranimiSyncSafety(payload, current);
    setLocalSyncWarning({ ...current, retrying: true, retry_message: 'DUKE VERIFIKUAR DB PARA RETRY...' });
    try {
      const before = await verifyBaseOrderInDbBySafetyIds(payload, current);
      if (before?.found) {
        try {
          appendPranimiCodeDebug('resolved_linked', {
            local_oid: safety.local_oid || before?.row?.local_oid || '',
            save_attempt_id: safety.save_attempt_id || '',
            outbox_op_id: safety.outbox_op_id || '',
            server_id: String(before?.row?.id || ''),
            via: before?.via || '',
          });
          const resolvedData = {
            ...(((before?.row?.data && typeof before.row.data === 'object') ? before.row.data : {})),
            ...(((payload?.data && typeof payload.data === 'object') ? payload.data : {})),
            local_sync_status: 'DB VERIFIED',
          };
          resolvedData.pranimi_code_lifecycle = {
            ...(((before?.row?.data?.pranimi_code_lifecycle && typeof before.row.data.pranimi_code_lifecycle === 'object') ? before.row.data.pranimi_code_lifecycle : {})),
            ...(((payload?.data?.pranimi_code_lifecycle && typeof payload.data.pranimi_code_lifecycle === 'object') ? payload.data.pranimi_code_lifecycle : {})),
            db_verify_state: 'DB_VERIFIED',
            db_verify_via: before?.via || 'manual_retry_precheck',
            server_id: String(before?.row?.id || ''),
          };
          await saveOrderLocal({ ...(payload || {}), ...(before.row || {}), data: resolvedData, id: String(before?.row?.id || safety.local_oid || ''), local_oid: before?.row?.local_oid || safety.local_oid || '', table: 'orders', _local: false, _synced: true, _syncPending: false, _syncing: false, _syncFailed: false, _syncError: null, server_id: String(before?.row?.id || '') });
        } catch {}
        setLocalSyncWarning((prev) => ({
          ...(prev || current),
          retrying: false,
          severity: 'green',
          title: 'ORDER U RUAJT NË SISTEM',
          message: 'ORDER U RUAJT NË SISTEM',
          subtitle: 'DB VERIFIED',
          status_label: 'DB VERIFIED',
          retry_message: `U gjet në DB (${before?.via || 'verify'}). Nuk u krijua duplicate.`,
          retry_result: { ok: true, resolved_linked: true, server_id: String(before?.row?.id || '') },
        }));
        return;
      }

      setLocalSyncWarning((prev) => ({ ...(prev || current), retrying: true, retry_message: 'DB nuk e ka ende. DUKE E KTHYER NË OUTBOX ME TË NJËJTIN local_oid/save_attempt_id...' }));
      const requeued = await enqueueBaseOrder({
        id: safety.local_oid || payload?.local_oid || payload?.data?.local_oid || oid,
        local_oid: safety.local_oid || payload?.local_oid || payload?.data?.local_oid || oid,
        ...payload,
        data: {
          ...((payload?.data && typeof payload.data === 'object') ? payload.data : {}),
          local_oid: safety.local_oid || payload?.local_oid || payload?.data?.local_oid || oid,
          save_attempt_id: safety.save_attempt_id || payload?.data?.save_attempt_id || null,
          pranimi_code_lifecycle: {
            ...((payload?.data?.pranimi_code_lifecycle && typeof payload.data.pranimi_code_lifecycle === 'object') ? payload.data.pranimi_code_lifecycle : {}),
            local_oid: safety.local_oid || payload?.local_oid || payload?.data?.local_oid || oid,
            save_attempt_id: safety.save_attempt_id || payload?.data?.pranimi_code_lifecycle?.save_attempt_id || null,
          },
        },
      });
      appendPranimiCodeDebug('manual_reenqueue', {
        local_oid: safety.local_oid || '',
        save_attempt_id: safety.save_attempt_id || '',
        previous_outbox_op_id: safety.outbox_op_id || '',
        outbox_op_id: requeued?.op_id || requeued?.outbox_op_id || '',
      });
      const res = await syncNow({ immediate: true, source: 'pranimi_local_not_synced_manual_reenqueue' });
      const after = await verifyBaseOrderInDbBySafetyIds(payload, { ...current, outbox_op_id: requeued?.op_id || requeued?.outbox_op_id || safety.outbox_op_id || '' });
      if (after?.found) {
        appendPranimiCodeDebug('db_verify_success', {
          local_oid: safety.local_oid || after?.row?.local_oid || '',
          save_attempt_id: safety.save_attempt_id || '',
          outbox_op_id: requeued?.op_id || requeued?.outbox_op_id || safety.outbox_op_id || '',
          server_id: String(after?.row?.id || ''),
          via: after?.via || '',
          source: 'manual_retry',
        });
      } else {
        appendPranimiCodeDebug('db_verify_failed', {
          local_oid: safety.local_oid || '',
          save_attempt_id: safety.save_attempt_id || '',
          outbox_op_id: requeued?.op_id || requeued?.outbox_op_id || safety.outbox_op_id || '',
          source: 'manual_retry',
          sync_done: Number(res?.done || 0),
          sync_failed: Number(res?.failed || 0),
          pending: Number(res?.pending || 0),
        });
      }
      setLocalSyncWarning((prev) => ({
        ...(prev || current),
        retrying: false,
        retry_message: after?.found ? 'ORDER U RUAJT NË SISTEM. Nuk u krijua duplicate.' : 'RETRY U PROVUA, POR ENDE NUK KA KONFIRMIM DB.',
        subtitle: after?.found ? 'DB VERIFIED' : 'LOCAL / NOT SYNCED',
        status_label: after?.found ? 'DB VERIFIED' : 'LOCAL / NOT SYNCED',
        severity: after?.found ? 'green' : (Number(res?.failed || 0) > 0 ? 'red' : 'yellow'),
        outbox_op_id: requeued?.op_id || requeued?.outbox_op_id || safety.outbox_op_id || '',
        retry_result: { ok: !!after?.found, pending: res?.pending ?? null, done: res?.done ?? null, failed: res?.failed ?? null, server_id: String(after?.row?.id || '') },
      }));
    } catch (err) {
      appendPranimiCodeDebug('db_verify_failed', {
        local_oid: safety.local_oid || '',
        save_attempt_id: safety.save_attempt_id || '',
        outbox_op_id: safety.outbox_op_id || '',
        source: 'manual_retry_error',
        error: String(err?.message || err || 'Unknown error'),
      });
      setLocalSyncWarning((prev) => ({
        ...(prev || current),
        retrying: false,
        retry_message: `RETRY DËSHTOI: ${err?.message || err || 'Unknown error'}`,
      }));
    }
  }


  function continueAfterLocalSyncWarning() {
    const warning = localSyncWarning || {};
    const next = warning?.targetNav || pendingNavTo || '/pastrimi';
    const payload = (warning?.payload && typeof warning.payload === 'object') ? warning.payload : {};
    const data = (payload?.data && typeof payload.data === 'object') ? payload.data : {};
    setLocalSyncWarning(null);
    try { setPendingNavTo(''); } catch {}
    try { setShowWizard(false); } catch {}
    try { setShowMsgSheet(false); } catch {}

    if (warning?.allow_sms_after_ack && !warning?.is_base_edit) {
      try {
        const smsCode = String(payload?.code || data?.code || warning?.code || '').trim();
        const smsOrderPayload = JSON.parse(JSON.stringify({
          id: String(data?.id || data?.local_oid || payload?.local_oid || warning?.local_oid || ''),
          local_oid: String(data?.local_oid || payload?.local_oid || warning?.local_oid || ''),
          public_id: smsCode,
          publicId: smsCode,
          confirm_id: smsCode,
          code: payload?.code || data?.code || warning?.code || null,
          client_name: payload?.client_name || data?.client_name || data?.client?.name || name?.trim() || '',
          client_phone: payload?.client_phone || data?.client_phone || data?.client?.phone || getCanonicalClientPhone(),
          pieces: Number(payload?.pieces || data?.pieces || data?.totals?.pieces || copeCount || 0),
          m2_total: Number(payload?.m2_total || data?.m2_total || data?.totals?.m2 || totalM2 || 0),
          price_total: Number(payload?.price_total || data?.price_total || data?.totals?.euro || totalEuro || 0),
          pay: {
            ...(data?.pay || {}),
            m2: Number(payload?.m2_total || data?.m2_total || data?.totals?.m2 || totalM2 || 0),
            euro: Number(payload?.price_total || data?.price_total || data?.totals?.euro || totalEuro || 0),
          },
          client: {
            ...(data?.client || {}),
            name: payload?.client_name || data?.client_name || data?.client?.name || name?.trim() || '',
            phone: payload?.client_phone || data?.client_phone || data?.client?.phone || getCanonicalClientPhone(),
            code: payload?.code || data?.code || warning?.code || null,
          },
          tepiha: Array.isArray(data?.tepiha) ? data.tepiha : [],
          staza: Array.isArray(data?.staza) ? data.staza : [],
          shkallore: data?.shkallore || { qty: 0, per: Number(stairsPer) || 0, photoUrl: '' },
          totals: {
            pieces: Number(payload?.pieces || data?.pieces || data?.totals?.pieces || copeCount || 0),
            m2: Number(payload?.m2_total || data?.m2_total || data?.totals?.m2 || totalM2 || 0),
            euro: Number(payload?.price_total || data?.price_total || data?.totals?.euro || totalEuro || 0),
          },
          data: {
            ...data,
            public_id: smsCode,
            publicId: smsCode,
            confirm_id: smsCode,
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
        if (smsText && smsPhone) {
          try { setResetAfterSmsClose(true); } catch {}
          try { setPendingNavTo(next); } catch {}
          setSmsModal({ open: true, phone: smsPhone, text: smsText });
          return;
        }
      } catch {}
    }

    void resetForNewOrder();
    try { router.push(next); } catch {}
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
            title={`KODI: ${formatKod(getActivePranimiCodeForDisplay(), netState.ok)}`}
            aria-label={`KODI: ${formatKod(getActivePranimiCodeForDisplay(), netState.ok)}`}
          >
            {formatKod(getActivePranimiCodeForDisplay(), netState.ok)}
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
                // Keep the active reserved BAZ code tied to this local_oid; clearing client fields must not replace/burn the draft code.
              }}
            >
              ✕
            </button>
            <div className="client-selected-main">
              {clientPhotoUrl ? <img src={clientPhotoUrl} alt="" className="client-mini large" /> : <div className="client-avatar-fallback">👤</div>}
              <div className="client-selected-copy">
                <div className="client-copy-topline">
                  <div className="client-code-pill">{`NR ${formatKod(getActivePranimiCodeForDisplay(), netState.ok)}`}</div>
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
        <button className="btn secondary" onPointerDown={() => { try { persistCurrentDraftLocalSync('home_pointerdown_local_first'); } catch {} }} onMouseDown={() => { try { persistCurrentDraftLocalSync('home_mousedown_local_first'); } catch {} }} onClick={async () => { const draftSavedOk = await commitDraftAndAdvanceCodeBestEffort(); const onlineNow = (() => { try { return typeof navigator === 'undefined' ? true : navigator.onLine !== false; } catch { return true; } })(); if (!draftSavedOk && hasStartedWork() && onlineNow) { alert('Drafti nuk u ruajt në DB. Qëndro në PRANIMI dhe provo prapë para se të dalësh.'); return; } try { clearCurrentSessionLocal(); } catch {} try { sessionStorage.setItem(RESET_ON_SHOW_KEY, '1'); } catch {} router.push('/'); }}>🏠 HOME</button>
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
              {draftsRefreshing ? <div style={{ textAlign: 'center', padding: '18px 0', color: 'rgba(255,255,255,0.7)', fontWeight: 900 }}>DUKE VERIFIKUAR DRAFTAT...</div> : uniqueDrafts.length === 0 ? <div style={{ textAlign: 'center', padding: '18px 0', color: 'rgba(255,255,255,0.7)' }}>S’ka “të pa plotsuara”.</div> : (
                uniqueDrafts.map((d) => (
                  <div key={d.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 4px', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
                    <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                      <div style={{ background: '#16a34a', color: '#0b0b0b', padding: '8px 10px', borderRadius: 10, fontWeight: 900, minWidth: 56, textAlign: 'center' }}>{d.code || '—'}</div>
                      <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.8)' }}>
                        <div style={{ fontWeight: 800 }}>KODI: {d.code || '—'}</div>
                        <div style={{ opacity: 0.92, fontWeight: 700 }}>{d.name || 'PA EMËR'}</div>
                        <div style={{ opacity: 0.82 }}>{d.phone ? `${phonePrefix} ${d.phone}` : 'PA TELEFON'}</div>
                        {d.source ? <div style={{ opacity: 0.78, fontWeight: 900 }}>{d.source}</div> : null}
                        <div style={{ opacity: 0.78 }}>{Number(d.m2 || 0).toFixed(2)} m² • {Number(d.euro || 0).toFixed(2)} €</div>
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 10 }}>
                      <button className="btn secondary" onClick={() => loadDraftIntoForm(d)}>HAP</button>
                      <button className="btn secondary" onClick={() => deleteDraft(d)}>FSHI</button>
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

      {localSyncWarning ? (
        <div className="wiz-backdrop" onClick={(e) => e.stopPropagation()}>
          <div className="apple-sheet compact" onClick={(e) => e.stopPropagation()} style={{ border: localSyncWarning?.severity === 'red' ? '1px solid rgba(248,113,113,0.55)' : '1px solid rgba(250,204,21,0.55)', boxShadow: localSyncWarning?.severity === 'red' ? '0 24px 80px rgba(127,29,29,0.45)' : '0 24px 80px rgba(113,63,18,0.42)' }}>
            <div className="apple-sheet-top">
              <div>
                <div className="apple-sheet-title" style={{ color: localSyncWarning?.severity === 'red' ? '#fecaca' : '#fef3c7' }}>
                  {localSyncWarning?.message || 'KJO ORDER ENDE NUK KA HYRË NË DB'}
                </div>
                <div className="apple-sheet-sub">{localSyncWarning?.subtitle || 'LOCAL / NOT SYNCED'}</div>
              </div>
            </div>

            <div className="apple-sheet-body">
              <div className="client-empty-state" style={{ marginTop: 0, textAlign: 'left', borderColor: localSyncWarning?.severity === 'red' ? 'rgba(248,113,113,0.35)' : 'rgba(250,204,21,0.35)', background: localSyncWarning?.severity === 'red' ? 'rgba(127,29,29,0.22)' : 'rgba(113,63,18,0.20)' }}>
                <div style={{ fontWeight: 950, color: localSyncWarning?.severity === 'red' ? '#fecaca' : '#fef3c7' }}>{localSyncWarning?.title || 'RUAJTUR LOKALISHT — DO SINKRONIZOHET KUR TË KETË INTERNET'}</div>
                <div style={{ marginTop: 8, color: 'rgba(255,255,255,0.82)', lineHeight: 1.4 }}>
                  Kodi: <strong>{localSyncWarning?.code || localSyncWarning?.payload?.code || '—'}</strong> • Status: <strong>{localSyncWarning?.status_label || localSyncWarning?.subtitle || 'LOCAL / NOT SYNCED'}</strong>
                </div>
                <div style={{ marginTop: 6, fontSize: 12, color: 'rgba(255,255,255,0.68)', lineHeight: 1.35 }}>
                  {localSyncWarning?.status_label === 'DB VERIFIED' ? 'ORDER U RUAJT NË SISTEM. Mund të vazhdosh.' : 'Lajmëro adminin ose përdor COPY/EXPORT DEBUG. RETRY kontrollon DB-në me local_oid/save_attempt_id para se ta kthejë në outbox.'}
                </div>
                {localSyncWarning?.retry_message ? (
                  <div style={{ marginTop: 8, fontSize: 12, color: 'rgba(255,255,255,0.78)', lineHeight: 1.35 }}>{localSyncWarning.retry_message}</div>
                ) : null}
              </div>

              <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', marginTop: 12, maxHeight: 170, overflow: 'auto', fontSize: 11, lineHeight: 1.35, color: 'rgba(255,255,255,0.78)', background: 'rgba(0,0,0,0.28)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 14, padding: 10 }}>
                {buildLocalSyncProblemText(localSyncWarning)}
              </pre>
            </div>

            <div className="apple-sheet-actions" style={{ gridTemplateColumns: '1fr' }}>
              <button type="button" className="btn primary" onClick={copyLocalSyncProblem}>LAJMËRO ADMININ</button>
              <button type="button" className="btn secondary" onClick={copyLocalSyncProblem}>COPY PROBLEM</button>
              <button type="button" className="btn secondary" onClick={exportLocalSyncDebug}>EXPORT DEBUG</button>
              <button type="button" className="btn" disabled={!!localSyncWarning?.retrying} onClick={retryLocalSyncWarning}>{localSyncWarning?.retrying ? 'DUKE PROVU...' : 'RETRY'}</button>
              <button type="button" className="btn secondary" onClick={continueAfterLocalSyncWarning}>VAZHDO</button>
            </div>
          </div>
        </div>
      ) : null}

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
        <div className="wiz-backdrop" onClick={() => resetClientMatchToPhoneEntry(clientMatchPrompt)}>
          <div className="apple-sheet compact" onClick={(e) => e.stopPropagation()}>
            <div className="apple-sheet-top">
              <div>
                <div className="apple-sheet-title">KY NUMËR EKZISTON</div>
                <div className="apple-sheet-sub">MATCH SIPAS TELEFONIT</div>
              </div>
              <button type="button" className="apple-close" onClick={() => resetClientMatchToPhoneEntry(clientMatchPrompt)}>✕</button>
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
                A don me përdor klientin ekzistues me këtë numër?
                <div style={{ marginTop: 8, fontSize: 12, color: 'rgba(255,255,255,0.7)', lineHeight: 1.35 }}>
                  Për këtë numër përdoret vetëm klienti ekzistues. Për klient të ri, ndërro numrin ose zgjidh PA NUMËR.
                </div>
              </div>
            </div>

            <div className="apple-sheet-actions" style={{ gridTemplateColumns: '1fr' }}>
              <button type="button" className="btn primary" onClick={() => applyClientMatchChoice('use_existing')}>PËRDOR KLIENTIN EKZISTUES</button>
              <button type="button" className="btn" onClick={() => applyClientMatchChoice('cancel_change_phone')}>KTHEHU / NDËRRO NUMRIN</button>
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
                        const cId = String(c?.id || '').trim();
                        const cCode = String(normalizeCode(c?.code || null) || '').trim();
                        if (c.name) setName(String(c.name));
                        if (c.photo_url) setClientPhotoUrl(String(c.photo_url || ''));
                        if (cId && cCode) {
                          codeRawRef.current = cCode;
                          setCodeRaw(cCode);
                          setSelectedClient({
                            id: cId,
                            code: cCode || '',
                            name: c?.name || '',
                            phone: c?.phone || '',
                          });
                        } else {
                          appendPranimiCodeDebug('selected_client_code_rejected_id_null', {
                            local_oid: String(oidRef.current || oid || ''),
                            selected_client_id: null,
                            selected_client_code: cCode || null,
                            final_code: normalizeCode(codeRawRef.current || codeRaw || null),
                            final_code_reason: 'SELECTED_CLIENT_CODE_REJECTED_ID_NULL',
                          });
                          setSelectedClient(null);
                        }
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
                  <input
                    ref={phoneInputRef}
                    className="input"
                    value={noPhone ? '' : phone}
                    onChange={(e) => {
                      const digits = normalizeMatchPhone(e.target.value || '');
                      setPhone(digits);
                      if (digits) setNoPhone(false);
                      const openPromptPhoneDigits = String(clientMatchPrompt?.phoneDigits || '').trim();
                      if (clientMatchPrompt?.open && openPromptPhoneDigits && openPromptPhoneDigits !== digits) {
                        closeClientMatchPrompt('phone_input_changed');
                      }
                      const selectedPhoneDigits = normalizeMatchPhone(selectedClient?.phone || '');
                      if (selectedClient?.id && selectedPhoneDigits && selectedPhoneDigits !== digits) {
                        setSelectedClient(null);
                        setOldClientDebt(0);
                        setClientMatchDecision({ matchKey: '', mode: '', candidate: null });
                      }
                    }}
                    inputMode="numeric"
                    placeholder={noPhone ? 'PA NUMËR' : '44XXXXXX'}
                    disabled={noPhone}
                  />
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
