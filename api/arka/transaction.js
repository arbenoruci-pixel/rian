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

function safeError(error) {
  const message = String(error?.message || error || '').trim();
  return /^[A-Z0-9_À-Ž-]+$/.test(message) ? message : 'ARKA_TRANSACTION_FAILED';
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
    return { ok: false, error: 'AUTH_USER_DISABLED', status: 403 };
  }

  return {
    ok: true,
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
    if (!auth.ok) return apiFail(res, auth.error, auth.status);

    const requestedActorPin = cleanPin(
      body?.actorPin
      || body?.actor_pin
      || body?.created_by_pin
      || body?.createdByPin
      || body?.actor?.pin
      || body?.user?.pin
    );
    if (requestedActorPin && requestedActorPin !== auth.user.pin) {
      return apiFail(res, 'ACTOR_SESSION_MISMATCH', 403);
    }

    const action = String(body?.action || '').trim().toUpperCase();
    if (action === 'TRANSPORT_ORDER_PAYMENT') {
      const access = await authorizeLegacyTransportPayment(supabase, body, auth.user);
      if (!access.ok) return apiFail(res, access.error, access.status);
    }

    const guardedBody = {
      ...(body || {}),
      actorPin: auth.user.pin,
      actorName: String(auth.user.name || ''),
      actorRole: auth.user.role,
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
