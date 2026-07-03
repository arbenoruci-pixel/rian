import {
  ARKA_ACTION,
  ARKA_ACTIVE_PAYMENT_STATUSES,
  ARKA_HANDOFF_STATUS,
  ARKA_PAYMENT_STATUS,
  ARKA_PAYMENT_TYPE,
  ARKA_SOURCE_MODULE,
  normalizeLegacyArkaStatus,
} from './arkaConstants.js';
import {
  asObject,
  cleanText,
  isMissingColumnOrFunctionError,
  isReadyForHandoffStatus,
  money,
  normalizeBaseCode,
  normalizeDbId,
  normalizePin,
  normalizeTransportCode,
  normalizeUuid,
  positiveMoney,
  round2,
} from './arkaGuards.js';

const SUMMARY_ID = 1;
const PENDING_TABLE = 'arka_pending_payments';
const HANDOFF_TABLE = 'cash_handoffs';
const HANDOFF_ITEMS_TABLE = 'cash_handoff_items';
const LEDGER_TABLE = 'company_budget_ledger';
const SUMMARY_TABLE = 'company_budget_summary';

const ARKA_RUNTIME_LOCKS = new Map();

async function withRuntimeLock(lockKey, fn) {
  const key = cleanText(lockKey, 'arka_runtime_lock') || 'arka_runtime_lock';
  const previous = ARKA_RUNTIME_LOCKS.get(key) || Promise.resolve();
  let release = () => {};
  const gate = new Promise((resolve) => { release = resolve; });
  const next = previous.catch(() => null).then(() => gate);
  ARKA_RUNTIME_LOCKS.set(key, next);
  await previous.catch(() => null);
  try {
    return await fn();
  } finally {
    release();
    if (ARKA_RUNTIME_LOCKS.get(key) === next) ARKA_RUNTIME_LOCKS.delete(key);
  }
}

function nowIso() {
  return new Date().toISOString();
}

function isProductionRuntime() {
  try {
    return String(process?.env?.NODE_ENV || '').toLowerCase() === 'production' ||
      String(process?.env?.VERCEL_ENV || '').toLowerCase() === 'production';
  } catch {
    return false;
  }
}

function upper(value) {
  return cleanText(value).toUpperCase();
}

function pick(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim() !== '') return value;
  }
  return null;
}


function stableToken(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9çë_.:-]+/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 140);
}

function idempotentMoneyKey(value) {
  return money(value).toFixed(2);
}

function buildTransportCashIdempotencyKey({ transportOrderId, amount, actorPin } = {}) {
  const transportId = normalizeUuid(transportOrderId);
  const pin = normalizePin(actorPin) || 'NO_PIN';
  if (!transportId) return '';
  return [ARKA_ACTION.TRANSPORT_ORDER_PAYMENT, transportId, idempotentMoneyKey(amount), pin]
    .map((part) => stableToken(part))
    .filter(Boolean)
    .join(':');
}

function buildBaseCashIdempotencyKey({ orderId, amount, actorPin } = {}) {
  const baseId = normalizeDbId(orderId);
  const pin = normalizePin(actorPin) || 'NO_PIN';
  if (!baseId) return '';
  return [ARKA_ACTION.BASE_ORDER_PAYMENT, baseId, idempotentMoneyKey(amount), pin]
    .map((part) => stableToken(part))
    .filter(Boolean)
    .join(':');
}

function buildSalaryPaymentIdempotencyKey({ monthKey, workerPin } = {}) {
  const month = cleanText(monthKey, '').slice(0, 7);
  const pin = normalizePin(workerPin);
  if (!month || !pin) return '';
  return [ARKA_ACTION.PAYROLL_SALARY_PAYMENT, month, pin].map((part) => stableToken(part)).join(':');
}

function buildManualSpendClientActionId(payload = {}, actor = {}, amount = 0, category = '') {
  const explicit = cleanText(pick(payload.clientActionId, payload.client_action_id, payload.manualActionId, payload.manual_action_id), '');
  if (explicit) return explicit;
  const sourceType = cleanText(payload.sourceType || payload.source_type || 'manual', 'manual');
  const description = cleanText(payload.description || payload.note, '');
  return [
    'manual_budget_spend',
    sourceType,
    actor.pin || payload.workerPin || payload.worker_pin || 'no_pin',
    category || 'SHPENZIM',
    round2(amount),
    stableToken(description),
  ].map((x) => stableToken(x)).filter(Boolean).join(':');
}

function actorFromPayload(payload = {}) {
  return {
    pin: normalizePin(pick(payload.actorPin, payload.actor_pin, payload.created_by_pin, payload.createdByPin, payload.actor?.pin, payload.user?.pin)),
    name: cleanText(pick(payload.actorName, payload.actor_name, payload.created_by_name, payload.createdByName, payload.actor?.name, payload.user?.name), ''),
    role: cleanText(pick(payload.actorRole, payload.actor_role, payload.created_by_role, payload.createdByRole, payload.actor?.role, payload.user?.role), ''),
  };
}


const ARKA_ACTOR_REQUIRED_ACTIONS = new Set([
  ARKA_ACTION.BASE_ORDER_PAYMENT,
  ARKA_ACTION.TRANSPORT_ORDER_PAYMENT,
  ARKA_ACTION.EXPENSE_REQUEST,
  ARKA_ACTION.CREATE_MEAL_DISTRIBUTION,
  ARKA_ACTION.COMPANY_BUDGET_SPEND,
  ARKA_ACTION.SUBMIT_HANDOFF,
  ARKA_ACTION.ACCEPT_HANDOFF,
  ARKA_ACTION.REJECT_HANDOFF,
  ARKA_ACTION.VOID_OR_REVERSE_PAYMENT,
  ARKA_ACTION.PAYROLL_SALARY_PAYMENT,
]);

const ARKA_MANAGER_ACTIONS = new Set([
  ARKA_ACTION.ACCEPT_HANDOFF,
  ARKA_ACTION.REJECT_HANDOFF,
  ARKA_ACTION.COMPANY_BUDGET_SPEND,
  ARKA_ACTION.VOID_OR_REVERSE_PAYMENT,
  ARKA_ACTION.PAYROLL_SALARY_PAYMENT,
]);

const ARKA_MANAGER_ROLE_KEYS = new Set([
  'DISPATCH',
  'ADMIN',
  'ADMIN_MASTER',
  'ADMINMASTER',
  'MASTER',
  'MASTER_USER',
  'MASTERUSER',
  'SUPERADMIN',
  'SUPER_ADMIN',
  'OWNER',
  'PRONAR',
]);

function normalizeActorRoleKey(role = '') {
  return upper(role)
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

function isArkaManagerRole(role = '') {
  const key = normalizeActorRoleKey(role);
  if (!key) return false;
  if (ARKA_MANAGER_ROLE_KEYS.has(key)) return true;
  const compact = key.replace(/_/g, '');
  if (ARKA_MANAGER_ROLE_KEYS.has(compact)) return true;
  return compact === 'ADMINISTRATOR';
}

async function assertActorAllowed(sb, payload = {}, action = '') {
  if (!ARKA_ACTOR_REQUIRED_ACTIONS.has(action)) return actorFromPayload(payload);

  const payloadActor = actorFromPayload(payload);
  const actorPin = normalizePin(payloadActor.pin);
  if (!actorPin) throw new Error('ACTOR_PIN_REQUIRED');

  let user = null;
  let actorLookupError = null;
  try {
    const res = await sb
      .from('users')
      .select('id,pin,name,role,is_active')
      .eq('pin', actorPin)
      .maybeSingle();
    user = res?.data || null;
    actorLookupError = res?.error || null;
  } catch (err) {
    actorLookupError = err;
  }

  // Some live deployments have users without is_active. In that schema, retry with
  // the minimum columns instead of failing every ARKA transaction before insert.
  if (actorLookupError && isMissingColumnOrFunctionError(actorLookupError)) {
    const res2 = await sb
      .from('users')
      .select('id,pin,name,role')
      .eq('pin', actorPin)
      .maybeSingle();
    user = res2?.data || null;
    actorLookupError = res2?.error || null;
  }

  if (actorLookupError) throw actorLookupError;
  if (!user?.pin) throw new Error('ACTOR_NOT_FOUND');
  if (Object.prototype.hasOwnProperty.call(user, 'is_active') && user.is_active === false) throw new Error('ACTOR_DISABLED');

  const dbRole = cleanText(user.role, '');
  if (ARKA_MANAGER_ACTIONS.has(action) && !isArkaManagerRole(dbRole)) {
    throw new Error('ACTOR_ROLE_NOT_ALLOWED');
  }

  return {
    id: user.id || null,
    pin: normalizePin(user.pin),
    name: cleanText(user.name, payloadActor.name || actorPin),
    role: dbRole || payloadActor.role || '',
  };
}

function withVerifiedActor(payload = {}, actor = {}) {
  const cleanActor = {
    pin: normalizePin(actor.pin),
    name: cleanText(actor.name, ''),
    role: cleanText(actor.role, ''),
  };
  return {
    ...(payload || {}),
    actorPin: cleanActor.pin,
    actor_pin: cleanActor.pin,
    actorName: cleanActor.name,
    actor_name: cleanActor.name,
    actorRole: cleanActor.role,
    actor_role: cleanActor.role,
    actor: {
      ...asObject(payload?.actor),
      pin: cleanActor.pin,
      name: cleanActor.name,
      role: cleanActor.role,
    },
    user: {
      ...asObject(payload?.user),
      pin: cleanActor.pin,
      name: cleanActor.name,
      role: cleanActor.role,
    },
  };
}

function stripKeys(obj = {}, keys = []) {
  const out = { ...(obj || {}) };
  for (const key of keys) delete out[key];
  return out;
}

function dedupeVariants(variants = []) {
  const out = [];
  const seen = new Set();
  for (const variant of variants) {
    const clean = Object.fromEntries(Object.entries(variant || {}).filter(([, value]) => value !== undefined));
    const key = JSON.stringify(Object.keys(clean).sort().map((k) => [k, clean[k]]));
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
  }
  return out;
}

function isMissingRpcFunctionError(error, functionName = '') {
  const msg = String(error?.message || error?.details || error?.hint || error || '').toLowerCase();
  const fn = String(functionName || '').toLowerCase();
  if (!fn || !msg.includes(fn)) return false;
  return msg.includes('function') && (msg.includes('does not exist') || msg.includes('not found') || msg.includes('could not find'));
}

function pendingInsertVariants(payload = {}) {
  const broadOptional = [
    'idempotency_key',
    'method',
    'created_by_role',
    'actor_pin',
    'actor_name',
    'source',
    'source_ref',
    'cycle_id',
    'applied_cycle_id',
    'client_phone',
    'transport_m2',
    'transport_code_str',
    'transport_order_id',
    'source_module',
    'handoff_note',
    'handed_at',
    'handed_by_pin',
    'handed_by_name',
    'handed_by_role',
    'approved_by_pin',
    'approved_by_name',
    'approved_at',
    'updated_at',
  ];
  return dedupeVariants([
    payload,
    stripKeys(payload, ['method', 'created_by_role', 'source', 'source_ref']),
    stripKeys(payload, ['method', 'created_by_role', 'source', 'source_ref', 'transport_m2']),
    stripKeys(payload, ['idempotency_key']),
    stripKeys(payload, ['idempotency_key', 'method', 'created_by_role', 'source', 'source_ref']),
    stripKeys(payload, ['idempotency_key', 'method', 'created_by_role', 'source', 'source_ref', 'transport_m2']),
    stripKeys(payload, broadOptional),
    {
      amount: payload.amount,
      type: payload.type,
      status: payload.status,
      note: payload.note || null,
      created_by_pin: payload.created_by_pin || null,
      created_by_name: payload.created_by_name || null,
      order_id: payload.order_id || null,
      order_code: payload.order_code || null,
      client_name: payload.client_name || null,
      created_at: payload.created_at || nowIso(),
    },
  ]);
}

function handoffInsertVariants(payload = {}) {
  const optional = [
    'driver_pin',
    'driver_name',
    'total_amount',
    'count_clients',
    'payment_ids',
    'order_ids',
    'client_items',
    'data',
    'idempotency_key',
    'submitted_at',
    'updated_at',
  ];
  return dedupeVariants([
    payload,
    stripKeys(payload, ['idempotency_key']),
    stripKeys(payload, ['idempotency_key', 'data', 'client_items']),
    stripKeys(payload, ['idempotency_key', ...optional]),
    {
      worker_pin: payload.worker_pin,
      worker_name: payload.worker_name,
      amount: payload.amount,
      status: payload.status,
      note: payload.note || null,
    },
  ]);
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
    'updated_at',
  ];
  return dedupeVariants([
    payload,
    stripKeys(payload, ['dispatch_note']),
    stripKeys(payload, ['accepted_by_pin', 'accepted_by_name', 'accepted_at', 'rejected_by_pin', 'rejected_by_name', 'rejected_at']),
    stripKeys(payload, ['driver_pin', 'driver_name', 'count_clients', 'total_amount', 'payment_ids', 'order_ids', 'data', 'client_items']),
    stripKeys(payload, optional),
  ]);
}

function pendingUpdateVariants(payload = {}) {
  const optional = [
    'accepted_at',
    'accepted_by_pin',
    'accepted_by_name',
    'approved_at',
    'approved_by_pin',
    'approved_by_name',
    'submitted_at',
    'handoff_note',
    'handed_at',
    'handed_by_pin',
    'handed_by_name',
    'handed_by_role',
    'updated_at',
  ];
  return dedupeVariants([
    payload,
    stripKeys(payload, ['accepted_at', 'accepted_by_pin', 'accepted_by_name']),
    stripKeys(payload, ['submitted_at', 'handoff_note']),
    stripKeys(payload, ['handed_at', 'handed_by_pin', 'handed_by_name', 'handed_by_role']),
    stripKeys(payload, optional),
  ]);
}

function ledgerInsertVariants(payload = {}) {
  const optional = [
    'source_type',
    'source_id',
    'created_by_pin',
    'created_by_name',
    'approved_by_pin',
    'approved_by_name',
    'worker_pin',
    'worker_name',
  ];
  return dedupeVariants([
    payload,
    stripKeys(payload, ['worker_pin', 'worker_name']),
    stripKeys(payload, ['created_by_name', 'approved_by_name', 'worker_pin', 'worker_name']),
    stripKeys(payload, ['source_id', 'worker_pin', 'worker_name']),
    stripKeys(payload, ['source_type', 'worker_pin', 'worker_name']),
    stripKeys(payload, optional),
    {
      direction: payload.direction,
      amount: payload.amount,
      category: payload.category,
      description: payload.description,
    },
  ]);
}

async function getSupabaseOrThrow(options = {}) {
  if (options?.supabase) return options.supabase;
  const mod = await import('../supabaseAdminClient.js');
  const sb = mod.createAdminClientOrThrow ? mod.createAdminClientOrThrow() : mod.getSupabaseAdmin?.();
  if (!sb) throw new Error('SERVER_NOT_CONFIGURED');
  return sb;
}

async function insertRow(sb, table, payload, variantsFactory = null, { select = '*' } = {}) {
  let lastErr = null;
  const variants = variantsFactory ? variantsFactory(payload) : dedupeVariants([payload]);
  for (const variant of variants) {
    const { data, error } = await sb.from(table).insert(variant).select(select).maybeSingle();
    if (!error) return data || variant;
    lastErr = error;
    if (!isMissingColumnOrFunctionError(error)) throw error;
  }
  throw lastErr || new Error(`INSERT_FAILED:${table}`);
}

