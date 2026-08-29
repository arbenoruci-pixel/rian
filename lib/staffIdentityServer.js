import { ROLES, STAFF_ADMIN_ROLES, staffRoleRank } from './roles.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PIN_RE = /^\d{4,12}$/;
const STAFF_ROLES = new Set(ROLES.map((role) => String(role || '').toUpperCase()));
const MANAGER_ROLES = new Set(STAFF_ADMIN_ROLES.map((role) => String(role || '').toUpperCase()));
const CASH_MODES = new Set(['FULL_CASH', 'HYBRID_COMMISSION', 'NO_CASH']);
const REQUEST_KEY_RE = /^[A-Za-z0-9._:-]{8,120}$/;

const BOOLEAN_FIELDS = new Set([
  'is_active',
  'is_hybrid_transport',
  'pay_salary_enabled',
  'pay_meal_enabled',
  'pay_commission_enabled',
  'pay_transport_bonus_enabled',
  'pay_ready_bonus_enabled',
]);

const MONEY_FIELDS = new Set([
  'salary',
  'avans_manual',
  'borxh_afatgjat',
  'bonus_transport',
  'bonus_ushqim',
  'commission_rate_m2',
  'pay_meal_amount',
  'pay_commission_rate_m2',
  'pay_transport_bonus_amount',
]);

const KNOWN_BUSINESS_ERRORS = new Set([
  'STAFF_ACTOR_NOT_ALLOWED',
  'STAFF_ACTOR_NOT_FOUND_OR_DISABLED',
  'STAFF_IDENTITY_NOT_FOUND',
  'STAFF_NAME_ALREADY_EXISTS',
  'STAFF_NAME_MATCH_REQUIRES_REACTIVATION',
  'STAFF_IDEMPOTENCY_CONFLICT',
  'STAFF_PIN_CHANGED',
  'STAFF_PIN_IN_USE',
  'STAFF_PIN_RETIRED',
  'STAFF_REACTIVATION_REQUIRED',
  'STAFF_REACTIVATION_TARGET_CHANGED',
  'STAFF_ROLE_ASSIGNMENT_NOT_ALLOWED',
  'STAFF_SELF_ROLE_CHANGE_NOT_ALLOWED',
  'STAFF_TARGET_ROLE_NOT_ALLOWED',
]);

export class StaffIdentityMutationError extends Error {
  constructor(code, status = 400, extra = {}) {
    super(String(code || 'STAFF_IDENTITY_MUTATION_FAILED'));
    this.name = 'StaffIdentityMutationError';
    this.code = String(code || 'STAFF_IDENTITY_MUTATION_FAILED');
    this.httpStatus = Number(status) || 400;
    this.extra = extra && typeof extra === 'object' ? extra : {};
  }
}

function fail(code, status = 400, extra = {}) {
  throw new StaffIdentityMutationError(code, status, extra);
}

export function normalizeStaffName(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toUpperCase();
}

export function cleanStaffUuid(value) {
  const clean = String(value || '').trim();
  return UUID_RE.test(clean) ? clean : '';
}

export function cleanStaffPin(value, { optional = false } = {}) {
  if (value == null || String(value).trim() === '') {
    if (optional) return '';
    fail('STAFF_PIN_INVALID', 400);
  }
  const clean = String(value).trim();
  if (!PIN_RE.test(clean)) fail('STAFF_PIN_INVALID', 400);
  return clean;
}

function cleanName(value, { optional = false } = {}) {
  if (value == null || String(value).trim() === '') {
    if (optional) return '';
    fail('STAFF_NAME_REQUIRED', 400);
  }
  const clean = String(value).trim().replace(/\s+/g, ' ');
  if (clean.length > 160) fail('STAFF_NAME_TOO_LONG', 400);
  return clean;
}

function cleanRole(value, { optional = false } = {}) {
  if (value == null || String(value).trim() === '') {
    if (optional) return '';
    fail('STAFF_ROLE_REQUIRED', 400);
  }
  const clean = String(value).trim().toUpperCase();
  if (!STAFF_ROLES.has(clean)) fail('STAFF_ROLE_INVALID', 400);
  return clean;
}

function cleanMoney(value, field) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 10000000) {
    fail(`STAFF_${String(field || 'AMOUNT').toUpperCase()}_INVALID`, 400);
  }
  return Math.round((number + Number.EPSILON) * 10000) / 10000;
}

