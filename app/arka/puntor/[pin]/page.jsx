'use client';

import Link from '@/lib/routerCompat.jsx';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter } from '@/lib/routerCompat.jsx';
import { getActor } from '@/lib/actorSession';
import { supabase } from '@/lib/supabaseClient';
import { fetchSessionUserByPin } from '@/lib/usersService';
import {
  createTimaEntry,
  createMealDistributionEntry,
  createExpenseEntry,
  deleteWorkerExtraEntry,
  listMealStaffOptions,
} from '@/lib/arkaService';
import { listWorkerDebtRows, submitWorkerCashToDispatch } from '@/lib/corporateFinance';
import {
  buildWorkerArkaSummary,
  mealCoveredByLabel,
  fetchWorkerOrdersFallbackRaw,
  buildWorkerOrderFallbackRows,
  readWorkerOrderAmount,
} from '@/lib/arkaWorkerSummary';
import useRouteAlive from '@/lib/routeAlive';
import { bootLog } from '@/lib/bootLog';

const MONEY = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function euro(v) {
  return `€${MONEY.format(Number(v || 0) || 0)}`;
}

function n(v) {
  const x = Number(v || 0);
  return Number.isFinite(x) ? x : 0;
}

function safeUpper(v) {
  return String(v || '').trim().toUpperCase();
}

function parseAmountInput(v) {
  const raw = String(v ?? '').trim().replace(/\s/g, '').replace(',', '.');
  return n(raw);
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

function isToday(v) {
  return String(v || '').slice(0, 10) === new Date().toISOString().slice(0, 10);
}

function sortRowsDesc(rows = []) {
  return (Array.isArray(rows) ? rows : [])
    .slice()
    .sort((a, b) => String(b?.created_at || b?.submitted_at || b?.decided_at || b?.updated_at || '').localeCompare(String(a?.created_at || a?.submitted_at || a?.decided_at || a?.updated_at || '')));
}

function Stat({ label, value, tone = 'neutral' }) {
  return (
    <div className={`arkaMiniStat ${tone}`}>
      <div className="arkaMiniStatLabel">{label}</div>
      <div className="arkaMiniStatValue">{value}</div>
    </div>
  );
}

function PaymentTitle(row) {
  const code = row?.order_code != null && row?.order_code !== '' ? `#${row.order_code}` : '';
  const client = String(row?.client_name || '').trim();
  const type = safeUpper(row?.type || 'PAGESË');
  if (client) return `${client.toUpperCase()}${code ? ` • ${code}` : ''}`;
  if (code) return `PAGESË ${code}`;
  return type || 'PAGESË';
}

function typeLabel(row) {
  const type = safeUpper(row?.type || 'ORDER');
  if (type === 'TRANSPORT') return 'T-KOD';
  return 'BAZË';
}

const EXTRA_TYPES = ['TIMA', 'EXPENSE', 'MEAL_PAYMENT', 'MEAL_COVERED'];
const OPEN_PAYMENT_STATUSES = new Set(['PENDING', 'COLLECTED']);
const OPEN_FOR_DISPATCH_STATUSES = new Set(['PENDING', 'COLLECTED']);
const ACCEPTED_HISTORY_STATUSES = new Set(['ACCEPTED_BY_DISPATCH', 'APPROVED', 'ACCEPTED']);
const CLOSED_OR_REJECTED_PAYMENT_STATUSES = new Set(['ACCEPTED_BY_DISPATCH', 'APPROVED', 'ACCEPTED', 'REJECTED', 'REFUZUAR', 'OWED', 'WORKER_DEBT', 'ADVANCE']);
const CASH_ACCOUNTABILITY_STATUSES = new Set(['COLLECTED', 'ACCEPTED_BY_DISPATCH', 'APPROVED']);
const TRANSPORT_COMMISSION_DONE_STATUSES = new Set(['DONE', 'DELIVERED', 'DORZUAR', 'DOREZUAR', 'DORËZUAR']);

function buildEmptyWorkerSummary() {
  return {
    collectedTotal: 0, pendingTotal: 0, expenseTotal: 0, mealPaymentTotal: 0, mealFromExpensesTotal: 0, mealSelfTotal: 0, mealCoveredTotal: 0, timaTotal: 0, deliveredTodayTotal: 0, deliveredEarlierTotal: 0, deliveredTotal: 0, toHandoverToday: 0, toHandoverWithPending: 0, advancesTotal: 0, debtTotal: 0, activityBaseToday: false, collectedRows: [], pendingRows: [], baseCollectedRows: [], basePendingRows: [], transportCollectedRows: [], transportPendingRows: [], expenseRows: [], expenseOnlyRows: [], expenseMealRows: [], timaRows: [], mealPaymentRows: [], mealCoveredRows: [], deliveredRows: [], deliveredTodayRows: [], deliveredEarlierRows: [], transportCodeRows: [], isHybridTransport: false, commissionRateM2: 0.5, transportCollectedM2: 0, transportPendingM2: 0, hybridCommissionCollected: 0, hybridCommissionWithPending: 0, hybridBaseShareCollected: 0, hybridBaseShareWithPending: 0,
  };
}

function readOrderAmount(row) {
  return readWorkerOrderAmount(row);
}

function isOpenRealPaymentRow(row) {
  const type = safeUpper(row?.type);
  const status = safeUpper(row?.status);
  if (EXTRA_TYPES.includes(type)) return false;
  if (['OWED', 'REJECTED', 'WORKER_DEBT', 'ADVANCE'].includes(status)) return false;
  return OPEN_PAYMENT_STATUSES.has(status);
}

function isStrictTransportCashPayment(row) {
  return safeUpper(row?.type) === 'TRANSPORT' && safeUpper(row?.source_module || row?.sourceModule) === 'TRANSPORT';
}

function cleanPaymentCode(row) {
  const transportCode = extractTransportCodeCandidate(row);
  if (transportCode) return transportCode;
  return String(row?.order_code || row?.code || row?.client_code || row?.raw_order_id || '—').trim().toUpperCase() || '—';
}

function isTransportPaymentRow(row) {
  const sourceModule = safeUpper(row?.source_module || row?.sourceModule);
  const type = safeUpper(row?.type);
  if (sourceModule === 'TRANSPORT' || type === 'TRANSPORT') return true;
  if (String(row?.transport_order_id || row?.transportOrderId || '').trim()) return true;
  if (extractTransportCodeCandidate(row)) return true;
  return false;
}

function isRealCashPayment(row) {
  const type = safeUpper(row?.type);
  const status = safeUpper(row?.status);
  if (EXTRA_TYPES.includes(type)) return false;
  if (CLOSED_OR_REJECTED_PAYMENT_STATUSES.has(status) && !ACCEPTED_HISTORY_STATUSES.has(status)) return false;
  return n(row?.amount) > 0;
}

function paymentBelongsToPin(row, targetPin) {
  const cleanPin = String(targetPin || '').trim();
  if (!cleanPin) return true;
  const pinFields = [
    row?.created_by_pin,
    row?.handed_by_pin,
    row?.worker_pin,
  ].map((value) => String(value || '').trim()).filter(Boolean);
  if (!pinFields.length) return true;
  return pinFields.includes(cleanPin);
}

function isOpenForDispatch(row, targetPin) {
  const status = safeUpper(row?.status);
  if (!OPEN_FOR_DISPATCH_STATUSES.has(status)) return false;
  if (ACCEPTED_HISTORY_STATUSES.has(status)) return false;
  if (['REJECTED', 'REFUZUAR', 'OWED', 'WORKER_DEBT', 'ADVANCE'].includes(status)) return false;
  if (!isRealCashPayment(row)) return false;
  return paymentBelongsToPin(row, targetPin);
}

function isAcceptedHistory(row, targetPin) {
  const status = safeUpper(row?.status);
  if (!ACCEPTED_HISTORY_STATUSES.has(status)) return false;
  if (!isRealCashPayment(row)) return false;
  return paymentBelongsToPin(row, targetPin);
}

function findTransportMetaForPayment(row, transportOrdersById = {}) {
  const map = transportOrdersById && typeof transportOrdersById === 'object' ? transportOrdersById : {};
  const id = String(row?.transport_order_id || row?.transportOrderId || '').trim();
  const code = extractTransportCodeCandidate(row);
  return (id && map[id]) || (code && map[`CODE:${code}`]) || (code && map[`TCODE:${code}`]) || null;
}

function readPaymentTransportM2(row, transportOrdersById = {}) {
  const data = row?.data || {};
  const pay = data?.pay || {};
  const totals = data?.totals || {};
  const meta = findTransportMetaForPayment(row, transportOrdersById);
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

function readPaymentClientName(row) {
  return String(row?.client_name || row?.client?.name || row?.data?.client_name || row?.data?.client?.name || row?.note || 'KLIENT').trim();
}

function buildCashDueRow(row, { transportOrdersById = {}, commissionRateM2 = 0.5 } = {}) {
  const isTransport = isTransportPaymentRow(row);
  const gross = n(row?.amount);
  const m2 = isTransport ? readPaymentTransportM2(row, transportOrdersById) : 0;
  const commission = isTransport ? +(m2 * n(commissionRateM2)).toFixed(2) : 0;
  const dueToBase = Math.max(0, +(gross - commission).toFixed(2));
  return {
    raw: row,
    id: row?.id || `${cleanPaymentCode(row)}_${row?.created_at || row?.updated_at || row?.amount || ''}`,
    code: cleanPaymentCode(row),
    clientName: readPaymentClientName(row),
    type: isTransport ? 'TRANSPORT' : 'BAZË',
    status: safeUpper(row?.status || 'PAGESË'),
    gross,
    m2,
    commission,
    dueToBase,
    created_at: row?.created_at || row?.updated_at || row?.handed_at || null,
  };
}


function paymentGroupKey(row) {
  return [
    safeUpper(row?.code || '—'),
    safeUpper(row?.clientName || 'KLIENT'),
    safeUpper(row?.type || 'BAZË'),
    safeUpper(row?.status || 'PAGESË'),
    n(row?.gross).toFixed(2),
  ].join('|');
}

function buildPaymentDisplayGroups(rows = []) {
  const groups = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const key = paymentGroupKey(row);
    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
      existing.rows.push(row);
      existing.gross = +(n(existing.gross) + n(row?.gross)).toFixed(2);
      existing.m2 = +(n(existing.m2) + n(row?.m2)).toFixed(2);
      existing.commission = +(n(existing.commission) + n(row?.commission)).toFixed(2);
      existing.dueToBase = +(n(existing.dueToBase) + n(row?.dueToBase)).toFixed(2);
      const created = row?.created_at || null;
      if (created && (!existing.firstCreatedAt || String(created) < String(existing.firstCreatedAt))) existing.firstCreatedAt = created;
      if (created && (!existing.lastCreatedAt || String(created) > String(existing.lastCreatedAt))) existing.lastCreatedAt = created;
    } else {
      groups.set(key, {
        ...row,
        key,
        count: 1,
        rows: [row],
        firstCreatedAt: row?.created_at || null,
        lastCreatedAt: row?.created_at || null,
      });
    }
  }
  return [...groups.values()];
}

