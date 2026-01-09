import { supabase } from './supabaseClient';

const TABLE = 'tepiha_users';

function isMissingTableError(err) {
  const msg = String(err?.message || '').toLowerCase();
  return (
    msg.includes('schema cache') ||
    msg.includes('could not find') ||
    msg.includes('does not exist') ||
    msg.includes('relation')
  );
}

export async function listUsers() {
  try {
    const { data, error } = await supabase
      .from(TABLE)
      .select('id,name,role,pin,is_active,created_at')
      .order('created_at', { ascending: true });

    if (error) {
      return { ok: false, error, missingTable: isMissingTableError(error) };
    }

    return { ok: true, items: data || [] };
  } catch (err) {
    return { ok: false, error: err, missingTable: isMissingTableError(err) };
  }
}

export async function ensureDefaultAdminIfEmpty({ defaultName = 'ADMIN', defaultPin = '0000' } = {}) {
  const res = await listUsers();
  if (!res.ok) return res;
  if ((res.items || []).length > 0) return res;

  const { data, error } = await supabase
    .from(TABLE)
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

  // For CREATE: name + pin required.
  // For UPDATE: allow blank pin (means "keep existing PIN").
  if (!payload.name) {
    return { ok: false, error: new Error('NAME is required') };
  }
  if (!payload.id && !payload.pin) {
    return { ok: false, error: new Error('PIN is required for new user') };
  }

  // Insert or update based on id (uuid). If no id, let DB generate.
  const query = supabase.from(TABLE);

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
    .from(TABLE)
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
    .from(TABLE)
    .update({ is_active: !!is_active })
    .eq('id', id)
    .select()
    .maybeSingle();

  if (error) {
    return { ok: false, error, missingTable: isMissingTableError(error) };
  }

  return { ok: true, item: data };
}

export async function findUserByPin(pin) {
  const p = String(pin || '').trim();
  if (!p) return { ok: true, item: null };

  const { data, error } = await supabase
    .from(TABLE)
    .select('id,name,role,pin,is_active,created_at')
    .eq('pin', p)
    .eq('is_active', true)
    .limit(1)
    .maybeSingle();

  if (error) {
    return { ok: false, error, missingTable: isMissingTableError(error) };
  }

  return { ok: true, item: data || null };
}
