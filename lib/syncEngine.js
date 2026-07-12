import { supabase, storageWithTimeout, withSupabaseTimeout } from '@/lib/supabaseClient';
import logger from '@/lib/logger';
import { bumpSyncCounter, syncDebugLog } from '@/lib/syncDebug';
import { clearPendingMutationsFromOp } from '@/lib/reconcile/pendingMutations';
import { isBaseScopedOp } from '@/lib/transportCore/scope';
import { sanitizeTransportOrderPayload } from '@/lib/transport/sanitize';
import { insertTransportOrder } from '@/lib/transport/transportDb';
import { buildPranimiFinalOrderData, normalizePranimiFinalOrderRow, isPranimiFinalOrderStatus } from './pranimiOrderLifecycle.js';
import { ARKA_SYNC_HTTP_TIMEOUT_MS, postArkaTransaction } from '@/lib/arka/arkaNetwork';

let offlineStoreModulePromise = null;
let syncRecoveryModulePromise = null;

function loadOfflineStoreModule() {
  if (!offlineStoreModulePromise) {
    offlineStoreModulePromise = import('@/lib/offlineStore').catch((error) => {
      offlineStoreModulePromise = null;
      throw error;
    });
  }
  return offlineStoreModulePromise;
}
function loadSyncRecoveryModule() {
  if (!syncRecoveryModulePromise) {
    syncRecoveryModulePromise = import('@/lib/syncRecovery').catch((error) => {
      syncRecoveryModulePromise = null;
      throw error;
    });
  }
  return syncRecoveryModulePromise;
}

async function deleteOp(...args) {
  const mod = await loadOfflineStoreModule();
  return mod.deleteOp(...args);
}
async function deleteOrderLocal(...args) {
  const mod = await loadOfflineStoreModule();
  return mod.deleteOrderLocal(...args);
}
async function getPendingOps(...args) {
  const mod = await loadOfflineStoreModule();
  return mod.getPendingOps(...args);
}
async function pushOp(...args) {
  const mod = await loadOfflineStoreModule();
  return mod.pushOp(...args);
}
async function markOpFailedPermanently(...args) {
  const mod = await loadOfflineStoreModule();
  if (typeof mod?.markOpFailedPermanently === 'function') return mod.markOpFailedPermanently(...args);
  return pushOp(args[0]);
}
async function saveOrderLocal(...args) {
  const mod = await loadOfflineStoreModule();
  return mod.saveOrderLocal(...args);
}
function clearBaseCreateRecovery(...args) {
  void loadSyncRecoveryModule()
    .then((mod) => {
      if (typeof mod?.clearBaseCreateRecovery === 'function') mod.clearBaseCreateRecovery(...args);
    })
    .catch(() => {});
}
function rememberBaseCreateRecovery(...args) {
  void loadSyncRecoveryModule()
    .then((mod) => {
      if (typeof mod?.rememberBaseCreateRecovery === 'function') mod.rememberBaseCreateRecovery(...args);
    })
    .catch(() => {});
}

const SNAPSHOT_KEY = 'tepiha_sync_snapshot_v1';
const LOCK_KEY = 'tepiha_sync_lock_v1';
const LOCK_TTL_MS = 45 * 1000;
const TAB_ID = `tab_${Math.random().toString(36).slice(2)}_${Date.now()}`;
const MAX_ATTEMPTS = 4;
const NETWORK_BACKOFF_MS = 60 * 1000;
const SOFT_BACKOFF_MS = 15 * 1000;
const HARD_BACKOFF_MS = 5 * 60 * 1000;
const AUTO_DEBOUNCE_MS = 1200;
const MAX_SYNC_RUN_MS = 20000;
const SYNC_OP_TIMEOUT_MS = 12000;
const STORAGE_UPLOAD_TIMEOUT_MS = 10000;

let running = null;
let isInitialized = false;
let scheduledTimer = null;
let scheduledPromise = null;
let scheduledResolve = null;
let lastScheduledOpts = null;
let snapshotWriteTimer = null;
let snapshotPayload = [];

function rid() {
  return (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : `op_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function isOnline() {
  try { return typeof navigator === 'undefined' ? true : navigator.onLine !== false; } catch { return true; }
}

function nowIso() {
  return new Date().toISOString();
}


function roundMoney(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? Number(n.toFixed(2)) : 0;
}

function normalizeCashGuardStatus(value = '') {
  return String(value || '').trim().toLowerCase().replace('ë', 'e');
}

function isDeliveredBaseStatus(value = '') {
  const status = normalizeCashGuardStatus(value);
  return ['dorzim', 'dorezim', 'delivery', 'delivered', 'completed', 'kompletuar'].includes(status);
}

function readNestedObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function readCashPaidAmountFromData(data = {}, fallbackTotal = 0) {
  const pay = readNestedObject(data?.pay);
  const paid = roundMoney(Math.max(
    Number(pay?.paid || 0),
    Number(data?.paid || 0),
    Number(data?.paid_eur || 0),
    Number(data?.clientPaid || 0),
    Number(data?.paid_cash || 0)
  ));
  const total = roundMoney(pay?.euro ?? pay?.total ?? data?.price_total ?? data?.total ?? fallbackTotal ?? 0);
  const debt = roundMoney(pay?.debt ?? data?.debt ?? Math.max(0, total - paid));
  const method = String(pay?.method || data?.pay_method || data?.method || 'CASH').trim().toUpperCase();
  return { paid, total, debt, method };
}

function extractActorForCashGuard(patch = {}, order = {}) {
  const data = readNestedObject(patch?.data);
  const pay = readNestedObject(data?.pay);
  const orderData = readNestedObject(order?.data);
  const orderPay = readNestedObject(orderData?.pay);
  const pin = String(
    patch?.delivered_by ||
    data?.delivered_by ||
    pay?.delivered_by ||
    pay?.actorPin ||
    pay?.actor_pin ||
    pay?.created_by_pin ||
    orderData?.delivered_by ||
    orderPay?.delivered_by ||
    ''
  ).trim();
  const name = String(
    data?.delivered_by_name ||
    pay?.actorName ||
    pay?.actor_name ||
    pay?.created_by_name ||
    orderData?.delivered_by_name ||
    orderPay?.actorName ||
    ''
  ).trim();
  const role = String(pay?.actorRole || pay?.actor_role || pay?.created_by_role || '').trim();
  return { pin, name, role };
}

async function resolveOrderForCashGuard(id, patch = {}) {
  const rawId = String(id || '').trim();
  if (!rawId) return null;
  let query = supabase.from('orders').select('id,code,client_name,client_phone,status,price_total,data');
  query = isNumericDbId(rawId) ? query.eq('id', Number(rawId)) : query.eq('local_oid', rawId);
  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  if (data?.id) return data;
  return null;
}

async function sumActiveBaseArkaPayments(orderId) {
  if (!isNumericDbId(orderId)) return { sum: 0, rows: [] };
  const { data, error } = await supabase
    .from('arka_pending_payments')
    .select('id,amount,status,type,source_module,order_id')
    .eq('order_id', Number(orderId))
    .eq('type', 'IN')
    .eq('source_module', 'BASE')
    .in('status', ['PENDING', 'COLLECTED', 'PENDING_DISPATCH_APPROVAL', 'ACCEPTED_BY_DISPATCH', 'HANDED'])
    .limit(50);
  if (error) throw error;
  const rows = Array.isArray(data) ? data : [];
  const sum = roundMoney(rows.reduce((acc, row) => acc + roundMoney(row?.amount), 0));
  return { sum, rows };
}

function buildBaseCashGuardIdempotencyKey({ orderId, amount, actorPin } = {}) {
  return ['BASE_ORDER_PAYMENT', orderId, roundMoney(amount).toFixed(2), actorPin || 'NO_PIN']
    .map((x) => String(x || '').trim())
    .filter(Boolean)
    .join(':');
}

async function ensureArkaPaymentBeforePaidCashOrderPatch(table, id, patch = {}) {
  if (table !== 'orders') return { ok: true, skipped: true, reason: 'NOT_BASE_ORDER' };

  const patchData = readNestedObject(patch?.data);
  const hasPaymentIntent =
    isPlainObject(patchData?.pay) ||
    ['paid', 'paid_eur', 'paid_cash', 'debt', 'clientPaid', 'pay_method', 'method'].some((key) => hasOwn(patch, key) || hasOwn(patchData, key));
  if (!hasPaymentIntent) return { ok: true, skipped: true, reason: 'NO_PAYMENT_INTENT' };

  const order = await resolveOrderForCashGuard(id, patch);
  if (!order?.id) return { ok: true, skipped: true, reason: 'ORDER_NOT_RESOLVED_YET' };

  const orderData = readNestedObject(order?.data);
  const requestedStatus = patch?.status || patchData?.status || order?.status || orderData?.status || '';
  if (!isDeliveredBaseStatus(requestedStatus)) return { ok: true, skipped: true, reason: 'NOT_DELIVERED_STATUS' };

  const mergedData = {
    ...orderData,
    ...patchData,
    paid: patch?.paid ?? patch?.paid_eur ?? patchData?.paid ?? patchData?.paid_eur ?? orderData?.paid,
    paid_eur: patch?.paid_eur ?? patchData?.paid_eur ?? orderData?.paid_eur,
    paid_cash: patch?.paid_cash ?? patchData?.paid_cash ?? orderData?.paid_cash,
    debt: patch?.debt ?? patchData?.debt ?? orderData?.debt,
    price_total: patch?.price_total ?? patchData?.price_total ?? order?.price_total ?? orderData?.price_total,
  };
  if (isPlainObject(patchData?.pay) || isPlainObject(orderData?.pay)) {
    mergedData.pay = {
      ...readNestedObject(orderData?.pay),
      ...readNestedObject(patchData?.pay),
    };
  }

  const cash = readCashPaidAmountFromData(mergedData, patch?.price_total ?? order?.price_total ?? 0);
  if (cash.method !== 'CASH') return { ok: true, skipped: true, reason: 'NON_CASH_METHOD' };
  if (!(cash.paid > 0) || cash.debt > 0.01) return { ok: true, skipped: true, reason: 'NOT_FULLY_PAID_CASH' };

  const active = await sumActiveBaseArkaPayments(order.id);
  const expectedPaid = roundMoney(Math.min(cash.paid, cash.total || cash.paid));
  const missingAmount = roundMoney(expectedPaid - active.sum);
  if (missingAmount <= 0.005) return { ok: true, skipped: true, reason: 'ARKA_ALREADY_COVERED', activePaymentSum: active.sum };

  const actor = extractActorForCashGuard(patch, order);
  if (!actor.pin) {
    const err = new Error('ARKA_SYNC_GUARD_ACTOR_PIN_REQUIRED_FOR_PAID_CASH_ORDER');
    err.details = { orderId: order.id, orderCode: order.code, amount: missingAmount, clientName: order.client_name || mergedData?.client_name || '' };
    throw err;
  }

  const idempotencyKey = buildBaseCashGuardIdempotencyKey({ orderId: order.id, amount: missingAmount, actorPin: actor.pin });
  const orderCode = patchData?.code || patch?.code || order?.code || mergedData?.code || mergedData?.client?.code || '';
  const clientName = patchData?.client_name || patchData?.client?.name || order?.client_name || mergedData?.client_name || mergedData?.client?.name || '';
  const clientPhone = patchData?.client_phone || patchData?.client?.phone || order?.client_phone || mergedData?.client_phone || mergedData?.client?.phone || '';

  await postArkaTransaction({
    action: 'BASE_ORDER_PAYMENT',
    actorPin: actor.pin,
    actorName: actor.name || null,
    actorRole: actor.role || null,
    orderId: order.id,
    amount: missingAmount,
    method: 'CASH',
    note: `PAGESA ${missingAmount.toFixed(2)}€ • #${orderCode || ''} • ${clientName || ''} | SYNC_GUARD_PAID_CASH_ORDER`,
    orderCode,
    clientName,
    clientPhone,
    statusOnFullPayment: 'dorzim',
    idempotencyKey,
    idempotency_key: idempotencyKey,
    queueOnNetworkFailure: false,
    _sync_guard: 'paid_cash_order_requires_arka_payment',
  }, { timeoutMs: Math.min(ARKA_SYNC_HTTP_TIMEOUT_MS, SYNC_OP_TIMEOUT_MS - 1000) });

  return { ok: true, createdOrReused: true, amount: missingAmount, orderId: order.id, idempotencyKey };
}

