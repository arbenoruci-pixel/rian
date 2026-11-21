import { ADMIN_ROLES } from './roles.js';

export const BASE_CODE_STATUS_MAX_CODES = 160;
export const BASE_CODE_STATUS_ROLES = Object.freeze([
  ...ADMIN_ROLES, 'MASTER', 'PUNTOR', 'PUNETOR', 'WORKER', 'BAZIST', 'BASE',
]);

export class BaseCodeStatusError extends Error {
  constructor(code, httpStatus = 400) {
    super(code);
    this.name = 'BaseCodeStatusError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

function fail(code, status = 400) {
  throw new BaseCodeStatusError(code, status);
}

function cleanCode(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const raw = String(value).trim();
  if (!/^\d{1,16}$/.test(raw)) return null;
  const code = Number(raw);
  return Number.isSafeInteger(code) && code > 0 ? code : null;
}

export function normalizeBaseCodeStatusCodes(input) {
  if (!Array.isArray(input) || input.length > BASE_CODE_STATUS_MAX_CODES) {
    fail('BASE_CODE_STATUS_CODES_INVALID');
  }
  const codes = input.map(cleanCode);
  if (codes.some((code) => code == null)) fail('BASE_CODE_STATUS_CODES_INVALID');
  return [...new Set(codes)];
}

function normalizeDraftContext(input, codes) {
  if (input === undefined) return null;
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail('BASE_CODE_STATUS_DRAFT_INVALID');
  }
  const code = cleanCode(input.code);
  const draftSessionId = typeof input.draft_session_id === 'string' ? input.draft_session_id.trim() : '';
  if (code == null || !codes.includes(code) || !draftSessionId || draftSessionId.length > 512) {
    fail('BASE_CODE_STATUS_DRAFT_INVALID');
  }
  return { code, draftSessionId };
}

// Match the application's existing approved-device login authority. The caller
// cannot supply a PIN, role or user id to choose whose approval is checked.
export async function authenticateBaseCodeStatusActor(supabase, deviceIdLike) {
  const deviceId = String(deviceIdLike || '').trim();
  if (!deviceId) fail('AUTH_REQUIRED', 401);
  if (deviceId.length > 120) fail('DEVICE_NOT_APPROVED', 403);
  const { data: device, error: deviceError } = await supabase
    .from('tepiha_user_devices')
    .select('user_id,is_approved')
    .eq('device_id', deviceId)
    .maybeSingle();
  if (deviceError) fail('BASE_CODE_STATUS_DEVICE_LOOKUP_FAILED', 503);
  if (!device?.user_id || device.is_approved !== true) fail('DEVICE_NOT_APPROVED', 403);

  const { data: user, error: userError } = await supabase
    .from('users')
    .select('id,role,is_active')
    .eq('id', device.user_id)
    .maybeSingle();
  if (userError) fail('BASE_CODE_STATUS_USER_LOOKUP_FAILED', 503);
  if (!user?.id || user.is_active === false) fail('AUTH_USER_DISABLED', 403);
  const role = String(user.role || '').trim().toUpperCase();
  if (!BASE_CODE_STATUS_ROLES.includes(role)) fail('BASE_CODE_STATUS_FORBIDDEN', 403);
  return { id: String(user.id), role };
}

export async function readBaseCodeStatuses(body, { supabase, authUser } = {}) {
  if (!supabase || !authUser?.id) fail('AUTH_REQUIRED', 401);
  if (!BASE_CODE_STATUS_ROLES.includes(String(authUser.role || '').trim().toUpperCase())) {
    fail('BASE_CODE_STATUS_FORBIDDEN', 403);
  }
  const codes = normalizeBaseCodeStatusCodes(body?.codes);
  const draft = normalizeDraftContext(body?.draft, codes);
  if (!codes.length) return { items: [] };
  const { data, error } = await supabase.from('base_code_pool')
    .select(draft ? 'code,status,lease_expires_at,reserved_by,draft_session_id' : 'code,status,lease_expires_at')
    .in('code', codes.map(String))
    .limit(BASE_CODE_STATUS_MAX_CODES);
  if (error || !Array.isArray(data)) fail('BASE_CODE_STATUS_LOOKUP_FAILED', 503);
  const requested = new Set(codes);
  const items = data.map((row) => {
    const code = cleanCode(row?.code);
    if (!requested.has(code) || typeof row?.status !== 'string') {
      fail('BASE_CODE_STATUS_INVALID_RESULT', 503);
    }
    const item = {
      code,
      status: row.status,
      lease_expires_at: row.lease_expires_at == null ? null : String(row.lease_expires_at),
    };
    // Lists receive only status fields. Opening a known shared draft also needs
    // its existing reservation owner, so a different worker resumes that exact
    // binding instead of silently trying to allocate the draft under their PIN.
    if (draft && code === draft.code && row.status === 'reserved' && row.draft_session_id === draft.draftSessionId) {
      item.reserved_by = row.reserved_by == null ? null : String(row.reserved_by);
      item.draft_session_id = row.draft_session_id;
    }
    return item;
  });
  return { items };
}
