import { supabase } from '@/lib/supabaseClient';
import { listPendingCashForActor } from '@/lib/arkaCashSync';
import { listWorkerUnsettledMealPayments, settleWorkerExtrasForHandoff } from '@/lib/arkaService';
import { ARKA_ACTION, ARKA_PAYMENT_STATUS, ARKA_PAYMENT_TYPE, ARKA_SOURCE_MODULE } from '@/lib/arka/arkaConstants';
import { arkaTransaction, buildArkaIdempotencyKey } from '@/lib/arka/arkaClient';

const SUMMARY_ID = 1;
const PENDING_CASH_TABLE = 'arka_pending_payments';
const HANDOFFS_TABLE = 'cash_handoffs';
const HANDOFF_ITEMS_TABLE = 'cash_handoff_items';
const LEDGER_TABLE = 'company_budget_ledger';
const SUMMARY_TABLE = 'company_budget_summary';

// cash_handoffs live DB CHECK constraint allows only:
// PENDING_DISPATCH_APPROVAL, ACCEPTED, REJECTED, CANCELLED.
// Do not use plain PENDING for cash_handoffs; arka_pending_payments may still use it.
const HANDOFF_STATUS_PENDING = 'PENDING_DISPATCH_APPROVAL';
const HANDOFF_STATUS_ACCEPTED = 'ACCEPTED';
const HANDOFF_STATUS_REJECTED = 'REJECTED';
const HANDOFF_STATUS_CANCELLED = 'CANCELLED';
const HANDOFF_PENDING_STATUSES = ['PENDING_DISPATCH_APPROVAL'];
const ACTIVE_WORKER_HANDOFF_SUBMITS = new Set();

const n = (v) => Number(v || 0) || 0;
const APPROX_TOLERANCE = 0.05;
const approxEqual = (a, b, tolerance = APPROX_TOLERANCE) => Math.abs(n(a) - n(b)) <= tolerance;
const parsePositiveNumber = (value) => {
  if (value == null || value === '') return 0;
  const parsed = Number(String(value).replace(',', '.').trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};
const clean = (v, fallback = '') => {
  const x = String(v || '').trim();
  return x || fallback;
};
const upper = (v) => clean(v).toUpperCase();
const nowIso = () => new Date().toISOString();

function safeDecodeURIComponent(value = '') {
  try {
    return decodeURIComponent(String(value || ''));
  } catch {
    return String(value || '');
  }
}

function parseWorkerRefFromLedgerText(text = '') {
  const raw = String(text || '');
  if (!raw) return { pin: '', name: '' };

  const kv = {};
  for (const part of raw.split('|')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const key = String(part.slice(0, idx) || '').trim().toLowerCase();
    const value = safeDecodeURIComponent(part.slice(idx + 1));
    if (key) kv[key] = value;
  }

  const pinFromKv = clean(kv.worker_pin || kv.pin || '', '');
  const nameFromKv = clean(kv.worker_name || kv.name || '', '');
  if (pinFromKv || nameFromKv) return { pin: pinFromKv, name: nameFromKv };

  const pinMatch = raw.match(/(?:\bPIN\b|\bPUNTORI\b|\bPUNETORI\b|\bWORKER\b)[^0-9]{0,8}(\d{3,8})/i) || raw.match(/\((\d{3,8})\)/);
  const pin = clean(pinMatch?.[1] || '', '');

  const nameMatch = raw.match(/(?:PËR|PER|FOR)\s+([A-ZÇË][A-ZÇË\s.-]{2,})/i) || raw.match(/(?:PUNTORI|PUNETORI|WORKER)\s*[:\-]?\s*([A-ZÇË][A-ZÇË\s.-]{2,})/i);
  const name = clean(nameMatch?.[1] || '', '');

  return { pin, name };
}

function isMissingColumnError(err) {
  const msg = String(err?.message || '').toLowerCase();
  return msg.includes('does not exist') || msg.includes('schema cache') || msg.includes('could not find the');
}

function normalizeArkaOrderId(value) {
  if (value == null || value === '') return null;
  const raw = String(value).trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) {
    const num = Number(raw);
    return Number.isSafeInteger(num) ? num : null;
  }
  return null;
}