function isPlainObject(value) {
  return !!value && Object.prototype.toString.call(value) === '[object Object]';
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj || {}, key);
}

function isNumericDbId(value) {
  return /^\d+$/.test(String(value || '').trim());
}

function getDbTruthStatus(row = {}) {
  const top = String(row?.status ?? '').trim();
  if (top) return top;
  const data = isPlainObject(row?.data) ? row.data : {};
  return String(data?.status ?? '').trim();
}

function normalizeBaseInsertPayload(row = {}) {
  let out = { ...(row || {}) };
  const data = isPlainObject(out?.data) ? { ...out.data } : {};
  const nextStatus = String(out?.status || data?.status || 'pastrim').trim();
  if (nextStatus) {
    out.status = nextStatus;
    out.data = { ...data, status: nextStatus };
  }
  if (isPranimiFinalOrderStatus(out?.status || out?.data?.status)) {
    out = normalizePranimiFinalOrderRow(out, {
      status: out?.status || out?.data?.status,
      localOid: out?.local_oid || out?.data?.local_oid || '',
      saveAttemptId: out?.data?.pranimi_code_lifecycle?.save_attempt_id || out?.data?.save_attempt_id || '',
      verifyState: 'DB_VERIFIED',
      source: 'DB_FINAL',
      draftSource: out?.data?.pranimi_draft_source || 'FINAL / SYNC UPSERT',
    });
  }
  return out;
}

async function fetchCurrentBaseRowByIdOrLocalOid(table, id) {
  if (table !== 'orders') return null;
  const rawId = String(id || '').trim();
  if (!rawId) return null;
  let q = supabase.from('orders').select('id,status,data');
  q = isNumericDbId(rawId) ? q.eq('id', Number(rawId)) : q.eq('local_oid', rawId);
  const { data, error } = await q.maybeSingle();
  if (error) throw error;
  return data || null;
}

async function normalizeBaseUpdatePatch(table, id, patch = {}) {
  if (table !== 'orders') return patch;
  const out = { ...(patch || {}) };
  const hasStatus = hasOwn(out, 'status') && String(out?.status ?? '').trim() !== '';
  const hasData = isPlainObject(out?.data);
  if (!hasStatus && !hasData) return out;

  const current = await fetchCurrentBaseRowByIdOrLocalOid(table, id);
  const currentData = isPlainObject(current?.data) ? current.data : {};
  const dbStatus = getDbTruthStatus(current);
  const nextStatus = hasStatus ? String(out.status).trim() : dbStatus;
  const nextData = { ...currentData, ...(hasData ? out.data : {}) };
  if (nextStatus) nextData.status = nextStatus;
  if (hasStatus) out.status = nextStatus;
  if (hasData || hasStatus || dbStatus) out.data = nextData;
  if (isPranimiFinalOrderStatus(out?.status || out?.data?.status)) {
    return normalizePranimiFinalOrderRow(out, {
      status: out?.status || out?.data?.status,
      localOid: out?.local_oid || out?.data?.local_oid || current?.local_oid || '',
      saveAttemptId: out?.data?.pranimi_code_lifecycle?.save_attempt_id || out?.data?.save_attempt_id || '',
      verifyState: 'DB_VERIFIED',
      source: 'DB_FINAL',
      draftSource: out?.data?.pranimi_draft_source || 'FINAL / SYNC UPDATE',
    });
  }
  return out;
}

function sortOps(ops = []) {
  return [...(Array.isArray(ops) ? ops : [])].sort((a, b) => {
    const aPaused = String(a?.status || '') === 'paused' ? 1 : 0;
    const bPaused = String(b?.status || '') === 'paused' ? 1 : 0;
    if (aPaused !== bPaused) return aPaused - bPaused;
    const aNext = Number(a?.nextRetryAt || 0);
    const bNext = Number(b?.nextRetryAt || 0);
    if (aNext !== bNext) return aNext - bNext;
    const aCreated = Date.parse(a?.created_at || a?.createdAt || 0) || 0;
    const bCreated = Date.parse(b?.created_at || b?.createdAt || 0) || 0;
    return aCreated - bCreated;
  });
}

function emitSyncStatus(syncing, extra = {}) {
  try {
    if (typeof window === 'undefined') return;
    const detail = { syncing: !!syncing, online: isOnline(), at: Date.now(), ...extra };
    window.dispatchEvent(new CustomEvent('tepiha:sync-status', {
      detail,
    }));
    syncDebugLog('probe_sync_status', detail);
  } catch {}
}

function mapOpToSnapshot(op = {}) {
  const payload = op?.payload && typeof op.payload === 'object'
    ? op.payload
    : (op?.data && typeof op.data === 'object' ? op.data : {});
  const table = String(payload?.table || op?.table || payload?._table || '');
  return {
    id: String(op?.op_id || op?.id || rid()),
    op_id: String(op?.op_id || op?.id || rid()),
    kind: String(op?.type || op?.kind || op?.op || 'op'),
    status: String(op?.status || 'pending'),
    attempts: Number(op?.attempts || 0),
    createdAt: op?.created_at || nowIso(),
    uniqueValue: payload?.localId || payload?.id || payload?.local_oid || payload?.code || op?.id || '',
    lastError: op?.lastError || null,
    nextRetryAt: op?.nextRetryAt || null,
    payload,
    table,
  };
}

