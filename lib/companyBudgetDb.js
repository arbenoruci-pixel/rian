import { supabase } from '@/lib/supabaseClient';

// Company budget ledger for DISPATCH (shared). Keeps OUT moves (expenses/bank transfers).
// IN cash comes from arka_days.received_amount.

export async function budgetListOutMoves(limit = 200) {
  const { data, error } = await supabase
    .from('arka_company_moves')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

export async function budgetAddOutMove({ type = 'OUT', amount, note = '', created_by = 'LOCAL', external_id = null }) {
  const payload = {
    type,
    amount: Number(amount),
    note,
    created_by,
    external_id: external_id || null,
  };

  // Idempotent insert when external_id exists
  if (payload.external_id) {
    const { data: existing } = await supabase
      .from('arka_company_moves')
      .select('*')
      .eq('external_id', payload.external_id)
      .maybeSingle();
    if (existing) return existing;
  }

  const { data, error } = await supabase
    .from('arka_company_moves')
    .insert([payload])
    .select('*')
    .single();
  if (error) throw error;
  return data;
}

export async function budgetDeleteOutMove(id) {
  const { error } = await supabase.from('arka_company_moves').delete().eq('id', id);
  if (error) throw error;
  return true;
}

export async function budgetListDays(rangeDays = 60) {
  // Fetch recent days for summary + pending handoffs
  const from = new Date(Date.now() - rangeDays * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('arka_days')
    .select('*')
    .gte('opened_at', from)
    .order('opened_at', { ascending: false })
    .limit(500);
  if (error) throw error;
  return data || [];
}
