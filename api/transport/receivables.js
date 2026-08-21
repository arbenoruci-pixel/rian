import { apiFail, apiOk, createAdminClientOrThrow, readBody } from '../_helpers.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ALLOWED_ROLES = new Set(['TRANSPORT', 'DISPATCH', 'ADMIN', 'ADMIN_MASTER', 'OWNER', 'PRONAR', 'SUPERADMIN']);
const PRIVILEGED_ROLES = new Set(['DISPATCH', 'ADMIN', 'ADMIN_MASTER', 'OWNER', 'PRONAR', 'SUPERADMIN']);

function cleanUuid(value) {
  const clean = String(value || '').trim();
  return UUID_RE.test(clean) ? clean : '';
}

function cleanKey(value) {
  return String(value || '').trim().slice(0, 240);
}

function cleanPin(value) {
  return String(value || '').replace(/\D/g, '').slice(0, 12);
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
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

function safeReceivableRow(row) {
  if (!row || typeof row !== 'object') return null;
  return {
    id: String(row.id || ''),
    transport_order_id: String(row.transport_order_id || row.transportOrderId || ''),
    original_amount: numberOrZero(row.original_amount ?? row.originalAmount),
    opening_paid_amount: numberOrZero(row.opening_paid_amount ?? row.openingPaidAmount),
    outstanding_amount: numberOrZero(row.outstanding_amount ?? row.outstandingAmount),
    status: String(row.status || ''),
    due_date: row.due_date || row.dueDate || null,
    delivered_at: row.delivered_at || row.deliveredAt || null,
  };
}

function safeReceivableSummaryRow(row) {
  const safe = safeReceivableRow(row);
  if (!safe) return null;
  return {
    id: safe.id,
    transportOrderId: safe.transport_order_id,
    clientTcode: String(row?.clientTcode || row?.client_tcode || ''),
    originalAmount: safe.original_amount,
    openingPaidAmount: safe.opening_paid_amount,
    outstandingAmount: safe.outstanding_amount,
    status: safe.status,
    dueDate: safe.due_date,
    deliveredAt: safe.delivered_at,
  };
}

function safeOrder(row) {
  if (!row || typeof row !== 'object') return null;
  const data = row.data && typeof row.data === 'object' ? row.data : {};
  const pay = data.pay && typeof data.pay === 'object' ? data.pay : {};
  return {
    id: String(row.id || ''),
    status: String(row.status || data.status || ''),
    data: {
      status: String(data.status || row.status || ''),
      state: String(data.state || ''),
      pay: {
        euro: numberOrZero(pay.euro),
        paid: numberOrZero(pay.paid),
        arkaRecordedPaid: numberOrZero(pay.arkaRecordedPaid),
        debt: numberOrZero(pay.debt),
        method: String(pay.method || ''),
        last_paid_at: pay.last_paid_at || null,
      },
      clientPaid: numberOrZero(data.clientPaid),
      paid: numberOrZero(data.paid),
      debt: numberOrZero(data.debt),
      isPaid: data.isPaid === true,
      paid_done: data.paid_done === true,
      payment_state: String(data.payment_state || ''),
      delivery_payment_status: String(data.delivery_payment_status || ''),
    },
  };
}

function safeBatch(row) {
  if (!row || typeof row !== 'object') return null;
  return {
    id: String(row.id || ''),
    amount_received: numberOrZero(row.amount_received),
    amount_applied: numberOrZero(row.amount_applied),
    change_amount: numberOrZero(row.change_amount),
    method: String(row.method || ''),
    status: String(row.status || ''),
  };
}

function sanitizeRpcResult(result) {
  const source = result && typeof result === 'object' ? result : {};
  const output = {
    previousOutstanding: numberOrZero(source.previousOutstanding),
    currentOrderDue: numberOrZero(source.currentOrderDue),
    ledgerOutstanding: numberOrZero(source.ledgerOutstanding),
    totalForPayment: numberOrZero(source.totalForPayment),
    effectivePaid: numberOrZero(source.effectivePaid),
    requiresReconciliation: source.requiresReconciliation === true,
    currentReceivable: safeReceivableSummaryRow(source.currentReceivable),
    receivables: (Array.isArray(source.receivables) ? source.receivables : [])
      .map(safeReceivableSummaryRow)
      .filter(Boolean),
  };

  if (Object.prototype.hasOwnProperty.call(source, 'duplicate')) output.duplicate = source.duplicate === true;
  if (Object.prototype.hasOwnProperty.call(source, 'paymentVerified')) output.paymentVerified = source.paymentVerified === true;
  if (source.receivable) output.receivable = safeReceivableRow(source.receivable);
  if (source.batch) output.batch = safeBatch(source.batch);
  if (source.order) output.order = safeOrder(source.order);
  return output;
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
  const role = String(user?.role || '').trim().toUpperCase();
  if (!user || user.is_active === false || !cleanPin(user.pin)) {
    return { ok: false, error: 'AUTH_USER_DISABLED', status: 403 };
  }
  const hybridTransportWorker = role === 'PUNTOR' && user.is_hybrid_transport === true;
  if (!ALLOWED_ROLES.has(role) && !hybridTransportWorker) {
    return { ok: false, error: 'ROLE_NOT_ALLOWED', status: 403 };
  }

  return { ok: true, user: { ...user, pin: cleanPin(user.pin), role } };
}

function actorAssignmentKeys(actor) {
  return new Set([
    actor?.id,
    actor?.pin,
    actor?.transport_id,
    actor?.tid,
  ].map((value) => String(value || '').trim()).filter(Boolean));
}

function orderClientId(order) {
  const data = order?.data && typeof order.data === 'object' ? order.data : {};
  return cleanUuid(order?.client_id || data?.client_id || data?.client?.id);
}

function orderAssignedToActor(order, actor) {
  if (PRIVILEGED_ROLES.has(actor.role)) return true;
  const data = order?.data && typeof order.data === 'object' ? order.data : {};
  const keys = actorAssignmentKeys(actor);
  const canonicalAssignment = String(order?.transport_id || '').trim();
  if (canonicalAssignment) return keys.has(canonicalAssignment);

  const legacyAssignments = [
    data.transport_id,
    data.transport_user_id,
    data.transport_pin,
    data.driver_id,
    data.driver_pin,
    data.assigned_driver_id,
    data.assigned_to_pin,
  ].map((value) => String(value || '').trim()).filter(Boolean);
  return legacyAssignments.some((value) => keys.has(value));
}

async function authorizeOrder(supabase, orderId, actor) {
  const { data: order, error } = await supabase
    .from('transport_orders')
    .select('id,client_id,transport_id,data')
    .eq('id', orderId)
    .maybeSingle();

  if (error) throw serverError('AUTH_ORDER_LOOKUP_FAILED');
  if (!order) return { ok: false, error: 'TRANSPORT_ORDER_NOT_FOUND', status: 404 };
  if (!orderAssignedToActor(order, actor)) {
    return { ok: false, error: 'ORDER_NOT_ASSIGNED_TO_ACTOR', status: 403 };
  }
  return { ok: true, order };
}

async function authorizeClient(supabase, clientId, actor) {
  if (PRIVILEGED_ROLES.has(actor.role)) return { ok: true };
  const { data: orders, error } = await supabase
    .from('transport_orders')
    .select('id,client_id,transport_id,data')
    .eq('client_id', clientId)
    .limit(200);

  if (error) throw serverError('AUTH_CLIENT_LOOKUP_FAILED');
  if (!(orders || []).some((order) => orderAssignedToActor(order, actor))) {
    return { ok: false, error: 'CLIENT_NOT_ASSIGNED_TO_ACTOR', status: 403 };
  }
  return { ok: true };
}

function safeBusinessError(error) {
  const message = String(error?.message || error || '').trim();
  return /^[A-Z0-9_À-Ž-]+$/.test(message)
    ? message
    : 'TRANSPORT_RECEIVABLE_REQUEST_FAILED';
}

const KNOWN_RPC_BUSINESS_ERRORS = new Set([
  'ACTOR_NOT_FOUND_OR_DISABLED',
  'AMOUNT_INVALID',
  'CLIENT_HAS_NO_OUTSTANDING_BALANCE',
  'ONLY_CASH_SUPPORTED',
  'PAYMENT_IDEMPOTENCY_KEY_REQUIRED',
  'PAYMENT_IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD',
  'PAYMENT_IDEMPOTENCY_KEY_TOO_LONG',
  'RECEIVABLE_ORDER_NOT_FOUND',
  'TRANSPORT_CLIENT_ID_REQUIRED',
  'TRANSPORT_ORDER_CLIENT_CHANGED',
  'TRANSPORT_ORDER_HAS_NO_DEBT',
  'TRANSPORT_ORDER_NOT_FOUND',
  'TRANSPORT_ORDER_NOT_IN_DELIVERY',
]);

async function callRpc(supabase, name, args) {
  let response;
  try {
    response = await supabase.rpc(name, args);
  } catch {
    throw serverError(name + '_TRANSPORT_FAILED');
  }

  const { data, error } = response || {};
  if (error) {
    const message = String(error.message || error.code || name + '_FAILED').trim();
    const rpcError = new Error(
      KNOWN_RPC_BUSINESS_ERRORS.has(message)
        ? message
        : name + '_TRANSPORT_FAILED'
    );
    rpcError.code = String(error.code || '');
    rpcError.httpStatus = KNOWN_RPC_BUSINESS_ERRORS.has(message) && rpcError.code === 'P0001'
      ? 409
      : 503;
    throw rpcError;
  }
  if (!data || data.ok !== true) throw serverError(name + '_NOT_VERIFIED');
  return data;
}

export default async function handler(req, res) {
  let action = '';
  let orderId = '';
  setPrivateNoStore(res);

  try {
    if (req.method && req.method !== 'POST') return apiFail(res, 'METHOD_NOT_ALLOWED', 405);
    if (!requestOriginAllowed(req)) return apiFail(res, 'ORIGIN_NOT_ALLOWED', 403);

    const body = typeof readBody === 'function' ? await readBody(req) : (req.body || {});
    action = String(body?.action || '').trim().toUpperCase();
    orderId = cleanUuid(body?.orderId || body?.order_id);
    const clientId = cleanUuid(body?.clientId || body?.client_id);
    const supabase = createAdminClientOrThrow();

    const auth = await authenticateDevice(supabase, req);
    if (!auth.ok) return apiFail(res, auth.error, auth.status);

    if (orderId) {
      const access = await authorizeOrder(supabase, orderId, auth.user);
      if (!access.ok) return apiFail(res, access.error, access.status);
      const authorizedClientId = orderClientId(access.order);
      if (clientId && authorizedClientId && clientId !== authorizedClientId) {
        return apiFail(res, 'ORDER_CLIENT_MISMATCH', 403);
      }
    } else if (clientId) {
      const access = await authorizeClient(supabase, clientId, auth.user);
      if (!access.ok) return apiFail(res, access.error, access.status);
    }

    if (action === 'SUMMARY') {
      if (!orderId && !clientId) return apiFail(res, 'ORDER_OR_CLIENT_ID_REQUIRED', 400);
      const result = await callRpc(supabase, 'transport_client_receivable_summary_v1', {
        p_order_id: orderId || null,
        p_client_id: clientId || null,
      });
      return apiOk(res, sanitizeRpcResult(result));
    }

    if (action === 'DELIVER_WITH_DEBT') {
      if (!orderId) return apiFail(res, 'ORDER_ID_INVALID', 400);
      const actorPin = cleanPin(body?.actorPin || body?.actor_pin);
      const dueDate = String(body?.dueDate || body?.due_date || '').trim();
      const idempotencyKey = cleanKey(body?.idempotencyKey || body?.idempotency_key);
      if (!actorPin) return apiFail(res, 'ACTOR_PIN_REQUIRED', 400);
      if (actorPin !== auth.user.pin) return apiFail(res, 'ACTOR_SESSION_MISMATCH', 403);
      if (dueDate && !DATE_RE.test(dueDate)) return apiFail(res, 'DUE_DATE_INVALID', 400);
      if (!idempotencyKey) return apiFail(res, 'IDEMPOTENCY_KEY_REQUIRED', 400);

      const result = await callRpc(supabase, 'transport_deliver_with_debt_v1', {
        p_order_id: orderId,
        p_actor_pin: auth.user.pin,
        p_due_date: dueDate || null,
        p_note: String(body?.note || '').trim().slice(0, 500) || null,
        p_idempotency_key: idempotencyKey,
      });
      return apiOk(res, sanitizeRpcResult(result));
    }

    if (action === 'COLLECT_CLIENT_PAYMENT') {
      if (!orderId) return apiFail(res, 'ORDER_ID_INVALID', 400);
      const actorPin = cleanPin(body?.actorPin || body?.actor_pin);
      const amountReceived = Number(body?.amountReceived ?? body?.amount_received);
      const method = String(body?.method || 'CASH').trim().toUpperCase();
      const idempotencyKey = cleanKey(body?.idempotencyKey || body?.idempotency_key);
      if (!actorPin) return apiFail(res, 'ACTOR_PIN_REQUIRED', 400);
      if (actorPin !== auth.user.pin) return apiFail(res, 'ACTOR_SESSION_MISMATCH', 403);
      if (!Number.isFinite(amountReceived) || amountReceived <= 0) return apiFail(res, 'AMOUNT_INVALID', 400);
      if (method !== 'CASH') return apiFail(res, 'ONLY_CASH_SUPPORTED', 400);
      if (!idempotencyKey) return apiFail(res, 'IDEMPOTENCY_KEY_REQUIRED', 400);

      const result = await callRpc(supabase, 'transport_collect_client_payment_v1', {
        p_order_id: orderId,
        p_actor_pin: auth.user.pin,
        p_amount_received: Math.round((amountReceived + Number.EPSILON) * 100) / 100,
        p_method: method,
        p_note: String(body?.note || '').trim().slice(0, 500) || null,
        p_idempotency_key: idempotencyKey,
      });
      return apiOk(res, sanitizeRpcResult(result));
    }

    return apiFail(res, 'ACTION_INVALID', 400);
  } catch (error) {
    console.error('[transport-receivables]', {
      action,
      orderId: orderId || null,
      code: String(error?.code || ''),
      message: String(error?.message || error || 'UNKNOWN_ERROR').slice(0, 300),
    });
    return apiFail(res, safeBusinessError(error), Number(error?.httpStatus) || 503);
  }
}
