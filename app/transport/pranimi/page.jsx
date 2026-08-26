"use client";
import { computeM2FromRows } from '@/lib/baseCodes';
import { clearTransportCodeReservationForOrder, getTransportCodeReservationForOrder, releaseTransportCodeIfUnused, reserveTransportCode } from '@/lib/transportCodes';
import { normalizePhoneDigits } from '@/lib/transport/clientCodes';
import { findTransportClientByPhoneOnly as findTransportClientByPhoneCanonical, insertTransportOrder } from '@/lib/transport/transportDb';
import {
  isValidTransportPhoneDigits,
  normalizeTransportPhoneKey,
  sameTransportPhoneDigits as sameTransportPhone,
  transportPhoneDigitVariants as buildTransportPhoneVariants,
} from '@/lib/transport/phone';
import React, { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from '@/lib/routerCompat.jsx';
import { supabase, storageWithTimeout, withSupabaseTimeout } from '@/lib/supabaseClient';
import { getPendingOps } from '@/lib/offlineStore';
import { getTransportSession, getTransportContext } from '@/lib/transportAuth';
import { readBestActor } from '@/lib/sessionStore';
import { ARKA_ACTION } from '@/lib/arka/arkaConstants';
import { arkaTransaction, buildArkaIdempotencyKey } from '@/lib/arka/arkaClient';
import PosModal from '@/components/PosModalV2';
import SmartSmsModal from '@/components/SmartSmsModal';
import { requirePaymentPin } from '@/lib/paymentPin';
import { getClientBalanceByPhone } from '@/lib/clientBalanceDb';
import { enqueueTransportOrder, syncNow } from '@/lib/syncManager';
import { addTransportCollected } from '@/lib/transportArkaStore';
import {
  collectTransportClientPayment,
  deliverTransportOrderWithDebt,
  getTransportReceivableSummary,
} from '@/lib/transportReceivablesClient';
import {
  acquireTransportPaymentIntent,
  clearTransportPaymentIntent,
  readTransportPaymentIntent,
} from '@/lib/transportPaymentIntent';
import { fetchTransportOrderById, isTransportOrderPaymentBlocked, listTransportOrders, searchTransportClientCandidatesByOrders, updateTransportOrderById } from '@/lib/transportOrdersDb';
import { buildSmartSmsText } from '@/lib/smartSms';
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
const TEPIHA_CHIPS = [1.0, 1.2, 1.5, 1.8, 2.0, 2.1, 2.2, 2.5, 2.8, 3.0, 3.2, 3.5, 3.7, 4.0, 4.5, 5.0, 5.8, 6.0, 8.0, 10.0, 12.0];
const STAZA_CHIPS = [0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.2, 1.5, 1.6, 1.8, 2.0, 2.2, 2.4, 2.5, 2.8, 3.0, 3.5, 4.0, 4.5, 5.0, 6.0];

const SHKALLORE_QTY_CHIPS = [5, 8, 10, 12, 13, 14, 15, 16, 17, 18, 20, 25, 30];
const SHKALLORE_PER_CHIPS = [0.25, 0.3, 0.35, 0.4, 0.45, 0.5];
const SHKALLORE_M2_PER_STEP_DEFAULT = 0.3;
const PRICE_DEFAULT = 1.8;
const LEGACY_TRANSPORT_PRICE_DEFAULTS = new Set([1.5, 3]);
const PAY_CHIPS = [5, 10, 20, 30, 50];
const DELIVERY_FINALIZE_STATUSES = new Set(['delivery', 'dorzim', 'dorezim', 'dorëzim']);
const LOADED_DELIVERY_PAYMENT_STATUSES = new Set(['loaded', 'ngarkuar', 'ngarkim']);
const LEDGER_PAYMENT_STATUSES = new Set([...DELIVERY_FINALIZE_STATUSES, ...LOADED_DELIVERY_PAYMENT_STATUSES, 'done', 'completed', 'delivered', 'dorzuar', 'dorezuar', 'dorëzuar']);
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
function officialTransportCode(raw) {
  const code = normalizeTcode(raw);
  return code && code !== 'T0' ? code : '';
}
function transportCodeNumber(raw) {
  const digits = String(raw || '').replace(/\D+/g, '').replace(/^0+/, '');
  return digits ? Number(digits) : null;
}
function sameMoney(a, b) {
  return Math.abs(Number(a || 0) - Number(b || 0)) <= 0.005;
}
function round2(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return 0;
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
function assertVerifiedTransportPaymentResult(result = {}, { orderId = '', code = '', amount = 0, actorPin = '' } = {}) {
  if (!result?.ok) throw new Error(result?.error || 'ARKA_TRANSPORT_PAYMENT_FAILED');
  if (result?.needsManualRepair) throw new Error(result?.repairCode || 'ARKA_NEEDS_MANUAL_REPAIR');
  if (result?.paymentVerified !== true) throw new Error('TRANSPORT_ARKA_PAYMENT_NOT_VERIFIED');
  const payment = result?.payment || result?.row || null;
  if (!payment?.id) throw new Error('TRANSPORT_ARKA_PAYMENT_ROW_MISSING');
  if (String(payment.transport_order_id || payment.transportOrderId || '').trim() !== String(orderId || '').trim()) throw new Error('TRANSPORT_ARKA_PAYMENT_ORDER_MISMATCH');
  const wantedCode = normalizeTcode(code);
  if (wantedCode && wantedCode !== 'T0' && normalizeTcode(payment.transport_code_str || payment.transportCodeStr || '') !== wantedCode) throw new Error('TRANSPORT_ARKA_PAYMENT_CODE_MISMATCH');
  if (!sameMoney(payment.amount, amount)) throw new Error('TRANSPORT_ARKA_PAYMENT_AMOUNT_MISMATCH');
  if (String(payment.type || '').trim().toUpperCase() !== 'TRANSPORT') throw new Error('TRANSPORT_ARKA_PAYMENT_TYPE_MISMATCH');
  if (String(payment.source_module || payment.sourceModule || '').trim().toUpperCase() !== 'TRANSPORT') throw new Error('TRANSPORT_ARKA_PAYMENT_SOURCE_MISMATCH');
  const pin = String(actorPin || '').trim();
  if (pin && String(payment.created_by_pin || '').trim() !== pin) throw new Error('TRANSPORT_ARKA_PAYMENT_PIN_MISMATCH');
  return payment;
}
function localYmd(input = new Date()) {
  try {
    const d = input instanceof Date ? input : new Date(input);
    if (!Number.isFinite(d.getTime())) return '';
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  } catch {
    return '';
  }
}
function nextLocalYmd() {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  return localYmd(date);
}

function defaultTransportPickupSlot() {
  try {
    return new Date().getHours() >= 15 ? 'evening' : 'morning';
  } catch {
    return 'morning';
  }
}
function transportPickupWindow(slot) {
  return String(slot || '').toLowerCase() === 'evening' ? '17:00-21:00' : '09:00-14:00';
}
const ACTIVE_CODE_KEY = 'transport_pranimi_active_code_v1';
const CODE_LEASE_KEY = 'transport_code_lease_v1';
const DRAFTS_FOLDER = 'transport_drafts';
const SETTINGS_FOLDER = 'transport_settings';
const TRANSPORT_CLIENT_SEARCH_TIMEOUT_MS = 12000;
// ---------------- HELPERS ----------------
function sanitizePhone(phone) { return String(phone || '').replace(/\D+/g, ''); }
function buildTransportPhoneDigits(prefix, local) {
  const prefixDigits = sanitizePhone(prefix || '+383') || '383';
  let localDigits = sanitizePhone(local || '');
  if (!localDigits) return '';
  if (localDigits.startsWith('00')) localDigits = localDigits.slice(2);
  if (localDigits.startsWith(prefixDigits)) {
    const rest = localDigits.slice(prefixDigits.length).replace(/^0+/, '');
    return rest ? `${prefixDigits}${rest}` : prefixDigits;
  }
  localDigits = localDigits.replace(/^0+/, '');
  return localDigits ? `${prefixDigits}${localDigits}` : prefixDigits;
}
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

function normalizeTransportStatusForVerify(value = '') {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'pastrimi') return 'pastrim';
  if (raw === 'ngarkuar' || raw === 'picked_up') return 'loaded';
  if (raw === 'ready') return 'gati';
  if (raw === 'accepted') return 'assigned';
  if (raw === 'dorezim' || raw === 'dorëzim') return 'dorzim';
  return raw;
}

function isBrowserTransportOffline() {
  try {
    return typeof navigator !== 'undefined' && navigator.onLine === false;
  } catch {
    return false;
  }
}

function isTransportNetworkLikeError(error) {
  const text = String(error?.message || error?.error || error || '').toLowerCase();
  const code = String(error?.code || '').toUpperCase();
  return (
    code === 'ABORT_ERR' ||
    text.includes('failed to fetch') ||
    text.includes('network') ||
    text.includes('timeout') ||
    text.includes('timed out') ||
    text.includes('aborted') ||
    text.includes('load failed') ||
    text.includes('offline')
  );
}

function decorateTransportSaveError(error, flags = {}) {
  const e = error instanceof Error ? error : new Error(String(error?.message || error || 'TRANSPORT_ORDER_SAVE_FAILED'));
  Object.assign(e, flags || {});
  return e;
}

function assertVerifiedTransportOrderRow(row = {}, expected = {}) {
  const expectedCode = officialTransportCode(expected?.codeStr || '');
  const rowData = row?.data && typeof row.data === 'object' && !Array.isArray(row.data) ? row.data : {};
  const rowClient = rowData?.client && typeof rowData.client === 'object' && !Array.isArray(rowData.client) ? rowData.client : {};
  const rowCode = officialTransportCode(
    row?.code_str ||
    rowData?.code_str ||
    rowData?.order_code ||
    rowData?.order_tcode ||
    rowData?.official_order_code ||
    row?.client_tcode ||
    ''
  );
  if (!row?.id || String(row.id) !== String(expected?.id || '')) {
    throw new Error('TRANSPORT_ORDER_VERIFY_ID_MISMATCH');
  }
  if (expectedCode && rowCode !== expectedCode) {
    throw new Error(`TRANSPORT_ORDER_VERIFY_CODE_MISMATCH: pritej ${expectedCode}, u gjet ${rowCode || '-'}`);
  }
  const expectedN = transportCodeNumber(expectedCode);
  const rowN = Number(row?.code_n || transportCodeNumber(rowCode) || 0);
  if (expectedN && rowN && Number(rowN) !== Number(expectedN)) {
    throw new Error(`TRANSPORT_ORDER_VERIFY_CODE_N_MISMATCH: ${rowN} != ${expectedN}`);
  }
  const expectedStatus = normalizeTransportStatusForVerify(expected?.status || '');
  const rowStatus = normalizeTransportStatusForVerify(row?.status || '');
  const rowDataStatus = normalizeTransportStatusForVerify(rowData?.status || '');
  if (expectedStatus && rowStatus !== expectedStatus) {
    throw new Error(`TRANSPORT_ORDER_VERIFY_STATUS_MISMATCH: pritej ${expectedStatus}, u gjet ${rowStatus || '-'}`);
  }
  const expectedDataStatus = normalizeTransportStatusForVerify(expected?.dataStatus || expected?.status || '');
  if (expectedDataStatus && rowDataStatus !== expectedDataStatus) {
    throw new Error(`TRANSPORT_ORDER_VERIFY_DATA_STATUS_MISMATCH: pritej ${expectedDataStatus}, u gjet ${rowDataStatus || '-'}`);
  }
  const expectedPhoneKey = normalizeTransp