function normalizeBaseOrderCode(value) {
  if (value == null || value === '') return null;
  const raw = String(value).replace(/#/g, '').trim().toUpperCase();
  if (!raw || raw === '0' || raw.startsWith('T')) return null;
  if (!/^\d+$/.test(raw)) return null;
  const num = Number(raw);
  return Number.isSafeInteger(num) && num > 0 ? num : null;
}

function normalizePendingPaymentId(value) {
  return normalizeArkaOrderId(value);
}

function normalizeTransportUuid(value) {
  const raw = String(value || '').trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(raw) ? raw : null;
}

function normalizeTransportCode(value) {
  const raw = String(value || '').replace(/#/g, '').trim().toUpperCase();
  return /^T\d+$/.test(raw) ? raw : null;
}

function detectSourceModule(row = {}) {
  const explicit = String(row?.source_module || row?.sourceModule || '').trim().toUpperCase();
  if (explicit === 'TRANSPORT' || explicit === 'BASE') return explicit;
  if (String(row?.type || '').trim().toUpperCase() === 'TRANSPORT') return 'TRANSPORT';
  if (normalizeTransportUuid(row?.transport_order_id || row?.transportOrderId || row?.order_id || row?.orderId)) return 'TRANSPORT';
  if (normalizeTransportCode(row?.transport_code_str || row?.transportCodeStr || row?.transport_code || row?.t_code || row?.tcode || row?.order_code)) return 'TRANSPORT';
  return 'BASE';
}

function parseTransportM2FromNote(value = '') {
  const note = String(value || '');
  if (!note) return 0;
  const matches = Array.from(note.matchAll(/([0-9]+(?:[.,][0-9]+)?)\s*(?:m²|m2|m\^2)/gi));
  if (!matches.length) return 0;
  return parsePositiveNumber(matches[matches.length - 1]?.[1]);
}

function normalizeTransportM2(row = {}) {
  const candidates = [
    row?.transport_m2,
    row?.transportM2,
    row?.m2,
    row?.m2_total,
    row?.pay?.m2,
    row?.data?.pay?.m2,
    row?.data?.m2_total,
  ];
  for (const value of candidates) {
    const parsed = parsePositiveNumber(value);
    if (parsed > 0) return parsed;
  }

  const noteCandidates = [
    row?.note,
    row?.data?.note,
    row?.pay?.note,
    row?.data?.pay?.note,
  ];
  for (const note of noteCandidates) {
    const parsed = parseTransportM2FromNote(note);
    if (parsed > 0) return parsed;
  }

  return 0;
}

async function getWorkerFinanceProfile(pin) {
  const cleanPin = String(pin || '').trim();
  if (!cleanPin) return { isHybridTransport: false, commissionRateM2: 0 };
  try {
    const { data, error } = await supabase
      .from('users')
      .select('is_hybrid_transport, commission_rate_m2')
      .eq('pin', cleanPin)
      .maybeSingle();
    if (error) throw error;
    return {
      isHybridTransport: Boolean(data?.is_hybrid_transport),
      commissionRateM2: Math.max(0, n(data?.commission_rate_m2 || 0)),
    };
  } catch {
    return { isHybridTransport: false, commissionRateM2: 0 };
  }
}

function computeHybridAmounts(row = {}, commissionRateM2 = 0, isHybridTransport = false) {
  const sourceModule = detectSourceModule(row);
  const rawAmount = n(row?.amount_num ?? row?.amount);
  const transportM2 = sourceModule === 'TRANSPORT' ? normalizeTransportM2(row) : 0;
  const commission = sourceModule === 'TRANSPORT' && isHybridTransport
    ? Math.max(0, +(transportM2 * commissionRateM2).toFixed(2))
    : 0;
  const deliverAmount = Math.max(0, +(rawAmount - commission).toFixed(2));
  return { sourceModule, rawAmount, transportM2, commission, deliverAmount };
}


function readPendingPaymentForItem(item = {}, pendingPaymentsById = new Map()) {
  const paymentId = normalizePendingPaymentId(item?.pending_payment_id || item?.pendingPaymentId || null);
  if (!paymentId || !pendingPaymentsById?.get) return null;
  return pendingPaymentsById.get(paymentId) || null;
}

function computeAcceptedHandoffAmount(
  handoff = {},
  financeProfile = { isHybridTransport: false, commissionRateM2: 0 },
  pendingPaymentsById = new Map()
) {
  const items = Array.isArray(handoff?.cash_handoff_items) ? handoff.cash_handoff_items : [];
  const storedAmount = n(handoff?.amount || handoff?.total_amount || 0);
  if (!items.length) return +storedAmount.toFixed(2);

  const acceptedSum = items.reduce((sum, item) => {
    const itemAmount = n(item?.amount_num ?? item?.amount);
    const pendingPayment = readPendingPaymentForItem(item, pendingPaymentsById);
    const sourceModule = detectSourceModule({ ...(pendingPayment || {}), ...(item || {}) });

    if (sourceModule !== 'TRANSPORT' || !financeProfile?.isHybridTransport) {
      return sum + itemAmount;
    }

    const transportM2 = normalizeTransportM2(item) || normalizeTransportM2(pendingPayment || {});
    const grossPending = n(pendingPayment?.amount_num ?? pendingPayment?.amount);
    const commission = Math.max(0, +(transportM2 * n(financeProfile?.commissionRateM2)).toFixed(2));

    // Double-subtract guard:
    // - If item.amount matches the original pending gross amount, this is a legacy gross item.
    //   Accept only base/net by subtracting the commission once.
    // - If item.amount already matches pending gross minus commission, it is already base/net.
    // - If there is no clear match, keep item.amount as the conservative accepted value.
    if (commission > 0 && grossPending > 0) {
      const expectedNet = Math.max(0, +(grossPending - Math.min(grossPending, commission)).toFixed(2));
      if (approxEqual(itemAmount, grossPending)) return sum + expectedNet;
      if (approxEqual(itemAmount, expectedNet)) return sum + itemAmount;
    }

    return sum + itemAmount;
  }, 0);

  return +Math.max(0, acceptedSum).toFixed(2);
}

function toHandoffItem(row = {}, handoffId, financeProfile = { isHybridTransport: false, commissionRateM2: 0 }) {
  const calc = computeHybridAmounts(row, financeProfile.commissionRateM2, financeProfile.isHybridTransport);
  const isTransport = calc.sourceModule === 'TRANSPORT';
  const transportOrderId = isTransport
    ? normalizeTransportUuid(row?.transport_order_id || row?.transportOrderId || row?.order_id || row?.orderId || row?.source_order_ref)
    : null;
  const transportCodeStr = isTransport
    ? normalizeTransportCode(row?.transport_code_str || row?.transportCodeStr || row?.transport_code || row?.t_code || row?.tcode || row?.client_tcode || row?.order_code)
    : null;

  return {
    handoff_id: handoffId,
    pending_payment_id: normalizePendingPaymentId(row?.pending_payment_id || row?.pendingPaymentId || row?.id || null),
    order_id: isTransport ? null : normalizeArkaOrderId(row?.order_id || row?.orderId || row?.source_order_ref || null),
    order_code: isTransport ? null : normalizeBaseOrderCode(row?.order_code || row?.code || null),
    source_module: calc.sourceModule,
    transport_order_id: transportOrderId,
    transport_code_str: transportCodeStr,
    transport_m2: isTransport ? calc.transportM2 : 0,
    amount: calc.deliverAmount,
  };
}

function money2(value) {
  return +n(value).toFixed(2);
}

function readTransportIdentity(item = {}) {
  const transportOrderId = normalizeTransportUuid(
    item?.transport_order_id ||
    item?.transportOrderId ||
    item?.transport_id ||
    item?.transportId ||
    item?.order_id ||
    item?.orderId ||
    item?.source_order_ref ||
    item?.data?.transport_order_id ||
    item?.data?.transportOrderId ||
    item?.data?.order_id ||
    null
  );
  const transportCodeStr = normalizeTransportCode(
    item?.transport_code_str ||
    item?.transportCodeStr ||
    item?.transport_code ||
    item?.t_code ||
    item?.tcode ||
    item?.client_tcode ||
    item?.order_code ||
    item?.code ||
    item?.data?.transport_code_str ||
    item?.data?.client_tcode ||
    item?.data?.order_code ||
    null
  );
  const sourceModule = detectSourceModule({
    ...item,
    transport_order_id: transportOrderId || item?.transport_order_id,
    transport_code_str: transportCodeStr || item?.transport_code_str,
  });
  const isTransport = sourceModule === 'TRANSPORT' || Boolean(transportOrderId || transportCodeStr);

  const keys = [
    transportOrderId ? `transport_order_id:${transportOrderId}` : null,
    transportCodeStr ? `transport_code_str:${transportCodeStr}` : null,
  ].filter(Boolean);

  if (!isTransport) return { isTransport: false, key: null, keys: [], transportOrderId: null, transportCodeStr: null };
  if (transportOrderId) return { isTransport: true, key: `transport_order_id:${transportOrderId}`, keys, transportOrderId, transportCodeStr };
  if (transportCodeStr) return { isTransport: true, key: `transport_code_str:${transportCodeStr}`, keys, transportOrderId, transportCodeStr };
  return { isTransport: true, key: null, keys: [], transportOrderId, transportCodeStr };
}

function readItemPaymentId(item = {}) {
  return normalizePendingPaymentId(
    item?.pending_payment_id ||
    item?.pendingPaymentId ||
    item?.payment_id ||
    item?.paymentId ||
    item?.arka_payment_id ||
    null
  );
}

function readItemFreshness(item = {}) {
  const idNum = Number(item?.id || item?.item_id || item?.itemId || 0);
  if (Number.isFinite(idNum) && idNum > 0) return idNum;
  const timeValue = Date.parse(item?.updated_at || item?.created_at || item?.submitted_at || item?.op_created_at || '');
  if (Number.isFinite(timeValue)) return timeValue;
  const indexNum = Number(item?.__dedupe_index);
  if (Number.isFinite(indexNum) && indexNum >= 0) return indexNum;
  const op = String(item?.op_id || item?.outbox_op_id || item?.save_attempt_id || '').trim();
  return op ? op.charCodeAt(op.length - 1) || 0 : 0;
}

function shouldPreferTransportDuplicate(candidate = {}, current = {}) {
  const candidatePaymentId = readItemPaymentId(candidate);
  const currentPaymentId = readItemPaymentId(current);
  if (candidatePaymentId && !currentPaymentId) return true;
  if (!candidatePaymentId && currentPaymentId) return false;

  const candidateAmountValid = money2(candidate?.amount_num ?? candidate?.amount) > 0;
  const currentAmountValid = money2(current?.amount_num ?? current?.amount) > 0;
  if (candidateAmountValid && !currentAmountValid) return true;
  if (!candidateAmountValid && currentAmountValid) return false;

  return readItemFreshness(candidate) >= readItemFreshness(current);
}

function dedupeTransportHandoffItems(items = []) {
  const sourceItems = Array.isArray(items) ? items : [];
  const rawTotal = money2(sourceItems.reduce((sum, item) => sum + n(item?.amount_num ?? item?.amount), 0));
  const keptRecords = [];
  const keyedTransport = new Map();
  const duplicates = [];

  sourceItems.forEach((item, index) => {
    const identity = readTransportIdentity(item);
    const identityKeys = identity.keys?.length ? identity.keys : (identity.key ? [identity.key] : []);
    const record = { item, index, keys: identityKeys };
    if (!identity.isTransport || !identity.key) {
      keptRecords.push(record);
      return;
    }

    const matchKey = identityKeys.find((key) => keyedTransport.has(key));
    const existing = matchKey ? keyedTransport.get(matchKey) : null;
    if (!existing) {
      for (const key of identityKeys) keyedTransport.set(key, record);
      keptRecords.push(record);
      return;
    }

    if (shouldPreferTransportDuplicate(item, existing.item)) {
      duplicates.push(existing.item);
      const existingIndex = keptRecords.findIndex((entry) => entry === existing);
      const mergedKeys = [...new Set([...(existing.keys || []), ...identityKeys])];
      record.keys = mergedKeys;
      if (existingIndex >= 0) keptRecords[existingIndex] = record;
      for (const key of mergedKeys) keyedTransport.set(key, record);
    } else {
      duplicates.push(item);
    }
  });

  const dedupedItems = keptRecords
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.item);
  const dedupedTotal = money2(dedupedItems.reduce((sum, item) => sum + n(item?.amount_num ?? item?.amount), 0));
  const duplicateDifference = money2(rawTotal - dedupedTotal);

  return {
    items: dedupedItems,
    duplicates,
    rawTotal,
    dedupedTotal,
    duplicateDifference,
  };
}


async function getSummary() {
  let { data, error } = await supabase
    .from(SUMMARY_TABLE)
    .select('*')
    .eq('id', SUMMARY_ID)
    .maybeSingle();
  if (error) throw error;
  if (data) return data;

  return { id: SUMMARY_ID, current_balance: 0, total_in: 0, total_out: 0 };
}

async function updateSummaryDelta({ deltaBalance = 0, deltaIn = 0, deltaOut = 0 }) {
  throw new Error('LEGACY_COMPANY_BUDGET_SUMMARY_WRITE_DISABLED_USE_ARKA_ENGINE');
}


async function insertLedgerEntry(payload = {}) {
  throw new Error('LEGACY_COMPANY_BUDGET_LEDGER_WRITE_DISABLED_USE_ARKA_ENGINE');
}


function stripKeys(obj = {}, keys = []) {
  const next = { ...(obj || {}) };
  for (const key of keys) delete next[key];
  return next;
}

function dedupePatchVariants(variants = []) {
  const out = [];
  const seen = new Set();
  for (const variant of variants) {
    const cleanVariant = Object.fromEntries(Object.entries(variant || {}).filter(([, value]) => value !== undefined));
    const key = JSON.stringify(Object.keys(cleanVariant).sort().map((k) => [k, cleanVariant[k]]));
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleanVariant);
  }
  return out;
}