export function sanitizeStaffIdentityPatch(input = {}) {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const patch = {};

  if (Object.prototype.hasOwnProperty.call(raw, 'name')) patch.name = cleanName(raw.name);
  if (Object.prototype.hasOwnProperty.call(raw, 'role')) patch.role = cleanRole(raw.role);
  if (Object.prototype.hasOwnProperty.call(raw, 'pin')) patch.pin = cleanStaffPin(raw.pin);

  for (const field of BOOLEAN_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(raw, field)) continue;
    if (typeof raw[field] !== 'boolean') fail(`STAFF_${field.toUpperCase()}_INVALID`, 400);
    patch[field] = raw[field];
  }

  for (const field of MONEY_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(raw, field)) continue;
    patch[field] = cleanMoney(raw[field], field);
  }

  if (Object.prototype.hasOwnProperty.call(raw, 'salary_day')) {
    if (raw.salary_day == null || raw.salary_day === '') {
      patch.salary_day = null;
    } else {
      const day = Number(raw.salary_day);
      if (!Number.isInteger(day) || day < 1 || day > 31) fail('STAFF_SALARY_DAY_INVALID', 400);
      patch.salary_day = day;
    }
  }

  if (Object.prototype.hasOwnProperty.call(raw, 'pay_cash_mode')) {
    const mode = String(raw.pay_cash_mode || '').trim().toUpperCase();
    if (!CASH_MODES.has(mode)) fail('STAFF_PAY_CASH_MODE_INVALID', 400);
    patch.pay_cash_mode = mode;
  }

  if (Object.prototype.hasOwnProperty.call(raw, 'pay_notes')) {
    const notes = String(raw.pay_notes || '').trim();
    if (notes.length > 1000) fail('STAFF_PAY_NOTES_TOO_LONG', 400);
    patch.pay_notes = notes || null;
  }

  return patch;
}

async function readStaffUserById(supabase, userId) {
  const { data, error } = await supabase
    .from('users')
    .select('id,pin,name,role,is_active,updated_at')
    .eq('id', userId)
    .maybeSingle();
  if (error) fail('STAFF_IDENTITY_LOOKUP_FAILED', 500);
  return data || null;
}

async function findNormalizedNameMatch(supabase, name, excludeUserId = '') {
  const wanted = normalizeStaffName(name);
  if (!wanted) return null;
  const { data, error } = await supabase
    .from('users')
    .select('id,pin,name,role,is_active,updated_at')
    .order('created_at', { ascending: true })
    .limit(500);
  if (error) fail('STAFF_IDENTITY_LOOKUP_FAILED', 500);
  return (Array.isArray(data) ? data : []).find((row) => {
    if (String(row?.id || '') === String(excludeUserId || '')) return false;
    return normalizeStaffName(row?.name) === wanted;
  }) || null;
}

function safeExistingUser(row) {
  if (!row) return null;
  return {
    id: String(row.id || ''),
    pin: String(row.pin || ''),
    name: String(row.name || ''),
    role: String(row.role || '').toUpperCase(),
    is_active: row.is_active !== false,
    updated_at: row.updated_at || null,
  };
}

function nameConflict(match) {
  const existing = safeExistingUser(match);
  fail('STAFF_NAME_MATCH_REQUIRES_REACTIVATION', 409, {
    existing_user: existing,
    can_reactivate: existing?.is_active === false,
  });
}

function enforceStaffRoleBoundary({ action, authUser, target, patch }) {
  const actorRole = String(authUser?.role || '').trim().toUpperCase();
  const actorRank = staffRoleRank(actorRole);
  if (!MANAGER_ROLES.has(actorRole) || actorRank < 0) fail('STAFF_ACTOR_NOT_ALLOWED', 403);

  if (target) {
    const targetRole = String(target.role || '').trim().toUpperCase();
    const targetRank = staffRoleRank(targetRole);
    // Unknown legacy roles are not safe to mutate until their privilege level
    // is classified explicitly.
    if (targetRank < 0 || targetRank > actorRank) {
      fail('STAFF_TARGET_ROLE_NOT_ALLOWED', 403);
    }

    const isSelf = String(target.id || '') === String(authUser.id || '');
    if (isSelf && patch.role && String(patch.role).toUpperCase() !== targetRole) {
      fail('STAFF_SELF_ROLE_CHANGE_NOT_ALLOWED', 409);
    }
  }

  if ((action === 'CREATE' || patch.role) && staffRoleRank(patch.role) > actorRank) {
    fail('STAFF_ROLE_ASSIGNMENT_NOT_ALLOWED', 403);
  }
}

