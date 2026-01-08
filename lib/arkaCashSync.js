import { supabase } from '@/lib/supabaseClient';
import { dbGetActiveCycle, dbHasPendingHanded, dbAddCycleMove } from '@/lib/arkaDb';

/*
  CASH PAYMENTS — ALWAYS WORK

  - If there is an OPEN cycle and NO pending HANDED cycle: write IN/OUT directly to arka_cycle_moves.
  - If ARKA is not OPEN (or there is a HANDED awaiting DISPATCH): save as WAITING/PENDING.
  - CashClient (ARKA DITORE) will force a mandatory popup on OPEN to confirm all WAITING payments.

  NOTE:
  We try Supabase table `arka_pending_payments` first. If it doesn't exist / no access,
  we fall back to a localStorage queue so payments are never lost.
*/

const LS_PENDING_KEY = 'arka_pending_payments_v1';

function lsRead() {
  try {
    const raw = localStorage.getItem(LS_PENDING_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function lsWrite(arr) {
  try {
    localStorage.setItem(LS_PENDING_KEY, JSON.stringify(arr));
  } catch {}
}

function lsPush(item) {
  const arr = lsRead();
  arr.unshift(item);
  lsWrite(arr.slice(0, 500));
}

async function pendingTableOk() {
  // very cheap check; if RLS blocks select, it might error — treat as not ok
  const { error } = await supabase.from('arka_pending_payments').select('id').limit(1);
  return !error;
}

export async function createPendingCashPayment(payload = {}) {
  const now = new Date().toISOString();
  const external_id = payload.externalId || payload.external_id || `pend_${Date.now()}_${Math.random().toString(16).slice(2)}`;

  const row = {
    external_id,
    status: 'PENDING',
    amount: Number(payload.amount || 0),
    type: String(payload.type || 'IN').toUpperCase(),
    method: String(payload.method || 'cash').toUpperCase(),
    order_id: payload.orderId || payload.order_id || null,
    order_code: payload.code || payload.order_code || null,
    client_name: payload.name || payload.client_name || null,
    note: payload.note || '',
    created_by_pin: payload.createdByPin || payload.created_by_pin || payload.user_pin || null,
    created_by_name: payload.createdBy || payload.created_by || payload.user || null,
    created_at: now,
  };

  // prefer Supabase
  try {
    const ok = await pendingTableOk();
    if (ok) {
      // idempotency by external_id
      const ex = await supabase.from('arka_pending_payments').select('*').eq('external_id', external_id).maybeSingle();
      if (!ex.error && ex.data?.id) return { ok: true, pending: true, row: ex.data };

      const ins = await supabase.from('arka_pending_payments').insert(row).select('*').single();
      if (!ins.error) return { ok: true, pending: true, row: ins.data };
    }
  } catch {
    // ignore, fallback to LS
  }

  // fallback local queue
  lsPush({ ...row, _local: true });
  return { ok: true, pending: true, local: true, row };
}

/**
 * recordCashMove(payload)
 *
 * IMPORTANT: never throws; returns ok=true even when saved as PENDING.
 */
export async function recordCashMove(payload = {}) {
  const amt = Number(payload.amount || 0);
  if (!Number.isFinite(amt) || amt <= 0) return { ok: false, skipped: true };

  const externalId = payload.externalId || payload.external_id || `cash_${Date.now()}_${Math.random().toString(16).slice(2)}`;

  try {
    const hasHanded = await dbHasPendingHanded();
    const cycle = await dbGetActiveCycle();

    // if ARKA can't accept direct cash (no OPEN cycle or pending HANDED) => PENDING
    if (!cycle?.id || hasHanded) {
      return await createPendingCashPayment({ ...payload, externalId, amount: amt });
    }

    // write directly to OPEN cycle
    await dbAddCycleMove({
      cycle_id: cycle.id,
      type: String(payload.type || 'IN').toUpperCase(),
      amount: amt,
      note: payload.note || '',
      source: payload.source || 'ORDER_PAY',
      created_by: payload.createdBy || payload.created_by || payload.user || 'LOCAL',
      external_id: externalId,
    });

    return { ok: true, direct: true };
  } catch (e) {
    // last resort: don't block payment, save as pending (LS fallback possible)
    try {
      return await createPendingCashPayment({ ...payload, externalId, amount: amt, err: String(e?.message || e) });
    } catch {
      lsPush({ ...payload, external_id: externalId, amount: amt, status: 'PENDING', _local: true, err: String(e?.message || e) });
      return { ok: true, pending: true, local: true };
    }
  }
}

// ---------- Helpers for ARKA/CASH (CashClient) ----------

export async function listPendingCashPayments(limit = 200) {
  // Supabase first
  try {
    const ok = await pendingTableOk();
    if (ok) {
      const q = await supabase
        .from('arka_pending_payments')
        .select('*')
        .eq('status', 'PENDING')
        .order('created_at', { ascending: true })
        .limit(limit);
      if (!q.error) return { ok: true, items: q.data || [], source: 'supabase' };
    }
  } catch {}

  // fallback local
  const local = lsRead().filter((x) => String(x.status).toUpperCase() === 'PENDING');
  return { ok: true, items: local.slice(0, limit), source: 'local' };
}

export async function applyPendingPaymentToCycle({ pending, cycle_id, approved_by_pin, approved_by_name, approved_by_role }) {
  if (!pending) throw new Error('pending missing');
  if (!cycle_id) throw new Error('cycle_id missing');

  const external_id = pending.external_id || pending.externalId;
  const amt = Number(pending.amount || 0);
  if (!Number.isFinite(amt) || amt <= 0) throw new Error('amount invalid');

  // create IN/OUT move in cycle
  await dbAddCycleMove({
    cycle_id,
    type: String(pending.type || 'IN').toUpperCase(),
    amount: amt,
    note: pending.note || '',
    source: pending.source || 'ORDER_PAY',
    created_by: approved_by_name || 'APPROVER',
    external_id: external_id ? `pending:${external_id}` : null,
  });

  // mark pending as applied
  try {
    const ok = await pendingTableOk();
    if (ok && external_id) {
      await supabase
        .from('arka_pending_payments')
        .update({
          status: 'APPLIED',
          applied_at: new Date().toISOString(),
          applied_cycle_id: cycle_id,
          approved_by_pin: approved_by_pin || null,
          approved_by_name: approved_by_name || null,
          approved_by_role: approved_by_role || null,
        })
        .eq('external_id', external_id);
      return { ok: true, applied: true, source: 'supabase' };
    }
  } catch {
    // ignore
  }

  // local fallback
  const arr = lsRead();
  const next = arr.map((x) => {
    if (external_id && x.external_id === external_id) {
      return { ...x, status: 'APPLIED', applied_at: new Date().toISOString(), applied_cycle_id: cycle_id, approved_by_pin, approved_by_name, approved_by_role };
    }
    return x;
  });
  lsWrite(next);
  return { ok: true, applied: true, source: 'local' };
}

export async function rejectPendingPayment({ pending, rejected_by_pin, rejected_by_name, rejected_by_role, reject_note }) {
  const external_id = pending?.external_id || pending?.externalId;
  if (!external_id) {
    // local-only item without external id
    const arr = lsRead();
    lsWrite(arr.filter((x) => x !== pending));
    return { ok: true, rejected: true, source: 'local' };
  }

  try {
    const ok = await pendingTableOk();
    if (ok) {
      await supabase
        .from('arka_pending_payments')
        .update({
          status: 'REJECTED',
          rejected_at: new Date().toISOString(),
          rejected_by_pin: rejected_by_pin || null,
          rejected_by_name: rejected_by_name || null,
          rejected_by_role: rejected_by_role || null,
          reject_note: reject_note || null,
        })
        .eq('external_id', external_id);
      return { ok: true, rejected: true, source: 'supabase' };
    }
  } catch {}

  // local fallback
  const arr = lsRead();
  const next = arr.map((x) => (x.external_id === external_id ? { ...x, status: 'REJECTED', reject_note, rejected_by_pin, rejected_by_name, rejected_by_role } : x));
  lsWrite(next);
  return { ok: true, rejected: true, source: 'local' };
}