function handoffUpdateVariants(payload = {}) {
  const optional = [
    'dispatch_note',
    'note',
    'driver_pin',
    'driver_name',
    'accepted_by_pin',
    'accepted_by_name',
    'accepted_at',
    'rejected_by_pin',
    'rejected_by_name',
    'rejected_at',
    'count_clients',
    'total_amount',
    'payment_ids',
    'order_ids',
    'data',
    'client_items',
    'company_ledger_entry_id',
  ];
  return dedupePatchVariants([
    payload,
    stripKeys(payload, ['dispatch_note']),
    stripKeys(payload, ['accepted_by_pin', 'accepted_by_name', 'accepted_at', 'rejected_by_pin', 'rejected_by_name', 'rejected_at']),
    stripKeys(payload, ['driver_pin', 'driver_name', 'count_clients', 'total_amount', 'payment_ids', 'order_ids', 'data', 'client_items']),
    stripKeys(payload, optional),
  ]);
}

async function updateCashHandoffWithFallback(handoffId, payload = {}) {
  throw new Error('LEGACY_HANDOFF_UPDATE_DISABLED_USE_ARKA_ENGINE');
}


function normalizeCashHandoffStatus(status) {
  const next = upper(status || HANDOFF_STATUS_PENDING);
  if (next === HANDOFF_STATUS_ACCEPTED) return HANDOFF_STATUS_ACCEPTED;
  if (next === HANDOFF_STATUS_REJECTED) return HANDOFF_STATUS_REJECTED;
  if (next === HANDOFF_STATUS_CANCELLED) return HANDOFF_STATUS_CANCELLED;
  return HANDOFF_STATUS_PENDING;
}

