import { supabase } from '@/lib/supabaseClient';
import { isExtraSettled } from '@/lib/arkaService';

const EXTRA_TYPES = new Set(['TIMA', 'EXPENSE', 'MEAL_PAYMENT', 'MEAL_COVERED']);
const OPEN_PAYMENT_STATUSES = new Set(['PENDING', 'COLLECTED']);
const ACTIVE_DELIVERY_STATUSES = new Set(['ACCEPTED']);
const MONEY_RE = /(\d+(?:[.,]\d+)?)/;

function n(v) {
  const x = Number(v || 0);
  return Number.isFinite(x) ? x : 0;
}

function safeUpper(v) {
  return String(v || '').trim().toUpperCase();
}

function cleanText(v, fallback = '') {
  const s = String(v || '').trim();
  return s || fallback;
}

function parseMoneyToken(raw) {
  if (raw == null) return 0;
  const match = String(raw).replace(/€/g, '').match(MONEY_RE);
  const value = Number(String(match?.[1] || '').replace(',', '.'));
  return Number.isFinite(value) ? value : 0;
}

function parseExpenseMealSplit(row) {
  const total = n(row?.amount);
  const note = cleanText(row?.note).toUpperCase();
  if (!note || total <= 0) return { expense: total, meal: 0 };

  let meal = 0;
  if (note === 'USHQIM' || note === 'MEAL') {
    meal = total;
  } else if (note.includes('USHQIM') || note.includes('MEAL')) {
    const before = note.match(/(\d+(?:[.,]\d+)?)\s*(?:€\s*)?(?=USHQIM|MEAL)/i);
    const after = note.match(/(?:USHQIM|MEAL)\s*(\d+(?:[.,]\d+)?)/i);
    meal = parseMoneyToken(before?.[1] || after?.[1]);
    if (meal <= 0 && /(USHQIM|MEAL)/i.test(note)) meal = total;
  }

  meal = Math.max(0, Math.min(total, meal));
  return { expense: Math.max(0, total - meal), meal };
}

function readM2FromText(text) {
  const raw = cleanText(text);
  if (!raw) return 0;
  const patterns = [
    /(\d+(?:[.,]\d+)?)\s*m²/i,
    /(\d+(?:[.,]\d+)?)\s*m2/i,
    /m²\s*[:=]?\s*(\d+(?:[.,]\d+)?)/i,
    /m2\s*[:=]?\s*(\d+(?:[.,]\d+)?)/i,
    /pay\.m2\s*[:=]?\s*(\d+(?:[.,]\d+)?)/i,
  ];
  for (const pattern of patterns) {
    const match = raw.match(pattern);
    if (match?.[1]) {
      const value = parseMoneyToken(match[1]);
      if (value > 0) return value;
    }
  }
  return 0;
}

function isoDay(v) {
  return String(v || '').slice(0, 10);
}

function isToday(v) {
  return isoDay(v) === isoDay(new Date().toISOString());
}

function byDateDesc(a, b) {
  return String(b?.created_at || b?.submitted_at || b?.decided_at || b?.updated_at || '').localeCompare(
    String(a?.created_at || a?.submitted_at || a?.decided_at || a?.updated_at || '')
  );
}

function workerKeyMatch(row, pin) {
  const p = cleanText(pin);
  if (!p || !row) return false;
  return [row?.created_by_pin, row?.handed_by_pin, row?.worker_pin].some((value) => cleanText(value) === p);
}

function isTransportPayment(row) {
  const sourceModule = safeUpper(row?.source_module || row?.sourceModule);
  if (sourceModule === 'TRANSPORT') return true;
  const type = safeUpper(row?.type);
  if (type === 'TRANSPORT') return true;
  if (cleanText(row?.transport_order_id || row?.transportOrderId)) return true;
  if (cleanText(row?.transport_code_str || row?.transportCodeStr || row?.transport_code || row?.t_code || row?.tcode || row?.client_tcode)) return true;
  const raw = `${cleanText(row?.order_code)} ${cleanText(row?.note)} ${cleanText(row?.client_name)}`.toUpperCase();
  return /\bT\d+\b/.test(raw);
}