function parseRpcBusinessCode(errorLike) {
  const source = [errorLike?.message, errorLike?.details, errorLike?.hint, errorLike?.code]
    .map((value) => String(value || '').toUpperCase())
    .join(' ');
  for (const code of KNOWN_BUSINESS_ERRORS) {
    if (source.includes(code)) return code;
  }
  if (source.includes('STAFF_CURRENT_PIN_STALE')) return 'STAFF_PIN_CHANGED';
  if (source.includes('STAFF_UPDATED_AT_STALE')) return 'STAFF_UPDATED_AT_CHANGED';
  if (source.includes('STAFF_PIN_IS_RETIRED')) return 'STAFF_PIN_RETIRED';
  if (source.includes('STAFF_PIN_ALREADY_USED')) return 'STAFF_PIN_IN_USE';
  if (source.includes('STAFF_USE_REACTIVATE_ACTION')) return 'STAFF_REACTIVATION_REQUIRED';
  if (source.includes('STAFF_USER_NOT_FOUND')) return 'STAFF_IDENTITY_NOT_FOUND';
  if (source.includes('STAFF_MANAGER_ONLY')) return 'STAFF_ACTOR_NOT_ALLOWED';
  if (source.includes('STAFF_IDEMPOTENCY_KEY_REQUIRED')) return 'STAFF_IDEMPOTENCY_KEY_REQUIRED';
  return '';
}

function normalizeRpcData(data) {
  if (Array.isArray(data) && data.length === 1) return normalizeRpcData(data[0]);
  if (typeof data === 'string') {
    try { return normalizeRpcData(JSON.parse(data)); } catch { return null; }
  }
  return data && typeof data === 'object' ? data : null;
}

async function callSaveStaffIdentityRpc(supabase, args) {
  let response;
  try {
    response = await supabase.rpc('save_staff_identity_v1', args);
  } catch {
    fail('STAFF_IDENTITY_RPC_FAILED', 503);
  }

  const { data, error } = response || {};
  if (error) {
    const businessCode = parseRpcBusinessCode(error);
    if (businessCode) fail(businessCode, 409);
    fail('STAFF_IDENTITY_RPC_FAILED', 503);
  }

  const result = normalizeRpcData(data);
  if (!result) fail('STAFF_IDENTITY_RPC_NOT_VERIFIED', 503);
  if (result.ok === false) {
    const code = String(result.error || result.code || 'STAFF_IDENTITY_RPC_FAILED').trim().toUpperCase();
    const status = KNOWN_BUSINESS_ERRORS.has(code) ? 409 : 503;
    fail(code, status, {
      existing_user: safeExistingUser(result.existing_user),
      can_reactivate: result.can_reactivate === true,
    });
  }
  if (result.ok !== true) fail('STAFF_IDENTITY_RPC_NOT_VERIFIED', 503);
  return result;
}

export async function authenticateStaffManager(supabase, deviceIdLike) {
  const deviceId = String(deviceIdLike || '').trim().slice(0, 120);
  if (!deviceId) fail('AUTH_REQUIRED', 401);

  const { data: device, error: deviceError } = await supabase
    .from('tepiha_user_devices')
    .select('user_id,is_approved')
    .eq('device_id', deviceId)
    .maybeSingle();
  if (deviceError) fail('AUTH_DEVICE_LOOKUP_FAILED', 500);
  if (!device?.user_id || device.is_approved !== true) fail('DEVICE_NOT_APPROVED', 403);

  const { data: user, error: userError } = await supabase
    .from('users')
    .select('id,pin,name,role,is_active')
    .eq('id', device.user_id)
    .maybeSingle();
  if (userError) fail('AUTH_USER_LOOKUP_FAILED', 500);
  const role = String(user?.role || '').trim().toUpperCase();
  if (!user || user.is_active === false || !PIN_RE.test(String(user.pin || ''))) {
    fail('AUTH_USER_DISABLED', 403);
  }
  if (!MANAGER_ROLES.has(role)) fail('STAFF_ACTOR_NOT_ALLOWED', 403);
  return { ...user, pin: String(user.pin), role };
}