function dateFromValue(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function isWithinLastDays(v, days) {
  const d = dateFromValue(v);
  if (!d) return false;
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  return diff >= 0 && diff <= Number(days || 0) * 24 * 60 * 60 * 1000;
}

function isCurrentMonth(v) {
  const d = dateFromValue(v);
  if (!d) return false;
  const now = new Date();
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
}

function isApprovedTodayExpense(row, targetPin) {
  const type = safeUpper(row?.type);
  if (!['EXPENSE', 'MEAL_PAYMENT'].includes(type)) return false;
  if (!ACCEPTED_HISTORY_STATUSES.has(safeUpper(row?.status))) return false;
  if (!paymentBelongsToPin(row, targetPin)) return false;
  if (!isToday(row?.created_at || row?.handed_at || row?.updated_at)) return false;
  return n(row?.amount) > 0;
}

function isCashAccountabilityRow(row, targetPin) {
  const type = safeUpper(row?.type);
  const status = safeUpper(row?.status);
  const createdByPin = String(row?.created_by_pin || '').trim();
  if (targetPin && createdByPin && createdByPin !== String(targetPin || '').trim()) return false;
  if (EXTRA_TYPES.includes(type)) return false;
  if (['OWED', 'REJECTED', 'WORKER_DEBT', 'ADVANCE'].includes(status)) return false;
  return CASH_ACCOUNTABILITY_STATUSES.has(status);
}

function firstPositiveNumber(...values) {
  for (const value of values) {
    const parsed = n(value);
    if (parsed > 0) return parsed;
  }
  return 0;
}

function readTransportOrderM2(row) {
  const data = row?.data || {};
  const pay = data?.pay || {};
  const totals = data?.totals || {};
  return firstPositiveNumber(
    row?.m2_total,
    row?.total_m2,
    row?.m2,
    data?.m2_total,
    data?.total_m2,
    data?.m2,
    pay?.m2_total,
    pay?.m2,
    totals?.m2_total,
    totals?.total_m2,
    totals?.m2,
    totals?.area
  );
}

function readTransportOrderCode(row) {
  const data = row?.data || {};
  const direct = [
    row?.code_str,
    row?.client_tcode,
    row?.transport_code_str,
    row?.transport_code,
    row?.t_code,
    row?.tcode,
    data?.code_str,
    data?.client_tcode,
    data?.client?.tcode,
    data?.transport_code,
    data?.t_code,
    data?.tcode,
  ]
    .map((value) => String(value || '').trim().toUpperCase())
    .find((value) => /^T\d+$/.test(value));
  if (direct) return direct;
  const raw = `${String(row?.order_code || '')} ${String(row?.note || '')} ${String(row?.client_name || '')} ${String(data?.client_name || '')}`.toUpperCase();
  const match = raw.match(/\bT\d+\b/);
  return match?.[0] || '';
}

function readTransportOrderClientName(row) {
  const data = row?.data || {};
  return String(
    row?.client_name ||
    data?.client_name ||
    data?.client?.name ||
    data?.name ||
    'TRANSPORT'
  ).trim();
}

function workerMatchesTransportOrder(row, targetPin, workerId) {
  const data = row?.data || {};
  const cleanPin = String(targetPin || '').trim();
  const cleanWorkerId = String(workerId || '').trim();
  const pinFields = [
    row?.driver_pin,
    row?.transport_pin,
    data?.driver_pin,
    data?.transport_pin,
    data?.assigned_driver_pin,
    data?.driver?.pin,
    data?.transport?.pin,
  ].map((value) => String(value || '').trim()).filter(Boolean);
  const idFields = [
    row?.assigned_driver_id,
    row?.transport_id,
    row?.driver_id,
    data?.assigned_driver_id,
    data?.transport_id,
    data?.driver_id,
    data?.driver?.id,
    data?.transport?.id,
  ].map((value) => String(value || '').trim()).filter(Boolean);

  if (cleanPin && pinFields.includes(cleanPin)) return true;
  if (cleanWorkerId && idFields.includes(cleanWorkerId)) return true;
  return false;
}

function uniqById(rows = []) {
  const map = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const key = String(row?.id || row?.external_id || row?.created_at || '').trim();
    if (!key) continue;
    map.set(key, row);
  }
  return [...map.values()];
}

function cleanErrorMessage(error, label) {
  const msg = String(error?.message || error?.details || error?.hint || error || '').trim();
  return label ? `${label}: ${msg || 'Gabim i panjohur'}` : (msg || 'Gabim i panjohur');
}

