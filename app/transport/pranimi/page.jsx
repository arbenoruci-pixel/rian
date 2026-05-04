"use client";
import { computeM2FromRows } from '@/lib/baseCodes';
import { reserveTransportCode } from '@/lib/transportCodes';
import { normalizePhoneDigits } from '@/lib/transport/clientCodes';
import { upsertTransportClient } from '@/lib/transport/transportDb';
import React, { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from '@/lib/routerCompat.jsx';
import { supabase, storageWithTimeout, withSupabaseTimeout } from '@/lib/supabaseClient';
import { getPendingOps } from '@/lib/offlineStore';
import { getTransportSession, getTransportContext } from '@/lib/transportAuth';
import { readBestActor } from '@/lib/sessionStore';
import { recordCashMove } from '@/lib/arkaCashSync';
import PosModal from '@/components/PosModal';
import { requirePaymentPin } from '@/lib/paymentPin';
import { getClientBalanceByPhone } from '@/lib/clientBalanceDb';
import { enqueueTransportOrder, syncNow } from '@/lib/syncManager';
import { addTransportCollected } from '@/lib/transportArkaStore';
import { fetchTransportOrderById, listTransportOrders, searchTransportClientCandidatesByOrders, updateTransportOrderById } from '@/lib/transportOrdersDb';
import { buildSmsLink } from '@/lib/smartSms';
import { trackRender } from '@/lib/sensor';
import useRouteAlive from '@/lib/routeAlive';

function V33PageOpenFallback() {
  return (
    <div style={{ minHeight: '100vh', background: '#05070d', color: '#fff', display: 'grid', placeItems: 'center', padding: 24, fontFamily: '-apple-system,BlinkMacSystemFont,Roboto,sans-serif' }}>
      <div style={{ width: 'min(420px, 100%)', border: '1px solid rgba(255,255,255,0.14)', borderRadius: 20, background: 'rgba(255,255,255,0.06)', padding: 20, textAlign: 'center' }}>
        <div style={{ fontSize: 18, fontWeight: 900, letterSpacing: 1 }}>DUKE HAPUR…</div>
        <div style={{ marginTop: 14, display: 'flex', gap: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
          <a href="/" style={{ color: '#fff', textDecoration: 'none', border: '1px solid rgba(255,255,255,0.18)', borderRadius: 12, padding: '10px 14px', fontWeight: 900 }}>HOME</a>
          <a href="/diag-raw" style={{ color: '#fff', textDecoration: 'none', border: '1px solid rgba(255,255,255,0.18)', borderRadius: 12, padding: '10px 14px', fontWeight: 900 }}>DIAG RAW</a>
        </div>
      </div>
    </div>
  );
}
const BUCKET = 'tepiha-photos';
const TEPIHA_CHIPS = [2.0, 2.5, 3.0, 3.5, 3.7, 4.0, 5.0, 6.0, 8.0, 12.0];
const STAZA_CHIPS = [0.5, 0.8, 0.9, 1.2, 1.5, 1.6, 2.0, 2.4, 2.5, 3.0, 4.0, 5.0];
const SHKALLORE_QTY_CHIPS = [5, 10, 15, 20, 25, 30];
const SHKALLORE_PER_CHIPS = [0.25, 0.3, 0.35, 0.4];
const SHKALLORE_M2_PER_STEP_DEFAULT = 0.3;
const PRICE_DEFAULT = 1.8;
const LEGACY_TRANSPORT_PRICE_DEFAULTS = new Set([1.5, 3]);
const PAY_CHIPS = [5, 10, 20, 30, 50];
const PREFIX_OPTIONS = [
  { flag: '🇽🇰', code: '+383', label: 'KOSOVË' },
  { flag: '🇦🇱', code: '+355', label: 'SHQIPËRI' },
  { flag: '🇲🇰', code: '+389', label: 'MAQEDONI' },
  { flag: '🇨🇭', code: '+41',  label: 'ZVICËR' },
  { flag: '🇩🇪', code: '+49',  label: 'GJERMANI' },
  { flag: '🇦🇹', code: '+43',  label: 'AUSTRI' },
];
const DRAFT_LIST_KEY = 'transport_draft_orders_v1';
const DRAFT_ITEM_PREFIX = 'transport_draft_order_';
const COMPANY_PHONE_DISPLAY = '+383 44 735 312';
const AUTO_MSG_KEY = 'transport_pranimi_auto_msg_after_save';
const PRICE_KEY = 'transport_pranimi_price_per_m2';
const OFFLINE_MODE_KEY = 'transport_offline_mode_v1';
function normalizeTcode(raw) {
  if (!raw) return 'T0';
  const s = String(raw).trim();
  if (/^t\d+/i.test(s)) {
    const n = s.replace(/\D+/g, '').replace(/^0+/, '');
    return `T${n || '0'}`;
  }
  const n = s.replace(/\D+/g, '').replace(/^0+/, '');
  return `T${n || '0'}`;
}
const ACTIVE_CODE_KEY = 'transport_pranimi_active_code_v1';
const CODE_LEASE_KEY = 'transport_code_lease_v1';
const DRAFTS_FOLDER = 'transport_drafts';
const SETTINGS_FOLDER = 'transport_settings';
const TRANSPORT_CLIENT_SEARCH_TIMEOUT_MS = 12000;
// ---------------- HELPERS ----------------
function sanitizePhone(phone) { return String(phone || '').replace(/\D+/g, ''); }
function normDigits(s) { return String(s || '').replace(/\D+/g, ''); }
function normalizeNewTransportPricePerM2(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return PRICE_DEFAULT;
  for (const legacy of LEGACY_TRANSPORT_PRICE_DEFAULTS) {
    if (Math.abs(n - legacy) < 0.001) return PRICE_DEFAULT;
  }
  return n;
}
function looksUuid(value) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || '').trim()); }
function isOpaqueUserRef(value) {
  const raw = String(value || '').trim();
  if (!raw) return false;
  if (/^ADMIN_/i.test(raw)) return true;
  if (looksUuid(raw)) return true;
  return /^\d{3,}$/.test(raw);
}
function cleanVisibleName(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return isOpaqueUserRef(raw) ? '' : raw;
}

function readPendingTransportPayload(op) {
  const payload = op?.payload && typeof op.payload === 'object'
    ? op.payload
    : (op?.data && typeof op.data === 'object' ? op.data : {});
  return payload && typeof payload === 'object' ? payload : {};
}

async function hasPendingTransportQueueItem(oid) {
  const targetId = String(oid || '').trim();
  if (!targetId) return false;
  const pendingOps = await getPendingOps().catch(() => []);
  return (Array.isArray(pendingOps) ? pendingOps : []).some((op) => {
    const payload = readPendingTransportPayload(op);
    const table = String(payload?.table || op?.table || payload?._table || '').trim();
    if (table !== 'transport_orders') return false;
    const rowId = String(payload?.id || payload?.local_oid || payload?.oid || op?.id || '').trim();
    return rowId === targetId;
  });
}
function displayTransportName(value, lookup, fallback = '') {
  const direct = cleanVisibleName(value);
  if (direct) return direct;
  const raw = String(value || '').trim();
  const digit = normDigits(raw);
  const byDigit = digit ? String(lookup?.get(digit) || '').trim() : '';
  if (byDigit) return byDigit;
  const byRaw = raw ? String(lookup?.get(raw) || '').trim() : '';
  if (byRaw) return byRaw;
  return fallback;
}
function readCodeLease() { try { return JSON.parse(localStorage.getItem(CODE_LEASE_KEY)); } catch { return null; } }
function writeCodeLease(tid, code) { try { localStorage.setItem(CODE_LEASE_KEY, JSON.stringify({ tid: String(tid), code: String(code), at: Date.now() })); } catch {} }

function transportOrderCodeCacheKey(oid) {
  return `transport_order_code_v1__${String(oid || '').trim()}`;
}

function transportPoolMirrorKey(ownerId) {
  return `transport_pool_mirror_${String(ownerId || '').trim()}`;
}

function uniqSortedTransportCodes(values = []) {
  const arr = Array.from(new Set((Array.isArray(values) ? values : [])
    .map((value) => normalizeTcode(value))
    .filter((value) => value && value !== 'T0')));
  arr.sort((a, b) => {
    const na = Number(String(a).replace(/\D+/g, '') || 0);
    const nb = Number(String(b).replace(/\D+/g, '') || 0);
    return na - nb;
  });
  return arr;
}

