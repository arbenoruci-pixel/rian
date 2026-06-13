import { supabase } from '@/lib/supabaseClient';

const TABLE = 'company_fixed_expenses';
const n = (v) => {
  const x = Number(v || 0);
  return Number.isFinite(x) ? x : 0;
};
const safeUpper = (v) => String(v || '').trim().toUpperCase();

function normalize(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: safeUpper(row.title || 'SHPENZIM'),
    amount: n(row.amount),
    dueDay: Math.max(1, Math.min(31, n(row.due_day) || 1)),
    essential: row.essential !== false,
    active: row.active !== false,
    note: row.note || '',
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
    created_by_pin: row.created_by_pin || null,
  };
}

export function isMissingRelationError(error) {
  const code = String(error?.code || '');
  const msg = String(error?.message || '').toLowerCase();
  return code === '42P01' || msg.includes('relation') || msg.includes('does not exist');
}

export async function listCompanyFixedExpenses({ includeInactive = true } = {}) {
  let q = supabase
    .from(TABLE)
    .select('id,title,amount,due_day,essential,active,note,created_at,updated_at,created_by_pin')
    .order('active', { ascending: false })
    .order('due_day', { ascending: true })
    .order('title', { ascending: true });
  if (!includeInactive) q = q.eq('active', true);
  const { data, error } = await q;
  if (error) throw error;
  return (Array.isArray(data) ? data : []).map(normalize).filter(Boolean);
}

export async function createCompanyFixedExpense({ actor, title, amount, dueDay, essential = true, active = true, note = '' }) {
  const payload = {
    title: safeUpper(title || 'SHPENZIM'),
    amount: n(amount),
    due_day: Math.max(1, Math.min(31, n(dueDay) || 1)),
    essential: essential !== false,
    active: active !== false,
    note: String(note || '').trim() || null,
    created_by_pin: actor?.pin || null,
  };
  const { data, error } = await supabase.from(TABLE).insert(payload).select('*').single();
  if (error) throw error;
  return normalize(data);
}

export async function updateCompanyFixedExpense(id, patch = {}) {
  const payload = {};
  if ('title' in patch) payload.title = safeUpper(patch.title || 'SHPENZIM');
  if ('amount' in patch) payload.amount = n(patch.amount);
  if ('dueDay' in patch || 'due_day' in patch) payload.due_day = Math.max(1, Math.min(31, n(patch.dueDay ?? patch.due_day) || 1));
  if ('essential' in patch) payload.essential = patch.essential !== false;
  if ('active' in patch) payload.active = patch.active !== false;
  if ('note' in patch) payload.note = String(patch.note || '').trim() || null;
  payload.updated_at = new Date().toISOString();
  const { data, error } = await supabase.from(TABLE).update(payload).eq('id', id).select('*').single();
  if (error) throw error;
  return normalize(data);
}

export async function deleteCompanyFixedExpense(id) {
  const { error } = await supabase.from(TABLE).delete().eq('id', id);
  if (error) throw error;
  return { ok: true };
}

export async function importLegacyFixedExpenses({ actor, items = [] }) {
  const rows = (Array.isArray(items) ? items : [])
    .map((x) => ({
      title: safeUpper(x?.title || 'SHPENZIM'),
      amount: n(x?.amount),
      due_day: Math.max(1, Math.min(31, n(x?.dueDay ?? x?.due_day) || 1)),
      essential: x?.essential !== false,
      active: x?.active !== false,
      note: String(x?.note || '').trim() || null,
      created_by_pin: actor?.pin || null,
    }))
    .filter((x) => x.title && x.amount > 0);
  if (!rows.length) return [];
  const { data, error } = await supabase.from(TABLE).insert(rows).select('*');
  if (error) throw error;
  return (Array.isArray(data) ? data : []).map(normalize).filter(Boolean);
}