async function insertCashHandoffWithFallback(payload = {}) {
  throw new Error('LEGACY_HANDOFF_INSERT_DISABLED_USE_ARKA_ENGINE');
}


function pendingCashPatchVariants(patch = {}) {
  const optionalAccepted = ['accepted_at', 'accepted_by_pin', 'accepted_by_name'];
  const optionalHandoff = ['handoff_id', 'submitted_at', 'handoff_note'];
  const optionalHanded = ['handed_at', 'handed_by_pin', 'handed_by_role'];
  const optionalUpdated = ['updated_at'];
  return dedupePatchVariants([
    patch,
    stripKeys(patch, optionalAccepted),
    stripKeys(patch, optionalHandoff),
    stripKeys(patch, optionalHanded),
    stripKeys(patch, [...optionalAccepted, ...optionalHandoff]),
    stripKeys(patch, [...optionalAccepted, ...optionalHandoff, ...optionalHanded]),
    stripKeys(patch, [...optionalAccepted, ...optionalHandoff, ...optionalHanded, ...optionalUpdated]),
  ]);
}

async function safeUpdatePendingCashBy(field, values = [], patch = {}) {
  throw new Error('LEGACY_PENDING_CASH_UPDATE_DISABLED_USE_ARKA_ENGINE');
}


async function updatePendingCashRows(items, patch) {
  const rows = Array.isArray(items) ? items : [];
  if (!rows.length) return;
  throw new Error('LEGACY_PENDING_CASH_UPDATE_DISABLED_USE_ARKA_ENGINE');
}


export async function listWorkerReadyCash(actorPin) {
  const pin = String(actorPin || '').trim();
  if (!pin) return [];
  const res = await listPendingCashForActor(pin, 200);
  const items = Array.isArray(res?.items) ? res.items : [];
  return items.filter(isCashRowReadyForDispatch);
}

function isCashRowReadyForDispatch(row = {}) {
  const status = upper(row?.status);
  if (!['PENDING', 'COLLECTED'].includes(status)) return false;
  const type = upper(row?.type || '');
  if (['TIMA', 'EXPENSE', 'MEAL_PAYMENT', 'MEAL_COVERED', 'ADVANCE'].includes(type)) return false;
  return n(row?.amount) > 0;
}

function readHandoffRelationItems(row = {}) {
  return Array.isArray(row?.cash_handoff_items) ? row.cash_handoff_items : [];
}

function clientHandoffItemFromPayment(item = {}, payment = {}, handoff = {}) {
  const transportCode = normalizeTransportCode(
    item?.transport_code_str || item?.transportCodeStr ||
    payment?.transport_code_str || payment?.transportCodeStr || payment?.transport_code || payment?.t_code || payment?.tcode || payment?.order_code
  );
  const baseCode = normalizeBaseOrderCode(item?.order_code || payment?.order_code || payment?.code || null);
  const code = transportCode || (baseCode ? `#${baseCode}` : clean(payment?.order_code || item?.order_code || '—', '—'));
  const clientName = clean(payment?.client_name || payment?.data?.client_name || payment?.data?.client?.name || item?.client_name || item?.note || 'KLIENT', 'KLIENT');
  return {
    id: item?.id || item?.pending_payment_id || payment?.id || `${handoff?.id || ''}_${code}_${clientName}`,
    pending_payment_id: normalizePendingPaymentId(item?.pending_payment_id || payment?.id || null),
    order_id: item?.order_id || payment?.order_id || null,
    code,
    client_name: clientName,
    amount: +n(item?.amount || payment?.amount || 0).toFixed(2),
    status: upper(payment?.status || handoff?.status || ''),
    source_module: upper(item?.source_module || payment?.source_module || payment?.type || ''),
    created_at: payment?.created_at || item?.created_at || handoff?.submitted_at || null,
  };
}

async function enrichHandoffsWithClientItems(rows = []) {
  const handoffs = Array.isArray(rows) ? rows : [];
  if (!handoffs.length) return [];

  const handoffIds = handoffs.map((row) => row?.id).filter(Boolean);
  let relationItems = handoffs.flatMap(readHandoffRelationItems);

  if (!relationItems.length && handoffIds.length) {
    try {
      const { data } = await supabase
        .from(HANDOFF_ITEMS_TABLE)
        .select('*')
        .in('handoff_id', handoffIds);
      relationItems = Array.isArray(data) ? data : [];
    } catch {}
  }

  const byHandoff = new Map();
  for (const item of relationItems) {
    const key = String(item?.handoff_id || '').trim();
    if (!key) continue;
    const list = byHandoff.get(key) || [];
    list.push(item);
    byHandoff.set(key, list);
  }

  const paymentIds = [...new Set(relationItems
    .map((item) => normalizePendingPaymentId(item?.pending_payment_id || item?.pendingPaymentId || null))
    .filter(Boolean))];
  const paymentsById = new Map();

  if (paymentIds.length) {
    try {
      const { data } = await supabase
        .from(PENDING_CASH_TABLE)
        .select('*')
        .in('id', paymentIds);
      for (const row of Array.isArray(data) ? data : []) {
        const id = normalizePendingPaymentId(row?.id);
        if (id) paymentsById.set(id, row);
      }
    } catch {}
  }

  return handoffs.map((handoff) => {
    const items = byHandoff.get(String(handoff?.id || '').trim()) || readHandoffRelationItems(handoff);
    const clientItems = items.map((item) => {
      const paymentId = normalizePendingPaymentId(item?.pending_payment_id || item?.pendingPaymentId || null);
      return clientHandoffItemFromPayment(item, paymentId ? paymentsById.get(paymentId) || {} : {}, handoff);
    });
    return {
      ...handoff,
      cash_handoff_items: items,
      client_items: clientItems,
      count_clients: clientItems.length || handoff?.count_clients || items.length || 0,
    };
  });
}