async function insertRows(sb, table, rows = []) {
  if (!rows.length) return [];
  const { data, error } = await sb.from(table).insert(rows).select('*');
  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

async function updateById(sb, table, id, patch, variantsFactory = null, { select = '*' } = {}) {
  let lastErr = null;
  const variants = variantsFactory ? variantsFactory(patch) : dedupeVariants([patch]);
  for (const variant of variants) {
    const { data, error } = await sb.from(table).update(variant).eq('id', id).select(select).maybeSingle();
    if (!error) return data || null;
    lastErr = error;
    if (!isMissingColumnOrFunctionError(error)) throw error;
  }
  throw lastErr || new Error(`UPDATE_FAILED:${table}`);
}

async function updatePendingByIds(sb, ids = [], patch = {}) {
  const cleanIds = [...new Set((ids || []).map((id) => normalizeDbId(id)).filter(Boolean))];
  if (!cleanIds.length) return { count: 0 };
  let lastErr = null;
  for (const variant of pendingUpdateVariants(patch)) {
    const { error } = await sb.from(PENDING_TABLE).update(variant).in('id', cleanIds);
    if (!error) return { count: cleanIds.length };
    lastErr = error;
    if (!isMissingColumnOrFunctionError(error)) throw error;
  }
  throw lastErr || new Error('PENDING_UPDATE_FAILED');
}

async function findPaymentIdsInActiveHandoffs(sb, ids = [], statuses = [ARKA_HANDOFF_STATUS.PENDING_DISPATCH_APPROVAL, ARKA_HANDOFF_STATUS.ACCEPTED]) {
  const cleanIds = [...new Set((ids || []).map((id) => normalizeDbId(id)).filter(Boolean))];
  if (!cleanIds.length) return new Set();
  const { data: items, error: itemErr } = await sb
    .from(HANDOFF_ITEMS_TABLE)
    .select('pending_payment_id,handoff_id')
    .in('pending_payment_id', cleanIds);
  if (itemErr) throw itemErr;
  const relationRows = Array.isArray(items) ? items : [];
  const handoffIds = [...new Set(relationRows.map((row) => normalizeDbId(row?.handoff_id)).filter(Boolean))];
  if (!handoffIds.length) return new Set();
  const { data: handoffs, error: handoffErr } = await sb
    .from(HANDOFF_TABLE)
    .select('id,status')
    .in('id', handoffIds)
    .in('status', statuses);
  if (handoffErr) throw handoffErr;
  const activeHandoffIds = new Set((Array.isArray(handoffs) ? handoffs : []).map((row) => String(row.id)));
  return new Set(relationRows
    .filter((row) => activeHandoffIds.has(String(normalizeDbId(row?.handoff_id))))
    .map((row) => normalizeDbId(row?.pending_payment_id))
    .filter(Boolean));
}

async function paymentHasActiveHandoff(sb, paymentId, statuses = [ARKA_HANDOFF_STATUS.PENDING_DISPATCH_APPROVAL, ARKA_HANDOFF_STATUS.ACCEPTED]) {
  const id = normalizeDbId(paymentId);
  if (!id) return false;
  const linked = await findPaymentIdsInActiveHandoffs(sb, [id], statuses);
  return linked.has(id);
}

async function claimPendingPaymentsForHandoff(sb, ids = [], handoffId, patch = {}) {
  const cleanIds = [...new Set((ids || []).map((id) => normalizeDbId(id)).filter(Boolean))];
  const cleanHandoffId = normalizeDbId(handoffId);
  if (!cleanIds.length || !cleanHandoffId) return { count: 0, rows: [] };
  const alreadyLinked = await findPaymentIdsInActiveHandoffs(sb, cleanIds);
  if (alreadyLinked.size) return { count: 0, rows: [] };
  let lastErr = null;
  for (const variant of pendingUpdateVariants(patch)) {
    const { data, error } = await sb
      .from(PENDING_TABLE)
      .update(variant)
      .in('id', cleanIds)
      .in('status', [ARKA_PAYMENT_STATUS.PENDING, ARKA_PAYMENT_STATUS.COLLECTED])
      .select('id,status');
    if (!error) return { count: Array.isArray(data) ? data.length : 0, rows: Array.isArray(data) ? data : [] };
    lastErr = error;
    if (!isMissingColumnOrFunctionError(error)) throw error;
  }
  throw lastErr || new Error('PENDING_HANDOFF_CLAIM_FAILED');
}

async function restoreClaimedPayments(sb, rows = [], note = '') {
  const byStatus = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const id = normalizeDbId(row?.id);
    if (!id) continue;
    const status = normalizeLegacyArkaStatus(row?.status) === ARKA_PAYMENT_STATUS.COLLECTED
      ? ARKA_PAYMENT_STATUS.COLLECTED
      : ARKA_PAYMENT_STATUS.PENDING;
    const list = byStatus.get(status) || [];
    list.push(id);
    byStatus.set(status, list);
  }
  for (const [status, ids] of byStatus.entries()) {
    await updatePendingByIds(sb, ids, {
      status,
      submitted_at: null,
      handed_at: null,
      handed_by_pin: null,
      handed_by_name: null,
      handed_by_role: null,
      handoff_note: note || 'HANDOFF_CLAIM_RESTORED',
      updated_at: nowIso(),
    });
  }
}

async function fetchOrder(sb, orderId) {
  const id = normalizeDbId(orderId);
  if (!id) throw new Error('ORDER_ID_INVALID');
  const { data, error } = await sb
    .from('orders')
    .select('id,status,data,code,client_name,client_phone,price_total,updated_at,created_at')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  if (!data?.id) throw new Error('ORDER_NOT_FOUND');
  return data;
}

async function fetchTransportOrder(sb, transportOrderId) {
  const id = normalizeUuid(transportOrderId);
  if (!id) throw new Error('TRANSPORT_ORDER_ID_INVALID');
  const { data, error } = await sb
    .from('transport_orders')
    .select('id,status,data,code_str,client_tcode,client_name,client_phone,updated_at,created_at')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  if (!data?.id) throw new Error('TRANSPORT_ORDER_NOT_FOUND');
  return data;
}

function readOrderTotal(row = {}) {
  const data = asObject(row?.data);
  const pay = asObject(data?.pay);
  return money(pick(pay.euro, pay.total, row.price_total, data.total, data.price_total, 0));
}

function readOrderPaid(row = {}) {
  const data = asObject(row?.data);
  const pay = asObject(data?.pay);
  return money(Math.max(
    money(pay.paid),
    money(pay.arkaRecordedPaid),
    money(data.clientPaid),
    money(row.paid_amount),
    money(row.paid_cash)
  ));
}

function normalizeBasePaymentFullStatus(value = '') {
  const status = cleanText(value, '').toLowerCase();
  if (['pastrim', 'gati', 'dorzim'].includes(status)) return status;
  return '';
}

function buildBaseOrderPatch(row = {}, amount, opts = {}) {
  const { duplicate = false } = opts || {};
  const data = asObject(row?.data);
  const pay = asObject(data?.pay);
  const total = readOrderTotal(row);
  const currentPaid = readOrderPaid(row);
  const currentArka = money(pay.arkaRecordedPaid);
  const nextPaid = duplicate ? round2(Math.max(currentPaid, currentArka, amount)) : round2(currentPaid + amount);
  const nextArka = duplicate ? round2(Math.max(currentArka, amount)) : round2(currentArka + amount);
  const debt = round2(Math.max(0, total - Math.max(nextPaid, nextArka)));
  const requestedFullStatus = normalizeBasePaymentFullStatus(
    opts?.statusOnFullPayment ||
    opts?.status_on_full_payment ||
    opts?.fullPaymentStatus ||
    opts?.full_payment_status
  );
  const nextStatus = debt <= 0.01 ? (requestedFullStatus || 'dorzim') : cleanText(row.status || data.status || 'pastrim');
  const nextData = {
    ...data,
    status: nextStatus,
    pay: {
      ...pay,
      euro: total || money(pay.euro),
      paid: nextPaid,
      arkaRecordedPaid: nextArka,
      debt,
      method: pay.method || 'CASH',
    },
    clientPaid: nextPaid,
    paid: nextPaid,
    debt,
    isPaid: debt <= 0.01,
    updated_at: nowIso(),
  };
  const patch = {
    status: nextStatus,
    data: nextData,
    price_total: total || row.price_total || 0,
    updated_at: nextData.updated_at,
  };
  return { patch, data: nextData, debt, nextPaid, nextStatus };
}

function orderUpdateVariants(patch = {}) {
  return dedupeVariants([
    patch,
    stripKeys(patch, ['paid_cash']),
    stripKeys(patch, ['paid_amount', 'paid_cash', 'price_total']),
    { status: patch.status, data: patch.data, updated_at: patch.updated_at },
    { data: patch.data, updated_at: patch.updated_at },
  ]);
}

async function updateOrderAfterPayment(sb, order, amount, opts = {}) {
  const { patch } = buildBaseOrderPatch(order, amount, opts);
  const updated = await updateById(sb, 'orders', order.id, patch, orderUpdateVariants, { select: 'id,status,data,code,client_name,client_phone,price_total,updated_at' });
  return updated || { ...order, ...patch };
}

function buildTransportPatch(row = {}, amount, { duplicate = false } = {}) {
  const data = asObject(row?.data);
  const pay = asObject(data?.pay);
  const total = money(pick(pay.euro, pay.total, data.total, 0));
  const currentPaid = money(Math.max(money(pay.paid), money(pay.arkaRecordedPaid)));
  const currentArka = money(pay.arkaRecordedPaid);
  const nextPaid = duplicate ? round2(Math.max(currentPaid, currentArka, amount)) : round2(currentPaid + amount);
  const nextArka = duplicate ? round2(Math.max(currentArka, amount)) : round2(currentArka + amount);
  const debt = round2(Math.max(0, total - Math.max(nextPaid, nextArka)));
  const paidAt = nowIso();
  const nextData = {
    ...data,
    pay: {
      ...pay,
      paid: nextPaid,
      arkaRecordedPaid: nextArka,
      debt,
      last_paid_at: paidAt,
    },
    updated_at: paidAt,
  };
  if (debt <= 0.01) {
    nextData.paid_done = true;
    nextData.paid_at = nextData.paid_at || paidAt;
  }
  return { data: nextData, updated_at: paidAt };
}

async function updateTransportAfterPayment(sb, row, amount, opts = {}) {
  const patch = buildTransportPatch(row, amount, opts);
  const variants = dedupeVariants([patch, { data: patch.data }]);
  let lastErr = null;
  for (const variant of variants) {
    const { data, error } = await sb.from('transport_orders').update(variant).eq('id', row.id).select('id,status,data,code_str,client_tcode,client_name,client_phone,updated_at').maybeSingle();
    if (!error) return data || { ...row, ...variant };
    lastErr = error;
    if (!isMissingColumnOrFunctionError(error)) throw error;
  }
  throw lastErr || new Error('TRANSPORT_UPDATE_FAILED');
}

async function findDuplicateBasePayment(sb, { orderId, amount }) {
  const id = normalizeDbId(orderId);
  if (!id) return null;
  const amt = money(amount);
  const { data, error } = await sb
    .from(PENDING_TABLE)
    .select('id,status,amount,type,source_module,order_id,order_code,handoff_note,created_at,created_by_pin,idempotency_key')
    .eq('order_id', id)
    .eq('type', ARKA_PAYMENT_TYPE.IN)
    .eq('source_module', ARKA_SOURCE_MODULE.BASE)
    .in('status', ARKA_ACTIVE_PAYMENT_STATUSES)
    .order('created_at', { ascending: false })
    .limit(20);
  if (error) throw error;
  const rows = Array.isArray(data) ? data : [];
  return rows.find((row) => Math.abs(money(row?.amount) - amt) <= 0.005) || null;
}

async function findActivePaymentByIdempotencyKey(sb, idempotencyKey) {
  const key = cleanText(idempotencyKey, '');
  if (!key) return null;
  try {
    const { data, error } = await sb
      .from(PENDING_TABLE)
      .select('*')
      .eq('idempotency_key', key)
      .in('status', ARKA_ACTIVE_PAYMENT_STATUSES)
      .order('created_at', { ascending: false })
      .limit(1);
    if (error) throw error;
    return Array.isArray(data) && data.length ? data[0] : null;
  } catch (error) {
    if (!isMissingColumnOrFunctionError(error)) throw error;
    return null;
  }
}

function paymentWorkerPin(row = {}) {
  return normalizePin(row.created_by_pin || row.handed_by_pin || row.worker_pin || row.driver_pin || row.actor_pin);
}

async function findDuplicateTransportPayment(sb, { transportOrderId, amount, actorPin }) {
  const id = normalizeUuid(transportOrderId);
  if (!id) return null;
  const amt = money(amount);
  const pin = normalizePin(actorPin);
  const { data, error } = await sb
    .from(PENDING_TABLE)
    .select('id,status,amount,type,source_module,transport_order_id,transport_code_str,handoff_note,created_at,created_by_pin,handed_by_pin')
    .eq('transport_order_id', id)
    .in('status', ARKA_ACTIVE_PAYMENT_STATUSES)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) throw error;
  const rows = Array.isArray(data) ? data : [];
  return rows.find((row) => {
    if (Math.abs(money(row?.amount) - amt) > 0.005) return false;
    const rowType = upper(row?.type);
    const rowSource = upper(row?.source_module);
    if (rowType && rowType !== ARKA_PAYMENT_TYPE.TRANSPORT) return false;
    if (rowSource && rowSource !== ARKA_SOURCE_MODULE.TRANSPORT) return false;
    const rowPin = paymentWorkerPin(row);
    return !pin || !rowPin || rowPin === pin;
  }) || null;
}

function isVerifiedTransportPaymentRow(row = {}, { transportOrderId, amount, actorPin, transportCode } = {}) {
  if (!row?.id) return false;
  if (!ARKA_ACTIVE_PAYMENT_STATUSES.includes(normalizeLegacyArkaStatus(row.status))) return false;
  const id = normalizeUuid(transportOrderId);
  if (!id || normalizeUuid(row.transport_order_id || row.transportOrderId) !== id) return false;
  if (Math.abs(money(row.amount) - money(amount)) > 0.005) return false;
  if (upper(row.type) !== ARKA_PAYMENT_TYPE.TRANSPORT) return false;
  if (upper(row.source_module) !== ARKA_SOURCE_MODULE.TRANSPORT) return false;
  const code = normalizeTransportCode(transportCode);
  if (code && normalizeTransportCode(row.transport_code_str || row.transportCodeStr) !== code) return false;
  const pin = normalizePin(actorPin);
  if (pin && normalizePin(row.created_by_pin) !== pin) return false;
  return true;
}

async function readPendingPaymentById(sb, paymentId) {
  const id = cleanText(paymentId, '');
  if (!id) return null;
  const { data, error } = await sb.from(PENDING_TABLE).select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data || null;
}

async function findVerifiedTransportPayment(sb, target = {}) {
  const candidates = [];
  const seen = new Set();
  const addCandidate = (row) => {
    if (!row?.id || seen.has(String(row.id))) return;
    seen.add(String(row.id));
    candidates.push(row);
  };

  if (target.payment?.id) addCandidate(await readPendingPaymentById(sb, target.payment.id));

  const key = cleanText(target.idempotencyKey || target.payment?.idempotency_key, '');
  if (key) {
    try {
      const { data, error } = await sb
        .from(PENDING_TABLE)
        .select('*')
        .eq('idempotency_key', key)
        .in('status', ARKA_ACTIVE_PAYMENT_STATUSES)
        .order('created_at', { ascending: false })
        .limit(10);
      if (error) throw error;
      (Array.isArray(data) ? data : []).forEach(addCandidate);
    } catch (error) {
      if (!isMissingColumnOrFunctionError(error)) throw error;
    }
  }

  const id = normalizeUuid(target.transportOrderId);
  if (id) {
    try {
      const { data, error } = await sb
        .from(PENDING_TABLE)
        .select('*')
        .eq('transport_order_id', id)
        .in('status', ARKA_ACTIVE_PAYMENT_STATUSES)
        .order('created_at', { ascending: false })
        .limit(50);
      if (error) throw error;
      (Array.isArray(data) ? data : []).forEach(addCandidate);
    } catch (error) {
      if (!isMissingColumnOrFunctionError(error)) throw error;
    }
  }

  return candidates.find((row) => isVerifiedTransportPaymentRow(row, target)) || null;
}

async function verifyTransportPaymentOrThrow(sb, target = {}) {
  const verified = await findVerifiedTransportPayment(sb, target);
  if (!verified?.id) throw new Error('TRANSPORT_ARKA_PAYMENT_VERIFY_FAILED');
  return verified;
}

function isVerifiedBasePaymentRow(row = {}, { orderId, amount } = {}) {
  if (!row?.id) return false;
  if (!ARKA_ACTIVE_PAYMENT_STATUSES.includes(normalizeLegacyArkaStatus(row.status))) return false;
  const id = normalizeDbId(orderId);
  if (!id || normalizeDbId(row.order_id || row.orderId) !== id) return false;
  if (Math.abs(money(row.amount) - money(amount)) > 0.005) return false;
  if (upper(row.type) !== ARKA_PAYMENT_TYPE.IN) return false;
  if (upper(row.source_module) !== ARKA_SOURCE_MODULE.BASE) return false;
  return true;
}

