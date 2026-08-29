import { supabase } from '@/lib/supabaseClient';
import { staffIdentityRequest } from '@/lib/staffIdentityClient';

const USERS_TABLE = 'users';
const USERS_VIEW = 'tepiha_users';

function isMissingTableError(errLike) {
  const msg = String(errLike?.message || errLike?.details || errLike?.hint || errLike || '').toLowerCase();
  return (
    msg.includes('schema cache') ||
    msg.includes('could not find') ||
    msg.includes('does not exist') ||
    msg.includes('relation')
  );
}

function mergePreferNonEmpty(base = {}, incoming = {}) {
  const next = { ...(base || {}) };
  for (const [key, value] of Object.entries(incoming || {})) {
    if (value == null) continue;
    if (typeof value === 'string' && value.trim() === '') continue;
    next[key] = value;
  }
  return next;
}

async function fetchUserByPin(pin, select = '*') {
  const cleanPin = String(pin || '').trim();
  if (!cleanPin) return null;
  const { data, error } = await supabase.from(USERS_TABLE).select(select).eq('pin', cleanPin).limit(1).maybeSingle();
  if (error) throw error;
  return data || null;
}

async function resolveUserRef(ref) {
  if (ref && typeof ref === 'object') {
    const base = {
      id: String(ref.id || '').trim(),
      pin: String(ref.pin || '').trim(),
      name: String(ref.name || '').trim(),
      is_active: ref.is_active,
      updated_at: ref.updated_at || null,
    };

    if (base.id) {
      try {
        const current = await fetchUserById(base.id, 'id,pin,name,is_active,updated_at');
        if (current) return mergePreferNonEmpty(base, current);
      } catch {}
    }

    if (base.pin) {
      try {
        const current = await fetchUserByPin(base.pin, 'id,pin,name,is_active,updated_at');
        if (current) return mergePreferNonEmpty(base, current);
      } catch {}
    }

    return base;
  }

  const raw = String(ref || '').trim();
  if (!raw) throw new Error('ID is required');

  try {
    const byId = await fetchUserById(raw, 'id,pin,name,is_active,updated_at');
    if (byId) return byId;
  } catch {}

  try {
    const byPin = await fetchUserByPin(raw, 'id,pin,name,is_active,updated_at');
    if (byPin) return byPin;
  } catch {}

  return { id: raw, pin: raw, name: '' };
}

export async function listUserRecords(options = {}) {
  const select = options?.select || '*';
  let q = supabase.from(USERS_TABLE).select(select);
  const eq = options?.eq || {};
  for (const [key, value] of Object.entries(eq)) q = q.eq(key, value);
  if (options?.orderBy) q = q.order(options.orderBy, { ascending: !!options?.ascending });
  if (options?.limit) q = q.limit(options.limit);
  const { data, error } = await q;
  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

export async function fetchUserById(id, select = '*') {
  const { data, error } = await supabase.from(USERS_TABLE).select(select).eq('id', id).maybeSingle();
  if (error) throw error;
  return data || null;
}

async function resolveExpectedUserState(id, options = {}) {
  const expectedCurrentPin = String(options?.expectedCurrentPin || '').trim();
  const expectedUpdatedAt = String(options?.expectedUpdatedAt || '').trim();
  if (expectedCurrentPin && expectedUpdatedAt) return { expectedCurrentPin, expectedUpdatedAt };

  const current = await fetchUserById(id, 'pin,updated_at');
  return {
    expectedCurrentPin: expectedCurrentPin || String(current?.pin || '').trim(),
    expectedUpdatedAt: expectedUpdatedAt || String(current?.updated_at || '').trim(),
  };
}

export async function updateUserRecord(id, patch = {}, options = {}) {
  const expected = await resolveExpectedUserState(id, options);
  const response = await staffIdentityRequest({
    action: 'UPDATE',
    userId: String(id || '').trim(),
    expectedCurrentPin: expected.expectedCurrentPin || undefined,
    expectedUpdatedAt: expected.expectedUpdatedAt || undefined,
    patch: { ...(patch || {}) },
  });
  return { ok: true, id, user: response?.user || null, result: response?.result || null };
}

export async function createUserRecord(row = {}) {
  const response = await staffIdentityRequest({
    action: 'CREATE',
    patch: { ...(row || {}) },
  });
  return response?.user || response?.result?.user || null;
}

export async function reactivateUserRecord(id, row = {}, options = {}) {
  const expected = await resolveExpectedUserState(id, options);
  const response = await staffIdentityRequest({
    action: 'REACTIVATE',
    reactivateUserId: String(id || '').trim(),
    expectedCurrentPin: expected.expectedCurrentPin || undefined,
    expectedUpdatedAt: expected.expectedUpdatedAt || undefined,
    patch: { ...(row || {}), is_active: true },
  });
  return response?.user || response?.result?.user || null;
}

export async function deleteUserRecord(ref) {
  const user = await resolveUserRef(ref);
  const userId = String(user?.id || '').trim();
  const userPin = String(user?.pin || '').trim();
  if (!userId) throw new Error('ID is required');

  const response = await staffIdentityRequest({
    action: 'DEACTIVATE',
    userId,
    expectedCurrentPin: userPin || undefined,
    expectedUpdatedAt: String(user?.updated_at || '').trim() || undefined,
  });
  return {
    ok: true,
    id: userId,
    pin: userPin || null,
    mode: 'deactivated',
    user: response?.user || response?.result?.user || null,
  };
}

export async function fetchSessionUserByPin(pin) {
  const cleanPin = String(pin || '').trim();
  if (!cleanPin) return null;

  let merged = null;

  try {
    const { data, error } = await supabase.from(USERS_TABLE).select('*').eq('pin', cleanPin).limit(1).maybeSingle();
    if (error) throw error;
    if (data) merged = mergePreferNonEmpty(merged, data);
  } catch {}

  try {
    const { data, error } = await supabase.from(USERS_VIEW).select('*').eq('pin', cleanPin).limit(1).maybeSingle();
    if (error && !isMissingTableError(error)) throw error;
    if (data) merged = mergePreferNonEmpty(merged, data);
  } catch {}

  return merged || null;
}