export async function listPendingDispatchHandoffs(limit = 100, select = '*, cash_handoff_items(*)') {
  const { data, error } = await supabase
    .from(HANDOFFS_TABLE)
    .select(select)
    .in('status', HANDOFF_PENDING_STATUSES)
    .order('submitted_at', { ascending: false })
    .limit(limit);

  if (error) throw error;
  return enrichHandoffsWithClientItems(Array.isArray(data) ? data : []);
}


function isUncommittedArkaTransactionResult(result = {}) {
  return Boolean(result?.offlineQueued || result?.queued || result?.localOnly || result?.offline);
}

async function verifyDispatchHandoffAcceptedInDb(handoffId) {
  const id = Number(handoffId || 0);
  if (!id) throw new Error('ACCEPT_VERIFY_HANDOFF_ID_INVALID');

  const { data: handoff, error: handoffErr } = await supabase
    .from(HANDOFFS_TABLE)
    .select('id,status,amount,cash_handoff_items(id,amount,pending_payment_id)')
    .eq('id', id)
    .maybeSingle();
  if (handoffErr) throw handoffErr;
  if (!handoff?.id) throw new Error('ACCEPT_VERIFY_HANDOFF_NOT_FOUND');
  if (upper(handoff?.status) !== HANDOFF_STATUS_ACCEPTED) {
    throw new Error(`ACCEPT_VERIFY_HANDOFF_NOT_ACCEPTED:${upper(handoff?.status) || 'EMPTY'}`);
  }

  const items = Array.isArray(handoff?.cash_handoff_items) ? handoff.cash_handoff_items : [];
  if (!items.length) throw new Error('ACCEPT_VERIFY_HANDOFF_HAS_NO_ITEMS');

  const itemSum = +items.reduce((sum, item) => sum + n(item?.amount), 0).toFixed(2);
  const handoffAmount = +n(handoff?.amount).toFixed(2);
  if (!approxEqual(itemSum, handoffAmount)) {
    throw new Error(`ACCEPT_VERIFY_ITEM_SUM_MISMATCH:${handoffAmount.toFixed(2)}:${itemSum.toFixed(2)}`);
  }

  const paymentIds = [...new Set(items.map((item) => normalizePendingPaymentId(item?.pending_payment_id)).filter(Boolean))];
  if (paymentIds.length) {
    const { data: payments, error: paymentErr } = await supabase
      .from(PENDING_CASH_TABLE)
      .select('id,status,handoff_note')
      .in('id', paymentIds);
    if (paymentErr) throw paymentErr;
    const paymentRows = Array.isArray(payments) ? payments : [];
    if (paymentRows.length !== paymentIds.length) {
      throw new Error(`ACCEPT_VERIFY_PAYMENT_COUNT_MISMATCH:${paymentIds.length}:${paymentRows.length}`);
    }
    const badPayment = paymentRows.find((row) => upper(row?.status) !== ARKA_PAYMENT_STATUS.ACCEPTED_BY_DISPATCH);
    if (badPayment) {
      throw new Error(`ACCEPT_VERIFY_PAYMENT_NOT_ACCEPTED:${badPayment.id}:${upper(badPayment.status) || 'EMPTY'}`);
    }
  }

  const { data: ledger, error: ledgerErr } = await supabase
    .from(LEDGER_TABLE)
    .select('id,amount,direction,source_type,source_id')
    .eq('source_type', 'cash_handoff')
    .eq('source_id', id);
  if (ledgerErr) throw ledgerErr;
  const ledgerRows = Array.isArray(ledger) ? ledger : [];
  if (ledgerRows.length !== 1) throw new Error(`ACCEPT_VERIFY_LEDGER_ROW_COUNT:${ledgerRows.length}`);

  const ledgerSum = +ledgerRows.reduce((sum, row) => sum + n(row?.amount), 0).toFixed(2);
  if (!approxEqual(ledgerSum, handoffAmount)) {
    throw new Error(`ACCEPT_VERIFY_LEDGER_AMOUNT_MISMATCH:${handoffAmount.toFixed(2)}:${ledgerSum.toFixed(2)}`);
  }

  return {
    acceptedCommitted: true,
    handoff,
    itemCount: items.length,
    itemSum,
    ledger: ledgerRows[0],
    ledgerCount: ledgerRows.length,
    ledgerAmount: ledgerSum,
  };
}

async function assertDispatchAcceptCommitted(handoffId, result = {}) {
  if (isUncommittedArkaTransactionResult(result)) {
    throw new Error('PRANIMI NUK U KRYE NË DB. INTERNETI/API DËSHTOI DHE VEPRIMI NUK U KONFIRMUA. PROVO PRAPË KUR JE ONLINE.');
  }

  const serverVerification = result?.verification || result?.result?.verification || null;
  if (serverVerification?.acceptedCommitted === true) {
    return {
      ...result,
      verification: serverVerification,
      verified: true,
    };
  }

  const clientVerification = await verifyDispatchHandoffAcceptedInDb(handoffId);
  return {
    ...result,
    verification: clientVerification,
    verified: true,
  };
}

function isAcceptRpcUnavailableError(error) {
  const msg = String(error?.message || error?.details || error?.hint || error || '').toLowerCase();
  return (
    msg.includes('accept_cash_handoff_atomic') && (
      msg.includes('could not find') ||
      msg.includes('does not exist') ||
      msg.includes('schema cache') ||
      msg.includes('function')
    )
  );
}

function normalizeAcceptRpcResult(data = {}) {
  const verification = data?.verification || null;
  return {
    ok: true,
    action: ARKA_ACTION.ACCEPT_HANDOFF,
    directRpc: true,
    result: data,
    handoff: data?.handoff || verification?.handoff || null,
    ledger: data?.ledger || verification?.ledger || null,
    verification,
    alreadyAccepted: Boolean(data?.alreadyAccepted),
  };
}