function scheduleSnapshotWrite(snapshot = []) {
  try {
    if (typeof window === 'undefined') return;
    snapshotPayload = Array.isArray(snapshot) ? snapshot : [];
    if (snapshotWriteTimer) {
      window.clearTimeout(snapshotWriteTimer);
      snapshotWriteTimer = null;
    }
    try {
      window.localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snapshotPayload));
      window.dispatchEvent(new Event('tepiha:outbox-changed'));
    } catch {}
  } catch {}
}

async function refreshSnapshot() {
  try {
    const ops = sortOps(await getPendingOps()).filter((op) => isBaseScopedOp(op));
    const snapshot = ops.map(mapOpToSnapshot);
    if (typeof window !== 'undefined') {
      scheduleSnapshotWrite(snapshot);
    }
    return snapshot;
  } catch (error) {
    logger.warn('syncEngine.refreshSnapshot.failed', { error: String(error?.message || error || '') });
    return [];
  }
}

function getPayload(op) {
  return op?.payload && typeof op.payload === 'object'
    ? op.payload
    : (op?.data && typeof op.data === 'object' ? op.data : {});
}

function readLock() {
  try {
    if (typeof window === 'undefined') return null;
    const raw = window.localStorage.getItem(LOCK_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function acquireLock() {
  try {
    if (typeof window === 'undefined') return true;
    const now = Date.now();
    const current = readLock();
    if (
      current?.owner &&
      current.owner !== TAB_ID &&
      Number(current?.ts || 0) > 0 &&
      (now - Number(current.ts)) < LOCK_TTL_MS
    ) {
      return false;
    }
    window.localStorage.setItem(LOCK_KEY, JSON.stringify({ owner: TAB_ID, ts: now }));
    const verify = readLock();
    return verify?.owner === TAB_ID;
  } catch {
    return true;
  }
}

function refreshLock() {
  try {
    if (typeof window === 'undefined') return;
    const current = readLock();
    if (current?.owner === TAB_ID) {
      window.localStorage.setItem(LOCK_KEY, JSON.stringify({ owner: TAB_ID, ts: Date.now() }));
    }
  } catch {}
}

function releaseLock() {
  try {
    if (typeof window === 'undefined') return;
    const current = readLock();
    if (!current || current.owner === TAB_ID) {
      window.localStorage.removeItem(LOCK_KEY);
    }
  } catch {}
}

function getErrorText(error) {
  try {
    if (!error) return '';
    if (typeof error === 'string') return error;
    return JSON.stringify({
      message: error?.message || '',
      details: error?.details || '',
      hint: error?.hint || '',
      code: error?.code || '',
      status: error?.status || '',
      name: error?.name || '',
    });
  } catch {
    return String(error || '');
  }
}

function isNetworkLikeError(error) {
  const msg = String(error?.message || error || '').toLowerCase();
  return (
    msg.includes('load failed') ||
    msg.includes('failed to fetch') ||
    msg.includes('networkerror') ||
    msg.includes('network request failed') ||
    msg.includes('fetch failed') ||
    msg.includes('timeout') ||
    msg.includes('aborted')
  );
}

function isStructuralSchemaError(error) {
  const text = getErrorText(error).toLowerCase();
  return (
    text.includes('pgrst') ||
    text.includes('schema cache') ||
    text.includes('column') ||
    text.includes("could not find the 'data_patch' column") ||
    text.includes('does not exist')
  );
}


function validateOpShape(op = {}) {
  const type = String(op?.type || op?.op || '').trim();
  const payload = getPayload(op);
  if (type === 'insert_order') {
    const row = payload?.insertRow || payload || {};
    const table = String(row?.table || payload?.table || '').trim();
    const id = String(payload?.localId || row?.local_oid || row?.id || op?.id || '').trim();
    if (!table) return 'MISSING_TABLE';
    if (!id) return 'MISSING_ID';
  }
  if (type === 'set_status' || type === 'patch_order_data' || type === 'update') {
    const id = String(payload?.id || payload?.order_id || payload?.local_oid || op?.id || '').trim();
    if (!id) return 'MISSING_ID';
  }
  if (type === 'arka_transaction') {
    const tx = payload?.transaction && typeof payload.transaction === 'object' ? payload.transaction : payload;
    const action = String(tx?.action || payload?.action || '').trim();
    const idempotency = String(tx?.idempotencyKey || tx?.idempotency_key || payload?.idempotency_key || '').trim();
    if (!action) return 'MISSING_ARKA_ACTION';
    if (!idempotency) return 'MISSING_ARKA_IDEMPOTENCY_KEY';
  }
  return '';
}

function shouldRetryYet(op = {}) {
  const status = String(op?.status || '').trim();
  if (status === 'failed_permanently' || status === 'dead_letter' || status === 'resolved_linked') return false;
  const nextRetryAt = Number(op?.nextRetryAt || 0);
  return !nextRetryAt || Date.now() >= nextRetryAt;
}

function buildRetriedOp(op = {}, error, { networkLike = false } = {}) {
  const attempts = Number(op?.attempts || 0) + 1;
  const exhausted = attempts >= MAX_ATTEMPTS;
  const waitMs = exhausted
    ? HARD_BACKOFF_MS
    : (networkLike ? NETWORK_BACKOFF_MS : SOFT_BACKOFF_MS * attempts);

  return {
    ...op,
    attempts,
    lastError: { message: String(error?.message || error || 'SYNC_FAILED'), at: nowIso() },
    nextRetryAt: Date.now() + waitMs,
    status: exhausted ? 'paused' : 'pending',
  };
}

function markFailedPermanently(op = {}, error) {
  const payload = getPayload(op);
  const data = payload?.data && typeof payload.data === 'object' ? payload.data : {};
  const life = data?.pranimi_code_lifecycle && typeof data.pranimi_code_lifecycle === 'object' ? data.pranimi_code_lifecycle : {};
  const at = nowIso();
  return {
    ...op,
    status: 'failed_permanently',
    attempts: Number(op?.attempts || 0) + 1,
    retry_count: Number(op?.attempts || 0) + 1,
    nextRetryAt: null,
    failed_at: at,
    lastError: {
      message: String(error?.message || error || 'STRUCTURAL_SYNC_ERROR'),
      code: error?.code || null,
      details: error?.details || null,
      hint: error?.hint || null,
      at,
    },
    sync_safety: {
      preserve_payload: true,
      local_oid: String(payload?.local_oid || data?.local_oid || life?.local_oid || op?.id || ''),
      save_attempt_id: String(life?.save_attempt_id || data?.save_attempt_id || payload?.save_attempt_id || ''),
      op_id: String(op?.op_id || ''),
      worker_pin: String(life?.pin || payload?.worker_pin || data?.worker_pin || ''),
      failed_at: at,
    },
  };
}

async function discardPermanentOp(op, error) {
  try {
    const failedOp = await markOpFailedPermanently(markFailedPermanently(op, error), error, { incrementAttempts: false });
    logger.error('syncEngine.permanent-stop', { type: op?.type || op?.op, op_id: failedOp?.op_id || op?.op_id, lastError: failedOp?.lastError || error });
    syncDebugLog('dead_letter_created', {
      op_id: String(failedOp?.op_id || op?.op_id || ''),
      type: String(op?.type || op?.op || ''),
      status: String(failedOp?.status || 'failed_permanently'),
      message: String(error?.message || error || 'STRUCTURAL_SYNC_ERROR'),
    });
  } catch (markError) {
    logger.error('syncEngine.permanent-stop.persist-failed', { error: String(markError?.message || markError || ''), original: String(error?.message || error || '') });
  }
}

async function upsertOrdersRow(table, row, onConflict = 'local_oid') {
  let payload = { ...(row || {}) };
  if (table === 'orders') payload = normalizeBaseInsertPayload(payload);
  if (!payload.updated_at) payload.updated_at = nowIso();
  if (table === 'transport_orders') {
    const result = await insertTransportOrder(payload);
    if (!result?.ok) {
      const error = new Error(result?.error || 'TRANSPORT_ORDER_SYNC_CREATE_FAILED');
      error.code = result?.code || '';
      throw error;
    }
    return result.data;
  }
  const q = supabase.from(table).upsert(payload, { onConflict }).select('id').maybeSingle();
  const { data, error } = await q;
  if (error) throw error;
  return data;
}

function stripNonSchemaCols(row, table = 'orders') {
  if (!row || typeof row !== 'object') return row;
  const out = { ...(row || {}) };

  delete out.table;
  delete out.localOnly;
  delete out.kind;
  delete out.op;
  delete out.op_id;
  delete out.attempts;
  delete out.lastError;
  delete out.nextRetryAt;
  delete out.server_id;
  delete out.save_attempt_id;
  delete out.phone_digits;
  delete out.pa_numer;
  delete out.oid;
  delete out._table;
  delete out.local_id;
  delete out.localId;
  delete out.sync_safety;
  delete out.retry_count;
  delete out.failed_at;
  delete out.last_error;
  delete out.outbox_op_id;

  Object.keys(out).forEach((key) => {
    if (String(key || '').startsWith('_')) delete out[key];
  });

  if ('client' in out) delete out.client;
  if ('code_n' in out) delete out.code_n;
  if ('data_patch' in out) delete out.data_patch;

  if (table === 'orders') {
    delete out.id;
    return out;
  }

  if (table === 'transport_orders') {
    return sanitizeTransportOrderPayload(out);
  }

  return out;
}

async function updateByIdOrLocalOid(table, id, patch) {
  let clean = stripNonSchemaCols({ ...(patch || {}) }, table);
  if (!clean.updated_at) clean.updated_at = nowIso();
  clean = await normalizeBaseUpdatePatch(table, id, clean);

  await ensureArkaPaymentBeforePaidCashOrderPatch(table, id, clean);

  let res = await supabase.from(table).update(clean).eq('id', id).select('id').maybeSingle();
  if (!res.error && res.data) return res.data;

  if (table === 'orders') {
    res = await supabase.from(table).update(clean).eq('local_oid', id).select('id').maybeSingle();
    if (!res.error && res.data) return res.data;
  }

  if (res.error) throw res.error;
  return null;
}


function firstPresent(...values) {
  for (const value of values) {
    if (value === 0) return value;
    if (value === false) return value;
    if (value == null) continue;
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed) return trimmed;
      continue;
    }
    return value;
  }
  return undefined;
}

function normalizeCode(...values) {
  const picked = firstPresent(...values);
  if (picked == null) return undefined;
  const text = String(picked).trim();
  if (!text) return undefined;
  return /^\d+$/.test(text) ? Number(text) : text;
}

function normalizeNumber(...values) {
  const picked = firstPresent(...values);
  if (picked == null) return undefined;
  const num = Number(picked);
  return Number.isFinite(num) ? num : undefined;
}

export function isNoPhonePlaceholder(phone) {
  const text = String(phone ?? '').trim().replace(/\s+/g, ' ').toUpperCase();
  return /^PA NUM(?:E|Ë)R \d+$/.test(text);
}

function buildNoPhonePlaceholderPhone(code) {
  const picked = normalizeCode(code);
  const codeText = picked != null ? String(picked).trim() : String(code ?? '').replace(/\D+/g, '').trim();
  return codeText ? `PA NUMER ${codeText}` : '';
}

function normalizePhoneLoose(value) {
  if (isNoPhonePlaceholder(value)) return '';
  const digits = String(value ?? '').replace(/\D+/g, '');
  if (!digits) return '';
  return digits.startsWith('383') ? digits.slice(3) : digits;
}

function normalizeNameLoose(value) {
  return String(value ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function cloneOrderData(clean = {}, row = {}) {
  const fromClean = clean?.data && typeof clean.data === 'object' ? clean.data : null;
  const fromRow = row?.data && typeof row.data === 'object' ? row.data : null;
  return { ...(fromRow || {}), ...(fromClean || {}) };
}

function getOrderClientId(row = {}) {
  const data = row?.data && typeof row.data === 'object' ? row.data : {};
  const client = data?.client && typeof data.client === 'object' ? data.client : {};
  return String(
    row?.client_id ||
    row?.client_master_id ||
    data?.client_id ||
    data?.client_master_id ||
    client?.id ||
    ''
  ).trim();
}

function getOrderClientPhone(row = {}) {
  const data = row?.data && typeof row.data === 'object' ? row.data : {};
  const client = data?.client && typeof data.client === 'object' ? data.client : {};
  const nestedOrder = data?.order && typeof data.order === 'object' ? data.order : {};
  return normalizePhoneLoose(
    row?.client_phone ||
    row?.phone ||
    data?.client_phone ||
    data?.phone ||
    nestedOrder?.client_phone ||
    nestedOrder?.phone ||
    client?.phone ||
    ''
  );
}

function getOrderClientName(row = {}) {
  const data = row?.data && typeof row.data === 'object' ? row.data : {};
  const client = data?.client && typeof data.client === 'object' ? data.client : {};
  const nestedOrder = data?.order && typeof data.order === 'object' ? data.order : {};
  return normalizeNameLoose(
    row?.client_name ||
    row?.name ||
    data?.client_name ||
    data?.name ||
    nestedOrder?.client_name ||
    nestedOrder?.name ||
    client?.name ||
    ''
  );
}

function sameClientOwnerLoose(owner = {}, row = {}) {
  const ownerId = String(owner?.id || '').trim();
  const rowId = getOrderClientId(row);
  if (ownerId && rowId && ownerId === rowId) return true;

  const ownerPhone = normalizePhoneLoose(owner?.phone || '');
  const rowPhone = getOrderClientPhone(row);
  if (ownerPhone && rowPhone && ownerPhone === rowPhone) return true;

  const ownerName = normalizeNameLoose(
    owner?.full_name ||
    owner?.name ||
    [owner?.first_name, owner?.last_name].filter(Boolean).join(' ')
  );
  const rowName = getOrderClientName(row);
  if (ownerName && rowName && ownerName === rowName) return true;

  return false;
}

async function fetchClientOwnerByCodeForSync(codeNum) {
  const code = normalizeCode(codeNum);
  if (code == null) return null;

  try {
    const { data, error } = await supabase
      .from('clients')
      .select('id,code,full_name,first_name,last_name,phone')
      .eq('code', code)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!error && data) return data;
  } catch {}

  try {
    const { data, error } = await supabase
      .from('orders')
      .select('client_id,client_name,client_phone,data,updated_at')
      .eq('code', code)
      .order('updated_at', { ascending: false })
      .limit(5);
    if (error) return null;
    const rows = Array.isArray(data) ? data : [];
    for (const row of rows) {
      const nested = row?.data && typeof row.data === 'object' ? row.data : {};
      const nestedClient = nested?.client && typeof nested.client === 'object' ? nested.client : {};
      const ownerId = String(row?.client_id || nested?.client_master_id || nestedClient?.id || '').trim();
      const ownerName = String(row?.client_name || nested?.client_name || nestedClient?.name || '').trim();
      const ownerPhone = String(row?.client_phone || nested?.client_phone || nestedClient?.phone || '').trim();
      if (!ownerId && !ownerName && !ownerPhone) continue;
      return {
        id: ownerId || null,
        code,
        full_name: ownerName || null,
        phone: ownerPhone || null,
      };
    }
  } catch {}

  return null;
}

function applyCanonicalOwnerToClean(clean = {}, row = {}, owner = {}) {
  const next = { ...(clean || {}) };
  const data = cloneOrderData(next, row);
  const existingClient = data?.client && typeof data.client === 'object' ? data.client : {};
  const ownerId = String(owner?.id || '').trim();
  const ownerName = String(
    owner?.full_name ||
    owner?.name ||
    [owner?.first_name, owner?.last_name].filter(Boolean).join(' ')
  ).trim();
  const ownerPhoneRaw = String(owner?.phone || '').trim();
  const ownerPhone = isNoPhonePlaceholder(ownerPhoneRaw) ? '' : ownerPhoneRaw;
  const ownerNoPhonePlaceholder = isNoPhonePlaceholder(ownerPhoneRaw) ? ownerPhoneRaw : '';
  const code = normalizeCode(next?.code, row?.code, data?.code, existingClient?.code);

  if (ownerId) {
    next.client_id = ownerId;
    data.client_id = ownerId;
    data.client_master_id = ownerId;
  }
  if (ownerName) {
    next.client_name = ownerName;
    data.client_name = ownerName;
  }
  if (ownerPhone) {
    next.client_phone = ownerPhone;
    data.client_phone = ownerPhone;
  } else if (ownerNoPhonePlaceholder || data?.no_phone) {
    next.client_phone = '';
    data.client_phone = '';
    data.no_phone = true;
    data.client_master_phone = ownerNoPhonePlaceholder || data.client_master_phone || buildNoPhonePlaceholderPhone(code);
  }
  if (code !== undefined) {
    next.code = code;
    data.code = code;
    data.client_code = code;
  }

  data.client = {
    ...existingClient,
    ...(ownerId ? { id: ownerId } : {}),
    ...(ownerName ? { name: ownerName } : {}),
    ...(ownerPhone ? { phone: ownerPhone } : { phone: '' }),
    ...(code !== undefined ? { code } : {}),
  };

  next.data = data;
  return next;
}

function normalizeNoPhoneOrderPayload(clean = {}, row = {}) {
  const next = { ...(clean || {}) };
  const data = cloneOrderData(next, row);
  const client = data?.client && typeof data.client === 'object' ? { ...data.client } : {};
  const code = normalizeCode(next?.code, row?.code, data?.code, client?.code);
  const placeholder = [
    data?.client_master_phone,
    client?.client_master_phone,
    client?.phone,
    data?.client_phone,
    next?.client_phone,
    row?.client_phone,
  ].find((v) => isNoPhonePlaceholder(v));
  if (data?.no_phone || placeholder) {
    const masterPhone = String(placeholder || buildNoPhonePlaceholderPhone(code) || '').trim();
    next.client_phone = '';
    data.client_phone = '';
    data.phone = '';
    data.no_phone = true;
    data.client_master_phone = masterPhone || data.client_master_phone || null;
    data.client = {
      ...client,
      phone: '',
      ...(masterPhone ? { client_master_phone: masterPhone } : {}),
      ...(code !== undefined ? { code } : {}),
    };
    next.data = data;
  }
  return next;
}

async function ensureNoPhonePlaceholderClientForSync(row = {}, clean = {}) {
  const data = cloneOrderData(clean, row);
  const client = data?.client && typeof data.client === 'object' ? data.client : {};
  if (!data?.no_phone && !isNoPhonePlaceholder(data?.client_master_phone) && !isNoPhonePlaceholder(client?.client_master_phone)) return null;
  const code = normalizeCode(clean?.code, row?.code, data?.code, client?.code);
  if (code == null) return null;
  const placeholder = String(
    [data?.client_master_phone, client?.client_master_phone, buildNoPhonePlaceholderPhone(code)].find((v) => isNoPhonePlaceholder(v)) || ''
  ).trim();
  if (!placeholder) return null;
  const fullName = String(clean?.client_name || row?.client_name || data?.client_name || client?.name || '').trim().replace(/\s+/g, ' ');
  const parts = fullName.split(' ').filter(Boolean);
  const firstName = parts.length > 1 ? parts.slice(0, -1).join(' ') : (fullName || null);
  const lastName = parts.length > 1 ? parts.slice(-1).join(' ') : null;

  const { data: existing, error: existingErr } = await supabase
    .from('clients')
    .select('id, code, full_name, first_name, last_name, phone, photo_url')
    .eq('code', code)
    .limit(1)
    .maybeSingle();
  if (existingErr) throw existingErr;

  if (existing?.id) {
    const existingHasRealPhone = !!normalizePhoneLoose(existing?.phone || '');
    if (existingHasRealPhone && !isNoPhonePlaceholder(existing?.phone || '')) {
      const conflict = new Error('NO_PHONE_CODE_OWNER_REAL_PHONE_CONFLICT');
      conflict.name = 'NO_PHONE_CODE_OWNER_REAL_PHONE_CONFLICT';
      conflict.code = 'NO_PHONE_CODE_OWNER_REAL_PHONE_CONFLICT';
      conflict.details = {
        code,
        existing_client_id: existing.id || null,
        existing_phone: existing?.phone || '',
        existing_name: existing?.full_name || [existing?.first_name, existing?.last_name].filter(Boolean).join(' ') || '',
        requested_placeholder: placeholder,
      };
      throw conflict;
    }
    const patch = {
      phone: placeholder,
      full_name: fullName || existing?.full_name || null,
      first_name: firstName || existing?.first_name || null,
      last_name: lastName || existing?.last_name || null,
      updated_at: nowIso(),
    };
    const { data: updated, error: updateErr } = await supabase
      .from('clients')
      .update(patch)
      .eq('id', existing.id)
      .select('id, code, full_name, first_name, last_name, phone, photo_url')
      .maybeSingle();
    if (updateErr) throw updateErr;
    return updated || { ...existing, ...patch };
  }

  const insertRow = {
    code,
    full_name: fullName || null,
    first_name: firstName || fullName || null,
    last_name: lastName || null,
    phone: placeholder,
    updated_at: nowIso(),
  };
  const { data: inserted, error: insertErr } = await supabase
    .from('clients')
    .insert(insertRow)
    .select('id, code, full_name, first_name, last_name, phone, photo_url')
    .maybeSingle();
  if (insertErr) {
    const msg = String(insertErr?.message || insertErr?.details || insertErr || '').toLowerCase();
    if (/duplicate|23505|unique/.test(msg)) {
      const { data: retry, error: retryErr } = await supabase
        .from('clients')
        .select('id, code, full_name, first_name, last_name, phone, photo_url')
        .eq('code', code)
        .limit(1)
        .maybeSingle();
      if (retryErr) throw retryErr;
      if (retry?.id) return retry;
    }
    throw insertErr;
  }
  return inserted || insertRow;
}

async function canonicalizeOrderOwnerForInsert(table = 'orders', row = {}, clean = {}, { force = false } = {}) {
  if (table !== 'orders') return { ...(clean || {}) };

  let next = normalizeNoPhoneOrderPayload(clean, row);
  const data = cloneOrderData(next, row);
  const rowClientId = getOrderClientId({ ...(row || {}), ...next, data });
  if (rowClientId && !next.client_id) next.client_id = rowClientId;
  next.data = data;

  const code = normalizeCode(next?.code, row?.code, data?.code, data?.client?.code);
  if (code == null) return next;

  const owner = await fetchClientOwnerByCodeForSync(code);
  if (!owner) return next;

  const sameOwner = sameClientOwnerLoose(owner, { ...(row || {}), ...next, data: next.data });
  if (!force && !sameOwner) return next;

  return applyCanonicalOwnerToClean(next, row, owner);
}

function isLikelyCodeOwnerConflict(error) {
  const text = getErrorText(error).toLowerCase();
  return (
    (text.includes('kodi') && text.includes('lidhur me klient')) ||
    text.includes('klient tjetër') ||
    text.includes('duplicate key') ||
    text.includes('23505')
  );
}

function promoteBaseOrderColumns(clean = {}, row = {}) {
  const data = clean?.data && typeof clean.data === 'object'
    ? clean.data
    : (row?.data && typeof row.data === 'object' ? row.data : {});
  const nestedOrder = data?.order && typeof data.order === 'object' ? data.order : {};
  const client = data?.client && typeof data.client === 'object' ? data.client : {};

  const code = normalizeCode(
    clean?.code,
    row?.code,
    data?.code,
    nestedOrder?.code,
    client?.code,
  );
  if (code !== undefined) clean.code = code;

  const status = firstPresent(
    clean?.status,
    row?.status,
    data?.status,
    nestedOrder?.status,
  );
  if (status !== undefined) {
    clean.status = status;
    data.status = status;
    clean.data = data;
  }

  const clientName = firstPresent(
    clean?.client_name,
    row?.client_name,
    data?.client_name,
    nestedOrder?.client_name,
    client?.name,
    data?.name,
    row?.name,
  );
  if (clientName !== undefined) clean.client_name = clientName;

  const clientPhone = firstPresent(
    clean?.client_phone,
    row?.client_phone,
    data?.client_phone,
    nestedOrder?.client_phone,
    client?.phone,
    data?.phone,
    row?.phone,
  );
  if (isNoPhonePlaceholder(clientPhone) || data?.no_phone) {
    clean.client_phone = '';
    data.client_phone = '';
    data.no_phone = true;
    data.client_master_phone = String(data?.client_master_phone || client?.client_master_phone || clientPhone || buildNoPhonePlaceholderPhone(code) || '').trim() || null;
    data.client = { ...client, phone: '', ...(data.client_master_phone ? { client_master_phone: data.client_master_phone } : {}) };
    clean.data = data;
  } else if (clientPhone !== undefined) clean.client_phone = clientPhone;

  const priceTotal = normalizeNumber(
    clean?.price_total,
    row?.price_total,
    data?.price_total,
    nestedOrder?.price_total,
    data?.total,
    nestedOrder?.total,
    data?.pay?.euro,
    nestedOrder?.pay?.euro,
  );
  if (priceTotal !== undefined) clean.price_total = priceTotal;

  return clean;
}

function describeInsertOp(op = {}) {
  const payload = getPayload(op);
  const row = payload?.insertRow || payload || {};
  const table = String(row?.table || payload?.table || 'orders');
  let clean = stripNonSchemaCols({ ...(row || {}) }, table);
  if (table === 'orders') {
    promoteBaseOrderColumns(clean, row);
    clean = normalizeBaseInsertPayload(clean);
  }
  const localId = String(payload?.localId || clean?.local_oid || row?.local_oid || row?.id || op?.id || '');
  return { payload, row, table, clean, localId };
}



function buildDbVerifyFailedError(details = {}) {
  const e = new Error('DB_VERIFY_FAILED');
  e.code = 'DB_VERIFY_FAILED';
  e.details = details;
  e.hint = 'Supabase upsert returned, but the order could not be verified by local_oid/save_attempt_id/server_id. Preserving outbox op.';
  return e;
}

async function verifyInsertedBaseOrderInDb(table = 'orders', row = {}, clean = {}, localId = '', serverRow = null) {
  if (table !== 'orders') return { ok: true, row: serverRow || null, via: 'non_base_table' };

  const selectCols = 'id,local_oid,code,status,client_name,client_phone,price_total,m2_total,pieces,paid_cash,is_paid_upfront,updated_at,data';
  const saveAttemptId = String(
    clean?.data?.pranimi_code_lifecycle?.save_attempt_id ||
    row?.data?.pranimi_code_lifecycle?.save_attempt_id ||
    clean?.data?.save_attempt_id ||
    row?.data?.save_attempt_id ||
    clean?.save_attempt_id ||
    row?.save_attempt_id ||
    ''
  ).trim();
  const localOid = String(clean?.local_oid || row?.local_oid || localId || '').trim();
  const serverId = String(serverRow?.id || '').trim();

  async function queryOne(via, apply) {
    try {
      let query = supabase.from(table).select(selectCols);
      query = apply(query);
      const { data, error } = await query.maybeSingle();
      if (!error && data) return { ok: true, row: data, via };
    } catch {}
    return null;
  }

  if (localOid) {
    const found = await queryOne('local_oid', (q) => q.eq('local_oid', localOid));
    if (found) return found;
  }

  if (saveAttemptId) {
    const found = await queryOne('save_attempt_id', (q) => q.filter('data->pranimi_code_lifecycle->>save_attempt_id', 'eq', saveAttemptId));
    if (found) return found;
  }

  // Supporting fallback only after the real sync-safety identifiers fail.
  if (serverId && /^\d+$/.test(serverId)) {
    const found = await queryOne('server_id', (q) => q.eq('id', Number(serverId)));
    if (found) return found;
  }

  return {
    ok: false,
    row: null,
    via: '',
    local_oid: localOid,
    save_attempt_id: saveAttemptId,
    server_id: serverId,
  };
}

function getBaseSaveAttemptId(row = {}, clean = {}) {
  return String(
    clean?.data?.pranimi_code_lifecycle?.save_attempt_id ||
    row?.data?.pranimi_code_lifecycle?.save_attempt_id ||
    clean?.data?.save_attempt_id ||
    row?.data?.save_attempt_id ||
    clean?.save_attempt_id ||
    row?.save_attempt_id ||
    ''
  ).trim();
}

function buildDbVerifiedBaseData({ row = {}, clean = {}, remoteRow = {}, verified = {}, op = {} } = {}) {
  const remoteData = (remoteRow?.data && typeof remoteRow.data === 'object') ? remoteRow.data : {};
  const rowData = (row?.data && typeof row.data === 'object') ? row.data : {};
  const cleanData = (clean?.data && typeof clean.data === 'object') ? clean.data : {};
  const at = nowIso();
  const serverId = String(remoteRow?.id || verified?.row?.id || clean?.id || row?.id || '');
  const localOid = String(remoteRow?.local_oid || clean?.local_oid || row?.local_oid || rowData?.local_oid || cleanData?.local_oid || op?.id || '');
  const saveAttemptId = getBaseSaveAttemptId(row, clean);
  const truthStatus = getDbTruthStatus(remoteRow) || String(clean?.status || row?.status || remoteData?.status || rowData?.status || cleanData?.status || '').trim();
  const mergedData = {
    ...remoteData,
    ...rowData,
    ...cleanData,
    local_oid: localOid || cleanData?.local_oid || rowData?.local_oid || remoteData?.local_oid || '',
    sync_error: null,
    db_verified_at: at,
  };
  const nextData = isPranimiFinalOrderStatus(truthStatus)
    ? buildPranimiFinalOrderData(mergedData, {
        status: truthStatus,
        localOid,
        saveAttemptId,
        verifyState: 'DB_VERIFIED',
        source: 'DB_FINAL',
        draftSource: 'FINAL / SYNC VERIFIED',
        serverId,
        updatedAt: at,
      })
    : { ...mergedData, status: truthStatus || mergedData?.status || '', local_sync_status: 'DB_VERIFIED' };
  nextData.pranimi_code_lifecycle = {
    ...(((nextData?.pranimi_code_lifecycle && typeof nextData.pranimi_code_lifecycle === 'object') ? nextData.pranimi_code_lifecycle : {})),
    local_oid: localOid || '',
    save_attempt_id: saveAttemptId || cleanData?.pranimi_code_lifecycle?.save_attempt_id || rowData?.pranimi_code_lifecycle?.save_attempt_id || '',
    outbox_op_id: String(cleanData?.pranimi_code_lifecycle?.outbox_op_id || rowData?.pranimi_code_lifecycle?.outbox_op_id || op?.op_id || ''),
    op_id: String(cleanData?.pranimi_code_lifecycle?.op_id || rowData?.pranimi_code_lifecycle?.op_id || op?.op_id || ''),
    db_verify_state: 'DB_VERIFIED',
    db_verify_via: String(verified?.via || ''),
    db_verified_at: at,
    server_id: serverId,
  };
  return nextData;
}

function buildDbVerifyStateUpdateError(error) {
  const e = new Error('DB_VERIFY_STATE_UPDATE_FAILED');
  e.code = 'DB_VERIFY_STATE_UPDATE_FAILED';
  e.details = error?.details || error?.message || String(error || '');
  e.hint = 'Order exists in DB, but data.pranimi_code_lifecycle.db_verify_state could not be updated to DB_VERIFIED. Preserving outbox op for retry.';
  return e;
}

async function markRemoteBaseOrderDbVerified(table = 'orders', remoteRow = {}, row = {}, clean = {}, verified = {}, op = {}) {
  if (table !== 'orders') return remoteRow;
  const serverId = String(remoteRow?.id || verified?.row?.id || '').trim();
  if (!serverId || !/^\d+$/.test(serverId)) return remoteRow;
  const nextData = buildDbVerifiedBaseData({ row, clean, remoteRow, verified, op });
  const { data, error } = await supabase
    .from(table)
    .update({ data: nextData })
    .eq('id', Number(serverId))
    .select('id,local_oid,code,status,client_name,client_phone,price_total,m2_total,pieces,paid_cash,is_paid_upfront,updated_at,data')
    .maybeSingle();
  if (error) throw buildDbVerifyStateUpdateError(error);
  return data || { ...remoteRow, data: nextData };
}

async function findExistingRemoteOrder(table = 'orders', row = {}, clean = {}, localId = '') {
  if (table !== 'orders') return null;
  const candidates = [];
  const localOid = String(clean?.local_oid || row?.local_oid || localId || '').trim();
  if (localOid) candidates.push({ kind: 'field', field: 'local_oid', value: localOid });

  const saveAttemptId = String(
    clean?.data?.pranimi_code_lifecycle?.save_attempt_id ||
    row?.data?.pranimi_code_lifecycle?.save_attempt_id ||
    clean?.data?.save_attempt_id ||
    row?.data?.save_attempt_id ||
    clean?.save_attempt_id ||
    row?.save_attempt_id ||
    ''
  ).trim();
  if (saveAttemptId) candidates.push({ kind: 'json', field: 'data->pranimi_code_lifecycle->>save_attempt_id', value: saveAttemptId });

  // Existing remote lookup for base inserts is intentionally limited to sync-safety IDs.
  // Do not resolve/delete an outbox op by code/name/phone or stale numeric id alone.

  const selectCols = 'id,local_oid,code,status,client_name,client_phone,price_total,m2_total,pieces,paid_cash,is_paid_upfront,updated_at,data';
  for (const candidate of candidates) {
    try {
      let query = supabase.from(table).select(selectCols);
      if (candidate.kind === 'json') query = query.filter(candidate.field, 'eq', candidate.value);
      else query = query.eq(candidate.field, candidate.value);
      const { data, error } = await query.maybeSingle();
      if (error) continue;
      if (data) return data;
    } catch {}
  }
  return null;
}

async function markInsertMirrorState(op = {}, extra = {}) {
  try {
    const type = String(op?.type || op?.op || '').trim();
    if (type !== 'insert_order') return;
    const { row, clean, table, localId } = describeInsertOp(op);
    if (!localId) return;
    await saveOrderLocal({
      ...row,
      ...clean,
      id: localId,
      local_oid: clean?.local_oid || row?.local_oid || localId,
      table,
      status: clean?.status || row?.status || '',
      data: row?.data || clean?.data || row,
      updated_at: nowIso(),
      _local: true,
      _synced: false,
      _syncPending: true,
      _syncing: false,
      _syncFailed: false,
      ...extra,
    });
  } catch {}
}

async function processOp(op) {
  const type = String(op?.type || op?.op || '').trim();
  const payload = getPayload(op);
  const data = op?.data && typeof op.data === 'object' ? op.data : {};

  if (type === 'insert_order') {
    const { row, table, localId } = describeInsertOp(op);
    let clean = stripNonSchemaCols({ ...(row || {}) }, table);
    if (table === 'orders') {
      clean = normalizeNoPhoneOrderPayload(clean, row);
      promoteBaseOrderColumns(clean, row);
      if (isPranimiFinalOrderStatus(clean?.status || clean?.data?.status)) {
        clean = normalizePranimiFinalOrderRow(clean, {
          status: clean?.status || clean?.data?.status,
          localOid: clean?.local_oid || row?.local_oid || localId || '',
          saveAttemptId: clean?.data?.pranimi_code_lifecycle?.save_attempt_id || row?.data?.pranimi_code_lifecycle?.save_attempt_id || '',
          verifyState: 'DB_VERIFIED',
          source: 'DB_FINAL',
          draftSource: clean?.data?.pranimi_draft_source || 'FINAL / OUTBOX SYNC',
        });
      }
      const noPhoneOwner = await ensureNoPhonePlaceholderClientForSync(row, clean);
      clean = await canonicalizeOrderOwnerForInsert(table, row, clean);
      if (noPhoneOwner?.id) {
        clean = applyCanonicalOwnerToClean(clean, row, noPhoneOwner);
        clean = normalizeNoPhoneOrderPayload(clean, row);
      }
    }

    if (table === 'orders' && localId && !clean.local_oid) {
      clean.local_oid = localId;
    }

    if (localId) {
      await markInsertMirrorState(op, {
        _syncing: true,
        _syncFailed: false,
        _syncError: null,
      });
    }

    const existingRemote = await findExistingRemoteOrder(table, row, clean, localId);
    if (existingRemote) {
      const existingId = String(existingRemote?.id || localId || '');
      const verifiedExistingRemote = await markRemoteBaseOrderDbVerified(
        table,
        existingRemote,
        row,
        clean,
        { ok: true, row: existingRemote, via: 'existing_remote' },
        op
      );
      await saveOrderLocal({
        ...row,
        ...clean,
        ...verifiedExistingRemote,
        id: existingId || localId,
        local_oid: verifiedExistingRemote?.local_oid || clean?.local_oid || row?.local_oid || localId || existingId,
        table,
        data: verifiedExistingRemote?.data || buildDbVerifiedBaseData({ row, clean, remoteRow: verifiedExistingRemote, verified: { ok: true, row: verifiedExistingRemote, via: 'existing_remote' }, op }),
        _local: false,
        _synced: true,
        _syncPending: false,
        _syncing: false,
        _syncFailed: false,
        _syncError: null,
        server_id: existingId || null,
        updated_at: nowIso(),
      });
      if (localId && existingId && localId !== existingId) {
        await deleteOrderLocal(localId);
      }
      return true;
    }

    let serverRow;
    try {
      serverRow = await upsertOrdersRow(table, clean, table === 'transport_orders' ? 'id' : 'local_oid');
    } catch (error) {
      if (table === 'orders' && isLikelyCodeOwnerConflict(error)) {
        const healedClean = await canonicalizeOrderOwnerForInsert(table, row, clean, { force: true });
        serverRow = await upsertOrdersRow(table, healedClean, 'local_oid');
        clean = healedClean;
        syncDebugLog('sync_insert_code_owner_healed', {
          id: String(localId || row?.local_oid || row?.id || ''),
          code: normalizeCode(healedClean?.code || row?.code || ''),
          client_id: String(healedClean?.client_id || healedClean?.data?.client_master_id || healedClean?.data?.client?.id || ''),
        });
      } else {
        throw error;
      }
    }
    const serverId = String(serverRow?.id || clean?.id || localId || '');

    const verified = await verifyInsertedBaseOrderInDb(table, row, clean, localId, serverRow);
    if (table === 'orders' && !verified?.ok) {
      syncDebugLog('db_verify_failed', {
        op_id: String(op?.op_id || ''),
        local_oid: String(verified?.local_oid || clean?.local_oid || row?.local_oid || localId || ''),
        save_attempt_id: String(verified?.save_attempt_id || ''),
        server_id: String(verified?.server_id || serverId || ''),
        reason: 'processOp_post_upsert_verify_failed',
      });
      try {
        const nextData = {
          ...((row?.data && typeof row.data === 'object') ? row.data : {}),
          ...((clean?.data && typeof clean.data === 'object') ? clean.data : {}),
          local_sync_status: 'LOCAL / NOT SYNCED',
          sync_error: 'DB_VERIFY_FAILED',
          pranimi_code_lifecycle: {
            ...(((row?.data?.pranimi_code_lifecycle && typeof row.data.pranimi_code_lifecycle === 'object') ? row.data.pranimi_code_lifecycle : {})),
            ...(((clean?.data?.pranimi_code_lifecycle && typeof clean.data.pranimi_code_lifecycle === 'object') ? clean.data.pranimi_code_lifecycle : {})),
            db_verify_state: 'DB_VERIFY_FAILED',
            db_verify_failed_at: nowIso(),
          },
        };
        const failedStatus = String(clean?.status || row?.status || nextData?.status || '').trim();
        if (failedStatus) nextData.status = failedStatus;
        await saveOrderLocal({
          ...row,
          ...clean,
          id: localId || clean?.local_oid || row?.local_oid || serverId,
          local_oid: clean?.local_oid || row?.local_oid || localId || '',
          table,
          data: nextData,
          _local: true,
          _synced: false,
          _syncPending: true,
          _syncing: false,
          _syncFailed: true,
          _syncError: 'DB_VERIFY_FAILED',
          server_id: serverId || null,
          updated_at: nowIso(),
        });
      } catch {}
      throw buildDbVerifyFailedError(verified);
    }

    let verifiedRow = (table === 'orders' && verified?.row) ? verified.row : serverRow;
    if (table === 'orders') {
      verifiedRow = await markRemoteBaseOrderDbVerified(table, verifiedRow, row, clean, verified, op);
    }
    const verifiedId = String(verifiedRow?.id || serverId || clean?.id || localId || '');

    if (table === 'orders' && verifiedId) {
      await ensureArkaPaymentBeforePaidCashOrderPatch(table, verifiedId, {
        ...clean,
        status: clean?.status || verifiedRow?.status || row?.status,
        data: {
          ...((row?.data && typeof row.data === 'object') ? row.data : {}),
          ...((clean?.data && typeof clean.data === 'object') ? clean.data : {}),
          ...((verifiedRow?.data && typeof verifiedRow.data === 'object') ? verifiedRow.data : {}),
        },
      });
    }

    syncDebugLog('db_verify_success', {
      op_id: String(op?.op_id || ''),
      local_oid: String(verifiedRow?.local_oid || clean?.local_oid || row?.local_oid || localId || ''),
      save_attempt_id: String(clean?.data?.pranimi_code_lifecycle?.save_attempt_id || row?.data?.pranimi_code_lifecycle?.save_attempt_id || clean?.data?.save_attempt_id || row?.data?.save_attempt_id || ''),
      server_id: verifiedId,
      via: String(verified?.via || 'upsert_return'),
      source: 'processOp_post_upsert_verify',
    });

    await saveOrderLocal({
      ...row,
      ...clean,
      ...verifiedRow,
      data: verifiedRow?.data || buildDbVerifiedBaseData({ row, clean, remoteRow: verifiedRow, verified, op }),
      id: verifiedId || localId,
      local_oid: verifiedRow?.local_oid || clean?.local_oid || row?.local_oid || localId || verifiedId,
      table,
      _local: false,
      _synced: true,
      _syncPending: false,
      _syncing: false,
      _syncFailed: false,
      _syncError: null,
      server_id: verifiedId || null,
      updated_at: nowIso(),
    });

    if (localId && verifiedId && localId !== verifiedId) {
      await deleteOrderLocal(localId);
    }
    return true;
  }

  if (type === 'set_status') {
    const table = String(payload?.table || data?.table || 'orders');
    const nextStatus = payload?.status || op?.data?.status || data?.status;
    const id = String(op?.id || payload?.id || payload?.local_oid || data?.id || data?.local_oid || '');
    const statusPatch = {
      ...(payload?.data || {}),
      status: nextStatus,
    };
    await ensureArkaPaymentBeforePaidCashOrderPatch(table, id, statusPatch);
    await updateByIdOrLocalOid(
      table,
      id,
      statusPatch
    );
    return true;
  }

  if (type === 'patch_order_data' || type === 'update') {
    const table = String(payload?.table || data?.table || 'orders');
    const id = String(
      payload?.id ||
      payload?.order_id ||
      payload?.local_oid ||
      data?.id ||
      data?.local_oid ||
      op?.id ||
      ''
    );

    const rawPatch =
      payload?.data && typeof payload.data === 'object'
        ? payload.data
        : (Object.keys(payload).length ? payload : data);

    await ensureArkaPaymentBeforePaidCashOrderPatch(table, id, rawPatch);

    const patch = stripNonSchemaCols({ ...(rawPatch || {}) }, table);
    if ('data_patch' in patch) delete patch.data_patch;

    await updateByIdOrLocalOid(table, id, patch);
    return true;
  }

  if (type === 'arka_transaction') {
    const tx = payload?.transaction && typeof payload.transaction === 'object' ? payload.transaction : payload;
    await postArkaTransaction({
      ...(tx || {}),
      _offline_flush: true,
      _outbox_op_id: String(op?.op_id || ''),
    }, { timeoutMs: Math.min(ARKA_SYNC_HTTP_TIMEOUT_MS, SYNC_OP_TIMEOUT_MS - 1000) });
    return true;
  }

  if (type === 'upload_storage') {
    const bucket = payload?.bucket;
    const path = payload?.path;
    const dataValue = payload?.data;
    if (bucket && path && dataValue != null) {
      const body = new Blob([String(dataValue)], { type: payload?.contentType || 'application/json' });
      const { error } = await storageWithTimeout(supabase.storage.from(bucket).upload(path, body, { upsert: true }), STORAGE_UPLOAD_TIMEOUT_MS, 'SYNC_STORAGE_UPLOAD_TIMEOUT', { bucket, path, op: 'upload_storage' });
      if (error) throw error;
    }
    return true;
  }

  return true;
}

function finishScheduledPromise(result) {
  try {
    if (typeof scheduledResolve === 'function') scheduledResolve(result);
  } catch {}
  scheduledResolve = null;
  scheduledPromise = null;
}

export function scheduleRunSync(opts = {}) {
  const delayMs = Number.isFinite(Number(opts?.delayMs)) ? Math.max(0, Number(opts.delayMs)) : AUTO_DEBOUNCE_MS;
  if (scheduledTimer) {
    clearTimeout(scheduledTimer);
    scheduledTimer = null;
  }
  lastScheduledOpts = { ...(lastScheduledOpts || {}), ...(opts || {}) };
  if (!scheduledPromise) {
    scheduledPromise = new Promise((resolve) => {
      scheduledResolve = resolve;
    });
  }
  scheduledTimer = setTimeout(async () => {
    scheduledTimer = null;
    const pendingOpts = { ...(lastScheduledOpts || {}), scheduled: true };
    lastScheduledOpts = null;
    try {
      const result = await runSync(pendingOpts);
      finishScheduledPromise(result);
    } catch (error) {
      finishScheduledPromise({ ok: false, error: String(error?.message || error || 'SYNC_FAILED') });
    }
  }, delayMs);
  return scheduledPromise;
}

export async function runSync(_opts = {}) {
  if (running) return running;

  if (!acquireLock()) {
    emitSyncStatus(false, { skipped: 'locked' });
    bumpSyncCounter('lockedRuns', 1);
    const snapshot = await refreshSnapshot();
    syncDebugLog('sync_run_locked', { pending: snapshot.length });
    return { ok: false, locked: true, pending: snapshot.length };
  }

  running = (async () => {
    emitSyncStatus(true, { source: _opts?.source || 'unknown', manual: !!_opts?.manual });

    if (!isOnline()) {
      const snapshot = await refreshSnapshot();
      syncDebugLog('sync_run_skipped_offline', { pending: snapshot.length });
      return { ok: false, offline: true, pending: snapshot.length };
    }

    const ops = sortOps(await getPendingOps()).filter((op) => isBaseScopedOp(op));
    bumpSyncCounter('syncRuns', 1);
    syncDebugLog('sync_run_start', {
      source: String(_opts?.source || 'unknown'),
      manual: !!_opts?.manual,
      pending: ops.length,
      firstIds: ops.slice(0, 3).map((op) => String(op?.op_id || op?.id || '')),
    });
    const runStartedAt = Date.now();
    let done = 0;
    let failed = 0;
    let skipped = 0;
    let networkStop = false;
    let permanentStops = 0;

    for (const op of ops) {
      refreshLock();

      if (Date.now() - runStartedAt > MAX_SYNC_RUN_MS) {
        networkStop = true;
        syncDebugLog('sync_run_max_duration_stop', { maxMs: MAX_SYNC_RUN_MS, done, failed, skipped });
        break;
      }

      if (!shouldRetryYet(op)) {
        skipped += 1;
        continue;
      }

      const invalidReason = validateOpShape(op);
      if (invalidReason) {
        syncDebugLog('op_rejected_invalid_shape', {
          op_id: String(op?.op_id || ''),
          type: String(op?.type || op?.op || ''),
          reason: invalidReason,
          id: String(op?.id || getPayload(op)?.id || getPayload(op)?.local_oid || ''),
          table: String(getPayload(op)?.table || getPayload(op)?.insertRow?.table || ''),
        });
        await discardPermanentOp(op, new Error(invalidReason));
        permanentStops += 1;
        bumpSyncCounter('permanentStops', 1);
        continue;
      }

      try {
        await withSupabaseTimeout(processOp(op), SYNC_OP_TIMEOUT_MS, 'SYNC_OP_TIMEOUT', { opType: String(op?.type || op?.op || ''), opId: String(op?.op_id || op?.id || '') });
        await deleteOp(op.op_id);
        try { clearPendingMutationsFromOp(op); } catch {}
        done += 1;
        bumpSyncCounter('successOps', 1);
        if (String(op?.type || op?.op || '').trim() === 'insert_order') {
          try { clearBaseCreateRecovery(getPayload(op)); } catch {}
        }
      } catch (e) {
        const networkLike = isNetworkLikeError(e) || !isOnline();
        const structural = isStructuralSchemaError(e);

        logger.error('syncEngine.op-error', {
          type: op?.type || op?.op,
          message: e?.message || String(e || ''),
          code: e?.code || '',
          details: e?.details || '',
          hint: e?.hint || '',
          at: nowIso(),
        });

        failed += 1;
        bumpSyncCounter('failedOps', 1);

        if (structural) {
          await markInsertMirrorState(op, {
            _syncing: false,
            _syncPending: false,
            _syncFailed: true,
            _syncError: String(e?.message || e || 'SYNC_FAILED'),
          });
          await discardPermanentOp(op, e);
          permanentStops += 1;
          bumpSyncCounter('permanentStops', 1);
          if (String(op?.type || op?.op || '').trim() === 'insert_order') {
            try { rememberBaseCreateRecovery(getPayload(op), { status: 'failed_permanently', source: 'syncEngine', note: String(e?.message || e || 'SYNC_FAILED'), terminal: true }); } catch {}
          }
          continue;
        }

        if (networkLike) {
          await markInsertMirrorState(op, {
            _syncing: false,
            _syncFailed: false,
            _syncError: String(e?.message || e || 'NETWORK_ERROR'),
          });
          const nextOp = buildRetriedOp(op, e, { networkLike: true });
          await pushOp(nextOp);
          networkStop = true;
          bumpSyncCounter('networkStops', 1);
          emitSyncStatus(true, { networkError: true, retryAt: nextOp.nextRetryAt });
          if (String(op?.type || op?.op || '').trim() === 'insert_order') {
            try { rememberBaseCreateRecovery(getPayload(op), { status: 'network_wait', source: 'syncEngine', note: String(e?.message || e || 'NETWORK_ERROR') }); } catch {}
          }
          break;
        }

        await markInsertMirrorState(op, {
          _syncing: false,
          _syncPending: String(e?.code || '') === 'DB_VERIFY_FAILED',
          _syncFailed: true,
          _syncError: String(e?.code || e?.message || e || 'SYNC_FAILED'),
        });
        await discardPermanentOp(op, e);
        permanentStops += 1;
        bumpSyncCounter('permanentStops', 1);
        if (String(op?.type || op?.op || '').trim() === 'insert_order') {
          try { rememberBaseCreateRecovery(getPayload(op), { status: 'failed_permanently', source: 'syncEngine', note: String(e?.message || e || 'SYNC_FAILED') }); } catch {}
        }
      }
    }

    const snapshot = await refreshSnapshot();

    try {
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new Event('tepiha:sync-done'));
        window.dispatchEvent(new Event('tepiha:outbox-changed'));
      }
    } catch {}

    const result = {
      ok: failed === 0,
      done,
      failed,
      skipped,
      networkStop,
      permanentStops,
      pending: snapshot.length,
    };

    syncDebugLog('sync_run_done', result);
    return result;
  })().finally(() => {
    releaseLock();
    emitSyncStatus(false);
    running = null;
  });

  return running;
}

export function initSyncEngine() {
  if (isInitialized) return;
  isInitialized = true;
}

export async function getSyncSnapshot() {
  return await refreshSnapshot();
}
