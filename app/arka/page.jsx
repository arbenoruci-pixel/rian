'use client';

import Link from '@/lib/routerCompat.jsx';
import LocalErrorBoundary from '@/components/LocalErrorBoundary';
import { useEffect, useMemo, useRef, useState } from 'react';
import { getActor } from '@/lib/actorSession';
import { supabase } from '@/lib/supabaseClient';
import { ARKA_ACTION, ARKA_SOURCE_MODULE } from '@/lib/arka/arkaConstants';
import { arkaTransaction, buildArkaIdempotencyKey } from '@/lib/arka/arkaClient';
import { fetchSessionUserByPin } from '@/lib/usersService';
import useRouteAlive from '@/lib/routeAlive';
import { bootLog, bootMarkReady } from '@/lib/bootLog';
import { getStartupIsolationLeftMs, isWithinStartupIsolationWindow } from '@/lib/startupIsolation';
import {
  approveExpenseEntry,
  createExpenseEntry,
  createMealDistributionEntry,
  ensureMealDecisionBeforeHandoff,
  isExtraSettled,
  listCashHandoffRecords,
  listMealStaffOptions,
  listPendingPaymentRecords,
  listTodayWorkers,
  listWorkerArkaExtras,
  listWorkerHandoffs,
  listWorkerPendingPayments,
  rejectExpenseEntry,
} from '@/lib/arkaService';
import {
  acceptDispatchHandoff,
  listPendingDispatchHandoffs,
  rejectDispatchHandoff,
  submitWorkerCashToDispatch,
} from '@/lib/corporateFinance';

const MONEY = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const WORKER_PAYMENTS_LIMIT = 80;
const WORKER_EXTRAS_LIMIT = 80;
const WORKER_HANDOFFS_LIMIT = 80;
const MANAGER_SECONDARY_LIMIT = 40;
const RELOAD_MIN_GAP_MS = 1800;
const LIFECYCLE_RELOAD_GAP_MS = 2600;
const PRIMARY_STALE_MS = 45000;
const SECONDARY_STALE_MS = 12000;
const ERROR_COOLDOWN_MS = 8000;
const MUTATION_COOLDOWN_MS = 2600;
const MUTATION_PRIMARY_DELAY_MS = 1400;
const INITIAL_MANAGER_SECONDARY_DELAY_MS = 1400;
const FOOD_DEDUCTION = 3;
const EXTRA_TYPES = new Set(['TIMA', 'EXPENSE', 'MEAL_PAYMENT', 'MEAL_COVERED']);
const NON_PAYMENT_STATUSES = new Set(['OWED', 'REJECTED', 'WORKER_DEBT', 'ADVANCE', 'PENDING_DISPATCH_APPROVAL', 'ACCEPTED_BY_DISPATCH']);
const MANAGER_PAYMENT_SELECT = 'id,amount,type,status,note,created_at,updated_at,created_by_pin,created_by_name,handed_by_pin,handed_by_name,handed_by_role,handoff_note,client_name,order_id,order_code,source_module,transport_order_id,transport_code_str,transport_m2';
const MANAGER_HANDOFF_SELECT = 'id,amount,status,worker_pin,worker_name,submitted_at,decided_at,note';
const MANAGER_PENDING_HANDOFF_SELECT = 'id,amount,status,worker_pin,worker_name,submitted_at,note,cash_handoff_items(*)';
const MANAGER_PENDING_EXPENSE_SELECT = 'id,amount,type,status,note,created_at,created_by_pin,created_by_name';

async function listAdminPendingExpenseApprovals(limit = MANAGER_SECONDARY_LIMIT, select = MANAGER_PENDING_EXPENSE_SELECT) {
  const { data, error } = await supabase
    .from('arka_pending_payments')
    .select(select)
    .eq('type', 'EXPENSE')
    .in('status', ['PENDING', 'PENDING_DISPATCH_APPROVAL'])
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    const msg = error?.message || error?.details || error?.hint || 'NUK U NGARKUAN SHPENZIMET NË PRITJE.';
    throw new Error(msg);
  }

  return Array.isArray(data) ? data : [];
}
const ARKA_MANAGER_CACHE_KEY = 'tepiha_arka_manager_cache_v1';
const ARKA_WORKER_CACHE_PREFIX = 'tepiha_arka_worker_cache_v1:';

function euro(v) {
  return `€${MONEY.format(Number(v || 0) || 0)}`;
}
function n(v) {
  const x = Number(v || 0);
  return Number.isFinite(x) ? x : 0;
}

const PAYMENT_TIME_ZONE = "Europe/Belgrade";

function fmtPaymentStamp(value) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";

  const parts = new Intl.DateTimeFormat("sq-AL", {
    timeZone: PAYMENT_TIME_ZONE,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);

  const get = (type) => parts.find((p) => p.type === type)?.value || "";

  return `${get("day")}/${get("month")}/${get("year")} • ${get("hour")}:${get("minute")}`;
}
function parseAmountInput(v) {
  const raw = String(v ?? '').trim().replace(/\s/g, '').replace(',', '.');
  return n(raw);
}
function safeUpper(v) {
  return String(v || '').trim().toUpperCase();
}

const EXPENSE_REQUEST_TAG = 'ARKA_EXPENSE_REQUEST_V1';

function cleanExpenseRequestValue(value) {
  return String(value || '').replace(/[;\n\r]/g, ' ').trim();
}

function cleanExpenseRequestBaseNote(note) {
  return String(note || '')
    .replace(/\n?ARKA_EXPENSE_REQUEST_V1[^\n]*/gi, '')
    .trim();
}

function buildExpenseRequestNote(note, request = {}) {
  const base = cleanExpenseRequestBaseNote(note) || 'SHPENZIM';
  const type = safeUpper(request?.requestType) === 'PERSONAL_ADVANCE' ? 'PERSONAL_ADVANCE' : 'BUSINESS_EXPENSE';
  const parts = [`${EXPENSE_REQUEST_TAG} type=${type}`];
  if (type === 'PERSONAL_ADVANCE') {
    parts.push(`beneficiary_pin=${cleanExpenseRequestValue(request?.beneficiaryPin)}`);
    parts.push(`beneficiary_name=${cleanExpenseRequestValue(request?.beneficiaryName)}`);
  }
  return `${base}\n${parts.join('; ')}`;
}

function parseExpenseRequestNote(note) {
  const raw = String(note || '');
  const cleanNote = cleanExpenseRequestBaseNote(raw) || raw.trim();
  const match = raw.match(/ARKA_EXPENSE_REQUEST_V1\s+type=([A-Z_]+)(?:;\s*beneficiary_pin=([^;\n]*))?(?:;\s*beneficiary_name=([^\n]*))?/i);
  const requestType = safeUpper(match?.[1] || '');
  return {
    requestType,
    beneficiaryPin: String(match?.[2] || '').trim(),
    beneficiaryName: String(match?.[3] || '').trim(),
    displayNote: cleanNote || 'SHPENZIM',
  };
}

function expenseRequestLabel(requestType) {
  const type = safeUpper(requestType);
  if (type === 'PERSONAL_ADVANCE') return 'KËRKESA: PERSONAL / AVANS';
  if (type === 'BUSINESS_EXPENSE') return 'KËRKESA: BIZNES';
  return '';
}


function expenseProposalLabel(requestType) {
  const type = safeUpper(requestType);
  if (type === 'BUSINESS_EXPENSE') return 'SHPENZIM BIZNESI';
  if (type === 'PERSONAL_ADVANCE') return 'PERSONAL / AVANS';
  if (type === 'REJECTED_OPEN_CASH') return 'REFUZO / CASH I HAPUR';
  return '—';
}

function readableArkaStatus(status) {
  const s = safeUpper(status);
  if (s === 'PENDING') return 'NË PRITJE ADMIN/DISPATCH';
  if (s === 'COLLECTED') return 'NË DORËZIM';
  if (s === 'ACCEPTED_BY_DISPATCH' || s === 'ACCEPTED') return 'PRANUAR';
  if (s === 'REJECTED' || s === 'REFUZUAR') return 'REFUZUAR';
  if (s === 'CONVERTED_TO_ADVANCE') return 'U KTHYE NË AVANS';
  return s || '—';
}

function formatBelgradeDateKey(value = new Date()) {
  try {
    const d = value instanceof Date ? value : new Date(value || Date.now());
    if (Number.isNaN(d.getTime())) return '';
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: PAYMENT_TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(d);
    const get = (type) => parts.find((part) => part.type === type)?.value || '';
    const y = get('year');
    const m = get('month');
    const day = get('day');
    return y && m && day ? `${y}-${m}-${day}` : '';
  } catch {
    return '';
  }
}

function getTimeZoneOffsetMs(timeZone, date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const asUtc = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    Number(map.hour || 0),
    Number(map.minute || 0),
    Number(map.second || 0)
  );
  return asUtc - date.getTime();
}

function zonedLocalToUtcMs(timeZone, y, m, d, h = 0, min = 0, sec = 0) {
  const guess = new Date(Date.UTC(y, m - 1, d, h, min, sec));
  const offset = getTimeZoneOffsetMs(timeZone, guess);
  return Date.UTC(y, m - 1, d, h, min, sec) - offset;
}

function belgradeDayBoundsIso(refDate = new Date()) {
  try {
    const key = formatBelgradeDateKey(refDate);
    const [y, m, d] = key.split('-').map((x) => Number(x));
    if (!y || !m || !d) throw new Error('bad_day_key');
    const startMs = zonedLocalToUtcMs(PAYMENT_TIME_ZONE, y, m, d, 0, 0, 0);
    const endMs = zonedLocalToUtcMs(PAYMENT_TIME_ZONE, y, m, d + 1, 0, 0, 0);
    return {
      dateKey: key,
      startIso: new Date(startMs).toISOString(),
      endIso: new Date(endMs).toISOString(),
    };
  } catch {
    const now = new Date(refDate || Date.now());
    const key = now.toISOString().slice(0, 10);
    return {
      dateKey: key,
      startIso: `${key}T00:00:00.000Z`,
      endIso: new Date(Date.parse(`${key}T00:00:00.000Z`) + 86400000).toISOString(),
    };
  }
}

function isBelgradeToday(value) {
  const today = formatBelgradeDateKey(new Date());
  return !!today && formatBelgradeDateKey(value) === today;
}

function isMealLikeRow(row = {}) {
  const type = typeOf(row);
  const note = String(row?.note || row?.handoff_note || row?.client_name || '').toLowerCase();
  return type === 'MEAL_PAYMENT' || type === 'MEAL_COVERED' || /(?:ushqim|buk|food)/i.test(note);
}

function isWorkerMealRowToday(row = {}, pin = '') {
  const cleanPin = String(pin || '').trim();
  if (!cleanPin || !row || !isMealLikeRow(row)) return false;
  const status = statusOf(row);
  if (['REJECTED', 'REFUZUAR'].includes(status)) return false;
  const creatorPin = String(row?.created_by_pin || '').trim();
  const handedPin = String(row?.handed_by_pin || '').trim();
  if (creatorPin !== cleanPin && handedPin !== cleanPin) return false;
  return isBelgradeToday(row?.created_at || row?.handed_at || row?.updated_at);
}

function cleanWorkerExpenseNote(row = {}) {
  const parsed = parseExpenseRequestNote(row?.note || '');
  return String(parsed?.displayNote || row?.note || 'SHPENZIM').trim();
}

function workerExpenseProposal(row = {}) {
  const rowType = typeOf(row);
  if (rowType === 'MEAL_PAYMENT' || rowType === 'MEAL_COVERED') return 'USHQIM';
  const parsed = parseExpenseRequestNote(row?.note || '');
  return expenseProposalLabel(parsed?.requestType || (rowType === 'EXPENSE' ? 'BUSINESS_EXPENSE' : ''));
}

function mealTodayAlertText(rows = []) {
  const row = (Array.isArray(rows) ? rows : []).find(Boolean) || {};
  const stamp = fmtPaymentStamp(row?.created_at || row?.handed_at || row?.updated_at) || fmtDate(row?.created_at || row?.handed_at || row?.updated_at);
  return [
    'Ushqimi për sot është regjistruar tashmë.',
    '',
    `Shuma: ${euro(row?.amount)}`,
    `Status: ${readableArkaStatus(row?.status)}`,
    `Ora: ${stamp || '—'}`,
    `Note: ${cleanExpenseRequestBaseNote(row?.note || '') || row?.note || 'USHQIM'}`,
  ].join('\n');
}

function extractExpenseDecisionId(data) {
  if (data == null) return null;
  if (Array.isArray(data)) return extractExpenseDecisionId(data[0]);
  if (typeof data === 'number' || typeof data === 'string') {
    const id = Number(data);
    return Number.isFinite(id) && id > 0 ? id : null;
  }
  if (typeof data === 'object') {
    const raw = data.decision_id ?? data.decisionId ?? data.id ?? data.decision?.id;
    const id = Number(raw);
    return Number.isFinite(id) && id > 0 ? id : null;
  }
  return null;
}

function normalizeWorkerExpenseRequest({ requestKind, actorPin, actorName, beneficiaryPin, beneficiaryName }) {
  const kind = safeUpper(requestKind || 'BUSINESS_EXPENSE');
  const selfPin = String(actorPin || '').trim();
  const selfName = String(actorName || selfPin || 'PUNTOR').trim();
  if (kind === 'PERSONAL_SELF') {
    if (!selfPin) return { error: '🔴 MUNGON PIN-I YT PËR PERSONAL / AVANS.' };
    return { requestType: 'PERSONAL_ADVANCE', beneficiaryPin: selfPin, beneficiaryName: selfName };
  }
  if (kind === 'PERSONAL_OTHER') {
    const pin = String(beneficiaryPin || '').trim();
    const name = String(beneficiaryName || '').trim();
    if (!pin) return { error: '🔴 SHKRUAJ PIN-IN E PERSONIT PËR PERSONAL / AVANS.' };
    return { requestType: 'PERSONAL_ADVANCE', beneficiaryPin: pin, beneficiaryName: name || pin };
  }
  return { requestType: 'BUSINESS_EXPENSE', beneficiaryPin: '', beneficiaryName: '' };
}

function fmtDate(v) {
  if (!v) return '—';
  try {
    return new Date(v).toLocaleString('sq-AL', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '—';
  }
}
function byDateDesc(a, b) {
  return String(b?.created_at || b?.submitted_at || b?.decided_at || b?.updated_at || '').localeCompare(
    String(a?.created_at || a?.submitted_at || a?.decided_at || a?.updated_at || '')
  );
}
function roleIsWorker(role) {
  return ['PUNTOR', 'PUNETOR', 'WORKER', 'TRANSPORT'].includes(safeUpper(role));
}
function roleIsArkaVisibleAccount(role) {
  return roleIsWorker(role) || safeUpper(role) === 'DISPATCH';
}
function roleCanManage(role) {
  return ['DISPATCH', 'ADMIN', 'ADMIN_MASTER', 'OWNER', 'PRONAR', 'SUPERADMIN'].includes(safeUpper(role));
}
function isArkaRouteActive() {
  try {
    if (typeof window === 'undefined') return true;
    const path = String(window.location?.pathname || '');
    return path === '/arka' || path.startsWith('/arka/');
  } catch {
    return true;
  }
}

function isOfflineBrowser() {
  try {
    return typeof navigator !== 'undefined' && navigator.onLine === false;
  } catch {
    return false;
  }
}

function withArkaTimeout(promise, label = 'arka_task', timeoutMs = 4200) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}_timeout_v26`)), Math.max(800, Number(timeoutMs || 0) || 4200));
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => {
    try { if (timer) clearTimeout(timer); } catch {}
  });
}

function readStoredJson(key) {
  try {
    if (typeof window === 'undefined') return null;
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function writeStoredJson(key, value) {
  try {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}
function getWorkerArkaCacheKey(pin) {
  return `${ARKA_WORKER_CACHE_PREFIX}${String(pin || '').trim()}`;
}
function mergeStoredJson(key, patch) {
  const prev = readStoredJson(key);
  const next = {
    ...(prev && typeof prev === 'object' ? prev : {}),
    ...(patch && typeof patch === 'object' ? patch : {}),
    ts: Date.now(),
  };
  writeStoredJson(key, next);
  return next;
}
function scheduleIdleTask(task, delayMs = 0, timeoutMs = 1600) {
  try {
    if (typeof window === 'undefined' || typeof task !== 'function') return () => {};
    let cancelled = false;
    let timerId = 0;
    let idleId = 0;
    const run = () => {
      if (cancelled) return;
      if (typeof window.requestIdleCallback === 'function') {
        idleId = window.requestIdleCallback(() => {
          idleId = 0;
          if (cancelled) return;
          task();
        }, { timeout: timeoutMs });
        return;
      }
      idleId = window.setTimeout(() => {
        idleId = 0;
        if (cancelled) return;
        task();
      }, 0);
    };
    timerId = window.setTimeout(() => {
      timerId = 0;
      run();
    }, Math.max(0, Number(delayMs || 0) || 0));
    return () => {
      cancelled = true;
      try { if (timerId) window.clearTimeout(timerId); } catch {}
      try {
        if (idleId && typeof window.cancelIdleCallback === 'function') window.cancelIdleCallback(idleId);
        else if (idleId) window.clearTimeout(idleId);
      } catch {}
    };
  } catch {
    return () => {};
  }
}
function mergeStoredJsonDeferred(key, patch, delayMs = 140) {
  return scheduleIdleTask(() => {
    try { mergeStoredJson(key, patch); } catch {}
  }, delayMs);
}
function reconcileActorWithUser(actor, userRow) {
  if (!actor) return actor;
  if (!userRow || typeof userRow !== 'object') return actor;
  const nextIsHybrid = isHybridWorker(userRow) || isHybridWorker(actor);
  const nextCommissionRate = firstPositiveNumber(
    userRow?.commission_rate_m2,
    userRow?.commissionRateM2,
    userRow?.transport_commission_rate_m2,
    actor?.commission_rate_m2,
    actor?.commissionRateM2,
    actor?.transport_commission_rate_m2
  );
  const next = {
    ...actor,
    pin: String(userRow?.pin || actor?.pin || '').trim(),
    name: String(userRow?.name || actor?.name || '').trim(),
    role: String(userRow?.role || actor?.role || '').trim(),
    user_id: userRow?.id || actor?.user_id || actor?.id || null,
    id: userRow?.id || actor?.id || actor?.user_id || null,
    is_hybrid_transport: nextIsHybrid,
    commission_rate_m2: nextCommissionRate > 0 ? nextCommissionRate : (nextIsHybrid ? 0.5 : 0),
    transport_id: userRow?.transport_id || actor?.transport_id || null,
  };
  return next;
}
function persistActorRepair(nextActor) {
  try {
    if (typeof window === 'undefined' || !nextActor?.pin) return;
    writeStoredJson('CURRENT_USER_DATA', nextActor);
    const session = readStoredJson('tepiha_session_v1');
    if (session && typeof session === 'object') {
      writeStoredJson('tepiha_session_v1', { ...session, actor: nextActor, user: nextActor });
    }
  } catch {}
}
function isoDay(v) {
  try {
    return new Date(v || Date.now()).toISOString().slice(0, 10);
  } catch {
    return '';
  }
}
function isToday(v) {
  const now = isoDay(new Date());
  return !!now && isoDay(v) === now;
}
function isMealCoveredForPinToday(row, pin) {
  const cleanPin = String(pin || '').trim();
  if (!cleanPin || typeOf(row) !== 'MEAL_COVERED') return false;
  const status = statusOf(row);
  if (['REJECTED', 'REFUZUAR'].includes(status)) return false;
  const targetPin = String(row?.handed_by_pin || '').trim();
  return targetPin === cleanPin && isToday(row?.created_at || row?.handed_at || row?.updated_at);
}
function staffMealCoveredToday(row) {
  return !!(row?.meal_covered_today || row?.mealCoveredToday || row?.has_meal_today);
}
function amountOf(row) {
  return n(row?.amount ?? row?.value ?? row?.total_amount ?? row?.sum);
}
function statusOf(row) {
  return safeUpper(row?.status);
}
function typeOf(row) {
  return safeUpper(row?.type);
}
function mapUniqueById(rows = []) {
  const out = [];
  const seen = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row) continue;
    const key = String(row?.id || `${row?.created_at || ''}_${row?.submitted_at || ''}_${row?.worker_pin || ''}_${row?.created_by_pin || ''}_${row?.amount || ''}_${row?.type || ''}_${row?.status || ''}`);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function isAcceptedHandoffStatus(status) {
  return ['ACCEPTED', 'ACCEPTED_BY_DISPATCH'].includes(safeUpper(status));
}
function isPendingHandoffStatus(status) {
  return ['PENDING', 'PENDING_DISPATCH_APPROVAL'].includes(safeUpper(status));
}

function cashStatusLabel(status) {
  const s = safeUpper(status);
  if (s === 'COLLECTED') return 'CASH I MARRË';
  if (s === 'PENDING_DISPATCH_APPROVAL') return 'DËRGUAR TE DISPATCH';
  if (s === 'ACCEPTED_BY_DISPATCH' || s === 'ACCEPTED') return 'PRANUAR NGA BAZA';
  if (s === 'REJECTED' || s === 'REFUZUAR') return 'KTHYER NGA DISPATCH';
  if (s === 'PENDING') return 'NË PRITJE';
  return s || '—';
}

function cashClientName(row = {}) {
  return String(row?.client_name || row?.client?.name || row?.data?.client_name || row?.data?.client?.name || row?.note || 'KLIENT').trim();
}

function cashOrderCode(row = {}) {
  const direct = String(row?.transport_code_str || row?.transport_code || row?.t_code || row?.tcode || row?.client_tcode || '').trim().toUpperCase();
  if (/^T\d+$/.test(direct)) return direct;
  const code = String(row?.order_code || row?.code || row?.client_code || row?.raw_order_id || '').trim().toUpperCase();
  if (!code) return '—';
  return code.startsWith('T') || code.startsWith('#') ? code : `#${code}`;
}