async function acceptDispatchHandoffDirectRpc(id, actor) {
  const { data, error } = await supabase.rpc('accept_cash_handoff_atomic', {
    handoff_id: id,
    accepted_by_pin: actor.pin,
    accepted_by_name: actor?.name || null,
  });
  if (error) throw error;
  if (data?.ok === false) throw new Error(data?.error || data?.message || 'ACCEPT_CASH_HANDOFF_RPC_FAILED');
  return assertDispatchAcceptCommitted(id, normalizeAcceptRpcResult(data || {}));
}

function extractSubmittedHandoff(result = {}) {
  return result?.handoff || result?.result?.handoff || null;
}

function paymentVerifiedForHandoff(row = {}, handoffId = '') {
  const status = upper(row?.status);
  const type = upper(row?.type);
  const note = String(row?.handoff_note || '').toUpperCase();
  const linked = String(row?.handoff_note || '').includes(String(handoffId));
  if (type === ARKA_PAYMENT_TYPE.MEAL_PAYMENT) {
    return note.includes(`SETTLED_IN_HANDOFF:${handoffId}`) || (note.includes('SETTLED_IN_HANDOFF') && linked);
  }
  return status === HANDOFF_STATUS_PENDING && linked;
}

function verifyHandoffSubmitResponse(result = {}, paymentIds = [], options = {}) {
  if (!result?.ok) throw new Error(result?.error || result?.message || 'SUBMIT_HANDOFF_FAILED');

  const expectedIds = [...new Set((paymentIds || []).map((id) => normalizePendingPaymentId(id)).filter(Boolean))];
  const expectedMealIds = [...new Set((options?.expectedMealPaymentIds || []).map((id) => normalizePendingPaymentId(id)).filter(Boolean))];
  const handoff = extractSubmittedHandoff(result);
  if (!handoff?.id) throw new Error('HANDOFF_RESPONSE_MISSING_ID');
  if (upper(handoff?.status) !== HANDOFF_STATUS_PENDING) {
    throw new Error(`HANDOFF_STATUS_INVALID:${upper(handoff?.status) || 'EMPTY'}`);
  }

  const items = Array.isArray(handoff?.cash_handoff_items) ? handoff.cash_handoff_items : [];
  if (!items.length) throw new Error('HANDOFF_ITEMS_EMPTY_AFTER_RPC');
  if (expectedIds.length && items.length !== expectedIds.length) {
    throw new Error(`HANDOFF_ITEM_COUNT_MISMATCH expected=${expectedIds.length} actual=${items.length}`);
  }

  const itemIds = new Set(items.map((item) => String(normalizePendingPaymentId(item?.pending_payment_id))).filter(Boolean));
  const missingIds = expectedIds.filter((id) => !itemIds.has(String(id)));
  if (missingIds.length) throw new Error(`HANDOFF_ITEM_PAYMENT_MISSING:${missingIds.join(',')}`);

  // MEAL_PAYMENT rows are settled through arka_pending_payments.handoff_note.
  // They are intentionally not inserted into cash_handoff_items because the DB
  // CHECK constraint does not allow negative handoff item amounts.
  const mealIdsInItems = expectedMealIds.filter((id) => itemIds.has(String(id)));
  if (mealIdsInItems.length) throw new Error(`MEAL_PAYMENT_SHOULD_NOT_BE_HANDOFF_ITEM:${mealIdsInItems.join(',')}`);

  const itemSum = +items.reduce((sum, item) => sum + n(item?.amount), 0).toFixed(2);
  const handoffAmount = +n(handoff?.amount || handoff?.total_amount).toFixed(2);
  if (!approxEqual(itemSum, handoffAmount)) {
    throw new Error(`HANDOFF_ITEM_SUM_MISMATCH handoff=${handoffAmount.toFixed(2)} items=${itemSum.toFixed(2)}`);
  }

  const verification = result?.verification || {};
  const expectedVerificationCount = expectedIds.length + expectedMealIds.length;
  if (expectedVerificationCount && !Object.prototype.hasOwnProperty.call(verification, 'paymentCount')) {
    throw new Error('HANDOFF_PAYMENT_VERIFY_MISSING');
  }
  if (expectedVerificationCount && Number(verification?.paymentCount) < expectedVerificationCount) {
    throw new Error(`HANDOFF_PAYMENT_VERIFY_COUNT_MISMATCH expected_at_least=${expectedVerificationCount} actual=${Number(verification?.paymentCount || 0)}`);
  }
  if (expectedVerificationCount && !Array.isArray(verification?.paymentStatuses)) {
    throw new Error('HANDOFF_PAYMENT_STATUS_VERIFY_MISSING');
  }

  const paymentStatusRows = Array.isArray(verification?.paymentStatuses) ? verification.paymentStatuses : [];
  const statusIds = new Set(paymentStatusRows.map((row) => String(normalizePendingPaymentId(row?.id))).filter(Boolean));
  const missingMealVerifyIds = expectedMealIds.filter((id) => !statusIds.has(String(id)));
  if (missingMealVerifyIds.length) throw new Error(`HANDOFF_MEAL_VERIFY_MISSING:${missingMealVerifyIds.join(',')}`);

  const badPayment = paymentStatusRows.find((row) => !paymentVerifiedForHandoff(row, handoff.id));
  if (badPayment) throw new Error(`HANDOFF_PAYMENT_VERIFY_FAILED:${badPayment.id || 'UNKNOWN'}`);

  return { handoff, items, itemSum, handoffAmount };
}