export async function runStaffIdentityMutation(bodyLike, { supabase, authUser } = {}) {
  if (!supabase || !authUser?.id || !PIN_RE.test(String(authUser?.pin || ''))) {
    fail('AUTH_REQUIRED', 401);
  }
  const actorRole = String(authUser.role || '').trim().toUpperCase();
  if (!MANAGER_ROLES.has(actorRole) || authUser.is_active === false) fail('STAFF_ACTOR_NOT_ALLOWED', 403);

  const body = bodyLike && typeof bodyLike === 'object' && !Array.isArray(bodyLike) ? bodyLike : {};
  const action = String(body.action || '').trim().toUpperCase();
  if (!['CREATE', 'UPDATE', 'DEACTIVATE', 'REACTIVATE'].includes(action)) {
    fail('STAFF_ACTION_INVALID', 400);
  }

  const userId = cleanStaffUuid(body.userId || body.user_id);
  const reactivateUserId = cleanStaffUuid(body.reactivateUserId || body.reactivate_user_id);
  const requestKey = String(body.idempotencyKey || body.idempotency_key || body.requestId || body.request_id || '').trim();
  if (!REQUEST_KEY_RE.test(requestKey)) fail('STAFF_IDEMPOTENCY_KEY_REQUIRED', 400);
  const patch = sanitizeStaffIdentityPatch(body.patch || body.user || {});
  const requestedExpectedPin = cleanStaffPin(
    body.expectedCurrentPin || body.expected_current_pin,
    { optional: true },
  );
  const requestedExpectedUpdatedAt = String(
    body.expectedUpdatedAt || body.expected_updated_at || '',
  ).trim();

  let target = null;
  if (action === 'UPDATE' || action === 'DEACTIVATE') {
    if (!userId) fail('STAFF_USER_ID_INVALID', 400);
    if (!requestedExpectedPin || !requestedExpectedUpdatedAt) fail('STAFF_EXPECTED_STATE_REQUIRED', 400);
    target = await readStaffUserById(supabase, userId);
    if (!target) fail('STAFF_IDENTITY_NOT_FOUND', 404);
    const deactivatesTarget = action === 'DEACTIVATE'
      || (action === 'UPDATE' && patch.is_active === false);
    if (deactivatesTarget && String(target.id) === String(authUser.id)) {
      fail('STAFF_SELF_DEACTIVATE_NOT_ALLOWED', 409);
    }
  }

  if (action === 'REACTIVATE') {
    if (!reactivateUserId) fail('STAFF_REACTIVATION_TARGET_INVALID', 400);
    if (!requestedExpectedPin || !requestedExpectedUpdatedAt) fail('STAFF_EXPECTED_STATE_REQUIRED', 400);
    target = await readStaffUserById(supabase, reactivateUserId);
    if (!target) fail('STAFF_IDENTITY_NOT_FOUND', 404);
  }

  if (action === 'CREATE') {
    if (!patch.name) fail('STAFF_NAME_REQUIRED', 400);
    if (!patch.role) fail('STAFF_ROLE_REQUIRED', 400);
    if (!patch.pin) fail('STAFF_PIN_INVALID', 400);
  }

  enforceStaffRoleBoundary({ action, authUser, target, patch });

  const effectivePatch = { ...patch };
  delete effectivePatch.name;
  delete effectivePatch.role;
  delete effectivePatch.pin;
  delete effectivePatch.is_active;
  effectivePatch.idempotency_key = `staff:${String(authUser.id)}:${requestKey}`;
  if (requestedExpectedPin) effectivePatch.expected_current_pin = requestedExpectedPin;
  if (requestedExpectedUpdatedAt) effectivePatch.expected_updated_at = requestedExpectedUpdatedAt;

  let rpcResult;
  try {
    rpcResult = await callSaveStaffIdentityRpc(supabase, {
      p_actor_pin: String(authUser.pin),
      p_action: action,
      p_user_id: userId || null,
      p_name: patch.name || (action === 'REACTIVATE' ? String(target?.name || '') : null),
      p_role: patch.role || (action === 'REACTIVATE' ? String(target?.role || '').toUpperCase() : null),
      p_pin: patch.pin || (action === 'REACTIVATE' ? String(target?.pin || '') : null),
      p_is_active: action === 'DEACTIVATE' ? false : (action === 'REACTIVATE' ? true : (patch.is_active ?? null)),
      p_patch: effectivePatch,
      p_reactivate_user_id: reactivateUserId || null,
    });
  } catch (error) {
    if (error?.code === 'STAFF_NAME_MATCH_REQUIRES_REACTIVATION') {
      const wantedName = patch.name || target?.name || '';
      const match = await findNormalizedNameMatch(
        supabase,
        wantedName,
        action === 'UPDATE' || action === 'REACTIVATE' ? (userId || reactivateUserId) : '',
      );
      if (match) nameConflict(match);
    }
    throw error;
  }

  return {
    action,
    user: rpcResult.user || rpcResult.item || null,
    result: rpcResult,
  };
}