async function findVerifiedBasePayment(sb, target = {}) {
  const candidates = [];
  const seen = new Set();
  const addCandidate = (row) => {
    if (!row?.id || seen.has(String(row.id))) return;
    seen.add(String(row.id));
    candidates.push(row);
  };

  if (target.payment?.id) addCandidate(await readPendingPaymentById(sb, target.payment.id));

  const key = cleanText(target.idempotencyKey || target.payment?.idempotency_key, '');
  if (key) {
    try {
      const { data, error } = await sb
        .from(PENDING_TABLE)
        .select('*')
        .eq('idempotency_key', key)
        .in('status', ARKA_ACTIVE_PAYMENT_STATUSES)
        .order('created_at', { ascending: false })
        .limit(10);
      if (error) throw error;
      (Array.isArray(data) ? data : []).forEach(addCandidate);
    } catch (error) {
      if (!isMissingColumnOrFunctionError(error)) throw error;
    }
  }

  const id = normalizeDbId(target.orderId);
  if (id) {
    const { data, error } = await sb
      .from(PENDING_TABLE)
      .select('*')
      .eq('order_id', id)
      .eq('type', ARKA_PAYMENT_TYPE.IN)
      .eq('source_module', ARKA_SOURCE_MODULE.BASE)
      .in('status', ARKA_ACTIVE_PAYMENT_STATUSES)
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) throw error;
    (Array.isArray(data) ? data : []).forEach(addCandidate);
  }

  return candidates.find((row) => isVerifiedBasePaymentRow(row, target)) || null;
}

async function verifyBasePaymentOrThrow(sb, target = {}) {
  const verified = await findVerifiedBasePayment(sb, target);
  if (!verified?.id) throw new Error('BASE_ARKA_PAYMENT_VERIFY_FAILED');
  return verified;
}

function buildBasePaymentRow(payload = {}, order = {}, actor = {}) {
  const data = asObject(order?.data);
  const client = asObject(data?.client);
  const amount = positiveMoney(payload.amount, 'AMOUNT_INVALID');
  const createdAt = nowIso();
  return {
    idempotency_key: cleanText(payload.idempotencyKey || payload.idempotency_key, '') || null,
    status: ARKA_PAYMENT_STATUS.PENDING,
    amount,
    type: ARKA_PAYMENT_TYPE.IN,
    source_module: ARKA_SOURCE_MODULE.BASE,
    order_id: normalizeDbId(payload.orderId || payload.order_id || order.id),
    order_code: normalizeBaseCode(payload.orderCode || payload.order_code || payload.code || order.code || client.code),
    transport_order_id: null,
    transport_code_str: null,
    transport_m2: 0,
    client_name: cleanText(payload.clientName || payload.client_name || order.client_name || client.name, '') || null,
    client_phone: cleanText(payload.clientPhone || payload.client_phone || order.client_phone || client.phone, '') || null,
    method: upper(payload.method || 'CASH') || 'CASH',
    note: cleanText(payload.note, `PAGESA ${amount}€`),
    created_by_pin: actor.pin || null,
    created_by_name: actor.name || null,
    created_by_role: actor.role || null,
    created_at: createdAt,
    updated_at: createdAt,
  };
}

function buildTransportPaymentRow(payload = {}, row = {}, actor = {}) {
  const data = asObject(row?.data);
  const client = asObject(data?.client);
  const pay = asObject(data?.pay);
  const amount = positiveMoney(payload.amount, 'AMOUNT_INVALID');
  const transportCode = normalizeTransportCode(payload.transportCode || payload.transport_code_str || payload.order_code || row.code_str || row.client_tcode || client.tcode);
  const createdAt = nowIso();
  return {
    idempotency_key: cleanText(payload.idempotencyKey || payload.idempotency_key, '') || buildTransportCashIdempotencyKey({
      transportOrderId: payload.transportOrderId || payload.transport_order_id || payload.orderId || payload.order_id || row.id,
      amount,
      actorPin: actor.pin,
    }) || null,
    status: ARKA_PAYMENT_STATUS.COLLECTED,
    amount,
    type: ARKA_PAYMENT_TYPE.TRANSPORT,
    source_module: ARKA_SOURCE_MODULE.TRANSPORT,
    order_id: null,
    order_code: null,
    transport_order_id: normalizeUuid(payload.transportOrderId || payload.transport_order_id || payload.orderId || payload.order_id || row.id),
    transport_code_str: transportCode,
    transport_m2: money(pick(payload.transportM2, payload.transport_m2, pay.m2, data.m2_total, data.totals?.m2, 0)),
    client_name: cleanText(payload.clientName || payload.client_name || row.client_name || client.name, '') || null,
    client_phone: cleanText(payload.clientPhone || payload.client_phone || row.client_phone || client.phone, '') || null,
    method: upper(payload.method || 'CASH') || 'CASH',
    note: cleanText(payload.note, `TRANSPORT PAGESË ${amount}€`),
    created_by_pin: actor.pin || null,
    created_by_name: actor.name || null,
    created_by_role: actor.role || null,

    // Transport COLLECTED cash is physically in the worker/driver's hand.
    // The DB atomic handoff RPC uses handed_by_pin as the cash holder owner.
    // Without this, rows are created as COLLECTED but the worker cannot submit them.
    handed_by_pin: actor.pin || null,
    handed_by_name: actor.name || null,
    handed_by_role: actor.role || null,

    created_at: createdAt,
    updated_at: createdAt,
  };
}

async function baseOrderPayment(sb, payload = {}) {
  const actor = actorFromPayload(payload);
  const orderId = normalizeDbId(payload.orderId || payload.order_id);
  const amount = positiveMoney(payload.amount, 'AMOUNT_INVALID');
  if (!orderId) throw new Error('ORDER_ID_INVALID');
  if (!actor.pin) throw new Error('ACTOR_PIN_REQUIRED');

  const deterministicKey = buildBaseCashIdempotencyKey({ orderId, amount, actorPin: actor.pin });
  const idempotencyKey = cleanText(payload.idempotencyKey || payload.idempotency_key || deterministicKey, '');
  const guardedPayload = { ...payload, idempotencyKey, idempotency_key: idempotencyKey };
  const lockKey = `base_cash:${orderId}:${idempotentMoneyKey(amount)}:${actor.pin}`;

  return withRuntimeLock(lockKey, async () => {
    const order = await fetchOrder(sb, orderId);
    const duplicateByKey = await findActivePaymentByIdempotencyKey(sb, idempotencyKey);
    if (duplicateByKey && !isVerifiedBasePaymentRow(duplicateByKey, { orderId, amount, actorPin: actor.pin })) {
      throw new Error('BASE_ARKA_IDEMPOTENCY_CONFLICT');
    }
    const duplicate = duplicateByKey || await findDuplicateBasePayment(sb, { orderId, amount });
    let payment = duplicate || null;
    let reusedExistingPayment = Boolean(duplicate);
    if (!payment) {
      try {
        payment = await insertRow(sb, PENDING_TABLE, buildBasePaymentRow(guardedPayload, order, actor), pendingInsertVariants);
      } catch (error) {
        const text = String(error?.code || error?.message || error || '').toLowerCase();
        const mightBeIdempotentRace = text.includes('23505') || text.includes('duplicate key') || text.includes('idemp');
        if (!mightBeIdempotentRace) throw error;
        const raced = await findActivePaymentByIdempotencyKey(sb, idempotencyKey);
        if (!raced || !isVerifiedBasePaymentRow(raced, { orderId, amount, actorPin: actor.pin })) throw error;
        payment = raced;
        reusedExistingPayment = true;
      }
    }

    const verifiedPayment = await verifyBasePaymentOrThrow(sb, { orderId, amount, payment, idempotencyKey });

    let updatedOrder = null;
    try {
      updatedOrder = await updateOrderAfterPayment(sb, order, amount, {
        duplicate: reusedExistingPayment,
        statusOnFullPayment:
          guardedPayload.statusOnFullPayment ||
          guardedPayload.status_on_full_payment ||
          guardedPayload.fullPaymentStatus ||
          guardedPayload.full_payment_status,
      });
    } catch (error) {
      return {
        ok: false,
        action: ARKA_ACTION.BASE_ORDER_PAYMENT,
        needsManualRepair: true,
        repairCode: 'BASE_ORDER_UPDATE_FAILED_AFTER_PAYMENT_INSERT',
        error: String(error?.message || error || 'BASE_ORDER_UPDATE_FAILED_AFTER_PAYMENT_INSERT'),
        duplicate: reusedExistingPayment,
        existing: reusedExistingPayment,
        payment: verifiedPayment,
        row: verifiedPayment,
        verifiedPayment,
        paymentVerified: true,
        orderId,
      };
    }

    await verifyBasePaymentOrThrow(sb, { orderId, amount, payment: verifiedPayment, idempotencyKey });

    return {
      ok: true,
      action: ARKA_ACTION.BASE_ORDER_PAYMENT,
      duplicate: reusedExistingPayment,
      existing: reusedExistingPayment,
      payment: verifiedPayment,
      row: verifiedPayment,
      verifiedPayment,
      paymentVerified: true,
      order: updatedOrder,
      idempotencyKey,
    };
  });
}

async function transportOrderPayment(sb, payload = {}) {
  const actor = actorFromPayload(payload);
  const transportOrderId = normalizeUuid(payload.transportOrderId || payload.transport_order_id || payload.orderId || payload.order_id);
  const amount = positiveMoney(payload.amount, 'AMOUNT_INVALID');
  if (!transportOrderId) throw new Error('TRANSPORT_ORDER_ID_INVALID');
  if (!actor.pin) throw new Error('ACTOR_PIN_REQUIRED');

  const deterministicKey = buildTransportCashIdempotencyKey({ transportOrderId, amount, actorPin: actor.pin });
  const idempotencyKey = cleanText(payload.idempotencyKey || payload.idempotency_key || deterministicKey, '');
  const guardedPayload = { ...payload, idempotencyKey, idempotency_key: idempotencyKey };
  const lockKey = `transport_cash:${transportOrderId}:${idempotentMoneyKey(amount)}:${actor.pin}`;

  return withRuntimeLock(lockKey, async () => {
    const row = await fetchTransportOrder(sb, transportOrderId);
    const transportCode = normalizeTransportCode(
      guardedPayload.transportCode ||
      guardedPayload.transport_code_str ||
      guardedPayload.order_code ||
      row.code_str ||
      row.client_tcode ||
      asObject(row?.data)?.client?.tcode
    );
    const verifyTarget = { transportOrderId, amount, actorPin: actor.pin, transportCode, idempotencyKey };

    const duplicateByKey = await findActivePaymentByIdempotencyKey(sb, idempotencyKey);
    if (duplicateByKey && !isVerifiedTransportPaymentRow(duplicateByKey, verifyTarget)) {
      throw new Error('TRANSPORT_ARKA_IDEMPOTENCY_CONFLICT');
    }
    const duplicateByTransport = duplicateByKey || await findDuplicateTransportPayment(sb, { transportOrderId, amount, actorPin: actor.pin });
    const payment = duplicateByTransport || await insertRow(sb, PENDING_TABLE, buildTransportPaymentRow(guardedPayload, row, actor), pendingInsertVariants);
    const verifiedPayment = await verifyTransportPaymentOrThrow(sb, { ...verifyTarget, payment });

    let transportOrder = null;
    try {
      transportOrder = await updateTransportAfterPayment(sb, row, amount, { duplicate: Boolean(duplicateByTransport) });
    } catch (error) {
      return {
        ok: false,
        action: ARKA_ACTION.TRANSPORT_ORDER_PAYMENT,
        needsManualRepair: true,
        repairCode: 'TRANSPORT_ORDER_UPDATE_FAILED_AFTER_PAYMENT_INSERT',
        error: String(error?.message || error || 'TRANSPORT_ORDER_UPDATE_FAILED_AFTER_PAYMENT_INSERT'),
        duplicate: Boolean(duplicateByTransport),
        existing: Boolean(duplicateByTransport),
        payment: verifiedPayment,
        row: verifiedPayment,
        verifiedPayment,
        paymentVerified: true,
        transportOrderId,
      };
    }

    await verifyTransportPaymentOrThrow(sb, { ...verifyTarget, payment: verifiedPayment });

    return {
      ok: true,
      action: ARKA_ACTION.TRANSPORT_ORDER_PAYMENT,
      duplicate: Boolean(duplicateByTransport),
      existing: Boolean(duplicateByTransport),
      payment: verifiedPayment,
      row: verifiedPayment,
      verifiedPayment,
      paymentVerified: true,
      transportOrder,
      transport_order: transportOrder,
    };
  });
}

function normalizeExpenseType(value) {
  const type = upper(value || ARKA_PAYMENT_TYPE.EXPENSE);
  if (Object.values(ARKA_PAYMENT_TYPE).includes(type)) return type;
  if (type === 'ADVANCE') return 'ADVANCE'; // legacy compatibility for existing ARKA debt/advance screens
  return ARKA_PAYMENT_TYPE.EXPENSE;
}

async function expenseRequest(sb, payload = {}) {
  const actor = actorFromPayload(payload);
  const amount = positiveMoney(payload.amount, 'AMOUNT_INVALID');
  const paymentType = normalizeExpenseType(payload.paymentType || payload.payment_type || payload.type || ARKA_PAYMENT_TYPE.EXPENSE);
  const targetPin = normalizePin(pick(payload.workerPin, payload.worker_pin, payload.created_by_pin, payload.targetPin, actor.pin));
  const targetName = cleanText(pick(payload.workerName, payload.worker_name, payload.created_by_name, payload.targetName, actor.name), 'PËRDORUESI');
  if (!actor.pin && !targetPin) throw new Error('ACTOR_PIN_REQUIRED');
  const sourceModule = upper(payload.sourceModule || payload.source_module || ARKA_SOURCE_MODULE.BASE);
  const status = upper(payload.status || (paymentType === 'ADVANCE' ? 'ADVANCE' : ARKA_PAYMENT_STATUS.PENDING));
  const idempotencyKey = cleanText(payload.idempotencyKey || payload.idempotency_key, '') || null;

  validateMealExpensePayload(payload, paymentType, amount);

  if ([ARKA_PAYMENT_TYPE.MEAL_PAYMENT, ARKA_PAYMENT_TYPE.MEAL_COVERED].includes(paymentType) && idempotencyKey) {
    const duplicate = await findActivePaymentByIdempotencyKey(sb, idempotencyKey);
    if (duplicate?.id) {
      return { ok: true, action: ARKA_ACTION.EXPENSE_REQUEST, duplicate: true, existing: true, payment: duplicate, row: duplicate };
    }
  }

  if (paymentType === ARKA_PAYMENT_TYPE.MEAL_PAYMENT) {
    const mealTargets = mealTargetListFromRow({ handoff_note: payload.handoffNote || payload.handoff_note || '' });
    for (const mealTargetPin of mealTargets) {
      await assertMealCoverageOpen(sb, mealTargetPin);
    }
  }

  const skipMealCoverageGuard = payload.skipMealCoverageGuard === true || payload.skip_meal_coverage_guard === true;
  if (paymentType === ARKA_PAYMENT_TYPE.MEAL_COVERED && !skipMealCoverageGuard) {
    await assertMealCoverageOpen(sb, targetPin || actor.pin);
  }

  const createdAt = nowIso();
  const row = await insertRow(sb, PENDING_TABLE, {
    idempotency_key: idempotencyKey,
    order_id: null,
    cycle_id: null,
    applied_cycle_id: null,
    amount,
    type: paymentType,
    status,
    note: cleanText(payload.note, paymentType === ARKA_PAYMENT_TYPE.EXPENSE ? 'SHPENZIM' : paymentType),
    source_module: sourceModule === ARKA_SOURCE_MODULE.TRANSPORT ? ARKA_SOURCE_MODULE.TRANSPORT : (sourceModule === ARKA_SOURCE_MODULE.ARKA ? ARKA_SOURCE_MODULE.ARKA : ARKA_SOURCE_MODULE.BASE),
    client_name: null,
    client_phone: null,
    order_code: null,
    created_by_pin: targetPin || actor.pin || null,
    created_by_name: targetName || actor.name || null,
    created_by_role: cleanText(payload.workerRole || payload.worker_role || actor.role, '') || null,
    approved_by_pin: status === ARKA_PAYMENT_STATUS.PENDING ? null : actor.pin || null,
    approved_by_name: status === ARKA_PAYMENT_STATUS.PENDING ? null : actor.name || null,
    handed_at: status === ARKA_PAYMENT_STATUS.PENDING ? null : createdAt,
    handed_by_pin: status === ARKA_PAYMENT_STATUS.PENDING ? null : actor.pin || null,
    handed_by_name: status === ARKA_PAYMENT_STATUS.PENDING ? null : actor.name || null,
    handed_by_role: cleanText(payload.workerRole || payload.worker_role || actor.role, '') || null,
    handoff_note: cleanText(payload.handoffNote || payload.handoff_note, '') || null,
    created_at: createdAt,
    updated_at: createdAt,
  }, pendingInsertVariants);
  return { ok: true, action: ARKA_ACTION.EXPENSE_REQUEST, payment: row, row };
}