async function ensureTransportCollectedRowsHaveWorkerOwner(pin, paymentIds = [], actor = {}) {
  const cleanPin = String(pin || '').trim();
  const ids = [...new Set((Array.isArray(paymentIds) ? paymentIds : []).map((id) => normalizePendingPaymentId(id)).filter(Boolean))];
  if (!cleanPin || !ids.length) return { ok: true, count: 0 };

  const patch = {
    handed_by_pin: cleanPin,
    handed_by_name: actor?.name || null,
    updated_at: nowIso(),
  };

  try {
    const { data, error } = await supabase
      .from(PENDING_CASH_TABLE)
      .update(patch)
      .in('id', ids)
      .eq('type', ARKA_PAYMENT_TYPE.TRANSPORT)
      .eq('status', ARKA_PAYMENT_STATUS.COLLECTED)
      .eq('created_by_pin', cleanPin)
      .is('handed_by_pin', null)
      .select('id');

    if (error) throw error;
    return { ok: true, count: Array.isArray(data) ? data.length : 0 };
  } catch (error) {
    if (!isMissingColumnError(error)) throw error;

    // Older DB shape fallback: handed_by_name may not exist, but handed_by_pin is the critical field.
    const { data, error: retryError } = await supabase
      .from(PENDING_CASH_TABLE)
      .update({
        handed_by_pin: cleanPin,
        updated_at: nowIso(),
      })
      .in('id', ids)
      .eq('type', ARKA_PAYMENT_TYPE.TRANSPORT)
      .eq('status', ARKA_PAYMENT_STATUS.COLLECTED)
      .eq('created_by_pin', cleanPin)
      .is('handed_by_pin', null)
      .select('id');

    if (retryError) throw retryError;
    return { ok: true, count: Array.isArray(data) ? data.length : 0, fallback: true };
  }
}

export async function submitWorkerCashToDispatch({ actor, note = '', amountOverride = null }) {
  const pin = String(actor?.pin || '').trim();
  if (!pin) throw new Error('MUNGON PIN-I I PUNËTORIT.');

  const lockKey = `worker_cash_handoff:${pin}`;
  if (ACTIVE_WORKER_HANDOFF_SUBMITS.has(lockKey)) {
    throw new Error('DORËZIMI ËSHTË DUKE U KRYER. MOS E SHTYP DY HERË.');
  }

  ACTIVE_WORKER_HANDOFF_SUBMITS.add(lockKey);
  try {
    const readyItems = await listWorkerReadyCash(pin);
    const paymentIds = readyItems
      .map((item) => normalizePendingPaymentId(item?.id))
      .filter(Boolean)
      .sort((a, b) => a - b);
    if (!paymentIds.length) throw new Error('NUK KA PAGESA GATI PËR DORËZIM.');

    const mealRows = await listWorkerUnsettledMealPayments(pin, { limit: 100 }).catch(() => []);
    const mealPaymentIds = (Array.isArray(mealRows) ? mealRows : [])
      .map((item) => normalizePendingPaymentId(item?.id))
      .filter(Boolean)
      .sort((a, b) => a - b);
    const includeUnsettledMeals = mealPaymentIds.length > 0;
    const expectedIds = [...new Set(paymentIds)].sort((a, b) => a - b);

    // Self-repair old transport cash rows created by older builds that saved
    // COLLECTED rows without handed_by_pin. The DB RPC requires handed_by_pin
    // to know which worker is allowed to submit the cash.
    await ensureTransportCollectedRowsHaveWorkerOwner(pin, expectedIds, actor);

    const result = await arkaTransaction({
      action: ARKA_ACTION.SUBMIT_HANDOFF,
      actorPin: pin,
      actorName: actor?.name || null,
      actorRole: actor?.role || null,
      amountDeclared: includeUnsettledMeals ? null : amountOverride,
      paymentIds,
      mealPaymentIds,
      note,
      includeUnsettledMeals,
      forceRpc: true,
      rpcOnly: true,
      idempotencyKey: buildArkaIdempotencyKey(ARKA_ACTION.SUBMIT_HANDOFF, [pin, paymentIds.join('-'), includeUnsettledMeals ? `MEAL:${mealPaymentIds.join('-')}` : 'NO_MEAL']),
    });

    const verified = verifyHandoffSubmitResponse(result, expectedIds, { expectedMealPaymentIds: mealPaymentIds });
    return {
      ...result,
      handoff: verified.handoff,
      items: verified.items,
      count: Number(result?.count || verified.items.length),
      total: n(result?.total || verified.handoffAmount),
      mealPaymentIds,
      mode: includeUnsettledMeals ? 'SUBMIT_CASH_HANDOFF_ATOMIC_RPC_WITH_MEAL_DEDUCT' : 'SUBMIT_CASH_HANDOFF_ATOMIC_RPC',
    };
  } finally {
    ACTIVE_WORKER_HANDOFF_SUBMITS.delete(lockKey);
  }
}


export async function acceptDispatchHandoff({ handoffId, actor }) {
  const id = Number(handoffId || 0);
  if (!id) throw new Error('MUNGON ID E DORËZIMIT.');
  if (!actor?.pin) throw new Error('MUNGON PIN-I I DISPATCH.');

  // Fast live path: call the DB atomic accept RPC directly from the client.
  // This avoids the mobile/PWA /api fetch timeout that can show ARKA_NETWORK_UNREACHABLE
  // even while Supabase realtime/queries are working. We still verify DB commit before success.
  let directRpcError = null;
  try {
    return await acceptDispatchHandoffDirectRpc(id, actor);
  } catch (error) {
    directRpcError = error;
    // Older DBs may not have the RPC yet. In that case keep the legacy HTTP path.
    // For real RPC failures we still try the HTTP/admin path once before showing error.
  }

  try {
    const result = await arkaTransaction({
      action: ARKA_ACTION.ACCEPT_HANDOFF,
      handoffId: id,
      actorPin: actor.pin,
      actorName: actor?.name || null,
      actorRole: actor?.role || null,
      queueOnNetworkFailure: false,
      idempotencyKey: buildArkaIdempotencyKey(ARKA_ACTION.ACCEPT_HANDOFF, [id]),
    }, {
      queueOnNetworkFailure: false,
      timeoutMs: isAcceptRpcUnavailableError(directRpcError) ? 20000 : 8000,
      maxAttempts: 1,
    });

    return assertDispatchAcceptCommitted(id, result);
  } catch (apiError) {
    if (isAcceptRpcUnavailableError(directRpcError)) throw apiError;
    throw new Error(String(directRpcError?.message || apiError?.message || 'NUK U PRANUA CASH.'));
  }
}


