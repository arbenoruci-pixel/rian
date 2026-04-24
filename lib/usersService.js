import { supabase } from '@/lib/supabaseClient';

const USERS_TABLE = 'users';
const USERS_VIEW = 'tepiha_users';

function isForeignKeyDeleteError(errLike) {
  const msg = String(errLike?.message || errLike?.details || errLike?.hint || errLike || '').toLowerCase();
  return (
    msg.includes('foreign key') ||
    msg.includes('violates foreign key constraint') ||
    msg.includes('still referenced') ||
    msg.includes('is referenced')
  );
}

function isMissingTableError(errLike) {
  const msg = String(errLike?.message || errLike?.details || errLike?.hint || errLike || '').toLowerCase();
  return (
    msg.includes('schema cache') ||
    msg.includes('could not find') ||
    msg.includes('does not exist') ||
    msg.includes('relation')
  );
}

function buildArchivedPin(pin, userId) {
  const rawPin = String(pin || '').trim();
  if (!rawPin) return '';
  const suffix = String(userId || '').replace(/[^a-z0-9]/gi, '').slice(-4).toUpperCase();
  const next = `DEL${rawPin}${suffix}`;
  return next.slice(0, 32);
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
    };

    if (base.id) {
      try {
        const current = await fetchUserById(base.id, 'id,pin,name,is_active');
        if (current) return mergePreferNonEmpty(base, current);
      } catch {}
    }

    if (base.pin) {
      try {
        const current = await fetchUserByPin(base.pin, 'id,pin,name,is_active');
        if (current) return mergePreferNonEmpty(base, current);
      } catch {}
    }

    return base;
  }

  const raw = String(ref || '').trim();
  if (!raw) throw new Error('ID is required');

  try {
    const byId = await fetchUserById(raw, 'id,pin,name,is_active');
    if (byId) return byId;
  } catch {}

  try {
    const byPin = await fetchUserByPin(raw, 'id,pin,name,is_active');
    if (byPin) return byPin;
  } catch {}

  return { id: raw, pin: raw, name: '' };
}

async function deleteDevicesForUser(user) {
  const tries = [];

  const run = async (label, fn) => {
    try {
      const res = await fn();
      tries.push({ label, ok: true, count: Array.isArray(res?.data) ? res.data.length : undefined });
      return res;
    } catch (err) {
      tries.push({ label, ok: false, error: err });
      return null;
    }
  };

  if (user?.id) {
    await run('tepiha_user_devices:user_id', () =>
      supabase.from('tepiha_user_devices').delete().eq('user_id', user.id).select('device_id')
    );
  }

  if (user?.pin) {
    await run('tepiha_user_devices:requested_pin', () =>
      supabase.from('tepiha_user_devices').delete().eq('requested_pin', String(user.pin)).select('device_id')
    );
  }

  return tries;
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

export async function updateUserRecord(id, patch = {}) {
  const payload = { ...(patch || {}) };
  const { error } = await supabase.from(USERS_TABLE).update(payload).eq('id', id);
  if (error) throw error;
  return { ok: true, id };
}

export async function createUserRecord(row = {}) {
  const payload = { ...(row || {}) };
  const { data, error } = await supabase.from(USERS_TABLE).insert([payload]).select('*').maybeSingle();
  if (error) throw error;
  return data || null;
}

export async function deleteUserRecord(ref) {
  const user = await resolveUserRef(ref);
  const userId = String(user?.id || '').trim();
  const userPin = String(user?.pin || '').trim();

  const tries = await deleteDevicesForUser(user);

  let lastDeleteError = null;

  if (userId) {
    const { data, error } = await supabase
      .from(USERS_TABLE)
      .delete()
      .eq('id', userId)
      .select('id,pin');

    if (!error && Array.isArray(data) && data.length > 0) {
      return { ok: true, id: userId, pin: userPin, mode: 'deleted', tries };
    }
    if (error) lastDeleteError = error;
  }

  if (userPin) {
    const { data, error } = await supabase
      .from(USERS_TABLE)
      .delete()
      .eq('pin', userPin)
      .select('id,pin');

    if (!error && Array.isArray(data) && data.length > 0) {
      return { ok: true, id: data?.[0]?.id || userId, pin: userPin, mode: 'deleted', tries };
    }
    if (error) lastDeleteError = error;
  }

  if (lastDeleteError && !isForeignKeyDeleteError(lastDeleteError)) {
    throw lastDeleteError;
  }

  const archivePatch = {
    is_active: false,
  };
  const archivedPin = buildArchivedPin(userPin, userId || userPin);
  if (archivedPin) archivePatch.pin = archivedPin;

  if (userId) {
    const { data, error } = await supabase
      .from(USERS_TABLE)
      .update(archivePatch)
      .eq('id', userId)
      .select('id,pin,is_active');

    if (!error && Array.isArray(data) && data.length > 0) {
      return { ok: true, id: userId, pin: userPin, mode: 'deactivated', tries, archivedPin };
    }
    if (error && !isMissingTableError(error)) {
      lastDeleteError = error;
    }
  }

  if (userPin) {
    const { data, error } = await supabase
      .from(USERS_TABLE)
      .update(archivePatch)
      .eq('pin', userPin)
      .select('id,pin,is_active');

    if (!error && Array.isArray(data) && data.length > 0) {
      return { ok: true, id: data?.[0]?.id || userId, pin: userPin, mode: 'deactivated', tries, archivedPin };
    }
    if (error && !isMissingTableError(error)) {
      lastDeleteError = error;
    }
  }

  if (!userId && !userPin) {
    throw new Error('ID is required');
  }

  if (lastDeleteError) throw lastDeleteError;

  return {
    ok: true,
    id: userId || null,
    pin: userPin || null,
    mode: 'not_found',
    tries,
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