async function createMealDistributionAtomic(sb, payload = {}) {
  const actor = actorFromPayload(payload);
  if (!actor.pin) throw new Error('ACTOR_PIN_REQUIRED');
  const payerPin = normalizePin(pick(payload.payerPin, payload.payer_pin, actor.pin));
  if (!payerPin) throw new Error('PAYER_PIN_REQUIRED');
  const payerName = cleanText(pick(payload.payerName, payload.payer_name, actor.name, payerPin), payerPin);
  const payerRole = cleanText(pick(payload.payerRole, payload.payer_role, actor.role, 'WORKER'), 'WORKER');
  const targetsInput = Array.isArray(payload.coveredWorkers || payload.covered_workers || payload.targets)
    ? (payload.coveredWorkers || payload.covered_workers || payload.targets)
    : [];
  const targetMap = new Map();
  for (const row of targetsInput) {
    const pin = normalizePin(pick(row?.pin, row?.workerPin, row?.worker_pin));
    if (!pin || targetMap.has(pin)) continue;
    targetMap.set(pin, {
      pin,
      name: cleanText(pick(row?.name, row?.workerName, row?.worker_name, pin), pin),
      role: cleanText(pick(row?.role, row?.workerRole, row?.worker_role, 'WORKER'), 'WORKER'),
    });
  }
  const targets = [...targetMap.values()];
  if (!targets.length) throw new Error('MEAL_TARGETS_REQUIRED');

  const amountPerPerson = money(payload.amountPerPerson || payload.amount_per_person || 3);
  if (Math.abs(amountPerPerson - 3) > 0.005) throw new Error('MEAL_DAILY_AMOUNT_MUST_BE_3');
  const mealDay = cleanText(payload.mealDay || payload.meal_day || mealTodayBoundsIso(new Date()).dateKey, '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(mealDay)) throw new Error('MEAL_DAY_INVALID');

  const idempotencyKey = cleanText(payload.idempotencyKey || payload.idempotency_key, '') || null;
  const { data, error } = await sb.rpc('create_meal_distribution_atomic', {
    actor_pin: actor.pin,
    actor_name: actor.name || null,
    actor_role: actor.role || null,
    payer_pin: payerPin,
    payer_name: payerName || null,
    payer_role: payerRole || null,
    meal_day: mealDay,
    amount_per_person: amountPerPerson,
    targets: targets,
    note: cleanText(payload.note, 'USHQIM EKIPI'),
    idempotency_key: idempotencyKey,
  });
  if (error) {
    if (isMissingRpcFunctionError(error, 'create_meal_distribution_atomic')) {
      throw new Error('CREATE_MEAL_DISTRIBUTION_ATOMIC_RPC_REQUIRED');
    }
    throw error;
  }
  if (data?.ok === false) throw new Error(data?.error || data?.message || 'CREATE_MEAL_DISTRIBUTION_FAILED');
  return {
    ok: true,
    action: ARKA_ACTION.CREATE_MEAL_DISTRIBUTION,
    ...(data || {}),
    rows: Array.isArray(data?.rows) ? data.rows : [data?.payment, ...(Array.isArray(data?.covered) ? data.covered : [])].filter(Boolean),
  };
}

async function readPaymentsByIds(sb, ids = []) {
  const cleanIds = [...new Set((ids || []).map((id) => normalizeDbId(id)).filter(Boolean))];
  if (!cleanIds.length) return [];
  const { data, error } = await sb.from(PENDING_TABLE).select('*').in('id', cleanIds);
  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

async function listActorReadyPayments(sb, actorPin, limit = 500) {
  const pin = normalizePin(actorPin);
  if (!pin) return [];
  const rows = [];
  const seen = new Set();
  const push = (row) => {
    if (!row?.id || seen.has(String(row.id))) return;
    const st = normalizeLegacyArkaStatus(row.status);
    if (!isReadyForHandoffStatus(st)) return;
    if (!(money(row.amount) > 0)) return;
    const type = upper(row.type);
    if ([ARKA_PAYMENT_TYPE.EXPENSE, ARKA_PAYMENT_TYPE.TIMA, ARKA_PAYMENT_TYPE.MEAL_PAYMENT, ARKA_PAYMENT_TYPE.MEAL_COVERED, 'ADVANCE'].includes(type)) return;
    seen.add(String(row.id));
    rows.push(row);
  };

  const queries = [
    sb.from(PENDING_TABLE).select('*').eq('created_by_pin', pin).in('status', [ARKA_PAYMENT_STATUS.PENDING, ARKA_PAYMENT_STATUS.COLLECTED]).order('created_at', { ascending: false }).limit(limit),
    sb.from(PENDING_TABLE).select('*').eq('handed_by_pin', pin).in('status', [ARKA_PAYMENT_STATUS.PENDING, ARKA_PAYMENT_STATUS.COLLECTED]).order('created_at', { ascending: false }).limit(limit),
  ];
  for (const query of queries) {
    const { data, error } = await query;
    if (error) throw error;
    (Array.isArray(data) ? data : []).forEach(push);
  }
  const activeLinked = await findPaymentIdsInActiveHandoffs(sb, rows.map((row) => row.id));
  return rows.filter((row) => !activeLinked.has(normalizeDbId(row.id))).slice(0, limit);
}

function isMealPaymentRow(row = {}) {
  return upper(row?.type) === ARKA_PAYMENT_TYPE.MEAL_PAYMENT;
}

function isMealCoveredRow(row = {}) {
  return upper(row?.type) === ARKA_PAYMENT_TYPE.MEAL_COVERED;
}

const ARKA_MEAL_TIME_ZONE = 'Europe/Belgrade';
const CLOSED_MEAL_STATUSES = new Set(['REJECTED', 'REFUZUAR', 'VOIDED', 'CANCELLED', 'CANCELED']);

function formatMealDateKey(value = new Date(), timeZone = ARKA_MEAL_TIME_ZONE) {
  const d = value instanceof Date ? value : new Date(value || Date.now());
  if (Number.isNaN(d.getTime())) return new Date().toISOString().slice(0, 10);
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
    const get = (type) => parts.find((part) => part.type === type)?.value || '';
    return `${get('year')}-${get('month')}-${get('day')}`;
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

function mealTzOffsetMs(timeZone, utcMs) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(new Date(utcMs));
    const get = (type) => Number(parts.find((part) => part.type === type)?.value || 0);
    const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
    return asUtc - utcMs;
  } catch {
    return 0;
  }
}

function mealZonedLocalToUtcMs(timeZone, y, m, d, h = 0, min = 0, sec = 0) {
  const guess = Date.UTC(y, m - 1, d, h, min, sec);
  const offset = mealTzOffsetMs(timeZone, guess);
  return Date.UTC(y, m - 1, d, h, min, sec) - offset;
}

function mealTodayBoundsIso(refDate = new Date()) {
  try {
    const key = formatMealDateKey(refDate, ARKA_MEAL_TIME_ZONE);
    const [y, m, d] = key.split('-').map((x) => Number(x));
    return {
      dateKey: key,
      startIso: new Date(mealZonedLocalToUtcMs(ARKA_MEAL_TIME_ZONE, y, m, d, 0, 0, 0)).toISOString(),
      endIso: new Date(mealZonedLocalToUtcMs(ARKA_MEAL_TIME_ZONE, y, m, d + 1, 0, 0, 0)).toISOString(),
    };
  } catch {
    const key = new Date().toISOString().slice(0, 10);
    return { dateKey: key, startIso: `${key}T00:00:00.000Z`, endIso: new Date(Date.parse(`${key}T00:00:00.000Z`) + 86400000).toISOString() };
  }
}

function isActiveMealStatus(status) {
  const s = upper(status);
  if (!s) return true;
  return !CLOSED_MEAL_STATUSES.has(s);
}

function mealNote(value = {}) {
  return String(pick(value?.handoff_note, value?.handoffNote, value?.note, '') || '');
}

function mealMarkerValue(note = '', marker = '') {
  const name = String(marker || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = String(note || '').match(new RegExp(`(?:^|[\\s|;])${name}:([^|;\\s]+)`, 'i'));
  return m ? String(m[1] || '').trim() : '';
}

function mealDayKeyFromRow(row = {}) {
  const note = mealNote(row);
  const marked = mealMarkerValue(note, 'MEAL_DAY')
    || mealMarkerValue(note, 'MEAL_OPEN')
    || mealMarkerValue(note, 'MEAL_CARRY')
    || mealMarkerValue(note, 'MEAL_DEBT');
  if (/^\d{4}-\d{2}-\d{2}$/.test(marked)) return marked;
  const raw = pick(row?.created_at, row?.createdAt, row?.handed_at, row?.handedAt);
  return raw ? formatMealDateKey(new Date(raw), ARKA_MEAL_TIME_ZONE) : '';
}

function mealRowMatchesDay(row = {}, dayKey = mealTodayBoundsIso(new Date()).dateKey) {
  return mealDayKeyFromRow(row) === dayKey;
}

function mealHasGuardedMarker(row = {}) {
  const note = mealNote(row);
  return /(?:^|[\s|;])MEAL_(?:DAY|OPEN|CARRY|DEBT):\d{4}-\d{2}-\d{2}\b/i.test(note);
}

function mealTargetListFromRow(row = {}) {
  const note = mealNote(row);
  const single = mealMarkerValue(note, 'MEAL_FOR');
  const many = mealMarkerValue(note, 'MEAL_TARGETS');
  return [...new Set([single, ...String(many || '').split(',')].map((x) => normalizePin(x)).filter(Boolean))];
}

function mealHandoffNoteCoversPin(row = {}, pin = '') {
  const cleanPin = normalizePin(pin);
  if (!cleanPin) return false;
  const explicitTargets = mealTargetListFromRow(row);
  if (explicitTargets.length) return explicitTargets.includes(cleanPin);
  const note = mealNote(row);
  const escaped = cleanPin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\(${escaped}\\)|PIN\\s*${escaped}|:${escaped}\\b|\\b${escaped}\\b`, 'i').test(note);
}

function mealRowCoversWorker(row = {}, pin = '') {
  const cleanPin = normalizePin(pin);
  if (!cleanPin) return false;
  const type = upper(row?.type);
  const createdPin = normalizePin(row?.created_by_pin);
  if (type === ARKA_PAYMENT_TYPE.MEAL_COVERED) {
    const explicitTargets = mealTargetListFromRow(row);
    if (explicitTargets.length) return explicitTargets.includes(cleanPin);
    return createdPin === cleanPin;
  }
  if (type === ARKA_PAYMENT_TYPE.MEAL_PAYMENT) {
    if (mealHandoffNoteCoversPin(row, cleanPin)) return true;
    return createdPin === cleanPin && !cleanText(row?.handoff_note, '');
  }
  return false;
}

async function findMealCoverageRowsForPinsToday(sb, pins = [], limit = 1000) {
  const cleanPins = [...new Set((Array.isArray(pins) ? pins : [pins]).map((pin) => normalizePin(pin)).filter(Boolean))];
  if (!cleanPins.length) return [];
  const bounds = mealTodayBoundsIso(new Date());
  const { data, error } = await sb
    .from(PENDING_TABLE)
    .select('*')
    .in('type', [ARKA_PAYMENT_TYPE.MEAL_PAYMENT, ARKA_PAYMENT_TYPE.MEAL_COVERED])
    .gte('created_at', bounds.startIso)
    .lt('created_at', bounds.endIso)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (Array.isArray(data) ? data : [])
    .filter((row) => isActiveMealStatus(row?.status))
    .filter((row) => mealRowMatchesDay(row, bounds.dateKey))
    .filter((row) => cleanPins.some((pin) => mealRowCoversWorker(row, pin)));
}

async function assertMealCoverageOpen(sb, targetPin) {
  const pin = normalizePin(targetPin);
  if (!pin) return;
  const rows = await findMealCoverageRowsForPinsToday(sb, [pin], 1000);
  if (rows.length) throw new Error(`MEAL_ALREADY_REGISTERED_TODAY:${pin}`);
}

function isMealSettledInHandoff(row = {}) {
  return String(row?.handoff_note || '').trim().toUpperCase().startsWith('SETTLED_IN_HANDOFF:');
}

function isUnsettledMealPayment(row = {}) {
  if (!isMealPaymentRow(row)) return false;
  if (!(money(row?.amount) > 0)) return false;
  if (isMealSettledInHandoff(row)) return false;
  return ARKA_ACTIVE_PAYMENT_STATUSES.includes(normalizeLegacyArkaStatus(row?.status));
}

function mealPaymentEligibleForHandoff(row = {}) {
  if (!isUnsettledMealPayment(row)) return false;
  // V4 safety: only guarded meal-flow rows can be deducted.
  // Plain/legacy MEAL_PAYMENT rows are ignored so stale/manual rows cannot be swept into a handoff.
  return mealHasGuardedMarker(row);
}

function mealTargetCountFromNote(note = '') {
  const targets = mealMarkerValue(note, 'MEAL_TARGETS');
  return String(targets || '').split(',').map((x) => normalizePin(x)).filter(Boolean).length;
}

function validateMealExpensePayload(payload = {}, paymentType = '', amount = 0) {
  const type = upper(paymentType);
  if (![ARKA_PAYMENT_TYPE.MEAL_PAYMENT, ARKA_PAYMENT_TYPE.MEAL_COVERED].includes(type)) return;
  const note = String(pick(payload.handoffNote, payload.handoff_note, '') || '');
  const day = mealMarkerValue(note, 'MEAL_DAY') || mealMarkerValue(note, 'MEAL_OPEN');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('MEAL_GUARD_DAY_REQUIRED');

  if (type === ARKA_PAYMENT_TYPE.MEAL_COVERED) {
    const mealFor = normalizePin(mealMarkerValue(note, 'MEAL_FOR'));
    const mealBy = normalizePin(mealMarkerValue(note, 'MEAL_BY'));
    if (!mealFor || !mealBy) throw new Error('MEAL_COVERED_MARKER_REQUIRED');
    if (Math.abs(money(amount) - 3) > 0.005) throw new Error('MEAL_DAILY_AMOUNT_MUST_BE_3');
    return;
  }

  const mealBy = normalizePin(mealMarkerValue(note, 'MEAL_BY'));
  const targetCount = mealTargetCountFromNote(note);
  if (!mealBy || targetCount < 1) throw new Error('MEAL_PAYMENT_MARKER_REQUIRED');
  const expected = round2(3 * targetCount);
  if (Math.abs(money(amount) - expected) > 0.005) throw new Error(`MEAL_PAYMENT_AMOUNT_INVALID expected=${expected.toFixed(2)}`);
}

function rowBelongsToActor(row = {}, actorPin = '') {
  const pin = normalizePin(actorPin);
  if (!pin) return true;
  const pins = [row.created_by_pin, row.handed_by_pin, row.worker_pin, row.driver_pin, row.actor_pin]
    .map((value) => normalizePin(value))
    .filter(Boolean);
  return !pins.length || pins.includes(pin);
}

async function listActorUnsettledMealPayments(sb, actorPin, limit = 100) {
  const pin = normalizePin(actorPin);
  if (!pin) return [];
  const rows = [];
  const seen = new Set();
  const push = (row) => {
    if (!row?.id || seen.has(String(row.id))) return;
    if (!mealPaymentEligibleForHandoff(row)) return;
    if (!rowBelongsToActor(row, pin)) return;
    seen.add(String(row.id));
    rows.push(row);
  };

  // MEAL_PAYMENT belongs to the payer. Do not use handed_by_pin here:
  // when worker A records that worker B paid, handed_by_pin can be A while
  // created_by_pin is B. Deducting by handed_by_pin would charge A incorrectly.
  const querySpecs = [
    { field: 'created_by_pin', value: pin },
  ];
  for (const spec of querySpecs) {
    try {
      const { data, error } = await sb
        .from(PENDING_TABLE)
        .select('*')
        .eq(spec.field, spec.value)
        .eq('type', ARKA_PAYMENT_TYPE.MEAL_PAYMENT)
        .in('status', ARKA_ACTIVE_PAYMENT_STATUSES)
        .order('created_at', { ascending: false })
        .limit(limit);
      if (error) throw error;
      (Array.isArray(data) ? data : []).forEach(push);
    } catch (error) {
      if (!isMissingColumnOrFunctionError(error)) throw error;
    }
  }

  const activeLinked = await findPaymentIdsInActiveHandoffs(sb, rows.map((row) => row.id));
  return rows.filter((row) => !activeLinked.has(normalizeDbId(row.id))).slice(0, limit);
}

function detectPaymentSource(row = {}) {
  const explicit = upper(row.source_module || row.sourceModule);
  if (explicit === ARKA_SOURCE_MODULE.TRANSPORT) return ARKA_SOURCE_MODULE.TRANSPORT;
  if (explicit === ARKA_SOURCE_MODULE.ARKA) return ARKA_SOURCE_MODULE.ARKA;
  const type = upper(row.type);
  if (type === ARKA_PAYMENT_TYPE.TRANSPORT) return ARKA_SOURCE_MODULE.TRANSPORT;
  if ([ARKA_PAYMENT_TYPE.MEAL_PAYMENT, ARKA_PAYMENT_TYPE.MEAL_COVERED, ARKA_PAYMENT_TYPE.SALARY_PAYMENT, ARKA_PAYMENT_TYPE.EXPENSE, ARKA_PAYMENT_TYPE.TIMA, 'ADVANCE'].includes(type)) return ARKA_SOURCE_MODULE.ARKA;
  if (normalizeUuid(row.transport_order_id || row.transportOrderId)) return ARKA_SOURCE_MODULE.TRANSPORT;
  if (normalizeTransportCode(row.transport_code_str || row.transportCodeStr || row.order_code)) return ARKA_SOURCE_MODULE.TRANSPORT;
  return ARKA_SOURCE_MODULE.BASE;
}

function transportM2(row = {}) {
  const candidates = [row.transport_m2, row.transportM2, row.m2, row.data?.pay?.m2, row.data?.m2_total];
  for (const value of candidates) {
    const parsed = money(value);
    if (parsed > 0) return parsed;
  }
  const note = String(row.note || '');
  const matches = Array.from(note.matchAll(/([0-9]+(?:[.,][0-9]+)?)\s*(?:m²|m2|m\^2)/gi));
  if (matches.length) return money(matches[matches.length - 1][1]);
  return 0;
}

async function workerFinanceProfile(sb, pin) {
  const cleanPin = normalizePin(pin);
  if (!cleanPin) return { isHybridTransport: false, commissionRateM2: 0 };
  try {
    const { data, error } = await sb.from('users').select('is_hybrid_transport,commission_rate_m2').eq('pin', cleanPin).maybeSingle();
    if (error) throw error;
    return { isHybridTransport: Boolean(data?.is_hybrid_transport), commissionRateM2: money(data?.commission_rate_m2) };
  } catch {
    return { isHybridTransport: false, commissionRateM2: 0 };
  }
}

function toHandoffItem(row = {}, handoffId, profile = {}) {
  const sourceModule = detectPaymentSource(row);
  const isTransport = sourceModule === ARKA_SOURCE_MODULE.TRANSPORT;
  const isMealPayment = isMealPaymentRow(row);
  if (isMealPayment) {
    throw new Error('MEAL_PAYMENT_MUST_NOT_BE_HANDOFF_ITEM');
  }
  const rawAmount = money(row.amount);
  const m2 = isTransport ? transportM2(row) : 0;
  const commission = isTransport && profile.isHybridTransport ? round2(m2 * money(profile.commissionRateM2)) : 0;
  const amount = round2(Math.max(0, rawAmount - Math.min(rawAmount, commission)));
  return {
    handoff_id: handoffId,
    pending_payment_id: normalizeDbId(row.id),
    order_id: isTransport || isMealPayment ? null : normalizeDbId(row.order_id),
    order_code: isTransport || isMealPayment ? null : normalizeBaseCode(row.order_code || row.code),
    source_module: sourceModule,
    transport_order_id: isTransport ? normalizeUuid(row.transport_order_id || row.transportOrderId || row.order_id || row.orderId) : null,
    transport_code_str: isTransport ? normalizeTransportCode(row.transport_code_str || row.transportCodeStr || row.order_code || row.code) : null,
    transport_m2: isTransport ? m2 : 0,
    amount,
  };
}

function dedupeTransportItems(items = []) {
  const out = [];
  const seen = new Map();
  for (const item of items) {
    const key = item.transport_order_id ? `id:${item.transport_order_id}` : (item.transport_code_str ? `code:${item.transport_code_str}` : '');
    if (!key) {
      out.push(item);
      continue;
    }
    if (!seen.has(key)) {
      seen.set(key, item);
      out.push(item);
    }
  }
  return out;
}

function applyMealDeductionToHandoffItems(items = [], deductionAmount = 0) {
  const cloned = (Array.isArray(items) ? items : [])
    .map((item) => ({ ...item, amount: round2(money(item?.amount)) }))
    .filter((item) => money(item.amount) > 0);
  const deduction = round2(Math.max(0, money(deductionAmount)));
  const grossTotal = round2(cloned.reduce((sum, item) => sum + money(item.amount), 0));
  if (!(deduction > 0)) return { items: cloned, grossTotal, netTotal: grossTotal, appliedDeduction: 0 };
  const netTotal = round2(grossTotal - deduction);
  if (!(grossTotal > 0)) throw new Error('NO_CASH_TO_DEDUCT_MEAL');
  if (!(netTotal > 0)) throw new Error('HANDOFF_AMOUNT_ZERO_AFTER_MEAL_DEDUCT');

  // cash_handoff_items.amount has a DB CHECK that rejects negative rows.
  // Store only positive/net item amounts and spread the meal deduction across
  // the existing client/transport rows, same model as hybrid commission netting.
  const minimumItemAmount = 0.01;
  if (netTotal + 0.0001 < cloned.length * minimumItemAmount) {
    throw new Error('HANDOFF_NET_TOO_SMALL_AFTER_MEAL_DEDUCT');
  }

  let remaining = deduction;
  const order = cloned
    .map((item, index) => ({ index, amount: money(item.amount) }))
    .sort((a, b) => b.amount - a.amount);

  for (const { index } of order) {
    if (!(remaining > 0)) break;
    const current = money(cloned[index].amount);
    const maxTake = round2(Math.max(0, current - minimumItemAmount));
    if (!(maxTake > 0)) continue;
    const take = round2(Math.min(maxTake, remaining));
    cloned[index].amount = round2(current - take);
    remaining = round2(remaining - take);
  }

  if (Math.abs(remaining) > 0.005) throw new Error('MEAL_DEDUCT_DISTRIBUTION_FAILED');

  const adjustedSum = round2(cloned.reduce((sum, item) => sum + money(item.amount), 0));
  const correction = round2(netTotal - adjustedSum);
  if (Math.abs(correction) > 0.005) {
    const targetIndex = cloned.reduce((best, item, index) => (money(item.amount) > money(cloned[best]?.amount) ? index : best), 0);
    const corrected = round2(money(cloned[targetIndex].amount) + correction);
    if (!(corrected > 0)) throw new Error('MEAL_DEDUCT_ROUNDING_FAILED');
    cloned[targetIndex].amount = corrected;
  }

  return { items: cloned, grossTotal, netTotal, appliedDeduction: deduction };
}

async function submitHandoffFallback(sb, payload = {}) {
  const actor = actorFromPayload(payload);
  if (!actor.pin) throw new Error('ACTOR_PIN_REQUIRED');
  const explicitPaymentIds = Array.isArray(payload.paymentIds || payload.payment_ids)
    ? (payload.paymentIds || payload.payment_ids).map((id) => normalizeDbId(id)).filter(Boolean)
    : [];

  const explicitRows = explicitPaymentIds.length ? await readPaymentsByIds(sb, explicitPaymentIds) : [];
  const autoRows = explicitPaymentIds.length ? [] : await listActorReadyPayments(sb, actor.pin, 500);
  const mealRows = await listActorUnsettledMealPayments(sb, actor.pin, 100);
  const byId = new Map();
  for (const row of [...autoRows, ...explicitRows, ...mealRows]) {
    if (row?.id && !isMealCoveredRow(row)) byId.set(String(row.id), row);
  }
  const payments = Array.from(byId.values());
  if (!payments.length) throw new Error('NO_READY_PAYMENTS_FOR_HANDOFF');

  const invalid = payments.find((row) => {
    if (isMealPaymentRow(row)) return !isUnsettledMealPayment(row);
    return !isReadyForHandoffStatus(row.status);
  });
  if (invalid) throw new Error(isMealPaymentRow(invalid) ? 'MEAL_PAYMENT_NOT_READY_FOR_HANDOFF' : 'PAYMENT_NOT_READY_FOR_HANDOFF');

  const activeLinked = await findPaymentIdsInActiveHandoffs(sb, payments.map((row) => row.id));
  if (activeLinked.size) throw new Error('PAYMENT_ALREADY_IN_ACTIVE_HANDOFF');

  const actorMismatch = payments.find((row) => !rowBelongsToActor(row, actor.pin));
  if (actorMismatch) throw new Error('PAYMENT_ACTOR_MISMATCH');

  const profile = await workerFinanceProfile(sb, actor.pin);
  const mealRowsForDeduct = payments.filter((row) => isMealPaymentRow(row));
  const regularPayments = payments.filter((row) => !isMealPaymentRow(row));
  const regularPrepared = regularPayments.map((row) => ({ row, item: toHandoffItem(row, null, profile) }));
  const grossItems = dedupeTransportItems(regularPrepared.map((x) => x.item));
  const regularItemIds = new Set(grossItems.map((x) => String(x.pending_payment_id)));
  const regularRows = regularPrepared.filter((entry) => regularItemIds.has(String(entry.item.pending_payment_id))).map((entry) => entry.row);
  const mealTotal = round2(mealRowsForDeduct.reduce((sum, row) => sum + money(row.amount), 0));
  if (!regularRows.length && mealTotal > 0) throw new Error('NO_CASH_TO_DEDUCT_MEAL');
  if (!regularRows.length) throw new Error('NO_READY_PAYMENTS_FOR_HANDOFF');
  const itemNetting = applyMealDeductionToHandoffItems(grossItems, mealTotal);
  const items = itemNetting.items;
  const amount = round2(itemNetting.netTotal);
  if (!(amount > 0)) throw new Error('HANDOFF_AMOUNT_ZERO');

  const declared = payload.amountDeclared != null ? money(payload.amountDeclared) : null;
  if (declared != null && declared > 0 && Math.abs(declared - amount) > 0.05) throw new Error('HANDOFF_DECLARED_AMOUNT_MISMATCH');

  const submittedAt = nowIso();
  const regularPaymentIds = regularRows.map((row) => normalizeDbId(row.id)).filter(Boolean);
  const mealPaymentIds = mealRowsForDeduct.map((row) => normalizeDbId(row.id)).filter(Boolean);
  const paymentIds = regularPaymentIds;
  const allPaymentIds = [...new Set([...regularPaymentIds, ...mealPaymentIds])].filter(Boolean);
  const handoffRows = [...regularRows, ...mealRowsForDeduct];
  const regularTotal = round2(itemNetting.grossTotal);

  const handoff = await insertRow(sb, HANDOFF_TABLE, {
    idempotency_key: cleanText(payload.idempotencyKey || payload.idempotency_key, '') || null,
    worker_pin: actor.pin,
    worker_name: actor.name || actor.pin,
    driver_pin: actor.pin,
    driver_name: actor.name || actor.pin,
    amount,
    total_amount: amount,
    count_clients: paymentIds.length,
    status: ARKA_HANDOFF_STATUS.PENDING_DISPATCH_APPROVAL,
    submitted_at: submittedAt,
    note: cleanText(payload.note, '') || null,
    payment_ids: paymentIds,
    order_ids: regularRows.map((row) => normalizeDbId(row.order_id)).filter(Boolean),
    data: {
      kind: 'cash_handoff',
      payment_ids: paymentIds,
      regular_payment_ids: regularPaymentIds,
      meal_payment_ids: mealPaymentIds,
      all_payment_ids: allPaymentIds,
      total_amount: amount,
      regular_total: regularTotal,
      meal_total: mealTotal,
      meal_deduct_applied: itemNetting.appliedDeduction,
      item_netting: 'meal_deduct_spread_positive_items_v2',
      count_clients: paymentIds.length,
    },
    updated_at: submittedAt,
  }, handoffInsertVariants);

  const originalRowsById = new Map(handoffRows.map((row) => [String(row.id), row]));
  try {
    if (regularPaymentIds.length) {
      const claim = await claimPendingPaymentsForHandoff(sb, regularPaymentIds, handoff.id, {
        status: ARKA_PAYMENT_STATUS.PENDING_DISPATCH_APPROVAL,
        submitted_at: submittedAt,
        handed_at: submittedAt,
        handed_by_pin: actor.pin,
        handed_by_name: actor.name || null,
        handed_by_role: actor.role || null,
        updated_at: submittedAt,
        handoff_note: `Handoff #${handoff.id}`,
      });

      if (claim.count !== regularPaymentIds.length) {
        await updateById(sb, HANDOFF_TABLE, handoff.id, {
          status: ARKA_HANDOFF_STATUS.CANCELLED,
          note: cleanText(payload.note, '') || 'HANDOFF_CANCELLED_PAYMENT_ALREADY_CLAIMED',
          updated_at: nowIso(),
        }, handoffUpdateVariants).catch(() => null);
        throw new Error('HANDOFF_PAYMENTS_ALREADY_CLAIMED');
      }
    }

    if (mealPaymentIds.length) {
      await updatePendingByIds(sb, mealPaymentIds, {
        handed_at: submittedAt,
        handed_by_pin: actor.pin,
        handed_by_name: actor.name || null,
        handed_by_role: actor.role || null,
        updated_at: submittedAt,
        handoff_note: `SETTLED_IN_HANDOFF:${handoff.id}`,
      });
    }

    const insertItems = items.map((item) => ({ ...item, handoff_id: handoff.id }));
    await insertRows(sb, HANDOFF_ITEMS_TABLE, insertItems);

    const verified = await readHandoffWithItems(sb, handoff.id);
    const itemSum = round2((verified.cash_handoff_items || []).reduce((sum, item) => sum + money(item.amount), 0));
    if (Math.abs(itemSum - amount) > 0.05) throw new Error('HANDOFF_ITEM_SUM_MISMATCH');

    let paymentRows = [];
    if (allPaymentIds.length) {
      const { data: paymentVerifyRows, error: paymentVerifyErr } = await sb
        .from(PENDING_TABLE)
        .select('id,status,handoff_note,type')
        .in('id', allPaymentIds);
      if (paymentVerifyErr) throw paymentVerifyErr;
      paymentRows = Array.isArray(paymentVerifyRows) ? paymentVerifyRows : [];
    }

    return {
      ok: true,
      action: ARKA_ACTION.SUBMIT_HANDOFF,
      handoff: verified,
      count: paymentIds.length,
      total: amount,
      mealTotal,
      regularTotal,
      devFallback: true,
      verification: {
        handoffId: verified?.id,
        itemCount: Array.isArray(verified.cash_handoff_items) ? verified.cash_handoff_items.length : 0,
        itemSum,
        paymentCount: paymentRows.length,
        paymentStatuses: paymentRows.map((row) => ({ id: row.id, status: row.status, handoff_note: row.handoff_note || null, type: row.type || null })),
      },
    };
  } catch (error) {
    await restoreClaimedPayments(sb, regularPaymentIds.map((id) => originalRowsById.get(String(id))).filter(Boolean), `HANDOFF_FAILED #${handoff.id}: ${String(error?.message || error)}`).catch(() => null);
    if (mealPaymentIds.length) {
      await updatePendingByIds(sb, mealPaymentIds, {
        handed_at: null,
        handed_by_pin: null,
        handed_by_name: null,
        handed_by_role: null,
        updated_at: nowIso(),
        handoff_note: `HANDOFF_FAILED #${handoff.id}: ${String(error?.message || error)}`,
      }).catch(() => null);
    }
    await updateById(sb, HANDOFF_TABLE, handoff.id, {
      status: ARKA_HANDOFF_STATUS.CANCELLED,
      note: cleanText(payload.note, '') || `HANDOFF_FAILED: ${String(error?.message || error)}`,
      updated_at: nowIso(),
    }, handoffUpdateVariants).catch(() => null);
    throw error;
  }
}