export async function rejectDispatchHandoff({ handoffId, actor, note = '' }) {
  const id = Number(handoffId || 0);
  if (!id) throw new Error('MUNGON ID E DORËZIMIT.');
  if (!actor?.pin) throw new Error('MUNGON PIN-I I DISPATCH.');
  return arkaTransaction({
    action: ARKA_ACTION.REJECT_HANDOFF,
    handoffId: id,
    actorPin: actor.pin,
    actorName: actor?.name || null,
    actorRole: actor?.role || null,
    note: note || 'KTHYER TE PUNTORI',
    idempotencyKey: buildArkaIdempotencyKey(ARKA_ACTION.REJECT_HANDOFF, [id]),
  });
}


export async function spendFromCompanyBudget({
  actor,
  amount,
  category = 'SHPENZIM',
  description = '',
  workerPin = null,
  workerName = null,
  sourceType = 'manual',
  sourceId = null,
  clientActionId = null,
  idempotencyKey = null,
} = {}) {
  const amt = +n(amount).toFixed(2);
  if (!(amt > 0)) throw new Error('SHUMA DUHET MBI 0€.');
  if (!actor?.pin && !workerPin) throw new Error('MUNGON PIN-I.');
  const cleanClientActionId = clean(clientActionId || '', '');
  const manualActionId = cleanClientActionId || (!sourceId
    ? buildArkaIdempotencyKey(ARKA_ACTION.COMPANY_BUDGET_SPEND, [
        sourceType || 'manual',
        actor?.pin || workerPin || '',
        category || 'SHPENZIM',
        amt.toFixed(2),
        description || '',
      ])
    : '');
  const stableSpendKey = clean(idempotencyKey || '', '') || buildArkaIdempotencyKey(
    ARKA_ACTION.COMPANY_BUDGET_SPEND,
    [sourceType || 'manual', sourceId || manualActionId || 'manual']
  );
  const note = [
    clean(description || category || 'SHPENZIM NGA BUXHETI', 'SHPENZIM NGA BUXHETI'),
    sourceType ? `source:${sourceType}` : '',
    sourceId ? `id:${sourceId}` : '',
    manualActionId ? `clientAction:${manualActionId}` : '',
  ].filter(Boolean).join(' | ');
  return arkaTransaction({
    action: ARKA_ACTION.COMPANY_BUDGET_SPEND,
    actorPin: actor?.pin || workerPin,
    actorName: actor?.name || workerName || null,
    actorRole: actor?.role || null,
    workerPin: workerPin || actor?.pin || null,
    workerName: workerName || actor?.name || null,
    sourceModule: ARKA_SOURCE_MODULE.ARKA,
    amount: amt,
    category,
    description: note,
    sourceType,
    sourceId,
    clientActionId: manualActionId || undefined,
    idempotencyKey: stableSpendKey || undefined,
  });
}


export async function deleteCompanyBudgetEntry({ entryId } = {}) {
  throw new Error('COMPANY_BUDGET_LEDGER_DELETE_DISABLED_USE_BUDGET_ADJUSTMENT');
}


function uniqueById(rows = []) {
  const map = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row) continue;
    const key = String(row?.id || `${row?.created_at || ''}_${row?.amount || ''}_${row?.status || ''}_${row?.note || ''}`);
    if (!map.has(key)) map.set(key, row);
  }
  return [...map.values()];
}

function ledgerMatchesWorkerAdvance(row, pin) {
  const cleanPin = clean(pin);
  if (!cleanPin) return false;
  const parsed = parseWorkerRefFromLedgerText(row?.description || row?.note || '');
  if (clean(parsed?.pin) === cleanPin) return true;
  const text = `${clean(row?.description)} ${clean(row?.note)} ${clean(parsed?.name)}`.toUpperCase();
  return text.includes(`(${cleanPin.toUpperCase()})`) || text.includes(`PIN ${cleanPin.toUpperCase()}`) || text.includes(cleanPin.toUpperCase());
}

export async function listWorkerDebtRows(pin, limit = 200) {
  const cleanPin = clean(pin);
  if (!cleanPin) return [];

  const [createdRes, handedRes, advanceLedgerRes] = await Promise.allSettled([
    supabase
      .from(PENDING_CASH_TABLE)
      .select('*')
      .eq('created_by_pin', cleanPin)
      .in('status', ['OWED', 'REJECTED', 'WORKER_DEBT', 'ADVANCE'])
      .order('created_at', { ascending: false })
      .limit(limit),
    supabase
      .from(PENDING_CASH_TABLE)
      .select('*')
      .eq('handed_by_pin', cleanPin)
      .in('status', ['OWED', 'REJECTED', 'WORKER_DEBT', 'ADVANCE'])
      .order('created_at', { ascending: false })
      .limit(limit),
    supabase
      .from(LEDGER_TABLE)
      // Worker metadata is not guaranteed as top-level columns in this DB.
      // Read only stable columns and recover worker identity from description when needed.
      .select('id,amount,category,description,created_at,direction')
      .eq('direction', 'OUT')
      .eq('category', 'WORKER_ADVANCE')
      .order('created_at', { ascending: false })
      .limit(limit),
  ]);

  const debtRows = [
    ...(createdRes.status === 'fulfilled' && Array.isArray(createdRes.value?.data) ? createdRes.value.data : []),
    ...(handedRes.status === 'fulfilled' && Array.isArray(handedRes.value?.data) ? handedRes.value.data : []),
  ];

  const advanceLedgerRows = (advanceLedgerRes.status === 'fulfilled' && Array.isArray(advanceLedgerRes.value?.data)
    ? advanceLedgerRes.value.data
    : [])
    .filter((row) => ledgerMatchesWorkerAdvance(row, cleanPin))
    .map((row) => {
      const parsedWorker = parseWorkerRefFromLedgerText(row?.description || '');
      return {
        id: `ledger_${row.id}`,
        amount: n(row?.amount),
        status: 'ADVANCE',
        type: 'ADVANCE',
        note: row?.description || 'AVANS NGA BUXHETI',
        handoff_note: row?.description || null,
        created_at: row?.created_at || null,
        updated_at: row?.created_at || null,
        category: row?.category || 'WORKER_ADVANCE',
        worker_pin: parsedWorker?.pin || cleanPin,
        worker_name: parsedWorker?.name || null,
        source_table: LEDGER_TABLE,
        source_id: row?.id || null,
      };
    });

  return uniqueById([...debtRows, ...advanceLedgerRows])
    .sort((a, b) => String(b?.created_at || b?.updated_at || '').localeCompare(String(a?.created_at || a?.updated_at || '')))
    .slice(0, limit);
}
