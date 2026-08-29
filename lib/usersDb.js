import { supabase } from './supabaseClient';
import { staffIdentityRequest } from './staffIdentityClient.js';

const READ_TABLE = 'tepiha_users';
const FALLBACK_READ_TABLE = 'users';
const WRITE_TABLE = 'users';

function isMissingTableError(err) {
  const msg = String(err?.message || '').toLowerCase();
  return (
    msg.includes('schema cache') ||
    msg.includes('could not find') ||
    msg.includes('does not exist') ||
    msg.includes('relation')
  );
}

const USER_SELECT = 'id,name,role,pin,is_active,created_at,is_hybrid_transport,transport_id,commission_rate_m2';

async function readUsers(select = USER_SELECT, { includeInactive = false, byPin = '' } = {}) {
  const sources = [READ_TABLE, FALLBACK_READ_TABLE];

  for (const table of sources) {
    try {
      let query = supabase.from(table).select(select);

      if (byPin) query = query.eq('pin', byPin).limit(1).maybeSingle();
      else query = query.order('created_at', { ascending: true });

      if (!includeInactive) query = query.eq('is_active', true);

      const { data, error } = await query;
      if (error) {
        if (isMissingTableError(error) && table === READ_TABLE) continue;
        return { ok: false, error, missingTable: isMissingTableError(error) };
      }

      if (byPin) return { ok: true, item: data || null };
      return { ok: true, items: data || [] };
    } catch (err) {
      if (isMissingTableError(err) && table === READ_TABLE) continue;
      return { ok: false, error: err, missingTable: isMissingTableError(err) };
    }
  }

  return { ok: true, items: [], item: null };
}

export async function listUsers({ includeInactive = false } = {}) {
  return readUsers(USER_SELECT, { includeInactive });
}

export async function ensureDefaultAdminIfEmpty({ defaultName = 'ADMIN', defaultPin = '0000' } = {}) {
  const res = await listUsers();
  if (!res.ok) return res;
  if ((res.items || []).length > 0) return res;

  const { data, error } = await supabase
    .from(WRITE_TABLE)
    .insert([{ name: defaultName, role: 'ADMIN', pin: String(defaultPin), is_active: true }])
    .select()
    .maybeSingle();

  if (error) {
    return { ok: false, error, missingTable: isMissingTableError(error) };
  }

  return { ok: true, items: [data].filter(Boolean) };
}

export async function upsertUser(user) {
  const payload = {
    id: user.id,
    name: String(user.name || '').trim(),
    role: user.role || 'PUNTOR',
    pin: String(user.pin || '').trim(),
    is_active: user.is_active !== false,
  };

  if (!payload.name) {
    return { ok: false, error: new Error('NAME is required') };
  }
  if (!payload.id && !payload.pin) {
    return { ok: false, error: new Error('PIN is required for new user') };
  }

  try {
    let response;
    if (payload.id) {
      const current = await readCurrentUserById(payload.id);
      const action = current?.is_active === false && payload.is_active
        ? 'REACTIVATE'
        : 'UPDATE';
      response = await staffIdentityRequest({
        action,
        ...(action === 'REACTIVATE'
          ? { reactivateUserId: payload.id }
          : { userId: payload.id }),
        expectedCurrentPin: String(current?.pin || '').trim() || undefined,
        expectedUpdatedAt: String(current?.updated_at || '').trim() || undefined,
        patch: {
          name: payload.name,
          role: payload.role,
          is_active: payload.is_active,
          ...(payload.pin ? { pin: payload.pin } : {}),
        },
      });
    } else {
      response = await staffIdentityRequest({
        action: 'CREATE',
        patch: {
          name: payload.name,
          role: payload.role,
          pin: payload.pin,
          is_active: payload.is_active,
        },
      });
    }
    return { ok: true, item: response?.user || response?.result?.user || null };
  } catch (error) {
    return { ok: false, error, missingTable: isMissingTableError(error) };
  }
}

export async function setUserPin(id, pin) {
  const p = String(pin || '').trim();
  if (!id) return { ok: false, error: new Error('ID is required') };
  if (!p) return { ok: false, error: new Error('PIN is required') };

  try {
    const current = await readCurrentUserById(id);
    const response = await staffIdentityRequest({
      action: 'UPDATE',
      userId: id,
      expectedCurrentPin: String(current?.pin || '').trim() || undefined,
      expectedUpdatedAt: String(current?.updated_at || '').trim() || undefined,
      patch: { pin: p },
    });
    return { ok: true, item: response?.user || response?.result?.user || null };
  } catch (error) {
    return { ok: false, error, missingTable: isMissingTableError(error) };
  }
}

export async function setUserActive(id, is_active) {
  try {
    const current = await readCurrentUserById(id);
    if (!current) return { ok: true, item: null };
    if ((current.is_active !== false) === !!is_active) return { ok: true, item: current };
    const action = is_active ? 'REACTIVATE' : 'DEACTIVATE';
    const response = await staffIdentityRequest({
      action,
      ...(action === 'REACTIVATE' ? { reactivateUserId: id } : { userId: id }),
      expectedCurrentPin: String(current.pin || '').trim() || undefined,
      expectedUpdatedAt: String(current.updated_at || '').trim() || undefined,
      ...(action === 'REACTIVATE' ? { patch: { is_active: true } } : {}),
    });
    return { ok: true, item: response?.user || response?.result?.user || null };
  } catch (error) {
    return { ok: false, error, missingTable: isMissingTableError(error) };
  }
}

export async function removeOrDeactivateUser(ref) {
  const raw = String(ref?.id || ref || '').trim();
  const rawPin = String(ref?.pin || '').trim();
  if (!raw && !rawPin) return { ok: false, error: new Error('ID is required') };

  try {
    let current = null;
    if (raw) {
      try {
        const byId = await supabase.from(WRITE_TABLE).select('id,pin,is_active,updated_at').eq('id', raw).limit(1).maybeSingle();
        if (!byId.error && byId.data) current = byId.data;
      } catch {}
    }
    if (!current && rawPin) {
      try {
        const byPin = await supabase.from(WRITE_TABLE).select('id,pin,is_active,updated_at').eq('pin', rawPin).limit(1).maybeSingle();
        if (!byPin.error && byPin.data) current = byPin.data;
      } catch {}
    }

    const targetId = String(current?.id || raw || '').trim();
    if (!targetId || !current) return { ok: true, mode: 'not_found', item: null };
    const response = await staffIdentityRequest({
      action: 'DEACTIVATE',
      userId: targetId,
      expectedCurrentPin: String(current?.pin || rawPin || '').trim() || undefined,
      expectedUpdatedAt: String(current?.updated_at || '').trim() || undefined,
    });
    return {
      ok: true,
      mode: 'deactivated',
      item: response?.user || response?.result?.user || null,
    };
  } catch (err) {
    return { ok: false, error: err, missingTable: isMissingTableError(err) };
  }
}

async function readCurrentUserById(id) {
  const cleanId = String(id || '').trim();
  if (!cleanId) return null;
  const { data, error } = await supabase
    .from(WRITE_TABLE)
    .select('id,pin,name,role,is_active,updated_at')
    .eq('id', cleanId)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

export async function findUserByPin(pin) {
  const p = String(pin || '').trim();
  if (!p) return { ok: true, item: null };
  return readUsers(USER_SELECT, { includeInactive: false, byPin: p });
}
