import { createClient } from '@supabase/supabase-js';

// Company budget ledger.
// Current DB tables:
// - company_budget_moves (ledger rows)

function getSupabaseAnon() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  return createClient(url, key);
}

function mustClient() {
  const supabase = getSupabaseAnon();
  if (!supabase) throw new Error('Missing Supabase env (NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY)');
  return supabase;
}

export async function budgetListMoves({ limit = 200 } = {}) {
  const supabase = mustClient();
  const { data, error } = await supabase
    .from('company_budget_moves')
    .select('id,direction,amount,reason,note,source,created_by,created_by_pin,created_at,ref_day_id,ref_type,external_id')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

// --- Compatibility helpers used by existing UI ---

// UI expects rows like: { id, amount, type, note, created_by }
export async function budgetListOutMoves({ limit = 200 } = {}) {
  const rows = await budgetListMoves({ limit });
  return rows.map((r) => ({
    id: r.id,
    amount: Number(r.amount || 0) || 0,
    type: String(r.direction || 'IN').toUpperCase(),
    note: r.note ?? r.reason ?? '',
    created_by: r.created_by ?? r.created_by_pin ?? '',
    created_at: r.created_at,
    source: r.source,
  }));
}

export async function budgetAddOutMove({ type, amount, note, created_by, created_by_pin } = {}) {
  const supabase = mustClient();
  const direction = String(type || 'OUT').toUpperCase();
  const amt = Number(amount || 0);
  if (!Number.isFinite(amt) || amt <= 0) throw new Error('Invalid amount');

  const payload = {
    direction,
    amount: amt,
    reason: direction === 'OUT' ? 'SHPENZIM' : 'IN',
    note: note ?? null,
    source: 'CASH',
    created_by: created_by ?? null,
    created_by_pin: created_by_pin ?? null,
  };

  const { data, error } = await supabase
    .from('company_budget_moves')
    .insert(payload)
    .select('id')
    .single();
  if (error) throw error;
  return data?.id;
}

export async function budgetDeleteOutMove(id) {
  const supabase = mustClient();
  const { error } = await supabase.from('company_budget_moves').delete().eq('id', id);
  if (error) throw error;
  return true;
}

export async function budgetGetTotals() {
  // Compute totals client-side to avoid relying on DB views.
  const moves = await budgetListMoves({ limit: 2000 });
  let totalIn = 0;
  let totalOut = 0;
  for (const m of moves) {
    const a = Number(m.amount || 0) || 0;
    if (String(m.direction || '').toUpperCase() === 'OUT') totalOut += a;
    else totalIn += a;
  }
  return { totalIn, totalOut, balance: totalIn - totalOut };
}