function firstPositiveNumber(...values) {
  for (const value of values) {
    const parsed = Number(value || 0);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 0;
}

function cashSourceModule(row = {}) {
  const explicit = safeUpper(row?.source_module || row?.sourceModule);
  if (explicit === 'TRANSPORT' || explicit === 'BASE') return explicit;
  if (safeUpper(row?.type) === 'TRANSPORT') return 'TRANSPORT';
  const code = String(cashOrderCode(row) || '').replace(/^#/, '').trim().toUpperCase();
  if (/^T\d+$/.test(code)) return 'TRANSPORT';
  if (String(row?.transport_order_id || row?.transportOrderId || '').trim()) return 'TRANSPORT';
  return 'BASE';
}

function isHybridWorker(worker = {}) {
  return worker?.is_hybrid_transport === true || String(worker?.is_hybrid_transport || '').toLowerCase() === 'true';
}

function workerCommissionRateM2(worker = {}) {
  const direct = firstPositiveNumber(worker?.commission_rate_m2, worker?.commissionRateM2, worker?.transport_commission_rate_m2, worker?.transportCommissionRateM2);
  if (direct > 0) return direct;
  return isHybridWorker(worker) ? 0.5 : 0;
}

function readTransportOrderM2(row = {}) {
  const data = row?.data && typeof row.data === 'object' ? row.data : {};
  const pay = data?.pay && typeof data.pay === 'object' ? data.pay : {};
  const totals = data?.totals && typeof data.totals === 'object' ? data.totals : {};
  return firstPositiveNumber(
    row?.transport_m2,
    row?.transportM2,
    row?.m2_total,
    row?.total_m2,
    row?.m2,
    row?.pieces_m2,
    row?.meta?.m2,
    row?.pay?.m2,
    data?.m2_total,
    data?.total_m2,
    data?.m2,
    pay?.m2_total,
    pay?.m2,
    totals?.m2_total,
    totals?.total_m2,
    totals?.m2
  );
}

function cleanTransportCodeFromCashRow(row = {}) {
  const direct = String(cashOrderCode(row) || '').replace(/^#/, '').trim().toUpperCase();
  if (/^T\d+$/.test(direct)) return direct;
  const data = row?.data && typeof row.data === 'object' ? row.data : {};
  const candidates = [
    row?.transport_code_str,
    row?.transport_code,
    row?.t_code,
    row?.tcode,
    row?.client_tcode,
    data?.transport_code_str,
    data?.transport_code,
    data?.client_tcode,
    data?.client_code,
  ];
  for (const value of candidates) {
    const clean = String(value || '').replace(/^#/, '').trim().toUpperCase();
    if (/^T\d+$/.test(clean)) return clean;
  }
  return '';
}

function findTransportMetaForCashRow(row = {}, transportOrdersById = {}) {
  const map = transportOrdersById && typeof transportOrdersById === 'object' ? transportOrdersById : {};
  const id = String(row?.transport_order_id || row?.transportOrderId || '').trim();
  const code = cleanTransportCodeFromCashRow(row);
  return (id && map[id]) || (code && map[`CODE:${code}`]) || (code && map[`TCODE:${code}`]) || null;
}

function readCashTransportM2(row = {}, transportOrdersById = {}) {
  const data = row?.data && typeof row.data === 'object' ? row.data : {};
  const pay = data?.pay && typeof data.pay === 'object' ? data.pay : {};
  const totals = data?.totals && typeof data.totals === 'object' ? data.totals : {};
  const meta = findTransportMetaForCashRow(row, transportOrdersById);
  return firstPositiveNumber(
    row?.transport_m2,
    row?.transportM2,
    row?.m2_total,
    row?.total_m2,
    row?.m2,
    row?.meta?.m2,
    row?.pay?.m2,
    data?.m2_total,
    data?.total_m2,
    data?.m2,
    pay?.m2_total,
    pay?.m2,
    totals?.m2_total,
    totals?.total_m2,
    totals?.m2,
    meta ? readTransportOrderM2(meta) : 0
  );
}

function chunkArray(values = [], size = 80) {
  const chunks = [];
  for (let i = 0; i < values.length; i += size) chunks.push(values.slice(i, i + size));
  return chunks;
}

async function fetchTransportMetaForCashRows(rows = []) {
  const sourceRows = Array.isArray(rows) ? rows : [];
  const ids = [...new Set(sourceRows.map((row) => String(row?.transport_order_id || row?.transportOrderId || '').trim()).filter(Boolean))];
  const codes = [...new Set(sourceRows.map((row) => cleanTransportCodeFromCashRow(row)).filter(Boolean))];
  if (!ids.length && !codes.length) return {};
  const map = {};
  const store = (items = []) => {
    for (const row of Array.isArray(items) ? items : []) {
      const id = String(row?.id || '').trim();
      const code = String(row?.code_str || row?.transport_code_str || '').trim().toUpperCase();
      const tcode = String(row?.client_tcode || row?.client_code || '').trim().toUpperCase();
      if (id) map[id] = row;
      if (code) map[`CODE:${code}`] = row;
      if (tcode) map[`TCODE:${tcode}`] = row;
    }
  };
  for (const chunk of chunkArray(ids, 60)) {
    const { data, error } = await supabase.from('transport_orders').select('*').in('id', chunk);
    if (!error) store(data);
  }
  for (const chunk of chunkArray(codes, 60)) {
    const [byCode, byTcode] = await Promise.all([
      supabase.from('transport_orders').select('*').in('code_str', chunk),
      supabase.from('transport_orders').select('*').in('client_tcode', chunk),
    ]);
    if (!byCode.error) store(byCode.data);
    if (!byTcode.error) store(byTcode.data);
  }
  return map;
}

function buildCashBreakdownRow(row = {}, worker = {}, options = {}) {
  const gross = +amountOf(row).toFixed(2);
  const sourceModule = cashSourceModule(row);
  const isTransport = sourceModule === 'TRANSPORT';
  const rate = workerCommissionRateM2(worker);
  const m2 = isTransport ? readCashTransportM2(row, options?.transportOrdersById) : 0;
  const commission = isTransport && isHybridWorker(worker) ? Math.min(gross, +(m2 * rate).toFixed(2)) : 0;
  const baseAmount = Math.max(0, +(gross - commission).toFixed(2));
  return {
    raw: row,
    id: row?.id || row?.external_id || `${cashOrderCode(row)}_${row?.created_at || row?.updated_at || gross}`,
    clientName: cashClientName(row),
    code: cashOrderCode(row),
    status: statusOf(row),
    sourceModule,
    typeLabel: isTransport ? 'TRANSPORT' : 'BAZË',
    gross,
    m2,
    commission,
    baseAmount,
    created_at: row?.created_at || row?.updated_at || row?.submitted_at || null,
  };
}

function cashBreakdownTransportDedupeKey(row = {}) {
  const raw = row?.raw || row;
  const id = String(raw?.transport_order_id || raw?.transportOrderId || row?.transport_order_id || row?.transportOrderId || '').trim();
  const code = normalizeHandoffTransportCode(raw?.transport_code_str || raw?.transportCodeStr || raw?.transport_code || raw?.client_tcode || row?.code || row?.order_code);
  if (id) return `transport_order_id:${id}`;
  if (code) return `transport_code:${code}`;
  return '';
}

function preferCashBreakdownDedupeRow(current = {}, candidate = {}) {
  const currentPending = String(current?.raw?.id || current?.raw?.pending_payment_id || '').trim();
  const candidatePending = String(candidate?.raw?.id || candidate?.raw?.pending_payment_id || '').trim();
  if (candidatePending && !currentPending) return candidate;
  if (!candidatePending && currentPending) return current;
  return String(candidate?.created_at || '') > String(current?.created_at || '') ? candidate : current;
}

function dedupeCashBreakdownTransportRows(rows = []) {
  const output = [];
  const indexByKey = new Map();
  const duplicateKeys = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    const key = String(row?.sourceModule || row?.typeLabel || '').toUpperCase() === 'TRANSPORT' ? cashBreakdownTransportDedupeKey(row) : '';
    if (!key) {
      output.push(row);
      continue;
    }
    if (!indexByKey.has(key)) {
      indexByKey.set(key, output.length);
      output.push(row);
      continue;
    }
    duplicateKeys.add(key);
    const idx = indexByKey.get(key);
    output[idx] = preferCashBreakdownDedupeRow(output[idx], row);
  }
  return {
    rows: output,
    duplicateCount: Math.max(0, (Array.isArray(rows) ? rows.length : 0) - output.length),
    duplicateKeys: [...duplicateKeys],
  };
}

function buildCashBreakdownRows(rows = [], worker = {}, options = {}) {
  const mapped = (Array.isArray(rows) ? rows : []).map((row) => buildCashBreakdownRow(row, worker, options));
  const dedupe = dedupeCashBreakdownTransportRows(mapped);
  return dedupe.rows;
}

function sumCashField(rows = [], field) {
  return +(Array.isArray(rows) ? rows : []).reduce((sum, row) => sum + n(row?.[field]), 0).toFixed(2);
}

function pushRowToGroup(map, key, row) {
  const cleanKey = String(key || '').trim();
  if (!cleanKey || !row) return;
  const current = map.get(cleanKey) || [];
  current.push(row);
  map.set(cleanKey, current);
}

function calcBulkLimit(pinCount, perPin, floor = 120, ceiling = 1600) {
  const total = Math.max(floor, (Number(pinCount || 0) || 0) * (Number(perPin || 0) || 0));
  return Math.min(ceiling, total);
}

async function loadManagerBulkSnapshots(workerRows = []) {
  const workers = Array.isArray(workerRows) ? workerRows : [];
  const pins = workers
    .map((row) => String(row?.pin || '').trim())
    .filter(Boolean);

  const uniquePins = [...new Set(pins)];
  const paymentsByPin = new Map();
  const extrasByPin = new Map();
  const handoffsByPin = new Map();
  const advancesByPin = new Map();
  let hadErrors = false;

  if (!uniquePins.length) {
    return { paymentsByPin, extrasByPin, handoffsByPin, advancesByPin, hadErrors };
  }

  const paymentsLimit = calcBulkLimit(uniquePins.length, 48, 180, 960);
  const extrasLimit = calcBulkLimit(uniquePins.length, 24, 120, 480);
  const handoffsLimit = calcBulkLimit(uniquePins.length, 12, 80, 320);
  const advancesLimit = calcBulkLimit(uniquePins.length, 12, 80, 320);

  const swallowToEmpty = (label, err) => {
    hadErrors = true;
    try { console.error(`[ARKA] ${label} failed, switching to local cache if available:`, err); } catch {}
    return [];
  };

  const [paymentRows, extraCreatedRows, extraTargetedRows, advanceCreatedRows, advanceTargetedRows, handoffRows] = await Promise.all([
    withArkaTimeout(listPendingPaymentRecords({
      select: MANAGER_PAYMENT_SELECT,
      in: { created_by_pin: uniquePins },
      orderBy: 'created_at',
      ascending: false,
      limit: paymentsLimit,
    }), 'manager_payments', 4200).catch((err) => swallowToEmpty('payments', err)),
    withArkaTimeout(listPendingPaymentRecords({
      select: MANAGER_PAYMENT_SELECT,
      in: { type: ['TIMA', 'EXPENSE', 'MEAL_PAYMENT', 'MEAL_COVERED'], created_by_pin: uniquePins },
      orderBy: 'created_at',
      ascending: false,
      limit: extrasLimit,
    }), 'manager_extras_created', 4200).catch((err) => swallowToEmpty('extras_created', err)),
    withArkaTimeout(listPendingPaymentRecords({
      select: MANAGER_PAYMENT_SELECT,
      in: { type: ['TIMA', 'EXPENSE', 'MEAL_PAYMENT', 'MEAL_COVERED'], handed_by_pin: uniquePins },
      orderBy: 'created_at',
      ascending: false,
      limit: extrasLimit,
    }), 'manager_extras_targeted', 4200).catch((err) => swallowToEmpty('extras_targeted', err)),
    withArkaTimeout(listPendingPaymentRecords({
      select: MANAGER_PAYMENT_SELECT,
      in: { status: ['ADVANCE'], created_by_pin: uniquePins },
      orderBy: 'created_at',
      ascending: false,
      limit: advancesLimit,
    }), 'manager_advances_created', 4200).catch((err) => swallowToEmpty('advances_created', err)),
    withArkaTimeout(listPendingPaymentRecords({
      select: MANAGER_PAYMENT_SELECT,
      in: { status: ['ADVANCE'], handed_by_pin: uniquePins },
      orderBy: 'created_at',
      ascending: false,
      limit: advancesLimit,
    }), 'manager_advances_targeted', 4200).catch((err) => swallowToEmpty('advances_targeted', err)),
    withArkaTimeout(listCashHandoffRecords({
      select: MANAGER_HANDOFF_SELECT,
      in: { worker_pin: uniquePins },
      orderBy: 'submitted_at',
      ascending: false,
      limit: handoffsLimit,
    }), 'manager_handoffs', 4200).catch((err) => swallowToEmpty('handoffs', err)),
  ]);

  for (const row of Array.isArray(paymentRows) ? paymentRows : []) {
    pushRowToGroup(paymentsByPin, row?.created_by_pin, row);
  }
  for (const row of Array.isArray(extraCreatedRows) ? extraCreatedRows : []) {
    pushRowToGroup(extrasByPin, row?.created_by_pin, row);
  }
  for (const row of Array.isArray(extraTargetedRows) ? extraTargetedRows : []) {
    if (['MEAL_PAYMENT', 'MEAL_COVERED'].includes(typeOf(row))) continue;
    pushRowToGroup(extrasByPin, row?.handed_by_pin, row);
  }
  for (const row of Array.isArray(advanceCreatedRows) ? advanceCreatedRows : []) {
    pushRowToGroup(advancesByPin, row?.created_by_pin, row);
  }
  for (const row of Array.isArray(advanceTargetedRows) ? advanceTargetedRows : []) {
    pushRowToGroup(advancesByPin, row?.handed_by_pin, row);
  }
  for (const row of Array.isArray(handoffRows) ? handoffRows : []) {
    pushRowToGroup(handoffsByPin, row?.worker_pin, row);
  }

  return { paymentsByPin, extrasByPin, handoffsByPin, advancesByPin, hadErrors };
}
function isRealPaymentRow(row) {
  const type = typeOf(row);
  const status = statusOf(row);
  if (EXTRA_TYPES.has(type)) return false;
  if (NON_PAYMENT_STATUSES.has(status)) return false;
  return ['PENDING', 'COLLECTED'].includes(status);
}

function isAcceptedPaymentHistoryRow(row) {
  const type = typeOf(row);
  const status = statusOf(row);
  if (EXTRA_TYPES.has(type)) return false;
  if (['REJECTED', 'REFUZUAR', 'OWED', 'WORKER_DEBT', 'ADVANCE'].includes(status)) return false;
  return ['ACCEPTED_BY_DISPATCH', 'APPROVED', 'ACCEPTED'].includes(status);
}
function isOpenExtraRow(row) {
  const type = typeOf(row);
  const status = statusOf(row);
  if (!EXTRA_TYPES.has(type)) return false;
  if (['REJECTED', 'REFUZUAR'].includes(status)) return false;
  if (isExtraSettled(row)) return false;
  return true;
}
function getHybridCommission(worker) {
  return n(worker?.hybrid_commission_today ?? worker?.hybrid_commission ?? worker?.commission_amount ?? 0);
}
function summarizeArkaCore({ worker, paymentRows = [], extraRows = [], handoffRows = [], advanceRows = [], transportOrdersById = {} }) {
  const uniquePaymentRows = mapUniqueById(paymentRows);
  const payments = uniquePaymentRows.filter(isRealPaymentRow).sort(byDateDesc);
  const acceptedPaymentRows = uniquePaymentRows.filter(isAcceptedPaymentHistoryRow).sort(byDateDesc);
  const pendingRows = payments.filter((row) => statusOf(row) === 'PENDING');
  const collectedRows = payments.filter((row) => statusOf(row) === 'COLLECTED');
  const dispatchOpenRows = [...collectedRows, ...pendingRows];
  const rawCashBreakdownRows = (Array.isArray(dispatchOpenRows) ? dispatchOpenRows : []).map((row) => buildCashBreakdownRow(row, worker, { transportOrdersById }));
  const cashBreakdownDedupe = dedupeCashBreakdownTransportRows(rawCashBreakdownRows);
  const cashBreakdownRows = cashBreakdownDedupe.rows.sort(byDateDesc);
  const acceptedCashBreakdownRows = buildCashBreakdownRows(acceptedPaymentRows, worker, { transportOrdersById }).sort(byDateDesc);
  const paymentTotal = payments.reduce((sum, row) => sum + amountOf(row), 0);
  const pendingTotal = pendingRows.reduce((sum, row) => sum + amountOf(row), 0);
  const collectedTotal = collectedRows.reduce((sum, row) => sum + amountOf(row), 0);
  const collectedGrossTotal = collectedRows.reduce((sum, row) => sum + amountOf(row), 0);
  const dispatchGrossTotal = sumCashField(cashBreakdownRows, 'gross');
  const acceptedGrossTotal = sumCashField(acceptedCashBreakdownRows, 'gross');
  const acceptedBaseTotal = sumCashField(acceptedCashBreakdownRows, 'baseAmount');
  const acceptedCommissionTotal = sumCashField(acceptedCashBreakdownRows, 'commission');
  const commissionHeldTotal = sumCashField(cashBreakdownRows, 'commission');
  const baseCashForDispatchTotal = sumCashField(cashBreakdownRows, 'baseAmount');

  const allExtraRows = mapUniqueById(extraRows).sort(byDateDesc);
  const extras = allExtraRows.filter(isOpenExtraRow).sort(byDateDesc);
  const timaRows = extras.filter((row) => typeOf(row) === 'TIMA' && statusOf(row) === 'ACCEPTED_BY_DISPATCH');
  const expenseRows = extras.filter((row) => typeOf(row) === 'EXPENSE');
  const mealPaymentRows = extras.filter((row) => typeOf(row) === 'MEAL_PAYMENT');
  const mealCoveredRows = extras.filter((row) => typeOf(row) === 'MEAL_COVERED');

  const timaTotal = timaRows.reduce((sum, row) => sum + amountOf(row), 0);
  const expenseTotal = expenseRows.reduce((sum, row) => sum + amountOf(row), 0);
  const mealTotal = mealPaymentRows.reduce((sum, row) => sum + amountOf(row), 0);
  const hybridCommission = getHybridCommission(worker);

  const handoffs = mapUniqueById(handoffRows).sort(byDateDesc);
  const deliveredRows = handoffs.filter((row) => isAcceptedHandoffStatus(row?.status));
  const pendingHandoffRows = handoffs.filter((row) => isPendingHandoffStatus(row?.status));
  const deliveredTodayRows = deliveredRows.filter((row) => isToday(row?.decided_at || row?.accepted_at || row?.submitted_at || row?.created_at));
  const deliveredTotal = deliveredRows.reduce((sum, row) => sum + amountOf(row), 0);
  const deliveredTodayTotal = deliveredTodayRows.reduce((sum, row) => sum + amountOf(row), 0);
  const pendingHandoffTotal = pendingHandoffRows.reduce((sum, row) => sum + buildHandoffReview(row, worker).baseTotal, 0);

  const advances = mapUniqueById(advanceRows)
    .filter((row) => statusOf(row) === 'ADVANCE')
    .sort(byDateDesc);
  const advanceTotal = advances.reduce((sum, row) => sum + amountOf(row), 0);

  const cashFromClientsTotal = dispatchGrossTotal;
  const visiblePaidHistoryTotal = +(dispatchGrossTotal + acceptedGrossTotal).toFixed(2);
  const visibleBaseHistoryTotal = +(baseCashForDispatchTotal + acceptedBaseTotal).toFixed(2);
  const visibleCommissionHistoryTotal = +(commissionHeldTotal + acceptedCommissionTotal).toFixed(2);
  const workerExpenseTotal = expenseTotal + mealTotal;
  const handedCashTotal = pendingHandoffTotal;
  const remainingToHandover = Math.max(0, baseCashForDispatchTotal);

  const dueTotal = baseCashForDispatchTotal;
  const hasTodayBasePayment = payments.some((row) => isBelgradeToday(row?.created_at));

  let status = 'PA LËVIZJE';
  let tone = 'idle';
  if (pendingHandoffRows.length) {
    status = 'DËRGUAR TE DISPATCH';
    tone = 'warn';
  } else if (remainingToHandover > 0) {
    status = 'CASH NË DORË';
    tone = 'info';
  } else if (deliveredTodayTotal > 0) {
    status = 'PRANUAR SOT';
    tone = 'ok';
  }

  return {
    worker,
    paymentRows: payments,
    pendingRows,
    collectedRows,
    acceptedPaymentRows,
    acceptedCashBreakdownRows,
    acceptedGrossTotal,
    acceptedBaseTotal,
    acceptedCommissionTotal,
    acceptedPaymentCount: acceptedPaymentRows.length,
    visiblePaidHistoryTotal,
    visibleBaseHistoryTotal,
    visibleCommissionHistoryTotal,
    cashBreakdownRows,
    cashDuplicateTransportCount: cashBreakdownDedupe.duplicateCount,
    cashDuplicateTransportKeys: cashBreakdownDedupe.duplicateKeys,
    allExtraRows,
    extraRows: extras,
    timaRows,
    expenseRows,
    mealPaymentRows,
    mealCoveredRows,
    handoffRows: handoffs,
    deliveredRows,
    deliveredTodayRows,
    pendingHandoffRows,
    advanceRows: advances,
    paymentTotal,
    pendingTotal,
    collectedTotal,
    collectedGrossTotal,
    commissionHeldTotal,
    baseCashForDispatchTotal,
    timaTotal,
    expenseTotal,
    mealTotal,
    deliveredTotal,
    deliveredTodayTotal,
    pendingHandoffTotal,
    advanceTotal,
    cashFromClientsTotal,
    workerExpenseTotal,
    handedCashTotal,
    remainingToHandover,
    hybridCommission,
    dueTotal,
    hasTodayBasePayment,
    status,
    tone,
  };
}

function ArkaPanelBoundary({ name, children }) {
  return (
    <LocalErrorBoundary
      boundaryKind="panel"
      routePath="/arka"
      routeName="ARKA"
      moduleName={name}
      componentName={name}
      sourceLayer="arka_panel"
      showHome={false}
    >
      {children}
    </LocalErrorBoundary>
  );
}

function Stat({ label, value, tone = 'neutral', small = false, sub = '' }) {
  return (
    <div className={`arkaMiniStat ${tone} ${small ? 'small' : ''}`}>
      <div className="arkaMiniStatLabel">{label}</div>
      <div className="arkaMiniStatValue">{value}</div>
      {sub ? <div className="arkaMiniStatSub">{sub}</div> : null}
    </div>
  );
}

function HistoryRow({ title, meta, amount, tone = 'neutral', rightText = '' }) {
  return (
    <div className="arkaHistoryRow">
      <div>
        <div className="arkaHistoryTitle">{title}</div>
        <div className="arkaHistoryMeta">{meta}</div>
      </div>
      <div style={{ textAlign: 'right' }}>
        <div className="arkaHistoryAmount">{amount}</div>
        {rightText ? <div className={`arkaHistoryMeta ${tone}`}>{rightText}</div> : null}
      </div>
    </div>
  );
}


function formatHistoryDateKey(dateKey = '') {
  const clean = String(dateKey || '').slice(0, 10);
  const parts = clean.split('-');
  if (parts.length !== 3) return clean || '—';
  return `${parts[2]}.${parts[1]}.${parts[0]}`;
}

function dateInputFromBelgradeKey(dateKey = '') {
  const clean = String(dateKey || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(clean) ? clean : formatBelgradeDateKey(new Date());
}

function addDaysToDateKey(dateKey = '', days = 0) {
  try {
    const clean = dateInputFromBelgradeKey(dateKey);
    const [y, m, d] = clean.split('-').map((x) => Number(x));
    const next = new Date(Date.UTC(y, m - 1, d + Number(days || 0), 12, 0, 0));
    return next.toISOString().slice(0, 10);
  } catch {
    return formatBelgradeDateKey(new Date());
  }
}

function belgradeDayBoundsFromDateKey(dateKey = '') {
  try {
    const clean = dateInputFromBelgradeKey(dateKey);
    const [y, m, d] = clean.split('-').map((x) => Number(x));
    if (!y || !m || !d) throw new Error('bad_history_date');
    const startMs = zonedLocalToUtcMs(PAYMENT_TIME_ZONE, y, m, d, 0, 0, 0);
    const endMs = zonedLocalToUtcMs(PAYMENT_TIME_ZONE, y, m, d + 1, 0, 0, 0);
    return {
      dateKey: clean,
      startIso: new Date(startMs).toISOString(),
      endIso: new Date(endMs).toISOString(),
    };
  } catch {
    return belgradeDayBoundsIso(new Date());
  }
}

function parseM2FromNote(note = '') {
  const raw = String(note || '');
  if (!raw) return 0;
  const matches = Array.from(raw.matchAll(/([0-9]+(?:[.,][0-9]+)?)\s*(?:m²|m2|m\^2)/gi));
  if (!matches.length) return 0;
  const last = matches[matches.length - 1]?.[1];
  const value = Number(String(last || '').replace(',', '.'));
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function historyTransportM2(row = {}) {
  return firstPositiveNumber(
    row?.transport_m2,
    row?.transportM2,
    row?.m2,
    row?.m2_total,
    row?.total_m2,
    row?.data?.m2,
    row?.data?.m2_total,
    row?.data?.total_m2,
    row?.pay?.m2,
    row?.data?.pay?.m2,
    parseM2FromNote(row?.note),
    parseM2FromNote(row?.data?.note),
    parseM2FromNote(row?.pay?.note),
    parseM2FromNote(row?.data?.pay?.note)
  );
}

function historyPaymentWorkerPin(row = {}) {
  const type = typeOf(row);
  if (['MEAL_COVERED', 'ADVANCE'].includes(type) && String(row?.handed_by_pin || '').trim()) {
    return String(row.handed_by_pin || '').trim();
  }
  return String(row?.created_by_pin || row?.handed_by_pin || row?.worker_pin || '').trim();
}

function historyPaymentWorkerName(row = {}) {
  const type = typeOf(row);
  if (['MEAL_COVERED', 'ADVANCE'].includes(type) && String(row?.handed_by_name || '').trim()) {
    return String(row.handed_by_name || '').trim();
  }
  return String(row?.created_by_name || row?.handed_by_name || row?.worker_name || row?.approved_by_name || '').trim();
}

function historyWorkerNameFromMap(pin, workerMap = {}) {
  const cleanPin = String(pin || '').trim();
  const worker = workerMap?.[cleanPin];
  return String(worker?.name || worker?.worker_name || worker?.created_by_name || cleanPin || 'PUNTORI').trim();
}

function historyTypeLabel(type = '') {
  const t = safeUpper(type);
  if (t === 'EXPENSE') return 'SHPENZIM';
  if (t === 'MEAL_PAYMENT') return 'USHQIM';
  if (t === 'MEAL_COVERED') return 'USHQIM I MBULUAR';
  if (t === 'ADVANCE') return 'AVANS';
  if (t === 'TIMA') return 'TIMA';
  return t || 'PAGESË';
}

function historyStatusLabel(status = '') {
  const s = safeUpper(status);
  if (s === 'PENDING') return 'NË PRITJE';
  if (s === 'COLLECTED') return 'NË DORËZIM';
  if (s === 'PENDING_DISPATCH_APPROVAL') return 'DËRGUAR TE DISPATCH';
  if (s === 'ACCEPTED_BY_DISPATCH' || s === 'ACCEPTED') return 'PRANUAR';
  if (s === 'REJECTED' || s === 'REFUZUAR') return 'REFUZUAR';
  if (s === 'CONVERTED_TO_ADVANCE') return 'U KTHYE NË AVANS';
  if (s === 'ADVANCE') return 'AVANS';
  if (s === 'CANCELLED') return 'ANULUAR';
  return s || '—';
}

function isHistoryClientPayment(row = {}) {
  const type = typeOf(row);
  if (['EXPENSE', 'MEAL_PAYMENT', 'MEAL_COVERED', 'ADVANCE', 'TIMA'].includes(type)) return false;
  return amountOf(row) > 0;
}

function isHistoryExpenseRow(row = {}) {
  return ['EXPENSE', 'MEAL_PAYMENT', 'MEAL_COVERED', 'ADVANCE'].includes(typeOf(row));
}

function isHistoryMealRow(row = {}) {
  return isMealLikeRow(row) || ['MEAL_PAYMENT', 'MEAL_COVERED'].includes(typeOf(row));
}

function buildHistoryPaymentLine(row = {}, worker = {}) {
  const gross = +amountOf(row).toFixed(2);
  const sourceModule = cashSourceModule(row);
  const isTransport = sourceModule === 'TRANSPORT';
  const m2 = isTransport ? historyTransportM2(row) : 0;
  const rate = workerCommissionRateM2(worker);
  const commission = isTransport && isHybridWorker(worker) ? Math.min(gross, +(m2 * rate).toFixed(2)) : 0;
  const baseAmount = Math.max(0, +(gross - commission).toFixed(2));
  return {
    raw: row,
    id: row?.id || `${cashOrderCode(row)}_${row?.created_at || gross}`,
    code: cashOrderCode(row),
    clientName: cashClientName(row),
    gross,
    m2,
    commission,
    baseAmount,
    status: statusOf(row),
    created_at: row?.created_at || row?.updated_at || null,
    sourceModule,
  };
}

function buildArkaHistoryGroups({ payments = [], handoffs = [], workersByPin = {}, targetPin = 'ALL' }) {
  const paymentRows = Array.isArray(payments) ? payments : [];
  const handoffRows = Array.isArray(handoffs) ? handoffs : [];
  const groupPins = new Set();

  if (String(targetPin || '').trim() && String(targetPin || '').trim() !== 'ALL') groupPins.add(String(targetPin || '').trim());
  for (const row of paymentRows) {
    const pin = historyPaymentWorkerPin(row);
    if (pin) groupPins.add(pin);
  }
  for (const row of handoffRows) {
    const pin = String(row?.worker_pin || '').trim();
    if (pin) groupPins.add(pin);
  }
  if (!groupPins.size && String(targetPin || '').trim() !== 'ALL') groupPins.add(String(targetPin || '').trim());

  const groups = [...groupPins].filter(Boolean).map((pin) => {
    const worker = workersByPin?.[pin] || { pin, name: historyWorkerNameFromMap(pin, workersByPin) };
    const clientPayments = paymentRows
      .filter((row) => historyPaymentWorkerPin(row) === pin)
      .filter(isHistoryClientPayment)
      .map((row) => buildHistoryPaymentLine(row, worker))
      .sort(byDateDesc);
    const expenses = paymentRows
      .filter((row) => historyPaymentWorkerPin(row) === pin)
      .filter(isHistoryExpenseRow)
      .sort(byDateDesc);
    const meals = paymentRows
      .filter((row) => historyPaymentWorkerPin(row) === pin)
      .filter(isHistoryMealRow)
      .sort(byDateDesc);
    const workerHandoffs = handoffRows
      .filter((row) => String(row?.worker_pin || '').trim() === pin)
      .sort(byDateDesc);

    const grossTotal = +clientPayments.reduce((sum, row) => sum + n(row?.gross), 0).toFixed(2);
    const commissionTotal = +clientPayments.reduce((sum, row) => sum + n(row?.commission), 0).toFixed(2);
    const baseTotal = +clientPayments.reduce((sum, row) => sum + n(row?.baseAmount), 0).toFixed(2);
    const expenseTotal = +expenses.filter((row) => typeOf(row) !== 'MEAL_COVERED').reduce((sum, row) => sum + amountOf(row), 0).toFixed(2);
    const mealTotal = +meals.reduce((sum, row) => sum + amountOf(row), 0).toFixed(2);
    const handoffTotal = +workerHandoffs.reduce((sum, row) => sum + amountOf(row), 0).toFixed(2);
    const openCashTotal = +clientPayments.filter((row) => ['PENDING', 'COLLECTED'].includes(safeUpper(row?.status))).reduce((sum, row) => sum + n(row?.baseAmount), 0).toFixed(2);
    const openExpenseTotal = +expenses.filter((row) => ['PENDING', 'COLLECTED'].includes(statusOf(row))).reduce((sum, row) => sum + amountOf(row), 0).toFixed(2);
    const pendingCount = paymentRows.filter((row) => historyPaymentWorkerPin(row) === pin && statusOf(row) === 'PENDING').length;
    const collectedCount = paymentRows.filter((row) => historyPaymentWorkerPin(row) === pin && statusOf(row) === 'COLLECTED').length;
    let dayStatus = 'PA LËVIZJE';
    if (pendingCount || collectedCount || openCashTotal > 0 || openExpenseTotal > 0) dayStatus = 'KA TË HAPURA';
    if (workerHandoffs.some((row) => isAcceptedHandoffStatus(row?.status))) dayStatus = openCashTotal > 0 || openExpenseTotal > 0 ? 'PJESËRISHT PRANUAR' : 'PRANUAR';
    if (workerHandoffs.some((row) => isPendingHandoffStatus(row?.status))) dayStatus = 'DËRGUAR TE DISPATCH';

    return {
      pin,
      worker,
      isHybrid: isHybridWorker(worker),
      clientPayments,
      expenses,
      meals,
      handoffs: workerHandoffs,
      totals: {
        grossTotal,
        commissionTotal,
        baseTotal,
        expenseTotal,
        mealTotal,
        handoffTotal,
        openCashTotal,
        openExpenseTotal,
        pendingCount,
        collectedCount,
        dayStatus,
      },
    };
  });

  groups.sort((a, b) => String(a?.worker?.name || '').localeCompare(String(b?.worker?.name || '')));
  return groups;
}

function HistoryMetricLine({ label, value }) {
  return (
    <div className="arkaHistoryRow" style={{ padding: '8px 0', borderBottom: '1px solid rgba(255,255,255,.06)' }}>
      <div className="arkaHistoryMeta">{label}</div>
      <div className="arkaHistoryAmount">{value}</div>
    </div>
  );
}

function ArkaHistoryGroup({ group }) {
  const workerName = String(group?.worker?.name || group?.pin || 'PUNTORI').toUpperCase();
  const totals = group?.totals || {};
  return (
    <section className="arkaSectionCard" style={{ display: 'grid', gap: 12 }}>
      <div className="arkaSectionHeadCompact">
        <div>
          <div className="arkaSectionTitle">{workerName}</div>
          <div className="arkaSectionSub">PIN {group?.pin || '—'} • {totals.dayStatus || 'PA LËVIZJE'}</div>
        </div>
        <div className="arkaCashTotalPill">{euro(group?.isHybrid ? totals.baseTotal : totals.grossTotal)}</div>
      </div>

      <div className="arkaSectionCard" style={{ margin: 0, padding: 12, background: 'rgba(15,23,42,.45)' }}>
        <div className="arkaSectionTitle">PËRMBLEDHJE</div>
        {group?.isHybrid ? (
          <>
            <HistoryMetricLine label="Cash bruto nga klientët" value={euro(totals.grossTotal)} />
            <HistoryMetricLine label="Komisioni im" value={euro(totals.commissionTotal)} />
            <HistoryMetricLine label="Për bazë" value={euro(totals.baseTotal)} />
          </>
        ) : (
          <>
            <HistoryMetricLine label="Cash i marrë" value={euro(totals.grossTotal)} />
            <HistoryMetricLine label="Cash për dorëzim" value={euro(totals.baseTotal || totals.grossTotal)} />
          </>
        )}
        <HistoryMetricLine label="Shpenzime" value={euro(totals.expenseTotal)} />
        <HistoryMetricLine label="Ushqim" value={group?.meals?.length ? `REGJISTRUAR • ${euro(totals.mealTotal)}` : 'NUK KA'} />
        <HistoryMetricLine label="Dorëzime te dispatch" value={euro(totals.handoffTotal)} />
        <HistoryMetricLine label="Status i ditës" value={totals.dayStatus || '—'} />
      </div>

      <div>
        <div className="arkaSectionTitle">KLIENTËT / PAGESAT</div>
        {group?.clientPayments?.length ? group.clientPayments.map((row) => (
          <HistoryRow
            key={`hist_pay_${group.pin}_${row.id}`}
            title={`${String(row.code || '—').toUpperCase()} — ${String(row.clientName || 'KLIENT').toUpperCase()}`}
            meta={`${fmtPaymentStamp(row.created_at) || fmtDate(row.created_at)} • ${row.m2 > 0 ? `${MONEY.format(row.m2)} m² • ` : ''}${historyStatusLabel(row.status)}`}
            amount={euro(group?.isHybrid ? row.baseAmount : row.gross)}
            rightText={group?.isHybrid ? `BRUTO ${euro(row.gross)}${row.commission > 0 ? ` • KOM ${euro(row.commission)}` : ''}` : historyStatusLabel(row.status)}
            tone={['ACCEPTED_BY_DISPATCH', 'ACCEPTED'].includes(safeUpper(row.status)) ? 'ok' : ['PENDING', 'COLLECTED'].includes(safeUpper(row.status)) ? 'warn' : 'neutral'}
          />
        )) : <div className="arkaEmpty">S’KA KLIENTË / PAGESA PËR KËTË DATË.</div>}
      </div>

      <div>
        <div className="arkaSectionTitle">DORËZIMET TE DISPATCH</div>
        {group?.handoffs?.length ? group.handoffs.map((row) => (
          <HistoryRow
            key={`hist_handoff_${group.pin}_${row.id}`}
            title={`HANDOFF #${row?.id || '—'}`}
            meta={`DËRGUAR: ${fmtPaymentStamp(row?.submitted_at) || fmtDate(row?.submitted_at)} • VENDOSUR: ${fmtPaymentStamp(row?.decided_at) || fmtDate(row?.decided_at)}${row?.accepted_by_name ? ` • ${String(row.accepted_by_name).toUpperCase()}` : ''}${row?.company_ledger_entry_id ? ` • LEDGER #${row.company_ledger_entry_id}` : ''}`}
            amount={euro(row?.amount)}
            rightText={historyStatusLabel(row?.status)}
            tone={isAcceptedHandoffStatus(row?.status) ? 'ok' : isPendingHandoffStatus(row?.status) ? 'warn' : 'neutral'}
          />
        )) : <div className="arkaEmpty">S’KA DORËZIME PËR KËTË DATË.</div>}
      </div>

      <div>
        <div className="arkaSectionTitle">SHPENZIMET</div>
        {group?.expenses?.length ? group.expenses.map((row) => (
          <HistoryRow
            key={`hist_exp_${group.pin}_${row.id}`}
            title={`${historyTypeLabel(row?.type)} — ${historyStatusLabel(row?.status)}`}
            meta={`${fmtPaymentStamp(row?.created_at) || fmtDate(row?.created_at)} • ${cleanWorkerExpenseNote(row).toUpperCase()}${row?.approved_by_name ? ` • ${String(row.approved_by_name).toUpperCase()}` : ''}${row?.handoff_note ? ` • ${String(row.handoff_note).toUpperCase()}` : ''}`}
            amount={euro(row?.amount)}
            rightText={historyTypeLabel(row?.type)}
            tone={statusOf(row) === 'ACCEPTED_BY_DISPATCH' ? 'ok' : ['PENDING', 'COLLECTED'].includes(statusOf(row)) ? 'warn' : 'neutral'}
          />
        )) : <div className="arkaEmpty">S’KA SHPENZIME PËR KËTË DATË.</div>}
      </div>

      <div>
        <div className="arkaSectionTitle">USHQIMI</div>
        {group?.meals?.length ? group.meals.map((row) => (
          <HistoryRow
            key={`hist_meal_${group.pin}_${row.id}`}
            title="REGJISTRUAR"
            meta={`${fmtPaymentStamp(row?.created_at) || fmtDate(row?.created_at)} • ${cleanExpenseRequestBaseNote(row?.note || '') || row?.note || 'USHQIM'}`}
            amount={euro(row?.amount)}
            rightText={historyStatusLabel(row?.status)}
            tone={statusOf(row) === 'ACCEPTED_BY_DISPATCH' ? 'ok' : 'warn'}
          />
        )) : <div className="arkaEmpty">Nuk ka ushqim të regjistruar për këtë datë.</div>}
      </div>

      <div className="arkaSectionCard" style={{ margin: 0, padding: 12, background: 'rgba(245,158,11,.06)', borderColor: 'rgba(245,158,11,.22)' }}>
        <div className="arkaSectionTitle">ÇKA KA MBETUR HAPUR</div>
        <HistoryMetricLine label="PENDING" value={String(totals.pendingCount || 0)} />
        <HistoryMetricLine label="COLLECTED" value={String(totals.collectedCount || 0)} />
        <HistoryMetricLine label="Cash i pa dorëzuar" value={euro(totals.openCashTotal)} />
        <HistoryMetricLine label="Shpenzime të papranuara" value={euro(totals.openExpenseTotal)} />
        <HistoryMetricLine label="Bllokon payroll" value={(totals.openCashTotal > 0 || totals.openExpenseTotal > 0 || (totals.pendingCount || 0) > 0 || (totals.collectedCount || 0) > 0) ? 'PO' : 'JO'} />
      </div>
    </section>
  );
}

function ArkaHistoryPanel({
  canManage = false,
  actor = null,
  dateKey = '',
  selectedWorkerPin = 'ALL',
  workerOptions = [],
  loading = false,
  error = '',
  groups = [],
  datePickerOpen = false,
  onSetDateKey = () => {},
  onSetSelectedWorkerPin = () => {},
  onToggleDatePicker = () => {},
}) {
  const todayKey = formatBelgradeDateKey(new Date());
  const yesterdayKey = addDaysToDateKey(todayKey, -1);
  const title = canManage ? 'HISTORIA E ARKËS' : 'HISTORIA IME';
  const ownerLine = canManage ? '' : `${String(actor?.name || 'PUNTORI').trim()} • PIN ${String(actor?.pin || '—').trim()}`;
  return (
    <div className="arkaSectionCard" style={{ display: 'grid', gap: 12 }}>
      <div className="arkaSectionHeadCompact">
        <div>
          <div className="arkaSectionTitle">{title}</div>
          {ownerLine ? <div className="arkaSectionSub">{ownerLine}</div> : null}
        </div>
        <div className="arkaCashTotalPill">{formatHistoryDateKey(dateKey)}</div>
      </div>

      <div className="arkaActionPanel" style={{ margin: 0 }}>
        <div className="arkaWorkerFoot" style={{ gap: 8, flexWrap: 'wrap' }}>
          <span>DATA: {formatHistoryDateKey(dateKey)}</span>
          <button type="button" className="arkaTopBtn" onClick={() => onSetDateKey(todayKey)}>SOT</button>
          <button type="button" className="arkaTopBtn" onClick={() => onSetDateKey(yesterdayKey)}>DJE</button>
          <button type="button" className="arkaTopBtn" onClick={onToggleDatePicker}>ZGJIDH DATËN</button>
        </div>
        {datePickerOpen ? (
          <input
            className="arkaField"
            type="date"
            value={dateInputFromBelgradeKey(dateKey)}
            onChange={(e) => onSetDateKey(e.target.value)}
            style={{ marginTop: 10 }}
          />
        ) : null}
        {canManage ? (
          <div className="arkaWorkerFoot" style={{ gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
            <span>PUNËTORI: {selectedWorkerPin === 'ALL' ? 'TË GJITHË' : String(workerOptions.find((row) => String(row?.pin || '') === String(selectedWorkerPin))?.name || selectedWorkerPin).toUpperCase()}</span>
            <button type="button" className="arkaTopBtn" onClick={() => onSetSelectedWorkerPin('ALL')}>TË GJITHË</button>
            <select className="arkaField" value={selectedWorkerPin === 'ALL' ? '' : selectedWorkerPin} onChange={(e) => onSetSelectedWorkerPin(e.target.value || 'ALL')} style={{ maxWidth: 260 }}>
              <option value="">ZGJIDH PUNËTORIN</option>
              {workerOptions.map((row) => (
                <option key={String(row?.pin || row?.id || row?.name)} value={String(row?.pin || '')}>{String(row?.name || row?.pin || 'PUNTORI').toUpperCase()}</option>
              ))}
            </select>
          </div>
        ) : null}
      </div>

      {loading ? <div className="arkaEmpty">PO NGARKOHET HISTORIA...</div> : null}
      {error ? <div className="arkaError">{error}</div> : null}
      {!loading && !error && groups.length ? groups.map((group) => <ArkaHistoryGroup key={`hist_group_${group.pin}`} group={group} />) : null}
      {!loading && !error && !groups.length ? <div className="arkaEmpty">S’KA HISTORI PËR KËTË DATË.</div> : null}
    </div>
  );
}

function cashRowDue(row = {}) {
  return n(row?.baseAmount ?? row?.dueToBase ?? row?.amount);
}
function cashRowGross(row = {}) {
  return n(row?.gross ?? row?.amount);
}
function cashRowCommission(row = {}) {
  return n(row?.commission ?? 0);
}
function CashClientCompactRow({ row = {}, workerName = 'PUNTORI', mini = false }) {
  const code = String(row?.code || cashOrderCode(row?.raw || row) || '—').toUpperCase();
  const name = String(row?.clientName || row?.client_name || 'KLIENT').toUpperCase();
  const due = cashRowDue(row);
  const gross = cashRowGross(row);
  const commission = cashRowCommission(row);
  const typeLabel = String(row?.typeLabel || row?.type || 'CASH').toUpperCase();
  const paidStamp = fmtPaymentStamp(
    row?.created_at ||
    row?.firstCreatedAt ||
    row?.lastCreatedAt ||
    row?.raw?.created_at
  );
  const handedStamp = fmtPaymentStamp(
    row?.handed_at ||
    row?.raw?.handed_at
  );
  return (
    <details className={`arkaCashCompactRow ${mini ? 'mini' : ''}`}>
      <summary className="arkaCashCompactSummary">
        <span className="arkaCashCode">{code}</span>
        <span className="arkaCashNameWrap">
          <span className="arkaCashName">{name}</span>
          {paidStamp ? <span className="arkaCashStamp">PAGUAR: {paidStamp}</span> : null}
          {handedStamp ? <span className="arkaCashStamp">DORËZUAR: {handedStamp}</span> : null}
        </span>
        <span className="arkaCashAmount">{euro(due)}</span>
      </summary>
      <div className="arkaCashCompactDetails">
        <span>{typeLabel}</span>
        <span>KLIENTI: {euro(gross)}</span>
        {commission > 0 ? <span>{String(workerName || 'PUNTORI').toUpperCase()}: {euro(commission)}</span> : null}
        <span>PËR BAZË: {euro(due)}</span>
      </div>
    </details>
  );
}

function handoffClientRows(row = {}) {
  const direct = Array.isArray(row?.client_items) ? row.client_items : [];
  if (direct.length) return direct;
  const items = Array.isArray(row?.cash_handoff_items) ? row.cash_handoff_items : [];
  return items.map((item) => ({
    id: item?.id || item?.pending_payment_id || `${row?.id || ''}_${item?.order_code || item?.transport_code_str || ''}`,
    client_name: String(item?.client_name || item?.note || 'KLIENT').trim(),
    code: String(item?.transport_code_str || item?.order_code || '—').trim().toUpperCase() || '—',
    amount: amountOf(item),
  }));
}


function handoffItemMatchKeys(item = {}) {
  return [
    item?.pending_payment_id,
    item?.pendingPaymentId,
    item?.id,
    item?.transport_code_str,
    item?.transportCodeStr,
    item?.order_code,
    item?.code,
  ]
    .map((value) => String(value || '').replace(/^#/, '').trim().toUpperCase())
    .filter(Boolean);
}

function handoffGrossCandidate(item = {}) {
  return firstPositiveNumber(
    item?.pending_payment_amount,
    item?.pendingPaymentAmount,
    item?.payment_amount,
    item?.paymentAmount,
    item?.gross_amount,
    item?.grossAmount,
    item?.gross,
    item?.client_paid_amount,
    item?.clientPaidAmount,
    item?.paid_amount,
    item?.paidAmount,
    item?.pending_payment?.amount,
    item?.pendingPayment?.amount,
    item?.payment?.amount,
    item?.arka_pending_payment?.amount
  );
}


function normalizeHandoffTransportCode(value) {
  const raw = String(value || '').replace(/#/g, '').trim().toUpperCase();
  return /^T\d+$/.test(raw) ? raw : '';
}

function handoffTransportDedupeKey(item = {}) {
  const source = handoffItemSource(item);
  const id = String(item?.transport_order_id || item?.transportOrderId || item?.transport_id || item?.transportId || '').trim();
  const code = normalizeHandoffTransportCode(
    item?.transport_code_str ||
    item?.transportCodeStr ||
    item?.transport_code ||
    item?.transportCode ||
    item?.client_tcode ||
    item?.tcode ||
    item?.code ||
    item?.order_code
  );
  const isTransport = source === 'TRANSPORT' || Boolean(id) || Boolean(code);
  if (!isTransport) return '';
  if (id) return `transport_order_id:${id}`;
  if (code) return `transport_code:${code}`;
  return '';
}

function handoffItemPendingPaymentId(item = {}) {
  return String(item?.pending_payment_id || item?.pendingPaymentId || '').trim();
}

function preferHandoffDedupeItem(current = {}, candidate = {}) {
  const currentHasPending = Boolean(handoffItemPendingPaymentId(current));
  const candidateHasPending = Boolean(handoffItemPendingPaymentId(candidate));
  if (candidateHasPending && !currentHasPending) return candidate;
  if (!candidateHasPending && currentHasPending) return current;
  const currentId = Number(current?.id || 0) || 0;
  const candidateId = Number(candidate?.id || 0) || 0;
  if (candidateId > currentId) return candidate;
  return current;
}

function dedupeHandoffTransportItems(items = []) {
  const source = Array.isArray(items) ? items : [];
  const output = [];
  const indexByKey = new Map();
  const duplicateKeys = new Set();
  let rawTransportAmount = 0;
  let dedupedTransportAmount = 0;

  source.forEach((item) => {
    const key = handoffTransportDedupeKey(item);
    if (!key) {
      output.push(item);
      return;
    }

    rawTransportAmount += amountOf(item);
    if (!indexByKey.has(key)) {
      indexByKey.set(key, output.length);
      output.push(item);
      return;
    }

    duplicateKeys.add(key);
    const existingIndex = indexByKey.get(key);
    const existing = output[existingIndex];
    output[existingIndex] = preferHandoffDedupeItem(existing, item);
  });

  for (const item of output) {
    if (handoffTransportDedupeKey(item)) dedupedTransportAmount += amountOf(item);
  }

  return {
    items: output,
    duplicateCount: Math.max(0, source.length - output.length),
    duplicateKeys: [...duplicateKeys],
    rawCount: source.length,
    dedupedCount: output.length,
    rawTransportAmount: +rawTransportAmount.toFixed(2),
    dedupedTransportAmount: +dedupedTransportAmount.toFixed(2),
    duplicateAmount: +Math.max(0, rawTransportAmount - dedupedTransportAmount).toFixed(2),
  };
}

function handoffMergedItems(row = {}) {
  const items = Array.isArray(row?.cash_handoff_items) ? row.cash_handoff_items : [];
  const clientItems = Array.isArray(row?.client_items) ? row.client_items : [];
  if (items.length && clientItems.length) {
    const clientByKey = new Map();
    for (const client of clientItems) {
      for (const key of handoffItemMatchKeys(client)) {
        if (!clientByKey.has(key)) clientByKey.set(key, client);
      }
    }
    return items.map((item) => {
      const meta = handoffItemMatchKeys(item).map((key) => clientByKey.get(key)).find(Boolean);
      if (!meta) return item;
      const metaGross = handoffGrossCandidate(meta);
      return {
        ...meta,
        ...item,
        client_name: item?.client_name || meta?.client_name,
        code: item?.code || meta?.code,
        pending_payment_amount: metaGross > 0 ? metaGross : item?.pending_payment_amount,
      };
    });
  }
  if (items.length) return items;
  return clientItems;
}

function handoffRawItems(row = {}) {
  return dedupeHandoffTransportItems(handoffMergedItems(row)).items;
}

function handoffItemSource(item = {}) {
  return String(item?.source_module || item?.sourceModule || item?.type || '').trim().toUpperCase();
}

function buildHandoffReview(row = {}, worker = {}) {
  const mergedItems = handoffMergedItems(row);
  const dedupeInfo = dedupeHandoffTransportItems(mergedItems);
  const rawItems = dedupeInfo.items;
  const hasStoredHandoffItems = Array.isArray(row?.cash_handoff_items) && row.cash_handoff_items.length > 0;
  const rate = workerCommissionRateM2(worker);
  const hybrid = isHybridWorker(worker);
  const rows = rawItems.map((item, index) => {
    const sourceModule = handoffItemSource(item);
    const isTransport = sourceModule === 'TRANSPORT' || String(item?.transport_code_str || item?.transportCodeStr || '').trim();
    const m2 = isTransport ? n(item?.transport_m2 || item?.transportM2 || item?.m2 || 0) : 0;
    const rawAmount = amountOf(item);
    const commission = isTransport && hybrid ? Math.max(0, +(m2 * rate).toFixed(2)) : 0;
    return {
      id: item?.id || item?.pending_payment_id || `${row?.id || 'handoff'}_${index}`,
      code: String(item?.transport_code_str || item?.transportCodeStr || item?.order_code || item?.code || '—').trim().toUpperCase() || '—',
      clientName: String(item?.client_name || item?.note || 'KLIENT').trim() || 'KLIENT',
      sourceModule: isTransport ? 'TRANSPORT' : 'BAZË',
      rawAmount,
      m2,
      commission,
      pendingGross: handoffGrossCandidate(item),
    };
  });

  const rawSum = +rows.reduce((sum, x) => sum + n(x.rawAmount), 0).toFixed(2);
  const commissionSum = +rows.reduce((sum, x) => sum + n(x.commission), 0).toFixed(2);
  const handoffAmount = n(row?.amount || row?.total_amount || 0);
  // cash_handoff_items.amount is stored as NET/PËR BAZË for hybrid rows.
  // Treat rows as legacy gross only when gross - commission matches the handoff total.
  const itemAmountsLookGross = !hasStoredHandoffItems && commissionSum > 0 && Math.abs((rawSum - commissionSum) - handoffAmount) <= 0.05;

  const normalizedRows = rows.map((x) => {
    const baseAmount = itemAmountsLookGross ? Math.max(0, +(x.rawAmount - x.commission).toFixed(2)) : +x.rawAmount.toFixed(2);
    const gross = x.pendingGross > 0 ? +x.pendingGross.toFixed(2) : (itemAmountsLookGross ? +x.rawAmount.toFixed(2) : +(baseAmount + x.commission).toFixed(2));
    return { ...x, gross, baseAmount };
  });

  let baseTotal = +normalizedRows.reduce((sum, x) => sum + n(x.baseAmount), 0).toFixed(2);
  let grossTotal = +normalizedRows.reduce((sum, x) => sum + n(x.gross), 0).toFixed(2);
  let totalCommission = +normalizedRows.reduce((sum, x) => sum + n(x.commission), 0).toFixed(2);

  if (!normalizedRows.length) {
    baseTotal = handoffAmount;
    grossTotal = handoffAmount;
    totalCommission = 0;
  }

  return {
    workerName: String(worker?.name || row?.worker_name || row?.worker_pin || 'PUNTOR').toUpperCase(),
    handoffRows: [row],
    clientRows: normalizedRows,
    clientCount: Number(row?.count_clients || normalizedRows.length || 0) || normalizedRows.length,
    grossTotal,
    commissionTotal: totalCommission,
    baseTotal,
    storedHandoffTotal: handoffAmount,
    source: itemAmountsLookGross ? 'GROSS_ITEMS_RECALCULATED' : 'NET_ITEMS',
    hasDuplicateTransportItems: dedupeInfo.duplicateCount > 0,
    duplicateTransportCount: dedupeInfo.duplicateCount,
    duplicateTransportAmount: dedupeInfo.duplicateAmount,
    rawItemCount: dedupeInfo.rawCount,
    dedupedItemCount: dedupeInfo.dedupedCount,
    duplicateTransportKeys: dedupeInfo.duplicateKeys,
  };
}

function buildWorkerHandoffReview(item = {}) {
  const worker = item?.worker || {};
  const handoffRows = Array.isArray(item?.pendingHandoffRows) ? item.pendingHandoffRows : [];
  const parts = handoffRows.map((row) => buildHandoffReview(row, worker));
  const clientRows = parts.flatMap((part) => part.clientRows);
  return {
    workerName: String(worker?.name || worker?.pin || 'PUNTOR').toUpperCase(),
    worker,
    handoffRows,
    clientRows,
    clientCount: clientRows.length || parts.reduce((sum, part) => sum + n(part.clientCount), 0),
    grossTotal: +parts.reduce((sum, part) => sum + n(part.grossTotal), 0).toFixed(2),
    commissionTotal: +parts.reduce((sum, part) => sum + n(part.commissionTotal), 0).toFixed(2),
    baseTotal: +parts.reduce((sum, part) => sum + n(part.baseTotal), 0).toFixed(2),
    storedHandoffTotal: +parts.reduce((sum, part) => sum + n(part.storedHandoffTotal), 0).toFixed(2),
    hasDuplicateTransportItems: parts.some((part) => part?.hasDuplicateTransportItems),
    duplicateTransportCount: parts.reduce((sum, part) => sum + n(part?.duplicateTransportCount), 0),
    duplicateTransportAmount: +parts.reduce((sum, part) => sum + n(part?.duplicateTransportAmount), 0).toFixed(2),
    rawItemCount: parts.reduce((sum, part) => sum + n(part?.rawItemCount), 0),
    dedupedItemCount: parts.reduce((sum, part) => sum + n(part?.dedupedItemCount), 0),
  };
}

function CashAcceptReviewModal({ review, busy = '', onCancel, onConfirm }) {
  if (!review) return null;
  const rows = Array.isArray(review?.clientRows) ? review.clientRows : [];
  return (
    <div className="arkaModalBackdrop" role="dialog" aria-modal="true">
      <div className="arkaCashReviewModal">
        <div className="arkaReviewHead">
          <div>
            <div className="arkaReviewTitle">PRANO CASH NGA {review.workerName}</div>
            <div className="arkaReviewSub">KONTROLL PARA PRANIMIT: SA KLIENTË, SA MORI TAPINI, SA HY NË BAZË.</div>
          </div>
          <button type="button" className="arkaTinyBtn" disabled={!!busy} onClick={onCancel}>MBYLL</button>
        </div>

        <div className="arkaReviewTotals">
          <Stat label="KLIENTË" value={String(review.clientCount || rows.length || 0)} tone="neutral" small />
          <Stat label="KLIENTËT PAGUAN" value={euro(review.grossTotal)} tone="ok" small />
          <Stat label="KOMISIONI" value={euro(review.commissionTotal)} tone="warn" small />
          <Stat label="PËR BAZË" value={euro(review.baseTotal)} tone="strong" small />
        </div>

        {Math.abs(n(review.storedHandoffTotal) - n(review.baseTotal)) > 0.05 ? (
          <div className="arkaReviewWarn">KUJDES: DB handoff amount është {euro(review.storedHandoffTotal)}, por tabela e rillogaritur për bazë është {euro(review.baseTotal)}. PRANIMI DUHET TË PËRDORË PËR BAZË.</div>
        ) : null}
        {review.hasDuplicateTransportItems ? (
          <div className="arkaReviewWarn">U gjet duplicate transport item. Totali është korrigjuar me dedupe: {euro(review.baseTotal)}. Raw: {review.rawItemCount} rreshta • Dedupe: {review.dedupedItemCount}.</div>
        ) : null}

        <div className="arkaReviewTableWrap">
          <table className="arkaReviewTable">
            <thead>
              <tr>
                <th>KODI</th>
                <th>KLIENTI</th>
                <th>KLIENTI PAGOI</th>
                <th>KOMISION</th>
                <th>PËR BAZË</th>
              </tr>
            </thead>
            <tbody>
              {rows.length ? rows.map((r) => (
                <tr key={r.id}>
                  <td>{r.code}</td>
                  <td>{String(r.clientName || 'KLIENT').toUpperCase()}</td>
                  <td>{euro(r.gross)}</td>
                  <td>{euro(r.commission)}</td>
                  <td><b>{euro(r.baseAmount)}</b></td>
                </tr>
              )) : (
                <tr><td colSpan="5">LISTA E KLIENTËVE NUK U NGARKUA.</td></tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="arkaReviewActions">
          <button type="button" className="arkaTopBtn" disabled={!!busy} onClick={onCancel}>ANULO</button>
          <button type="button" className="arkaTopBtn ok" disabled={!!busy || review.hasDuplicateTransportItems} onClick={onConfirm}>{busy ? 'DUKE PRANU...' : `PRANO PËR BAZË ${euro(review.baseTotal)}`}</button>
        </div>
      </div>
    </div>
  );
}

function PendingHandoffRow({ row, actor, onDone, workerSummary, onReviewAccept }) {
  const [busy, setBusy] = useState('');
  const review = buildHandoffReview(row, workerSummary?.worker || { pin: row?.worker_pin, name: row?.worker_name });
  const clients = review.clientRows;
  const clientCount = Number(row?.count_clients || clients.length || 0) || 0;

  async function handleAccept() {
    if (onReviewAccept) {
      onReviewAccept({
        worker: workerSummary?.worker || { pin: row?.worker_pin, name: row?.worker_name },
        pendingHandoffRows: [row],
      });
      return;
    }
    if (review.hasDuplicateTransportItems) {
      alert('🔴 U GJET DUPLICATE TRANSPORT ITEM. Totali u shfaq me dedupe, por pranimi raw u ndalua për siguri.');
      return;
    }
    try {
      setBusy('accept');
      await acceptDispatchHandoff({ handoffId: row.id, actor });
      await onDone?.(row?.id);
      alert('✅ CASH U PRANUA.');
    } catch (e) {
      alert(`🔴 ${e?.message || 'NUK U PRANUA CASH.'}`);
    } finally {
      setBusy('');
    }
  }

  async function handleReject() {
    const note = window.prompt('SHËNIMI I REFUZIMIT', 'KTHEJE DHE KONTROLLO PARATË') || '';
    try {
      setBusy('reject');
      await rejectDispatchHandoff({ handoffId: row.id, actor, note });
      await onDone?.(row?.id);
      alert('✅ DORËZIMI U KTHYE TE SHOFERI.');
    } catch (e) {
      alert(`🔴 ${e?.message || 'NUK U REFUZUA DORËZIMI.'}`);
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="arkaPendingRow" style={{ alignItems: 'stretch', flexDirection: 'column', gap: 10 }}>
      <div className="arkaWorkerFoot" style={{ alignItems: 'flex-start' }}>
        <div>
          <div className="arkaPendingName">{String(row?.worker_name || row?.worker_pin || 'SHOFER').toUpperCase()}</div>
          <div className="arkaPendingMeta">PIN {row?.worker_pin || '—'} • {fmtDate(row?.submitted_at)} • {clientCount} KLIENTË</div>
        </div>
        <div className="arkaPendingRight">
          <div className="arkaPendingAmount">{euro(review.baseTotal)}</div>
          <div className="arkaPendingMeta">{cashStatusLabel(isPendingHandoffStatus(row?.status) ? 'PENDING_DISPATCH_APPROVAL' : row?.status)}</div>
        </div>
      </div>

      {review.hasDuplicateTransportItems ? (
        <div className="arkaReviewWarn">U gjet duplicate transport item. Totali është korrigjuar me dedupe.</div>
      ) : null}

      <div className="arkaCashCompactList">
        {clients.length ? clients.map((client) => (
          <CashClientCompactRow key={`handoff_client_${row.id}_${client.id}`} row={{ code: client?.code, clientName: client?.clientName, baseAmount: client?.baseAmount, gross: client?.gross, commission: client?.commission, typeLabel: 'DORËZIM' }} mini />
        )) : <div className="arkaEmpty">LISTA E KLIENTËVE NUK U NGARKUA, POR TOTALI I DORËZIMIT ËSHTË I VLEFSHËM.</div>}
      </div>

      <div className="arkaPendingActions" style={{ justifyContent: 'flex-end' }}>
        <button type="button" className="arkaTinyBtn ok" disabled={!!busy} onClick={handleAccept}>{busy === 'accept' ? '...' : 'PRANO CASH'}</button>
        <button type="button" className="arkaTinyBtn bad" disabled={!!busy} onClick={handleReject}>{busy === 'reject' ? '...' : 'KTHEJE / REFUZO'}</button>
      </div>
    </div>
  );
}

function PendingExpenseRow({ row, actor, onDone, beneficiaryOptions = [] }) {
  const [busy, setBusy] = useState('');
  const [classifyOpen, setClassifyOpen] = useState(false);
  const [decisionType, setDecisionType] = useState('BUSINESS_EXPENSE');
  const [beneficiaryPin, setBeneficiaryPin] = useState('');
  const [beneficiaryName, setBeneficiaryName] = useState('');
  const [decisionNote, setDecisionNote] = useState('');

  const cleanOptions = useMemo(() => {
    const seen = new Set();
    const rows = [];
    for (const item of Array.isArray(beneficiaryOptions) ? beneficiaryOptions : []) {
      const pin = String(item?.pin || item?.worker?.pin || '').trim();
      if (!pin || seen.has(pin)) continue;
      seen.add(pin);
      rows.push({ pin, name: String(item?.name || item?.worker?.name || pin).trim() });
    }
    return rows;
  }, [beneficiaryOptions]);

  const expenseRequest = useMemo(() => parseExpenseRequestNote(row?.note), [row?.note]);
  const requestedDecisionLabel = expenseRequestLabel(expenseRequest?.requestType);

  function openClassificationModal(preselectType = '') {
    const forcedType = safeUpper(preselectType);
    const requestedType = safeUpper(expenseRequest?.requestType);

    if (forcedType === 'REJECTED_OPEN_CASH') {
      setDecisionType('REJECTED_OPEN_CASH');
      setBeneficiaryPin('');
      setBeneficiaryName('');
    } else if (forcedType === 'BUSINESS_EXPENSE') {
      setDecisionType('BUSINESS_EXPENSE');
      setBeneficiaryPin('');
      setBeneficiaryName('');
    } else if (requestedType === 'PERSONAL_ADVANCE') {
      setDecisionType('PERSONAL_ADVANCE');
      setBeneficiaryPin(expenseRequest?.beneficiaryPin || '');
      setBeneficiaryName(expenseRequest?.beneficiaryName || '');
    } else {
      setDecisionType('BUSINESS_EXPENSE');
      setBeneficiaryPin('');
      setBeneficiaryName('');
    }

    setDecisionNote('');
    setClassifyOpen(true);
  }


  async function handleApprove() {
    if (safeUpper(row?.type || 'EXPENSE') === 'EXPENSE') {
      openClassificationModal();
      return;
    }
    try {
      setBusy('approve');
      await approveExpenseEntry({ requestId: row.id, actor });
      await onDone?.(row?.id);
      alert('✅ SHPENZIMI U PRANUA.');
    } catch (e) {
      alert(`🔴 ${e?.message || 'NUK U PRANUA SHPENZIMI.'}`);
    } finally {
      setBusy('');
    }
  }

  async function confirmExpenseDecision() {
    const type = safeUpper(decisionType || 'BUSINESS_EXPENSE');
    const cleanBeneficiaryPin = String(beneficiaryPin || '').trim();
    const cleanBeneficiaryName = String(beneficiaryName || '').trim();
    const actorPin = String(actor?.pin || '').trim();
    const actorName = String(actor?.name || '').trim();
    const expensePaymentId = Number(row?.id || 0);

    if (!actorPin) {
      alert('🔴 MUNGON PIN-I I AKTORIT.');
      return;
    }

    if (!expensePaymentId) {
      alert('🔴 MUNGON ID E SHPENZIMIT.');
      return;
    }

    if (type === 'PERSONAL_ADVANCE' && !cleanBeneficiaryPin) {
      alert('🔴 SHKRUJE PIN-IN E PUNËTORIT PËR AVANS PERSONAL.');
      return;
    }

    try {
      setBusy('decision');
      const { data: decisionData, error } = await supabase.rpc('create_standalone_expense_decision', {
        p_expense_payment_id: expensePaymentId,
        p_decision_type: type,
        p_beneficiary_pin: type === 'PERSONAL_ADVANCE' ? cleanBeneficiaryPin : null,
        p_beneficiary_name: type === 'PERSONAL_ADVANCE' ? cleanBeneficiaryName : null,
        p_note: String(decisionNote || '').trim() || null,
        p_actor_pin: actorPin,
        p_actor_name: actorName || null,
      });
      if (error) throw error;

      let decisionId = extractExpenseDecisionId(decisionData);

      if (!decisionId) {
        const { data: decisionRow, error: decisionReadError } = await supabase
          .from('arka_expense_decisions')
          .select('id')
          .eq('expense_payment_id', expensePaymentId)
          .eq('decision_type', type)
          .eq('decision_status', 'ACTIVE')
          .is('finalized_payment_id', null)
          .order('id', { ascending: false })
          .limit(1)
          .maybeSingle();

        if (decisionReadError) throw decisionReadError;
        decisionId = extractExpenseDecisionId(decisionRow);
      }

      if (!decisionId) {
        throw new Error('NUK U GJET DECISION_ID PAS KLASIFIKIMIT.');
      }

      const finalizerRpc = type === 'PERSONAL_ADVANCE'
        ? 'finalize_personal_advance_expense_decision'
        : 'finalize_business_or_rejected_expense_decision';

      const { error: finalizeError } = await supabase.rpc(finalizerRpc, {
        p_decision_id: decisionId,
        p_actor_pin: actorPin,
        p_actor_name: actorName || null,
      });
      if (finalizeError) throw finalizeError;

      setClassifyOpen(false);
      await onDone?.(row?.id);

      if (type === 'BUSINESS_EXPENSE') {
        alert('✅ SHPENZIMI U PRANUA SI BUSINESS_EXPENSE DHE AUDIT U MBYLL.');
        return;
      }

      if (type === 'PERSONAL_ADVANCE') {
        alert('✅ SHPENZIMI U KONVERTUA NË AVANS PERSONAL.');
        return;
      }

      alert('✅ SHPENZIMI U REFUZUA SI REJECTED_OPEN_CASH DHE AUDIT U MBYLL.');
    } catch (e) {
      alert(`🔴 ${e?.message || 'NUK U RUAJT KLASIFIKIMI.'}`);
    } finally {
      setBusy('');
    }
  }

  async function handleReject() {
    if (safeUpper(row?.type || 'EXPENSE') === 'EXPENSE') {
      openClassificationModal('REJECTED_OPEN_CASH');
      return;
    }

    try {
      setBusy('reject');
      await rejectExpenseEntry({ requestId: row.id, actor });
      await onDone?.(row?.id);
      alert('✅ SHPENZIMI U REFUZUA.');
    } catch (e) {
      alert(`🔴 ${e?.message || 'NUK U REFUZUA SHPENZIMI.'}`);
    } finally {
      setBusy('');
    }
  }

  function handleBeneficiaryPinChange(value) {
    const pin = String(value || '').trim();
    setBeneficiaryPin(pin);
    const match = cleanOptions.find((item) => item.pin === pin);
    if (match) setBeneficiaryName(match.name || '');
  }

  return (
    <>
      <div className="arkaPendingRow">
        <div>
          <div className="arkaPendingName">{String(row?.created_by_name || row?.created_by_pin || 'PUNTOR').toUpperCase()}</div>
          <div className="arkaPendingMeta">{String(expenseRequest?.displayNote || row?.note || 'SHPENZIM').toUpperCase()} • {fmtDate(row?.created_at)}</div>
          {requestedDecisionLabel ? (
            <div className={`arkaExpenseRequestBadge ${safeUpper(expenseRequest?.requestType) === 'PERSONAL_ADVANCE' ? 'personal' : 'business'}`}>
              {requestedDecisionLabel}{safeUpper(expenseRequest?.requestType) === 'PERSONAL_ADVANCE' && (expenseRequest?.beneficiaryPin || expenseRequest?.beneficiaryName) ? ` • PËR: ${String(expenseRequest?.beneficiaryName || expenseRequest?.beneficiaryPin).toUpperCase()}${expenseRequest?.beneficiaryPin ? ` / PIN ${expenseRequest.beneficiaryPin}` : ''}` : ''}
            </div>
          ) : null}
        </div>
        <div className="arkaPendingRight">
          <div className="arkaPendingAmount">{euro(row?.amount)}</div>
          <div className="arkaPendingActions">
            <button type="button" className="arkaTinyBtn ok" disabled={!!busy} onClick={handleApprove}>{busy === 'approve' || busy === 'decision' ? '...' : 'PRANO'}</button>
            <button type="button" className="arkaTinyBtn bad" disabled={!!busy} onClick={handleReject}>{busy === 'reject' ? '...' : 'REFUZO'}</button>
          </div>
        </div>
      </div>

      {classifyOpen ? (
        <div className="arkaExpenseModalBackdrop" role="dialog" aria-modal="true">
          <div className="arkaExpenseModalCard">
            <div className="arkaExpenseModalHeader">
              <div>
                <div className="arkaExpenseModalTitle">KLASIFIKO SHPENZIMIN</div>
                <div className="arkaExpenseModalSub">KY VENDIM RUAHET PARA APROVIMIT.</div>
              </div>
              <button type="button" className="arkaTinyBtn" disabled={!!busy} onClick={() => setClassifyOpen(false)}>MBYLL</button>
            </div>

            <div className="arkaExpenseReviewBox">
              <div><span>ID</span><strong>#{row?.id}</strong></div>
              <div><span>SHUMA</span><strong>{euro(row?.amount)}</strong></div>
              <div><span>PUNËTORI</span><strong>{String(row?.created_by_name || row?.created_by_pin || '—').toUpperCase()}</strong></div>
              <div><span>PIN</span><strong>{row?.created_by_pin || '—'}</strong></div>
              <div className="wide"><span>NOTE</span><strong>{String(expenseRequest?.displayNote || row?.note || '—').toUpperCase()}</strong></div>
              {requestedDecisionLabel ? <div className="wide"><span>KËRKESA</span><strong>{requestedDecisionLabel}{safeUpper(expenseRequest?.requestType) === 'PERSONAL_ADVANCE' && (expenseRequest?.beneficiaryPin || expenseRequest?.beneficiaryName) ? ` • ${String(expenseRequest?.beneficiaryName || expenseRequest?.beneficiaryPin).toUpperCase()}${expenseRequest?.beneficiaryPin ? ` / PIN ${expenseRequest.beneficiaryPin}` : ''}` : ''}</strong></div> : null}
            </div>

            <div className="arkaExpenseDecisionGrid">
              <button type="button" className={`arkaExpenseDecisionBtn ${decisionType === 'BUSINESS_EXPENSE' ? 'active' : ''}`} disabled={!!busy} onClick={() => setDecisionType('BUSINESS_EXPENSE')}>SHPENZIM BIZNESI</button>
              <button type="button" className={`arkaExpenseDecisionBtn ${decisionType === 'PERSONAL_ADVANCE' ? 'active warn' : ''}`} disabled={!!busy} onClick={() => setDecisionType('PERSONAL_ADVANCE')}>PERSONAL / AVANS</button>
              <button type="button" className={`arkaExpenseDecisionBtn ${decisionType === 'REJECTED_OPEN_CASH' ? 'active bad' : ''}`} disabled={!!busy} onClick={() => setDecisionType('REJECTED_OPEN_CASH')}>REFUZO / CASH I HAPUR</button>
            </div>

            {decisionType === 'PERSONAL_ADVANCE' ? (
              <div className="arkaExpenseBeneficiaryGrid">
                <div>
                  <label>PIN I PUNËTORIT</label>
                  <input className="arkaField" list={`expense_beneficiaries_${row?.id}`} value={beneficiaryPin} onChange={(e) => handleBeneficiaryPinChange(e.target.value)} placeholder="P.SH. 2020" />
                  <datalist id={`expense_beneficiaries_${row?.id}`}>
                    {cleanOptions.map((item) => (
                      <option key={item.pin} value={item.pin}>{item.name}</option>
                    ))}
                  </datalist>
                </div>
                <div>
                  <label>EMRI</label>
                  <input className="arkaField" value={beneficiaryName} onChange={(e) => setBeneficiaryName(e.target.value)} placeholder="P.SH. SHKENDIE RUHANJ" />
                </div>
              </div>
            ) : null}

            <div className="arkaExpenseNoteBox">
              <label>SHËNIM OPSIONAL</label>
              <textarea className="arkaField" rows={3} value={decisionNote} onChange={(e) => setDecisionNote(e.target.value)} placeholder="P.SH. SHKENDIA 13.5" />
            </div>

            {decisionType === 'BUSINESS_EXPENSE' ? (
              <div className="arkaExpenseWarning ok">BUSINESS_EXPENSE E MBYLL EXPENSE SI ACCEPTED_BY_DISPATCH DHE PLOTËSON AUDIT.</div>
            ) : decisionType === 'PERSONAL_ADVANCE' ? (
              <div className="arkaExpenseWarning warn">PERSONAL_ADVANCE E KONVERTON EXPENSE NË ADVANCE REAL DHE PLOTËSON AUDIT.</div>
            ) : (
              <div className="arkaExpenseWarning bad">REJECTED_OPEN_CASH E MBYLL EXPENSE SI REJECTED DHE PLOTËSON AUDIT.</div>
            )}

            <div className="arkaExpenseModalActions">
              <button type="button" className="arkaTinyBtn" disabled={!!busy} onClick={() => setClassifyOpen(false)}>ANULO</button>
              <button type="button" className="arkaSolidBtn" disabled={!!busy} onClick={confirmExpenseDecision}>{busy === 'decision' ? 'DUKE RUAJTUR...' : 'KONFIRMO'}</button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

function WorkerSummaryCard({ item, busy = '', onAcceptCash, onAddExpense, onAddAdvance }) {
  const pendingCount = Array.isArray(item?.pendingHandoffRows) ? item.pendingHandoffRows.length : 0;
  const cashRows = Array.isArray(item?.cashBreakdownRows) ? item.cashBreakdownRows : [];
  const historyRows = Array.isArray(item?.acceptedCashBreakdownRows) ? item.acceptedCashBreakdownRows : [];
  const due = n(item?.baseCashForDispatchTotal ?? item?.remainingToHandover);
  // IMPORTANT: dispatch acceptance must use NET/PËR BAZË totals,
  // not gross client-paid transport totals.
  const visiblePaid = n(item?.visibleBaseHistoryTotal ?? item?.baseCashForDispatchTotal ?? item?.remainingToHandover ?? item?.dueTotal);
  const visibleCommission = n(item?.visibleCommissionHistoryTotal ?? item?.commissionHeldTotal);
  const clientCount = cashRows.length || historyRows.length || (Array.isArray(item?.collectedRows) ? item.collectedRows.length : 0);
  const workerFirstName = String(item?.worker?.name || 'PUNTORI').trim().split(/\s+/)[0] || 'PUNTORI';
  return (
    <div className="arkaWorkerCard ownerSimpleCard compactWorkerCard">
      <div className="arkaWorkerTop">
        <div>
          <div className="arkaWorkerName">{String(item?.worker?.name || 'PUNTOR').toUpperCase()}</div>
          <div className="arkaWorkerMeta">PIN {item?.worker?.pin || '—'} • {String(item?.worker?.role || 'WORKER').toUpperCase()} • {clientCount} KLIENTË</div>
        </div>
        <div className={`arkaWorkerBadge ${item?.tone || 'idle'}`}>{item?.status || 'PA LËVIZJE'}</div>
      </div>
      <div className="arkaWorkerDueLine"><span>PËR BAZË</span><b>{euro(due)}</b></div>
      <div className="arkaOwnerFormulaGrid compactStats">
        <Stat label="KANË PAGUAR" value={euro(visiblePaid)} tone="ok" small />
        <Stat label={`KOMISION ${workerFirstName.toUpperCase()}`} value={euro(visibleCommission)} tone="warn" small />
        <Stat label="DËRGUAR" value={euro(item?.pendingHandoffTotal)} tone="info" small />
        <Stat label="HISTORI" value={euro(item?.acceptedGrossTotal)} tone="neutral" small />
      </div>
      {cashRows.length ? <div className="arkaCashCompactList adminMini">{cashRows.slice(0,4).map((row)=><CashClientCompactRow key={`worker_cash_${item?.worker?.pin}_${row.id || row.created_at}`} row={row} workerName={workerFirstName} mini />)}{cashRows.length > 4 ? <div className="arkaCashMore">+ {cashRows.length - 4} TJERA</div> : null}</div> : null}
      {!cashRows.length && historyRows.length ? <div className="arkaCashCompactList adminMini">{historyRows.slice(0,3).map((row)=><CashClientCompactRow key={`worker_history_${item?.worker?.pin}_${row.id || row.created_at}`} row={row} workerName={workerFirstName} mini />)}{historyRows.length > 3 ? <div className="arkaCashMore">+ {historyRows.length - 3} HISTORI</div> : null}</div> : null}
      <div className="arkaWorkerActions mainOnly">
        <Link prefetch={false} href={`/arka/puntor/${encodeURIComponent(item?.worker?.pin || '')}`} className="arkaTopBtn">HAP</Link>
        <button type="button" className="arkaTopBtn" disabled={!!busy || !pendingCount} onClick={() => onAcceptCash?.(item)}>{pendingCount ? 'PRANO CASH (' + pendingCount + ')' : 'PRANO CASH'}</button>
      </div>
      <details className="arkaInlineAdminTools"><summary>ADMIN</summary><div className="arkaWorkerActions adminTools"><button type="button" className="arkaTopBtn" disabled={!!busy} onClick={() => onAddExpense?.(item)}>SHTO SHPENZIM</button><button type="button" className="arkaTopBtn" disabled={!!busy} onClick={() => onAddAdvance?.(item)}>SHTO AVANS</button></div></details>
    </div>
  );
}

export default function ArkaPageV3() {
  useRouteAlive('arka_page');
  const [actor, setActor] = useState(null);
  const [loading, setLoading] = useState(true);
  const [secondaryLoading, setSecondaryLoading] = useState(false);
  const [error, setError] = useState('');
  const [workerSnapshot, setWorkerSnapshot] = useState(null);
  const [workerCards, setWorkerCards] = useState([]);
  const [pendingHandoffs, setPendingHandoffs] = useState([]);
  const [pendingExpenseApprovals, setPendingExpenseApprovals] = useState([]);
  const [cashAcceptReview, setCashAcceptReview] = useState(null);
  const [mealOptions, setMealOptions] = useState([]);
  const [selectedMealPins, setSelectedMealPins] = useState([]);
  const [mealCoworkersOpen, setMealCoworkersOpen] = useState(false);
  const [mealFormOpen, setMealFormOpen] = useState(false);
  const [expenseFormOpen, setExpenseFormOpen] = useState(false);
  const [expenseTitle, setExpenseTitle] = useState('');
  const [expenseAmount, setExpenseAmount] = useState('');
  const [expenseRequestType, setExpenseRequestType] = useState('BUSINESS_EXPENSE');
  const [expenseBeneficiaryPin, setExpenseBeneficiaryPin] = useState('');
  const [expenseBeneficiaryName, setExpenseBeneficiaryName] = useState('');
  const [expandedWorkerCashLineKey, setExpandedWorkerCashLineKey] = useState('');
  const [isClientsSectionOpen, setIsClientsSectionOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyDateKey, setHistoryDateKey] = useState(() => formatBelgradeDateKey(new Date()));
  const [historyDatePickerOpen, setHistoryDatePickerOpen] = useState(false);
  const [historyWorkerPin, setHistoryWorkerPin] = useState('ALL');
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const [historyGroups, setHistoryGroups] = useState([]);
  const [busy, setBusy] = useState('');

  const reloadInFlightRef = useRef(false);
  const lastReloadAtRef = useRef(0);
  const lifecycleTimerRef = useRef(null);
  const postMutationPrimaryTimerRef = useRef(null);
  const primaryLoadedAtRef = useRef(0);
  const secondaryLoadedAtRef = useRef(0);
  const errorCooldownUntilRef = useRef(0);
  const mutationCooldownUntilRef = useRef(0);
  const busyRef = useRef('');
  const uiReadyMarkedRef = useRef(false);
  const [sessionChecked, setSessionChecked] = useState(false);

  const role = safeUpper(actor?.role);
  const isWorker = roleIsWorker(role);
  const canManage = roleCanManage(role);
  const canOpenKapaku = canManage && (String(actor?.pin || '').trim() === '2380' || ['MASTER', 'ADMIN', 'ADMIN_MASTER', 'SUPERADMIN', 'DISPATCH'].includes(role));


  function applyCachedBootState(currentActor = null) {
    const act = currentActor || actor || getActor();
    if (!act?.pin) return false;
    if (roleIsWorker(act?.role) && !roleCanManage(act?.role)) {
      const cached = readStoredJson(getWorkerArkaCacheKey(act.pin));
      if (!cached || typeof cached !== 'object') return false;
      if (cached?.workerSnapshot) setWorkerSnapshot(cached.workerSnapshot || null);
      setMealOptions(Array.isArray(cached?.mealOptions) ? cached.mealOptions : []);
      setPendingHandoffs(Array.isArray(cached?.pendingHandoffs) ? cached.pendingHandoffs : []);
      setPendingExpenseApprovals(Array.isArray(cached?.pendingExpenseApprovals) ? cached.pendingExpenseApprovals : []);
      setLoading(false);
      return true;
    }
    const cached = readStoredJson(ARKA_MANAGER_CACHE_KEY);
    if (!cached || typeof cached !== 'object') return false;
    setWorkerCards(Array.isArray(cached?.workerCards) ? cached.workerCards : []);
    setPendingHandoffs(Array.isArray(cached?.pendingHandoffs) ? cached.pendingHandoffs : []);
    setPendingExpenseApprovals(Array.isArray(cached?.pendingExpenseApprovals) ? cached.pendingExpenseApprovals : []);
    setLoading(false);
    return true;
  }

  useEffect(() => {
    busyRef.current = String(busy || '').trim();
  }, [busy]);

  function clearPostMutationPrimaryTimer() {
    if (postMutationPrimaryTimerRef.current) {
      clearTimeout(postMutationPrimaryTimerRef.current);
      postMutationPrimaryTimerRef.current = null;
    }
  }

  async function scheduleManagerMutationRefresh(currentActor = null) {
    const act = currentActor || actor || getActor();
    mutationCooldownUntilRef.current = Date.now() + MUTATION_COOLDOWN_MS;
    clearPostMutationPrimaryTimer();

    if (roleIsWorker(act?.role) && !roleCanManage(act?.role)) {
      await reloadAll(act, { force: true, source: 'mutation_worker', target: 'all' });
      return;
    }

    await reloadAll(act, { force: true, source: 'mutation_secondary', target: 'secondary' });

    postMutationPrimaryTimerRef.current = setTimeout(() => {
      if (!isArkaRouteActive()) return;
      void reloadAll(act, { force: true, source: 'mutation_followup', target: 'primary' });
    }, MUTATION_PRIMARY_DELAY_MS);
  }

  async function handlePendingHandoffDone(handoffId) {
    const cleanId = String(handoffId || '').trim();
    if (cleanId) {
      setPendingHandoffs((current) => current.filter((row) => String(row?.id || '').trim() !== cleanId));
    }
    await scheduleManagerMutationRefresh(actor);
  }

  async function handlePendingExpenseDone(requestId) {
    const cleanId = String(requestId || '').trim();
    if (cleanId) {
      setPendingExpenseApprovals((current) => current.filter((row) => String(row?.id || '').trim() !== cleanId));
    }
    await scheduleManagerMutationRefresh(actor);
  }

  function acceptWorkerCashFromCard(item) {
    const rows = Array.isArray(item?.pendingHandoffRows) ? item.pendingHandoffRows : [];
    if (!rows.length) {
      alert('S’KA DORËZIM CASH NË PRITJE PËR KËTË PUNTOR.');
      return;
    }
    setCashAcceptReview(buildWorkerHandoffReview(item));
  }

  async function confirmCashAcceptReview() {
    const review = cashAcceptReview;
    const rows = Array.isArray(review?.handoffRows) ? review.handoffRows : [];
    if (!rows.length) {
      setCashAcceptReview(null);
      alert('S’KA DORËZIM CASH NË PRITJE.');
      return;
    }
    if (review?.hasDuplicateTransportItems) {
      alert('🔴 U GJET DUPLICATE TRANSPORT ITEM. Totali u korrigjua me dedupe në ekran, por pranimi raw u ndalua për siguri.');
      return;
    }
    try {
      setBusy('accept_cash_review');
      for (const row of rows) {
        await acceptDispatchHandoff({ handoffId: row.id, actor });
        await handlePendingHandoffDone(row?.id);
      }
      setCashAcceptReview(null);
      alert('✅ CASH U PRANUA NË ARKË: ' + euro(review?.baseTotal || 0));
      await scheduleManagerMutationRefresh(actor);
    } catch (e) {
      alert('🔴 ' + (e?.message || 'NUK U PRANUA CASH.'));
    } finally {
      setBusy('');
    }
  }

  async function addWorkerExpenseFromCard(item) {
    const worker = item?.worker || {};
    const workerName = String(worker?.name || worker?.pin || 'PUNTOR').toUpperCase();
    const amount = parseAmountInput(window.prompt('SHUMA E SHPENZIMIT PËR ' + workerName, '') || '');
    if (!(amount > 0)) return;
    const note = window.prompt('SHËNIMI I SHPENZIMIT', 'SHPENZIM') || 'SHPENZIM';
    try {
      setBusy('expense_' + (worker?.pin || ''));
      await createExpenseEntry({
        actor,
        amount,
        note,
        workerPin: worker?.pin || '',
        workerName: worker?.name || worker?.pin || 'PUNTOR',
        workerRole: worker?.role || 'WORKER',
      });
      alert('✅ SHPENZIMI U SHTUA.');
      await scheduleManagerMutationRefresh(actor);
    } catch (e) {
      alert('🔴 ' + (e?.message || 'NUK U SHTUA SHPENZIMI.'));
    } finally {
      setBusy('');
    }
  }

  async function insertWorkerAdvance({ worker, amount, note }) {
    const res = await arkaTransaction({
      action: ARKA_ACTION.EXPENSE_REQUEST,
      actorPin: actor?.pin || worker?.pin || null,
      actorName: actor?.name || worker?.name || null,
      actorRole: actor?.role || null,
      workerPin: worker?.pin || actor?.pin || null,
      workerName: worker?.name || actor?.name || null,
      paymentType: 'ADVANCE',
      sourceModule: ARKA_SOURCE_MODULE.ARKA,
      status: 'ADVANCE',
      amount,
      note: String(note || 'AVANS').trim() || 'AVANS',
      idempotencyKey: buildArkaIdempotencyKey(ARKA_ACTION.EXPENSE_REQUEST, [worker?.pin || actor?.pin || '', 'ADVANCE', amount]),
    });
    return res?.payment || res?.row || null;
  }


  async function addWorkerAdvanceFromCard(item) {
    const worker = item?.worker || {};
    const workerName = String(worker?.name || worker?.pin || 'PUNTOR').toUpperCase();
    const amount = parseAmountInput(window.prompt('SHUMA E AVANSIT PËR ' + workerName, '') || '');
    if (!(amount > 0)) return;
    const note = window.prompt('SHËNIMI I AVANSIT', 'AVANS') || 'AVANS';
    const ok = window.confirm('A DON ME SHTU AVANS ' + euro(amount) + ' PËR ' + workerName + '?');
    if (!ok) return;
    try {
      setBusy('advance_' + (worker?.pin || ''));
      await insertWorkerAdvance({ worker, amount, note });
      alert('✅ AVANSI U SHTUA.');
      await scheduleManagerMutationRefresh(actor);
    } catch (e) {
      alert('🔴 ' + (e?.message || 'NUK U SHTUA AVANSI.'));
    } finally {
      setBusy('');
    }
  }
  const totals = useMemo(() => ({
    // Use NET/base totals for dispatch-facing cards and acceptance totals.
    cashFromClientsTotal: workerCards.reduce((sum, item) => sum + n(item?.visibleBaseHistoryTotal ?? item?.baseCashForDispatchTotal ?? item?.remainingToHandover ?? item?.dueTotal), 0),
    acceptedHistoryTotal: workerCards.reduce((sum, item) => sum + n(item?.acceptedGrossTotal), 0),
    commissionHeldTotal: workerCards.reduce((sum, item) => sum + n(item?.visibleCommissionHistoryTotal ?? item?.commissionHeldTotal), 0),
    workerExpenseTotal: workerCards.reduce((sum, item) => sum + n(item?.workerExpenseTotal), 0),
    pendingHandoffTotal: workerCards.reduce((sum, item) => sum + n(item?.pendingHandoffTotal), 0),
    acceptedTodayTotal: workerCards.reduce((sum, item) => sum + n(item?.deliveredTodayTotal), 0),
    remainingToHandover: workerCards.reduce((sum, item) => sum + n(item?.baseCashForDispatchTotal ?? item?.remainingToHandover), 0),
  }), [workerCards]);

  const workerCardsByPin = useMemo(() => {
    const map = new Map();
    for (const item of Array.isArray(workerCards) ? workerCards : []) {
      const pin = String(item?.worker?.pin || '').trim();
      if (pin) map.set(pin, item);
    }
    return map;
  }, [workerCards]);

  const selfMealTodayRows = useMemo(() => {
    const pin = String(actor?.pin || '').trim();
    if (!pin || !workerSnapshot) return [];
    const rows = [
      ...(Array.isArray(workerSnapshot?.allExtraRows) ? workerSnapshot.allExtraRows : []),
      ...(Array.isArray(workerSnapshot?.mealCoveredRows) ? workerSnapshot.mealCoveredRows : []),
      ...(Array.isArray(workerSnapshot?.mealPaymentRows) ? workerSnapshot.mealPaymentRows : []),
      ...(Array.isArray(workerSnapshot?.extraRows) ? workerSnapshot.extraRows : []),
    ];
    return mapUniqueById(rows).filter((row) => isWorkerMealRowToday(row, pin));
  }, [actor?.pin, workerSnapshot]);

  const selfMealCoveredToday = selfMealTodayRows.length > 0;

  const canIncludeSelfMeal = !!workerSnapshot?.hasTodayBasePayment && !selfMealCoveredToday;

  const selectedMealWorkers = useMemo(() => {
    const selected = new Set((selectedMealPins || []).map((pin) => String(pin || '').trim()).filter(Boolean));
    return (Array.isArray(mealOptions) ? mealOptions : []).filter((row) => selected.has(String(row?.pin || '').trim()));
  }, [mealOptions, selectedMealPins]);

  const selectedOpenMealWorkers = useMemo(() => (selectedMealWorkers || []).filter((row) => !staffMealCoveredToday(row)), [selectedMealWorkers]);
  const selectedCoveredMealWorkers = useMemo(() => (selectedMealWorkers || []).filter((row) => staffMealCoveredToday(row)), [selectedMealWorkers]);
  const mealSubmitPeopleCount = selectedOpenMealWorkers.length + (canIncludeSelfMeal ? 1 : 0);
  const mealSubmitTotal = mealSubmitPeopleCount * FOOD_DEDUCTION;

  const workerOpenExpenseRows = useMemo(() => {
    const pin = String(actor?.pin || '').trim();
    if (!pin || !workerSnapshot) return [];
    const rows = [
      ...(Array.isArray(workerSnapshot?.allExtraRows) ? workerSnapshot.allExtraRows : []),
      ...(Array.isArray(workerSnapshot?.extraRows) ? workerSnapshot.extraRows : []),
    ];
    return mapUniqueById(rows)
      .filter((row) => String(row?.created_by_pin || '').trim() === pin)
      .filter((row) => ['EXPENSE', 'MEAL_PAYMENT', 'MEAL_COVERED'].includes(typeOf(row)))
      .filter((row) => ['PENDING', 'COLLECTED'].includes(statusOf(row)))
      .sort(byDateDesc);
  }, [actor?.pin, workerSnapshot]);

  const workerOpenExpenseTotal = useMemo(() => workerOpenExpenseRows.reduce((sum, row) => sum + amountOf(row), 0), [workerOpenExpenseRows]);

  const historyWorkerOptions = useMemo(() => {
    const map = new Map();
    for (const item of Array.isArray(workerCards) ? workerCards : []) {
      const worker = item?.worker || {};
      const pin = String(worker?.pin || '').trim();
      if (!pin) continue;
      map.set(pin, { ...worker, pin, name: String(worker?.name || pin).trim() });
    }
    if (actor?.pin && !map.has(String(actor.pin))) {
      map.set(String(actor.pin), { ...actor, pin: String(actor.pin), name: String(actor?.name || actor.pin).trim() });
    }
    return [...map.values()].sort((a, b) => String(a?.name || '').localeCompare(String(b?.name || '')));
  }, [workerCards, actor]);

  useEffect(() => {
    if (!actor?.pin) return;
    setHistoryWorkerPin((prev) => {
      if (canManage) return prev || 'ALL';
      return String(actor.pin || '').trim();
    });
  }, [actor?.pin, canManage]);

  async function loadArkaHistoryPanel() {
    const bounds = belgradeDayBoundsFromDateKey(historyDateKey);
    const targetPin = canManage ? String(historyWorkerPin || 'ALL').trim() || 'ALL' : String(actor?.pin || '').trim();
    if (!actor?.pin || (!canManage && !targetPin)) return;

    setHistoryLoading(true);
    setHistoryError('');
    try {
      const limit = targetPin === 'ALL' ? 1000 : 500;
      let paymentQuery = supabase
        .from('arka_pending_payments')
        .select('*')
        .gte('created_at', bounds.startIso)
        .lt('created_at', bounds.endIso)
        .order('created_at', { ascending: false })
        .limit(limit);

      if (targetPin !== 'ALL') {
        paymentQuery = paymentQuery.or(`created_by_pin.eq.${targetPin},handed_by_pin.eq.${targetPin}`);
      }

      const fetchHandoffsForField = async (field) => {
        let query = supabase
          .from('cash_handoffs')
          .select('*, cash_handoff_items(*)')
          .gte(field, bounds.startIso)
          .lt(field, bounds.endIso)
          .order(field, { ascending: false })
          .limit(limit);
        if (targetPin !== 'ALL') query = query.eq('worker_pin', targetPin);
        const { data, error } = await query;
        if (error) throw error;
        return Array.isArray(data) ? data : [];
      };

      const [paymentRes, submittedHandoffs, decidedHandoffs] = await Promise.all([
        withArkaTimeout(paymentQuery, 'history_payments', 5200),
        withArkaTimeout(fetchHandoffsForField('submitted_at'), 'history_handoffs_submitted', 5200),
        withArkaTimeout(fetchHandoffsForField('decided_at'), 'history_handoffs_decided', 5200).catch(() => []),
      ]);

      if (paymentRes?.error) throw paymentRes.error;
      const payments = Array.isArray(paymentRes?.data) ? paymentRes.data : [];
      const handoffs = mapUniqueById([...(Array.isArray(submittedHandoffs) ? submittedHandoffs : []), ...(Array.isArray(decidedHandoffs) ? decidedHandoffs : [])]);
      const workersByPin = {};
      for (const item of historyWorkerOptions) {
        const pin = String(item?.pin || '').trim();
        if (pin) workersByPin[pin] = item;
      }
      if (actor?.pin) workersByPin[String(actor.pin).trim()] = { ...(workersByPin[String(actor.pin).trim()] || {}), ...actor, pin: String(actor.pin).trim(), name: String(actor?.name || actor.pin).trim() };
      for (const row of payments) {
        const pin = historyPaymentWorkerPin(row);
        if (pin && !workersByPin[pin]) workersByPin[pin] = { pin, name: historyPaymentWorkerName(row) || pin };
      }
      for (const row of handoffs) {
        const pin = String(row?.worker_pin || '').trim();
        if (pin && !workersByPin[pin]) workersByPin[pin] = { pin, name: String(row?.worker_name || pin).trim() };
      }
      const groups = buildArkaHistoryGroups({ payments, handoffs, workersByPin, targetPin });
      setHistoryGroups(groups);
    } catch (err) {
      setHistoryGroups([]);
      setHistoryError(err?.message || 'NUK U NGARKUA HISTORIA E ARKËS.');
    } finally {
      setHistoryLoading(false);
    }
  }

  useEffect(() => {
    if (!historyOpen || !actor?.pin) return;
    let cancelled = false;
    const run = async () => {
      await loadArkaHistoryPanel();
      if (cancelled) return;
    };
    run();
    return () => { cancelled = true; };
  }, [historyOpen, historyDateKey, historyWorkerPin, actor?.pin, canManage]);

  async function loadWorkerView(currentActor) {
    setWorkerCards([]);
    setPendingHandoffs([]);
    setPendingExpenseApprovals([]);
    const pin = String(currentActor?.pin || '').trim();
    if (!pin) {
      setWorkerSnapshot(null);
      setMealOptions([]);
      return;
    }

    let hadErrors = false;
    const swallowToEmpty = (label, err) => {
      hadErrors = true;
      try { console.error(`[ARKA][WORKER] ${label} failed, switching to local cache if available:`, err); } catch {}
      return [];
    };

    const [payments, extras, handoffs, mealStaff, financeUser] = await Promise.all([
      withArkaTimeout(listWorkerPendingPayments(pin, WORKER_PAYMENTS_LIMIT), 'worker_payments', 4200).catch((err) => swallowToEmpty('payments', err)),
      withArkaTimeout(listWorkerArkaExtras(pin, WORKER_EXTRAS_LIMIT), 'worker_extras', 4200).catch((err) => swallowToEmpty('extras', err)),
      withArkaTimeout(listWorkerHandoffs(pin, WORKER_HANDOFFS_LIMIT), 'worker_handoffs', 4200).catch((err) => swallowToEmpty('handoffs', err)),
      withArkaTimeout(listMealStaffOptions({ excludePin: pin }), 'meal_staff', 4200).catch((err) => swallowToEmpty('meal_staff', err)),
      withArkaTimeout(fetchSessionUserByPin(pin), 'worker_finance_profile', 2600).catch(() => null),
    ]);

    if (hadErrors) {
      const cached = readStoredJson(getWorkerArkaCacheKey(pin));
      if (cached && typeof cached === 'object') {
        setWorkerSnapshot(cached?.workerSnapshot || null);
        setMealOptions(Array.isArray(cached?.mealOptions) ? cached.mealOptions : []);
        setPendingHandoffs(Array.isArray(cached?.pendingHandoffs) ? cached.pendingHandoffs : []);
        setPendingExpenseApprovals(Array.isArray(cached?.pendingExpenseApprovals) ? cached.pendingExpenseApprovals : []);
        const now = Date.now();
        primaryLoadedAtRef.current = now;
        secondaryLoadedAtRef.current = now;
        return;
      }
      throw new Error('Load failed');
    }

    const financeActor = financeUser ? reconcileActorWithUser(currentActor, financeUser) : currentActor;
    if (financeUser) {
      setActor((prev) => (String(prev?.pin || '').trim() === pin ? reconcileActorWithUser(prev, financeUser) : prev));
      persistActorRepair(financeActor);
    }
    let transportOrdersById = {};
    if ((Array.isArray(payments) ? payments : []).some((row) => cashSourceModule(row) === 'TRANSPORT')) {
      try { transportOrdersById = await withArkaTimeout(fetchTransportMetaForCashRows(payments), 'worker_transport_meta', 3400); }
      catch (err) { try { console.warn('[ARKA][WORKER] transport meta unavailable, using payment row m2 only:', err); } catch {} }
    }
    const snapshot = summarizeArkaCore({ worker: financeActor, paymentRows: payments, extraRows: extras, handoffRows: handoffs, transportOrdersById });
    setWorkerSnapshot(snapshot);
    setMealOptions(Array.isArray(mealStaff) ? mealStaff : []);
    mergeStoredJsonDeferred(getWorkerArkaCacheKey(pin), {
      workerSnapshot: snapshot,
      mealOptions: Array.isArray(mealStaff) ? mealStaff : [],
      pendingHandoffs: Array.isArray(handoffs) ? handoffs : [],
      pendingExpenseApprovals: [],
    });
    const now = Date.now();
    primaryLoadedAtRef.current = now;
    secondaryLoadedAtRef.current = now;
  }

  async function loadManagerPrimary() {
    setWorkerSnapshot(null);
    setMealOptions([]);
    try {
      const staff = await withArkaTimeout(listTodayWorkers(), 'today_workers', 4200);
      const workerRows = (Array.isArray(staff) ? staff : []).filter((row) => roleIsArkaVisibleAccount(row?.role));
      const { paymentsByPin, extrasByPin, handoffsByPin, advancesByPin, hadErrors } = await loadManagerBulkSnapshots(workerRows);
      if (hadErrors) throw new Error('Load failed');
      const allPaymentRows = [];
      for (const worker of workerRows) {
        const pin = String(worker?.pin || '').trim();
        allPaymentRows.push(...(paymentsByPin.get(pin) || []));
      }
      let transportOrdersById = {};
      if (allPaymentRows.some((row) => cashSourceModule(row) === 'TRANSPORT')) {
        try { transportOrdersById = await withArkaTimeout(fetchTransportMetaForCashRows(allPaymentRows), 'manager_transport_meta', 3800); }
        catch (err) { try { console.warn('[ARKA][MANAGER] transport meta unavailable, using payment row m2 only:', err); } catch {} }
      }
      const cards = workerRows.map((worker) => {
        const pin = String(worker?.pin || '').trim();
        return summarizeArkaCore({
          worker,
          paymentRows: paymentsByPin.get(pin) || [],
          extraRows: extrasByPin.get(pin) || [],
          handoffRows: handoffsByPin.get(pin) || [],
          advanceRows: advancesByPin.get(pin) || [],
          transportOrdersById,
        });
      });
      cards.sort((a, b) => {
        const priority = { warn: 0, info: 1, ok: 2, idle: 3 };
        return (priority[a?.tone] ?? 9) - (priority[b?.tone] ?? 9)
          || n(b?.remainingToHandover) - n(a?.remainingToHandover)
          || String(a?.worker?.name || '').localeCompare(String(b?.worker?.name || ''));
      });
      setWorkerCards(cards);
      mergeStoredJsonDeferred(ARKA_MANAGER_CACHE_KEY, { workerCards: cards });
      primaryLoadedAtRef.current = Date.now();
    } catch (e) {
      const cached = readStoredJson(ARKA_MANAGER_CACHE_KEY);
      if (cached && Array.isArray(cached?.workerCards)) {
        setWorkerCards(cached.workerCards);
        primaryLoadedAtRef.current = Date.now();
        return;
      }
      throw e;
    }
  }

  async function loadManagerSecondary() {
    setSecondaryLoading(true);
    try {
      let hadErrors = false;
      const swallowToEmpty = (label, err) => {
        hadErrors = true;
        try { console.error(`[ARKA][MANAGER] ${label} failed, switching to local cache if available:`, err); } catch {}
        return [];
      };
      const [handoffs, expenses] = await Promise.all([
        withArkaTimeout(listPendingDispatchHandoffs(MANAGER_SECONDARY_LIMIT, MANAGER_PENDING_HANDOFF_SELECT), 'pending_dispatch_handoffs', 4200).catch((err) => swallowToEmpty('handoffs', err)),
        withArkaTimeout(listAdminPendingExpenseApprovals(MANAGER_SECONDARY_LIMIT, MANAGER_PENDING_EXPENSE_SELECT), 'pending_expense_approvals', 4200).catch((err) => swallowToEmpty('expenses', err)),
      ]);
      if (hadErrors) {
        const cached = readStoredJson(ARKA_MANAGER_CACHE_KEY);
        if (cached && typeof cached === 'object') {
          setPendingHandoffs(Array.isArray(cached?.pendingHandoffs) ? cached.pendingHandoffs : []);
          setPendingExpenseApprovals(Array.isArray(cached?.pendingExpenseApprovals) ? cached.pendingExpenseApprovals : []);
          secondaryLoadedAtRef.current = Date.now();
          return;
        }
        throw new Error('Load failed');
      }
      setPendingHandoffs(Array.isArray(handoffs) ? handoffs : []);
      setPendingExpenseApprovals(Array.isArray(expenses) ? expenses : []);
      mergeStoredJsonDeferred(ARKA_MANAGER_CACHE_KEY, {
        pendingHandoffs: Array.isArray(handoffs) ? handoffs : [],
        pendingExpenseApprovals: Array.isArray(expenses) ? expenses : [],
      });
      secondaryLoadedAtRef.current = Date.now();
    } finally {
      setSecondaryLoading(false);
    }
  }

  async function reloadAll(currentActor = null, { force = false, source = 'direct', target = 'auto' } = {}) {
    const act = currentActor || getActor();
    const now = Date.now();
    const inMutationCooldown = now < mutationCooldownUntilRef.current;
    const isLifecycleSource = ['focus', 'visibility', 'pageshow', 'pageshow_fresh'].includes(String(source || ''));
    if (!isArkaRouteActive()) return;
    if (isOfflineBrowser()) {
      const restored = applyCachedBootState(act);
      setLoading(false);
      if (!restored) {
        setError((prev) => prev || 'OFFLINE. HAPE NJËHERË ONLINE QË TË RUAHET SNAPSHOT-I I ARKËS.');
      } else {
        setError('');
      }
      return;
    }
    const hidden = typeof document !== 'undefined' && document.visibilityState !== 'visible';
    const allowHiddenBoot = force || String(source || '').startsWith('initial') || primaryLoadedAtRef.current === 0 || secondaryLoadedAtRef.current === 0;
    if (hidden && !allowHiddenBoot) return;
    if (!force && now < errorCooldownUntilRef.current) return;
    if (!force && inMutationCooldown && isLifecycleSource) return;
    if (!force && now - lastReloadAtRef.current < RELOAD_MIN_GAP_MS) return;
    if (reloadInFlightRef.current) return;

    let runPrimary = false;
    let runSecondary = false;

    if (roleIsWorker(act?.role) && !roleCanManage(act?.role)) {
      runPrimary = true;
      runSecondary = true;
    } else {
      const primaryAge = now - primaryLoadedAtRef.current;
      const secondaryAge = now - secondaryLoadedAtRef.current;
      if (force || target === 'all' || source === 'manual' || source === 'mutation' || source === 'arka_refresh') {
        runPrimary = true;
        runSecondary = true;
      } else if (target === 'primary') {
        runPrimary = true;
      } else if (target === 'secondary') {
        runSecondary = true;
      } else {
        runPrimary = primaryLoadedAtRef.current === 0 || primaryAge >= PRIMARY_STALE_MS;
        runSecondary = secondaryLoadedAtRef.current === 0 || secondaryAge >= SECONDARY_STALE_MS;
      }
    }

    if (!runPrimary && !runSecondary) return;

    const isWorkerView = roleIsWorker(act?.role) && !roleCanManage(act?.role);
    const cachedPrimary = isWorkerView
      ? !!readStoredJson(getWorkerArkaCacheKey(act?.pin))?.workerSnapshot
      : !!(readStoredJson(ARKA_MANAGER_CACHE_KEY)?.workerCards || []).length;
    const livePrimaryReady = isWorkerView
      ? !!workerSnapshot
      : Array.isArray(workerCards) && workerCards.length > 0;
    const showBlockingLoading = runPrimary && !(livePrimaryReady || cachedPrimary);

    reloadInFlightRef.current = true;
    const reloadWatchdog = (() => {
      try {
        return window.setTimeout(() => {
          try {
            if (!reloadInFlightRef.current) return;
            reloadInFlightRef.current = false;
            setLoading(false);
            setSecondaryLoading(false);
            const restored = applyCachedBootState(act);
            setError((prev) => prev || (restored ? '' : 'ARKA PO VAZHDON ME SAFE STATE. RRJETI U VONUA.'));
            try { window.dispatchEvent(new CustomEvent('tepiha:force-route-settled', { detail: { path: '/arka', source: 'arka_reload_watchdog_v26' } })); } catch {}
          } catch {}
        }, 6500);
      } catch {
        return null;
      }
    })();
    lastReloadAtRef.current = now;
    if (showBlockingLoading) setLoading(true);
    setError('');
    try {
      if (isWorkerView) {
        await loadWorkerView(act);
      } else {
        const tasks = [];
        if (runPrimary) tasks.push(loadManagerPrimary());
        if (runSecondary) tasks.push(loadManagerSecondary());
        await Promise.all(tasks);
      }
      errorCooldownUntilRef.current = 0;
    } catch (e) {
      errorCooldownUntilRef.current = Date.now() + ERROR_COOLDOWN_MS;
      setError(e?.message || 'NUK U NGARKUA ARKA.');
    } finally {
      try { if (reloadWatchdog) window.clearTimeout(reloadWatchdog); } catch {}
      if (showBlockingLoading) setLoading(false);
      reloadInFlightRef.current = false;
    }
  }

  useEffect(() => {
    let alive = true;
    const localActor = getActor() || null;
    setActor(localActor);
    setSessionChecked(true);
    if (!localActor?.pin) {
      setLoading(false);
      return () => { alive = false; };
    }

    applyCachedBootState(localActor);

    const actorLooksComplete = !!(
      localActor?.pin
      && localActor?.role
      && (localActor?.user_id || localActor?.id)
    );

    if (actorLooksComplete) {
      return () => { alive = false; };
    }

    (async () => {
      try {
        const userRow = await fetchSessionUserByPin(localActor.pin);
        if (!alive || !userRow) return;
        const repaired = reconcileActorWithUser(localActor, userRow);
        const changed = JSON.stringify({ pin: localActor?.pin, role: localActor?.role, name: localActor?.name, user_id: localActor?.user_id, is_hybrid_transport: localActor?.is_hybrid_transport, commission_rate_m2: localActor?.commission_rate_m2, transport_id: localActor?.transport_id }) !== JSON.stringify({ pin: repaired?.pin, role: repaired?.role, name: repaired?.name, user_id: repaired?.user_id, is_hybrid_transport: repaired?.is_hybrid_transport, commission_rate_m2: repaired?.commission_rate_m2, transport_id: repaired?.transport_id });
        if (changed) {
          persistActorRepair(repaired);
          try { window.__tepihaBootDebug?.logEvent?.('arka_actor_reconciled', { pin: repaired?.pin, role: repaired?.role, isHybrid: repaired?.is_hybrid_transport === true }); } catch {}
        }
        setActor(repaired);
        applyCachedBootState(repaired);
      } catch {}
    })();
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!sessionChecked) return undefined;
    const timer = setTimeout(() => {
      try {
        bootLog('ui_ready', {
          page: 'arka',
          path: typeof window !== 'undefined' ? (window.location.pathname || '/arka') : '/arka',
          source: uiReadyMarkedRef.current ? 'safe_shell_repeat' : 'safe_shell_first',
          loading: !!loading,
          actorPin: actor?.pin || '',
          isWorker: !!isWorker,
          canManage: !!canManage,
          workerCards: Array.isArray(workerCards) ? workerCards.length : 0,
          pendingHandoffs: Array.isArray(pendingHandoffs) ? pendingHandoffs.length : 0,
        });
      } catch {}
      if (uiReadyMarkedRef.current) return;
      uiReadyMarkedRef.current = true;
      try {
        bootMarkReady({
          source: 'arka_page',
          page: 'arka',
          path: typeof window !== 'undefined' ? (window.location.pathname || '/arka') : '/arka',
          loading: !!loading,
          actorPin: actor?.pin || '',
          isWorker: !!isWorker,
          canManage: !!canManage,
        });
      } catch {}
    }, 0);
    return () => clearTimeout(timer);
  }, [sessionChecked, loading, actor?.pin, isWorker, canManage, workerCards.length, pendingHandoffs.length, pendingExpenseApprovals.length, !!workerSnapshot]);

  useEffect(() => {
    if (!sessionChecked || !loading) return undefined;
    const timer = setTimeout(() => {
      setLoading(false);
      setError((prev) => prev || 'PO PRITET RRJETI. PO SHFAQET GJENDJA E SIGURT.');
    }, 2400);
    return () => clearTimeout(timer);
  }, [sessionChecked, loading]);

  useEffect(() => {
    if (!actor?.pin) return;
    const isManagerActor = roleCanManage(actor?.role) && !roleIsWorker(actor?.role);
    const cancelPrimary = scheduleIdleTask(() => {
      if (!isArkaRouteActive()) return;
      void reloadAll(actor, { force: true, source: 'initial', target: isManagerActor ? 'primary' : 'all' });
    }, 120, 1400);

    let cancelSecondary = null;
    if (isManagerActor) {
      cancelSecondary = scheduleIdleTask(() => {
        if (!isArkaRouteActive()) return;
        void reloadAll(actor, { force: true, source: 'initial_secondary', target: 'secondary' });
      }, INITIAL_MANAGER_SECONDARY_DELAY_MS, 2200);
    }

    return () => {
      try { cancelPrimary?.(); } catch {}
      try { cancelSecondary?.(); } catch {}
    };
  }, [actor?.pin, actor?.role]);

  useEffect(() => {
    if (!actor?.pin) return;
    if (isWithinStartupIsolationWindow()) {
      bootLog('arka_lifecycle_startup_isolation_skip', {
        path: typeof window !== 'undefined' ? (window.location.pathname || '/arka') : '/arka',
        leftMs: getStartupIsolationLeftMs(),
      });
      return undefined;
    }

    function scheduleLifecycleReload(reason) {
      const needsBootData = primaryLoadedAtRef.current === 0 || secondaryLoadedAtRef.current === 0;
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible' && !needsBootData) return;
      if (!isArkaRouteActive()) return;
      if (busyRef.current) return;
      const now = Date.now();
      if (now < mutationCooldownUntilRef.current) return;
      if (now - lastReloadAtRef.current < LIFECYCLE_RELOAD_GAP_MS) return;
      const target = needsBootData ? 'all' : 'secondary';
      if (lifecycleTimerRef.current) clearTimeout(lifecycleTimerRef.current);
      lifecycleTimerRef.current = setTimeout(() => {
        void reloadAll(actor, { source: reason, target });
      }, reason === 'pageshow' ? 180 : 260);
    }

    function onFocus() {
      scheduleLifecycleReload('focus');
    }
    function onVisibility() {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        scheduleLifecycleReload('visibility');
      }
    }
    function onPageShow(event) {
      scheduleLifecycleReload(event?.persisted ? 'pageshow' : 'pageshow_fresh');
    }
    function onArkaRefresh() {
      void reloadAll(actor, { force: true, source: 'arka_refresh', target: 'all' });
    }

    if (typeof window !== 'undefined') {
      window.addEventListener('focus', onFocus);
      window.addEventListener('pageshow', onPageShow);
      window.addEventListener('arka:refresh', onArkaRefresh);
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibility);
    }

    return () => {
      if (lifecycleTimerRef.current) clearTimeout(lifecycleTimerRef.current);
      clearPostMutationPrimaryTimer();
      if (typeof window !== 'undefined') {
        window.removeEventListener('focus', onFocus);
        window.removeEventListener('pageshow', onPageShow);
        window.removeEventListener('arka:refresh', onArkaRefresh);
      }
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibility);
      }
    };
  }, [actor?.pin, actor?.role]);

  async function fetchSelfMealRowsTodayFromDb() {
    const pin = String(actor?.pin || '').trim();
    if (!pin) return [];
    const bounds = belgradeDayBoundsIso(new Date());
    const select = MANAGER_PAYMENT_SELECT;
    const [createdRes, handedRes] = await Promise.all([
      supabase
        .from('arka_pending_payments')
        .select(select)
        .eq('created_by_pin', pin)
        .gte('created_at', bounds.startIso)
        .lt('created_at', bounds.endIso)
        .order('created_at', { ascending: false })
        .limit(120),
      supabase
        .from('arka_pending_payments')
        .select(select)
        .eq('handed_by_pin', pin)
        .gte('created_at', bounds.startIso)
        .lt('created_at', bounds.endIso)
        .order('created_at', { ascending: false })
        .limit(120),
    ]);
    const error = createdRes?.error || handedRes?.error;
    if (error) throw error;
    return mapUniqueById([...(createdRes?.data || []), ...(handedRes?.data || [])])
      .filter((row) => isWorkerMealRowToday(row, pin))
      .sort(byDateDesc);
  }

  async function getSelfMealRowsTodaySafe() {
    try {
      const dbRows = await fetchSelfMealRowsTodayFromDb();
      if (dbRows.length) return dbRows;
    } catch (err) {
      try { console.warn('[ARKA][MEAL] duplicate check failed, using current snapshot:', err); } catch {}
    }
    return selfMealTodayRows;
  }

  async function openMealForm() {
    const rows = await getSelfMealRowsTodaySafe();
    if (rows.length) {
      setMealFormOpen(false);
      alert(mealTodayAlertText(rows));
      return;
    }
    setMealFormOpen(true);
  }

  async function submitExpense() {
    const title = String(expenseTitle || '').trim() || 'SHPENZIM';
    const amount = parseAmountInput(expenseAmount);
    if (amount <= 0) return alert('🔴 SHKRUAJ SHUMËN E SHPENZIMIT.');
    const request = normalizeWorkerExpenseRequest({
      requestKind: expenseRequestType,
      actorPin: actor?.pin,
      actorName: actor?.name,
      beneficiaryPin: expenseBeneficiaryPin,
      beneficiaryName: expenseBeneficiaryName,
    });
    if (request?.error) return alert(request.error);
    try {
      setBusy('expense');
      await createExpenseEntry({
        actor,
        amount,
        note: buildExpenseRequestNote(title, request),
        workerPin: actor?.pin,
        workerName: actor?.name,
        workerRole: actor?.role,
      });
      setExpenseTitle('');
      setExpenseAmount('');
      setExpenseRequestType('BUSINESS_EXPENSE');
      setExpenseBeneficiaryPin('');
      setExpenseBeneficiaryName('');
      setExpenseFormOpen(false);
      await scheduleManagerMutationRefresh(actor);
      alert('✅ SHPENZIMI U REGJISTRUA SI KËRKESË NË PRITJE.');
    } catch (e) {
      alert(`🔴 ${e?.message || 'NUK U REGJISTRUA SHPENZIMI.'}`);
    } finally {
      setBusy('');
    }
  }

  async function submitMeal() {
    const liveMealRows = await getSelfMealRowsTodaySafe();
    const includeSelf = !!workerSnapshot?.hasTodayBasePayment && liveMealRows.length === 0;
    const selectedWorkers = selectedOpenMealWorkers;
    if (liveMealRows.length) {
      setMealFormOpen(false);
      return alert(mealTodayAlertText(liveMealRows));
    }
    if (!includeSelf && !selectedWorkers.length) {
      if (liveMealRows.length || selfMealCoveredToday) return alert(mealTodayAlertText(liveMealRows.length ? liveMealRows : selfMealTodayRows));
      return alert('🔴 ZGJIDH NJË KOLEG OSE DUHET ME PAS SË PAKU 1 PAGESË BAZË SOT PËR USHQIMIN TËND.');
    }
    if (selectedCoveredMealWorkers.length) {
      const names = selectedCoveredMealWorkers.map((row) => String(row?.name || row?.pin || '').toUpperCase()).filter(Boolean).join(', ');
      return alert(`🔴 KËTA PUNTORË E KANË USHQIMIN E REGJISTRUAR SOT: ${names}`);
    }
    try {
      setBusy('meal');
      await createMealDistributionEntry({
        actor,
        payerPin: actor?.pin,
        payerName: actor?.name,
        payerRole: actor?.role,
        coveredWorkers: selectedWorkers,
        amountPerPerson: FOOD_DEDUCTION,
        includePayerMeal: includeSelf,
        note: 'USHQIM EKIPI',
      });
      setSelectedMealPins([]);
      setMealCoworkersOpen(false);
      setMealFormOpen(false);
      await scheduleManagerMutationRefresh(actor);
      alert('✅ USHQIMI U REGJISTRUA.');
    } catch (e) {
      alert(`🔴 ${e?.message || 'NUK U REGJISTRUA USHQIMI.'}`);
    } finally {
      setBusy('');
    }
  }

  async function submitHandoff() {
    if (busyRef.current) return;
    busyRef.current = 'handoff';
    try {
      const rows = Array.isArray(workerSnapshot?.cashBreakdownRows) ? workerSnapshot.cashBreakdownRows : [];
      const total = n(workerSnapshot?.baseCashForDispatchTotal ?? workerSnapshot?.collectedTotal);
      const grossTotal = n(workerSnapshot?.cashFromClientsTotal ?? workerSnapshot?.collectedGrossTotal ?? workerSnapshot?.collectedTotal);
      const commissionTotal = n(workerSnapshot?.commissionHeldTotal);
      if (!workerSnapshot || total <= 0 || !rows.length) return alert('🔴 NUK KE KLIENTË ME CASH I MARRË PËR DORËZIM.');
      if (n(workerSnapshot?.cashDuplicateTransportCount) > 0) {
        return alert('🔴 U GJET DUPLICATE TRANSPORT CASH. DORËZIMI U NDALUA PËR SIGURI QË MOS TË KRIJOHET HANDOFF I DYFISHTË.');
      }
      const mealDecision = await ensureMealDecisionBeforeHandoff({
        actor,
        workerPin: actor?.pin,
        workerName: actor?.name,
        workerRole: actor?.role,
        staffOptions: mealOptions,
        amountPerPerson: FOOD_DEDUCTION,
      });
      const mealDeduct = n(mealDecision?.deductAmount);
      const estimatedNet = Math.max(0, +(total - mealDeduct).toFixed(2));
      const ok = window.confirm(
        `A DON ME I DORËZU TE DISPATCH ${estimatedNet.toFixed(2)}€?

` +
        `KLIENTËT PAGUAN: ${grossTotal.toFixed(2)}€
` +
        `KOMISIONI YT: ${commissionTotal.toFixed(2)}€
` +
        `${mealDecision?.confirmLine ? `${mealDecision.confirmLine}
` : ''}` +
        `${rows.length} KLIENTË PËR DORËZIM.`
      );
      if (!ok) return;
      setBusy('handoff');
      await submitWorkerCashToDispatch({ actor });
      await scheduleManagerMutationRefresh(actor);
      alert('✅ DORËZIMI U DËRGUA TE DISPATCH.');
    } catch (e) {
      alert(`🔴 ${e?.message || 'NUK U DËRGUA DORËZIMI.'}`);
    } finally {
      busyRef.current = '';
      setBusy('');
    }
  }

  const workerFirstName = String(actor?.name || 'PUNTORIT').trim().split(/\s+/)[0] || 'PUNTORIT';
  const workerCashLines = Array.isArray(workerSnapshot?.cashBreakdownRows) ? workerSnapshot.cashBreakdownRows : [];
  const workerGrossTotal = n(workerSnapshot?.cashFromClientsTotal ?? workerSnapshot?.collectedGrossTotal ?? workerSnapshot?.collectedTotal);
  const workerCommissionTotal = n(workerSnapshot?.commissionHeldTotal);
  const workerBaseForDispatchTotal = n(workerSnapshot?.baseCashForDispatchTotal ?? workerSnapshot?.dueTotal);
  const workerIsHybrid = isHybridWorker(workerSnapshot?.worker || actor || {});
  const todayLabel = (() => {
    const key = formatBelgradeDateKey(new Date());
    if (!key) return '';
    const [y, m, d] = key.split('-');
    return `${d}.${m}.${y}`;
  })();
  const primaryMealTodayRow = selfMealTodayRows[0] || null;

  function handleExpenseBeneficiaryPinChange(value) {
    const cleanPin = String(value || '').trim();
    setExpenseBeneficiaryPin(cleanPin);
    const target = (mealOptions || []).find((row) => String(row?.pin || '').trim() === cleanPin);
    if (target) setExpenseBeneficiaryName(String(target?.name || cleanPin).trim());
  }

  function toggleMealPin(pin) {
    const cleanPin = String(pin || '').trim();
    if (!cleanPin) return;
    const target = (mealOptions || []).find((row) => String(row?.pin || '').trim() === cleanPin);
    if (target && staffMealCoveredToday(target)) {
      alert('🔴 KY PUNTOR E KA TASHMË USHQIMIN E REGJISTRUAR SOT.');
      return;
    }
    setSelectedMealPins((current) => current.includes(cleanPin)
      ? current.filter((item) => item !== cleanPin)
      : [...current, cleanPin]);
  }

  return (
    <div className="arkaSimplePage">
      <div className="arkaSimpleTop">
        <div>
          <div className="arkaSimpleEyebrow">ARKA V3</div>
          <h1 className="arkaSimpleTitle">{canManage ? 'ADMIN / DISPATCH ARKA' : 'ARKA IME E DITËS'}</h1>
          {canManage ? (
            <div className="arkaSimpleSub">KUSH KA CASH, SA DUHET PRANUAR, DHE CILËT KLIENTË JANË BRENDA.</div>
          ) : null}
        </div>
        <div className="arkaSimpleNav">
          <Link href="/" prefetch={false} className="arkaTopBtn">HOME</Link>
          {canOpenKapaku ? <Link href="/arka/kapaku" prefetch={false} className="arkaTopBtn">KAPAKU I ARKËS</Link> : null}
          {canManage ? <Link href="/arka/payroll" prefetch={false} className="arkaTopBtn">PAYROLL</Link> : null}
          {canManage ? <Link href="/arka/stafi" prefetch={false} className="arkaTopBtn">STAFI</Link> : null}
          {canManage ? <Link href="/arka/obligimet" prefetch={false} className="arkaTopBtn">OBLIGIMET</Link> : null}
        </div>
      </div>

      {error ? <div className="arkaLoaderCard">🔴 {error}</div> : null}
      {loading ? <div className="arkaLoaderCard">PO NGARKOHET ARKA...</div> : null}
      {!actor?.pin && !loading ? <div className="arkaLoaderCard">MUNGON SESIONI I PËRDORUESIT.</div> : null}

      {!loading && actor?.pin && isWorker && !canManage && workerSnapshot ? (
        <>
          <div className="arkaHeroSingle arkaHeroMainDue">
            <div>
              <div className="arkaSimpleEyebrow">{String(actor?.name || 'PUNTOR').toUpperCase()} • PIN {actor?.pin || '—'}</div>
              <div className="arkaWorkerName">ARKA IME E DITËS</div>
              <div className="arkaWorkerMeta">DATA: {todayLabel || '—'}</div>
            </div>
            <div className="arkaHeroDueHuge">{euro(workerBaseForDispatchTotal)}</div>
          </div>

          <section className="arkaSectionCard arkaCashListCard">
            <div className="arkaSectionHeadCompact">
              <div>
                <div className="arkaSectionTitle">DORËZO TE DISPATCH</div>
              </div>
              <div className="arkaCashTotalPill">{euro(workerBaseForDispatchTotal)}</div>
            </div>
            {workerIsHybrid ? (
              <>
                <div className="arkaWorkerStats workerOnlyGrid cleanCashGrid">
                  <Stat label="DUHET ME DORËZU NË BAZË" value={euro(workerBaseForDispatchTotal)} tone="strong" />
                  <Stat label="CASH BRUTO NGA KLIENTËT" value={euro(workerGrossTotal)} tone="ok" />
                  <Stat label="KOMISIONI IM I MBAJTUR" value={euro(workerCommissionTotal)} tone="warn" />
                </div>
              </>
            ) : (
              <div className="arkaWorkerStats workerOnlyGrid cleanCashGrid">
                <Stat label="CASH PËR DORËZIM" value={euro(workerBaseForDispatchTotal)} tone="strong" />
              </div>
            )}
          </section>

          <section className="arkaSectionCard arkaCashListCard">
            <button
              type="button"
              onClick={() => {
                if (isClientsSectionOpen) setExpandedWorkerCashLineKey('');
                setIsClientsSectionOpen((v) => !v);
              }}
              style={{
                width: '100%',
                display: 'grid',
                gap: 10,
                textAlign: 'left',
                border: 0,
                background: 'transparent',
                color: 'inherit',
                padding: 0,
                cursor: 'pointer',
              }}
              aria-expanded={isClientsSectionOpen}
            >
              <div className="arkaSectionHeadCompact" style={{ alignItems: 'flex-start', gap: 12 }}>
                <div style={{ minWidth: 0 }}>
                  <div className="arkaSectionTitle">KLIENTËT PËR DORËZIM</div>
                  <div className="arkaSectionSub">{workerCashLines.length} KLIENTË</div>
                </div>
                <div style={{ display: 'grid', justifyItems: 'end', gap: 6, textAlign: 'right' }}>
                  <div className="arkaCashTotalPill">TOTAL PËR BAZË: {euro(workerBaseForDispatchTotal)}</div>
                  <div className="arkaPendingMeta">{isClientsSectionOpen ? 'MBYLL LISTËN ˄' : 'HAP LISTËN ˅'}</div>
                </div>
              </div>
            </button>

            {isClientsSectionOpen ? (
              <>
                <div
                  className="arkaCashCompactDetails"
                  style={{
                    display: 'grid',
                    gap: 8,
                    marginTop: 12,
                    padding: 12,
                    borderRadius: 14,
                  }}
                >
                  <div className="arkaWorkerFoot" style={{ alignItems: 'center', gap: 10 }}>
                    <span>Cash bruto nga klientët</span>
                    <b>{euro(workerGrossTotal)}</b>
                  </div>
                  <div className="arkaWorkerFoot" style={{ alignItems: 'center', gap: 10 }}>
                    <span>Komisioni im</span>
                    <b>{euro(workerCommissionTotal)}</b>
                  </div>
                  <div className="arkaWorkerFoot" style={{ alignItems: 'center', gap: 10 }}>
                    <span>Për bazë</span>
                    <b>{euro(workerBaseForDispatchTotal)}</b>
                  </div>
                </div>

                <div className="arkaCashCompactList" style={{ marginTop: 10, display: 'grid', gap: 8 }}>
                  {workerCashLines.length ? workerCashLines.map((row, index) => {
                    const rowKey = String(row?.id || row?.raw?.id || row?.payment_id || row?.created_at || row?.raw?.created_at || index);
                    const isOpen = expandedWorkerCashLineKey === rowKey;
                    const code = String(row?.code || cashOrderCode(row?.raw || row) || '—').toUpperCase();
                    const client = String(row?.clientName || row?.client_name || 'KLIENT').toUpperCase();
                    const paidAt = fmtPaymentStamp(row?.created_at || row?.raw?.created_at) || fmtDate(row?.created_at || row?.raw?.created_at) || '—';
                    return (
                      <div
                        key={`cash_collected_${rowKey}`}
                        className="arkaPendingRow"
                        style={{
                          alignItems: 'stretch',
                          flexDirection: 'column',
                          gap: isOpen ? 10 : 8,
                          padding: 12,
                          borderRadius: 16,
                        }}
                      >
                        <button
                          type="button"
                          onClick={() => setExpandedWorkerCashLineKey(isOpen ? '' : rowKey)}
                          style={{
                            width: '100%',
                            display: 'grid',
                            gap: 8,
                            textAlign: 'left',
                            border: 0,
                            background: 'transparent',
                            color: 'inherit',
                            padding: 0,
                            cursor: 'pointer',
                          }}
                          aria-expanded={isOpen}
                        >
                          <div style={{ display: 'grid', gap: 8 }}>
                            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, minWidth: 0 }}>
                              <span
                                className="arkaCashTotalPill"
                                style={{
                                  flex: '0 0 auto',
                                  display: 'inline-flex',
                                  padding: '3px 8px',
                                  fontSize: 12,
                                  lineHeight: 1.1,
                                  maxWidth: '42%',
                                }}
                              >
                                {code}
                              </span>
                              <span
                                className="arkaPendingName"
                                style={{
                                  minWidth: 0,
                                  flex: 1,
                                  whiteSpace: 'normal',
                                  overflow: 'hidden',
                                  display: '-webkit-box',
                                  WebkitLineClamp: 2,
                                  WebkitBoxOrient: 'vertical',
                                  lineHeight: 1.2,
                                  fontSize: 14,
                                }}
                              >
                                {client}
                              </span>
                            </div>
                            <div className="arkaWorkerFoot" style={{ alignItems: 'flex-end', gap: 10 }}>
                              <span className="arkaPendingMeta">PËR BAZË</span>
                              <b style={{ fontSize: 20, lineHeight: 1, whiteSpace: 'nowrap' }}>{euro(row?.baseAmount)}</b>
                            </div>
                            <div className="arkaWorkerFoot" style={{ alignItems: 'center', paddingTop: 2 }}>
                              <span className="arkaPendingMeta">{isOpen ? 'MBYLL DETAJET' : 'SHIKO DETAJET'}</span>
                              <span className="arkaPendingMeta" aria-hidden="true">{isOpen ? '˄' : '˅'}</span>
                            </div>
                          </div>
                        </button>
                        {isOpen ? (
                          <div
                            className="arkaCashCompactDetails"
                            style={{
                              display: 'grid',
                              gap: 8,
                              marginTop: 2,
                              padding: 10,
                              borderRadius: 14,
                            }}
                          >
                            <div>
                              <div className="arkaPendingMeta">PAGUAR</div>
                              <div className="arkaPendingName" style={{ fontSize: 13 }}>{paidAt}</div>
                            </div>
                            <div className="arkaWorkerFoot" style={{ alignItems: 'center' }}>
                              <span>Cash bruto</span>
                              <b>{euro(row?.gross)}</b>
                            </div>
                            {workerIsHybrid ? (
                              <div className="arkaWorkerFoot" style={{ alignItems: 'center' }}>
                                <span>Komisioni im</span>
                                <b>{euro(row?.commission)}</b>
                              </div>
                            ) : null}
                            <div className="arkaWorkerFoot" style={{ alignItems: 'center' }}>
                              <span>Për bazë</span>
                              <b>{euro(row?.baseAmount)}</b>
                            </div>
                          </div>
                        ) : null}
                      </div>
                    );
                  }) : <div className="arkaEmpty">S’KA KLIENTË ME CASH I MARRË PËR DORËZIM.</div>}
                </div>
              </>
            ) : null}
          </section>

          <section className="arkaSectionCard">
            <div className="arkaSectionHeadCompact">
              <div>
                <div className="arkaSectionTitle">SHPENZIMET E HAPURA</div>
              </div>
              <div className="arkaCashTotalPill">{euro(workerOpenExpenseTotal)}</div>
            </div>
            {workerOpenExpenseRows.length ? workerOpenExpenseRows.map((row) => (
              <div key={`open_expense_${row.id}`} className="arkaHistoryRow" style={{ alignItems: 'flex-start' }}>
                <div>
                  <div className="arkaHistoryTitle">{euro(row?.amount)} — {readableArkaStatus(row?.status)}</div>
                  <div className="arkaHistoryMeta">{cleanWorkerExpenseNote(row)}</div>
                  <div className="arkaHistoryMeta">Propozuar si: {workerExpenseProposal(row)}</div>
                  <div className="arkaHistoryMeta">{fmtPaymentStamp(row?.created_at) || fmtDate(row?.created_at)}</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div className="arkaHistoryMeta warn">{readableArkaStatus(row?.status)}</div>
                </div>
              </div>
            )) : <div className="arkaEmpty">Nuk ka shpenzime të hapura.</div>}
            <div className="arkaWorkerFoot" style={{ marginTop: 12 }}>
              <span>TOTAL SHPENZIME TË HAPURA: {euro(workerOpenExpenseTotal)}</span>
            </div>
          </section>

          <section className="arkaSectionCard">
            <div className="arkaSectionHeadCompact">
              <div>
                <div className="arkaSectionTitle">USHQIMI SOT</div>
              </div>
              <div className={`arkaCashTotalPill ${selfMealCoveredToday ? 'ok' : ''}`}>{selfMealCoveredToday ? 'REGJISTRUAR' : 'PA USHQIM'}</div>
            </div>
            {selfMealCoveredToday ? (
              <div className="arkaPendingRow" style={{ alignItems: 'stretch', flexDirection: 'column', gap: 8 }}>
                <div className="arkaPendingName">REGJISTRUAR</div>
                <div className="arkaPendingMeta">{euro(primaryMealTodayRow?.amount)} — {fmtPaymentStamp(primaryMealTodayRow?.created_at || primaryMealTodayRow?.handed_at) || fmtDate(primaryMealTodayRow?.created_at || primaryMealTodayRow?.handed_at)} — {readableArkaStatus(primaryMealTodayRow?.status)}</div>
                <div className="arkaPendingMeta">{cleanExpenseRequestBaseNote(primaryMealTodayRow?.note || '') || primaryMealTodayRow?.note || 'USHQIM'}</div>
              </div>
            ) : <div className="arkaEmpty">USHQIMI NUK ËSHTË REGJISTRUAR SOT.</div>}
          </section>

          <div className="arkaSectionCard" style={{ display: 'grid', gap: 10 }}>
            <button type="button" className="arkaSolidBtn big arkaMainHandoffBtn" disabled={!!busy || workerBaseForDispatchTotal <= 0 || n(workerSnapshot?.cashDuplicateTransportCount) > 0} onClick={submitHandoff}>{busy === 'handoff' ? '...' : `DORËZO TE DISPATCH — ${euro(workerBaseForDispatchTotal)}`}</button>
            {n(workerSnapshot?.cashDuplicateTransportCount) > 0 ? <div className="arkaReviewWarn">U gjet duplicate transport cash. Dorëzimi u ndalua për siguri.</div> : null}
            <button type="button" className="arkaTopBtn" disabled={!!busy} onClick={() => setExpenseFormOpen((v) => !v)}>{expenseFormOpen ? 'MBYLL SHPENZIMIN' : 'SHTO SHPENZIM'}</button>
            <button type="button" className="arkaTopBtn" disabled={!!busy || selfMealCoveredToday} onClick={openMealForm}>{selfMealCoveredToday ? 'USHQIMI U REGJISTRUA SOT' : 'SHTO USHQIM'}</button>
          </div>

          {expenseFormOpen ? (
            <div className="arkaActionPanel">
              <div className="arkaActionHeader">SHTO SHPENZIM</div>
              <div className="arkaSimpleSub">PUNTORI VETËM PROPOZON TIPIN. ADMIN / DISPATCH E KONFIRMON VENDIMIN FINAL.</div>
              <div className="arkaInlineForm">
                <input className="arkaField" value={expenseTitle} onChange={(e) => setExpenseTitle(e.target.value)} placeholder="P.SH. NAFTË / PARKING" />
                <input className="arkaField small" inputMode="decimal" value={expenseAmount} onChange={(e) => setExpenseAmount(e.target.value)} placeholder="20" />
              </div>
              <div className="arkaExpenseRequestGrid">
                <button type="button" className={`arkaExpenseRequestBtn ${expenseRequestType === 'BUSINESS_EXPENSE' ? 'active' : ''}`} disabled={!!busy} onClick={() => setExpenseRequestType('BUSINESS_EXPENSE')}>BIZNES</button>
                <button type="button" className={`arkaExpenseRequestBtn ${expenseRequestType === 'PERSONAL_SELF' ? 'active warn' : ''}`} disabled={!!busy} onClick={() => setExpenseRequestType('PERSONAL_SELF')}>PERSONAL PËR VETE</button>
                <button type="button" className={`arkaExpenseRequestBtn ${expenseRequestType === 'PERSONAL_OTHER' ? 'active warn' : ''}`} disabled={!!busy} onClick={() => setExpenseRequestType('PERSONAL_OTHER')}>PERSONAL PËR DIKË TJETËR</button>
              </div>
              {expenseRequestType === 'PERSONAL_OTHER' ? (
                <div className="arkaExpenseBeneficiaryGrid">
                  <div>
                    <label>PIN I PERSONIT</label>
                    <input className="arkaField" list="arka_self_expense_beneficiaries" value={expenseBeneficiaryPin} onChange={(e) => handleExpenseBeneficiaryPinChange(e.target.value)} placeholder="P.SH. 2020" />
                    <datalist id="arka_self_expense_beneficiaries">
                      {(mealOptions || []).map((row) => <option key={String(row?.pin || '')} value={String(row?.pin || '')}>{row?.name || row?.pin}</option>)}
                    </datalist>
                  </div>
                  <div>
                    <label>EMRI</label>
                    <input className="arkaField" value={expenseBeneficiaryName} onChange={(e) => setExpenseBeneficiaryName(e.target.value)} placeholder="P.SH. SHKENDIE" />
                  </div>
                </div>
              ) : null}
              {expenseRequestType === 'PERSONAL_SELF' ? <div className="arkaExpenseWarning warn">KËRKESA DO RUAHET SI PERSONAL / AVANS PËR TY.</div> : null}
              {expenseRequestType === 'BUSINESS_EXPENSE' ? <div className="arkaExpenseWarning ok">KËRKESA DO RUAHET SI SHPENZIM BIZNESI.</div> : null}
              <div className="arkaWorkerFoot" style={{ marginTop: 12 }}>
                <span>{expenseRequestType === 'PERSONAL_OTHER' ? 'PERSONAL / AVANS PËR PERSON TJETËR' : expenseRequestType === 'PERSONAL_SELF' ? 'PERSONAL / AVANS PËR VETE' : 'BIZNES'}</span>
                <button type="button" className="arkaSolidBtn" disabled={!!busy} onClick={submitExpense}>{busy === 'expense' ? '...' : '+ SHTO'}</button>
              </div>
            </div>
          ) : null}

          {mealFormOpen && !selfMealCoveredToday ? (
            <div className="arkaActionPanel">
              <div className="arkaActionHeader">USHQIMI I DITËS</div>
              <div className="arkaSimpleSub">3€ PËR PERSON. NUK LEJOHET DY HERË PËR TË NJËJTËN DITË.</div>
              <div className="arkaWorkerFoot muted" style={{ marginTop: 8 }}>
                <span>USHQIMI YT: {workerSnapshot.hasTodayBasePayment ? 'GATI PËR RUAJTJE' : 'KËRKON PAGESË BAZË SOT'}</span>
                <button type="button" className="arkaTopBtn" disabled={!!busy} onClick={() => setMealCoworkersOpen((v) => !v)}>{mealCoworkersOpen ? 'MBYLLE KOLEGËT' : '+ SHTO USHQIM PËR KOLEG'}</button>
              </div>
              {mealCoworkersOpen ? (
                <>
                  <div style={{ display: 'grid', gap: 8, marginTop: 12 }}>
                    {mealOptions.length ? mealOptions.map((row) => { const pin = String(row?.pin || '').trim(); const checked = selectedMealPins.includes(pin); const alreadyCovered = staffMealCoveredToday(row); return (<label key={pin} className="arkaPendingRow" style={{ cursor: alreadyCovered ? 'not-allowed' : 'pointer', opacity: alreadyCovered ? 0.55 : 1 }}><div><div className="arkaPendingName">{String(row?.name || pin).toUpperCase()}</div><div className="arkaPendingMeta">PIN {pin} • {row?.active_today ? 'AKTIV SOT' : 'JO AKTIV SOT'}{alreadyCovered ? ' • USHQIMI U REGJISTRUA SOT' : ''}</div></div><div className="arkaPendingRight"><input type="checkbox" disabled={alreadyCovered} checked={checked && !alreadyCovered} onChange={() => toggleMealPin(pin)} /></div></label>); }) : <div className="arkaEmpty">S’KA KOLEGË PËR T’U PËRFSHIRË.</div>}
                  </div>
                  <div className="arkaWorkerFoot" style={{ marginTop: 12 }}><span>TË ZGJEDHUR: {selectedOpenMealWorkers.length}</span><span>{selectedCoveredMealWorkers.length ? `TË BLLOKUAR: ${selectedCoveredMealWorkers.length}` : ''}</span></div>
                </>
              ) : null}
              <div className="arkaWorkerFoot" style={{ marginTop: 12 }}>
                <span>{mealSubmitPeopleCount ? `${mealSubmitPeopleCount} PERSONA` : 'ASNJË PËR RUAJTJE'}</span>
                <button type="button" className="arkaSolidBtn" disabled={!!busy || mealSubmitPeopleCount <= 0} onClick={submitMeal}>{busy === 'meal' ? '...' : `${selectedOpenMealWorkers.length ? 'RUAJ USHQIMIN' : 'RUAJ USHQIMIN TIM'} • ${euro(mealSubmitTotal)}`}</button>
              </div>
            </div>
          ) : null}

          <div className="arkaAdvancedDetails">
            <button
              type="button"
              className="arkaAdvancedSummary"
              onClick={() => setHistoryOpen((v) => !v)}
              style={{ width: '100%', textAlign: 'left' }}
            >
              {historyOpen ? 'MBYLL HISTORINË / DETAJET' : 'HAP HISTORINË / DETAJET'}
            </button>
            {historyOpen ? (
              <ArkaHistoryPanel
                canManage={false}
                actor={actor}
                dateKey={historyDateKey}
                selectedWorkerPin={String(actor?.pin || '')}
                workerOptions={historyWorkerOptions}
                loading={historyLoading}
                error={historyError}
                groups={historyGroups}
                datePickerOpen={historyDatePickerOpen}
                onSetDateKey={setHistoryDateKey}
                onSetSelectedWorkerPin={setHistoryWorkerPin}
                onToggleDatePicker={() => setHistoryDatePickerOpen((v) => !v)}
              />
            ) : null}
          </div>
        </>
      ) : null}

      {cashAcceptReview ? (
        <CashAcceptReviewModal
          review={cashAcceptReview}
          busy={busy === 'accept_cash_review' ? busy : ''}
          onCancel={() => { if (!busy) setCashAcceptReview(null); }}
          onConfirm={confirmCashAcceptReview}
        />
      ) : null}

      {!loading && actor?.pin && canManage ? (
        <>
          <div className="arkaWorkerStats adminTopGrid ownerTotalsGrid">
            <Stat label="NË DORË TE SHOFERËT" value={euro(totals.remainingToHandover)} tone="strong" />
            <Stat label="PËR PRANIM" value={euro(totals.pendingHandoffTotal)} tone="info" />
            <Stat label="PRANUAR SOT" value={euro(totals.acceptedTodayTotal)} tone="ok" />
            <Stat label="PËR BAZË / PËR DORËZIM" value={euro(totals.cashFromClientsTotal)} tone="ok" />
            <Stat label="HISTORI PRANUAR" value={euro(totals.acceptedHistoryTotal)} tone="neutral" />
            <Stat label="KOMISION SHOFERËT" value={euro(totals.commissionHeldTotal)} tone="warn" />
          </div>

          <div className="arkaAdvancedDetails" style={{ marginBottom: 14 }}>
            <button
              type="button"
              className="arkaAdvancedSummary"
              onClick={() => setHistoryOpen((v) => !v)}
              style={{ width: '100%', textAlign: 'left' }}
            >
              {historyOpen ? 'MBYLL HISTORINË / DETAJET' : 'HAP HISTORINË / DETAJET'}
            </button>
            {historyOpen ? (
              <ArkaHistoryPanel
                canManage={true}
                actor={actor}
                dateKey={historyDateKey}
                selectedWorkerPin={historyWorkerPin}
                workerOptions={historyWorkerOptions}
                loading={historyLoading}
                error={historyError}
                groups={historyGroups}
                datePickerOpen={historyDatePickerOpen}
                onSetDateKey={setHistoryDateKey}
                onSetSelectedWorkerPin={setHistoryWorkerPin}
                onToggleDatePicker={() => setHistoryDatePickerOpen((v) => !v)}
              />
            ) : null}
          </div>

          <div className="arkaSplitGrid">
            <section className="arkaSectionCard">
              <div className="arkaSectionHeadCompact">
                <div>
                  <div className="arkaSectionTitle">NË DORË TE SHOFERËT</div>
                  <div className="arkaSectionSub">SHOFER • TOTAL • KLIENTË</div>
                </div>
                <button type="button" className="arkaTopBtn" onClick={() => reloadAll(actor, { force: true, source: 'manual', target: 'all' })}>REFRESH</button>
              </div>
              <div className="arkaWorkerList">
                {workerCards.length ? workerCards.map((item) => (
                  <ArkaPanelBoundary key={item?.worker?.pin || item?.worker?.id} name="ArkaWorkerSummaryCard">
                    <WorkerSummaryCard item={item} busy={busy} onAcceptCash={acceptWorkerCashFromCard} onAddExpense={addWorkerExpenseFromCard} onAddAdvance={addWorkerAdvanceFromCard} />
                  </ArkaPanelBoundary>
                )) : <div className="arkaEmpty">S’KA PUNTORË AKTIVË.</div>}
              </div>
            </section>

            <section className="arkaSectionCard sideRail">
              <div className="arkaSectionTitle">DORËZIME PËR PRANIM</div>
              <div className="arkaSectionSub">DORËZIME TË DËRGUARA NGA SHOFERËT.</div>
              {secondaryLoading ? <div className="arkaEmpty">PO NGARKOHET PANELI ANËSOR...</div> : null}
              {!secondaryLoading && pendingHandoffs.length ? pendingHandoffs.map((row) => (
                <ArkaPanelBoundary key={row.id} name="ArkaPendingHandoffRow">
                  <PendingHandoffRow row={row} actor={actor} workerSummary={workerCardsByPin.get(String(row?.worker_pin || '').trim())} onReviewAccept={acceptWorkerCashFromCard} onDone={handlePendingHandoffDone} />
                </ArkaPanelBoundary>
              )) : null}
              {!secondaryLoading && !pendingHandoffs.length ? <div className="arkaEmpty">S’KA DORËZIME NË PRITJE.</div> : null}

              <div className="arkaSectionDivider" />

              <div className="arkaSectionTitle">SHPENZIME NË PRITJE</div>
              {!secondaryLoading && pendingExpenseApprovals.length ? pendingExpenseApprovals.map((row) => (
                <ArkaPanelBoundary key={row.id} name="ArkaPendingExpenseRow">
                  <PendingExpenseRow row={row} actor={actor} beneficiaryOptions={workerCards.map((item) => item?.worker).filter(Boolean)} onDone={handlePendingExpenseDone} />
                </ArkaPanelBoundary>
              )) : null}
              {!secondaryLoading && !pendingExpenseApprovals.length ? <div className="arkaEmpty">S’KA SHPENZIME NË PRITJE.</div> : null}
            </section>
          </div>
        </>
      ) : null}
    </div>
  );
}
