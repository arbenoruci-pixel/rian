// Server-side facade for the single PRANIMI allocator RPC.
// It never batches, seeds, guesses, updates base_code_pool, or retries another path.

const DEFAULT_LEASE_MINUTES = 30;
const MAX_LEASE_MINUTES = 60 * 24 * 7;

function strictPin(value) { const pin = String(value == null ? '' : value).trim(); return /^\d{3,12}$/.test(pin) ? pin : ''; }
function strictCode(value) { const raw = String(value == null ? '' : value).trim(); if (!/^\d+$/.test(raw)) return null; const n = Number(raw); return Number.isSafeInteger(n) && n > 0 ? n : null; }
function cleanCount(value) { if (value == null || value === '') return 1; const n = Number(value); return Number.isInteger(n) ? n : NaN; }
function serverError(message, status = 500, extra = {}) { const e = new Error(message); e.status = status; Object.assign(e, extra); return e; }
function classifyAssignmentRpcError(error) {
  const text = `${String(error?.message || '')} ${String(error?.details || '')} ${String(error?.hint || '')}`.toUpperCase();
  const map = [
    ['PIN_ACTIVE_DRAFT_EXISTS', 409],
    ['PIN_NOT_FOUND_OR_DISABLED', 403],
    ['DRAFT_SESSION_REQUIRED', 400],
    ['NO_BASE_CODES_AVAILABLE', 409],
  ];
  const hit = map.find(([token]) => text.includes(token));
  return hit ? serverError(hit[0], hit[1], { code: hit[0], details: error?.details || null, cause: error }) : null;
}

async function validatePin(supabase, pin) {
  let lastError = null;
  for (const table of ['users', 'tepiha_users']) {
    try {
      let result = await supabase.from(table).select('id,pin,role,name,is_active').eq('pin', pin).limit(1).maybeSingle();
      if (result?.error && ['42703', 'PGRST204'].includes(String(result.error.code || ''))) result = await supabase.from(table).select('id,pin,role,name').eq('pin', pin).limit(1).maybeSingle();
      if (result?.error) { lastError = result.error; continue; }
      if (!result?.data) continue;
      if (Object.prototype.hasOwnProperty.call(result.data, 'is_active') && result.data.is_active === false) throw serverError('PIN_DISABLED', 403);
      return result.data;
    } catch (error) { if (error?.status === 403) throw error; lastError = error; }
  }
  if (lastError) throw serverError(`PIN_LOOKUP_FAILED:${lastError?.message || String(lastError)}`, 500);
  throw serverError('PIN_NOT_FOUND', 404);
}

async function validateDeviceIfProvided(supabase, user, rawDeviceId) {
  const deviceId = String(rawDeviceId || '').trim().slice(0, 120);
  if (!deviceId) return { checked: false, approved: true };
  const userId = String(user?.id || '').trim();
  if (!userId) throw serverError('PIN_USER_ID_MISSING', 403);
  const { data, error } = await supabase.from('tepiha_user_devices').select('id,is_approved,user_id').eq('device_id', deviceId).eq('user_id', userId).limit(1).maybeSingle();
  if (error) throw serverError(`DEVICE_LOOKUP_FAILED:${error?.message || String(error)}`, 500);
  if (!data || data.is_approved !== true) throw serverError('DEVICE_NOT_APPROVED', 403);
  return { checked: true, approved: true, deviceId };
}

export async function reserveBaseCodesForPin(input = {}, deps = {}) {
  const supabase = deps.supabase;
  if (!supabase?.rpc || !supabase?.from) throw serverError('SUPABASE_CLIENT_REQUIRED', 500);
  const pin = strictPin(input?.pin ?? input?.actor_pin ?? input?.p_pin);
  if (!pin) throw serverError('PIN_REQUIRED_OR_INVALID', 400);
  const count = cleanCount(input?.count ?? input?.n ?? input?.p_n ?? input?.p_count);
  if (count === 0) return { ok: true, pin, codes: [], count: 0, source: 'NOOP_ZERO_COUNT' };
  if (count !== 1) throw serverError('PRANIMI_SINGLE_CODE_ONLY', 400);
  const draftSessionId = String(input?.draftSessionId ?? input?.draft_session_id ?? input?.p_draft_session_id ?? input?.oid ?? input?.local_oid ?? '').trim();
  if (!draftSessionId) throw serverError('DRAFT_SESSION_REQUIRED', 400);
  const leaseMinutes = Math.max(1, Math.min(MAX_LEASE_MINUTES, Math.trunc(Number(input?.leaseMinutes ?? input?.lease_minutes ?? DEFAULT_LEASE_MINUTES) || DEFAULT_LEASE_MINUTES)));
  const user = await validatePin(supabase, pin);
  const device = await validateDeviceIfProvided(supabase, user, input?.deviceId ?? input?.device_id);

  let response;
  try { response = await supabase.rpc('get_or_assign_pranimi_code', { p_pin: pin, p_draft_session_id: draftSessionId, p_lease_minutes: leaseMinutes }); }
  catch (cause) { const deterministic = classifyAssignmentRpcError(cause); if (deterministic) throw deterministic; throw serverError('PRANIMI_ASSIGNMENT_RESULT_AMBIGUOUS', 503, { cause }); }
  const { data, error } = response || {};
  if (error) { const deterministic = classifyAssignmentRpcError(error); if (deterministic) throw deterministic; throw serverError('PRANIMI_ASSIGNMENT_RESULT_AMBIGUOUS', 503, { cause: error, code: error?.code || null }); }
  const row = Array.isArray(data) ? data[0] : data;
  const code = strictCode(row?.code ?? row);
  const status = String(row?.status || '').trim().toLowerCase();
  const reservedBy = strictPin(row?.reserved_by ?? row?.pin);
  const returnedDraft = String(row?.draft_session_id || '').trim();
  const leaseExpiresAt = String(row?.lease_expires_at || '').trim();
  if (code == null || status !== 'reserved' || reservedBy !== pin || returnedDraft !== draftSessionId || !leaseExpiresAt || row?.verified === false) throw serverError('DB_ASSIGNMENT_IDENTITY_MISMATCH', 502, { assignment: row || null });
  return {
    ok: true,
    pin,
    codes: [code],
    code,
    count: 1,
    source: 'RPC:get_or_assign_pranimi_code',
    assignment: { code, status, reserved_by: reservedBy, draft_session_id: returnedDraft, lease_expires_at: leaseExpiresAt, verified: true },
    user: { id: user?.id || null, name: user?.name || null, role: user?.role || null },
    device,
  };
}
