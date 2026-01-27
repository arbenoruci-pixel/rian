
import { supabase } from './supabaseClient';

export async function applyPendingPaymentToCycle({ pendingId, cycleId, actor }) {
  const pin = actor?.pin || null;
  const name = actor?.name || null;

  // Load pending if only id provided
  let pending = null;
  if (pendingId) {
    const { data, error } = await supabase
      .from('arka_pending_payments')
      .select('*')
      .eq('id', pendingId)
      .single();
    if (error) throw error;
    pending = data;
  }

  if (!pending) throw new Error('Missing pending payment');

  // Update pending -> APPROVED (use applied_at + approved_by_*)
  const { data: upd, error: updErr } = await supabase
    .from('arka_pending_payments')
    .update({
      status: 'APPROVED',
      applied_at: new Date().toISOString(),
      approved_by_pin: pin,
      approved_by_name: name
    })
    .eq('id', pending.id)
    .select('id,status');

  if (updErr) throw updErr;
  if (!upd || upd.length === 0) throw new Error('NO_ROWS_UPDATED');

  // Try insert move (ignore actor columns if schema doesnt allow)
  const move = {
    cycle_id: cycleId || pending.cycle_id || null,
    amount: pending.amount,
    direction: 'IN',
    note: 'Pending accepted'
  };

  await supabase.from('arka_cycle_moves').insert(move);

  return { ok: true };
}