async function fetchWorkerPendingPaymentsRaw(pin, limit = 300) {
  const cleanPin = String(pin || '').trim();
  if (!cleanPin) return [];
  const { data, error } = await supabase
    .from('arka_pending_payments')
    .select('*')
    .eq('created_by_pin', cleanPin)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

async function fetchWorkerExtrasRaw(pin, limit = 200) {
  const cleanPin = String(pin || '').trim();
  if (!cleanPin) return [];
  const [createdRes, targetedRes] = await Promise.all([
    supabase
      .from('arka_pending_payments')
      .select('*')
      .in('type', EXTRA_TYPES)
      .eq('created_by_pin', cleanPin)
      .order('created_at', { ascending: false })
      .limit(limit),
    supabase
      .from('arka_pending_payments')
      .select('*')
      .in('type', EXTRA_TYPES)
      .eq('handed_by_pin', cleanPin)
      .order('created_at', { ascending: false })
      .limit(limit),
  ]);
  if (createdRes.error) throw createdRes.error;
  if (targetedRes.error) throw targetedRes.error;
  return uniqById([...(Array.isArray(createdRes.data) ? createdRes.data : []), ...(Array.isArray(targetedRes.data) ? targetedRes.data : [])])
    .sort((a, b) => String(b?.created_at || '').localeCompare(String(a?.created_at || '')));
}

async function fetchWorkerHandoffsRaw(pin, limit = 100) {
  const cleanPin = String(pin || '').trim();
  if (!cleanPin) return [];
  const { data, error } = await supabase
    .from('cash_handoffs')
    .select('*')
    .eq('worker_pin', cleanPin)
    .order('submitted_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

async function fetchWorkerOrdersRaw(targetPin, limit = 180) {
  return fetchWorkerOrdersFallbackRaw(targetPin, limit);
}

function extractTransportCodeCandidate(row) {
  const direct = [
    row?.transport_code_str,
    row?.transportCodeStr,
    row?.transport_code,
    row?.t_code,
    row?.tcode,
    row?.client_tcode,
    row?.code_str,
    row?.order_code,
  ]
    .map((value) => String(value || '').trim().toUpperCase())
    .find((value) => /^T\d+$/.test(value));
  if (direct) return direct;
  const raw = `${String(row?.order_code || '')} ${String(row?.note || '')} ${String(row?.client_name || '')}`.toUpperCase();
  const match = raw.match(/\bT\d+\b/);
  return match?.[0] || '';
}

async function fetchTransportOrderMetaForPaymentsRaw(paymentRows = []) {
  const rows = Array.isArray(paymentRows) ? paymentRows : [];
  const ids = [...new Set(rows
    .map((row) => String(row?.transport_order_id || row?.transportOrderId || '').trim())
    .filter(Boolean))];
  const codes = [...new Set(rows
    .map((row) => extractTransportCodeCandidate(row))
    .filter(Boolean))];

  if (!ids.length && !codes.length) return {};

  const map = {};
  const chunkSize = 80;

  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    const { data, error } = await supabase
      .from('transport_orders')
      .select('*')
      .in('id', chunk);
    if (error) throw error;
    for (const row of Array.isArray(data) ? data : []) {
      const id = String(row?.id || '').trim();
      const codeStr = String(row?.code_str || '').trim().toUpperCase();
      const clientTcode = String(row?.client_tcode || row?.data?.client?.tcode || '').trim().toUpperCase();
      if (id) map[id] = row;
      if (codeStr) map[`CODE:${codeStr}`] = row;
      if (clientTcode) map[`TCODE:${clientTcode}`] = row;
    }
  }

  for (let i = 0; i < codes.length; i += chunkSize) {
    const chunk = codes.slice(i, i + chunkSize);
    const [byCodeStr, byClientTcode] = await Promise.all([
      supabase.from('transport_orders').select('*').in('code_str', chunk),
      supabase.from('transport_orders').select('*').in('client_tcode', chunk),
    ]);
    if (byCodeStr.error) throw byCodeStr.error;
    if (byClientTcode.error) throw byClientTcode.error;
    for (const res of [byCodeStr, byClientTcode]) {
      for (const row of Array.isArray(res.data) ? res.data : []) {
        const id = String(row?.id || '').trim();
        const codeStr = String(row?.code_str || '').trim().toUpperCase();
        const clientTcode = String(row?.client_tcode || row?.data?.client?.tcode || '').trim().toUpperCase();
        if (id) map[id] = row;
        if (codeStr) map[`CODE:${codeStr}`] = row;
        if (clientTcode) map[`TCODE:${clientTcode}`] = row;
      }
    }
  }

  return map;
}

async function fetchWorkerCompletedTransportOrdersRaw(targetPin, workerRow, limit = 800) {
  const cleanPin = String(targetPin || '').trim();
  if (!cleanPin && !workerRow?.id) return [];

  const { data, error } = await supabase
    .from('transport_orders')
    .select('*')
    .in('status', ['done', 'delivered', 'dorzuar', 'dorezuar', 'dorëzuar'])
    .order('updated_at', { ascending: false })
    .limit(Math.max(50, Math.min(Number(limit || 800), 1200)));

  if (error) throw error;

  const workerId = String(workerRow?.id || '').trim();
  return (Array.isArray(data) ? data : [])
    .filter((row) => TRANSPORT_COMMISSION_DONE_STATUSES.has(safeUpper(row?.status || row?.data?.status)))
    .filter((row) => workerMatchesTransportOrder(row, cleanPin, workerId))
    .sort((a, b) => String(b?.done_at || b?.delivered_at || b?.updated_at || b?.created_at || '').localeCompare(String(a?.done_at || a?.delivered_at || a?.updated_at || a?.created_at || '')));
}

export default function ArkaWorkerDetailPage() {
  useRouteAlive('arka_worker_detail_page');
  const params = useParams();
  const router = useRouter();
  let pin = '';
  try {
    pin = decodeURIComponent(String(params?.pin || '')).trim();
  } catch {
    pin = String(params?.pin || '').trim();
  }

  const [actor, setActor] = useState(null);
  const [worker, setWorker] = useState(null);
  const [payments, setPayments] = useState([]);
  const [extras, setExtras] = useState([]);
  const [handoffs, setHandoffs] = useState([]);
  const [orderFallbackRows, setOrderFallbackRows] = useState([]);
  const [xray, setXray] = useState({ pin: '', ordersRows: 0, matchedOrders: 0, matchedOrdersTotal: 0 });
  const [debtRows, setDebtRows] = useState([]);
  const [transportOrdersById, setTransportOrdersById] = useState({});
  const [completedTransportOrders, setCompletedTransportOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState(false);
  const [timaAmount, setTimaAmount] = useState('');
  const [timaNote, setTimaNote] = useState('TIMA');
  const [expenseAmount, setExpenseAmount] = useState('');
  const [expenseNote, setExpenseNote] = useState('SHPENZIM');
  const [deletingId, setDeletingId] = useState('');
  const [staffOptions, setStaffOptions] = useState([]);
  const [mealAmount, setMealAmount] = useState('3');
  const [mealNote, setMealNote] = useState('USHQIM');
  const [mealTargets, setMealTargets] = useState([]);
  const [mealSearch, setMealSearch] = useState('');
  const [secondaryLoading, setSecondaryLoading] = useState(false);
  const reloadSeqRef = useRef(0);

  const canManage = ['DISPATCH', 'ADMIN', 'ADMIN_MASTER', 'OWNER', 'PRONAR', 'SUPERADMIN'].includes(safeUpper(actor?.role));
  const sameWorker = String(actor?.pin || '').trim() === pin;

  async function reload() {
    if (!pin) return;
    const seq = Date.now();
    reloadSeqRef.current = seq;
    setLoading(true);
    setSecondaryLoading(false);
    setLoadError('');
    setWorker((prev) => prev || { pin, name: pin, role: 'WORKER', is_hybrid_transport: false, commission_rate_m2: 0.5 });
    try {
      const results = await Promise.allSettled([
        fetchSessionUserByPin(pin),
        fetchWorkerPendingPaymentsRaw(pin),
        fetchWorkerExtrasRaw(pin),
        fetchWorkerHandoffsRaw(pin),
        typeof listWorkerDebtRows === 'function' ? listWorkerDebtRows(pin) : Promise.resolve([]),
      ]);

      if (reloadSeqRef.current !== seq) return;

      const [workerRes, paymentRes, extrasRes, handoffRes, debtRes] = results;
      const issues = [];

      if (workerRes.status === 'rejected') issues.push(cleanErrorMessage(workerRes.reason, 'USERS'));
      if (paymentRes.status === 'rejected') issues.push(cleanErrorMessage(paymentRes.reason, 'ARKA_PENDING_PAYMENTS'));
      if (extrasRes.status === 'rejected') issues.push(cleanErrorMessage(extrasRes.reason, 'ARKA_EXTRAS'));
      if (handoffRes.status === 'rejected') issues.push(cleanErrorMessage(handoffRes.reason, 'CASH_HANDOFFS'));
      if (debtRes.status === 'rejected') issues.push(cleanErrorMessage(debtRes.reason, 'WORKER_DEBTS'));

      const workerRow = workerRes.status === 'fulfilled' ? workerRes.value : null;
      const cleanPayments = paymentRes.status === 'fulfilled' && Array.isArray(paymentRes.value) ? paymentRes.value : [];
      const cleanExtras = extrasRes.status === 'fulfilled' && Array.isArray(extrasRes.value) ? extrasRes.value : [];
      const cleanHandoffs = handoffRes.status === 'fulfilled' && Array.isArray(handoffRes.value) ? handoffRes.value : [];
      const cleanDebtRows = debtRes.status === 'fulfilled' && Array.isArray(debtRes.value) ? debtRes.value : [];
      const pinStr = String(pin || '').trim();

      setWorker(workerRow || { pin, name: pin, role: 'WORKER', is_hybrid_transport: false, commission_rate_m2: 0.5 });
      setPayments(cleanPayments);
      setExtras(cleanExtras);
      setHandoffs(cleanHandoffs);
      setDebtRows(cleanDebtRows);
      setOrderFallbackRows([]);
      setTransportOrdersById({});
      setCompletedTransportOrders([]);
      setXray({ pin: pinStr, ordersRows: 0, matchedOrders: 0, matchedOrdersTotal: 0 });
      setLoadError(issues.join(' | '));
      setLoading(false);

      const needsOrdersFallback = !cleanPayments.some((row) => isOpenRealPaymentRow(row));
      const needsTransportMeta = cleanPayments.some((row) => isTransportPaymentRow(row));
      const needsCompletedTransportOrders = workerRow?.is_hybrid_transport === true;
      if (!needsOrdersFallback && !needsTransportMeta && !needsCompletedTransportOrders) return;

      setSecondaryLoading(true);
      const secondaryIssues = [];
      let workerOrders = [];
      let transportMap = {};
      let completedTransportRows = [];

      if (needsOrdersFallback) {
        try {
          workerOrders = await fetchWorkerOrdersRaw(pinStr);
        } catch (error) {
          secondaryIssues.push(cleanErrorMessage(error, 'ORDERS'));
        }
      }

      if (needsTransportMeta) {
        try {
          transportMap = await fetchTransportOrderMetaForPaymentsRaw(cleanPayments);
        } catch (error) {
          secondaryIssues.push(cleanErrorMessage(error, 'TRANSPORT_ORDERS'));
        }
      }

      if (needsCompletedTransportOrders) {
        try {
          completedTransportRows = await fetchWorkerCompletedTransportOrdersRaw(pinStr, workerRow);
        } catch (error) {
          secondaryIssues.push(cleanErrorMessage(error, 'TRANSPORT_COMMISSION_ORDERS'));
        }
      }

      if (reloadSeqRef.current !== seq) return;

      setOrderFallbackRows(buildWorkerOrderFallbackRows(workerOrders));
      setXray({
        pin: pinStr,
        ordersRows: workerOrders.length,
        matchedOrders: workerOrders.length,
        matchedOrdersTotal: workerOrders.reduce((sum, row) => sum + readOrderAmount(row), 0),
      });
      setTransportOrdersById(transportMap || {});
      setCompletedTransportOrders(completedTransportRows);
      setLoadError((prev) => [prev, ...secondaryIssues].filter(Boolean).join(' | '));
    } catch (error) {
      if (reloadSeqRef.current !== seq) return;
      setPayments([]);
      setExtras([]);
      setHandoffs([]);
      setOrderFallbackRows([]);
      setXray({ pin: String(pin || '').trim(), ordersRows: 0, matchedOrders: 0, matchedOrdersTotal: 0 });
      setDebtRows([]);
      setTransportOrdersById({});
      setCompletedTransportOrders([]);
      setLoadError(cleanErrorMessage(error, 'LOAD'));
      setLoading(false);
    } finally {
      if (reloadSeqRef.current === seq) {
        setLoading(false);
        setSecondaryLoading(false);
      }
    }
  }

  useEffect(() => {
    setActor(getActor() || null);
  }, []);

  useEffect(() => {
    if (!actor) return;
    if (!canManage && !sameWorker) {
      try { window.__tepihaBootDebug?.logEvent?.('arka_worker_detail_access_blocked', { actorPin: actor?.pin || '', actorRole: actor?.role || '', targetPin: pin }); } catch {}
      try { alert('NUK KE LEJE ME HAP KËTË LLOGARI.'); } catch {}
      router.replace('/arka');
    }
  }, [actor, canManage, sameWorker, pin, router]);

  useEffect(() => {
    void reload();
  }, [pin]);

  useEffect(() => {
    let alive = true;
    async function loadMealStaff() {
      try {
        const rows = await listMealStaffOptions({ excludePin: pin });
        if (!alive) return;
        const cleanRows = Array.isArray(rows)
          ? rows
              .filter((row) => String(row?.pin || '').trim())
              .reduce((acc, row) => {
                const targetPin = String(row?.pin || '').trim();
                if (!targetPin || acc.some((item) => String(item?.pin || '').trim() === targetPin)) return acc;
                acc.push({
                  ...row,
                  pin: targetPin,
                  active_today: row?.active_today === true,
                });
                return acc;
              }, [])
          : [];
        setStaffOptions(cleanRows);
      } catch {
        if (alive) setStaffOptions([]);
      }
    }
    void loadMealStaff();
    return () => {
      alive = false;
    };
  }, [pin]);

  const hasOpenRealPayments = useMemo(() => (payments || []).some((row) => isOpenRealPaymentRow(row)), [payments]);

  const summaryPayments = useMemo(() => (hasOpenRealPayments ? payments : orderFallbackRows), [hasOpenRealPayments, payments, orderFallbackRows]);

  const summary = useMemo(() => {
    try {
      return buildWorkerArkaSummary({
        payments: Array.isArray(summaryPayments) ? summaryPayments : [],
        extras: Array.isArray(extras) ? extras : [],
        handoffs: Array.isArray(handoffs) ? handoffs : [],
        debtRows: Array.isArray(debtRows) ? debtRows : [],
        pin,
        worker,
        transportOrdersById: transportOrdersById && typeof transportOrdersById === 'object' ? transportOrdersById : {},
      });
    } catch (error) {
      try {
        bootLog('arka_worker_detail_summary_error', {
          path: typeof window !== 'undefined' ? window.location?.pathname || '' : '',
          pin,
          message: String(error?.message || error || 'SUMMARY_ERROR'),
        });
      } catch {}
      return buildEmptyWorkerSummary();
    }
  }, [summaryPayments, extras, handoffs, debtRows, pin, worker, transportOrdersById]);

  const cashAccount = useMemo(() => {
    const allPayments = Array.isArray(payments) ? payments : [];
    const commissionRate = n(worker?.commission_rate_m2) > 0 ? n(worker?.commission_rate_m2) : 0.5;
    const dueOptions = {
      transportOrdersById: transportOrdersById && typeof transportOrdersById === 'object' ? transportOrdersById : {},
      commissionRateM2: commissionRate,
    };

    const openRows = sortRowsDesc(allPayments.filter((row) => isOpenForDispatch(row, pin))).map((row) => buildCashDueRow(row, dueOptions));
    const historyRows = sortRowsDesc(allPayments.filter((row) => isAcceptedHistory(row, pin))).map((row) => buildCashDueRow(row, dueOptions));
    const allDueRows = [...openRows, ...historyRows];

    const baseOpenRows = openRows.filter((row) => row.type === 'BAZË');
    const transportOpenRows = openRows.filter((row) => row.type === 'TRANSPORT');
    const approvedTodayExpenseRows = sortRowsDesc((Array.isArray(extras) ? extras : []).filter((row) => isApprovedTodayExpense(row, pin)));
    const approvedTodayExpenses = approvedTodayExpenseRows.reduce((sum, row) => sum + n(row?.amount), 0);
    const openDueBeforeExpenses = openRows.reduce((sum, row) => sum + n(row?.dueToBase), 0);
    const totalDueToBase = Math.max(0, +(openDueBeforeExpenses - approvedTodayExpenses).toFixed(2));
    const transportCommissionHeldTotal = allDueRows
      .filter((row) => row.type === 'TRANSPORT')
      .reduce((sum, row) => sum + n(row?.commission), 0);

    return {
      openRows,
      baseOpenRows,
      transportOpenRows,
      historyRows,
      approvedTodayExpenseRows,
      approvedTodayExpenses,
      openGrossTotal: openRows.reduce((sum, row) => sum + n(row?.gross), 0),
      baseOpenGrossTotal: baseOpenRows.reduce((sum, row) => sum + n(row?.gross), 0),
      transportOpenGrossTotal: transportOpenRows.reduce((sum, row) => sum + n(row?.gross), 0),
      baseOpenDueTotal: baseOpenRows.reduce((sum, row) => sum + n(row?.dueToBase), 0),
      transportOpenDueTotal: transportOpenRows.reduce((sum, row) => sum + n(row?.dueToBase), 0),
      openTransportCommissionTotal: transportOpenRows.reduce((sum, row) => sum + n(row?.commission), 0),
      openDueBeforeExpenses,
      totalDueToBase,
      transportCommissionHeldTotal,

      // Legacy fields kept so the advanced, hidden view does not break.
      baseCashRows: baseOpenRows.map((row) => row.raw),
      transportCashRows: transportOpenRows.map((row) => row.raw),
      cashRows: openRows.map((row) => row.raw),
      baseCashTotal: baseOpenRows.reduce((sum, row) => sum + n(row?.gross), 0),
      transportCashTotal: transportOpenRows.reduce((sum, row) => sum + n(row?.gross), 0),
      totalCashCollected: openRows.reduce((sum, row) => sum + n(row?.gross), 0),
      cashExpensesTotal: approvedTodayExpenses,
      cashAdvancesTotal: 0,
      cashHandedRows: [],
      cashHandedTotal: 0,
      remainingToHandOver: totalDueToBase,
    };
  }, [payments, extras, pin, worker?.commission_rate_m2, transportOrdersById]);

  const payrollAccount = useMemo(() => {
    const commissionRate = n(worker?.commission_rate_m2) > 0 ? n(worker?.commission_rate_m2) : 0.5;
    const isHybrid = worker?.is_hybrid_transport === true;
    const commissionRows = isHybrid
      ? (Array.isArray(completedTransportOrders) ? completedTransportOrders : []).map((row) => {
          const m2 = readTransportOrderM2(row);
          const commission = +(m2 * commissionRate).toFixed(2);
          return {
            id: row?.id || `${readTransportOrderCode(row)}_${row?.updated_at || row?.created_at || ''}`,
            code: readTransportOrderCode(row) || 'T-KOD',
            client_name: readTransportOrderClientName(row),
            status: safeUpper(row?.status || row?.data?.status || 'DONE'),
            m2,
            commission,
            updated_at: row?.done_at || row?.delivered_at || row?.updated_at || row?.created_at || null,
          };
        }).filter((row) => row.m2 > 0 && row.commission > 0)
      : [];
    const transportCommissionTotal = commissionRows.reduce((sum, row) => sum + n(row?.commission), 0);
    const commissionHeldFromCash = Math.min(transportCommissionTotal, n(cashAccount.transportCommissionHeldTotal));
    const commissionStillPayable = Math.max(0, +(transportCommissionTotal - commissionHeldFromCash).toFixed(2));
    const baseSalary = n(worker?.salary);
    const advancesDeducted = n(summary.advancesTotal);
    const netPayable = baseSalary + commissionStillPayable - advancesDeducted;
    return {
      baseSalary,
      commissionRate,
      commissionRows,
      transportCommissionTotal,
      commissionHeldFromCash,
      commissionStillPayable,
      advancesDeducted,
      netPayable,
    };
  }, [worker, completedTransportOrders, summary.advancesTotal, cashAccount.transportCommissionHeldTotal]);

  const cashRemainingToHandOver = cashAccount.remainingToHandOver;

  const hasTodayActivity = summary.activityBaseToday;

  const mealSearchValue = String(mealSearch || '').trim().toUpperCase();
  const visibleMealOptions = useMemo(() => {
    const rows = Array.isArray(staffOptions) ? staffOptions : [];
    if (!mealSearchValue) return rows;
    return rows.filter((row) => {
      const hay = `${String(row?.name || '')} ${String(row?.pin || '')} ${String(row?.role || '')}`.toUpperCase();
      return hay.includes(mealSearchValue);
    });
  }, [staffOptions, mealSearchValue]);

  const mealTargetRows = useMemo(() => {
    const pins = new Set((mealTargets || []).map((row) => String(row || '').trim()).filter(Boolean));
    return (staffOptions || []).filter((row) => pins.has(String(row?.pin || '').trim()));
  }, [staffOptions, mealTargets]);

  const mealPreviewRows = useMemo(() => {
    const rows = [];
    if (hasTodayActivity) {
      rows.push({ pin, name: worker?.name || pin, role: worker?.role || 'WORKER', auto: true });
    }
    return rows.concat(mealTargetRows.map((row) => ({ ...row, auto: false })));
  }, [hasTodayActivity, pin, worker, mealTargetRows]);

  const mealPeopleCount = mealPreviewRows.length;
  const mealTotalAmount = parseAmountInput(mealAmount || '0') * mealPeopleCount;

  function notifyArkaHome() {
    if (typeof window === 'undefined') return;
    try {
      window.dispatchEvent(new Event('arka:refresh'));
    } catch {}
  }

  function toggleMealTarget(targetPin) {
    const cleanPin = String(targetPin || '').trim();
    if (!cleanPin) return;
    const row = (staffOptions || []).find((item) => String(item?.pin || '').trim() === cleanPin);
    if (!row?.active_today) return;
    setMealTargets((prev) => prev.includes(cleanPin) ? prev.filter((entry) => entry !== cleanPin) : [...prev, cleanPin]);
  }

  function selectAllVisibleMealTargets() {
    const nextPins = visibleMealOptions
      .filter((row) => row?.active_today)
      .map((row) => String(row?.pin || '').trim())
      .filter(Boolean);
    setMealTargets(nextPins);
  }

  function clearMealTargets() {
    setMealTargets([]);
  }

  async function payTeamMeal() {
    const amount = parseAmountInput(mealAmount || '3');
    if (amount <= 0) {
      alert('🔴 SHKRUAJ SHUMËN PËR PERSON.');
      return;
    }
    const picked = (staffOptions || []).filter((row) => row?.active_today && mealTargets.includes(String(row?.pin || '').trim()));
    const includeSelf = hasTodayActivity;
    const totalPeople = picked.length + (includeSelf ? 1 : 0);
    if (!totalPeople) {
      alert('🔴 NUK KA ASNJË PUNTOR AKTIV PËR USHQIM.');
      return;
    }
    try {
      setBusy(true);
      await createMealDistributionEntry({
        actor,
        payerPin: pin,
        payerName: worker?.name || pin,
        payerRole: worker?.role || 'WORKER',
        coveredWorkers: picked,
        amountPerPerson: amount,
        note: mealNote || 'USHQIM',
        includePayerMeal: includeSelf,
      });
      setMealTargets([]);
      setMealAmount('3');
      setMealNote('USHQIM');
      setMealSearch('');
      await reload();
      notifyArkaHome();
      alert(`✅ USHQIMI U REGJISTRUA PËR ${totalPeople} PUNTORË.`);
    } catch (e) {
      alert(`🔴 ${e?.message || 'NUK U REGJISTRUA USHQIMI.'}`);
    } finally {
      setBusy(false);
    }
  }

  async function giveTima() {
    const amount = parseAmountInput(timaAmount);
    if (amount <= 0) {
      alert('🔴 SHKRUAJ SHUMËN E TIMËS.');
      return;
    }
    try {
      setBusy(true);
      await createTimaEntry({
        actor,
        amount,
        note: timaNote || 'TIMA',
        workerPin: pin,
        workerName: worker?.name || pin,
        workerRole: worker?.role || 'WORKER',
      });
      setTimaAmount('');
      setTimaNote('TIMA');
      await reload();
      notifyArkaHome();
      alert('✅ TIMA U REGJISTRUA.');
    } catch (e) {
      alert(`🔴 ${e?.message || 'NUK U REGJISTRUA TIMA.'}`);
    } finally {
      setBusy(false);
    }
  }

  async function addExpense() {
    const amount = parseAmountInput(expenseAmount);
    if (amount <= 0) {
      alert('🔴 SHKRUAJ SHUMËN E SHPENZIMIT.');
      return;
    }
    try {
      setBusy(true);
      await createExpenseEntry({
        actor,
        amount,
        note: expenseNote || 'SHPENZIM',
        workerPin: pin,
        workerName: worker?.name || pin,
        workerRole: worker?.role || 'WORKER',
      });
      setExpenseAmount('');
      setExpenseNote('SHPENZIM');
      await reload();
      notifyArkaHome();
      alert('✅ SHPENZIMI U REGJISTRUA.');
    } catch (e) {
      alert(`🔴 ${e?.message || 'NUK U REGJISTRUA SHPENZIMI.'}`);
    } finally {
      setBusy(false);
    }
  }

  async function removeExpense(row) {
    if (!row?.id) return;
    const ok = window.confirm(`A DON ME E FSHI KËTË RRESHT ${euro(row?.amount)}?`);
    if (!ok) return;
    try {
      setDeletingId(String(row.id));
      await deleteWorkerExtraEntry({ rowId: row.id, actor, allowedTypes: ['EXPENSE', 'TIMA', 'MEAL_PAYMENT', 'MEAL_COVERED'] });
      await reload();
      notifyArkaHome();
      alert('✅ RRESHTI U FSHI.');
    } catch (e) {
      alert(`🔴 ${e?.message || 'NUK U FSHI RRESHTI.'}`);
    } finally {
      setDeletingId('');
    }
  }

  async function handoffMine() {
    if (!sameWorker || cashRemainingToHandOver <= 0) return;
    const ok = window.confirm(`A DON ME I DORËZU ${cashRemainingToHandOver.toFixed(2)}€?`);
    if (!ok) return;
    try {
      setBusy(true);
      await submitWorkerCashToDispatch({ actor, amountOverride: cashRemainingToHandOver });
      await reload();
      notifyArkaHome();
      alert('✅ DORËZIMI U DËRGUA.');
    } catch (e) {
      alert(`🔴 ${e?.message || 'NUK U DËRGUA DORËZIMI.'}`);
    } finally {
      setBusy(false);
    }
  }

  const summaryFoot = summary.isHybridTransport
    ? `COLLECTED + TIMA - SHPENZIME - USHQIM`
    : `COLLECTED + TIMA - SHPENZIME - USHQIM`;

  const ownerCashRows = sortRowsDesc(cashAccount.cashRows);
  const ownerExpenseRows = sortRowsDesc([...(summary.expenseRows || []), ...(summary.mealPaymentRows || [])]);
  const ownerAdvanceRows = sortRowsDesc((debtRows || []).filter((row) => safeUpper(row?.status) === 'ADVANCE'));
  const ownerDeliveredRows = sortRowsDesc((summary.deliveredRows || []).filter((row) => safeUpper(row?.status) === 'ACCEPTED'));
  const ownerCashTotal = cashAccount.totalCashCollected;
  const ownerExpenseTotal = cashAccount.cashExpensesTotal;
  const ownerAdvanceTotal = cashAccount.cashAdvancesTotal;
  const ownerDeliveredTotal = cashAccount.cashHandedTotal;
  const ownerRemainingTotal = cashAccount.remainingToHandOver;
  const workerFirstName = String(worker?.name || 'SHOFERIT').trim().split(/\s+/)[0] || 'SHOFERIT';
  const openPaymentGroups = buildPaymentDisplayGroups(cashAccount.openRows);
  const historyTodayTotal = cashAccount.historyRows
    .filter((row) => isToday(row?.created_at))
    .reduce((sum, row) => sum + n(row?.dueToBase), 0);
  const historyLast7Total = cashAccount.historyRows
    .filter((row) => isWithinLastDays(row?.created_at, 7))
    .reduce((sum, row) => sum + n(row?.dueToBase), 0);
  const historyMonthTotal = cashAccount.historyRows
    .filter((row) => isCurrentMonth(row?.created_at))
    .reduce((sum, row) => sum + n(row?.dueToBase), 0);

  return (
    <div className="arkaSimplePage">
      <div className="arkaSimpleTop">
        <div>
          <div className="arkaSimpleEyebrow">DETajet E PUNTORIT</div>
          <h1 className="arkaSimpleTitle">{String(worker?.name || pin || 'PUNTOR').toUpperCase()}</h1>
          <div className="arkaSimpleSub">PIN {pin || '—'} • {String(worker?.role || 'WORKER').toUpperCase()}</div>
        </div>
        <div className="arkaSimpleNav">
          <Link prefetch={false} href="/arka" className="arkaTopBtn">← KTHEHU</Link>
          {canManage ? <Link prefetch={false} href="/arka/payroll" className="arkaTopBtn">PAYROLL</Link> : null}
        </div>
      </div>

      {loading ? <div className="arkaLoaderCard">PO NGARKOHEN DETAJET...</div> : null}
      {secondaryLoading ? <div className="arkaLoaderCard">PO PLOTËSOHEN TË DHËNAT ANËSORE...</div> : null}
      {loadError ? (
        <div
          className="arkaLoaderCard"
          style={{
            borderColor: 'rgba(239,68,68,.65)',
            background: 'rgba(127,29,29,.35)',
            color: '#fecaca',
          }}
        >
          GABIM NË NGARKIM: {loadError}
        </div>
      ) : null}

      {!loading && !hasOpenRealPayments && orderFallbackRows.length ? (
        <div className="arkaLoaderCard" style={{ borderColor: 'rgba(34,197,94,.45)', background: 'rgba(20,83,45,.24)', color: '#dcfce7' }}>
          FALLBACK AKTIV NGA ORDERS • PO PËRDOREN {orderFallbackRows.length} RRESHTA NGA `data.delivered_by` PËR KËTË PUNTOR.
        </div>
      ) : null}

      {!loading ? (
        <>
          <section className="arkaSectionCard payrollClearBlock ownerSimpleCard">
            <div className="arkaSectionSub">PYETJA KRYESORE</div>
            <div className="arkaSectionTitle">SA DUHET ME DORËZU NË BAZË TASH?</div>

            <div className="arkaActionPanel emphasis ownerFormulaBox" style={{ alignItems: 'stretch' }}>
              <div>
                <div className="arkaActionHeader">DUHET ME DORËZU NË BAZË</div>
                <div style={{ fontSize: 'clamp(34px, 9vw, 56px)', lineHeight: 1, fontWeight: 950, letterSpacing: '-.04em', color: '#dcfce7', marginTop: 8 }}>
                  {euro(cashAccount.totalDueToBase)}
                </div>
              </div>
              <div className="arkaSimpleSub" style={{ marginTop: 8 }}>
                PËR BAZË = PAGESA BAZË + PJESA E BAZËS NGA TRANSPORTI − SHPENZIME TË PRANUARA
              </div>
            </div>

            <div className="arkaWorkerStats adminTopGrid ownerTotalsGrid">
              <Stat label="KLIENTËT KANË PAGUAR" value={euro(cashAccount.openGrossTotal)} tone="info" />
              <Stat label={`KOMISION ${workerFirstName.toUpperCase()}`} value={euro(cashAccount.openTransportCommissionTotal)} tone="warn" />
              <Stat label="SHPENZIME TË PRANUARA" value={euro(cashAccount.approvedTodayExpenses)} tone="warn" />
              <Stat label="PAGESA BAZË" value={euro(cashAccount.baseOpenDueTotal)} tone="ok" />
              <Stat label="TRANSPORT PËR BAZË" value={euro(cashAccount.transportOpenDueTotal)} tone="ok" />
            </div>

            <div className="arkaFormulaLine">
              {euro(cashAccount.baseOpenDueTotal)} + {euro(cashAccount.transportOpenDueTotal)} − {euro(cashAccount.approvedTodayExpenses)} = {euro(cashAccount.totalDueToBase)}
            </div>
          </section>

          <section className="arkaSectionCard payrollClearBlock">
            <div className="arkaSectionTitle">1. LISTA E PAGESAVE TË HAPURA</div>
            <div className="arkaSectionSub">SHFAQEN VETËM COLLECTED / PENDING QË ENDE NUK JANË PRANUAR NGA DISPATCH.</div>

            {openPaymentGroups.length ? openPaymentGroups.slice(0, 60).map((row) => (
              <div className="arkaHistoryRow" key={`open_due_group_${row.key}`}>
                <div>
                  <div className="arkaHistoryTitle">
                    {row.code} — {String(row.clientName || 'KLIENT').toUpperCase()}
                  </div>
                  <div className="arkaHistoryMeta">
                    {row.type}{row.count > 1 ? ` • ${row.count} PAGESA TË GRUPUARA` : ` • ${row.status}`}
                  </div>
                  {row.count > 1 ? (
                    <div className="arkaSimpleSub">
                      DUPLIKATË E GRUPUAR • {fmtDate(row.firstCreatedAt)}{row.lastCreatedAt && row.lastCreatedAt !== row.firstCreatedAt ? ` — ${fmtDate(row.lastCreatedAt)}` : ''}
                    </div>
                  ) : null}
                  <div className="arkaSimpleSub">KLIENTI PAGOI: {euro(row.gross)}</div>
                  {row.type === 'TRANSPORT' ? (
                    <div className="arkaSimpleSub">{workerFirstName.toUpperCase()} MBAN KOMISION: {euro(row.commission)}</div>
                  ) : null}
                  <div className="arkaSimpleSub">PËR BAZË: {euro(row.dueToBase)}</div>
                </div>
                <div className="arkaPendingRight">
                  <div className="arkaHistoryAmount">{euro(row.dueToBase)}</div>
                </div>
              </div>
            )) : <div className="arkaEmpty">S’KA PAGESA TË HAPURA PËR DISPATCH.</div>}
          </section>

          <details className="arkaAdvancedDetails">
            <summary className="arkaAdvancedSummary">HAP HISTORINË</summary>
            <section className="arkaSectionCard">
              <div className="arkaSectionTitle">2. HISTORIA E PAGESAVE TË PRANUARA</div>
              <div className="arkaSectionSub">KËTO JANË ACCEPTED_BY_DISPATCH / APPROVED. DEFAULT JANË TË MBYLLURA.</div>
              <div className="arkaWorkerStats adminTopGrid ownerTotalsGrid">
                <Stat label="SOT" value={euro(historyTodayTotal)} tone="ok" />
                <Stat label="7 DITËT E FUNDIT" value={euro(historyLast7Total)} tone="info" />
                <Stat label="KËTË MUAJ" value={euro(historyMonthTotal)} tone="strong" />
                <Stat label="RRESHTA" value={String(cashAccount.historyRows.length)} tone="neutral" />
              </div>
              {cashAccount.historyRows.length ? cashAccount.historyRows.slice(0, 20).map((row) => (
                <div className="arkaHistoryRow" key={`history_due_${row.id}`}>
                  <div>
                    <div className="arkaHistoryTitle">{row.code} — {String(row.clientName || 'KLIENT').toUpperCase()} — {row.type}</div>
                    <div className="arkaHistoryMeta">{fmtDate(row.created_at)} • KLIENTI PAGOI {euro(row.gross)} • {row.status}</div>
                    {row.type === 'TRANSPORT' ? (
                      <div className="arkaSimpleSub">KOMISION {euro(row.commission)} • PËR BAZË {euro(row.dueToBase)}</div>
                    ) : (
                      <div className="arkaSimpleSub">PËR BAZË {euro(row.dueToBase)}</div>
                    )}
                  </div>
                  <div className="arkaPendingRight">
                    <div className="arkaHistoryAmount">{euro(row.dueToBase)}</div>
                  </div>
                </div>
              )) : <div className="arkaEmpty">S’KA PAGESA TË PRANUARA NGA DISPATCH.</div>}
            </section>
          </details>

          <section className="arkaSectionCard">
            <div className="arkaSectionTitle">3. KOMISIONET</div>
            <div className="arkaSectionSub">TOTALI SHIHET KËTU. T-CODET JANË TË MBYLLURA DEFAULT.</div>
            <div className="arkaWorkerStats adminTopGrid ownerTotalsGrid">
              <Stat label="KOMISION I FITUAR" value={euro(payrollAccount.transportCommissionTotal)} tone="warn" />
              <Stat label="KOMISION I MBAJTUR NGA CASH" value={euro(payrollAccount.commissionHeldFromCash)} tone="ok" />
              <Stat label="KOMISION ENDE PËR PAGESË" value={euro(payrollAccount.commissionStillPayable)} tone="strong" />
            </div>
            <details className="arkaAdvancedDetails">
              <summary className="arkaAdvancedSummary">HAP KOMISIONET</summary>
              {summary.isHybridTransport ? (
                payrollAccount.commissionRows.length ? payrollAccount.commissionRows.slice(0, 20).map((row) => (
                  <div className="arkaHistoryRow" key={`commission_${row?.id}`}>
                    <div>
                      <div className="arkaHistoryTitle">{row.code} — {row.m2.toFixed(2)} m² × {euro(payrollAccount.commissionRate)} = {euro(row.commission)}</div>
                      <div className="arkaHistoryMeta">{fmtDate(row?.updated_at)} • {String(row?.client_name || 'TRANSPORT').toUpperCase()} • {row.status}</div>
                    </div>
                    <div className="arkaPendingRight"><div className="arkaHistoryAmount">{euro(row.commission)}</div></div>
                  </div>
                )) : <div className="arkaEmpty">S’KA KOMISION TRANSPORTI TË PËRFUNDUAR.</div>
              ) : <div className="arkaEmpty">KY PUNTOR NUK ËSHTË HYBRID TRANSPORT.</div>}
            </details>
          </section>

          <details className="arkaAdvancedDetails">
            <summary className="arkaAdvancedSummary">HAP PAYROLL</summary>
            <section className="arkaSectionCard payrollClearBlock">
              <div className="arkaSectionTitle">4. PAYROLL</div>
              <div className="arkaSectionSub">RROGA DHE KOMISIONI JANË HESAP I NDARË NGA CASH-I PËR DORËZIM.</div>
              <div className="arkaWorkerStats adminTopGrid ownerTotalsGrid">
                <Stat label="RROGA" value={euro(payrollAccount.baseSalary)} tone="neutral" />
                <Stat label="KOMISION I FITUAR" value={euro(payrollAccount.transportCommissionTotal)} tone="warn" />
                <Stat label="MBAJTUR NGA CASH" value={euro(payrollAccount.commissionHeldFromCash)} tone="ok" />
                <Stat label="KOMISION ENDE PËR PAGESË" value={euro(payrollAccount.commissionStillPayable)} tone="info" />
                <Stat label="AVANSE PAYROLL" value={euro(payrollAccount.advancesDeducted)} tone="muted" />
                <Stat label="NETO PËR PAGESË" value={euro(payrollAccount.netPayable)} tone="strong" />
              </div>
              <div className="arkaActionPanel emphasis ownerFormulaBox">
                <div className="arkaActionHeader">NETO PËR PAGESË: {euro(payrollAccount.netPayable)}</div>
                <div className="arkaSimpleSub">RROGA + KOMISION ENDE PËR PAGESË − AVANSET PAYROLL</div>
                <div className="arkaSimpleSub">{euro(payrollAccount.baseSalary)} + {euro(payrollAccount.commissionStillPayable)} − {euro(payrollAccount.advancesDeducted)}</div>
              </div>
            </section>
          </details>

          <details className="arkaAdvancedDetails">
            <summary className="arkaAdvancedSummary">HAP PAMJEN E VJETËR / AVANCUAR</summary>
            <div className="arkaWorkerStats adminTopGrid">
            <Stat label="TOTAL COLLECTED" value={euro(summary.collectedTotal)} tone="ok" />
            <Stat label="TOTAL PENDING" value={euro(summary.pendingTotal)} tone="warn" />
            <Stat label="SHPENZIME" value={euro(summary.expenseTotal)} tone="warn" />
            <Stat label="USHQIM" value={euro(summary.mealSelfTotal)} tone="muted" />
            <Stat label="TIMA" value={euro(summary.timaTotal)} tone="info" />
            <Stat label="TOTAL DORËZUAR" value={euro(summary.deliveredTotal)} tone="strong" />
            <Stat label="ME DORËZU SOT" value={euro(summary.toHandoverToday)} tone="strong" />
            <Stat label="ME DORËZU + PENDING" value={euro(summary.toHandoverWithPending)} tone="info" />
          </div>

          <div className="arkaActionPanel">
            <div className="arkaActionHeader">X-RAY</div>
            <div className="arkaWorkerStats arkaSectionTopStats">
              <Stat label="PIN" value={xray.pin || '—'} tone="neutral" />
              <Stat label="ORDERS ROWS" value={String(xray.ordersRows || 0)} tone="neutral" />
              <Stat label="MATCHED ORDERS" value={String(xray.matchedOrders || 0)} tone="info" />
              <Stat label="MATCHED TOTAL" value={euro(xray.matchedOrdersTotal)} tone="ok" />
            </div>
            <div className="arkaWorkerFoot muted">
              <span>ORDERS FILTROHEN NË SERVER ME `data-&gt;&gt;delivered_by = PIN`.</span>
              <span>{hasOpenRealPayments ? 'ARKA_PENDING_PAYMENTS MBETET BURIMI PRIMAR.' : 'PO SHFAQET FALLBACK NGA ORDERS SEPSE NUK KA OPEN PAYMENT ROWS.'}</span>
            </div>
          </div>

          {canManage ? (
            <div className="arkaActionPanel">
              <div className="arkaActionHeader">JEP TIMA</div>
              <div className="arkaInlineForm">
                <input className="arkaField small" inputMode="decimal" value={timaAmount} onChange={(e) => setTimaAmount(e.target.value)} placeholder="20" />
                <input className="arkaField" value={timaNote} onChange={(e) => setTimaNote(e.target.value)} placeholder="TIMA" />
                <button type="button" className="arkaSolidBtn" disabled={busy} onClick={giveTima}>RUAJ TIMA</button>
              </div>
            </div>
          ) : null}

          {(canManage || sameWorker) ? (
            <div className="arkaActionPanel">
              <div className="arkaActionHeader">SHTO SHPENZIM</div>
              <div className="arkaInlineForm">
                <input className="arkaField small" inputMode="decimal" value={expenseAmount} onChange={(e) => setExpenseAmount(e.target.value)} placeholder="10" />
                <input className="arkaField" value={expenseNote} onChange={(e) => setExpenseNote(e.target.value)} placeholder="SHPENZIM" />
                <button type="button" className="arkaSolidBtn" disabled={busy} onClick={addExpense}>RUAJ SHPENZIM</button>
              </div>
              <div className="arkaWorkerFoot muted"><span>PUNTORI DHE ADMINI MUND TA SHTOJNË OSE FSHIJNË NËSE ËSHTË GABIM.</span></div>
            </div>
          ) : null}

          {(canManage || sameWorker) ? (
            <div className="arkaActionPanel">
              <div>
                <div className="arkaActionHeader">PAGUAJ USHQIM PËR EKIPIN</div>
                <div className="arkaSimpleSub">AUTO 3€ FUTET VETËM NËSE KY PUNTOR KA SË PAKU 1 PAGESË BAZE REALE SOT. TË TJERËT MUND T’I SHTOSH POSHTË.</div>
              </div>
              <div className="arkaInlineForm mealTopRow">
                <input className="arkaField small" inputMode="decimal" value={mealAmount} onChange={(e) => setMealAmount(e.target.value)} placeholder="3" />
                <input className="arkaField" value={mealNote} onChange={(e) => setMealNote(e.target.value)} placeholder="USHQIM" />
                <button type="button" className="arkaSolidBtn" disabled={busy || !mealPeopleCount} onClick={payTeamMeal}>RUAJ USHQIMIN • {mealPeopleCount}</button>
              </div>

              <div className="arkaMealAutoBox">
                <div className="arkaMealAutoTitle">AUTO NGA SISTEMI</div>
                <div className={`arkaMealAutoValue ${hasTodayActivity ? 'ok' : 'muted'}`}>
                  {hasTodayActivity
                    ? `${String(worker?.name || pin).toUpperCase()} • PIN ${pin} • ${euro(parseAmountInput(mealAmount || '0'))}`
                    : 'KY PUNTOR S’KA PAGESË BAZE REALE SOT — NUK FUTET AUTOMATIKISHT NË USHQIM.'}
                </div>
              </div>

              <div className="arkaMealTools">
                <input
                  className="arkaField"
                  value={mealSearch}
                  onChange={(e) => setMealSearch(e.target.value)}
                  placeholder="KËRKO PUNTOR..."
                />
                <div className="arkaMealToolbar">
                  <button type="button" className="arkaTinyBtn" onClick={selectAllVisibleMealTargets}>ZGJIDH AKTIVËT</button>
                  <button type="button" className="arkaTinyBtn" onClick={clearMealTargets}>PASTRO</button>
                </div>
              </div>

              <div className="arkaMealGrid">
                {visibleMealOptions.map((row) => {
                  const targetPin = String(row?.pin || '').trim();
                  const active = mealTargets.includes(targetPin);
                  const canPick = row?.active_today === true;
                  return (
                    <button
                      type="button"
                      key={targetPin}
                      className={`arkaMealChip ${active ? 'active' : ''} ${canPick ? 'eligible' : 'disabled'}`}
                      onClick={() => toggleMealTarget(targetPin)}
                      disabled={!canPick}
                    >
                      <span>{String(row?.name || targetPin).toUpperCase()}</span>
                      <small>{canPick ? `PIN ${targetPin} • AKTIV SOT` : `PIN ${targetPin} • JO AKTIV SOT`}</small>
                    </button>
                  );
                })}
              </div>

              {!visibleMealOptions.length ? <div className="arkaEmpty">S’U GJET ASNJË PUNTOR ME KËTË KËRKIM.</div> : null}

              <div className="arkaMealSelectedBox">
                <div className="arkaMealSelectedTitle">TË PËRFSHIRË NË USHQIM</div>
                <div className="arkaMealSelectedList">
                  {mealPreviewRows.length
                    ? mealPreviewRows.map((row) => (
                        <span key={`${row.pin}_${row.auto ? 'auto' : 'manual'}`} className={`arkaMealPill ${row.auto ? 'auto' : ''}`}>
                          {String(row?.name || row?.pin || '').toUpperCase()}
                          <small>{row.auto ? 'AUTO' : `PIN ${String(row?.pin || '').trim()}`}</small>
                        </span>
                      ))
                    : <span className="arkaMealSelectedEmpty">ASNJË PUNTOR I PËRZGJEDHUR.</span>}
                </div>
              </div>

              <div className="arkaWorkerFoot muted">
                <span>PAGUESI: {String(worker?.name || pin).toUpperCase()}</span>
                <span>{mealPeopleCount} NË TOTAL • {euro(mealTotalAmount)}</span>
              </div>
            </div>
          ) : null}

          {sameWorker ? (
            <div className="arkaActionPanel emphasis">
              <div>
                <div className="arkaActionHeader">DORËZIMI IM</div>
                <div className="arkaSimpleSub">SISTEMI E LLOGARIT VETËM CASH-IN PËR DORËZIM. KOMISIONI I TRANSPORTIT MBETET TE PAYROLL.</div>
              </div>
              <button type="button" className="arkaSolidBtn big" disabled={busy || cashRemainingToHandOver <= 0} onClick={handoffMine}>DËRGO PËR DORËZIM • {euro(cashRemainingToHandOver)}</button>
            </div>
          ) : null}

          <div className="arkaSplitGrid detailPage">
            <section className="arkaSectionCard">
              <div className="arkaSectionTitle">PAGESA TË HYRA</div>
              <div className="arkaSectionSub">COLLECTED DHE PENDING TREGOHEN NDAMAS.</div>
              <div className="arkaWorkerStats arkaSectionTopStats">
                <Stat label="TOTAL COLLECTED" value={euro(summary.collectedTotal)} tone="ok" />
                <Stat label="TOTAL PENDING" value={euro(summary.pendingTotal)} tone="warn" />
              </div>
              {summary.collectedRows.concat(summary.pendingRows).length ? summary.collectedRows.concat(summary.pendingRows).slice(0, 20).map((row) => (
                <div className="arkaHistoryRow" key={`pay_${row.id || row.external_id || row.created_at}`}>
                  <div>
                    <div className="arkaHistoryTitle">{PaymentTitle(row)}</div>
                    <div className="arkaHistoryMeta">{fmtDate(row?.created_at)} • {safeUpper(row?.status || '—')} • {typeLabel(row)}</div>
                  </div>
                  <div className="arkaPendingRight">
                    <div className="arkaHistoryAmount">{euro(row?.amount)}</div>
                  </div>
                </div>
              )) : <div className="arkaEmpty">S’KA PAGESA AKTIVE.</div>}
            </section>

            <section className="arkaSectionCard">
              <div className="arkaSectionTitle">SHPENZIME</div>
              <div className="arkaSectionSub">SHPENZIMET REALE JANË TË NDARA NGA USHQIMI.</div>
              <div className="arkaWorkerStats arkaSectionTopStats singleTwo">
                <Stat label="TOTAL SHPENZIME" value={euro(summary.expenseTotal)} tone="warn" />
              </div>
              {summary.expenseOnlyRows.length ? summary.expenseOnlyRows.slice(0, 15).map((row) => (
                <div className="arkaHistoryRow" key={`expense_${row.id}`}>
                  <div>
                    <div className="arkaHistoryTitle">{String(row?.note || 'SHPENZIM').toUpperCase()}</div>
                    <div className="arkaHistoryMeta">{fmtDate(row?.created_at)} • {safeUpper(row?.status || '—')}</div>
                  </div>
                  <div className="arkaPendingRight">
                    <div className="arkaHistoryAmount">{euro(row?.real_amount || row?.amount)}</div>
                    {(canManage || sameWorker) ? <button type="button" className="arkaTinyBtn bad" disabled={busy || deletingId === String(row.id)} onClick={() => removeExpense(row)}>{deletingId === String(row.id) ? '...' : 'FSHIJ'}</button> : null}
                  </div>
                </div>
              )) : <div className="arkaEmpty">S’KA SHPENZIME TË HAPURA.</div>}
            </section>
          </div>

          <div className="arkaSplitGrid detailPage">
            <section className="arkaSectionCard">
              <div className="arkaSectionTitle">USHQIM</div>
              <div className="arkaSectionSub">MEAL PAYMENT ZBRITET TE PAGUESI. MEAL COVERED ËSHTË VETËM EVIDENCË.</div>
              <div className="arkaWorkerStats arkaSectionTopStats">
                <Stat label="ZBRITJE USHQIM" value={euro(summary.mealSelfTotal)} tone="muted" />
                <Stat label="COVERED EVIDENCË" value={euro(summary.mealCoveredTotal)} tone="neutral" />
              </div>
              {summary.mealPaymentRows.length ? summary.mealPaymentRows.map((row) => (
                <div className="arkaHistoryRow" key={`mealpay_${row.id}`}>
                  <div>
                    <div className="arkaHistoryTitle">{String(row?.note || 'USHQIM').toUpperCase()}</div>
                    <div className="arkaHistoryMeta">{fmtDate(row?.created_at)} • PAGUAR NGA KY PUNTOR</div>
                  </div>
                  <div className="arkaPendingRight">
                    <div className="arkaHistoryAmount">{euro(row?.amount)}</div>
                    {canManage ? <button type="button" className="arkaTinyBtn bad" disabled={busy || deletingId === String(row.id)} onClick={() => removeExpense(row)}>{deletingId === String(row.id) ? '...' : 'FSHIJ'}</button> : null}
                  </div>
                </div>
              )) : null}
              {summary.expenseMealRows.length ? summary.expenseMealRows.map((row) => (
                <div className="arkaHistoryRow" key={`mealsplit_${row.id}`}>
                  <div>
                    <div className="arkaHistoryTitle">USHQIM NGA SHPENZIMI</div>
                    <div className="arkaHistoryMeta">{fmtDate(row?.created_at)} • {String(row?.note || 'USHQIM').toUpperCase()}</div>
                  </div>
                  <div className="arkaPendingRight">
                    <div className="arkaHistoryAmount">{euro(row?.meal_amount)}</div>
                  </div>
                </div>
              )) : null}
              {summary.mealCoveredRows.length ? summary.mealCoveredRows.map((row) => (
                <div className="arkaHistoryRow" key={`mealcovered_${row.id}`}>
                  <div>
                    <div className="arkaHistoryTitle">{mealCoveredByLabel(row)}</div>
                    <div className="arkaHistoryMeta">{fmtDate(row?.created_at)} • {String(row?.note || 'USHQIM').toUpperCase()}</div>
                  </div>
                  <div className="arkaPendingRight">
                    <div className="arkaHistoryAmount">{euro(row?.amount)}</div>
                  </div>
                </div>
              )) : null}
              {!summary.mealPaymentRows.length && !summary.expenseMealRows.length && !summary.mealCoveredRows.length ? <div className="arkaEmpty">S’KA LËVIZJE TË USHQIMIT.</div> : null}
            </section>

            <section className="arkaSectionCard">
              <div className="arkaSectionTitle">TIMA</div>
              <div className="arkaSectionSub">TIMA E PRANUAR NGA DISPATCH HYRT NË LLOGARITJE.</div>
              <div className="arkaWorkerStats arkaSectionTopStats singleTwo">
                <Stat label="TOTAL TIMA" value={euro(summary.timaTotal)} tone="info" />
              </div>
              {summary.timaRows.length ? summary.timaRows.slice(0, 15).map((row) => (
                <div className="arkaHistoryRow" key={`tima_${row.id}`}>
                  <div>
                    <div className="arkaHistoryTitle">{String(row?.note || 'TIMA').toUpperCase()}</div>
                    <div className="arkaHistoryMeta">{fmtDate(row?.created_at)} • {safeUpper(row?.status || '—')}</div>
                  </div>
                  <div className="arkaPendingRight">
                    <div className="arkaHistoryAmount">{euro(row?.amount)}</div>
                    {canManage ? <button type="button" className="arkaTinyBtn bad" disabled={busy || deletingId === String(row.id)} onClick={() => removeExpense(row)}>{deletingId === String(row.id) ? '...' : 'FSHIJ'}</button> : null}
                  </div>
                </div>
              )) : <div className="arkaEmpty">S’KA TIMA TË HAPURA.</div>}
            </section>
          </div>

          {summary.isHybridTransport ? (
            <div className="arkaSplitGrid detailPage">
              <section className="arkaSectionCard">
                <div className="arkaSectionTitle">HYBRID TRANSPORT</div>
                <div className="arkaSectionSub">T-KODET NDARË NGA BAZA. KOMISIONI LLOGARITET {summary.commissionRateM2.toFixed(2)}€/M².</div>
                <div className="arkaWorkerStats arkaSectionTopStats">
                  <Stat label="T-KODE TË PAGUARA" value={String(summary.transportCodeRows.length)} tone="info" />
                  <Stat label="TOTAL M²" value={`${summary.transportCollectedM2.toFixed(2)} m²`} tone="neutral" />
                  <Stat label={`KOMISION ${summary.commissionRateM2.toFixed(2)}€/M²`} value={euro(summary.hybridCommissionCollected)} tone="warn" />
                  <Stat label="PJESA NË BAZË" value={euro(summary.hybridBaseShareCollected)} tone="ok" />
                </div>
                {summary.transportCodeRows.length ? summary.transportCodeRows.slice(0, 12).map((row) => (
                  <div className="arkaHistoryRow" key={`transport_${row.id}`}>
                    <div>
                      <div className="arkaHistoryTitle">{String(row?.code || row?.client_name || 'T-KOD').toUpperCase()}</div>
                      <div className="arkaHistoryMeta">{fmtDate(row?.created_at)} • {String(row?.client_name || '').toUpperCase()} • {row.m2.toFixed(2)} M²</div>
                    </div>
                    <div className="arkaPendingRight">
                      <div className="arkaHistoryAmount">{euro(row?.amount)}</div>
                    </div>
                  </div>
                )) : <div className="arkaEmpty">S’KA T-KODE TË PAGUARA AKTIVISHT.</div>}
              </section>
            </div>
          ) : null}

          <div className="arkaSplitGrid detailPage">
            <section className="arkaSectionCard">
              <div className="arkaSectionTitle">DORËZIME</div>
              <div className="arkaSectionSub">DORËZUAR SOT, MË HERËT DHE TOTALI JANË TË NDARË.</div>
              <div className="arkaWorkerStats arkaSectionTopStats">
                <Stat label="DORËZUAR SOT" value={euro(summary.deliveredTodayTotal)} tone="ok" />
                <Stat label="DORËZUAR MË HERËT" value={euro(summary.deliveredEarlierTotal)} tone="neutral" />
                <Stat label="TOTAL DORËZUAR" value={euro(summary.deliveredTotal)} tone="strong" />
              </div>
              {summary.deliveredRows.length ? summary.deliveredRows.slice(0, 15).map((row) => (
                <div className="arkaHistoryRow" key={`handoff_${row.id}`}>
                  <div>
                    <div className="arkaHistoryTitle">{safeUpper(row?.status || 'DORËZIM')}</div>
                    <div className="arkaHistoryMeta">{fmtDate(row?.submitted_at || row?.decided_at)} • {isToday(row?.submitted_at || row?.decided_at) ? 'SOT' : 'MË HERËT'}</div>
                  </div>
                  <div className="arkaPendingRight">
                    <div className="arkaHistoryAmount">{euro(row?.amount)}</div>
                  </div>
                </div>
              )) : <div className="arkaEmpty">S’KA DORËZIME AKOMA.</div>}
            </section>

            <section className="arkaSectionCard">
              <div className="arkaSectionTitle">PËRMBLEDHJE</div>
              <div className="arkaSectionSub">{summaryFoot}</div>
              <div className="arkaWorkerStats arkaSectionTopStats">
                <Stat label="ME DORËZU SOT" value={euro(summary.toHandoverToday)} tone="strong" />
                <Stat label="ME DORËZU ME PENDING" value={euro(summary.toHandoverWithPending)} tone="info" />
              </div>
              <div className="arkaHistoryRow">
                <div>
                  <div className="arkaHistoryTitle">FORMULA SOT</div>
                  <div className="arkaHistoryMeta">COLLECTED + TIMA - SHPENZIME - USHQIM</div>
                </div>
                <div className="arkaPendingRight"><div className="arkaHistoryAmount">{euro(summary.toHandoverToday)}</div></div>
              </div>
              <div className="arkaHistoryRow">
                <div>
                  <div className="arkaHistoryTitle">FORMULA ME PENDING</div>
                  <div className="arkaHistoryMeta">COLLECTED + PENDING + TIMA - SHPENZIME - USHQIM</div>
                </div>
                <div className="arkaPendingRight"><div className="arkaHistoryAmount">{euro(summary.toHandoverWithPending)}</div></div>
              </div>
            </section>
          </div>

          <div className="arkaSplitGrid detailPage">
            <section className="arkaSectionCard">
              <div className="arkaSectionTitle">BORXHE / AVANSE</div>
              <div className="arkaWorkerStats arkaSectionTopStats">
                <Stat label="AVANSE" value={euro(summary.advancesTotal)} tone="muted" />
                <Stat label="BORXH" value={euro(summary.debtTotal)} tone="warn" />
              </div>
              {(debtRows || []).length ? debtRows.slice(0, 15).map((row) => (
                <div className="arkaHistoryRow" key={row.id}>
                  <div>
                    <div className="arkaHistoryTitle">{safeUpper(row?.status || 'BORXH')}</div>
                    <div className="arkaHistoryMeta">{String(row?.note || '—').toUpperCase()}</div>
                  </div>
                  <div className="arkaPendingRight">
                    <div className="arkaHistoryAmount">{euro(row?.amount)}</div>
                  </div>
                </div>
              )) : <div className="arkaEmpty">S’KA BORXHE OSE AVANSE.</div>}
            </section>
          </div>
          </details>
        </>
      ) : null}
    </div>
  );
}
