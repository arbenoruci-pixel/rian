import { getSupabaseClient } from '@/lib/arka/supabaseClient';
import {
  listPendingCashPayments,
  applyPendingPaymentToCycle,
} from '@/lib/arkaCashSync';

// Wrapper API expected by CashClient.

export async function loadPendingPayments(dayKey) {
  return listPendingCashPayments(dayKey);
}

export async function acceptPendingPayment({ pending, cycle_id, actor } = {}) {
  if (!pending?.id && !pending?.external_id && !pending?.externalId) throw new Error('Missing pending payment');
  if (!cycle_id) throw new Error('Missing cycle_id');

  return applyPendingPaymentToCycle({
    pending,
    cycle_id,
    approved_by_name: actor?.name ?? null,
    approved_by_pin: actor?.pin ?? null,
    approved_by_role: actor?.role ?? null,
  });
}


export async function rejectPendingPayment({ pending, actor, note } = {}) {
  if (!pending?.id) throw new Error('Missing pending payment id');
  const sb = getSupabaseClient();
  const now = new Date().toISOString();

  // Try a rich update first; fall back to minimal if schema doesn't have columns.
  const rich = {
    status: 'REJECTED',
    rejected_at: now,
    rejected_by_pin: actor?.pin ?? null,
    rejected_by_name: actor?.name ?? null,
    rejected_by_role: actor?.role ?? null,
    reject_note: note ?? null,
  };

  let { error } = await sb
    .from('arka_pending_payments')
    .update(rich)
    .eq('id', pending.id);

  if (error) {
    // PostgREST schema cache / missing-column errors: update only status.
    const { error: e2 } = await sb
      .from('arka_pending_payments')
      .update({ status: 'REJECTED' })
      .eq('id', pending.id);
    if (e2) throw e2;
  }

  return { ok: true };
}
