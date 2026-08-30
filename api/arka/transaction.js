import { apiFail, apiOk, createAdminClientOrThrow, readBody } from '../_helpers.js';
import { runArkaTransaction } from '../../lib/arka/arkaEngine.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PRIVILEGED_ROLES = new Set(['DISPATCH', 'ADMIN', 'ADMIN_MASTER', 'OWNER', 'PRONAR', 'SUPERADMIN']);
const TRANSPORT_LEDGER_STATUSES = new Set([
  'loaded', 'ngarkuar', 'ngarkim',
  'delivery', 'dorzim', 'dorezim', 'dorëzim',
  'done', 'completed', 'delivered', 'dorzuar', 'dorezuar', 'dorëzuar',
]);

function cleanUuid(value) {
  const clean = String(value || '').trim();
  return UUID_RE.test(clean) ? clean : '';
}

function cleanPin(value) {
  return String(value || '').replace(/\D/g, '').slice(0, 12);
}

function setPrivateNoStore(res) {
  res.setHeader('cache-control', 'private, no-store, max-age=0, must-revalidate');
  res.setHeader('pragma', 'no-cache');
  res.setHeader('expires', '0');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('vary', 'Cookie');
}

function readCookie(req, name) {
  const raw = String(req?.headers?.cookie || '');
  const prefix = String(name || '') + '=';
  for (const part of raw.split(';')) {
    const value = part.trim();
    if (!value.startsWith(prefix)) continue;
    try { return decodeURIComponent(value.slice(prefix.length)); } catch { return ''; }
  }
  return '';
}

