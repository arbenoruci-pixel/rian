import { supabase } from '@/lib/supabaseClient';

// Company budget ledger (DISPATCH).
// Supabase table (confirmed): company_budget_moves
// Columns: id, direction, amount, reason, note, source, created_by, created_by_pin,
// created_at, ref_day_id, ref_type, external_id

const TABLE = 'company_budget_moves';

export async function budgetListMoves(limit = 200) {
  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

export async function budgetAddMove(move) {
  const payload = {
    direction: move.direction || 'OUT',
    amount: move.amount,
    reason: move.reason || 'MOVE',
    note: move.note || null,
    source: move.source || 'CASH',
    created_by: move.created_by || null,
    created_by_pin: move.created_by_pin || null,
    ref_day_id: move.ref_day_id || null,
    ref_type: move.ref_type || null,
    external_id: move.external_id || null,
  };

  const { data, error } = await supabase.from(TABLE).insert(payload).select('*').single();
  if (error) throw error;
  return data;
}

export async function budgetDeleteMove(id) {
  const { error } = await supabase.from(TABLE).delete().eq('id', id);
  if (error) throw error;
  return true;
}

// Backwards compatible wrappers (older UI used these names)
export async function budgetListOutMoves(limit = 200) {
  const all = await budgetListMoves(limit);
  return all.filter((m) => String(m.direction || '').toUpperCase() === 'OUT');
}

export async function budgetAddOutMove({ amount, reason, note, source, created_by, created_by_pin }) {
  return budgetAddMove({
    direction: 'OUT',
    amount,
    reason,
    note,
    source,
    created_by,
    created_by_pin,
  });
}
