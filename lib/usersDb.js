import { supabase } from './supabaseClient';

// READ: mund të jetë VIEW (tepiha_users). Në disa DB kjo view ka kolona të ndryshme.
const READ_TABLE = 'tepiha_users';

// WRITE: te ti u konfirmu që tepiha_users është VIEW mbi public.users.
// INSERT/UPDATE duhet të shkojnë te tabela burim.
const WRITE_TABLE = 'users';

const USER_FIELDS_STRICT = 'id,name,role,pin,is_active,is_master,created_at';
const USER_FIELDS_FALLBACK = 'id,name,role,pin,created_at';

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
    // Disa view nuk i kanë is_active/is_master → provo strict, pastaj fallback.
    let data = null;
    let error = null;

    {
      const r1 = await supabase
        .from(READ_TABLE)
        .select(USER_FIELDS_STRICT)
        .order('created_at', { ascending: true });
      data = r1.data;
      error = r1.error;
    }

    if (error) {
      const msg = String(error?.message || '').toLowerCase();
      const maybeMissingCols = msg.includes('column') && msg.includes('does not exist');
      if (maybeMissingCols) {
        const r2 = await supabase
          .from(READ_TABLE)
          .select(USER_FIELDS_FALLBACK)
          .order('created_at', { ascending: true });
        data = (r2.data || []).map((u) => ({ ...u, is_active: true, is_master: false }));
        error = r2.error;
      }
    }

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

  // Përdorim tabelën e shkrimit për INSERT ose UPDATE
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

export async function findUserByPin(pin) {
  const p = String(pin || '').trim();
  if (!p) return { ok: true, item: null };

  // Provo me is_active, pastaj fallback (kur view s’ka is_active).
  let data = null;
  let error = null;

  {
    const r1 = await supabase
      .from(READ_TABLE)
      .select(USER_FIELDS_STRICT)
      .eq('pin', p)
      .limit(1)
      .maybeSingle();
    data = r1.data;
    error = r1.error;
  }

  if (error) {
    const msg = String(error?.message || '').toLowerCase();
    const maybeMissingCols = msg.includes('column') && msg.includes('does not exist');
    if (maybeMissingCols) {
      const r2 = await supabase
        .from(READ_TABLE)
        .select(USER_FIELDS_FALLBACK)
        .eq('pin', p)
        .limit(1)
        .maybeSingle();
      data = r2.data ? { ...r2.data, is_active: true, is_master: false } : null;
      error = r2.error;
    }
  }

  if (data && data.is_active === false) {
    return { ok: true, item: null };
  }

  if (error) {
    return { ok: false, error, missingTable: isMissingTableError(error) };
  }

  return { ok: true, item: data || null };
}