async function verifySubmittedHandoffState(sb, { handoff, paymentIds = [], mealPaymentIds = [] } = {}) {
  const handoffId = normalizeDbId(handoff?.id);
  if (!handoffId) throw new Error('HANDOFF_RESPONSE_MISSING_ID');

  const verified = await readHandoffWithItems(sb, handoffId);
  const status = upper(verified?.status);
  if (status !== ARKA_HANDOFF_STATUS.PENDING_DISPATCH_APPROVAL) {
    throw new Error(`HANDOFF_STATUS_INVALID:${status || 'EMPTY'}`);
  }

  const items = Array.isArray(verified?.cash_handoff_items) ? verified.cash_handoff_items : [];
  const itemPaymentIds = [...new Set(items.map((item) => normalizeDbId(item?.pending_payment_id)).filter(Boolean))];
  const expectedPaymentIds = [...new Set((paymentIds || []).map((id) => normalizeDbId(id)).filter(Boolean))];
  const expectedMealIds = [...new Set((mealPaymentIds || []).map((id) => normalizeDbId(id)).filter(Boolean))];
  const idsToVerify = expectedPaymentIds.length ? expectedPaymentIds : itemPaymentIds;
  const expectedCount = idsToVerify.length || Number(verified?.count_clients || 0) || items.length;

  if (!items.length) throw new Error('HANDOFF_ITEMS_EMPTY_AFTER_RPC');
  if (expectedCount > 0 && items.length !== expectedCount) {
    throw new Error(`HANDOFF_ITEM_COUNT_MISMATCH expected=${expectedCount} actual=${items.length}`);
  }

  if (idsToVerify.length) {
    const itemIdSet = new Set(itemPaymentIds.map((id) => String(id)));
    const missingItemIds = idsToVerify.filter((id) => !itemIdSet.has(String(id)));
    if (missingItemIds.length) throw new Error(`HANDOFF_ITEM_PAYMENT_MISSING:${missingItemIds.join(',')}`);
  }

  const itemSum = round2(items.reduce((sum, item) => sum + money(item?.amount), 0));
  const handoffAmount = round2(money(verified?.amount ?? verified?.total_amount));
  if (Math.abs(itemSum - handoffAmount) > 0.05) {
    throw new Error(`HANDOFF_ITEM_SUM_MISMATCH handoff=${handoffAmount.toFixed(2)} items=${itemSum.toFixed(2)}`);
  }

  let paymentRows = [];
  const allIdsToVerify = [...new Set([...idsToVerify, ...expectedMealIds])];
  if (allIdsToVerify.length) {
    const { data, error } = await sb
      .from(PENDING_TABLE)
      .select('id,status,handoff_note,type')
      .in('id', allIdsToVerify);
    if (error) throw error;
    paymentRows = Array.isArray(data) ? data : [];

    if (paymentRows.length !== allIdsToVerify.length) {
      throw new Error(`HANDOFF_PAYMENT_VERIFY_COUNT_MISMATCH expected=${allIdsToVerify.length} actual=${paymentRows.length}`);
    }

    const regularRows = paymentRows.filter((row) => !isMealPaymentRow(row));
    const badStatus = regularRows.find((row) => upper(row?.status) !== ARKA_PAYMENT_STATUS.PENDING_DISPATCH_APPROVAL);
    if (badStatus) {
      throw new Error(`HANDOFF_PAYMENT_STATUS_INVALID:${badStatus.id}:${upper(badStatus.status) || 'EMPTY'}`);
    }

    const missingNote = paymentRows.find((row) => !String(row?.handoff_note || '').includes(String(handoffId)));
    if (missingNote) throw new Error(`HANDOFF_NOTE_NOT_LINKED:${missingNote.id}`);

    const badMeal = paymentRows.find((row) => isMealPaymentRow(row) && !String(row?.handoff_note || '').toUpperCase().startsWith(`SETTLED_IN_HANDOFF:${String(handoffId).toUpperCase()}`));
    if (badMeal) throw new Error(`HANDOFF_MEAL_NOT_SETTLED:${badMeal.id}`);
  }

  return {
    handoff: verified,
    itemCount: items.length,
    itemSum,
    paymentCount: paymentRows.length,
    mealPaymentCount: expectedMealIds.length,
    paymentStatuses: paymentRows.map((row) => ({ id: row.id, status: row.status, handoff_note: row.handoff_note || null, type: row.type || null })),
  };
}