function isRealPaymentRow(row) {
  const type = safeUpper(row?.type);
  const status = safeUpper(row?.status);
  if (EXTRA_TYPES.has(type)) return false;
  if (['OWED', 'REJECTED', 'WORKER_DEBT', 'ADVANCE'].includes(status)) return false;
  return true;
}

function isOpenPaymentRow(row) {
  return isRealPaymentRow(row) && OPEN_PAYMENT_STATUSES.has(safeUpper(row?.status));
}

export function readWorkerOrderAmount(row) {
  return (
    Number(row?.total ?? 0) ||
    Number(row?.price_total ?? 0) ||
    Number(row?.data?.total ?? 0) ||
    Number(row?.data?.paid ?? 0) ||
    0
  );
}

export function buildWorkerOrderFallbackRows(rows = []) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => ({
      id: `order_${String(row?.id || row?.code || row?.created_at || Math.random()).trim()}`,
      amount: readWorkerOrderAmount(row),
      status: 'COLLECTED',
      type: 'ORDER',
      created_at: row?.updated_at || row?.created_at || null,
      order_code: row?.code || row?.order_code || row?.client_code || '',
      client_name: row?.client_name || row?.data?.client_name || row?.data?.name || '',
      source_module: 'ORDERS_FALLBACK',
      raw_order_id: row?.id || null,
    }))
    .filter((row) => n(row?.amount) > 0);
}

