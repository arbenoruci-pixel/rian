import { apiFail, apiOk, createAdminClientOrThrow, readBody } from '../_helpers.js';

const MANAGER_ROLES = new Set([
  'ADMIN', 'ADMIN_MASTER', 'OWNER', 'PRONAR', 'SUPERADMIN',
  'MASTER', 'MASTER USER', 'MASTER_USER', 'MASTERUSER',
]);

function clean(value) {
  return String(value ?? '').trim();
}

function cleanPin(value) {
  return clean(value).replace(/\D/g, '').slice(0, 12);
}

function readCookie(req, name) {
  const prefix = `${String(name || '')}=`;
  for (const part of String(req?.headers?.cookie || '').split(';')) {
    const item = part.trim();
    if (!item.startsWith(prefix)) continue;
    try { return decodeURIComponent(item.slice(prefix.length)); } catch { return ''; }
  }
  return '';
}

function requestOriginAllowed(req) {
  const origin = clean(req?.headers?.origin);
  if (!origin) return true;
  const forwardedHost = clean(req?.headers?.['x-forwarded-host'] || req?.headers?.host)
    .split(',')[0]
    .trim()
    .toLowerCase();
  if (!forwardedHost) return false;
  try {
    const parsed = new URL(origin);
    return ['https:', 'http:'].includes(parsed.protocol) && parsed.host.toLowerCase() === forwardedHost;
  } catch {
    return false;
  }
}

function setPrivateNoStore(res) {
  res.setHeader('cache-control', 'private, no-store, max-age=0, must-revalidate');
  res.setHeader('pragma', 'no-cache');
  res.setHeader('expires', '0');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('vary', 'Cookie');
}

async function authenticateManager(supabase, req) {
  const deviceId = clean(readCookie(req, 'tepiha_device_id')).slice(0, 120);
  if (!deviceId) return { ok: false, error: 'AUTH_REQUIRED', status: 401 };

  const { data: device, error: deviceError } = await supabase
    .from('tepiha_user_devices')
    .select('user_id,is_approved')
    .eq('device_id', deviceId)
    .maybeSingle();
  if (deviceError) throw new Error('WORKER_CONTROL_DEVICE_LOOKUP_FAILED');
  if (!device?.user_id || device.is_approved !== true) {
    return { ok: false, error: 'DEVICE_NOT_APPROVED', status: 403 };
  }

  const { data: user, error: userError } = await supabase
    .from('users')
    .select('id,pin,name,role,is_active,is_master')
    .eq('id', device.user_id)
    .maybeSingle();
  if (userError) throw new Error('WORKER_CONTROL_ACTOR_LOOKUP_FAILED');
  if (!user || user.is_active === false || !cleanPin(user.pin)) {
    return { ok: false, error: 'AUTH_USER_DISABLED', status: 403 };
  }

  const role = clean(user.role).toUpperCase();
  const isManager = user.is_master === true || MANAGER_ROLES.has(role);
  if (!isManager) return { ok: false, error: 'WORKER_CONTROL_MANAGER_ONLY', status: 403 };

  return {
    ok: true,
    user: {
      id: user.id,
      pin: cleanPin(user.pin),
      name: clean(user.name) || cleanPin(user.pin),
      role,
      is_master: user.is_master === true,
    },
  };
}

function safeError(error) {
  const message = clean(error?.message || error);
  const leading = message.match(/^([A-Z][A-Z0-9_À-Ž-]{2,})(?=$|[\s:])/u)?.[1] || '';
  return leading || 'WORKER_CONTROL_FAILED';
}

export default async function handler(req, res) {
  setPrivateNoStore(res);
  if (req.method && req.method !== 'POST') return apiFail(res, 'METHOD_NOT_ALLOWED', 405);
  if (!requestOriginAllowed(req)) return apiFail(res, 'ORIGIN_NOT_ALLOWED', 403);

  try {
    const body = typeof readBody === 'function' ? await readBody(req) : (req.body || {});
    const action = clean(body?.action).toUpperCase();
    const supabase = createAdminClientOrThrow();
    const auth = await authenticateManager(supabase, req);
    if (!auth.ok) return apiFail(res, auth.error, auth.status);

    if (action === 'CREATE_ADVANCE') {
      const workerPin = cleanPin(body?.workerPin || body?.worker_pin);
      const amount = Number(body?.amount || 0);
      const note = clean(body?.note) || 'AVANS';
      const idempotencyKey = clean(body?.idempotencyKey || body?.idempotency_key).slice(0, 240) || null;
      if (!workerPin) return apiFail(res, 'WORKER_PIN_REQUIRED', 400);
      if (!Number.isFinite(amount) || amount <= 0) return apiFail(res, 'WORKER_ADVANCE_AMOUNT_INVALID', 400);

      const { data, error } = await supabase.rpc('create_worker_advance_pro_v1', {
        p_actor_pin: auth.user.pin,
        p_actor_name: auth.user.name,
        p_worker_pin: workerPin,
        p_amount: amount,
        p_note: note,
        p_idempotency_key: idempotencyKey,
      });
      if (error) throw error;
      return apiOk(res, { action, result: data || null });
    }

    if (action === 'RESOLVE_EXPENSE') {
      const paymentId = Number(body?.expensePaymentId || body?.expense_payment_id || 0);
      const resolution = clean(body?.resolution).toUpperCase();
      const beneficiaryPin = cleanPin(body?.beneficiaryPin || body?.beneficiary_pin) || null;
      const beneficiaryName = clean(body?.beneficiaryName || body?.beneficiary_name) || null;
      const note = clean(body?.note) || 'VENDOSUR NGA KARTELA E PUNTORIT';
      if (!Number.isInteger(paymentId) || paymentId <= 0) return apiFail(res, 'EXPENSE_PAYMENT_ID_REQUIRED', 400);
      if (!['BUSINESS_EXPENSE', 'PERSONAL_ADVANCE', 'REJECTED_OPEN_CASH'].includes(resolution)) {
        return apiFail(res, 'INVALID_EXPENSE_RESOLUTION', 400);
      }

      const { data, error } = await supabase.rpc('resolve_arka_expense_v2', {
        p_actor_pin: auth.user.pin,
        p_actor_name: auth.user.name,
        p_expense_payment_id: paymentId,
        p_resolution: resolution,
        p_beneficiary_pin: resolution === 'PERSONAL_ADVANCE' ? beneficiaryPin : null,
        p_beneficiary_name: resolution === 'PERSONAL_ADVANCE' ? beneficiaryName : null,
        p_note: note,
      });
      if (error) throw error;
      return apiOk(res, { action, result: data || null });
    }

    return apiFail(res, 'WORKER_CONTROL_ACTION_INVALID', 400);
  } catch (error) {
    console.error('[worker-control]', safeError(error));
    return apiFail(res, safeError(error), 400);
  }
}
