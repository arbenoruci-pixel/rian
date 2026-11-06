// Read-only replacement for browser access to the private code allocator table.
const BASE_ROLES = new Set(['PUNTOR', 'PUNETOR', 'WORKER', 'BAZIST', 'BASE', 'DISPATCH', 'ADMIN', 'ADMIN_MASTER', 'OWNER', 'PRONAR', 'SUPERADMIN']);
export class BaseCodeStatusError extends Error {
  constructor(code, httpStatus = 400) { super(code); this.code = code; this.httpStatus = httpStatus; }
}
const fail = (code, status) => { throw new BaseCodeStatusError(code, status); };

export async function authenticateBaseCodeStatusActor(supabase, deviceId) {
  if (typeof deviceId !== 'string' || !deviceId || deviceId.length > 120) fail('AUTH_REQUIRED', 401);
  const { data: device, error: de } = await supabase.from('tepiha_user_devices').select('user_id,is_approved').eq('device_id', deviceId).maybeSingle();
  if (de) fail('AUTH_DEVICE_LOOKUP_FAILED', 503);
  if (!device?.user_id || device.is_approved !== true) fail('DEVICE_NOT_APPROVED', 403);
  const { data: actor, error: ue } = await supabase.from('users').select('id,role,is_active').eq('id', device.user_id).maybeSingle();
  if (ue) fail('AUTH_USER_LOOKUP_FAILED', 503);
  if (!actor?.id || actor.is_active !== true || !BASE_ROLES.has(String(actor.role).trim().toUpperCase())) fail('BASE_CODE_STATUS_FORBIDDEN', 403);
  return actor;
}

export async function readBaseCodeStatuses(body, { supabase, actor }) {
  if (!actor?.id || actor.is_active !== true || !BASE_ROLES.has(String(actor.role).trim().toUpperCase())) fail('BASE_CODE_STATUS_FORBIDDEN', 403);
  if (body?.expectedActorId !== actor.id) fail('BASE_CODE_STATUS_SESSION_CHANGED', 403);
  if (!Array.isArray(body.codes) || body.codes.length > 160 || body.codes.some(code => !/^[1-9]\d{0,14}$/.test(String(code)) || !Number.isSafeInteger(Number(code)))) fail('BASE_CODE_STATUS_CODES_INVALID');
  const codes = [...new Set(body.codes.map(code => String(Number(code))))];
  if (!codes.length) return { rows: [] };
  const { data, error } = await supabase.from('base_code_pool').select('code,status,lease_expires_at').in('code', codes).limit(160);
  if (error) fail('BASE_CODE_STATUS_READ_FAILED', 503);
  // Explicit projection also protects against accidental future query expansion.
  return { rows: (data || []).map(row => ({ code: row.code, status: row.status, lease_expires_at: row.lease_expires_at })) };
}