export async function fetchWorkerOrdersFallbackRaw(pin, limit = 180) {
  const cleanPin = cleanText(pin);
  if (!cleanPin) return [];
  const safeLimit = Math.max(1, Math.min(Number(limit || 180), 240));
  const { data, error } = await supabase
    .from('orders')
    .select('id,code,status,client_name,client_phone,created_at,updated_at,data,total,price_total')
    .eq('data->>delivered_by', cleanPin)
    .order('updated_at', { ascending: false })
    .limit(safeLimit);
  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

function extractTCode(row, transportOrdersById = {}) {
  const transportIdKey = cleanText(row?.transport_order_id || row?.transportOrderId);
  const direct = transportIdKey ? transportOrdersById[transportIdKey] : null;
  const directCode = cleanText(
    row?.transport_code_str ||
    row?.transportCodeStr ||
    row?.transport_code ||
    row?.t_code ||
    row?.tcode ||
    row?.client_tcode ||
    direct?.code_str ||
    direct?.client_tcode ||
    direct?.data?.client?.tcode ||
    direct?.data?.client_tcode ||
    direct?.code
  ).toUpperCase();
  if (/^T\d+$/.test(directCode)) return directCode;

  const directFromRow = [
    row?.t_code,
    row?.tcode,
    row?.client_tcode,
    row?.code_str,
    row?.transport_code,
    row?.transport_code_str,
    row?.order_code,
  ].map((v) => cleanText(v).toUpperCase()).find((v) => /^T\d+$/.test(v));
  if (directFromRow) return directFromRow;

  const raw = `${cleanText(row?.order_code)} ${cleanText(row?.note)} ${cleanText(row?.client_name)}`;
  const match = raw.match(/\bT\d+\b/i);
  if (match?.[0]) return match[0].toUpperCase();
  return '';
}

function readTransportM2(row, transportOrdersById = {}) {
  const transportIdKey = cleanText(row?.transport_order_id || row?.transportOrderId);
  const codeKey = extractTCode(row, transportOrdersById);
  const direct =
    (transportIdKey ? transportOrdersById[transportIdKey] : null) ||
    (codeKey ? transportOrdersById[`CODE:${codeKey}`] : null) ||
    (codeKey ? transportOrdersById[`TCODE:${codeKey}`] : null) ||
    {};
  const data = direct?.data || {};
  const candidates = [
    row?.transport_m2,
    row?.transportM2,
    row?.m2,
    row?.m2_total,
    row?.pay?.m2,
    row?.data?.pay?.m2,
    row?.data?.m2_total,
    row?.meta?.m2,
    direct?.m2,
    direct?.m2_total,
    data?.pay?.m2,
    data?.m2_total,
    data?.m2,
    data?.totals?.m2,
    data?.totals?.total_m2,
    data?.totals?.grandM2,
    readM2FromText(row?.note),
    readM2FromText(row?.client_name),
  ];
  for (const value of candidates) {
    const parsed = n(value);
    if (parsed > 0) return parsed;
  }
  return 0;
}

export function mealCoveredByLabel(row) {
  const marker = cleanText(row?.handoff_note || row?.note);
  const match = marker.match(/MEAL_BY:([^|]+)/i);
  if (match?.[1]) {
    const payer = cleanText(match[1]);
    if (payer) return `COVERED BY ${payer.toUpperCase()}`;
  }
  return 'MEAL COVERED';
}

export async function fetchTransportOrderMetaForPayments(paymentRows = []) {
  const rows = Array.isArray(paymentRows) ? paymentRows : [];
  const ids = [...new Set(rows
    .filter((row) => isTransportPayment(row) && cleanText(row?.transport_order_id || row?.transportOrderId))
    .map((row) => cleanText(row?.transport_order_id || row?.transportOrderId)))];
  const codes = [...new Set(rows
    .filter(isTransportPayment)
    .map((row) => extractTCode(row, {}))
    .filter(Boolean))];

  if (!ids.length && !codes.length) return {};

  const map = {};
  const chunkSize = 80;

  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    const { data, error } = await supabase
      .from('transport_orders')
      .select('id, code_str, client_tcode, data')
      .in('id', chunk);
    if (!error) {
      for (const row of Array.isArray(data) ? data : []) {
        const id = cleanText(row.id);
        const codeStr = cleanText(row?.code_str).toUpperCase();
        const clientTcode = cleanText(row?.client_tcode || row?.data?.client?.tcode).toUpperCase();
        if (id) map[id] = row;
        if (codeStr) map[`CODE:${codeStr}`] = row;
        if (clientTcode) map[`TCODE:${clientTcode}`] = row;
      }
    }
  }

  for (let i = 0; i < codes.length; i += chunkSize) {
    const chunk = codes.slice(i, i + chunkSize);
    const [byCodeStr, byClientTcode] = await Promise.all([
      supabase.from('transport_orders').select('id, code_str, client_tcode, data').in('code_str', chunk),
      supabase.from('transport_orders').select('id, code_str, client_tcode, data').in('client_tcode', chunk),
    ]);
    for (const res of [byCodeStr, byClientTcode]) {
      if (res.error) continue;
      for (const row of Array.isArray(res.data) ? res.data : []) {
        const id = cleanText(row.id);
        const codeStr = cleanText(row?.code_str).toUpperCase();
        const clientTcode = cleanText(row?.client_tcode || row?.data?.client?.tcode).toUpperCase();
        if (id) map[id] = row;
        if (codeStr) map[`CODE:${codeStr}`] = row;
        if (clientTcode) map[`TCODE:${clientTcode}`] = row;
      }
    }
  }

  return map;
}