async function submitHandoffViaRpc(sb, payload = {}) {
  const actor = actorFromPayload(payload);
  if (!actor.pin) throw new Error('ACTOR_PIN_REQUIRED');
  const paymentIds = Array.isArray(payload.paymentIds || payload.payment_ids)
    ? [...new Set((payload.paymentIds || payload.payment_ids).map((id) => normalizeDbId(id)).filter(Boolean))]
    : [];
  const mealPaymentIds = Array.isArray(payload.mealPaymentIds || payload.meal_payment_ids)
    ? [...new Set((payload.mealPaymentIds || payload.meal_payment_ids).map((id) => normalizeDbId(id)).filter(Boolean))]
    : [];
  const { data, error } = await sb.rpc('submit_cash_handoff_atomic', {
    actor_pin: actor.pin,
    actor_name: actor.name || null,
    actor_role: actor.role || null,
    payment_ids: paymentIds.length ? paymentIds : null,
    amount_declared: payload.amountDeclared != null ? money(payload.amountDeclared) : null,
    handoff_note: cleanText(payload.note, '') || null,
    idempotency_key: cleanText(payload.idempotencyKey || payload.idempotency_key, '') || null,
    meal_payment_ids: mealPaymentIds.length ? mealPaymentIds : null,
  });
  if (error) throw error;
  if (data?.ok === false) throw new Error(data?.error || data?.message || 'SUBMIT_CASH_HANDOFF_ATOMIC_FAILED');

  const verification = await verifySubmittedHandoffState(sb, {
    handoff: data?.handoff || data,
    paymentIds,
    mealPaymentIds,
  });

  return {
    ok: true,
    action: ARKA_ACTION.SUBMIT_HANDOFF,
    rpc: true,
    result: data,
    handoff: verification.handoff,
    count: Number(data?.count || verification.itemCount || verification.handoff?.count_clients || 0) || undefined,
    total: money(data?.total || verification.handoff?.amount || verification.handoff?.total_amount),
    alreadySubmitted: Boolean(data?.alreadySubmitted),
    verification: {
      handoffId: verification.handoff?.id,
      itemCount: verification.itemCount,
      itemSum: verification.itemSum,
      paymentCount: verification.paymentCount,
      mealPaymentCount: verification.mealPaymentCount,
      paymentStatuses: verification.paymentStatuses,
    },
  };
}

function payloadFlagEnabled(...values) {
  return values.some((value) => value === true || value === 1 || ['1', 'true', 'yes', 'y'].includes(String(value ?? '').trim().toLowerCase()));
}

async function submitHandoff(sb, payload = {}) {
  const actor = actorFromPayload(payload);
  if (!actor.pin) throw new Error('ACTOR_PIN_REQUIRED');

  const explicitPaymentIds = Array.isArray(payload.paymentIds || payload.payment_ids)
    ? [...new Set((payload.paymentIds || payload.payment_ids).map((id) => normalizeDbId(id)).filter(Boolean))]
    : [];
  const rpcOnly = payloadFlagEnabled(payload.rpcOnly, payload.rpc_only, payload.forceRpc, payload.force_rpc, payload.atomicRpc, payload.atomic_rpc);
  const includeUnsettledMeals = payloadFlagEnabled(payload.includeUnsettledMeals, payload.include_unsettled_meals, payload.mealDeduct, payload.meal_deduct);
  const emergencyFallback = payloadFlagEnabled(payload.allowJsHandoffFallback, payload.allow_js_handoff_fallback)
    || (typeof process !== 'undefined' && String(process?.env?.ARKA_ALLOW_JS_HANDOFF_FALLBACK || '').trim() === '1');

  const mealRows = includeUnsettledMeals || !explicitPaymentIds.length
    ? await listActorUnsettledMealPayments(sb, actor.pin, 100)
    : [];
  const mealPaymentIds = mealRows.map((row) => normalizeDbId(row.id)).filter(Boolean);
  const rpcPayload = mealPaymentIds.length
    ? { ...payload, paymentIds: explicitPaymentIds, payment_ids: explicitPaymentIds, mealPaymentIds: mealPaymentIds, meal_payment_ids: mealPaymentIds }
    : (explicitPaymentIds.length ? { ...payload, paymentIds: explicitPaymentIds, payment_ids: explicitPaymentIds } : payload);

  try {
    return await submitHandoffViaRpc(sb, rpcPayload);
  } catch (error) {
    const missingRpc = isMissingRpcFunctionError(error, 'submit_cash_handoff_atomic') || String(error?.message || '').includes('meal_payment_ids');
    if (emergencyFallback && (!rpcOnly || missingRpc)) {
      return submitHandoffFallback(sb, explicitPaymentIds.length ? { ...payload, paymentIds: explicitPaymentIds, payment_ids: explicitPaymentIds } : payload);
    }
    if (missingRpc && mealPaymentIds.length) {
      throw new Error('SUBMIT_CASH_HANDOFF_ATOMIC_MEAL_RPC_REQUIRED');
    }
    throw error;
  }
}

async function readHandoffWithItems(sb, handoffId) {
  const id = normalizeDbId(handoffId);
  if (!id) throw new Error('HANDOFF_ID_INVALID');
  const { data, error } = await sb.from(HANDOFF_TABLE).select('*, cash_handoff_items(*)').eq('id', id).maybeSingle();
  if (error) throw error;
  if (!data?.id) throw new Error('HANDOFF_NOT_FOUND');
  return { ...data, cash_handoff_items: Array.isArray(data.cash_handoff_items) ? data.cash_handoff_items : [] };
}

async function findExistingLedgerForHandoff(sb, handoffId) {
  const id = normalizeDbId(handoffId);
  if (!id) return null;
  try {
    const { data, error } = await sb.from(LEDGER_TABLE).select('*').eq('source_type', 'cash_handoff').eq('source_id', id).limit(1);
    if (error) throw error;
    if (Array.isArray(data) && data.length) return data[0];
  } catch (error) {
    if (!isMissingColumnOrFunctionError(error)) throw error;
  }
  try {
    const { data, error } = await sb.from(LEDGER_TABLE).select('*').ilike('description', `%cash_handoff:${id}%`).limit(1);
    if (error) throw error;
    if (Array.isArray(data) && data.length) return data[0];
  } catch (error) {
    if (!isMissingColumnOrFunctionError(error)) throw error;
  }
  return null;
}

async function getSummary(sb) {
  const { data, error } = await sb.from(SUMMARY_TABLE).select('*').eq('id', SUMMARY_ID).maybeSingle();
  if (error) throw error;
  if (data) return data;
  const seed = { id: SUMMARY_ID, current_balance: 0, total_in: 0, total_out: 0 };
  const { error: seedErr } = await sb.from(SUMMARY_TABLE).upsert(seed, { onConflict: 'id' });
  if (seedErr) throw seedErr;
  return seed;
}

async function computeLedgerBudgetTotals(sb) {
  const { data, error } = await sb
    .from(LEDGER_TABLE)
    .select('direction,amount')
    .range(0, 99999);
  if (error) throw error;
  const rows = Array.isArray(data) ? data : [];
  const totalIn = round2(rows.filter((row) => upper(row?.direction) === 'IN').reduce((sum, row) => sum + money(row?.amount), 0));
  const totalOut = round2(rows.filter((row) => upper(row?.direction) === 'OUT').reduce((sum, row) => sum + money(row?.amount), 0));
  return {
    total_in: totalIn,
    total_out: totalOut,
    current_balance: round2(totalIn - totalOut),
  };
}

async function recomputeCompanyBudgetSummaryFromLedger(sb) {
  const summary = await getSummary(sb);
  const totals = await computeLedgerBudgetTotals(sb);
  const patch = {
    ...totals,
    updated_at: nowIso(),
  };
  const { data, error } = await sb.from(SUMMARY_TABLE).update(patch).eq('id', SUMMARY_ID).select('*').maybeSingle();
  if (error) throw error;
  return data || { ...summary, ...patch };
}

async function updateSummaryDelta(sb, { deltaBalance = 0, deltaIn = 0, deltaOut = 0 }) {
  // The ledger is the source of truth. Older delta math could drift under
  // concurrent handoff/expense writes; always recalculate summary from ledger.
  try {
    return await recomputeCompanyBudgetSummaryFromLedger(sb);
  } catch (error) {
    // Backward-compatible fallback for schemas/RLS states where a full ledger scan
    // is temporarily unavailable. Verification code will still catch mismatches.
    const summary = await getSummary(sb);
    const patch = {
      current_balance: round2(money(summary.current_balance) + money(deltaBalance)),
      total_in: round2(money(summary.total_in) + money(deltaIn)),
      total_out: round2(money(summary.total_out) + money(deltaOut)),
      updated_at: nowIso(),
    };
    const { data, error: updateError } = await sb.from(SUMMARY_TABLE).update(patch).eq('id', SUMMARY_ID).select('*').maybeSingle();
    if (updateError) throw updateError;
    return data || { ...summary, ...patch };
  }
}

async function insertLedgerForHandoff(sb, handoff, actor, amount) {
  const existing = await findExistingLedgerForHandoff(sb, handoff.id);
  if (existing) return { ledger: existing, inserted: false };
  const workerPin = cleanText(handoff.worker_pin, '');
  const workerName = cleanText(handoff.worker_name, workerPin || 'PUNTOR');
  const description = `PRANIM NGA DISPATCH — ${workerName || workerPin} | cash_handoff:${handoff.id}`;
  const ledger = await insertRow(sb, LEDGER_TABLE, {
    direction: 'IN',
    amount,
    category: 'WORKER_TO_DISPATCH',
    description,
    source_type: 'cash_handoff',
    source_id: handoff.id,
    created_by_pin: actor.pin || null,
    created_by_name: actor.name || null,
    approved_by_pin: actor.pin || null,
    approved_by_name: actor.name || null,
    worker_pin: workerPin || null,
    worker_name: workerName || null,
  }, ledgerInsertVariants);
  await updateSummaryDelta(sb, { deltaBalance: amount, deltaIn: amount, deltaOut: 0 });
  return { ledger, inserted: true };
}