function requestOriginAllowed(req) {
  const origin = String(req?.headers?.origin || '').trim();
  if (!origin) return true;
  const forwardedHost = String(req?.headers?.['x-forwarded-host'] || req?.headers?.host || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  if (!forwardedHost) return false;
  try {
    const parsed = new URL(origin);
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:')
      && parsed.host.toLowerCase() === forwardedHost;
  } catch {
    return false;
  }
}

function serverError(code) {
  const error = new Error(code);
  error.httpStatus = 500;
  return error;
}

const SAFE_ERROR_CODE_RE = /^[A-Z][A-Z0-9_À-Ž-]{2,}$/;

export function safeError(error) {
  const message = String(error?.message || error || '').trim();
  if (SAFE_ERROR_CODE_RE.test(message)) return message;

  // PostgreSQL RAISE messages may append private diagnostics after a stable
  // domain code (for example `BASE_CLIENT_PAYMENT_STALE_DEBT expected=...`).
  // Return only that leading code so clients can reconcile terminal failures
  // without exposing the diagnostic payload.
  const leadingCode = message.match(/^([A-Z][A-Z0-9_À-Ž-]{2,})(?=$|[\s:])/u)?.[1] || '';
  if (SAFE_ERROR_CODE_RE.test(leadingCode)) return leadingCode;

  const errorCode = String(error?.code || '').trim().toUpperCase();
  return SAFE_ERROR_CODE_RE.test(errorCode) ? errorCode : 'ARKA_TRANSACTION_FAILED';
}

function cleanBaseOrderId(value) {
  const id = String(value ?? '').trim();
  return /^\d+$/.test(id) && !/^0+$/.test(id) ? id : '';
}

function moneyCents(value) {
  if (value === '' || value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : null;
}

function cleanText(value) {
  return String(value ?? '').trim();
}

function normalizeExpectedDebts(value) {
  let source = value;
  if (typeof source === 'string') {
    try { source = JSON.parse(source); } catch { return null; }
  }
  if (!Array.isArray(source) || source.length === 0) return null;

  const seen = new Set();
  const rows = [];
  for (const item of source) {
    const orderId = cleanBaseOrderId(item?.orderId ?? item?.order_id ?? item?.id);
    const debtCents = moneyCents(item?.debt ?? item?.expectedDebt ?? item?.expected_debt);
    if (!orderId || debtCents == null || debtCents <= 0 || seen.has(orderId)) return null;
    seen.add(orderId);
    rows.push({ orderId, debtCents });
  }
  rows.sort((a, b) => a.orderId.length - b.orderId.length || a.orderId.localeCompare(b.orderId));
  return rows;
}

function sameExpectedDebts(left, right) {
  const a = normalizeExpectedDebts(left);
  const b = normalizeExpectedDebts(right);
  if (!a || !b || a.length !== b.length) return false;
  return a.every((item, index) => (
    item.orderId === b[index].orderId
    && item.debtCents === b[index].debtCents
  ));
}

export function isExactCommittedBaseBatchRetry(bodyLike = {}, batchLike = {}) {
  const body = bodyLike && typeof bodyLike === 'object' ? bodyLike : {};
  const batch = batchLike && typeof batchLike === 'object' ? batchLike : {};
  const action = cleanText(body.action).toUpperCase();
  if (action !== 'BASE_ORDER_PAYMENT') return false;
  if (cleanText(batch.status).toUpperCase() !== 'CONFIRMED') return false;

  const idempotencyKey = cleanText(body.idempotencyKey || body.idempotency_key);
  const actorPin = cleanPin(
    body.actorPin
    || body.actor_pin
    || body.created_by_pin
    || body.createdByPin
    || body.actor?.pin
    || body.user?.pin
  );
  const orderId = cleanBaseOrderId(body.orderId ?? body.order_id);
  const clientId = cleanUuid(body.clientId || body.client_id).toLowerCase();
  const amountCents = moneyCents(body.amount);
  const expectedDebtCents = moneyCents(body.expectedDebt ?? body.expected_debt);
  const cashGivenCents = moneyCents(body.cashGiven ?? body.cash_given ?? body.amount);
  const changeCents = moneyCents(
    body.changeAmount
    ?? body.change_amount
    ?? ((cashGivenCents != null && amountCents != null) ? (cashGivenCents - amountCents) / 100 : null)
  );
  const linkedDebts = body.linkedDebts || body.linked_debts;
  const outcome = cleanText(body.paymentOutcome || body.payment_outcome).toUpperCase();
  const fullStatus = cleanText(
    body.statusOnFullPayment
    || body.status_on_full_payment
    || body.fullPaymentStatus
    || body.full_payment_status
  ).toLowerCase();
  const expectedFullStatus = outcome === 'PREPAY_STAYS_PASTRIMI'
    ? 'pastrim'
    : (outcome === 'CLIENT_PICKED_UP_TO_DORZIM' ? 'dorzim' : '');
  const method = cleanText(body.method || 'CASH').toUpperCase();

  if (
    !idempotencyKey
    || !actorPin
    || !orderId
    || !clientId
    || amountCents == null
    || amountCents <= 0
    || expectedDebtCents == null
    || expectedDebtCents <= 0
    || cashGivenCents == null
    || cashGivenCents < amountCents
    || changeCents == null
    || changeCents < 0
    || !expectedFullStatus
    || fullStatus !== expectedFullStatus
    || method !== 'CASH'
    || !sameExpectedDebts(linkedDebts, batch.expected_order_debts)
  ) return false;

  return (
    idempotencyKey === cleanText(batch.idempotency_key)
    && actorPin === cleanPin(batch.created_by_pin)
    && orderId === cleanBaseOrderId(batch.anchor_order_id)
    && clientId === cleanUuid(batch.client_id).toLowerCase()
    && amountCents === moneyCents(batch.amount_applied)
    && cashGivenCents === moneyCents(batch.amount_given)
    && changeCents === moneyCents(batch.change_amount)
    && expectedDebtCents === moneyCents(batch.expected_total_debt)
    && outcome === cleanText(batch.payment_outcome).toUpperCase()
    && cleanText(body.note) === cleanText(batch.note)
  );
}

export async function authorizeCommittedBaseBatchRetry(supabase, body, { deviceApproved = false } = {}) {
  if (!deviceApproved || cleanText(body?.action).toUpperCase() !== 'BASE_ORDER_PAYMENT') return null;
  const idempotencyKey = cleanText(body?.idempotencyKey || body?.idempotency_key);
  if (!idempotencyKey || idempotencyKey.length > 240) return null;

  const { data: batch, error } = await supabase
    .from('base_payment_batches')
    .select('id,client_id,anchor_order_id,amount_given,amount_applied,change_amount,expected_total_debt,expected_order_debts,payment_outcome,status,created_by_pin,created_by_name,created_by_role,note,idempotency_key')
    .eq('idempotency_key', idempotencyKey)
    .maybeSingle();
  if (error || !batch || !isExactCommittedBaseBatchRetry(body, batch)) return null;

  return {
    batchId: batch.id,
    actor: {
      pin: cleanPin(batch.created_by_pin),
      name: cleanText(batch.created_by_name),
      role: cleanText(batch.created_by_role).toUpperCase(),
    },
  };
}

async function authenticateDevice(supabase, req) {
  const deviceId = String(readCookie(req, 'tepiha_device_id') || '').trim().slice(0, 120);
  if (!deviceId) return { ok: false, error: 'AUTH_REQUIRED', status: 401 };

  const { data: device, error: deviceError } = await supabase
    .from('tepiha_user_devices')
    .select('user_id,is_approved')
    .eq('device_id', deviceId)
    .maybeSingle();
  if (deviceError) throw serverError('AUTH_DEVICE_LOOKUP_FAILED');
  if (!device?.user_id || device.is_approved !== true) {
    return { ok: false, error: 'DEVICE_NOT_APPROVED', status: 403 };
  }

  const { data: user, error: userError } = await supabase
    .from('users')
    .select('id,pin,name,role,is_active,is_hybrid_transport,transport_id,tid')
    .eq('id', device.user_id)
    .maybeSingle();
  if (userError) throw serverError('AUTH_USER_LOOKUP_FAILED');
  if (!user || user.is_active === false || !cleanPin(user.pin)) {
    return { ok: false, error: 'AUTH_USER_DISABLED', status: 403, deviceApproved: true };
  }

  return {
    ok: true,
    deviceApproved: true,
    user: {
      ...user,
      pin: cleanPin(user.pin),
      role: String(user.role || '').trim().toUpperCase(),
    },
  };
}

function actorAssignmentKeys(actor) {
  return new Set([
    actor?.id,
    actor?.pin,
    actor?.transport_id,
    actor?.tid,
  ].map((value) => String(value || '').trim()).filter(Boolean));
}

function orderAssignedToActor(order, actor) {
  if (PRIVILEGED_ROLES.has(actor?.role)) return true;
  const data = order?.data && typeof order.data === 'object' ? order.data : {};
  const keys = actorAssignmentKeys(actor);
  const canonicalAssignment = String(order?.transport_id || '').trim();
  if (canonicalAssignment) return keys.has(canonicalAssignment);

  return [
    data.transport_id,
    data.transport_user_id,
    data.transport_pin,
    data.driver_id,
    data.driver_pin,
    data.assigned_driver_id,
    data.assigned_to_pin,
  ].map((value) => String(value || '').trim()).filter(Boolean)
    .some((value) => keys.has(value));
}

async function authorizeLegacyTransportPayment(supabase, body, actor) {
  const orderId = cleanUuid(body?.transportOrderId || body?.transport_order_id);
  if (!orderId) return { ok: false, error: 'TRANSPORT_ORDER_ID_INVALID', status: 400 };

  const { data: order, error: orderError } = await supabase
    .from('transport_orders')
    .select('id,status,transport_id,data')
    .eq('id', orderId)
    .maybeSingle();
  if (orderError) throw serverError('AUTH_ORDER_LOOKUP_FAILED');
  if (!order) return { ok: false, error: 'TRANSPORT_ORDER_NOT_FOUND', status: 404 };
  if (!orderAssignedToActor(order, actor)) {
    return { ok: false, error: 'ORDER_NOT_ASSIGNED_TO_ACTOR', status: 403 };
  }

  const status = String(order.status || order?.data?.status || '').trim().toLowerCase();
  const { data: ledgerRows, error: ledgerError } = await supabase
    .from('transport_receivables')
    .select('id')
    .eq('transport_order_id', orderId)
    .limit(1);
  if (ledgerError) throw serverError('TRANSPORT_RECEIVABLE_LOOKUP_FAILED');

  if (TRANSPORT_LEDGER_STATUSES.has(status) || (ledgerRows || []).length > 0) {
    return {
      ok: false,
      error: 'TRANSPORT_RECEIVABLE_PAYMENT_REQUIRED',
      status: 409,
    };
  }
  return { ok: true };
}

export default async function handler(req, res) {
  setPrivateNoStore(res);
  try {
    if (req.method && req.method !== 'POST') return apiFail(res, 'METHOD_NOT_ALLOWED', 405);
    if (!requestOriginAllowed(req)) return apiFail(res, 'ORIGIN_NOT_ALLOWED', 403);

    const body = typeof readBody === 'function' ? await readBody(req) : (req.body || {});
    const supabase = createAdminClientOrThrow();
    const auth = await authenticateDevice(supabase, req);
    const requestedActorPin = cleanPin(
      body?.actorPin
      || body?.actor_pin
      || body?.created_by_pin
      || body?.createdByPin
      || body?.actor?.pin
      || body?.user?.pin
    );
    const action = String(body?.action || '').trim().toUpperCase();
    const sessionMismatch = Boolean(auth.ok && requestedActorPin && requestedActorPin !== auth.user.pin);
    let committedRetry = null;
    if (auth.deviceApproved && (!auth.ok || sessionMismatch)) {
      committedRetry = await authorizeCommittedBaseBatchRetry(supabase, body, {
        deviceApproved: auth.deviceApproved === true,
      });
    }
    if (!auth.ok && !committedRetry) return apiFail(res, auth.error, auth.status);
    if (sessionMismatch && !committedRetry) return apiFail(res, 'ACTOR_SESSION_MISMATCH', 403);

    const authorizedActor = committedRetry?.actor || auth.user;
    if (action === 'TRANSPORT_ORDER_PAYMENT') {
      const access = await authorizeLegacyTransportPayment(supabase, body, authorizedActor);
      if (!access.ok) return apiFail(res, access.error, access.status);
      // Transport cash writes are ledger-only. Returning here (before the
      // legacy engine) removes the check-then-write race with delivery/FIFO.
      return apiFail(res, 'TRANSPORT_RECEIVABLE_PAYMENT_REQUIRED', 409);
    }

    const guardedBody = {
      ...(body || {}),
      actorPin: authorizedActor.pin,
      actorName: String(authorizedActor.name || ''),
      actorRole: String(authorizedActor.role || ''),
    };
    const result = await runArkaTransaction(guardedBody, { supabase });
    return apiOk(res, result || {});
  } catch (error) {
    console.error('[arka-transaction]', {
      code: String(error?.code || ''),
      message: String(error?.message || error || 'UNKNOWN_ERROR').slice(0, 300),
    });
    return apiFail(res, safeError(error), Number(error?.httpStatus) || 500);
  }
}
