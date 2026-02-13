import { supabase } from '@/lib/supabaseClient';

// Company-level budget moves (separate from day cash register).
// Keep this file **pure**: no React/state/user context in here.

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
    direction: move?.direction || 'OUT',
    amount: Number(move?.amount ?? 0),
    reason: move?.reason || 'MOVE',
    note: move?.note || null,
    source: move?.source || 'CASH',

    // Actor fields (optional)
    created_by: move?.created_by || null,
    created_by_name: move?.created_by_name || null,
    created_by_pin: move?.created_by_pin || null,

    // Optional references
    ref_day_id: move?.ref_day_id || null,
    ref_type: move?.ref_type || null,
    external_id: move?.external_id || null,
  };

  const { data, error } = await supabase.from(TABLE).insert(payload).select('*').single();
  if (error) throw error;
  return data;
}

export async function budgetAddOutMove({
  amount,
  reason = 'OUT',
  note = null,
  source = 'CASH',
  created_by = null,
  created_by_name = null,
  created_by_pin = null,
  ref_day_id = null,
  ref_type = null,
  external_id = null,
} = {}) {
  return budgetAddMove({
    direction: 'OUT',
    amount,
    reason,
    note,
    source,
    created_by,
    created_by_name,
    created_by_pin,
    ref_day_id,
    ref_type,
    external_id,
  });
}

// Delete a company budget move by id.
export async function budgetDeleteMove(id) {
  if (!id) throw new Error('MUNGON ID');
  const { error } = await supabase.from(TABLE).delete().eq('id', id);
  if (error) throw error;
  return true;
}