function releaseUnusedWarmTransportCode(ownerId, code, orderId) {
  if (typeof window === 'undefined' || typeof localStorage === 'undefined') return;
  const owner = String(ownerId || '').trim();
  const cleanCode = normalizeTcode(code);
  if (!owner || !cleanCode || cleanCode === 'T0') return;
  try {
    const orderKey = transportOrderCodeCacheKey(orderId);
    const cached = String(localStorage.getItem(orderKey) || '').trim();
    if (!cached || normalizeTcode(cached) === cleanCode) {
      localStorage.removeItem(orderKey);
    }
  } catch {}
  try {
    const mirrorKey = transportPoolMirrorKey(owner);
    const raw = localStorage.getItem(mirrorKey);
    const arr = raw ? JSON.parse(raw) : [];
    localStorage.setItem(mirrorKey, JSON.stringify(uniqSortedTransportCodes([...(Array.isArray(arr) ? arr : []), cleanCode])));
  } catch {}
}
async function getOrReserveTransportCode(tid, opts = {}) {
  const TID = String(tid || '').trim();
  if (!TID) return '';
  return reserveTransportCode(TID, opts);
}
function readClientCodeMap(tid) {
  try {
    const key = `transport_client_code_map_v1_${String(tid || '')}`;
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function normalizeTransportPhoneKey(value) {
  let digits = normalizePhoneDigits(value);
  if (digits.startsWith('00383')) digits = digits.slice(5);
  else if (digits.startsWith('383') && digits.length >= 10) digits = digits.slice(3);
  if (digits.startsWith('0') && digits.length >= 8) digits = digits.replace(/^0+/, '');
  return digits;
}

function isValidTransportPhoneDigits(value) {
  const key = normalizeTransportPhoneKey(value);
  return key.length >= 8;
}

function buildTransportPhoneVariants(value) {
  const raw = normalizePhoneDigits(value);
  const key = normalizeTransportPhoneKey(raw);
  const variants = new Set();
  if (raw) variants.add(raw);
  if (key) {
    variants.add(key);
    variants.add(`0${key}`);
    variants.add(`383${key}`);
    variants.add(`00383${key}`);
  }
  return Array.from(variants).filter(Boolean);
}

function sameTransportPhone(a, b) {
  const ka = normalizeTransportPhoneKey(a);
  const kb = normalizeTransportPhoneKey(b);
  return !!ka && !!kb && ka === kb;
}

function buildTransportPhoneMatchKey(candidate = {}, phoneDigits = '') {
  const phoneKey = normalizeTransportPhoneKey(phoneDigits || candidate?.phone_digits || candidate?.phone || '');
  const codeKey = String(candidate?.tcode || candidate?.client_tcode || candidate?.code || candidate?.id || '').trim().toUpperCase();
  return `transport-phone:${phoneKey}:client:${codeKey || 'na'}`;
}

function normalizeTransportClientCandidate(c = {}) {
  const phoneRaw = String(c?.phone || c?.client_phone || c?.phone_digits || '').trim();
  const phoneDigits = normalizePhoneDigits(c?.phone_digits || phoneRaw || '');
  const tcode = normalizeTcode(c?.tcode || c?.client_tcode || c?.code || c?.code_str || '');
  const kind = String(c?.kind || 'client');
  const source = c?.source || 'transport_clients';
  const isOrderHistory = source === 'transport_orders' || kind === 'order_cache';
  return {
    id: isOrderHistory ? (c?.client_id || c?.row?.client_id || null) : (c?.id || c?.client_id || null),
    kind,
    source,
    tcode,
    name: String(c?.name || c?.client_name || '').trim(),
    phone: phoneRaw,
    phone_digits: phoneDigits,
    address: String(c?.address || c?.client_address || '').trim(),
    gps_lat: c?.gps_lat ?? c?.lat ?? '',
    gps_lng: c?.gps_lng ?? c?.lng ?? '',
    updated_at: c?.updated_at || c?.row?.updated_at || '',
    row: c?.row || null,
  };
}

async function findTransportClientByPhoneOnly(phoneValue, options = {}) {
  const variants = buildTransportPhoneVariants(phoneValue);
  const phoneKey = normalizeTransportPhoneKey(phoneValue);
  if (!isValidTransportPhoneDigits(phoneKey)) return null;

  const timeoutMs = Number(options?.timeoutMs || 5000);
  const signal = options?.signal || null;
  const candidates = [];
  const seen = new Set();
  const pushCandidate = (row = {}) => {
    const c = normalizeTransportClientCandidate(row);
    const cPhoneKey = normalizeTransportPhoneKey(c.phone_digits || c.phone || '');
    if (!cPhoneKey || cPhoneKey !== phoneKey) return;
    const key = String(c.id || c.tcode || `${cPhoneKey}:${c.name}`).trim();
    if (key && seen.has(key)) return;
    if (key) seen.add(key);
    candidates.push(c);
  };

  try {
    let query = supabase
      .from('transport_clients')
      .select('id, tcode, name, phone, phone_digits, address, gps_lat, gps_lng, updated_at')
      .in('phone_digits', variants)
      .order('updated_at', { ascending: false })
      .limit(5);
    if (typeof query?.timeout === 'function') query = query.timeout(timeoutMs, 'TRANSPORT_PHONE_CLIENT_TIMEOUT');
    if (signal && typeof query?.abortSignal === 'function') query = query.abortSignal(signal);
    const { data, error } = await query;
    if (!error) (Array.isArray(data) ? data : []).forEach(pushCandidate);
  } catch {}

  if (!candidates.length) {
    // If transport_clients is missing a row, recover from global transport order history.
    // Candidate acceptance still requires same normalized phone_digits, never name or T-code alone.
    try {
      const orderHits = await searchTransportClientCandidatesByOrders({
        transportId: '',
        query: variants[0] || phoneValue,
        limit: 20,
        signal,
        timeoutMs: Math.max(3500, Math.min(timeoutMs, 7000)),
        timeoutLabel: 'TRANSPORT_PHONE_ORDER_HISTORY_GLOBAL_TIMEOUT',
      }).catch(() => []);
      (Array.isArray(orderHits) ? orderHits : []).forEach(pushCandidate);
    } catch {}
  }

  candidates.sort((a, b) => String(b?.updated_at || b?.row?.updated_at || '').localeCompare(String(a?.updated_at || a?.row?.updated_at || '')));
  return candidates[0] || null;
}

async function searchClientsLive(transportId, q, options = {}) {
  const tid = String(transportId || '').trim();
  const qq = String(q || '').trim();
  if (!qq) return [];

  const signal = options?.signal;
  const timeoutMs = Number(options?.timeoutMs) > 0 ? Number(options.timeoutMs) : TRANSPORT_CLIENT_SEARCH_TIMEOUT_MS;
  const qLower = qq.toLowerCase();
  const qDigits = normalizePhoneDigits(qq);
  const isDigitsOnly = qDigits && qDigits === qq.replace(/\s+/g, '');
  const isTCode = /^t\d+$/i.test(qLower) || (qLower.startsWith('t') && normalizePhoneDigits(qLower.slice(1)).length > 0);
  const tDigits = isTCode ? normalizePhoneDigits(qLower.replace(/^t/i, '')) : '';
  const out = [];
  const seen = new Set();

  const push = (x) => {
    const key = [
      String(x?.id || ''),
      String(x?.tcode || x?.client_tcode || ''),
      normalizePhoneDigits(x?.phone_digits || x?.phone || ''),
      String(x?.name || '').trim().toLowerCase(),
    ].join('|');
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(x);
  };

  const isAbortError = (error) => {
    const code = String(error?.code || '').toUpperCase();
    return error?.name === 'AbortError' || code === 'ABORT_ERR' || code === 'SEARCH_ABORTED' || /abort/i.test(String(error?.message || ''));
  };

  const mapClientRow = (c) => {
    const digits = normalizePhoneDigits(c?.phone_digits || c?.phone || '');
    push({
      id: c?.id,
      kind: String(c?.kind || 'client'),
      source: c?.source || 'transport_clients',
      tcode: String(c?.tcode || ''),
      name: String(c?.name || ''),
      phone: String(c?.phone || ''),
      phone_digits: digits,
      address: c?.address || '',
      gps_lat: c?.gps_lat,
      gps_lng: c?.gps_lng,
      brought_by: String(c?.brought_by || ''),
      pieces: Number(c?.pieces || 0),
    });
  };

  const orderFallbackPromise = searchTransportClientCandidatesByOrders({
    transportId: tid,
    query: qq,
    limit: 20,
    signal,
    timeoutMs: Math.max(5000, Math.min(timeoutMs, 9000)),
    timeoutLabel: 'TRANSPORT_CLIENT_FALLBACK_TIMEOUT',
  }).catch((error) => {
    if (isAbortError(error)) throw error;
    return [];
  });

  const runClientLookup = async (column, value) => {
    let query = supabase
      .from('transport_clients')
      .select('id, tcode, name, phone, phone_digits, address, gps_lat, gps_lng, updated_at')
      .ilike(column, value)
      .order('updated_at', { ascending: false })
      .limit(12);

    if (typeof query?.timeout === 'function') {
      query = query.timeout(timeoutMs, 'SUPABASE_TIMEOUT');
    }
    if (signal && typeof query?.abortSignal === 'function') {
      query = query.abortSignal(signal);
    }

    const { data, error } = await query;
    if (error) throw error;
    (data || []).forEach(mapClientRow);
  };

  const tasks = [];
  if (qDigits.length >= 3) tasks.push(runClientLookup('phone_digits', `%${qDigits}%`));
  if ((isTCode && tDigits) || (isDigitsOnly && qDigits.length >= 1 && qDigits.length <= 6)) {
    tasks.push(runClientLookup('tcode', `T${(tDigits || qDigits)}%`));
  }
  if (qq.length >= 2 && !isDigitsOnly && !isTCode) {
    tasks.push(runClientLookup('name', `%${qq}%`));
  }

  const [orderFallback, results] = await Promise.all([
    orderFallbackPromise,
    Promise.allSettled(tasks),
  ]);
  (orderFallback || []).forEach(mapClientRow);

  const realErrors = results
    .filter((result) => result.status === 'rejected')
    .map((result) => result.reason)
    .filter((error) => !isAbortError(error));

  if (!out.length && realErrors.length) {
    throw realErrors[0];
  }

  return out.slice(0, 20);
}
 
async function uploadPhoto(file, oid, key) {
  if (!file || !oid) return null;
  const ext = file.name.split('.').pop() || 'jpg';
  const path = `photos/${oid}/${key}_${Date.now()}.${ext}`;
  const { data, error } = await storageWithTimeout(supabase.storage.from(BUCKET).upload(path, file, { upsert: true }), 9000, 'TRANSPORT_PRANIMI_PHOTO_UPLOAD_TIMEOUT', { bucket: BUCKET, path });
  if (error) return null;
  const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(data.path);
  return pub?.publicUrl || null;
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
    color: '#fff',
    fontWeight: 900,
  };
}

function getMainOnlyTransportActorScope() {
  if (typeof window === 'undefined') return { role: 'UNKNOWN', pin: '', transport_id: '', name: '' };

  const safeParse = (raw) => {
    try { return raw ? JSON.parse(raw) : null; } catch { return null; }
  };

  try {
    const actor = readBestActor({ allowTransportFallback: false });
    if (actor && (actor.role || actor.pin || actor.id || actor.user_id)) {
      const role = String(actor.role || '').trim().toUpperCase() || 'UNKNOWN';
      const pin = String(actor.pin || actor.transport_pin || '').trim();
      return {
        role,
        pin,
        transport_id: role === 'TRANSPORT'
          ? String(actor.transport_id || actor.id || actor.user_id || pin || '').trim()
          : (pin ? `ADMIN_${pin}` : ''),
        name: String(actor.name || actor.username || actor.full_name || '').trim(),
      };
    }
  } catch {}

  try {
    const rawMain = localStorage.getItem('tepiha_session_v1');
    const m = safeParse(rawMain);
    const u = m?.user || m?.actor || m || null;
    const role = String(u?.role || '').trim().toUpperCase();
    const pin = String(u?.pin || '').trim();
    if (role || pin) {
      return {
        role: role || 'UNKNOWN',
        pin,
        transport_id: role === 'TRANSPORT' ? String(u?.transport_id || pin || '').trim() : (pin ? `ADMIN_${pin}` : ''),
        name: String(u?.name || u?.username || u?.full_name || '').trim(),
      };
    }
  } catch {}

  try {
    const rawCurrent = localStorage.getItem('CURRENT_USER_DATA');
    const u = safeParse(rawCurrent);
    const role = String(u?.role || '').trim().toUpperCase();
    const pin = String(u?.pin || '').trim();
    if (role || pin) {
      return {
        role: role || 'UNKNOWN',
        pin,
        transport_id: role === 'TRANSPORT' ? String(u?.transport_id || pin || '').trim() : (pin ? `ADMIN_${pin}` : ''),
        name: String(u?.name || u?.username || u?.full_name || '').trim(),
      };
    }
  } catch {}

  return { role: 'UNKNOWN', pin: '', transport_id: '', name: '' };
}

function getSafeTransportActorScope({ allowTransportFallback = true } = {}) {
  if (typeof window === 'undefined') return { role: 'UNKNOWN', pin: '', transport_id: '', name: '' };

  // Base bridge edit must never trust transport context/session. A stale
  // transport session can remain on iOS/Safari after user switch, so the
  // main/base session is the only source of truth for bridge mode.
  if (!allowTransportFallback) {
    return getMainOnlyTransportActorScope();
  }

  const safeParse = (raw) => {
    try { return raw ? JSON.parse(raw) : null; } catch { return null; }
  };

  try {
    if (typeof getTransportContext === 'function') {
      const ctx = getTransportContext();
      if (ctx && (ctx.role || ctx.transport_id || ctx.transport_pin || ctx.pin)) {
        return {
          role: String(ctx.role || '').toUpperCase() || 'UNKNOWN',
          pin: String(ctx.pin || ctx.transport_pin || '').trim(),
          transport_id: String(ctx.transport_id || ctx.pin || ctx.transport_pin || '').trim(),
          name: String(ctx.name || ctx.transport_name || '').trim(),
        };
      }
    }
  } catch {}

  try {
    if (typeof getTransportSession === 'function') {
      const ts = getTransportSession();
      if (ts?.transport_id) {
        return {
          role: 'TRANSPORT',
          pin: String(ts.pin || ts.transport_pin || ts.transport_id || '').trim(),
          transport_id: String(ts.transport_id || '').trim(),
          name: String(ts.name || ts.transport_name || '').trim(),
        };
      }
    }
  } catch {}

  try {
    const rawTransport = localStorage.getItem('tepiha_transport_session_v1');
    const t = safeParse(rawTransport);
    if (t?.transport_id) {
      return {
        role: 'TRANSPORT',
        pin: String(t.pin || t.transport_pin || t.transport_id || '').trim(),
        transport_id: String(t.transport_id || '').trim(),
        name: String(t.name || t.transport_name || '').trim(),
      };
    }
  } catch {}

  return getMainOnlyTransportActorScope();
}

// Local Drafts Helpers
function safeJsonParse(s, f) { try { return JSON.parse(s); } catch { return f; } }
function loadDraftIds() { const raw = localStorage.getItem(DRAFT_LIST_KEY); return safeJsonParse(raw || '[]', []); }
function saveDraftIds(ids) { localStorage.setItem(DRAFT_LIST_KEY, JSON.stringify(ids)); }
function upsertDraftLocal(d) {
  if (!d?.id) return;
  const next = { ...d, transport_id: String(d?.transport_id || '').trim() || null };
  localStorage.setItem(`${DRAFT_ITEM_PREFIX}${d.id}`, JSON.stringify(next));
  const ids = loadDraftIds();
  if (!ids.includes(d.id)) { ids.unshift(d.id); saveDraftIds(ids); } 
}
function removeDraftLocal(id) {
  if (!id) return;
  localStorage.removeItem(`${DRAFT_ITEM_PREFIX}${id}`);
  saveDraftIds(loadDraftIds().filter((x) => x !== id));
}
function readAllDraftsLocal(scopeTid = '') {
  const wantedTid = String(scopeTid || '').trim();
  return loadDraftIds()
    .map(id => safeJsonParse(localStorage.getItem(`${DRAFT_ITEM_PREFIX}${id}`), null))
    .filter(Boolean)
    .filter((d) => !wantedTid || String(d?.transport_id || '').trim() === wantedTid)
    .sort((a, b) => (b.ts || 0) - (a.ts || 0));
}
function buildDraftPayload(d = {}, scopeTid = '') {
  return {
    ...d,
    id: d.id,
    ts: Date.now(),
    transport_id: String(scopeTid || d?.transport_id || '').trim() || null,
    addressDesc: d?.addressDesc ?? '',
    gpsLat: d?.gpsLat ?? '',
    gpsLng: d?.gpsLng ?? '',
    clientPhotoUrl: d?.clientPhotoUrl ?? '',
  };
}

function getAdvancedTransportStatus(currentStatus = '', fallbackStatus = 'loaded') {
  const current = String(currentStatus || '').trim().toLowerCase();
  const fallback = String(fallbackStatus || 'loaded').trim().toLowerCase() || 'loaded';
  if (!current) return fallback;
  if (current === 'dispatched' || current === 'assigned' || current === 'new' || current === 'inbox' || current === 'pranim') return 'pickup';
  if (current === 'pickup') return 'loaded';
  if (current === 'loaded' || current === 'ngarkim' || current === 'ngarkuar') return 'pastrim';
  return current;
}

function isBaseWorkerRoleForTransportBridge(role) {
  return ['PUNTOR', 'PUNETOR', 'WORKER'].includes(String(role || '').trim().toUpperCase());
}

function readExistingTransportAssignment(row, data = {}) {
  const d = (data && typeof data === 'object' && !Array.isArray(data)) ? data : {};
  return String(
    d.transport_id ||
    d.transport_user_id ||
    d.assigned_driver_id ||
    d.driver_id ||
    row?.transport_id ||
    row?.transport_user_id ||
    row?.assigned_driver_id ||
    ''
  ).trim();
}

function asPlainTransportObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function firstTransportValue(...values) {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    const text = String(value).trim();
    if (text) return value;
  }
  return '';
}

function splitTransportPhoneForForm(value, fallbackPrefix = '+383') {
  const raw = String(value || '').trim();
  if (!raw) return { prefix: fallbackPrefix, local: '' };
  const compact = raw.replace(/[^\d+]/g, '');
  const digits = normalizePhoneDigits(compact || raw);

  if (compact.startsWith('+')) {
    const pref = PREFIX_OPTIONS.find((opt) => compact.startsWith(opt.code));
    if (pref) return { prefix: pref.code, local: compact.slice(pref.code.length).replace(/\D+/g, '') };
  }

  for (const opt of PREFIX_OPTIONS) {
    const codeDigits = normalizePhoneDigits(opt.code);
    if (digits.startsWith(`00${codeDigits}`) && digits.length > codeDigits.length + 2) {
      return { prefix: opt.code, local: digits.slice(codeDigits.length + 2).replace(/^0+/, '') };
    }
    if (digits.startsWith(codeDigits) && digits.length > codeDigits.length) {
      return { prefix: opt.code, local: digits.slice(codeDigits.length).replace(/^0+/, '') };
    }
  }

  if (digits.startsWith('0') && digits.length >= 8) {
    return { prefix: fallbackPrefix, local: digits.replace(/^0+/, '') };
  }

  return { prefix: fallbackPrefix, local: normalizeTransportPhoneKey(digits) || digits };
}

function readTransportOrderClientForEdit(row = {}) {
  const d = asPlainTransportObject(row?.data);
  const nestedOrder = asPlainTransportObject(d?.order);
  const c = asPlainTransportObject(d?.client || nestedOrder?.client);
  const gps = asPlainTransportObject(c?.gps || d?.gps || nestedOrder?.gps);
  const tcode = normalizeTcode(firstTransportValue(
    c?.tcode,
    c?.code,
    d?.client_tcode,
    nestedOrder?.client_tcode,
    row?.client_tcode,
    row?.code_str,
    d?.code_str,
    d?.code
  ));

  return {
    id: firstTransportValue(row?.client_id, c?.id, d?.client_id, nestedOrder?.client_id) || null,
    tcode: tcode && tcode !== 'T0' ? tcode : '',
    name: String(firstTransportValue(c?.name, c?.client_name, d?.client_name, nestedOrder?.client_name, row?.client_name, row?.name) || '').trim(),
    phone: String(firstTransportValue(c?.phone, c?.client_phone, d?.client_phone, nestedOrder?.client_phone, row?.client_phone, row?.phone) || '').trim(),
    photoUrl: String(firstTransportValue(c?.photoUrl, c?.photo_url, d?.clientPhotoUrl, d?.client_photo_url, nestedOrder?.clientPhotoUrl) || '').trim(),
    address: String(firstTransportValue(c?.address, c?.addressDesc, d?.addressDesc, d?.address, nestedOrder?.addressDesc, nestedOrder?.address, row?.address, row?.client_address) || '').trim(),
    gpsLat: firstTransportValue(gps?.lat, c?.gps_lat, d?.gps_lat, nestedOrder?.gps_lat, row?.gps_lat),
    gpsLng: firstTransportValue(gps?.lng, c?.gps_lng, d?.gps_lng, nestedOrder?.gps_lng, row?.gps_lng),
  };
}