export function buildWorkerArkaSummary({
  payments = [],
  extras = [],
  handoffs = [],
  debtRows = [],
  pin = '',
  worker = null,
  transportOrdersById = {},
}) {
  const cleanPin = cleanText(pin);
  const allPayments = Array.isArray(payments) ? payments.slice() : [];
  const allExtras = Array.isArray(extras) ? extras.slice() : [];
  const allHandoffs = Array.isArray(handoffs) ? handoffs.slice() : [];
  const allDebtRows = Array.isArray(debtRows) ? debtRows.slice() : [];

  const openPaymentRows = allPayments.filter(isOpenPaymentRow).sort(byDateDesc);
  const collectedRows = openPaymentRows.filter((row) => safeUpper(row?.status) === 'COLLECTED');
  const pendingRows = openPaymentRows.filter((row) => safeUpper(row?.status) === 'PENDING');
  const baseCollectedRows = collectedRows.filter((row) => !isTransportPayment(row));
  const basePendingRows = pendingRows.filter((row) => !isTransportPayment(row));
  const transportCollectedRows = collectedRows.filter(isTransportPayment);
  const transportPendingRows = pendingRows.filter(isTransportPayment);

  const activityBaseToday = allPayments.some((row) => {
    if (!isRealPaymentRow(row) || isTransportPayment(row)) return false;
    const status = safeUpper(row?.status);
    if (!['PENDING', 'COLLECTED', 'ACCEPTED_BY_DISPATCH', 'PENDING_DISPATCH_APPROVAL'].includes(status)) return false;
    return isToday(row?.created_at) && n(row?.amount) > 0;
  });

  const lastAcceptedAt = allHandoffs
    .filter((row) => safeUpper(row?.status) === 'ACCEPTED')
    .map((row) => cleanText(row?.decided_at || row?.submitted_at))
    .filter(Boolean)
    .sort()
    .slice(-1)[0] || '';

  const filteredExtras = allExtras
    .filter((row) => workerKeyMatch(row, cleanPin))
    .filter((row) => !['REJECTED', 'REFUZUAR'].includes(safeUpper(row?.status)));

  const openExtras = filteredExtras.filter((row) => {
    if (isExtraSettled(row)) return false;
    const createdAt = cleanText(row?.created_at);
    if (lastAcceptedAt && createdAt && createdAt <= lastAcceptedAt) return false;
    return true;
  }).sort(byDateDesc);

  const rawExpenseRows = openExtras.filter((row) => safeUpper(row?.type) === 'EXPENSE');
  const expenseRows = rawExpenseRows.map((row) => {
    const split = parseExpenseMealSplit(row);
    return { ...row, real_amount: split.expense, meal_amount: split.meal };
  });
  const expenseMealRows = expenseRows.filter((row) => n(row?.meal_amount) > 0);
  const expenseOnlyRows = expenseRows.filter((row) => n(row?.real_amount) > 0 || n(row?.meal_amount) <= 0);
  const timaRows = openExtras.filter((row) => safeUpper(row?.type) === 'TIMA' && safeUpper(row?.status) === 'ACCEPTED_BY_DISPATCH');
  const mealPaymentRows = openExtras.filter((row) => safeUpper(row?.type) === 'MEAL_PAYMENT');
  const mealCoveredRows = openExtras.filter((row) => safeUpper(row?.type) === 'MEAL_COVERED');

  const collectedTotal = collectedRows.reduce((sum, row) => sum + n(row?.amount), 0);
  const pendingTotal = pendingRows.reduce((sum, row) => sum + n(row?.amount), 0);
  const expenseTotal = expenseRows.reduce((sum, row) => sum + n(row?.real_amount), 0);
  const mealPaymentTotal = mealPaymentRows.reduce((sum, row) => sum + n(row?.amount), 0);
  const mealFromExpensesTotal = expenseMealRows.reduce((sum, row) => sum + n(row?.meal_amount), 0);
  const mealSelfTotal = mealPaymentTotal + mealFromExpensesTotal;
  const mealCoveredTotal = mealCoveredRows.reduce((sum, row) => sum + n(row?.amount), 0);
  const timaTotal = timaRows.reduce((sum, row) => sum + n(row?.amount), 0);

  const deliveredRows = allHandoffs.filter((row) => ACTIVE_DELIVERY_STATUSES.has(safeUpper(row?.status))).sort(byDateDesc);
  const deliveredTodayRows = deliveredRows.filter((row) => isToday(row?.submitted_at || row?.decided_at));
  const deliveredEarlierRows = deliveredRows.filter((row) => !isToday(row?.submitted_at || row?.decided_at));
  const deliveredTodayTotal = deliveredTodayRows.reduce((sum, row) => sum + n(row?.amount), 0);
  const deliveredEarlierTotal = deliveredEarlierRows.reduce((sum, row) => sum + n(row?.amount), 0);
  const deliveredTotal = deliveredRows.reduce((sum, row) => sum + n(row?.amount), 0);

  const isHybridTransport = worker?.is_hybrid_transport === true;
  const commissionRateM2 = n(worker?.commission_rate_m2) > 0 ? n(worker?.commission_rate_m2) : 0.5;
  const transportCollectedM2 = transportCollectedRows.reduce((sum, row) => sum + readTransportM2(row, transportOrdersById), 0);
  const transportPendingM2 = transportPendingRows.reduce((sum, row) => sum + readTransportM2(row, transportOrdersById), 0);
  const hybridCommissionCollected = isHybridTransport ? transportCollectedM2 * commissionRateM2 : 0;
  const hybridCommissionWithPending = isHybridTransport ? (transportCollectedM2 + transportPendingM2) * commissionRateM2 : 0;
  const transportCollectedAmount = transportCollectedRows.reduce((sum, row) => sum + n(row?.amount), 0);
  const transportPendingAmount = transportPendingRows.reduce((sum, row) => sum + n(row?.amount), 0);
  const hybridBaseShareCollected = Math.max(0, transportCollectedAmount - hybridCommissionCollected);
  const hybridBaseShareWithPending = Math.max(0, transportCollectedAmount + transportPendingAmount - hybridCommissionWithPending);

  const transportCodeRows = transportCollectedRows.map((row) => ({
    id: row?.id || row?.order_id || row?.external_id || `${row?.created_at || ''}_${row?.amount || 0}`,
    code: extractTCode(row, transportOrdersById),
    amount: n(row?.amount),
    m2: readTransportM2(row, transportOrdersById),
    created_at: row?.created_at || null,
    client_name: cleanText(row?.client_name, 'T-KOD'),
  }));

  const advancesTotal = allDebtRows.filter((row) => safeUpper(row?.status) === 'ADVANCE').reduce((sum, row) => sum + n(row?.amount), 0);
  const debtTotal = allDebtRows.filter((row) => safeUpper(row?.status) !== 'ADVANCE').reduce((sum, row) => sum + n(row?.amount), 0);

  const toHandoverToday = Math.max(0, collectedTotal + timaTotal - expenseTotal - mealSelfTotal);
  const toHandoverWithPending = Math.max(0, collectedTotal + pendingTotal + timaTotal - expenseTotal - mealSelfTotal);

  return {
    collectedTotal,
    pendingTotal,
    expenseTotal,
    mealPaymentTotal,
    mealFromExpensesTotal,
    mealSelfTotal,
    mealCoveredTotal,
    timaTotal,
    deliveredTodayTotal,
    deliveredEarlierTotal,
    deliveredTotal,
    toHandoverToday,
    toHandoverWithPending,
    advancesTotal,
    debtTotal,
    activityBaseToday,
    collectedRows,
    pendingRows,
    baseCollectedRows,
    basePendingRows,
    transportCollectedRows,
    transportPendingRows,
    expenseRows,
    expenseOnlyRows,
    expenseMealRows,
    timaRows,
    mealPaymentRows,
    mealCoveredRows,
    deliveredRows,
    deliveredTodayRows,
    deliveredEarlierRows,
    transportCodeRows,
    isHybridTransport,
    commissionRateM2,
    transportCollectedM2,
    transportPendingM2,
    hybridCommissionCollected,
    hybridCommissionWithPending,
    hybridBaseShareCollected,
    hybridBaseShareWithPending,
  };
}
