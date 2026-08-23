Warning: truncated output (original token count: 102968)
Total output lines: 8523

"use client";

import {
  normalizeCode,
  ensureBasePool,
  getBaseCodeReservationDiagnostics,
  ensureBaseCodeEpochFresh,
  resetBaseCodeReservationCompatibilityCache,
} from '@/lib/baseCodes';
import { getPranimiCodeAllocator } from '@/lib/pranimiCodeAllocator';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from '@/lib/routerCompat.jsx';
import { supabase, storageWithTimeout, withSupabaseTimeout } from '@/lib/supabaseClient';
import { listOrderRecords, upsertOrderRecord, updateOrderRecord } from '@/lib/ordersService';
import { fetchOrdersFromDb, fetchClientsFromDb } from '@/lib/ordersDb';
import { enqueueBaseOrder, enqueueOutboxItem, syncNow } from '@/lib/syncManager';
import { getAllOrdersLocal, getPendingOps, saveOrderLocal } from '@/lib/offlineStore';
import { recordCashMove } from '@/lib/arkaCashSync';
import PosModal from '@/components/PosModal';
import { getActor, getActorPinStrict } from '@/lib/actorSession';
import { normalizeRealPin } from '@/lib/pinIdentity';
import { requirePaymentPin } from '@/lib/paymentPin';
import { getClientBalanceByPhone } from '@/lib/clientBalanceDb';
import SmartSmsModal from '@/components/SmartSmsModal';
import { buildSmartSmsText, buildSmsLink } from '@/lib/smartSms';
import { logDebugEvent, trackRender } from '@/lib/sensor';
import { bootLog, bootMarkReady } from '@/lib/bootLog';
import { patchBaseMasterRow } from '@/lib/baseMasterCache';
import { isDiagEnabled } from '@/lib/diagMode';
import useRouteAlive from '@/lib/routeAlive';
import {
  buildPranimiFinalOrderData,
  isPranimiArchivedOrder,
  isPranimiFinalOrderRow,
} from '@/lib/pranimiOrderLifecycle';

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
const LS_BASE_ORDER_CODE_PREFIX = 'base_order_code:';
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
// Meaningful drafts renew this lease on activity. Seven days prevents abandoned
// drafts from locking numeric codes for years.
const LOCK_MINUTES_AFTER_INFO = 60 * 24 * 7;
const PASRTRIMI_EDIT_TO_PRANIMI_KEY = 'tepiha_pastrim_edit_to_pranimi_v1';
const PASRTRIMI_EDIT_TO_PRANIMI_BACKUP_KEY = 'tepiha_pastrim_edit_to_pranimi_backup_v1';
const GATI_EDIT_TO_PRANIMI_KEY = 'tepiha_gati_edit_to_pranimi_v1';
const GATI_EDIT_TO_PRANIMI_BACKUP_KEY = 'tepiha_gati_edit_to_pranimi_backup_v1';
const PRANIMI_ACTIVE_EDIT_BRIDGE_KEY = 'tepiha_pranimi_active_edit_bridge_v1';
const CURRENT_SESSION_KEY = 'tepiha_pranimi_current_session_v1';
const CURRENT_SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const PRANIMI_EXISTING_CLIENT_HANDOFF_KEY = 'tepiha_existing_client_handoff_v1';
const PRANIMI_EXISTING_HANDOFF_MAX_AGE_MS = 30 * 60 * 1000;
const PRANIMI_ENTRY_MODE_NEW = 'NEW_CLIENT_MODE';
const PRANIMI_ENTRY_MODE_EXISTING = 'EXPLICIT_EXISTING_CLIENT_MODE';
const PRANIMI_ENTRY_MODE_RESUME = 'EXPLICIT_RESUME_CURRENT_SESSION';
const PRANIMI_ENTRY_MODE_EDIT = 'EDIT_EXISTING_ORDER_MODE';
const PRANIMI_ENTRY_MODE_DRAFT = 'EXPLICIT_DRAFT_RESUME_MODE';
const PRANIMI_BLANK_DRAFT_RELEASE_MS = 30 * 60 * 1000;
const PRANIMI_DRAFT_RESERVATION_PREFIX = 'pranimi_draft_reservation:';
const PRANIMI_BG_META_TIMEOUT_MS = 2500;
const PRANIMI_BG_POOL_TIMEOUT_MS = 11000;
const PRANIMI_BG_SYNC_MIN_GAP_MS = 6000;
const PRANIMI_CODE_RESERVE_RETRY_DELAYS_MS = [0, 400, 1200, 2500, 5000, 9000, 15000, 30000];
const PRANIMI_DB_DRAFT_SAVE_TIMEOUT_MS = 5000;
const PRANIMI_DB_DRAFT_VERIFY_TIMEOUT_MS = 3500;
const PRANIMI_DB_DRAFT_STATUS = 'incomplete';
const PRANIMI_DB_DRAFT_FALLBACK_TOP_STATUS = 'pranim';
const PRANIMI_CONTINUE_CLIENT_LOOKUP_MS = 1000;
const PRANIMI_DRAFT_GUARD_VERSION = 'v8_db_draft_api_backed_2026_06_05';
const PRANIMI_TEPAPLOTESUARA_UI_GUARD_VERSION = 'tepaplotesuara-v8-db-api-guarded-before-render';
const PRANIMI_CONTINUE_CODE_VERIFY_MS = 6000;
const PRANIMI_CONTINUE_CODE_RESERVE_MS = 12000;
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