// ---------------- COMPONENT ----------------
function PranimiPageInner() {
  useRouteAlive('transport_pranimi_page');
  const router = useRouter();
  const searchParams = useSearchParams();
  const editId = String(searchParams?.get('edit') || searchParams?.get('id') || '').trim();
  const isEdit = Boolean(editId);
  const bridgeFrom = String(searchParams?.get('from') || '').trim();
  const isBaseBridgeEdit = Boolean(isEdit && bridgeFrom === 'pastrimi-edit' && searchParams?.get('baseBridge') === '1');
  const newStatusRaw = String(searchParams?.get('new_status') || '').trim().toLowerCase();
  
  // Flow: në create respektojmë query statusin; default i sigurt = 'pickup'.
  const createStatus = (newStatusRaw === 'pickup' || newStatusRaw === 'loaded') ? newStatusRaw : 'pickup';
  const [editRowStatus, setEditRowStatus] = useState('loaded');
  const [phonePrefix, setPhonePrefix] = useState('+383');
  const [showPrefixSheet, setShowPrefixSheet] = useState(false);
  const [showAddClient, setShowAddClient] = useState(false);
  const [gpsLoading, setGpsLoading] = useState(false);
  const [gpsSaved, setGpsSaved] = useState(false);
  const [me, setMe] = useState(null);
  const [creating, setCreating] = useState(true);
  const [photoUploading, setPhotoUploading] = useState(false);
  const [savingContinue, setSavingContinue] = useState(false);
  const [oid, setOid] = useState('');
  const [codeRaw, setCodeRaw] = useState('');
  const [drafts, setDrafts] = useState([]);
  const [showDraftsSheet, setShowDraftsSheet] = useState(false);
  // Client Data
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [clientPhotoUrl, setClientPhotoUrl] = useState('');
  const [addressDesc, setAddressDesc] = useState('');
  const [gpsLat, setGpsLat] = useState('');
  const [gpsLng, setGpsLng] = useState('');
  const [clientQuery, setClientQuery] = useState('');
  const [clientHits, setClientHits] = useState([]);
  const [clientsLoading, setClientsLoading] = useState(false);
  const [clientSearchNotice, setClientSearchNotice] = useState('');
  const [oldClientDebt, setOldClientDebt] = useState(0);
  const [clientId, setClientId] = useState(null);
  const [clientTcode, setClientTcode] = useState('');
  const [transportClientMatchPrompt, setTransportClientMatchPrompt] = useState({ open: false, matchKey: '', candidate: null, phoneDigits: '' });
  const [transportClientMatchDecision, setTransportClientMatchDecision] = useState({ matchKey: '', mode: '' });
  const [activeChipKey, setActiveChipKey] = useState('');
  // Rows
  const [tepihaRows, setTepihaRows] = useState([]);
  const [stazaRows, setStazaRows] = useState([]);
  const [stairsQty, setStairsQty] = useState(0);
  const [stairsPer, setStairsPer] = useState(SHKALLORE_M2_PER_STEP_DEFAULT);
  const [stairsPhotoUrl, setStairsPhotoUrl] = useState('');
  // Pay
  const [pricePerM2, setPricePerM2] = useState(PRICE_DEFAULT);
  const [clientPaid, setClientPaid] = useState(0);
  const [arkaRecordedPaid, setArkaRecordedPaid] = useState(0);
  const [payMethod, setPayMethod] = useState('CASH');
  const [notes, setNotes] = useState('');
  // Sheets
  const [showPaySheet, setShowPaySheet] = useState(false);
  const [showStairsSheet, setShowStairsSheet] = useState(false);
  const [showMsgSheet, setShowMsgSheet] = useState(false);
  const [showReceiptSheet, setShowReceiptSheet] = useState(false);
  const [receiptText, setReceiptText] = useState('');
  const [msgKind, setMsgKind] = useState('start'); // 'start' | 'receipt'
  const [autoMsgAfterSave, setAutoMsgAfterSave] = useState(true);
  const [showPriceSheet, setShowPriceSheet] = useState(false);
  const [priceTmp, setPriceTmp] = useState(PRICE_DEFAULT);
  const [payAdd, setPayAdd] = useState(0);
  const [offlineMode, setOfflineMode] = useState(false);
  const [netState, setNetState] = useState({ ok: true, reason: '' });
  // ADMIN/DISPATCH can create transport orders without being a transport actor.
  // Prevent leaking orders to a driver just because a stale transport session exists.
  const [actor, setActor] = useState(null); // { role, pin }
  const [lockedBridgeTransportId, setLockedBridgeTransportId] = useState('');
  const [editOriginalData, setEditOriginalData] = useState(null);
  const [assignTid, setAssignTid] = useState(''); // transport_id to write into order.data.transport_id
  const [transportUsers, setTransportUsers] = useState([]); // [{pin,name}]
  const transportUserNameMap = useMemo(() => new Map((Array.isArray(transportUsers) ? transportUsers : []).map((u) => [String(u?.pin || u?.transport_id || '').trim(), String(u?.name || '').trim()]).filter((entry) => entry[0] && entry[1])), [transportUsers]);
  // Detect actor/session changes (logout/login) without full page reload.
  // Safari/PWA can keep this page alive; without this, a new PIN can inherit the previous actor's code/oid.
  const actorSigRef = useRef('');
  const draftTimer = useRef(null);
  const secretTapRef = useRef(0);
  const draftSnapshotRef = useRef('');
  const liveSearchSeqRef = useRef(0);
  const liveSearchAbortRef = useRef(null);
  const secretTapTimerRef = useRef(null);
  const priceSourceRef = useRef('new');
  const codeWarmupTimerRef = useRef(null);
  const debtLookupTimerRef = useRef(null);
  const actorRole = String(actor?.role || '').trim().toUpperCase();
  const isBaseWorkerBridgeEdit = Boolean(isBaseBridgeEdit && isBaseWorkerRoleForTransportBridge(actorRole));

  function getCurrentDraftTransportId() {
    return String((actor?.role === 'TRANSPORT' ? me?.transport_id : assignTid) || '').trim();
  }

  // Base worker bridge is allowed only to edit an existing transport order from PASTRIMI.
  // After save/message close, never send that user to Transport Board/Menu because the route guard
  // correctly blocks full transport access and would redirect them to Login.
  function closeAfterTransportPranimiSave() {
    if (isBaseWorkerBridgeEdit) {
      router.push('/pastrimi');
      return;
    }
    const returnTab = String(searchParams?.get('return_tab') || '').toLowerCase();
    const returnMode = String(searchParams?.get('return_mode') || '').toLowerCase();
    if (returnTab === 'loaded') {
      router.push(`/transport/board?tab=loaded&mode=${returnMode === 'out' ? 'out' : 'in'}`);
    } else if (returnTab === 'ready') {
      router.push('/transport/board?tab=ready');
    } else if (returnTab === 'depo') {
      router.push('/transport/board?tab=depo');
    } else {
      router.push('/transport/board');
    }
  }

  useEffect(() => {
    trackRender('TransportPranimiPage');
  }, []);
  // --- INIT ---
  useEffect(() => {
    (async () => {
        const scope = getSafeTransportActorScope({ allowTransportFallback: !isBaseBridgeEdit });
        const role = String(scope?.role || 'UNKNOWN').toUpperCase();
        const pin = String(scope?.pin || '').trim();
        const actorObj = { role, pin };
        setActor(actorObj);
        if (isBaseBridgeEdit && !isBaseWorkerRoleForTransportBridge(role) && !['DISPATCH', 'ADMIN', 'ADMIN_MASTER', 'OWNER', 'PRONAR', 'SUPERADMIN'].includes(role)) {
          router.push('/login');
          return;
        }
        let transportScope = null;
        let adminTidLocal = null;
        if (role === 'TRANSPORT') {
          transportScope = scope?.transport_id ? scope : (getTransportSession() || null);
          if (!transportScope?.transport_id) { router.push('/transport/menu'); return; }
          setMe({ ...transportScope, role: 'TRANSPORT', pin });
          setAssignTid(String(transportScope.transport_id));
        } else {
          const adminTid = String(scope?.transport_id || (pin ? `ADMIN_${pin}` : 'ADMIN'));
          adminTidLocal = adminTid;
          setMe({ transport_id: null, role, pin });
          setAssignTid(adminTid);
          try {
            const { data } = await supabase
              .from('users')
              .select('name,pin,role')
              .eq('role', 'TRANSPORT')
              .order('name', { ascending: true })
              .limit(200);
            const rows = Array.isArray(data) ? data : [];
            setTransportUsers(
              rows
                .filter((r) => r?.pin)
                .map((r) => ({ pin: String(r.pin), name: String(r.name || r.pin) }))
            );
          } catch {}
        }
        
        const initDraftScopeTid = String((role === 'TRANSPORT' ? transportScope?.transport_id : adminTidLocal) || '').trim();
        try { setDrafts(readAllDraftsLocal(initDraftScopeTid)); } catch {}
        if (isEdit) {
            const row = await fetchTransportOrderById(editId).catch(() => null);
            if (row) {
                const d = asPlainTransportObject(row.data);
                const editClient = readTransportOrderClientForEdit(row);
                const existingTid = readExistingTransportAssignment(row, d);
                setOid(row.id);
                setCodeRaw(editClient.tcode || normalizeTcode(row.code_str || row.client_tcode || ''));
                setEditRowStatus(row.status);
                setEditOriginalData(d && typeof d === 'object' && !Array.isArray(d) ? d : {});
                if (existingTid) setAssignTid(existingTid);
                if (isBaseBridgeEdit) setLockedBridgeTransportId(existingTid);
                setName(editClient.name || '');
                try {
                  const phoneParts = splitTransportPhoneForForm(editClient.phone, phonePrefix);
                  setPhonePrefix(phoneParts.prefix || '+383');
                  setPhone(phoneParts.local || '');
                } catch {}
                setClientPhotoUrl(editClient.photoUrl || '');
                setClientId(editClient.id || null);
                setClientTcode(editClient.tcode || normalizeTcode(row.code_str || row.client_tcode || ''));
                setAddressDesc(editClient.address || '');
                const lat = editClient.gpsLat;
                const lng = editClient.gpsLng;
                if (lat !== '' && lat != null) setGpsLat(lat);
                if (lng !== '' && lng != null) setGpsLng(lng);
                
                try { setTepihaRows((d.tepiha||[]).map((r,i)=>({...r, id:`t${i}`}))); } catch{}
                try { setStazaRows((d.staza||[]).map((r,i)=>({...r, id:`s${i}`}))); } catch{}
                
                setStairsQty(d.shkallore?.qty||0); 
                setStairsPer(d.shkallore?.per||SHKALLORE_M2_PER_STEP_DEFAULT); 
                setStairsPhotoUrl(d.shkallore?.photoUrl||'');
                
                priceSourceRef.current = 'existing';
                setClientPaid(d.pay?.paid||0); 
                setPricePerM2(d.pay?.rate||PRICE_DEFAULT); 
                setPriceTmp(d.pay?.rate||PRICE_DEFAULT);
                setArkaRecordedPaid(d.pay?.arkaRecordedPaid||0);
                setNotes(d.notes||'');
                if (!isBaseBridgeEdit && searchParams?.get('focus') === 'pay') { setTimeout(() => setShowPaySheet(true), 200); }
            }
        } else {
            const id = (typeof crypto !== 'undefined' && crypto.randomUUID)
              ? crypto.randomUUID()
              : `ord_${Date.now()}`;
            setOid(id);
            // Start empty, then warm a visible T-code shortly after open.
            // If a typed phone belongs to an existing client, the existing permanent T-code replaces it.
            setCodeRaw('');
            setClientTcode('');
            priceSourceRef.current = 'new';
            setPricePerM2(PRICE_DEFAULT);
            setPriceTmp(PRICE_DEFAULT);
            clearTimeout(codeWarmupTimerRef.current);
        }
        setCreating(false);
    })();
  }, []);

  useEffect(() => {
    return () => {
      try { clearTimeout(codeWarmupTimerRef.current); } catch {}
      try { clearTimeout(debtLookupTimerRef.current); } catch {}
      try { clearTimeout(draftTimer.current); } catch {}
      try { liveSearchAbortRef.current?.abort?.(); } catch {}
      try { secretTapTimerRef.current && clearTimeout(secretTapTimerRef.current); } catch {}
    };
  }, []);


  useEffect(() => {
    if (creating || isEdit || !oid) return;
    if ((clientTcode && normalizeTcode(clientTcode) !== 'T0') || (codeRaw && normalizeTcode(codeRaw) !== 'T0')) return;

    const tid = getCurrentDraftTransportId();
    if (!tid) return;

    // Keep the old worker-friendly behavior: show a T-code on the screen shortly after opening.
    // Existing-client protection still wins later: if the typed phone belongs to an existing
    // client, this warmed code is put back into the local mirror and the client's permanent
    // T-code replaces it.
    try { clearTimeout(codeWarmupTimerRef.current); } catch {}
    let alive = true;
    codeWarmupTimerRef.current = setTimeout(() => {
      void (async () => {
        const fresh = await getOrReserveTransportCode(tid, { oid }).catch(() => '');
        if (!alive || !fresh) return;
        setCodeRaw(normalizeTcode(fresh));
      })();
    }, 650);

    return () => {
      alive = false;
      try { clearTimeout(codeWarmupTimerRef.current); } catch {}
    };
  }, [creating, isEdit, oid, actor?.role, me?.transport_id, assignTid, codeRaw, clientTcode]);

  useEffect(() => {
    try {
      const offlineFlag = localStorage.getItem(OFFLINE_MODE_KEY) === '1';
      setOfflineMode(Boolean(offlineFlag || (typeof navigator !== 'undefined' && navigator.onLine === false)));
      setNetState({
        ok: !(offlineFlag || (typeof navigator !== 'undefined' && navigator.onLine === false)),
        reason: offlineFlag ? 'OFFLINE_FLAG' : ((typeof navigator !== 'undefined' && navigator.onLine === false) ? 'OFFLINE' : ''),
      });
    } catch {}
    const onOnline = () => {
      setOfflineMode(false);
      setNetState({ ok: true, reason: '' });
      try { localStorage.removeItem(OFFLINE_MODE_KEY); } catch {}
    };
    const onOffline = () => {
      setOfflineMode(true);
      setNetState({ ok: false, reason: 'OFFLINE' });
      try { localStorage.setItem(OFFLINE_MODE_KEY, '1'); } catch {}
    };
    if (typeof window !== 'undefined') {
      window.addEventListener('online', onOnline);
      window.addEventListener('offline', onOffline);
    }
    return () => {
      if (typeof window !== 'undefined') {
        window.removeEventListener('online', onOnline);
        window.removeEventListener('offline', onOffline);
      }
    };
  }, []);

  useEffect(() => {
    if (isEdit || priceSourceRef.current !== 'new') return;
    try {
      const raw = localStorage.getItem(PRICE_KEY);
      const saved = Number(raw || '');
      const nextPrice = normalizeNewTransportPricePerM2(Number.isFinite(saved) && saved > 0 ? saved : PRICE_DEFAULT);
      setPricePerM2(nextPrice);
      setPriceTmp(nextPrice);
      try { localStorage.setItem(PRICE_KEY, String(nextPrice)); } catch {}
    } catch {}
  }, [isEdit]);
  // --- SESSION WATCH (PIN SWITCH) ---
  useEffect(() => {
    // Polling is the most reliable option because localStorage changes in the same tab
    // do not fire the 'storage' event.
    let alive = true;
    const resetFor = async (role, pin, transport_id) => {
      // Reset all form state so the new actor never inherits the previous actor's order.
      setClientQuery('');
      setClientHits([]);
      setName('');
      setPhone('');
      setClientPhotoUrl('');
      setAddressDesc('');
      setGpsLat(null);
      setGpsLng(null);
      setTepihaRows([]);
      setStazaRows([]);
      setStairsQty(0);
      setStairsPer(SHKALLORE_M2_PER_STEP_DEFAULT);
      setStairsPhotoUrl('');
      setNotes('');
      setClientPaid(0);
      setPayAdd(0);
      setArkaRecordedPaid(0);
      setShowPaySheet(false);
      setShowDraftsSheet(false);
      const id = (typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID()
        : `ord_${Date.now()}`;
      setOid(id);
      // New actor scope starts clean; warm-up will show a fresh T-code after the scope is ready.
      setCodeRaw('');
      setClientId(null);
      setClientTcode('');
      setTransportClientMatchPrompt({ open: false, matchKey: '', candidate: null, phoneDigits: '' });
      setTransportClientMatchDecision({ matchKey: '', mode: '' });
    };
    const tick = async () => {
      if (!alive) return;
      const scope = getSafeTransportActorScope({ allowTransportFallback: !isBaseBridgeEdit });
      const role = String(scope?.role || 'UNKNOWN').toUpperCase();
      const pin = String(scope?.pin || '').trim();
      const tid = String(scope?.transport_id || (pin ? `ADMIN_${pin}` : 'ADMIN')).trim();
      if (isBaseBridgeEdit && !isBaseWorkerRoleForTransportBridge(role) && !['DISPATCH', 'ADMIN', 'ADMIN_MASTER', 'OWNER', 'PRONAR', 'SUPERADMIN'].includes(role)) {
        router.push('/login');
        return;
      }
      const sig = `${role}|${pin}|${tid}`;
      if (!actorSigRef.current) {
        actorSigRef.current = sig;
        return;
      }
      if (sig !== actorSigRef.current) {
        actorSigRef.current = sig;
        // Update actor scope + reset order session.
        setActor({ role: role || 'UNKNOWN', pin });
        if (role === 'TRANSPORT') {
          if (!scope?.transport_id) { router.push('/transport/menu'); return; }
          setMe({ ...scope, role: 'TRANSPORT', pin });
          setAssignTid(String(scope.transport_id));
          await resetFor(role, pin, String(scope.transport_id));
        } else {
          setMe({ transport_id: null, role, pin });
          setAssignTid(tid);
          await resetFor(role, pin, tid);
        }
      }
    };
    const t = setInterval(() => { tick(); }, 15000);
    return () => { alive = false; clearInterval(t); };
  }, [router, isBaseBridgeEdit]);
  // Search Live (TEL / KOD / T-CODE / EMËR)
  useEffect(() => {
      const q = String(clientQuery || '').trim();
      const digits = normalizePhoneDigits(q);
      const isT = /^t\d+$/i.test(q) || (q.toLowerCase().startsWith('t') && normalizePhoneDigits(q.slice(1)).length > 0);
      const should = (digits.length >= 1) || isT || (q.length >= 2);
      try { liveSearchAbortRef.current?.abort?.(); } catch {}
      liveSearchAbortRef.current = null;
      if (!should) {
        setClientHits([]);
        setClientSearchNotice('');
        setClientsLoading(false);
        return;
      }
      const tid = (actor?.role === 'TRANSPORT') ? me?.transport_id : assignTid;
      const seq = ++liveSearchSeqRef.current;
      setClientsLoading(true);
      setClientSearchNotice('');
      const timer = setTimeout(() => {
        const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
        liveSearchAbortRef.current = controller;
        searchClientsLive(tid, q, {
          signal: controller?.signal,
          timeoutMs: TRANSPORT_CLIENT_SEARCH_TIMEOUT_MS,
        })
          .then((r) => {
            if (liveSearchSeqRef.current !== seq) return;
            setClientHits(Array.isArray(r) ? r : []);
            setClientSearchNotice('');
          })
          .catch((error) => {
            if (liveSearchSeqRef.current !== seq) return;
            const code = String(error?.code || '').toUpperCase();
            const isAbort = error?.name === 'AbortError' || code === 'ABORT_ERR' || code === 'SEARCH_ABORTED' || /abort/i.test(String(error?.message || ''));
            if (isAbort) return;
            setClientHits((prev) => (Array.isArray(prev) ? prev : []));
            setClientSearchNotice('Lidhja me serverin është e dobët. Po shfaqen rezultatet që kemi në cache.');
          })
          .finally(() => {
            if (liveSearchSeqRef.current !== seq) return;
            if (liveSearchAbortRef.current === controller) liveSearchAbortRef.current = null;
            setClientsLoading(false);
          });
      }, 400);
      return () => {
        clearTimeout(timer);
        try {
          if (liveSearchAbortRef.current) {
            liveSearchAbortRef.current.abort();
            liveSearchAbortRef.current = null;
          }
        } catch {}
      };
  }, [clientQuery, me?.transport_id, assignTid, actor?.role]);
  // Autosave Draft
  useEffect(() => {
      if(creating || !oid) return;
      clearTimeout(draftTimer.current);
      const draftPayload = buildDraftPayload({
        id: oid,
        codeRaw,
        name,
        phone,
        tepihaRows,
        stazaRows,
        stairsQty,
        stairsPer,
        addressDesc,
        gpsLat,
        gpsLng,
        clientPhotoUrl,
        notes,
        clientPaid,
        pricePerM2
      }, getCurrentDraftTransportId());
      const nextSnapshot = JSON.stringify(draftPayload || {});
      draftTimer.current = setTimeout(() => {
          if(!(name || phone)) return;
          if (draftSnapshotRef.current === nextSnapshot) return;
          upsertDraftLocal(draftPayload);
          draftSnapshotRef.current = nextSnapshot;
      }, 800);
      return () => clearTimeout(draftTimer.current);
  }, [creating, oid, codeRaw, name, phone, tepihaRows, stazaRows, stairsQty, stairsPer, addressDesc, gpsLat, gpsLng, clientPhotoUrl, notes, clientPaid, pricePerM2, actor?.role, me?.transport_id, assignTid]);
  const totalM2 = useMemo(() => {
    const tepihaM2 = (Array.isArray(tepihaRows) ? tepihaRows : []).reduce(
      (sum, row) => sum + (Number(row?.m2) || 0) * (Number(row?.qty) || 0),
      0
    );
    const stazaM2 = (Array.isArray(stazaRows) ? stazaRows : []).reduce(
      (sum, row) => sum + (Number(row?.m2) || 0) * (Number(row?.qty) || 0),
      0
    );
    const shkalloreM2 = (Number(stairsQty) || 0) * (Number(stairsPer) || 0);
    return Number((tepihaM2 + stazaM2 + shkalloreM2).toFixed(2));
  }, [tepihaRows, stazaRows, stairsQty, stairsPer]);
  const copeCount = useMemo(() => {
    const t = (Array.isArray(tepihaRows) ? tepihaRows : []).reduce((s, r) => s + (Number(r?.qty) || 0), 0);
    const st = (Array.isArray(stazaRows) ? stazaRows : []).reduce((s, r) => s + (Number(r?.qty) || 0), 0);
    return t + st + (Number(stairsQty) || 0);
  }, [tepihaRows, stazaRows, stairsQty]);
  const totalEuro = useMemo(() => Number((totalM2 * (Number(pricePerM2) || 0)).toFixed(2)), [totalM2, pricePerM2]);
  const diff = useMemo(() => Number((totalEuro - Number(clientPaid || 0)).toFixed(2)), [totalEuro, clientPaid]);
  const currentDebt = diff > 0 ? diff : 0;
  const currentChange = diff < 0 ? Math.abs(diff) : 0;
  const remainingDue = Math.max(0, Number((totalEuro - Number(clientPaid || 0)).toFixed(2)));

  useEffect(() => {
    let alive = true;
    const phoneFull = sanitizePhone(phonePrefix + (phone || ''));
    try { clearTimeout(debtLookupTimerRef.current); } catch {}
    if (!phoneFull || phoneFull.length < 6) { setOldClientDebt(0); return () => { alive = false; }; }
    debtLookupTimerRef.current = setTimeout(async () => {
      try {
        const res = await getClientBalanceByPhone(phoneFull);
        if (!alive) return;
        setOldClientDebt(Number(res?.debt_eur || 0) || 0);
      } catch {
        if (alive) setOldClientDebt(0);
      }
    }, 500);
    return () => {
      alive = false;
      try { clearTimeout(debtLookupTimerRef.current); } catch {}
    };
  }, [phonePrefix, phone]);

  useEffect(() => {
      if(!showPaySheet) return;
      if(Number(payAdd || 0) > 0) return;
      setPayAdd(remainingDue);
  }, [showPaySheet, remainingDue, payAdd]);
  function addRow(kind) {
      const setter = kind === 'tepiha' ? setTepihaRows : setStazaRows;
      const p = kind === 'tepiha' ? 't' : 's';
      setter(prev => [...prev, { id: `${p}${Date.now()}`, m2: '', qty: '0', photoUrl: '' }]);
  }
  function removeRow(kind) {
      const setter = kind === 'tepiha' ? setTepihaRows : setStazaRows;
      setter(prev => prev.slice(0, -1));
  }
  function handleRowChange(kind, id, f, v) {
      const setter = kind === 'tepiha' ? setTepihaRows : setStazaRows;
      setter(prev => prev.map(r => r.id === id ? { ...r, [f]: v } : r));
  }
  
  async function handleRowPhotoChange(kind, id, file) {
      if(!file || !oid) return;
      setPhotoUploading(true);
      const url = await uploadPhoto(file, oid, `${kind}_${id}`);
      if(url) handleRowChange(kind, id, 'photoUrl', url);
      setPhotoUploading(false);
  }
  async function handleStairsPhotoChange(file) {
      if(!file || !oid) return;
      setPhotoUploading(true);
      const url = await uploadPhoto(file, oid, 'shkallore');
      if(url) setStairsPhotoUrl(url);
      setPhotoUploading(false);
  }
  function applyChip(kind, val) {
      const rows = kind === 'tepiha' ? tepihaRows : stazaRows;
      const setter = kind === 'tepiha' ? setTepihaRows : setStazaRows;
      const p = kind === 'tepiha' ? 't' : 's';
      if(!rows.length) setter([{ id: `${p}1`, m2: String(val), qty: '1', photoUrl: '' }]);
      else {
          const empty = rows.findIndex(r => !r.m2);
          if(empty !== -1) { const n=[...rows]; n[empty].m2=String(val); n[empty].qty=(n[empty].qty!=='0'?n[empty].qty:'1'); setter(n); }
          else setter([...rows, { id: `${p}${Date.now()}`, m2: String(val), qty: '1', photoUrl: '' }]);
      }
  }
  async function handleGetGPS() {
      try {
        if (typeof navigator === 'undefined' || !navigator.geolocation) {
          alert('GPS nuk mbështetet në këtë pajisje.');
          return;
        }
        setGpsLoading(true);
        setGpsSaved(false);
        navigator.geolocation.getCurrentPosition(
          (p) => {
            setGpsLat(p.coords.latitude);
            setGpsLng(p.coords.longitude);
            setGpsLoading(false);
            setGpsSaved(true);
          },
          () => {
            setGpsLoading(false);
            setGpsSaved(false);
            alert('Nuk u mor lokacioni. Lejo GPS dhe provo prap.');
          },
          { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
        );
      } catch {
        setGpsLoading(false);
        setGpsSaved(false);
      }
  }
  function applyExistingTransportClientCandidate(candidate = {}, { accepted = false } = {}) {
      const c = normalizeTransportClientCandidate(candidate || {});
      const tc = normalizeTcode(c.tcode || '');
      const matchKey = buildTransportPhoneMatchKey(c, c.phone_digits || c.phone);
      if (c.name) setName(c.name);
      const fullPhone = String(c.phone || '').trim();
      const pref = PREFIX_OPTIONS.find((opt) => fullPhone.startsWith(opt.code));
      if (pref) {
        setPhonePrefix(pref.code);
        setPhone(fullPhone.slice(pref.code.length).replace(/\D+/g, ''));
      } else {
        const localDigits = normalizeTransportPhoneKey(c.phone_digits || fullPhone);
        if (localDigits) setPhone(localDigits);
      }
      setClientId(c.id || null);
      if (tc && tc !== 'T0') {
        try { clearTimeout(codeWarmupTimerRef.current); } catch {}
        const warmedCode = normalizeTcode(codeRaw || '');
        if (!isEdit && warmedCode && warmedCode !== 'T0' && warmedCode !== tc) {
          releaseUnusedWarmTransportCode(getCurrentDraftTransportId(), warmedCode, oid);
        }
        setClientTcode(tc);
        setCodeRaw(tc);
      }
      if (c.address) setAddressDesc(c.address);
      if (c.gps_lat !== '' && c.gps_lat != null) setGpsLat(c.gps_lat);
      if (c.gps_lng !== '' && c.gps_lng != null) setGpsLng(c.gps_lng);
      if (accepted) setTransportClientMatchDecision({ matchKey, mode: 'use_existing' });
      setTransportClientMatchPrompt({ open: false, matchKey: '', candidate: null, phoneDigits: '' });
  }

  function isSelectedTransportPhoneClient(candidate = {}) {
      const c = normalizeTransportClientCandidate(candidate || {});
      const cId = String(c.id || '').trim();
      const cCode = normalizeTcode(c.tcode || '');
      if (cId && String(clientId || '').trim() === cId) return true;
      if (cCode && cCode !== 'T0' && normalizeTcode(clientTcode || codeRaw) === cCode && sameTransportPhone(c.phone_digits || c.phone, phonePrefix + phone)) return true;
      return false;
  }

  function isAcceptedTransportClientForCurrentPhone() {
      const phoneKey = normalizeTransportPhoneKey(phonePrefix + phone);
      const decisionKey = String(transportClientMatchDecision?.matchKey || '');
      return Boolean(
        isValidTransportPhoneDigits(phoneKey) &&
        transportClientMatchDecision?.mode === 'use_existing' &&
        decisionKey.includes(`transport-phone:${phoneKey}:`) &&
        (clientId || (clientTcode && normalizeTcode(clientTcode) !== 'T0'))
      );
  }

  function resetAcceptedTransportClientIdentity() {
      setClientId(null);
      setClientTcode('');
      setCodeRaw('');
      setTransportClientMatchPrompt({ open: false, matchKey: '', candidate: null, phoneDigits: '' });
      setTransportClientMatchDecision({ matchKey: '', mode: '' });
  }

  function handleTransportPhoneChange(raw) {
      const nextPhone = String(raw || '').replace(/\D+/g, '');
      if ((clientId || clientTcode || transportClientMatchDecision?.mode) && nextPhone !== String(phone || '')) {
        resetAcceptedTransportClientIdentity();
      }
      setPhone(nextPhone);
  }

  function handleTransportPrefixChange(nextPrefix) {
      const prefix = String(nextPrefix || '+383');
      if (prefix !== phonePrefix && (clientId || clientTcode || transportClientMatchDecision?.mode)) {
        resetAcceptedTransportClientIdentity();
      }
      setPhonePrefix(prefix);
      setShowPrefixSheet(false);
  }

  useEffect(() => {
      if (creating || isEdit) return;
      const tid = (actor?.role === 'TRANSPORT') ? me?.transport_id : assignTid;
      const phoneFull = sanitizePhone(phonePrefix + (phone || ''));
      const phoneKey = normalizeTransportPhoneKey(phoneFull);
      if (!tid || !isValidTransportPhoneDigits(phoneKey)) {
        if (transportClientMatchPrompt?.open) setTransportClientMatchPrompt({ open: false, matchKey: '', candidate: null, phoneDigits: '' });
        return;
      }
      let alive = true;
      const t = setTimeout(() => {
        void (async () => {
          const found = await findTransportClientByPhoneOnly(phoneFull, { timeoutMs: 5000 }).catch(() => null);
          if (!alive) return;
          if (!found) {
            if (transportClientMatchPrompt?.open) setTransportClientMatchPrompt({ open: false, matchKey: '', candidate: null, phoneDigits: '' });
            return;
          }
          const matchKey = buildTransportPhoneMatchKey(found, phoneFull);
          if (isSelectedTransportPhoneClient(found)) return;
          if (String(transportClientMatchDecision?.matchKey || '') === matchKey && transportClientMatchDecision?.mode === 'use_existing') return;
          if (String(transportClientMatchPrompt?.matchKey || '') === matchKey && transportClientMatchPrompt?.open) return;
          setTransportClientMatchPrompt({ open: true, matchKey, candidate: found, phoneDigits: phoneKey });
        })();
      }, 650);
      return () => { alive = false; clearTimeout(t); };
  }, [creating, isEdit, actor?.role, me?.transport_id, assignTid, phonePrefix, phone, clientId, clientTcode, codeRaw, transportClientMatchDecision?.matchKey, transportClientMatchDecision?.mode, transportClientMatchPrompt?.open, transportClientMatchPrompt?.matchKey]);

  // ✅ FIX: MESAZHI I GATSHËM PËR SMS/VIBER
  function buildStartMessage() {
      const code = normalizeTcode(codeRaw);
      const pieces = Number(copeCount || 0);
      return [
        `Përshëndetje ${name || ''},`,
        `Porosia juaj u pranua me sukses.`,
        `KODI: ${code}`,
        `COPË: ${pieces}`,
        `TOTALI: ${Number(totalEuro || 0).toFixed(2)} €`,
        ``,
        `Kur porosia të jetë gati, do t'ju njoftojmë për konfirmim. Pa konfirmimin tuaj, porosia nuk sillet.`,
        `Nëse nuk lajmëroheni brenda 3 ditëve, aplikohet tarifë ekstra për ta risjellë.`,
        ``,
        `📍 Ndiqni porosinë live:`,
        `https://tepiha.vercel.app/k/${normalizeTcode(codeRaw)}`,
        ``,
        `Tel: ${COMPANY_PHONE_DISPLAY}`
      ].join('\n');
  }
  function buildReceiptMessage() {
      const paid = Number(clientPaid || 0);
      const debt = Math.max(0, Number(totalEuro || 0) - paid);
      return [
        `TEPIHA - RECITË`,
        `KODI: ${normalizeTcode(codeRaw)}`,
        `KLIENTI: ${name || ''}`,
        `TOTAL: ${Number(totalEuro || 0).toFixed(2)} €`,
        `PAGUAR: ${paid.toFixed(2)} €`,
        `BORXH: ${debt.toFixed(2)} €`,
        `Tel: ${COMPANY_PHONE_DISPLAY}`,
      ].join('\n');
  }
  function buildCurrentMessage() {
      return msgKind === 'receipt' ? buildReceiptMessage() : buildStartMessage();
  }
  function saveClientQuick() {
      if (!String(name || '').trim()) return alert('Shkruaj emrin!');
      const normalized = (clientTcode || codeRaw) ? normalizeTcode(clientTcode || codeRaw) : '';
      if (normalized && normalized !== 'T0') {
        setClientTcode(normalized);
        setCodeRaw(normalized);
      }
      setShowAddClient(false);
  }

  function handleTcodeChange(raw) {
      const normalized = normalizeTcode(raw);
      setClientTcode(normalized);
      setCodeRaw(normalized);
  }

  // ✅ FIX: RUAJTJA -> KAMION -> MESAZH
  async function handleContinue() {
      if (savingContinue || photoUploading) return;
      if(!name) return alert("Shkruaj emrin!");
      const currentActorRole = String(actor?.role || '').trim().toUpperCase();
      const currentIsBaseWorker = isBaseWorkerRoleForTransportBridge(currentActorRole);
      if (currentIsBaseWorker && !isBaseBridgeEdit) {
        alert('Ky rol mund të hapë TRANSPORT PRANIMI vetëm nga PASTRIMI për editim.');
        return;
      }
      if (currentIsBaseWorker && isBaseBridgeEdit && !isEdit) {
        alert('PUNTORI i bazës nuk mund të krijojë transport order të ri.');
        return;
      }
      // transport_id written to DB = assignment scope
      // - TRANSPORT user: own tid
      // - ADMIN/DISPATCH: selected driver tid OR ADMIN_<pin>
      // - PUNTOR via Pastrimi bridge: locked existing transport_id from the order
      const editDataForTransport = (isEdit && editOriginalData && typeof editOriginalData === 'object' && !Array.isArray(editOriginalData)) ? editOriginalData : {};
      const preservedBridgeTid = readExistingTransportAssignment({ transport_id: editDataForTransport?.transport_id }, editDataForTransport) || lockedBridgeTransportId || assignTid;
      const tid = (currentIsBaseWorker && isBaseBridgeEdit)
        ? preservedBridgeTid
        : ((actor?.role === 'TRANSPORT') ? me?.transport_id : assignTid);
      if(!tid) return alert("S'je i kyçur (PIN)!");
      if (currentIsBaseWorker && isBaseBridgeEdit && !preservedBridgeTid) {
        alert('Nuk u gjet shoferi/transport_id ekzistues për këtë transport order. Nuk u ruajt që të mos ndryshohet assignment-i.');
        return;
      }
      setSavingContinue(true);
      // 1) Phone-only existing-client check for transport client book.
      // Transport never decides an existing client from name or T-code; phone_digits is the guard.
      const cleanClientName = String(name || '').trim();
      const phoneFull = sanitizePhone(phonePrefix + phone);
      const phoneDigits = normalizePhoneDigits(phoneFull);
      const phoneKey = normalizeTransportPhoneKey(phoneFull);
      const phoneIsValidForMatch = isValidTransportPhoneDigits(phoneKey);
      const actorPin = String(actor?.pin || me?.pin || me?.transport_pin || '').trim();
      const actorName = String(actor?.name || me?.name || me?.full_name || me?.username || displayTransportName(actorPin, transportUserNameMap, '') || '').trim();
      let existingPhoneClient = null;
      if (!isEdit && phoneIsValidForMatch) {
        existingPhoneClient = await findTransportClientByPhoneOnly(phoneFull, { timeoutMs: 5500 }).catch(() => null);
        if (existingPhoneClient && !isSelectedTransportPhoneClient(existingPhoneClient)) {
          const matchKey = buildTransportPhoneMatchKey(existingPhoneClient, phoneFull);
          if (!(String(transportClientMatchDecision?.matchKey || '') === matchKey && transportClientMatchDecision?.mode === 'use_existing')) {
            setTransportClientMatchPrompt({ open: true, matchKey, candidate: existingPhoneClient, phoneDigits: phoneKey });
            setSavingContinue(false);
            return;
          }
          applyExistingTransportClientCandidate(existingPhoneClient, { accepted: true });
        }
      }

      const acceptedExistingByPhone = Boolean(existingPhoneClient || isAcceptedTransportClientForCurrentPhone());
      let tcodeForClient = String((existingPhoneClient?.tcode || (acceptedExistingByPhone ? clientTcode : '') || normalizeTcode(codeRaw)) || '').toUpperCase().trim();
      let nextClientId = existingPhoneClient?.id || (acceptedExistingByPhone ? clientId : null) || null;

      // Nëse telefoni nuk ekziston në DB, vetëm atëherë merret T-code i ri.
      // Existing transport clients keep their permanent T-code and never consume a fresh code.
      if (!acceptedExistingByPhone && (!tcodeForClient || tcodeForClient === 'T0' || tcodeForClient === '0')) {
        try {
          const fresh = await getOrReserveTransportCode(tid, { oid });
          if (fresh) {
            setCodeRaw(fresh);
            setClientTcode(fresh);
            tcodeForClient = String(fresh).toUpperCase().trim();
          }
        } catch {}
      }
      if (!tcodeForClient || tcodeForClient === 'T0' || tcodeForClient === '0') {
        // S’ka kod => ruaje si draft dhe mos e humb klientin
        try { upsertDraftLocal(buildDraftPayload({ id: oid, codeRaw, name, phone, tepihaRows, stazaRows, stairsQty, stairsPer, addressDesc, gpsLat, gpsLng, clientPhotoUrl, notes, clientPaid, pricePerM2 }, getCurrentDraftTransportId())); } catch {}
        try { localStorage.setItem(OFFLINE_MODE_KEY, '1'); } catch {}
        alert('⚠️ S’MORI T-KOD. U RUAJT SI DRAFT. Provo prap kur të ketë lidhje.');
        setSavingContinue(false);
        return;
      }
      try {
        const r = await upsertTransportClient({
          id: nextClientId || undefined,
          name: cleanClientName,
          phone: phoneFull,
          phone_digits: phoneDigits,
          tcode: tcodeForClient,
          address: addressDesc || '',
          gps_lat: gpsLat ?? null,
          gps_lng: gpsLng ?? null,
          notes: notes || ''
        });
        if (!r?.ok || !(r?.id || r?.client_id)) {
          throw new Error(r?.error || 'TRANSPORT_CLIENT_LINK_FAILED');
        }
        nextClientId = r?.id || r?.client_id || nextClientId || null;
        tcodeForClient = String((r?.tcode || tcodeForClient) || '').toUpperCase().trim();
        setClientId(nextClientId || null);
        setClientTcode(tcodeForClient);
        setCodeRaw(tcodeForClient);
      } catch (e) {
        console.warn('upsertTransportClient failed:', e?.message);
        try { upsertDraftLocal(buildDraftPayload({ id: oid, codeRaw: tcodeForClient || codeRaw, name: cleanClientName, phone, tepihaRows, stazaRows, stairsQty, stairsPer, addressDesc, gpsLat, gpsLng, clientPhotoUrl, notes, clientPaid, pricePerM2 }, getCurrentDraftTransportId())); } catch {}
        alert('⚠️ Klienti i transportit nuk u lidh me DB. Porosia u ruajt si DRAFT, jo si transport_order pa client_id.');
        setSavingContinue(false);
        return;
      }
      const order = {
          id: oid, ts: Date.now(),
          client: { id: nextClientId, tcode: tcodeForClient, name: cleanClientName, phone: phoneFull, code: tcodeForClient, photoUrl: clientPhotoUrl, address: addressDesc, gps: { lat: gpsLat || null, lng: gpsLng || null } },
          tepiha: tepihaRows, staza: stazaRows, shkallore: { qty: stairsQty, per: stairsPer, photoUrl: stairsPhotoUrl },
          pay: { m2: totalM2, euro: totalEuro, paid: clientPaid, rate: Number(pricePerM2) || PRICE_DEFAULT, arkaRecordedPaid },
          notes
      };
      
      // Visit number (how many times this client has had an order)
      let visitNr = 1;
      try {
        if (tcodeForClient) {
          const vrows = await listTransportOrders({
            select: 'visit_nr',
            eq: { client_tcode: tcodeForClient },
            orderBy: 'visit_nr',
            ascending: false,
            limit: 1,
          }).catch(() => []);
          if (Array.isArray(vrows) && vrows[0]) {
            const last = Number(vrows[0].visit_nr || 0);
            visitNr = (Number.isFinite(last) ? last : 0) + 1;
          }
        }
      } catch {}
      if (!Number.isFinite(visitNr) || visitNr < 1) visitNr = 1;
      const nextStatus = isEdit ? getAdvancedTransportStatus(editRowStatus, createStatus) : createStatus;
      const payload = {
          id: oid, 
          code_str: tcodeForClient, 
          client_tcode: tcodeForClient,
          visit_nr: visitNr,
          client_id: nextClientId,
          client_name: cleanClientName, 
          client_phone: phoneFull,
          // ⚠️ transport_id është GENERATED ALWAYS (data->>'transport_id').
          // Pra NUK guxojmë me e fut në INSERT/UPDATE (kthen error "cannot insert a non-DEFAULT value...").
          // Board e lexon transport_id nga kolona e gjeneruar, sepse ne e ruajmë gjithmonë te data.transport_id.
          status: nextStatus,
          data: {
            ...order,
            client_id: nextClientId || null,
            client_name: cleanClientName,
            client_phone: phoneFull,
            phone_digits: phoneDigits,
            client: {
              ...(order?.client || {}),
              id: nextClientId || null,
              tcode: tcodeForClient,
              code: tcodeForClient,
              name: cleanClientName,
              phone: phoneFull,
              phone_digits: phoneDigits,
            },
            transport_id: tid,
            transport_user_id: editDataForTransport?.transport_user_id || undefined,
            assigned_driver_id: editDataForTransport?.assigned_driver_id || undefined,
            transport_pin: isBaseWorkerBridgeEdit ? (editDataForTransport?.transport_pin || editDataForTransport?.driver_pin || null) : (editDataForTransport?.transport_pin || undefined),
            driver_pin: isBaseWorkerBridgeEdit ? (editDataForTransport?.driver_pin || editDataForTransport?.transport_pin || null) : (editDataForTransport?.driver_pin || undefined),
            transport_name: isBaseWorkerBridgeEdit ? (editDataForTransport?.transport_name || editDataForTransport?.driver_name || null) : (editDataForTransport?.transport_name || undefined),
            driver_name: isBaseWorkerBridgeEdit ? (editDataForTransport?.driver_name || editDataForTransport?.transport_name || null) : (editDataForTransport?.driver_name || undefined),
            brought_by_pin: isBaseWorkerBridgeEdit ? (editDataForTransport?.brought_by_pin || editDataForTransport?.created_by_pin || actorPin || null) : (actorPin || null),
            brought_by_name: isBaseWorkerBridgeEdit ? (editDataForTransport?.brought_by_name || editDataForTransport?.created_by_name || actorName || null) : (actorName || null),
            created_by_pin: isBaseWorkerBridgeEdit ? (editDataForTransport?.created_by_pin || actorPin || null) : (actorPin || null),
            created_by_name: isBaseWorkerBridgeEdit ? (editDataForTransport?.created_by_name || actorName || null) : (actorName || null),
            created_by_role: isBaseWorkerBridgeEdit ? (editDataForTransport?.created_by_role || actor?.role || null) : (actor?.role || null),
            gps_lat: gpsLat || null,
            gps_lng: gpsLng || null
          }
      };
      // In edit mode, keep original client_tcode/visit_nr (don't overwrite)
      if (isEdit) {
        delete payload.client_tcode;
        delete payload.visit_nr;
      }
      try {
        if (isEdit) {
          await updateTransportOrderById(oid, payload);
          await withSupabaseTimeout(syncNow({ scope: 'transport', source: 'transport_pranimi_edit' }), 3000, 'TRANSPORT_PRANIMI_EDIT_SYNC_FAST_TIMEOUT', { source: 'transport_pranimi_edit' }).catch(() => ({ ok: false, deferred: true }));
        } else {
          // ✅ Robust Outbox: persist PENDING first, then attempt immediate sync.
          // DB triggers will auto-mark pool codes as USED only when INSERT/UPSERT succeeds.
          await enqueueTransportOrder(payload);
          const syncRes = await withSupabaseTimeout(syncNow({ scope: 'transport', source: 'transport_pranimi_create' }), 3000, 'TRANSPORT_PRANIMI_CREATE_SYNC_FAST_TIMEOUT', { source: 'transport_pranimi_create' }).catch((err) => {
            try { syncNow({ scope: 'transport', source: 'transport_pranimi_background_after_timeout' }).catch(() => {}); } catch {}
            return { ok: false, offline: true, deferred: true, timeout: err?.isSupabaseTimeout === true };
          });
          const offlineQueued = Boolean(syncRes?.offline || syncRes?.deferred || syncRes?.timeout || offlineMode || !netState?.ok || (typeof navigator !== 'undefined' && navigator.onLine === false));
          const pendingOps = await getPendingOps().catch(() => []);
          const currentPending = (Array.isArray(pendingOps) ? pendingOps : []).find((op) => {
            const pl = (op?.payload && typeof op.payload === 'object') ? op.payload : ((op?.data && typeof op.data === 'object') ? op.data : {});
            const rowId = String(pl?.id || pl?.local_oid || pl?.oid || op?.id || '');
            return rowId === String(oid);
          });
          if (currentPending && !offlineQueued) {
            throw new Error(String(currentPending?.lastError?.message || 'Dështoi sinkronizimi me serverin!'));
          }
        }

        removeDraftLocal(oid);
        setSavingContinue(false);

        if(autoMsgAfterSave) { setMsgKind('start'); setShowMsgSheet(true); } // ✅ HAP MESAZHIN
        else {
          closeAfterTransportPranimiSave();
        }
      } catch (e) {
          let queuedTransportOffline = false;
          try {
            queuedTransportOffline = await hasPendingTransportQueueItem(oid);
            if (!queuedTransportOffline && payload && !isEdit) {
              await enqueueTransportOrder(payload);
              queuedTransportOffline = true;
            }
          } catch {}
          if (!queuedTransportOffline) {
            try {
              upsertDraftLocal(buildDraftPayload({
                id: oid,
                codeRaw,
                name,
                phone,
                tepihaRows,
                stazaRows,
                stairsQty,
                stairsPer,
                addressDesc,
                gpsLat,
                gpsLng,
                clientPhotoUrl,
                clientPaid,
                pricePerM2,
                notes,
              }, getCurrentDraftTransportId()));
            } catch {}
          }
          try { localStorage.setItem(OFFLINE_MODE_KEY, '1'); } catch {}
          alert(
            queuedTransportOffline
              ? ("⚠️ RUJTJA NË SERVER DËSHTOI. POROSIA MBETI VETËM NË TRANSPORT OFFLINE QUEUE.\n" + (e?.message || ''))
              : ("⚠️ RUJTJA NË SERVER DËSHTOI. U RUAJT SI TRANSPORT DRAFT/OFFLINE.\n" + (e?.message || ''))
          );
          setSavingContinue(false);
      }
  }
  async function persistTransportPaymentState({ nextPaid, nextArkaRecordedPaid, totalEuroOverride, paymentActor = null } = {}) {
      if (!isEdit || !oid) return { ok: true, skipped: true };
      const nowIso = new Date().toISOString();
      const totalToSave = Number(totalEuroOverride ?? totalEuro ?? 0);
      const currentOrder = await fetchTransportOrderById(oid).catch(() => null);
      const currentData = (currentOrder?.data && typeof currentOrder.data === 'object' && !Array.isArray(currentOrder.data)) ? currentOrder.data : {};
      const currentClient = (currentData?.client && typeof currentData.client === 'object' && !Array.isArray(currentData.client)) ? currentData.client : {};
      const terminalStatus = 'done';
      const paymentPin = String(paymentActor?.pin || actor?.pin || me?.transport_pin || me?.pin || currentData?.driver_pin || currentData?.transport_pin || '').trim();
      const paymentName = String(paymentActor?.name || me?.name || me?.full_name || me?.username || currentData?.driver_name || currentData?.transport_name || '').trim();
      const assignedTransportId = String(
          currentData?.transport_id ||
          currentData?.transport_user_id ||
          currentData?.assigned_driver_id ||
          currentOrder?.transport_id ||
          ((actor?.role === 'TRANSPORT') ? me?.transport_id : assignTid) ||
          ''
      ).trim();
      const assignedTransportPin = String(currentData?.transport_pin || currentData?.driver_pin || paymentPin || '').trim();
      const assignedTransportName = String(currentData?.transport_name || currentData?.driver_name || paymentName || '').trim();
      const nextData = {
          ...currentData,
          client: {
              ...currentClient,
              id: clientId || currentClient?.id || null,
              tcode: String((clientTcode || currentClient?.tcode || currentClient?.code || normalizeTcode(codeRaw)) || '').toUpperCase().trim(),
              name,
              phone: phonePrefix + phone,
              code: String((clientTcode || currentClient?.code || currentClient?.tcode || normalizeTcode(codeRaw)) || '').toUpperCase().trim(),
              photoUrl: clientPhotoUrl || currentClient?.photoUrl || '',
              address: addressDesc || currentClient?.address || '',
              gps: { lat: gpsLat || currentClient?.gps?.lat || null, lng: gpsLng || currentClient?.gps?.lng || null },
          },
          tepiha: tepihaRows,
          staza: stazaRows,
          shkallore: { qty: stairsQty, per: stairsPer, photoUrl: stairsPhotoUrl },
          pay: {
              ...(currentData?.pay && typeof currentData.pay === 'object' && !Array.isArray(currentData.pay) ? currentData.pay : {}),
              m2: totalM2,
              euro: totalToSave,
              paid: Number(nextPaid || 0),
              rate: Number(pricePerM2) || PRICE_DEFAULT,
              arkaRecordedPaid: Number(nextArkaRecordedPaid || 0),
          },
          totals: {
              ...(currentData?.totals && typeof currentData.totals === 'object' && !Array.isArray(currentData.totals) ? currentData.totals : {}),
              grandTotal: totalToSave,
          },
          notes,
          status: terminalStatus,
          state: terminalStatus,
          delivered_at: nowIso,
          done_at: nowIso,
          delivered_by_transport_id: assignedTransportId || currentData?.delivered_by_transport_id || '',
          delivered_by_pin: paymentPin || currentData?.delivered_by_pin || null,
          delivered_by_name: paymentName || currentData?.delivered_by_name || null,
          transport_id: assignedTransportId || currentData?.transport_id || '',
          transport_user_id: currentData?.transport_user_id || assignedTransportId || '',
          assigned_driver_id: currentData?.assigned_driver_id || assignedTransportId || '',
          transport_pin: assignedTransportPin || null,
          driver_pin: currentData?.driver_pin || assignedTransportPin || null,
          transport_name: assignedTransportName || null,
          driver_name: currentData?.driver_name || assignedTransportName || null,
          created_by_pin: currentData?.created_by_pin || actor?.pin || null,
          created_by_role: currentData?.created_by_role || actor?.role || null,
          gps_lat: gpsLat || currentData?.gps_lat || null,
          gps_lng: gpsLng || currentData?.gps_lng || null,
      };
      await updateTransportOrderById(oid, {
        client_name: name,
        client_phone: sanitizePhone(phonePrefix + phone),
        status: terminalStatus,
        updated_at: nowIso,
        data: nextData,
      });
      return { ok: true };
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

      const nextPaid = Number((Number(clientPaid || 0) + applied).toFixed(2));
      setClientPaid(nextPaid);

      let nextArkaRecordedPaid = Number(arkaRecordedPaid || 0);
      if (payMethod === 'CASH') {
        nextArkaRecordedPaid = Number((Number(arkaRecordedPaid || 0) + applied).toFixed(2));
        setArkaRecordedPaid(nextArkaRecordedPaid);
      }

      setShowPaySheet(false);

      try {
        await persistTransportPaymentState({
          nextPaid,
          nextArkaRecordedPaid,
          totalEuroOverride: totalEuro,
          paymentActor: pinData,
        });
      } catch (e) {
        alert('Gabim gjatë ruajtjes së pagesës: ' + (e?.message || ''));
        return;
      }

      void (async () => {
        try {
          if (payMethod === 'CASH') {
            const actorPin = String(pinData?.pin || actor?.pin || me?.transport_pin || me?.pin || '').trim();
            const actorTid = String(me?.transport_id || assignTid || '').trim();
            try {
              if (actorTid) {
                const transportCode = normalizeTcode(codeRaw);
                const transportM2 = Number(totalM2 || 0) || 0;
                const transportNote = `PAGESA ${applied}€ - ${name} • ${transportCode || 'T-KOD'} • ${transportM2.toFixed(2)} m²`;
                addTransportCollected(actorTid, {
                  id: `cash_${Date.now()}`,
                  amount: applied,
                  order_code: transportCode,
                  client_name: name,
                  note: transportNote,
                  created_at: new Date().toISOString(),
                  created_by_pin: actorPin || null,
                });
              }
            } catch {}
            const transportCode = normalizeTcode(codeRaw);
            const transportM2 = Number(totalM2 || 0) || 0;
            const transportNote = `PAGESA ${applied}€ - ${name} • ${transportCode || 'T-KOD'} • ${transportM2.toFixed(2)} m²`;
            await recordCashMove({
              amount: applied,
              note: transportNote,
              type: 'TRANSPORT',
              status: 'COLLECTED',
              order_id: oid,
              order_code: transportCode,
              client_name: name,
              source: 'ORDER_PAY',
              actor: {
                pin: actorPin || null,
                name: pinData?.name || me?.name || me?.full_name || me?.username || null,
                role: pinData?.role || me?.role || null,
              },
              created_by_pin: actorPin || null,
              created_by_name: pinData?.name || me?.name || me?.full_name || me?.username || null,
            });
          }
        } catch {}
      })();

      if (typeof window !== 'undefined') {
        if (window.parent && window.parent !== window) {
          window.parent.postMessage({ type: 'transport-payment-complete' }, window.location.origin);
        } else {
          router.replace('/transport/board?tab=delivered');
        }
      }
  }
  // --- DRAFTS ---
  function openDrafts() { setDrafts(readAllDraftsLocal(getCurrentDraftTransportId())); setShowDraftsSheet(true); }
  function loadDraft(d) {
      setOid(d.id); setCodeRaw(d.codeRaw); setName(d.name || ''); setPhone(d.phone || ''); 
      setTepihaRows(d.tepihaRows||[]); setStazaRows(d.stazaRows||[]); setClientPaid(d.clientPaid||0);
      priceSourceRef.current = 'draft';
      setPricePerM2(Number(d.pricePerM2 || PRICE_DEFAULT));
      setPriceTmp(Number(d.pricePerM2 || PRICE_DEFAULT));
      setStairsQty(d.stairsQty || 0); setStairsPer(d.stairsPer || SHKALLORE_M2_PER_STEP_DEFAULT);
      setAddressDesc(d.addressDesc || ''); setGpsLat(d.gpsLat || ''); setGpsLng(d.gpsLng || '');
      setClientPhotoUrl(d.clientPhotoUrl || '');
      setNotes(d.notes || '');
      setCurrentStep(1);
      setShowDraftsSheet(false);
  }
  function deleteDraft(id) { removeDraftLocal(id); setDrafts(readAllDraftsLocal(getCurrentDraftTransportId())); }
  // --- PAYMENT / PRICE ---
  function openPay() {
    if (isBaseWorkerBridgeEdit) return;
    const dueNow = Number((totalEuro - Number(clientPaid || 0)).toFixed(2));
    setPayAdd(dueNow > 0 ? dueNow : 0);
    setPayMethod('CASH');
    setShowPaySheet(true);
  }
  function openPriceEditor() { setPriceTmp(pricePerM2); setShowPriceSheet(true); }
  function handleSecretPriceTap() {
    if (isBaseWorkerBridgeEdit) return;
    if (secretTapTimerRef.current) clearTimeout(secretTapTimerRef.current);
    secretTapRef.current += 1;
    if (secretTapRef.current >= 3) {
      secretTapRef.current = 0;
      openPriceEditor();
      return;
    }
    secretTapTimerRef.current = setTimeout(() => {
      secretTapRef.current = 0;
      secretTapTimerRef.current = null;
    }, 1000);
  }

  useEffect(() => {
    return () => {
      if (draftTimer.current) clearTimeout(draftTimer.current);
      if (secretTapTimerRef.current) clearTimeout(secretTapTimerRef.current);
    };
  }, []);

  async function savePriceAndClose() {
      const v = Number(priceTmp);
      if(!(v > 0)) {
        setShowPriceSheet(false);
        return;
      }

      setPricePerM2(v);
      try { localStorage.setItem(PRICE_KEY, String(v)); } catch {}

      try {
        if (oid) {
          upsertDraftLocal(buildDraftPayload({
            id: oid,
            codeRaw,
            name,
            phone,
            tepihaRows,
            stazaRows,
            stairsQty,
            stairsPer,
            addressDesc,
            gpsLat,
            gpsLng,
            clientPhotoUrl,
            notes,
            clientPaid,
            pricePerM2: v,
          }, getCurrentDraftTransportId()));
        }
      } catch {}

      if (isEdit && oid) {
        try {
          await persistTransportPaymentState({
            nextPaid: clientPaid,
            nextArkaRecordedPaid: arkaRecordedPaid,
            totalEuroOverride: Number((totalM2 * v).toFixed(2)),
          });
        } catch (e) {
          alert('Gabim gjatë ruajtjes së çmimit: ' + (e?.message || ''));
          return;
        }
      }

      setShowPriceSheet(false);
  }
  if (creating) return <div className="wrap"><p style={{textAlign:'center', paddingTop:30}}>Duke u hapur...</p></div>;
  return (
    <div className="wrap">
        <header className="header-row" style={{ alignItems: 'flex-start' }}>
            <div><h1 className="title">PRANIMI</h1><div className="subtitle">KRIJO POROSI</div></div>
            <div className="code-badge"><span className="badge" onClick={handleSecretPriceTap} style={{ cursor: "pointer", WebkitTapHighlightColor: "transparent", userSelect: "none", WebkitUserSelect: "none" }}>KODI: {(clientTcode || codeRaw) ? normalizeTcode(clientTcode || codeRaw) : 'I RI'}</span></div>
        </header>

        {actor?.role !== 'TRANSPORT' && !isBaseWorkerBridgeEdit && (
          <section style={{marginTop: 10}}>
            <div className="card" style={{padding:'12px 14px', borderRadius:18}}>
              <div style={{fontSize:12, opacity:.75, marginBottom:8}}>KUJT ME IA QIT?</div>
              <select
                value={assignTid}
                onChange={async (e) => {
                  const v = String(e.target.value || '').trim();
                  setAssignTid(v);
                  if (!isEdit) {
                    // Switching driver/admin scope starts a clean code/client decision.
                    resetAcceptedTransportClientIdentity();
                  }
                }}
                style={{width:'100%', padding:'10px 12px', borderRadius:12, background:'#0f172a', color:'#fff', border:'1px solid rgba(255,255,255,0.12)'}}
              >
                <option value={assignTid}>{assignTid.startsWith('ADMIN_') || assignTid==='ADMIN' ? 'VETEM ADMIN' : (displayTransportName(assignTid, transportUserNameMap, 'SHOFER I CAKTUAR') || 'SHOFER I CAKTUAR')}</option>
                {actor?.pin && <option value={`ADMIN_${actor.pin}`}>VETEM ADMIN</option>}
                {transportUsers.map(u => <option key={u.pin} value={u.pin}>{u.name}</option>)}
              </select>
            </div>
          </section>
        )}

        {isBaseWorkerBridgeEdit && (
          <section style={{marginTop: 10}}>
            <div className="card" style={{padding:'12px 14px', borderRadius:18, border:'1px solid rgba(59,130,246,0.35)', background:'rgba(59,130,246,0.10)'}}>
              <div style={{fontSize:12, opacity:.75, marginBottom:6}}>BASE BRIDGE EDIT</div>
              <div style={{fontSize:13, fontWeight:900}}>SHOFERI/TRANSPORT_ID ËSHTË I KYÇUR DHE NUK NDRYSHOHET NGA PASTRIMI.</div>
            </div>
          </section>
        )}

        <section className="card">
          <h2 className="card-title">KLIENTI</h2>
          <div className="client-toolbar">
            <button type="button" className="icon-chip search" aria-label="Kërko klient" title="KËRKO KLIENT">🔍</button>
            <button type="button" className="icon-chip drafts" onClick={openDrafts} aria-label="Të pa plotsuarat" title={`TË PA PLOTSUARAT${drafts.length > 0 ? ` (${drafts.length})` : ''}`}>📝{drafts.length > 0 ? <span className="header-icon-badge">{drafts.length}</span> : null}</button>
            <button type="button" className="icon-chip add" onClick={() => setShowAddClient(true)} aria-label="Shto klient" title="SHTO KLIENT">＋</button>
          </div>

          <div className="field-group" style={{ marginTop: 12 }}>
            <input className="input" placeholder="KËRKO: TEL • KOD • Txx • EMËR" value={clientQuery} onChange={e => setClientQuery(e.target.value)} />
            {clientsLoading ? <div style={{ fontSize: 12, opacity: .7, marginTop: 8 }}>DUKE KËRKUAR...</div> : null}
            {clientSearchNotice ? <div style={{ fontSize: 12, opacity: .82, marginTop: 8, color: '#fbbf24', fontWeight: 800 }}>{clientSearchNotice}</div> : null}
            {clientHits.length > 0 ? (
              <div className="client-hits">
                {clientHits.map((c, i) => (
                  <button
                    type="button"
                    key={c.id || i}
                    className="client-hit"
                    onClick={() => {
                      const candidate = normalizeTransportClientCandidate(c || {});
                      setName(candidate.name || '');
                      const digits = normalizePhoneDigits(candidate.phone_digits || candidate.phone);
                      const candidatePhoneKey = normalizeTransportPhoneKey(candidate.phone_digits || candidate.phone || digits);
                      const queryPhoneKey = normalizeTransportPhoneKey(clientQuery);
                      const currentPhoneKey = normalizeTransportPhoneKey(phonePrefix + phone);
                      const phoneMatchedByInput = Boolean(
                        isValidTransportPhoneDigits(candidatePhoneKey) &&
                        ((queryPhoneKey && queryPhoneKey === candidatePhoneKey) || (currentPhoneKey && currentPhoneKey === candidatePhoneKey))
                      );
                      if (digits && phoneMatchedByInput) {
                        const fullPhone = String(candidate.phone || '');
                        const pref = PREFIX_OPTIONS.find((opt) => fullPhone.startsWith(opt.code));
                        if (pref) {
                          setPhonePrefix(pref.code);
                          setPhone(fullPhone.slice(pref.code.length).replace(/\D+/g, ''));
                        } else {
                          setPhone(normalizeTransportPhoneKey(digits));
                        }
                      }
                      // Search by name/T-code may fill visible fields, but it never accepts an existing client.
                      // The decision remains phone-only and must go through the green confirmation prompt.
                      setClientId(null);
                      setClientTcode('');
                      setCodeRaw('');
                      setTransportClientMatchDecision({ matchKey: '', mode: '' });
                      if (candidate.address) setAddressDesc(candidate.address);
                      if (candidate.gps_lat) setGpsLat(candidate.gps_lat);
                      if (candidate.gps_lng) setGpsLng(candidate.gps_lng);
                      if (phoneMatchedByInput) {
                        setShowAddClient(true);
                        setTransportClientMatchPrompt({
                          open: true,
                          matchKey: buildTransportPhoneMatchKey(candidate, candidate.phone_digits || candidate.phone || digits),
                          candidate,
                          phoneDigits: candidatePhoneKey,
                        });
                      } else {
                        setTransportClientMatchPrompt({ open: false, matchKey: '', candidate: null, phoneDigits: '' });
                      }
                      setClientQuery('');
                    }}
                  >
                    <div style={{fontWeight:900}}>{String(c.tcode || '').trim() ? String(c.tcode).toUpperCase() : 'KLIENT'}</div>
                    <div style={{fontSize:13, opacity:.82}}>{c.name} • {c.phone}</div>
                    {(c.brought_by || Number(c.pieces || 0) > 0) ? (
                      <div style={{fontSize:11, opacity:.72}}>
                        {(displayTransportName(c.brought_by, transportUserNameMap, c.brought_by ? 'TRANSPORT' : 'TRANSPORT') || 'TRANSPORT') ? `🚚 ${displayTransportName(c.brought_by, transportUserNameMap, c.brought_by ? 'TRANSPORT' : 'TRANSPORT')}` : '🚚 TRANSPORT'}{Number(c.pieces || 0) > 0 ? ` • ${Number(c.pieces || 0)} copë` : ''}
                      </div>
                    ) : null}
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          {(name || phone || clientPhotoUrl || addressDesc) ? (
            <div className="client-selected-card">
              <div className="client-selected-main">
                {clientPhotoUrl ? <img src={clientPhotoUrl} alt="" className="client-mini large" /> : <div className="client-avatar-fallback">👤</div>}
                <div className="client-selected-copy">
                  <div className="client-copy-topline">
                    <div className="client-code-pill">{(clientTcode || codeRaw) ? normalizeTcode(clientTcode || codeRaw) : 'I RI'}</div>
                    <button type="button" className="client-inline-edit" onClick={() => setShowAddClient(true)}>✎</button>
                  </div>
                  <div className="client-selected-name">{name || 'KLIENT I RI'}</div>
                  <div className="client-selected-phone">{String(phone || '').replace(/\D+/g, '') ? `${phonePrefix} ${String(phone || '').replace(/\D+/g, '')}` : 'PA TELEFON'}</div>
                  {addressDesc ? <div className="client-selected-address">📍 {addressDesc}</div> : null}
                  <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {(gpsLat || gpsLng) ? (
                      <>
                        <button type="button" className="btn secondary" onClick={() => window.open(`https://maps.google.com/?q=${gpsLat},${gpsLng}`, '_blank')} style={{ padding: '8px 14px', fontSize: 13, minHeight: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6, background: 'rgba(45,212,191,0.15)', color: '#2dd4bf', border: '1px solid rgba(45,212,191,0.3)', borderRadius: 12, fontWeight: 900 }}>
                          🗺️ HAP HARTËN
                        </button>
                        <button type="button" className="btn secondary" onClick={handleGetGPS} disabled={gpsLoading} style={{ padding: '8px 14px', fontSize: 13, minHeight: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6, borderRadius: 12, fontWeight: 800 }}>
                          {gpsLoading ? '...' : '📍 NDRYSHO'}
                        </button>
                      </>
                    ) : (
                      <button type="button" className="btn secondary" onClick={handleGetGPS} disabled={gpsLoading} style={{ padding: '8px 14px', fontSize: 13, minHeight: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6, borderRadius: 12, fontWeight: 800 }}>
                        {gpsLoading ? 'DUKE MARRË...' : '📍 MERR GPS LOKAL'}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          ) : null}

          {oldClientDebt > 0 && <div style={{ marginTop:12, padding:'10px 12px', borderRadius:12, background:'rgba(239,68,68,0.16)', border:'1px solid rgba(239,68,68,0.35)', color:'#fecaca', fontWeight:900, fontSize:12 }}>⚠️ KUJDES: KY KLIENT KA {oldClientDebt.toFixed(2)}€ BORXH TË VJETËR!</div>}

        </section>

        <section className="card">
          <h2 className="card-title">TEPIHA</h2>
          <div className="chip-row modern">
            {TEPIHA_CHIPS.map((v) => (
              <button key={v} type="button" className="chip chip-modern" onClick={() => applyChip('tepiha', v)} style={chipStyleForVal(v, activeChipKey === `tepiha:${Number(v)}`)}>
                {v.toFixed(1)}
              </button>
            ))}
          </div>
          {tepihaRows.map((row) => (
            <div className="piece-row" key={row.id}>
              <div className="row">
                <input className="input small" type="number" value={row.m2} onChange={(e) => handleRowChange('tepiha', row.id, 'm2', e.target.value)} placeholder="m²" />
                <input className="input small" type="number" value={row.qty} onChange={(e) => handleRowChange('tepiha', row.id, 'qty', e.target.value)} placeholder="copë" />
                <label className="camera-btn">{row.photoUrl ? <img src={row.photoUrl} style={{width:'100%', height:'100%', borderRadius:12, objectFit:'cover'}} /> : '📷'}<input type="file" hidden accept="image/*" onChange={(e) => handleRowPhotoChange('tepiha', row.id, e.target.files?.[0])} /></label>
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
              <button key={v} type="button" className="chip chip-modern" onClick={() => applyChip('staza', v)} style={chipStyleForVal(v, activeChipKey === `staza:${Number(v)}`)}>
                {v.toFixed(1)}
              </button>
            ))}
          </div>
          {stazaRows.map((row) => (
            <div className="piece-row" key={row.id}>
              <div className="row">
                <input className="input small" type="number" value={row.m2} onChange={(e) => handleRowChange('staza', row.id, 'm2', e.target.value)} placeholder="m²" />
                <input className="input small" type="number" value={row.qty} onChange={(e) => handleRowChange('staza', row.id, 'qty', e.target.value)} placeholder="copë" />
                <label className="camera-btn">{row.photoUrl ? <img src={row.photoUrl} style={{width:'100%', height:'100%', borderRadius:12, objectFit:'cover'}} /> : '📷'}<input type="file" hidden accept="image/*" onChange={(e) => handleRowPhotoChange('staza', row.id, e.target.files?.[0])} /></label>
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
            {!isBaseWorkerBridgeEdit && <button className="btn secondary" style={{ flex: 1 }} onClick={openPay}>€ PAGESA</button>}
          </div>
          <div style={{ marginTop: 10 }}>
            <button className="btn secondary" style={{ width: '100%' }} onClick={() => { setMsgKind('start'); setShowMsgSheet(true); }}>📩 DËRGO MESAZH — FILLON PASTRIMI</button>
          </div>
          <div className="tot-line">M² Total: <strong>{totalM2.toFixed(2)}</strong></div>
          <div className="tot-line">Copë: <strong>{copeCount}</strong></div>
          <div className="tot-line">Total: <strong>{totalEuro.toFixed(2)} €</strong></div>
          <div className="tot-line" style={{ borderTop: '1px solid rgba(255,255,255,0.08)', marginTop: 10, paddingTop: 10 }}>Paguar: <strong style={{ color: '#16a34a' }}>{Number(clientPaid || 0).toFixed(2)} €</strong></div>
          <div className="tot-line" style={{ fontSize: 12, color: 'rgba(255,255,255,0.65)' }}>Regjistru n'ARKË: <strong>{Number(arkaRecordedPaid || 0).toFixed(2)} €</strong></div>
          {currentDebt > 0 && <div className="tot-line">Borxh: <strong style={{ color: '#dc2626' }}>{currentDebt.toFixed(2)} €</strong></div>}
          {currentChange > 0 && <div className="tot-line">Kthim: <strong style={{ color: '#2563eb' }}>{currentChange.toFixed(2)} €</strong></div>}
        </section>

        <section className="card">
          <h2 className="card-title">SHËNIME</h2>
          <textarea className="input" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </section>

        <footer className="footer-bar">
          <button className="btn secondary" onClick={() => router.push(isBaseWorkerBridgeEdit ? '/pastrimi' : '/transport/menu')}>↩ {isBaseWorkerBridgeEdit ? 'PASTRIMI' : 'MENU'}</button>
          <button className="btn primary" onClick={handleContinue} disabled={photoUploading || savingContinue}>
            {savingContinue ? '⏳ DUKE RUJT...' : (isEdit ? '💾 RUAJ' : '💾 RUAJ / VAZHDO')}
          </button>
        </footer>

        {showAddClient && (
          <div className="modal-overlay" onClick={() => setShowAddClient(false)}>
            <div className="modal-content dark add-client-modal" onClick={(e) => e.stopPropagation()}>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom: 12 }}>
                <div>
                  <div className="card-title" style={{ margin:0 }}>KLIENT I RI</div>
                  <div style={{ fontSize:12, opacity:.72, marginTop:4 }}>IDENTIKE ME BAZËN + T-CODE & ADRESË GPS</div>
                </div>
                <button className="btn secondary" style={{ padding:'10px 12px' }} onClick={() => setShowAddClient(false)}>✕</button>
              </div>

              <div className="field-group transport-tcode-focus">
                <label className="label">T-CODE</label>
                <input className="input tcodeInput" value={(clientTcode || codeRaw) ? normalizeTcode(clientTcode || codeRaw) : 'MERRET PAS TEL.'} readOnly disabled placeholder="T123" style={{ opacity: 0.7, cursor: 'not-allowed' }} />
              </div>

              <div className="field-group">
                <label className="label">EMRI & MBIEMRI</label>
                <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="EMRI I KLIENTIT" />
              </div>

              <div className="field-group">
                <label className="label">TELEFONI</label>
                <div className="row">
                  <button type="button" className="prefixBtn" onClick={() => setShowPrefixSheet(true)}>{phonePrefix}</button>
                  <input className="input" value={phone} onChange={(e) => handleTransportPhoneChange(e.target.value)} inputMode="numeric" placeholder="44XXXXXX" />
                </div>
              </div>

              {transportClientMatchPrompt?.open && transportClientMatchPrompt?.candidate ? (
                <div className="transport-existing-client-prompt">
                  <div className="existing-title">KY KLIENT EKZISTON NË DB. A DON ME SHTU POROSI TË RE TE KY KLIENT?</div>
                  <div className="existing-grid">
                    <div><span>EMRI</span><strong>{transportClientMatchPrompt.candidate.name || 'PA EMËR'}</strong></div>
                    <div><span>TEL</span><strong>{transportClientMatchPrompt.candidate.phone || transportClientMatchPrompt.candidate.phone_digits || 'PA TEL'}</strong></div>
                    <div><span>T-CODE</span><strong>{normalizeTcode(transportClientMatchPrompt.candidate.tcode || '')}</strong></div>
                    <div><span>ADRESA/GPS</span><strong>{transportClientMatchPrompt.candidate.address || ((transportClientMatchPrompt.candidate.gps_lat || transportClientMatchPrompt.candidate.gps_lng) ? `${transportClientMatchPrompt.candidate.gps_lat || ''}${transportClientMatchPrompt.candidate.gps_lng ? `, ${transportClientMatchPrompt.candidate.gps_lng}` : ''}` : 'NUK KA')}</strong></div>
                  </div>
                  <div className="existing-actions">
                    <button type="button" className="btn" onClick={() => applyExistingTransportClientCandidate(transportClientMatchPrompt.candidate, { accepted: true })}>PO, SHTO TE KY KLIENT</button>
                    <button type="button" className="btn secondary" onClick={() => { resetAcceptedTransportClientIdentity(); setPhone(''); }}>NUK ËSHTË KY — NDRYSHO TEL</button>
                  </div>
                </div>
              ) : null}

              <div className="field-group">
                <label className="label">ADRESA</label>
                <textarea className="input" rows={4} value={addressDesc} onChange={(e) => setAddressDesc(e.target.value)} placeholder="PËRSHKRUAJ ADRESËN, HYRJEN, KATIN, OBORRIN..." />
              </div>

              <div className="field-group" style={{ marginBottom: 0 }}>
                <label className="label">LOKACIONI GPS</label>
                <button type="button" className={`gps-big-btn ${gpsSaved ? 'ok' : ''}`} onClick={handleGetGPS} disabled={gpsLoading}>
                  {gpsLoading ? 'Duke kërkuar...' : (gpsSaved || gpsLat ? '✅ Lokacioni u ruajt' : '📍 MERR LOKACIONIN (GPS)')}
                </button>
                {(gpsLat || gpsLng) ? <div style={{ fontSize:12, opacity:.78, marginTop:8 }}>GPS: {String(gpsLat || '')}{gpsLng ? ` • ${String(gpsLng)}` : ''}</div> : null}
              </div>

              <div style={{ display:'flex', gap:10, marginTop: 14 }}>
                <button type="button" className="btn secondary" style={{ flex:1 }} onClick={() => setShowAddClient(false)}>ANULO</button>
                <button type="button" className="btn primary" style={{ flex:1 }} onClick={saveClientQuick}>RUAJ KLIENTIN</button>
              </div>
            </div>
          </div>
        )}
      {/* PAY SHEET */}
      {showPaySheet && !isBaseWorkerBridgeEdit && (
        <PosModal
          open={showPaySheet}
          onClose={() => setShowPaySheet(false)}
          title="PAGESA (ARKË)"
          subtitle={`KODI: ${normalizeTcode(codeRaw)} • ${name}`}
          total={totalEuro}
          alreadyPaid={Number(clientPaid || 0)}
          amount={payAdd}
          setAmount={setPayAdd}
          payChips={PAY_CHIPS}
          confirmText="KRYEJ PAGESËN"
          cancelText="ANULO"
          disabled={savingContinue}
          onConfirm={applyPayAndClose}
        />
      )}
      {/* SHKALLORE SHEET */}
      {showStairsSheet && (
        <div className="modal-overlay" onClick={() => setShowStairsSheet(false)}>
          <div className="modal-content dark" onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3 className="card-title" style={{ margin: 0, color: '#fff' }}>SHKALLORE</h3>
              <button className="btn secondary" onClick={() => setShowStairsSheet(false)}>✕</button>
            </div>
            <div className="field-group" style={{ marginTop: 12 }}>
              <label className="label">COPË</label>
              <div className="chip-row">
                {SHKALLORE_QTY_CHIPS.map((n) => <button key={n} className="chip" onClick={() => setStairsQty(n)}>{n}</button>)}
              </div>
              <input type="number" className="input" value={stairsQty||''} onChange={(e) => setStairsQty(e.target.value)} placeholder="" />
            </div>
            <div className="field-group">
              <label className="label">m² PËR COPË</label>
              <div className="chip-row">
                {SHKALLORE_PER_CHIPS.map((v) => <button key={v} className="chip" onClick={() => setStairsPer(v)}>{v}</button>)}
              </div>
              <input type="number" step="0.01" className="input" value={stairsPer||''} onChange={(e) => setStairsPer(e.target.value)} />
            </div>
            <div className="field-group">
              <div style={{display:'flex', justifyContent:'space-between', alignItems:'center'}}>
                  <label className="label">FOTO</label>
                  <label className="camera-btn">
                      {stairsPhotoUrl ? <img src={stairsPhotoUrl} style={{width:'100%', height:'100%', borderRadius:12, objectFit:'cover'}} /> : '📷'}
                      <input type="file" hidden accept="image/*" onChange={(e) => handleStairsPhotoChange(e.target.files?.[0])} />
                  </label>
              </div>
            </div>
            <button className="btn primary" style={{ width: '100%', marginTop: 12 }} onClick={() => setShowStairsSheet(false)}>MBYLL</button>
          </div>
        </div>
      )}
      {/* DRAFTS SHEET */}
      {showDraftsSheet && (
        <div className="draftsOverlay" onClick={() => setShowDraftsSheet(false)}>
          <div className="draftsModal" onClick={(e) => e.stopPropagation()}>
            <div className="draftsTop">
              <div>
                <div className="draftsTitle">TË PA PLOTSUARAT</div>
                <div className="draftsSub">Zgjidh një draft për të vazhduar ose fshije nëse nuk të duhet më.</div>
              </div>
              <button className="btn secondary" onClick={() => setShowDraftsSheet(false)}>✕</button>
            </div>
            <div className="draftsBody">
              {drafts.length === 0 ? (
                <div className="draftsEmpty">S'ka porosi të pambarura.</div>
              ) : (
                drafts.map((d) => (
                  <div key={d.id} className="draftCardWrap">
                    <button type="button" className="draftCard" onClick={() => loadDraft(d)}>
                      <div className="draftCode">{d.codeRaw || 'PA KOD'}</div>
                      <div className="draftName">{d.name || 'Pa emër klienti'}</div>
                    </button>
                    <button
                      type="button"
                      className="draftDelete"
                      onClick={() => deleteDraft(d.id)}
                      aria-label="Fshi draftin"
                      title="Fshi draftin"
                    >
                      🗑
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
      {/* PREFIX SHEET */}
      {showPrefixSheet && (
        <div className="modalCenterOverlay" onClick={() => setShowPrefixSheet(false)}>
            <div className="modalCenter" onClick={e => e.stopPropagation()}>
                {PREFIX_OPTIONS.map(o => (
                    <div key={o.code} className="prefixOpt" onClick={() => handleTransportPrefixChange(o.code)}>
                        <span className="poFlag">{o.flag}</span><span className="poCode">{o.code}</span>
                    </div>
                ))}
            </div>
        </div>
      )}
      {/* PRICE SHEET */}
      {showPriceSheet && !isBaseWorkerBridgeEdit && (
        <div className="payfs">
          <div className="payfs-top">
            <div className="payfs-title">NDËRRO QMIMIN</div>
            <button className="btn secondary" onClick={() => setShowPriceSheet(false)}>✕</button>
          </div>
          <div className="payfs-body">
            <input type="number" className="input" value={priceTmp} onChange={e=>setPriceTmp(Number(e.target.value) || 0)} />
            <button className="btn primary" style={{marginTop:20, width:'100%'}} onClick={savePriceAndClose}>RUJ</button>
          </div>
        </div>
      )}
      {/* MESSAGE SHEET */}
      {/* MESSAGE MODAL FULL SCREEN */}
      {showMsgSheet && (
        <div className="msgOverlay" onClick={closeAfterTransportPranimiSave}>
          <div className="msgModal" onClick={(e) => e.stopPropagation()}>
            <div className="msgModalTop">
              <div>
                <div className="msgModalTitle">MESAZHI PËR KLIENTIN</div>
                <div className="msgModalSub">Dërgoje nga këtu para se ta mbyllësh porosinë.</div>
              </div>
              <button className="btn secondary" onClick={closeAfterTransportPranimiSave}>MBYLL</button>
            </div>
            <div className="msgPreview">
              <pre style={{color:'#E5E7EB', fontSize:14, whiteSpace:'pre-wrap', lineHeight:1.55, margin:0}}>{buildCurrentMessage()}</pre>
            </div>
            <div className="msgActions">
              <button className="btn secondary" onClick={() => {
                const txt = buildCurrentMessage();
                try { navigator.clipboard?.writeText(txt); } catch {}
              }}>KOPJO</button>
              <button className="btn secondary" onClick={() => {
                const txt = buildCurrentMessage();
                const ph = sanitizePhone(phonePrefix + phone);
                window.open(`https://wa.me/${ph}?text=${encodeURIComponent(txt)}`, '_blank');
              }}>WHATSAPP</button>
              <button className="btn secondary" onClick={() => {
                const txt = buildCurrentMessage();
                const ph = sanitizePhone(phonePrefix + phone);
                window.open(`viber://chat?number=%2B${ph}`, '_blank');
              }}>VIBER</button>
              <button className="btn primary" onClick={() => {
                const txt = buildCurrentMessage();
                const ph = sanitizePhone(phonePrefix + phone);
                const smsHref = buildSmsLink(ph, txt);
                if (smsHref) window.open(smsHref, '_blank');
              }}>SMS</button>
            </div>
          </div>
        </div>
      )}
      <style jsx>{`
        .wrap { padding: 10px 10px 80px; max-width: 600px; margin: 0 auto; color: white; }

        .client-toolbar{ display:flex; gap:10px; margin-top:8px; }
        .icon-chip{ width:54px; height:54px; border:none; border-radius:999px; background:#f2f2f7; color:#111; display:flex; align-items:center; justify-content:center; font-size:28px; font-weight:900; box-shadow:0 10px 26px rgba(0,0,0,0.24); position:relative; }
        .header-icon-badge{ position:absolute; top:-4px; right:-4px; min-width:22px; height:22px; border-radius:999px; background:#ef4444; color:#fff; display:flex; align-items:center; justify-content:center; font-size:11px; font-weight:900; padding:0 6px; }
        .client-hits{ display:flex; flex-direction:column; gap:8px; margin-top:10px; }
        .client-hit{ text-align:left; padding:12px; border-radius:14px; border:1px solid rgba(255,255,255,0.08); background:rgba(255,255,255,0.05); color:#fff; }
        .client-selected-card{ margin-top:12px; border-radius:18px; padding:14px; background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.08); }
        .client-selected-main{ display:flex; align-items:center; gap:12px; }
        .client-mini.large{ width:58px; height:58px; border-radius:999px; object-fit:cover; border:1px solid rgba(255,255,255,0.08); }
        .client-avatar-fallback{ width:58px; height:58px; border-radius:999px; display:flex; align-items:center; justify-content:center; font-size:24px; background:#222; }
        .client-selected-copy{ min-width:0; flex:1; }
        .client-copy-topline{ display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:6px; }
        .client-code-pill{ display:inline-flex; align-items:center; justify-content:center; min-height:28px; padding:0 12px; border-radius:999px; background:#16a34a; color:#fff; font-size:12px; font-weight:900; }
        .client-inline-edit{ border:none; background:transparent; color:#93c5fd; font-size:18px; }
        .client-selected-name{ font-size:18px; font-weight:900; line-height:1.15; }
        .client-selected-phone,.client-selected-address{ margin-top:4px; font-size:13px; opacity:.82; }
        .transport-existing-client-prompt{ margin-top:12px; padding:14px; border-radius:18px; background:rgba(22,163,74,0.16); border:1px solid rgba(34,197,94,0.45); color:#fff; }
        .transport-existing-client-prompt .existing-title{ font-size:13px; line-height:1.35; font-weight:1000; color:#bbf7d0; letter-spacing:.02em; }
        .transport-existing-client-prompt .existing-grid{ display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-top:12px; }
        .transport-existing-client-prompt .existing-grid div{ padding:9px 10px; border-radius:12px; background:rgba(0,0,0,0.22); min-width:0; }
        .transport-existing-client-prompt .existing-grid span{ display:block; font-size:10px; opacity:.68; font-weight:900; letter-spacing:.08em; margin-bottom:3px; }
        .transport-existing-client-prompt .existing-grid strong{ display:block; font-size:12px; font-weight:900; overflow-wrap:anywhere; }
        .transport-existing-client-prompt .existing-actions{ display:grid; grid-template-columns:1fr; gap:8px; margin-top:12px; }
        @media (max-width:520px){ .transport-existing-client-prompt .existing-grid{ grid-template-columns:1fr; } }
        .transport-extra-grid{ display:grid; grid-template-columns:1fr; gap:12px; margin-top:14px; }
        .transport-extra-card{ border:1px solid rgba(255,255,255,0.10); background:linear-gradient(180deg, rgba(255,255,255,0.07), rgba(255,255,255,0.03)); border-radius:18px; padding:14px; box-shadow:0 10px 24px rgba(0,0,0,0.18); }
        .transport-extra-label{ font-size:11px; font-weight:900; letter-spacing:1px; opacity:.68; margin-bottom:8px; }
        .transport-extra-value{ font-size:14px; font-weight:800; line-height:1.35; }
        .transport-code-hero{ font-size:26px; letter-spacing:1px; color:#7dd3fc; }
        .transport-extra-note{ margin-top:6px; font-size:11px; opacity:.62; line-height:1.35; }
        .transport-extra-actions{ display:flex; gap:10px; margin-top:10px; flex-wrap:wrap; }
        .transport-gps-inline{ margin-top:8px; font-size:12px; opacity:.74; }
        .transport-tcode-focus .label{ color:#7dd3fc; }
        .tcodeInput{ font-size:22px; font-weight:900; letter-spacing:1px; text-transform:uppercase; color:#7dd3fc; }
        @media (min-width: 860px){ .transport-extra-grid{ grid-template-columns:1fr 1fr; } }
        .add-client-modal{ max-width:520px; }
        .prefixBtn{ min-width:92px; background:#222; border:1px solid #333; color:#fff; border-radius:12px; font-weight:800; }
        .gps-big-btn{ width:100%; min-height:54px; border:none; border-radius:14px; background:#1f2937; color:#fff; font-weight:900; font-size:15px; }
        .gps-big-btn.ok{ background:#166534; }
        .header-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
        .title { font-size: 24px; font-weight: 900; margin: 0; }
        .subtitle { font-size: 12px; opacity: 0.7; font-weight: 700; letter-spacing: 1px; }
        .code-badge { background: #222; padding: 6px 12px; borderRadius: 12px; font-weight: 800; }
        .card { background: #111; border-radius: 18px; padding: 16px; margin-bottom: 16px; border: 1px solid rgba(255,255,255,0.1); }
        .card-title { font-size: 14px; font-weight: 900; margin-bottom: 12px; color: rgba(255,255,255,0.6); }
        .field-group { margin-bottom: 14px; }
        .label { font-size: 12px; font-weight: 800; margin-bottom: 6px; display: block; opacity: 0.8; }
        .input { width: 100%; background: #222; border: 1px solid #333; color: white; padding: 12px; border-radius: 12px; font-size: 16px; font-weight: 600; }
        .row { display: flex; gap: 10px; }
        .btn { border: none; padding: 14px; border-radius: 14px; font-weight: 900; font-size: 14px; cursor: pointer; display: flex; align-items: center; justify-content: center; }
        .primary { background: white; color: black; }
        .secondary { background: #222; color: white; }
        .footer-bar { position: fixed; bottom: 0; left: 0; right: 0; background: rgba(0,0,0,0.9); padding: 16px; display: flex; gap: 10px; border-top: 1px solid #222; backdrop-filter: blur(10px); }
        .chip-row { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
        .chip { padding: 10px 14px; border-radius: 12px; background: #222; color: white; font-weight: 700; border: 1px solid #333; }
        .piece-row { margin-bottom: 10px; padding-bottom: 10px; border-bottom: 1px solid #222; }
        .tot-line { font-size: 14px; display: flex; justify-content: space-between; margin-bottom: 6px; }
        .camera-btn { width: 44px; height: 44px; background: #222; border-radius: 12px; display: flex; align-items: center; justify-content: center; font-size: 20px; cursor: pointer; border: 1px solid #333; }
        .modalCenterOverlay { position: fixed; inset: 0; background: rgba(0,0,0,0.8); z-index: 10000; display: flex; align-items: center; justify-content: center; }
        .modalCenter { width: 300px; background: #111; padding: 20px; border-radius: 20px; border: 1px solid #333; }
        .prefixOpt { padding: 12px; border-bottom: 1px solid #222; display: flex; justify-content: space-between; font-weight: 700; }
        .modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.6); z-index: 9999; display: flex; alignItems: center; justifyContent: center; padding: 20px; }
        .modal-content { width: 100%; max-width: 420px; padding: 18px; border-radius: 18px; background: white; }
        .draftsOverlay { position: fixed; inset: 0; background: rgba(0,0,0,0.82); z-index: 11050; display: flex; align-items: center; justify-content: center; padding: 16px; }
        .draftsModal { width: min(860px, 100%); max-height: calc(100vh - 32px); overflow: auto; background: linear-gradient(180deg, #0b1220, #111827); border: 1px solid rgba(255,255,255,0.12); border-radius: 22px; box-shadow: 0 24px 80px rgba(0,0,0,0.45); padding: 18px; }
        .draftsTop { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; margin-bottom:14px; }
        .draftsTitle { font-size: 18px; font-weight: 900; letter-spacing: .4px; }
        .draftsSub { font-size: 12px; opacity: .72; margin-top: 4px; }
        .draftsBody { display:flex; flex-direction:column; gap:12px; }
        .draftsEmpty { text-align:center; padding:28px 16px; color:#94a3b8; background: rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.08); border-radius:18px; }
        .draftCardWrap { display:flex; gap:10px; align-items:stretch; }
        .draftCard { flex:1; text-align:left; padding:16px; border-radius:18px; background: rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.10); color:#fff; cursor:pointer; }
        .draftCode { color:#22c55e; font-weight:900; font-size:18px; line-height:1.15; }
        .draftName { margin-top:8px; font-size:15px; font-weight:700; color:#e5e7eb; }
        .draftDelete { width:52px; min-width:52px; border-radius:16px; border:1px solid rgba(255,255,255,0.10); background: rgba(239,68,68,0.14); color:#fecaca; font-size:22px; cursor:pointer; }
        .msgOverlay { position: fixed; inset: 0; background: rgba(0,0,0,0.82); z-index: 11000; display: flex; align-items: center; justify-content: center; padding: 16px; }
        .msgModal { width: min(760px, 100%); max-height: calc(100vh - 32px); overflow: auto; background: linear-gradient(180deg, #0b1220, #111827); border: 1px solid rgba(255,255,255,0.12); border-radius: 22px; box-shadow: 0 24px 80px rgba(0,0,0,0.45); padding: 18px; }
        .msgModalTop { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:14px; }
        .msgModalTitle { font-size: 18px; font-weight: 900; letter-spacing: .4px; }
        .msgModalSub { font-size: 12px; opacity: .72; margin-top: 4px; }
        .msgPreview { background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.08); border-radius: 18px; padding: 16px; }
        .msgActions { display:grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap:10px; margin-top:14px; }
        .modal-content.dark { background: #0b0b0b; color: #fff; border: 1px solid rgba(255,255,255,0.1); }
        
        /* MODERN CHIPS STYLE */
        .chip-modern { padding: 10px 14px; border-radius: 14px; font-weight: 900; font-size: 16px; letter-spacing: 0.2px; text-shadow: 0 1px 0 rgba(0,0,0,0.35); }
        .gpsBtn { width: 44px; background: #222; border: 1px solid #333; border-radius: 12px; color: white; font-size: 20px; cursor: pointer; display: flex; align-items: center; justify-content: center; }

        /* PHONE-FRIENDLY TRANSPORT CLIENT MODAL
           Keeps the existing-client prompt usable on iPhone/Safari when the
           keyboard/browser bars reduce the visible height. */
        @media (max-width: 560px) {
          .modal-overlay {
            align-items: flex-start;
            justify-content: center;
            overflow-y: auto;
            -webkit-overflow-scrolling: touch;
            padding: max(10px, env(safe-area-inset-top)) 10px calc(108px + env(safe-area-inset-bottom));
          }
          .modal-content.add-client-modal {
            width: min(100%, 420px);
            max-height: calc(100dvh - 118px);
            overflow-y: auto;
            -webkit-overflow-scrolling: touch;
            padding: 14px;
            border-radius: 20px;
          }
          .modal-content.add-client-modal .card-title {
            font-size: 13px;
            line-height: 1.1;
          }
          .modal-content.add-client-modal .field-group {
            margin-bottom: 10px;
          }
          .modal-content.add-client-modal .label {
            margin-bottom: 5px;
          }
          .modal-content.add-client-modal .input,
          .modal-content.add-client-modal .prefixBtn {
            min-height: 48px;
            padding: 10px 12px;
            font-size: 16px;
          }
          .modal-content.add-client-modal .tcodeInput {
            font-size: 18px;
          }
          .transport-existing-client-prompt {
            margin-top: 10px;
            padding: 12px;
            border-radius: 16px;
            max-height: 46dvh;
            overflow-y: auto;
            -webkit-overflow-scrolling: touch;
          }
          .transport-existing-client-prompt .existing-title {
            font-size: 12px;
            line-height: 1.32;
          }
          .transport-existing-client-prompt .existing-grid {
            grid-template-columns: 1fr;
            gap: 6px;
            margin-top: 10px;
          }
          .transport-existing-client-prompt .existing-grid div {
            padding: 7px 9px;
            border-radius: 11px;
          }
          .transport-existing-client-prompt .existing-grid span {
            font-size: 9px;
            margin-bottom: 2px;
          }
          .transport-existing-client-prompt .existing-grid strong {
            font-size: 12px;
            line-height: 1.2;
          }
          .transport-existing-client-prompt .existing-actions {
            position: sticky;
            bottom: -1px;
            background: linear-gradient(180deg, rgba(5,46,22,0), rgba(5,46,22,0.98) 22%, rgba(5,46,22,0.98));
            padding-top: 10px;
            margin-top: 8px;
          }
          .transport-existing-client-prompt .existing-actions .btn {
            min-height: 46px;
            padding: 10px 12px;
            font-size: 12px;
            line-height: 1.2;
          }
        }
      `}</style>
    </div>
  );
}
export default function PranimiPage() {
  return (
    <Suspense fallback={null}>
      <PranimiPageInner />
    </Suspense>
  );
}
