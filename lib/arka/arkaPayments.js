import { getSupabaseClient } from '@/lib/arka/supabaseClient';
import {
  listPendingCashPayments,
  applyPendingPaymentToCycle,
} from '@/lib/arkaCashSync';

function normalizeArkaError(err) {
  const msg = String(err?.message || err || '').toLowerCase();
  if (!msg) return 'Gabim i panjohur.';
  if (msg.includes('missing pending payment id') || msg.includes('missing pending payment')) return 'GABIM: Pagesa në pritje nuk u gjet.';
  if (msg.includes('missing cycle_id') || msg.includes('missing cycle') || msg.includes('no_cycle')) return 'GABIM: Cikli i arkës mungon ose nuk është valid.';
  if (msg.includes('missing approver pin') || msg.includes('missing_approver_pin')) return 'GABIM: PIN-i i aprovuesit mungon.';
  if (msg.includes('nuk ekziston ose perdoruesi nuk eshte aktiv') || msg.includes('nuk ekziston ose përdoruesi nuk është aktiv')) return 'GABIM: PIN-i nuk ekziston ose llogaria nuk është aktive!';
  if (msg.includes('foreign key') && msg.includes('applied_cycle_id')) return 'GABIM: Cikli i arkës nuk është valid. Rifresko faqen dhe provo përsëri.';
  if (msg.includes('invalid input syntax for type uuid')) return 'GABIM: ID e ciklit nuk është UUID valide.';
  if (msg.includes('schema cache') || msg.includes('could not find')) return 'GABIM: Sistemi po përditësohet. Provo përsëri pas pak.';
  return String(err?.message || err || 'Gabim i panjohur.');
}

// Wrapper API expected by CashClient.

export async function loadPendingPayments(dayKey) {
  return listPendingCashPayments(dayKey);
}

export async function acceptPendingPayment({ pending, cycle_id, actor } = {}) {
  if (!pending?.id) throw new Error('Missing pending payment id');
  if (!cycle_id) throw new Error('Missing cycle_id');
  const approved_by_name = actor?.name ?? null;
  const approved_by_pin = actor?.pin ?? null;
  const approved_by_role = actor?.role ?? null;
  return applyPendingPaymentToCycleSafe({
    pending,
    cycle_id,
    approved_by_name,
    approved_by_pin,
    approved_by_role,
  });
}


export async function rejectPendingPayment({ pending, actor, note } = {}) {
  if (!pending?.id) throw new Error('Missing pending payment id');
  const sb = getSupabaseClient();
  const now = new Date().toISOString();

  // Try a rich update first; fall back to minimal if schema doesn't have columns.
  const rich = {
    status: 'OWED',
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
      .update({ status: 'OWED' })
      .eq('id', pending.id);
    if (e2) throw new Error(normalizeArkaError(e2));
  }

  return { ok: true };
}
// ARKA CLEAN LOCK: accept ONE pending by id, never batch
export async function applyPendingPaymentToCycleSafe({ pending, cycle_id, approved_by_name, approved_by_pin, approved_by_role }) {
  if (!pending?.id) throw new Error('MISSING_PENDING_ID');
  if (!cycle_id) throw new Error('MISSING_CYCLE_ID');
  if (!approved_by_pin) throw new Error('MISSING_APPROVER_PIN');
  // Prefer the existing implementation but ensure it targets this pending row
  const res = await applyPendingPaymentToCycle({
    pending,
    cycle_id,
    approved_by_name: approved_by_name ?? null,
    approved_by_pin: String(approved_by_pin),
    approved_by_role: approved_by_role ?? null,
  });

  if (!res?.ok) {
    throw new Error(normalizeArkaError(res?.error || res?.raw_error || 'Gabim gjatë aprovimit të pagesës.'));
  }

  return res;
}
