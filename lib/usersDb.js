import { supabase } from './supabaseClient';

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

  const query = supabase.from(WRITE_TABLE);

  const { data, error } = payload.id
    ? await query
        .update({
          name: payload.name,
          role: payload.role,
          is_active: payload.is_active,
          ...(payload.pin ? { pin: payload.pin } : {}),
        })
        .eq('id', payload.id)
        .select()
        .maybeSingle()
    : await query
        .insert([
          {
            name: payload.name,
            role: payload.role,
            pin: payload.pin,
            is_active: payload.is_active,
          },
        ])
        .select()
        .maybeSingle();

  if (error) {
    return { ok: false, error, missingTable: isMissingTableError(error) };
  }

  return { ok: true, item: data };
}

export async function setUserPin(id, pin) {
  const p = String(pin || '').trim();
  if (!id) return { ok: false, error: new Error('ID is required') };
  if (!p) return { ok: false, error: new Error('PIN is required') };

  const { data, error } = await supabase
    .from(WRITE_TABLE)
    .update({ pin: p })
    .eq('id', id)
    .select()
    .maybeSingle();

  if (error) {
    return { ok: false, error, missingTable: isMissingTableError(error) };
  }

  return { ok: true, item: data };
}

export async function setUserActive(id, is_active) {
  const { data, error } = await supabase
    .from(WRITE_TABLE)
    .update({ is_active: !!is_active })
    .eq('id', id)
    .select()
    .maybeSingle();

  if (error) {
    return { ok: false, error, missingTable: isMissingTableError(error) };
  }

  return { ok: true, item: data };
}

function isForeignKeyDeleteError(err) {
  const msg = String(err?.message || err?.details || err?.hint || '').toLowerCase();
  return (
    msg.includes('foreign key') ||
    msg.includes('violates foreign key constraint') ||
    msg.includes('still referenced') ||
    msg.includes('is referenced')
  );
}

export async function removeOrDeactivateUser(ref) {
  const raw = String(ref?.id || ref || '').trim();
  const rawPin = String(ref?.pin || '').trim();
  if (!raw && !rawPin) return { ok: false, error: new Error('ID is required') };

  try {
    let current = null;
    if (raw) {
      try {
        const byId = await supabase.from(WRITE_TABLE).select('id,pin,is_active').eq('id', raw).limit(1).maybeSingle();
        if (!byId.error && byId.data) current = byId.data;
      } catch {}
    }
    if (!current && rawPin) {
      try {
        const byPin = await supabase.from(WRITE_TABLE).select('id,pin,is_active').eq('pin', rawPin).limit(1).maybeSingle();
        if (!byPin.error && byPin.data) current = byPin.data;
      } catch {}
    }

    const tryDeleteId = current?.id || raw;
    if (tryDeleteId) {
      const { data, error: deleteError } = await supabase
        .from(WRITE_TABLE)
        .delete()
        .eq('id', tryDeleteId)
        .select('id');

      if (!deleteError && Array.isArray(data) && data.length > 0) {
        return { ok: true, mode: 'deleted', item: data?.[0] || null };
      }

      if (deleteError && !isForeignKeyDeleteError(deleteError)) {
        return { ok: false, error: deleteError, missingTable: isMissingTableError(deleteError) };
      }
    }

    const pinToArchive = String(current?.pin || rawPin || '').trim();
    const archivedPin = pinToArchive ? `DEL${pinToArchive}${String(current?.id || raw || '').replace(/[^a-z0-9]/gi, '').slice(-4).toUpperCase()}`.slice(0, 32) : '';
    const patch = { is_active: false, ...(archivedPin ? { pin: archivedPin } : {}) };

    if (current?.id || raw) {
      const { data, error: updateError } = await supabase
        .from(WRITE_TABLE)
        .update(patch)
        .eq('id', current?.id || raw)
        .select();

      if (!updateError && Array.isArray(data) && data.length > 0) {
        return { ok: true, mode: 'deactivated', item: data?.[0] || null };
      }

      if (updateError && !isMissingTableError(updateError)) {
        return { ok: false, error: updateError, missingTable: isMissingTableError(updateError) };
      }
    }

    if (pinToArchive) {
      const { data, error: updateByPinError } = await supabase
        .from(WRITE_TABLE)
        .update(patch)
        .eq('pin', pinToArchive)
        .select();

      if (!updateByPinError && Array.isArray(data) && data.length > 0) {
        return { ok: true, mode: 'deactivated', item: data?.[0] || null };
      }

      if (updateByPinError) {
        return { ok: false, error: updateByPinError, missingTable: isMissingTableError(updateByPinError) };
      }
    }

    return { ok: true, mode: 'not_found', item: null };
  } catch (err) {
    return { ok: false, error: err, missingTable: isMissingTableError(err) };
  }
}

export async function findUserByPin(pin) {
  const p = String(pin || '').trim();
  if (!p) return { ok: true, item: null };
  return readUsers(USER_SELECT, { includeInactive: false, byPin: p });
}