function resolvePranimiActorPin(fallbackActor = null, fallbackPin = '') {
  return getActorPinStrict(getActor())
    || getActorPinStrict(fallbackActor)
    || normalizeRealPin(fallbackPin);
}

function makePranimiLocalOid() {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  } catch {}
  return `ord_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

// ONE-WAY ALLOCATOR bridge — this page cannot reserve, mint, consume, or release
// a PRANIMI code outside the central service.
function pranimiCodeAllocator() {
  return getPranimiCodeAllocator();
}

function getAssignedPranimiCode(oid) {
  return normalizeCode(pranimiCodeAllocator().assignedCodeForDraft(String(oid || '').trim()));
}

async function allocatePranimiCode(pin, oid, restoredCode = null, meaningful = false) {
  const args = { pin, oid: String(oid || '').trim(), meaningful: meaningful === true };
  const candidate = normalizeCode(restoredCode);
  const res = candidate == null
    ? await pranimiCodeAllocator().getOrAllocateForDraft(args)
    : await pranimiCodeAllocator().adoptAndVerifyForDraft({ ...args, code: candidate });
  const code = normalizeCode(res?.code);
  if (code == null) {
    const error = new Error('ALLOCATOR_NUK_KTHEU_KOD');
    error.code = 'ALLOCATOR_EMPTY_CODE';
    throw error;
  }
  return { ...res, code };
}

async function verifyPranimiCode(pin, oid, code, meaningful = false) {
  return pranimiCodeAllocator().verifyAssignedCode({ pin, oid: String(oid || '').trim(), code, meaningful: meaningful === true });
}

async function renewPranimiCodeLease(pin, oid, code, meaningful = false) {
  return pranimiCodeAllocator().renewForDraft({ pin, oid: String(oid || '').trim(), code, meaningful: meaningful === true });
}

async function releasePranimiCodeLease(pin, oid, code, reason = 'release_draft') {
  return pranimiCodeAllocator().releaseForDraft({ pin, oid: String(oid || '').trim(), code, reason });
}

async function consumePranimiCode(pin, oid, code, orderId, clientPhone = '') {
  return pranimiCodeAllocator().consumeForDraft({ pin, oid: String(oid || '').trim(), code, orderId, clientPhone });
}

async function verifyExistingPranimiClientCode(clientId, code, phone = '', name = '') {
  return pranimiCodeAllocator().verifyExistingClientCode({ clientId, code, phone, name });
}

async function finalizeExistingClientPranimiCode(pin, oid, finalCode, orderId) {
  return pranimiCodeAllocator().finalizeExistingClientDraft({ pin, oid: String(oid || '').trim(), finalCode, orderId });
}

function acknowledgeFinalizedPranimiCode(pin, oid, code, orderId = '') {
  return pranimiCodeAllocator().acknowledgeFinalizedDraft({ pin, oid: String(oid || '').trim(), code, orderId });
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

async function resolveExplicitExistingClientHandoff({ clientId = '', code = null, name = '', phone = '' } = {}) {
  const wantedId = String(clientId || '').trim();
  const wantedCode = normalizeCode(code ?? null);
  const wantedName = String(name || '').trim();
  const wantedPhoneDigits = normalizeMatchPhone(phone || '');

  const normalizeClientRow = (row = {}) => {
    const full = String(
      row?.full_name ||
      row?.name ||
      [row?.first_name || '', row?.last_name || ''].filter(Boolean).join(' ') ||
      wantedName ||
      ''
    ).trim().replace(/\s+/g, ' ');
    const dbPhone = String(row?.phone || '').trim();
    return {
      id: String(row?.id || '').trim(),
      code: String(normalizeCode(row?.code ?? wantedCode ?? null) || '').trim(),
      name: full,
      phone: dbPhone || phone || '',
      photo_url: row?.photo_url || '',
      full_name: row?.full_name || full,
      first_name: row?.first_name || '',
      last_name: row?.last_name || '',
    };
  };

  const isUsable = (row = {}) => {
    const id = String(row?.id || '').trim();
    const rowCode = normalizeCode(row?.code ?? null);
    if (!id || rowCode == null) return false;
    if (wantedCode != null && String(rowCode) !== String(wantedCode)) return false;
    const dbPhoneDigits = normalizeMatchPhone(row?.phone || '');
    if (wantedPhoneDigits && dbPhoneDigits && wantedPhoneDigits !== dbPhoneDigits) return false;
    return true;
  };

  try {
    if (wantedId) {
      const { data, error } = await supabase
        .from('clients')
        .select('id, code, full_name, first_name, last_name, phone, photo_url, updated_at')
        .eq('id', wantedId)
        .limit(1)
        .maybeSingle();
      if (!error && data && isUsable(data)) return normalizeClientRow(data);
    }
  } catch {}

  try {
    if (wantedCode != null) {
      const { data, error } = await supabase
        .from('clients')
        .select('id, code, full_name, first_name, last_name, phone, photo_url, updated_at')
        .eq('code', wantedCode)
        .order('updated_at', { ascending: false })
        .limit(5);
      if (!error && Array.isArray(data)) {
        const exactPhone = data.find((row) => isUsable(row) && (!wantedPhoneDigits || normalizeMatchPhone(row?.phone || '') === wantedPhoneDigits));
        if (exactPhone) return normalizeClientRow(exactPhone);
        const exactCode = data.find((row) => isUsable(row));
        if (exactCode) return normalizeClientRow(exactCode);
      }
    }
  } catch {}

  try {
    const lookup = wantedPhoneDigits || wantedName || (wantedCode != null ? String(wantedCode) : '');
    if (lookup) {
      const hits = await searchClientsLive(lookup);
      const exact = (Array.isArray(hits) ? hits : []).find((row) => isUsable(row));
      if (exact) return normalizeClientRow(exact);
    }
  } catch {}

  return null;
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

function readPranimiEntryIntent() {
  const fallback = { mode: PRANIMI_ENTRY_MODE_NEW, source: 'default_new_entry', clientId: '', code: null, name: '', phone: '' };
  try {
    if (typeof window === 'undefined') return fallback;
    const params = new URLSearchParams(String(window.location?.search || ''));
    const from = String(params.get('from') || '').trim();
    if (from === 'pastrimi-edit' || from === 'gati-edit') {
      return { ...fallback, mode: PRANIMI_ENTRY_MODE_EDIT, source: from };
    }
    if (params.get('resumeCurrent') === '1') {
      return { ...fallback, mode: PRANIMI_ENTRY_MODE_RESUME, source: 'explicit_resume_current' };
    }

    const existingRequested = params.get('existingClient') === '1';
    let handoff = null;
    try {
      const raw = window.sessionStorage?.getItem(PRANIMI_EXISTING_CLIENT_HANDOFF_KEY);
      const parsed = raw ? safeJsonParse(raw, null) : null;
      const createdAt = Number(parsed?.createdAt || parsed?.created_at || 0);
      if (parsed && (!createdAt || (Date.now() - createdAt) <= PRANIMI_EXISTING_HANDOFF_MAX_AGE_MS)) handoff = parsed;
    } catch {}

    if (existingRequested) {
      const clientId = String(params.get('clientId') || handoff?.clientId || handoff?.client_id || '').trim();
      const code = normalizeCode(params.get('code') || handoff?.clientCode || handoff?.code || null);
      const name = String(params.get('name') || handoff?.name || '').trim();
      const phone = String(params.get('phone') || handoff?.phone || '').trim();
      if (clientId || (code != null && (name || phone))) {
        return {
          mode: PRANIMI_ENTRY_MODE_EXISTING,
          source: from || String(handoff?.source || 'explicit_existing_client'),
          clientId,
          code,
          name,
          phone,
        };
      }
      return { ...fallback, source: 'invalid_existing_client_handoff_rejected' };
    }

    return { ...fallback, source: params.get('fresh') ? 'fresh_new_entry' : 'plain_new_entry' };
  } catch {
    return fallback;
  }
}

function clearPranimiEntryHandoff() {
  try { window.sessionStorage?.removeItem(PRANIMI_EXISTING_CLIENT_HANDOFF_KEY); } catch {}
}

function cleanPranimiEntryUrl() {
  try {
    if (typeof window === 'undefined') return;
    const next = new URL(window.location.href);
    const from = String(next.searchParams.get('from') || '').trim();
    ['fresh', 'existingClient', 'clientId', 'code', 'name', 'phone', 'resumeCurrent'].forEach((key) => next.searchParams.delete(key));
    if (from === 'home_old_search' || from === 'global_home_search') next.searchParams.delete('from');
    const query = next.searchParams.toString();
    window.history.replaceState({}, '', query ? `${next.pathname}?${query}${next.hash || ''}` : `${next.pathname}${next.hash || ''}`);
  } catch {}
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


async function verifyExactPranimiOrderCode(orderId, code, expectedLocalOid = '') {
  const id = String(orderId || '').trim();
  const expectedCode = normalizeCode(code);
  if (!id || expectedCode == null) return { ok: false, reason: 'EDIT_ORDER_ID_OR_CODE_MISSING' };
  const idValue = /^\d+$/.test(id) ? Number(id) : id;
  const { data, error } = await withSupabaseTimeout(
    supabase.from('orders').select('id,local_oid,code,status,data').eq('id', idValue).limit(1).maybeSingle(),
    PRANIMI_CONTINUE_CODE_VERIFY_MS,
    'PRANIMI_EDIT_ORDER_CODE_VERIFY_TIMEOUT',
    { order_id: id, code: expectedCode }
  );
  if (error) throw error;
  if (!data?.id) return { ok: false, reason: 'EDIT_ORDER_NOT_FOUND' };
  const dbCode = normalizeCode(readVerifiedBaseOrderCode(data));
  if (dbCode == null || dbCode !== expectedCode) return { ok: false, reason: 'EDIT_ORDER_CODE_MISMATCH', dbCode, expectedCode };
  const expectedOid = String(expectedLocalOid || '').trim();
  const dbOid = readVerifiedBaseOrderLocalOid(data);
  if (expectedOid && dbOid && expectedOid !== dbOid) return { ok: false, reason: 'EDIT_ORDER_DRAFT_MISMATCH', dbOid, expectedOid };
  return { ok: true, verified: true, code: expectedCode, order: data };
}

function readSessionReservedBaseCode(localOid = '') {
  // Legacy name retained for draft migration candidates; reads only through the
  // official allocator storage adapter and never authorizes display/save itself.
  return getAssignedPranimiCode(localOid);
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


function readLockedDraftOwnerPinFromPool(row = {}, localOid = '', code = null) {
  try {
    if (!row || typeof row !== 'object') return '';
    const status = String(row?.status || row?.pool_status || '').trim().toLowerCase();
    if (status !== 'reserved') return '';
    const rowCode = normalizeCode(row?.code ?? row?.pool_code ?? row?.base_code ?? null);
    const expectedCode = normalizeCode(code);
    if (expectedCode != null && rowCode != null && String(rowCode) !== String(expectedCode)) return '';
    const sid = String(row?.draft_session_id || row?.local_oid || '').trim();
    const expectedOid = String(localOid || '').trim();
    if (expectedOid && sid && sid !== expectedOid) return '';
    return normalizeRealPin(row?.reserved_by || row?.pin || '');
  } catch {
    return '';
  }
}

function resolveDraftCodeLifecyclePin({ localOid = '', code = null, fallbackPin = '', draft = null, poolRow = null } = {}) {
  const id = String(localOid || '').trim();
  const candidate = normalizeCode(code);
  const fallback = normalizeRealPin(fallbackPin);

  const poolOwnerPin = readLockedDraftOwnerPinFromPool(poolRow, id, candidate);
  if (poolOwnerPin) return poolOwnerPin;

  try {
    const meta = readDraftReservationLocal(id) || {};
    const metaCode = normalizeCode(meta?.code ?? meta?.codeRaw ?? null);
    const metaPin = normalizeRealPin(meta?.created_by_pin || meta?.pin || meta?.reserved_by || '');
    if (metaPin && (candidate == null || metaCode == null || String(metaCode) === String(candidate))) return metaPin;
  } catch {}

  try {
    const life = {
      ...(((draft?.draft_lifecycle && typeof draft.draft_lifecycle === 'object') ? draft.draft_lifecycle : {})),
      ...(((draft?.pranimi_code_lifecycle && typeof draft.pranimi_code_lifecycle === 'object') ? draft.pranimi_code_lifecycle : {})),
      ...(((draft?.data?.pranimi_code_lifecycle && typeof draft.data.pranimi_code_lifecycle === 'object') ? draft.data.pranimi_code_lifecycle : {})),
      ...(((draft?.data?.draft_lifecycle && typeof draft.data.draft_lifecycle === 'object') ? draft.data.draft_lifecycle : {})),
    };
    const lifeCode = normalizeCode(life?.code ?? life?.final_code ?? draft?.code ?? draft?.codeRaw ?? null);
    const lifePin = normalizeRealPin(life?.pin || life?.created_by_pin || life?.reserved_by || draft?.reserved_by || '');
    if (lifePin && (candidate == null || lifeCode == null || String(lifeCode) === String(candidate))) return lifePin;
  } catch {}

  return fallback;
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


async function safeCleanupPranimiClientCreatedInThisFlow({ client, expected = {}, reason = 'ORDER_SAVE_FAILED' } = {}) {
  // Protection rule: the browser never deletes a client. A failed or ambiguous
  // order save retains all real DB data for review/retry.
  appendPranimiCodeDebug('client_cleanup_disabled_protect_real_db', {
    client_id: String(client?.id || '').trim() || null,
    client_code: normalizeCode(expected?.code ?? client?.code ?? null),
    reason,
  });
  return { ok: false, skipped: true, reason: 'DIRECT_CLIENT_DELETE_DISABLED' };
}

function clearPranimiLocalDraftsAfterEpochChange() {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    const toRemove = [];
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      if (!key) continue;
      if (key === DRAFT_LIST_KEY || key.startsWith(DRAFT_ITEM_PREFIX)) toRemove.push(key);
    }
    for (const key of toRemove) {
      try { window.localStorage.removeItem(key); } catch {}
    }
  } catch {}
}

async function ensureFreshPranimiEpoch(pin = '') {
  try {
    const result = await ensureBaseCodeEpochFresh(pin);
    if (result?.changed) clearPranimiLocalDraftsAfterEpochChange();
    return result?.changed === true;
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
  if (isPranimiArchivedOrder(row)) return false;
  if (isPranimiFinalOrderRow(row)) return false;
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


function applyPranimiFinalLifecycleToPayload(payload = {}, opts = {}) {
  if (!payload || typeof payload !== 'object') return payload;
  const status = String(opts?.status || payload?.status || payload?.data?.status || 'pastrim').trim() || 'pastrim';
  const localOid = String(opts?.localOid || opts?.local_oid || payload?.local_oid || payload?.data?.local_oid || '').trim();
  const saveAttemptId = String(opts?.saveAttemptId || opts?.save_attempt_id || payload?.data?.pranimi_code_lifecycle?.save_attempt_id || payload?.data?.save_attempt_id || '').trim();
  payload.status = status;
  payload.data = buildPranimiFinalOrderData(payload?.data || {}, {
    status,
    localOid,
    saveAttemptId,
    verifyState: opts?.verifyState || opts?.db_verify_state || 'DB_VERIFIED',
    source: opts?.source || 'DB_FINAL',
    draftSource: opts?.draftSource || opts?.pranimi_draft_source || 'FINAL / PRANIMI',
    serverId: opts?.serverId || opts?.server_id || '',
    updatedAt: payload?.updated_at || opts?.updatedAt || opts?.updated_at,
  });
  return payload;
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

async function safeDirectPranimiDraftWrite(row = {}, reason = 'autosave_db_draft') {
  const localOid = String(row?.local_oid || row?.data?.local_oid || '').trim();
  if (!localOid) return { ok: false, reason: 'DIRECT_DRAFT_LOCAL_OID_REQUIRED' };

  const existingHit = await findBaseOrderByLocalOidAny(localOid, PRANIMI_DRAFT_ORDER_SELECT);
  const existing = existingHit?.row || null;
  if (existing && isBlockingPranimiDraftOrder(existing)) {
    return { ok: false, blocked: true, reason: 'DIRECT_DRAFT_FINAL_ORDER_EXISTS', row: existing };
  }

  const variants = [
    buildPranimiDbDraftRowForTopStatus(row, PRANIMI_DB_DRAFT_STATUS),
    buildPranimiDbDraftRowForTopStatus(row, PRANIMI_DB_DRAFT_FALLBACK_TOP_STATUS),
  ];
  let lastError = null;

  if (existing?.id) {
    const expectedUpdatedAt = String(existing?.updated_at || '').trim();
    if (!expectedUpdatedAt) return { ok: false, blocked: true, reason: 'DIRECT_DRAFT_CAS_TIMESTAMP_MISSING', row: existing };

    for (let i = 0; i < variants.length; i += 1) {
      try {
        const { data, error } = await supabase
          .from('orders')
          .update(variants[i])
          .eq('id', existing.id)
          .eq('updated_at', expectedUpdatedAt)
          .select(PRANIMI_DRAFT_ORDER_SELECT)
          .maybeSingle();
        if (error) throw error;
        if (data) return { ok: true, row: data, via: i === 0 ? 'direct_cas_incomplete' : 'direct_cas_pranim_fallback' };

        const currentHit = await findBaseOrderByLocalOidAny(localOid, PRANIMI_DRAFT_ORDER_SELECT);
        const current = currentHit?.row || null;
        return {
          ok: false,
          blocked: true,
          reason: current && isBlockingPranimiDraftOrder(current)
            ? 'DIRECT_DRAFT_FINAL_ORDER_WON_RACE'
            : 'DIRECT_DRAFT_COMPARE_AND_SWAP_LOST',
          row: current || existing,
        };
      } catch (error) {
        lastError = error;
      }
    }
    return { ok: false, reason: 'DIRECT_DRAFT_UPDATE_FAILED', error: lastError };
  }

  for (let i = 0; i < variants.length; i += 1) {
    try {
      const { data, error } = await supabase
        .from('orders')
        .insert(variants[i])
        .select(PRANIMI_DRAFT_ORDER_SELECT)
        .maybeSingle();
      if (error) throw error;
      if (data) return { ok: true, row: data, via: i === 0 ? 'direct_insert_incomplete' : 'direct_insert_pranim_fallback' };
    } catch (error) {
      lastError = error;
      const currentHit = await findBaseOrderByLocalOidAny(localOid, PRANIMI_DRAFT_ORDER_SELECT);
      const current = currentHit?.row || null;
      if (current && isBlockingPranimiDraftOrder(current)) {
        return { ok: false, blocked: true, reason: 'DIRECT_DRAFT_FINAL_ORDER_WON_INSERT_RACE', row: current };
      }
      if (current) return { ok: false, blocked: true, reason: 'DIRECT_DRAFT_CONCURRENT_ROW_EXISTS', row: current };
    }
  }

  return { ok: false, reason: 'DIRECT_DRAFT_INSERT_FAILED', error: lastError };
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

    // V476: the direct fallback is compare-and-swap only. Never use an
    // unconditional upsert on local_oid, because a late draft write could race
    // a final save and downgrade PASRIM back to PRANIM.
    const directWrite = await withSupabaseTimeout(
      safeDirectPranimiDraftWrite(row, reason),
      9000,
      'PRANIMI_DB_DRAFT_SAFE_DIRECT_TIMEOUT',
      { source: 'upsertDraftDb:safeDirectCas', local_oid: row.local_oid, code: row.code, reason }
    ).catch((error) => ({ ok: false, reason: 'DIRECT_DRAFT_SAFE_WRITE_THROW', error }));

    if (!directWrite?.ok) {
      appendPranimiCodeDebug('db_draft_safe_direct_blocked_or_failed', {
        local_oid: row.local_oid,
        code: row.code,
        direct_reason: directWrite?.reason || 'UNKNOWN',
        blocked: !!directWrite?.blocked,
        current_order_id: directWrite?.row?.id || null,
        current_status: readPranimiDraftOrderStatus(directWrite?.row || {}),
        error: String(directWrite?.error?.message || directWrite?.error || ''),
        reason,
      });
      return false;
    }

    const verify = await verifyPranimiDbDraftSaved({ ...draft, local_oid: row.local_oid, codeRaw: row.code, code: row.code });
    if (!verify?.ok) {
      appendPranimiCodeDebug('db_draft_verify_failed', {
        local_oid: row.local_oid,
        code: row.code,
        verify_reason: verify?.reason || 'UNKNOWN',
        direct_write_via: directWrite?.via || null,
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

    // V39.1 protection: the browser never falls back to a direct orders DELETE.
    // The guarded API is the only delete authority because it verifies draft flags
    // server-side before touching a row. Ambiguity leaves the row intact.
    appendPranimiCodeDebug('db_draft_direct_delete_blocked', {
      local_oid: localOid || null,
      db_order_id: dbOrderId || null,
      api_reason: apiDelete?.reason || apiDelete?.error || 'API_DELETE_NOT_CONFIRMED',
    });
    return false;
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
  // Fail-safe rule: finalized/archived public.orders rows always block draft writes.
  if (isPranimiArchivedOrder(row) || isPranimiFinalOrderRow(row)) return true;
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

function extractPranimiDraftSafetyIds(…62968 tokens truncated… of keys) out.local_storage[k] = localStorage.getItem(k);
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

  async function finalizeRetryCodeLifecycle(verifiedRow = {}, payload = {}, warning = {}) {
    const data = (payload?.data && typeof payload.data === 'object') ? payload.data : {};
    const life = (data?.pranimi_code_lifecycle && typeof data.pranimi_code_lifecycle === 'object') ? data.pranimi_code_lifecycle : {};
    const pin = normalizeRealPin(life?.pin) || resolvePranimiActorPin(actor);
    const draftId = String(life?.local_oid || data?.local_oid || payload?.local_oid || warning?.local_oid || '').trim();
    const code = normalizeCode(payload?.code ?? data?.code ?? life?.final_code ?? warning?.code ?? null);
    const orderId = String(verifiedRow?.id || warning?.server_id || '').trim();
    const mode = String(warning?.code_lifecycle_mode || life?.code_lifecycle_mode || (warning?.is_base_edit ? 'EDIT_EXISTING_ORDER' : (life?.selected_client_id ? 'EXISTING_CLIENT_HISTORICAL_CODE' : 'NEW_ASSIGNED_CODE'))).trim();
    if (!pin || !draftId || code == null || !orderId) return { ok: false, reason: 'RETRY_CODE_LIFECYCLE_KEYS_MISSING', mode, pin, draftId, code, orderId };
    if (mode === 'EDIT_EXISTING_ORDER') return { ok: true, skipped: true, reason: 'EDIT_KEEPS_EXISTING_CODE', mode };
    let result;
    if (mode === 'EXISTING_CLIENT_HISTORICAL_CODE') result = await finalizeExistingClientPranimiCode(pin, draftId, code, orderId);
    else result = await consumePranimiCode(pin, draftId, code, orderId, payload?.client_phone || data?.client_phone || '');
    if (!result?.ok) return { ...result, ok: false, mode };
    const assignedForAck = normalizeCode(result?.tempCode ?? result?.code ?? getAssignedPranimiCode(draftId));
    if (assignedForAck != null) {
      const ack = acknowledgeFinalizedPranimiCode(pin, draftId, assignedForAck, orderId);
      if (!ack?.ok) return { ok: false, reason: ack?.reason || 'RETRY_CODE_ACK_FAILED', mode, result };
    }
    return { ...result, ok: true, mode };
  }

  async function retryLocalSyncWarning() {
    const current = localSyncWarning || {};
    const payload = (current?.payload && typeof current.payload === 'object') ? current.payload : {};
    const safety = extractPranimiSyncSafety(payload, current);
    setLocalSyncWarning({ ...current, retrying: true, retry_message: 'DUKE VERIFIKUAR DB PARA RETRY...' });
    try {
      const before = await verifyBaseOrderInDbBySafetyIds(payload, current);
      if (before?.found) {
        const lifecycleResult = await finalizeRetryCodeLifecycle(before.row || {}, payload, current);
        if (!lifecycleResult?.ok) {
          setLocalSyncWarning((prev) => ({ ...(prev || current), retrying: false, severity: 'red', title: 'ORDER U GJET, POR KODI NUK U FINALIZUA', subtitle: 'CODE LIFECYCLE PENDING', status_label: 'DB VERIFIED / CODE PENDING', retry_message: `RETRY I KODIT DËSHTOI: ${lifecycleResult?.reason || 'NOT_CONFIRMED'}`, last_error: lifecycleResult?.reason || 'CODE_LIFECYCLE_NOT_CONFIRMED' }));
          return;
        }
        try {
          appendPranimiCodeDebug('resolved_linked', {
            local_oid: safety.local_oid || before?.row?.local_oid || '',
            save_attempt_id: safety.save_attempt_id || '',
            outbox_op_id: safety.outbox_op_id || '',
            server_id: String(before?.row?.id || ''),
            via: before?.via || '',
          });
          const resolvedData = buildPranimiFinalOrderData({
            ...(((before?.row?.data && typeof before.row.data === 'object') ? before.row.data : {})),
            ...(((payload?.data && typeof payload.data === 'object') ? payload.data : {})),
          }, {
            status: before?.row?.status || payload?.status || payload?.data?.status || 'pastrim',
            localOid: before?.row?.local_oid || safety.local_oid || payload?.data?.local_oid || '',
            saveAttemptId: safety.save_attempt_id || payload?.data?.pranimi_code_lifecycle?.save_attempt_id || '',
            verifyState: 'DB_VERIFIED',
            source: 'DB_FINAL',
            draftSource: 'FINAL / MANUAL RETRY VERIFIED',
            serverId: String(before?.row?.id || ''),
          });
          resolvedData.pranimi_code_lifecycle.db_verify_via = before?.via || 'manual_retry_precheck';
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
      const retryLocalOid = safety.local_oid || payload?.local_oid || payload?.data?.local_oid || oid;
      const retryPayload = applyPranimiFinalLifecycleToPayload({ ...payload, data: { ...((payload?.data && typeof payload.data === 'object') ? payload.data : {}) } }, {
        status: payload?.status || payload?.data?.status || 'pastrim',
        localOid: retryLocalOid,
        saveAttemptId: safety.save_attempt_id || payload?.data?.pranimi_code_lifecycle?.save_attempt_id || payload?.data?.save_attempt_id || '',
        verifyState: 'LOCAL / NOT SYNCED',
        source: 'DB_FINAL_LOCAL_PENDING',
        draftSource: 'FINAL / MANUAL RETRY OUTBOX',
      });
      retryPayload.data.save_attempt_id = safety.save_attempt_id || retryPayload.data.save_attempt_id || null;
      const requeued = await enqueueBaseOrder({
        id: retryLocalOid,
        local_oid: retryLocalOid,
        ...retryPayload,
      });
      appendPranimiCodeDebug('manual_reenqueue', {
        local_oid: safety.local_oid || '',
        save_attempt_id: safety.save_attempt_id || '',
        previous_outbox_op_id: safety.outbox_op_id || '',
        outbox_op_id: requeued?.op_id || requeued?.outbox_op_id || '',
      });
      const res = await syncNow({ immediate: true, source: 'pranimi_local_not_synced_manual_reenqueue' });
      const after = await verifyBaseOrderInDbBySafetyIds(payload, { ...current, outbox_op_id: requeued?.op_id || requeued?.outbox_op_id || safety.outbox_op_id || '' });
      let afterLifecycle = null;
      if (after?.found) {
        afterLifecycle = await finalizeRetryCodeLifecycle(after.row || {}, payload, { ...current, outbox_op_id: requeued?.op_id || requeued?.outbox_op_id || safety.outbox_op_id || '' });
        if (!afterLifecycle?.ok) {
          setLocalSyncWarning((prev) => ({ ...(prev || current), retrying: false, severity: 'red', title: 'ORDER U RUAJT, POR KODI NUK U FINALIZUA', subtitle: 'CODE LIFECYCLE PENDING', status_label: 'DB VERIFIED / CODE PENDING', retry_message: `RETRY I KODIT DËSHTOI: ${afterLifecycle?.reason || 'NOT_CONFIRMED'}`, last_error: afterLifecycle?.reason || 'CODE_LIFECYCLE_NOT_CONFIRMED' }));
          return;
        }
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
    const status = String(warning?.status_label || warning?.subtitle || '').trim().toUpperCase();
    if (status !== 'DB VERIFIED') {
      alert('Ruajtja/lifecycle i kodit nuk është konfirmuar. Qëndro në këtë draft dhe përdor RETRY me të njëjtin kod.');
      return;
    }
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
        const verifiedSmsOrderId = String(
          warning?.server_id ||
          warning?.retry_result?.server_id ||
          data?.pranimi_code_lifecycle?.server_id ||
          ''
        ).trim();
        const smsOrderPayload = JSON.parse(JSON.stringify({
          id: String(data?.id || data?.local_oid || payload?.local_oid || warning?.local_oid || ''),
          order_id: verifiedSmsOrderId,
          public_order_id: verifiedSmsOrderId,
          db_id: verifiedSmsOrderId,
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
            order_id: verifiedSmsOrderId,
            public_order_id: verifiedSmsOrderId,
            db_id: verifiedSmsOrderId,
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
          <button
            type="button"
            className="badge pranim-top-code-badge"
            title={getActivePranimiCodeForDisplay()
              ? `KODI: ${formatKod(getActivePranimiCodeForDisplay(), netState.ok)}`
              : (codeReserveUi.message || 'KODI PO REZERVOHET — PREK PËR ME PROVU PRAP')}
            aria-label={getActivePranimiCodeForDisplay()
              ? `KODI: ${formatKod(getActivePranimiCodeForDisplay(), netState.ok)}`
              : (codeReserveUi.message || 'PROVO REZERVIMIN E KODIT PRAP')}
            onClick={() => {
              const activeOid = String(oidRef.current || oid || '').trim();
              if (activeOid && normalizeCode(codeRawRef.current || codeRaw) == null) {
                resetBaseCodeReservationCompatibilityCache();
                setCodeReserveUi({ status: 'reserving', message: 'DUKE MARRË KODIN…', raw: '' });
                queueBackgroundMetaSync('manual_code_badge_retry', 0);
                tryReserveCodeInBackground(activeOid, 'manual_code_badge_retry', { attempt: 0, delayMs: 0, force: true });
              }
            }}
            style={{ border: 0, cursor: getActivePranimiCodeForDisplay() ? 'default' : 'pointer' }}
          >
            {getActivePranimiCodeForDisplay()
              ? formatKod(getActivePranimiCodeForDisplay(), netState.ok)
              : (codeReserveUi.status === 'error' ? 'PROVO' : formatKod(null, netState.ok))}
          </button>
          {!getActivePranimiCodeForDisplay() && codeReserveUi.message ? (
            <div
              role={codeReserveUi.status === 'error' ? 'alert' : 'status'}
              style={{
                marginTop: 4,
                maxWidth: 190,
                textAlign: 'center',
                fontSize: 10,
                lineHeight: 1.2,
                fontWeight: 800,
                color: codeReserveUi.status === 'error' ? '#ff9c9c' : 'rgba(255,255,255,0.72)',
              }}
              title={codeReserveUi.raw || codeReserveUi.message}
            >
              {codeReserveUi.message}
            </div>
          ) : null}
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
                clearSelectedClientBinding('client_card_closed_restore_temp_code', { clearIdentity: true });
                // Keep and restore the active reserved BAZ code tied to this local_oid.
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
                      <div style={{ background: '#16a34a', color: '#0b0b0b', padding: '8px 10px', borderRadius: 10, fontWeight: 900, minWidth: 56, textAlign: 'center' }}>{readDraftDisplayCode(d) || '…'}</div>
                      <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.8)' }}>
                        <div style={{ fontWeight: 800 }}>KODI: {readDraftDisplayCode(d) || 'VERIFIKOHET KUR HAPET'}</div>
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
                      onClick={async () => {
                        const contextToken = Number(clientContextTokenRef.current || 0);
                        const contextOid = String(oidRef.current || oid || '').trim();
                        const cId = String(c?.id || '').trim();
                        const cCode = normalizeCode(c?.code || null);
                        codeRawRef.current = '';
                        setCodeRaw('');
                        setCodeReserveUi({ status: 'reserving', message: 'DUKE VERIFIKU KODIN E KLIENTIT…', raw: '' });
                        try {
                          const verdict = await verifyExistingPranimiClientCode(cId, cCode, c?.phone || '', c?.name || '');
                          if (!isPranimiClientContextCurrent(contextToken, contextOid)) {
                            appendPranimiCodeDebug('selected_client_search_verify_ignored_stale_context', { local_oid: contextOid || null, selected_client_id: cId || null, selected_client_code: cCode });
                            return;
                          }
                          if (!verdict?.ok) throw Object.assign(new Error(verdict?.reason || 'EXISTING_CLIENT_CODE_NOT_VERIFIED'), { code: verdict?.reason || 'EXISTING_CLIENT_CODE_NOT_VERIFIED' });
                          const verifiedCode = String(normalizeCode(verdict.code));
                          if (c.name) setName(String(c.name));
                          if (c.photo_url) setClientPhotoUrl(String(c.photo_url || ''));
                          codeRawRef.current = verifiedCode;
                          setCodeRaw(verifiedCode);
                          setSelectedClient({ id: cId, code: verifiedCode, name: c?.name || '', phone: c?.phone || '' });
                          const nextPhone = String(c.phone || '').replace(/\D/g, '');
                          setPhone(nextPhone);
                          setNoPhone(!nextPhone);
                          setCodeReserveUi({ status: 'ready', message: '', raw: '' });
                          setClientQuery('');
                          setClientHits([]);
                          setShowClientSearch(false);
                        } catch (error) {
                          if (!isPranimiClientContextCurrent(contextToken, contextOid)) return;
                          setSelectedClient(null);
                          restoreActiveDraftAssignedCode('selected_client_search_verify_failed_restore_temp_code');
                          appendPranimiCodeDebug('selected_client_code_db_verify_blocked', { local_oid: String(oidRef.current || oid || ''), selected_client_id: cId || null, selected_client_code: cCode, error: String(error?.code || error?.message || error || '') });
                          alert('Kodi i klientit nuk u verifikua në DB. Zgjedhja u ndal për siguri.');
                        }
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
                <input
                  className="input"
                  value={name}
                  onChange={(e) => {
                    const nextName = e.target.value;
                    setName(nextName);
                    const selectedName = normalizeMatchName(selectedClient?.name || '');
                    if (selectedClient?.id && selectedName && selectedName !== normalizeMatchName(nextName)) {
                      clearSelectedClientBinding('selected_client_name_changed_restore_temp_code');
                    }
                  }}
                  placeholder="EMRI I KLIENTIT"
                />
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
                        clearSelectedClientBinding('selected_client_phone_changed_restore_temp_code');
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
                        clearSelectedClientBinding('selected_client_switched_to_no_phone_restore_temp_code');
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