async function readLedgerRowsForHandoff(sb, handoffId) {
  const id = normalizeDbId(handoffId);
  if (!id) return [];
  const { data, error } = await sb
    .from(LEDGER_TABLE)
    .select('id,direction,amount,category,description,source_type,source_id,created_at')
    .eq('source_type', 'cash_handoff')
    .eq('source_id', id)
    .limit(5);
  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

async function verifyCompanyBudgetSummaryBalanced(sb) {
  const summary = await getSummary(sb);
  const totals = await computeLedgerBudgetTotals(sb);
  const ledgerIn = round2(totals.total_in);
  const ledgerOut = round2(totals.total_out);
  const ledgerBalance = round2(totals.current_balance);
  const summaryIn = round2(money(summary?.total_in));
  const summaryOut = round2(money(summary?.total_out));
  const summaryBalance = round2(money(summary?.current_balance));
  return {
    ledgerIn,
    ledgerOut,
    ledgerBalance,
    summaryIn,
    summaryOut,
    summaryBalance,
    diffIn: round2(summaryIn - ledgerIn),
    diffOut: round2(summaryOut - ledgerOut),
    diffBalance: round2(summaryBalance - ledgerBalance),
  };
}

async function verifyAcceptedHandoffState(sb, handoffId) {
  const id = normalizeDbId(handoffId);
  if (!id) throw new Error('HANDOFF_ID_INVALID');

  const verified = await readHandoffWithItems(sb, id);
  const status = upper(verified?.status);
  if (status !== ARKA_HANDOFF_STATUS.ACCEPTED) {
    throw new Error(`ACCEPT_VERIFY_HANDOFF_NOT_ACCEPTED:${status || 'EMPTY'}`);
  }

  const items = Array.isArray(verified?.cash_handoff_items) ? verified.cash_handoff_items : [];
  if (!items.length) throw new Error('ACCEPT_VERIFY_HANDOFF_HAS_NO_ITEMS');

  const itemSum = round2(items.reduce((sum, item) => sum + money(item?.amount), 0));
  const handoffAmount = round2(money(verified?.amount ?? verified?.total_amount));
  if (Math.abs(itemSum - handoffAmount) > 0.05) {
    throw new Error(`ACCEPT_VERIFY_ITEM_SUM_MISMATCH handoff=${handoffAmount.toFixed(2)} items=${itemSum.toFixed(2)}`);
  }

  const paymentIds = [...new Set(items.map((item) => normalizeDbId(item?.pending_payment_id)).filter(Boolean))];
  const paymentRows = paymentIds.length ? await readPaymentsByIds(sb, paymentIds) : [];
  if (paymentRows.length !== paymentIds.length) {
    throw new Error(`ACCEPT_VERIFY_PAYMENT_COUNT_MISMATCH expected=${paymentIds.length} actual=${paymentRows.length}`);
  }

  const badPayment = paymentRows.find((row) => upper(row?.status) !== ARKA_PAYMENT_STATUS.ACCEPTED_BY_DISPATCH);
  if (badPayment) {
    throw new Error(`ACCEPT_VERIFY_PAYMENT_NOT_ACCEPTED:${badPayment.id}:${upper(badPayment.status) || 'EMPTY'}`);
  }

  const ledgerRows = await readLedgerRowsForHandoff(sb, id);
  if (ledgerRows.length !== 1) {
    throw new Error(`ACCEPT_VERIFY_LEDGER_ROW_COUNT:${ledgerRows.length}`);
  }

  const ledgerAmount = round2(ledgerRows.reduce((sum, row) => sum + money(row?.amount), 0));
  if (Math.abs(ledgerAmount - handoffAmount) > 0.05) {
    throw new Error(`ACCEPT_VERIFY_LEDGER_AMOUNT_MISMATCH handoff=${handoffAmount.toFixed(2)} ledger=${ledgerAmount.toFixed(2)}`);
  }

  const summary = await verifyCompanyBudgetSummaryBalanced(sb);
  if (Math.abs(summary.diffIn) > 0.01 || Math.abs(summary.diffOut) > 0.01 || Math.abs(summary.diffBalance) > 0.01) {
    throw new Error(`ACCEPT_VERIFY_SUMMARY_DIFF in=${summary.diffIn.toFixed(2)} out=${summary.diffOut.toFixed(2)} balance=${summary.diffBalance.toFixed(2)}`);
  }

  return {
    acceptedCommitted: true,
    handoff: verified,
    handoffId: id,
    amount: handoffAmount,
    itemCount: items.length,
    itemSum,
    paymentCount: paymentRows.length,
    paymentStatuses: paymentRows.map((row) => ({ id: row.id, status: row.status, handoff_note: row.handoff_note || null, type: row.type || null })),
    ledgerCount: ledgerRows.length,
    ledgerAmount,
    ledger: ledgerRows[0] || null,
    summary,
  };
}

async function acceptHandoffViaRpc(sb, payload = {}) {
  const actor = actorFromPayload(payload);
  if (!actor.pin) throw new Error('ACTOR_PIN_REQUIRED');
  const handoffId = normalizeDbId(payload.handoffId || payload.handoff_id);
  if (!handoffId) throw new Error('HANDOFF_ID_INVALID');
  const { data, error } = await sb.rpc('accept_cash_handoff_atomic', {
    handoff_id: handoffId,
    accepted_by_pin: actor.pin || null,
    accepted_by_name: actor.name || null,
  });
  if (error) throw error;
  if (data?.ok === false) throw new Error(data?.error || data?.message || 'ACCEPT_CASH_HANDOFF_ATOMIC_FAILED');

  const verification = await verifyAcceptedHandoffState(sb, handoffId);
  return {
    ok: true,
    action: ARKA_ACTION.ACCEPT_HANDOFF,
    rpc: true,
    result: data,
    handoff: verification.handoff,
    ledger: verification.ledger,
    alreadyAccepted: Boolean(data?.alreadyAccepted),
    verification,
  };
}

async function acceptHandoffFallback(sb, payload = {}) {
  const actor = actorFromPayload(payload);
  if (!actor.pin) throw new Error('ACTOR_PIN_REQUIRED');
  const handoffId = normalizeDbId(payload.handoffId || payload.handoff_id);
  if (!handoffId) throw new Error('HANDOFF_ID_INVALID');
  const handoff = await readHandoffWithItems(sb, handoffId);
  const currentStatus = upper(handoff.status);
  if (currentStatus === ARKA_HANDOFF_STATUS.ACCEPTED) {
    const verification = await verifyAcceptedHandoffState(sb, handoff.id);
    return {
      ok: true,
      action: ARKA_ACTION.ACCEPT_HANDOFF,
      alreadyAccepted: true,
      handoff: verification.handoff,
      ledger: verification.ledger,
      verification,
    };
  }
  if (currentStatus !== ARKA_HANDOFF_STATUS.PENDING_DISPATCH_APPROVAL) throw new Error('HANDOFF_NOT_PENDING_DISPATCH_APPROVAL');

  const items = Array.isArray(handoff.cash_handoff_items) ? handoff.cash_handoff_items : [];
  if (!items.length) throw new Error('HANDOFF_HAS_NO_ITEMS');
  const paymentIds = items.map((item) => normalizeDbId(item.pending_payment_id || item.pendingPaymentId)).filter(Boolean);
  const payments = await readPaymentsByIds(sb, paymentIds);
  if (payments.length !== paymentIds.length) throw new Error('HANDOFF_PAYMENT_MISSING');

  const itemSum = round2(items.reduce((sum, item) => sum + money(item.amount), 0));
  const handoffAmount = money(handoff.amount || handoff.total_amount);
  if (Math.abs(itemSum - handoffAmount) > 0.05) throw new Error('HANDOFF_ITEM_SUM_MISMATCH');

  const { ledger, inserted } = await insertLedgerForHandoff(sb, handoff, actor, handoffAmount);
  const acceptedAt = nowIso();
  const acceptedHandoff = await updateById(sb, HANDOFF_TABLE, handoff.id, {
    amount: handoffAmount,
    total_amount: handoffAmount,
    status: ARKA_HANDOFF_STATUS.ACCEPTED,
    decided_at: acceptedAt,
    accepted_at: acceptedAt,
    dispatch_pin: actor.pin || null,
    accepted_by_pin: actor.pin || null,
    accepted_by_name: actor.name || null,
    company_ledger_entry_id: ledger?.id || null,
    updated_at: acceptedAt,
  }, handoffUpdateVariants);
  await updatePendingByIds(sb, paymentIds, {
    status: ARKA_PAYMENT_STATUS.ACCEPTED_BY_DISPATCH,
    accepted_at: acceptedAt,
    accepted_by_pin: actor.pin || null,
    accepted_by_name: actor.name || null,
    updated_at: acceptedAt,
  });

  const verification = await verifyAcceptedHandoffState(sb, handoff.id);
  return {
    ok: true,
    action: ARKA_ACTION.ACCEPT_HANDOFF,
    handoff: verification.handoff || acceptedHandoff || handoff,
    ledger: verification.ledger || ledger,
    ledgerInserted: inserted,
    verification,
  };
}

async function acceptHandoff(sb, payload = {}) {
  try {
    return await acceptHandoffViaRpc(sb, payload);
  } catch (error) {
    if (!isMissingRpcFunctionError(error, 'accept_cash_handoff_atomic')) throw error;
    return acceptHandoffFallback(sb, payload);
  }
}

async function rejectHandoff(sb, payload = {}) {
  const actor = actorFromPayload(payload);
  if (!actor.pin) throw new Error('ACTOR_PIN_REQUIRED');
  const handoffId = normalizeDbId(payload.handoffId || payload.handoff_id);
  if (!handoffId) throw new Error('HANDOFF_ID_INVALID');
  const handoff = await readHandoffWithItems(sb, handoffId);
  const currentStatus = upper(handoff.status);
  if (currentStatus !== ARKA_HANDOFF_STATUS.PENDING_DISPATCH_APPROVAL) throw new Error('HANDOFF_NOT_PENDING_DISPATCH_APPROVAL');

  const rejectedAt = nowIso();
  const rejectNote = cleanText(payload.note || payload.rejectNote || payload.reject_note, 'KTHYER TE PUNTORI');
  const rejected = await updateById(sb, HANDOFF_TABLE, handoff.id, {
    status: ARKA_HANDOFF_STATUS.REJECTED,
    decided_at: rejectedAt,
    rejected_at: rejectedAt,
    dispatch_pin: actor.pin || null,
    rejected_by_pin: actor.pin || null,
    rejected_by_name: actor.name || null,
    note: rejectNote,
    dispatch_note: rejectNote,
    updated_at: rejectedAt,
  }, handoffUpdateVariants);

  const items = Array.isArray(handoff.cash_handoff_items) ? handoff.cash_handoff_items : [];
  const baseIds = [];
  const transportIds = [];
  for (const item of items) {
    const id = normalizeDbId(item.pending_payment_id || item.pendingPaymentId);
    if (!id) continue;
    const isTransport = upper(item.source_module) === ARKA_SOURCE_MODULE.TRANSPORT || normalizeTransportCode(item.transport_code_str);
    if (isTransport) transportIds.push(id);
    else baseIds.push(id);
  }
  if (baseIds.length) {
    await updatePendingByIds(sb, baseIds, {
      status: ARKA_PAYMENT_STATUS.PENDING,
      submitted_at: null,
      handoff_note: `REFUZUAR #${handoff.id} • ${rejectNote}`,
      handed_at: null,
      handed_by_pin: null,
      handed_by_name: null,
      handed_by_role: null,
      updated_at: rejectedAt,
    });
  }
  if (transportIds.length) {
    await updatePendingByIds(sb, transportIds, {
      status: ARKA_PAYMENT_STATUS.COLLECTED,
      submitted_at: null,
      handoff_note: `REFUZUAR #${handoff.id} • ${rejectNote}`,
      handed_at: null,
      handed_by_pin: null,
      handed_by_name: null,
      handed_by_role: null,
      updated_at: rejectedAt,
    });
  }
  return { ok: true, action: ARKA_ACTION.REJECT_HANDOFF, handoff: rejected || handoff, handoffId: handoff.id };
}

async function findExistingLedgerForSource(sb, sourceType, sourceId, idempotencyKey = '', extraTags = []) {
  const cleanSourceType = cleanText(sourceType, '');
  const cleanSourceId = cleanText(sourceId, '');
  const cleanKey = cleanText(idempotencyKey, '');
  if (cleanSourceType && cleanSourceId) {
    try {
      const { data, error } = await sb.from(LEDGER_TABLE).select('*').eq('source_type', cleanSourceType).eq('source_id', cleanSourceId).limit(1);
      if (error) throw error;
      if (Array.isArray(data) && data.length) return data[0];
    } catch (error) {
      if (!isMissingColumnOrFunctionError(error)) throw error;
    }
  }
  const tags = [cleanKey ? `idempotency:${cleanKey}` : '', cleanSourceType && cleanSourceId ? `source:${cleanSourceType}:${cleanSourceId}` : '', ...(Array.isArray(extraTags) ? extraTags : [])].filter(Boolean);
  for (const tag of tags) {
    try {
      const { data, error } = await sb.from(LEDGER_TABLE).select('*').ilike('description', `%${tag}%`).limit(1);
      if (error) throw error;
      if (Array.isArray(data) && data.length) return data[0];
    } catch (error) {
      if (!isMissingColumnOrFunctionError(error)) throw error;
    }
  }
  return null;
}

async function companyBudgetSpend(sb, payload = {}) {
  const actor = actorFromPayload(payload);
  const amount = positiveMoney(payload.amount, 'AMOUNT_INVALID');
  const workerPin = normalizePin(payload.workerPin || payload.worker_pin || actor.pin);
  const workerName = cleanText(payload.workerName || payload.worker_name || actor.name, '');
  if (!actor.pin && !workerPin) throw new Error('ACTOR_PIN_REQUIRED');

  const category = cleanText(payload.category || payload.budgetCategory || payload.budget_category || 'SHPENZIM', 'SHPENZIM').toUpperCase();
  const sourceType = cleanText(payload.sourceType || payload.source_type || 'company_budget_spend', 'company_budget_spend');
  const manualClientActionId = buildManualSpendClientActionId(payload, actor, amount, category);
  const idempotencyKey = cleanText(payload.idempotencyKey || payload.idempotency_key || manualClientActionId, '');
  const rawSourceId = cleanText(payload.sourceId || payload.source_id || payload.requestId || payload.request_id || manualClientActionId, '');
  const dbSourceId = /^\d+$/.test(rawSourceId) ? rawSourceId : null;
  const tags = [
    rawSourceId ? `source:${sourceType}:${rawSourceId}` : '',
    idempotencyKey ? `idempotency:${idempotencyKey}` : '',
    manualClientActionId ? `clientAction:${manualClientActionId}` : '',
  ].filter(Boolean);
  const description = [cleanText(payload.description || payload.note, category), ...tags].filter(Boolean).join(' | ');

  const existing = await findExistingLedgerForSource(sb, sourceType, dbSourceId, idempotencyKey, tags);
  if (existing) {
    return { ok: true, action: ARKA_ACTION.COMPANY_BUDGET_SPEND, existing: true, ledger: existing, budgetReused: true };
  }

  const ledgerPayload = {
    direction: 'OUT',
    amount,
    category,
    description,
    source_type: sourceType,
    source_id: dbSourceId,
    created_by_pin: actor.pin || workerPin || null,
    created_by_name: actor.name || workerName || null,
    approved_by_pin: actor.pin || null,
    approved_by_name: actor.name || null,
    worker_pin: workerPin || null,
    worker_name: workerName || null,
  };
  const ledger = await insertRow(sb, LEDGER_TABLE, ledgerPayload, ledgerInsertVariants);
  const summary = await updateSummaryDelta(sb, { deltaBalance: -amount, deltaIn: 0, deltaOut: amount });
  return { ok: true, action: ARKA_ACTION.COMPANY_BUDGET_SPEND, ledger, summary, amount, budgetSpent: true };
}

async function findExistingSalaryPayment(sb, { monthKey, workerPin, idempotencyKey } = {}) {
  const month = cleanText(monthKey, '').slice(0, 7);
  const pin = normalizePin(workerPin);
  const key = cleanText(idempotencyKey, '');
  if (key) {
    try {
      const { data, error } = await sb
        .from(PENDING_TABLE)
        .select('*')
        .eq('idempotency_key', key)
        .eq('type', ARKA_PAYMENT_TYPE.SALARY_PAYMENT)
        .eq('status', ARKA_PAYMENT_STATUS.SALARY_PAID)
        .limit(1);
      if (error) throw error;
      if (Array.isArray(data) && data.length) return data[0];
    } catch (error) {
      if (!isMissingColumnOrFunctionError(error)) throw error;
    }
  }
  if (!month || !pin) return null;
  try {
    const { data, error } = await sb
      .from(PENDING_TABLE)
      .select('*')
      .eq('type', ARKA_PAYMENT_TYPE.SALARY_PAYMENT)
      .eq('status', ARKA_PAYMENT_STATUS.SALARY_PAID)
      .eq('created_by_pin', pin)
      .ilike('note', `%RROGA ${month}%`)
      .order('created_at', { ascending: false })
      .limit(1);
    if (error) throw error;
    return Array.isArray(data) && data.length ? data[0] : null;
  } catch (error) {
    if (!isMissingColumnOrFunctionError(error)) throw error;
    return null;
  }
}

async function collectAdvanceRowsForSalary(sb, { workerPin, workerName } = {}) {
  const pin = normalizePin(workerPin);
  const name = cleanText(workerName, '');
  const rows = [];
  const seen = new Set();
  const statuses = ['ADVANCE'];
  const push = (row) => {
    if (!row?.id || seen.has(String(row.id))) return;
    const type = upper(row?.type);
    const status = upper(row?.status);
    // Salary payment must clear only advances that were deducted from salary.
    // Generic rejected/owed debts are informational in monthly preview and must not be auto-settled here.
    if (status !== 'ADVANCE' && type !== 'ADVANCE') return;
    seen.add(String(row.id));
    rows.push(row);
  };
  const specs = [
    pin ? { field: 'created_by_pin', value: pin } : null,
    name ? { field: 'created_by_name', value: name } : null,
  ].filter(Boolean);
  for (const spec of specs) {
    try {
      const { data, error } = await sb
        .from(PENDING_TABLE)
        .select('*')
        .in('status', statuses)
        .eq(spec.field, spec.value)
        .limit(500);
      if (error) throw error;
      (Array.isArray(data) ? data : []).forEach(push);
    } catch (error) {
      if (!isMissingColumnOrFunctionError(error)) throw error;
    }
  }
  return rows;
}

async function clearManualAdvanceOnWorker(sb, { workerPin, workerId } = {}) {
  const pin = normalizePin(workerPin);
  const id = normalizeDbId(workerId);
  const patch = { avans_manual: 0, updated_at: nowIso() };
  const attempts = [];
  if (pin) attempts.push((q) => q.eq('pin', pin));
  if (id) attempts.push((q) => q.eq('id', id));
  for (const apply of attempts) {
    try {
      const { error } = await apply(sb.from('users').update(patch));
      if (!error) return true;
      if (!isMissingColumnOrFunctionError(error)) throw error;
    } catch (error) {
      if (!isMissingColumnOrFunctionError(error)) throw error;
    }
  }
  return false;
}

async function payrollSalaryPayment(sb, payload = {}) {
  const actor = actorFromPayload(payload);
  const workerPin = normalizePin(pick(payload.workerPin, payload.worker_pin, payload.targetPin));
  const workerName = cleanText(pick(payload.workerName, payload.worker_name, payload.targetName), 'PUNËTOR');
  const workerId = normalizeDbId(pick(payload.workerId, payload.worker_id, payload.userId, payload.user_id));
  const monthKey = cleanText(payload.monthKey || payload.month_key, '').slice(0, 7);
  const amount = money(payload.amount);
  const baseSalary = money(payload.baseSalary || payload.base_salary);
  const advanceAmount = money(payload.advanceAmount || payload.advance_amount);
  const manualAdvanceAmount = money(payload.manualAdvanceAmount || payload.manual_advance_amount);
  const autoAdvanceAmount = money(payload.autoAdvanceAmount || payload.auto_advance_amount);
  if (!actor.pin) throw new Error('ACTOR_PIN_REQUIRED');
  if (!workerPin) throw new Error('WORKER_PIN_REQUIRED');
  if (!/^\d{4}-\d{2}$/.test(monthKey)) throw new Error('MONTH_KEY_INVALID');
  if (!Number.isFinite(amount) || amount < 0) throw new Error('AMOUNT_INVALID');

  const idempotencyKey = cleanText(payload.idempotencyKey || payload.idempotency_key || buildSalaryPaymentIdempotencyKey({ monthKey, workerPin }), '');
  return withRuntimeLock(`salary_payment:${monthKey}:${workerPin}`, async () => {
    const existing = await findExistingSalaryPayment(sb, { monthKey, workerPin, idempotencyKey });
    if (existing) return { ok: true, action: ARKA_ACTION.PAYROLL_SALARY_PAYMENT, existing: true, duplicate: true, salaryPayment: existing, row: existing };

    let budget = null;
    if (amount > 0) {
      budget = await companyBudgetSpend(sb, {
        actorPin: actor.pin,
        actorName: actor.name,
        actorRole: actor.role,
        workerPin,
        workerName,
        amount,
        category: 'SALARY',
        sourceType: 'salary_payment',
        sourceId: `${monthKey}:${workerPin}`,
        idempotencyKey,
        note: `RROGA ${monthKey} • ${workerName} • NET ${idempotentMoneyKey(amount)}€ • AVANS ${idempotentMoneyKey(advanceAmount)}€`,
      });
    }

    const createdAt = nowIso();
    const markerNote = [
      `RROGA ${monthKey}`,
      workerName ? `PUNËTORI ${workerName}` : '',
      workerPin ? `PIN ${workerPin}` : '',
      `NET ${idempotentMoneyKey(amount)}€`,
      `BAZË ${idempotentMoneyKey(baseSalary)}€`,
      `AVANS ${idempotentMoneyKey(advanceAmount)}€`,
      idempotencyKey ? `idempotency:${idempotencyKey}` : '',
    ].filter(Boolean).join(' • ');

    const salaryPayment = await insertRow(sb, PENDING_TABLE, {
      idempotency_key: idempotencyKey || null,
      status: ARKA_PAYMENT_STATUS.SALARY_PAID,
      amount: round2(amount),
      type: ARKA_PAYMENT_TYPE.SALARY_PAYMENT,
      source_module: ARKA_SOURCE_MODULE.ARKA,
      method: 'CASH',
      note: markerNote,
      handoff_note: `SALARY_PAID:${monthKey}:${workerPin}`,
      created_by_pin: workerPin,
      created_by_name: workerName,
      created_by_role: 'WORKER',
      handed_at: createdAt,
      handed_by_pin: actor.pin,
      handed_by_name: actor.name || null,
      handed_by_role: actor.role || null,
      approved_at: createdAt,
      approved_by_pin: actor.pin,
      approved_by_name: actor.name || null,
      created_at: createdAt,
      updated_at: createdAt,
    }, pendingInsertVariants);

    const advanceRows = await collectAdvanceRowsForSalary(sb, { workerPin, workerName });
    if (advanceRows.length) {
      await updatePendingByIds(sb, advanceRows.map((row) => row.id), {
        status: ARKA_PAYMENT_STATUS.SETTLED_IN_SALARY,
        approved_at: createdAt,
        approved_by_pin: actor.pin,
        approved_by_name: actor.name || null,
        updated_at: createdAt,
        handoff_note: `SETTLED_IN_SALARY:${monthKey}:${workerPin}`,
      });
    }
    if (manualAdvanceAmount > 0) await clearManualAdvanceOnWorker(sb, { workerPin, workerId });

    return {
      ok: true,
      action: ARKA_ACTION.PAYROLL_SALARY_PAYMENT,
      salaryPayment,
      row: salaryPayment,
      ledger: budget?.ledger || null,
      summary: budget?.summary || null,
      amount,
      monthKey,
      workerPin,
      advancesSettled: advanceRows.length,
      autoAdvanceAmount,
      manualAdvanceAmount,
    };
  });
}


async function findExistingVoidAuditForPayment(sb, paymentId, idempotencyKey = '') {
  const tag = `VOID_AUDIT_OF:${paymentId}`;
  const key = cleanText(idempotencyKey, '');
  const attempts = [];
  if (key) attempts.push({ column: 'idempotency_key', value: key, mode: 'eq' });
  attempts.push({ column: 'handoff_note', value: tag, mode: 'eq' });
  attempts.push({ column: 'note', value: tag, mode: 'ilike' });

  for (const attempt of attempts) {
    try {
      let q = sb.from(PENDING_TABLE).select('*').eq('status', ARKA_PAYMENT_STATUS.VOIDED).limit(1);
      if (attempt.mode === 'ilike') q = q.ilike(attempt.column, `%${attempt.value}%`);
      else q = q.eq(attempt.column, attempt.value);
      const { data, error } = await q;
      if (error) throw error;
      if (Array.isArray(data) && data.length) return data[0];
    } catch (error) {
      if (!isMissingColumnOrFunctionError(error)) throw error;
    }
  }
  return null;
}

async function voidOrReversePayment(sb, payload = {}) {
  const actor = actorFromPayload(payload);
  const paymentId = normalizeDbId(payload.paymentId || payload.payment_id || payload.rowId || payload.row_id);
  if (!paymentId) throw new Error('PAYMENT_ID_INVALID');
  if (!actor.pin) throw new Error('ACTOR_PIN_REQUIRED');
  const { data: row, error } = await sb.from(PENDING_TABLE).select('*').eq('id', paymentId).maybeSingle();
  if (error) throw error;
  if (!row?.id) throw new Error('PAYMENT_NOT_FOUND');
  const status = normalizeLegacyArkaStatus(row.status);
  const linkedToActiveHandoff = await paymentHasActiveHandoff(sb, paymentId);
  if (status === ARKA_PAYMENT_STATUS.PENDING && !linkedToActiveHandoff) {
    const { error: delErr } = await sb.from(PENDING_TABLE).delete().eq('id', paymentId).eq('status', ARKA_PAYMENT_STATUS.PENDING);
    if (delErr) throw delErr;
    return { ok: true, action: ARKA_ACTION.VOID_OR_REVERSE_PAYMENT, deleted: true, paymentId };
  }
  const createdAt = nowIso();
  const voidTag = `VOID_AUDIT_OF:${paymentId}`;
  const voidIdempotencyKey = cleanText(payload.idempotencyKey || payload.idempotency_key, '') || `${ARKA_ACTION.VOID_OR_REVERSE_PAYMENT}:${paymentId}`;
  const existingVoid = await findExistingVoidAuditForPayment(sb, paymentId, voidIdempotencyKey);
  if (existingVoid) {
    return { ok: true, action: ARKA_ACTION.VOID_OR_REVERSE_PAYMENT, alreadyVoided: true, auditOnly: true, budgetReversed: false, original: row, auditRow: existingVoid };
  }
  const noteBase = cleanText(payload.note, `VOID AUDIT ROW FOR PAYMENT #${paymentId}`);
  const auditRow = await insertRow(sb, PENDING_TABLE, {
    idempotency_key: voidIdempotencyKey,
    amount: -Math.abs(money(row.amount)),
    type: row.type || ARKA_PAYMENT_TYPE.EXPENSE,
    status: ARKA_PAYMENT_STATUS.VOIDED,
    note: noteBase.includes(voidTag) ? noteBase : `${noteBase} | ${voidTag}`,
    source_module: row.source_module || ARKA_SOURCE_MODULE.ARKA,
    order_id: row.order_id || null,
    order_code: row.order_code || null,
    transport_order_id: row.transport_order_id || null,
    transport_code_str: row.transport_code_str || null,
    transport_m2: row.transport_m2 || 0,
    client_name: row.client_name || null,
    client_phone: row.client_phone || null,
    created_by_pin: row.created_by_pin || null,
    created_by_name: row.created_by_name || null,
    approved_by_pin: actor.pin || null,
    approved_by_name: actor.name || null,
    handoff_note: `VOID_AUDIT_OF:${paymentId}`,
    created_at: createdAt,
    updated_at: createdAt,
  }, pendingInsertVariants);
  return { ok: true, action: ARKA_ACTION.VOID_OR_REVERSE_PAYMENT, auditOnly: true, budgetReversed: false, original: row, auditRow };
}

export async function runArkaAuditReport(options = {}) {
  const sb = await getSupabaseOrThrow(options);
  const out = {};
  const read = async (key, runner) => {
    try { out[key] = await runner(); } catch (error) { out[key] = { error: String(error?.message || error) }; }
  };

  await read('accepted_handoff_with_non_accepted_payments', async () => {
    const { data, error } = await sb
      .from(HANDOFF_TABLE)
      .select('id,status,cash_handoff_items(pending_payment_id)')
      .eq('status', ARKA_HANDOFF_STATUS.ACCEPTED)
      .limit(500);
    if (error) throw error;
    const handoffRows = Array.isArray(data) ? data : [];
    const ids = handoffRows.flatMap((h) => (h.cash_handoff_items || []).map((i) => normalizeDbId(i.pending_payment_id)).filter(Boolean));
    const payments = ids.length ? await readPaymentsByIds(sb, ids) : [];
    const byId = new Map(payments.map((p) => [String(p.id), p]));
    return handoffRows.flatMap((h) => (h.cash_handoff_items || [])
      .map((i) => byId.get(String(i.pending_payment_id)))
      .filter((p) => p && normalizeLegacyArkaStatus(p.status) !== ARKA_PAYMENT_STATUS.ACCEPTED_BY_DISPATCH)
      .map((p) => ({ handoff_id: h.id, payment_id: p.id, payment_status: p.status })));
  });

  await read('pending_dispatch_payment_without_valid_handoff', async () => {
    const { data, error } = await sb.from(PENDING_TABLE).select('id,status').eq('status', ARKA_PAYMENT_STATUS.PENDING_DISPATCH_APPROVAL).limit(1000);
    if (error) throw error;
    const rows = Array.isArray(data) ? data : [];
    const ids = rows.map((row) => normalizeDbId(row.id)).filter(Boolean);
    if (!ids.length) return [];
    const linked = await findPaymentIdsInActiveHandoffs(sb, ids, [ARKA_HANDOFF_STATUS.PENDING_DISPATCH_APPROVAL]);
    return rows.filter((p) => !linked.has(normalizeDbId(p.id)));
  });

  await read('duplicate_ledger_per_handoff', async () => {
    const { data, error } = await sb.from(LEDGER_TABLE).select('id,amount,source_id,source_type').eq('source_type', 'cash_handoff').limit(2000);
    if (error) throw error;
    const groups = new Map();
    for (const row of data || []) {
      const key = String(row.source_id || '');
      if (!key) continue;
      const g = groups.get(key) || { source_id: key, nr_rows: 0, total: 0, rows: [] };
      g.nr_rows += 1;
      g.total = round2(g.total + money(row.amount));
      g.rows.push(row.id);
      groups.set(key, g);
    }
    return [...groups.values()].filter((g) => g.nr_rows > 1);
  });

  await read('paid_order_still_active', async () => {
    const { data, error } = await sb.from('orders').select('id,code,client_name,status,price_total,data').in('status', ['pastrim', 'gati']).limit(1000);
    if (error) throw error;
    return (data || []).filter((o) => {
      const d = asObject(o.data);
      const pay = asObject(d.pay);
      const total = money(pick(pay.euro, o.price_total, 0));
      const paid = Math.max(money(pay.paid), money(pay.arkaRecordedPaid));
      return total - paid <= 0.01;
    });
  });

  await read('arka_payment_accepted_but_order_active', async () => {
    const { data, error } = await sb.from(PENDING_TABLE).select('id,amount,status,order_id,type,source_module').eq('type', ARKA_PAYMENT_TYPE.IN).eq('source_module', ARKA_SOURCE_MODULE.BASE).in('status', ARKA_ACTIVE_PAYMENT_STATUSES).limit(1000);
    if (error) throw error;
    const ids = [...new Set((data || []).map((p) => normalizeDbId(p.order_id)).filter(Boolean))];
    const { data: orders, error: oErr } = ids.length ? await sb.from('orders').select('id,code,client_name,status,price_total').in('id', ids) : { data: [], error: null };
    if (oErr) throw oErr;
    const byId = new Map((orders || []).map((o) => [String(o.id), o]));
    return (data || []).map((p) => ({ payment: p, order: byId.get(String(p.order_id)) })).filter(({ order }) => ['pastrim', 'gati'].includes(String(order?.status || '').toLowerCase()));
  });

  return { ok: true, report: out };
}

export async function runArkaTransaction(payload = {}, options = {}) {
  const action = upper(payload.action);
  if (!Object.values(ARKA_ACTION).includes(action)) throw new Error('ARKA_ACTION_INVALID');
  const sb = await getSupabaseOrThrow(options);
  const verifiedActor = await assertActorAllowed(sb, payload, action);
  const guardedPayload = withVerifiedActor(payload, verifiedActor);

  switch (action) {
    case ARKA_ACTION.BASE_ORDER_PAYMENT:
      return baseOrderPayment(sb, guardedPayload);
    case ARKA_ACTION.TRANSPORT_ORDER_PAYMENT:
      return transportOrderPayment(sb, guardedPayload);
    case ARKA_ACTION.EXPENSE_REQUEST:
      return expenseRequest(sb, guardedPayload);
    case ARKA_ACTION.CREATE_MEAL_DISTRIBUTION:
      return createMealDistributionAtomic(sb, guardedPayload);
    case ARKA_ACTION.COMPANY_BUDGET_SPEND:
      return companyBudgetSpend(sb, guardedPayload);
    case ARKA_ACTION.PAYROLL_SALARY_PAYMENT:
      return payrollSalaryPayment(sb, guardedPayload);
    case ARKA_ACTION.SUBMIT_HANDOFF: {
      const submitActor = actorFromPayload(guardedPayload);
      const submitPaymentIds = Array.isArray(guardedPayload.paymentIds || guardedPayload.payment_ids)
        ? [...new Set((guardedPayload.paymentIds || guardedPayload.payment_ids).map((id) => normalizeDbId(id)).filter(Boolean))]
        : [];
      const submitLockKey = `submit_handoff:${submitActor.pin || 'NO_PIN'}:${submitPaymentIds.length ? submitPaymentIds.join('-') : 'AUTO'}`;
      return withRuntimeLock(submitLockKey, () => submitHandoff(sb, guardedPayload));
    }
    case ARKA_ACTION.ACCEPT_HANDOFF:
      return acceptHandoff(sb, guardedPayload);
    case ARKA_ACTION.REJECT_HANDOFF:
      return rejectHandoff(sb, guardedPayload);
    case ARKA_ACTION.VOID_OR_REVERSE_PAYMENT:
      return voidOrReversePayment(sb, guardedPayload);
    default:
      throw new Error('ARKA_ACTION_NOT_IMPLEMENTED');
  }
}

export default runArkaTransaction;
