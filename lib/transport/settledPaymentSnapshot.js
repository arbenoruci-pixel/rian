// Keep settled Transport payment/fulfillment fields authoritative during
// a stale mobile-board update.  The database ledger trigger is the final guard;
// this protects the phone's optimistic/offline mirror as well.
const COMPLETE = new Set(['done', 'completed', 'delivered', 'dorzuar', 'dorezuar', 'dorëzuar']);
const CANCEL = new Set(['cancelled', 'canceled', 'anuluar', 'annulled']);
const PAYMENT_KEYS = ['euro', 'total', 'paid', 'arkaRecordedPaid', 'debt', 'method', 'last_paid_at'];
const ORDER_FINANCE_KEYS = [
  'paid', 'clientPaid', 'debt', 'paid_done', 'isPaid', 'payment_state',
  'delivery_payment_status', 'delivery_with_debt', 'debt_amount',
  'paid_at', 'delivered_at', 'done_at', 'completed_at',
  'delivered_by_pin', 'delivered_by_name',
];

function asRecord(v) {
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

function status(v) {
  return String(v || '').trim().toLowerCase();
}

function hasOwn(record, key) {
  return Object.prototype.hasOwnProperty.call(record, key);
}

/**
 * The Supabase row is already fully paid and completed. Keep its confirmed
 * finance fields when a stale phone submits an unrelated status/data patch.
 * Never override explicit cancellation or the pre-existing manual exception.
 */
export function preserveSettledTransportOrderPatch(authoritativeRow, candidatePatch = {}) {
  const remote = asRecord(authoritativeRow);
  const data = asRecord(remote.data);
  const savedPay = asRecord(data.pay);
  const total = Number(savedPay.euro ?? savedPay.total ?? 0);
  const paid = Number(savedPay.paid ?? 0);
  if (!COMPLETE.has(status(remote.status))
      || data.paid_done !== true
      || !Number.isFinite(total) || total <= 0
      || !Number.isFinite(paid) || paid + 0.005 < total) {
    return candidatePatch;
  }

  const patch = asRecord(candidatePatch);
  const patchData = asRecord(patch.data);
  if (CANCEL.has(status(patch.status))
      || patchData.manual_status_override === 'PAID_NOT_PICKED_UP') {
    return candidatePatch;
  }

  const safe = { ...patch };
  if (hasOwn(safe, 'status') && !COMPLETE.has(status(safe.status))) {
    safe.status = remote.status;
  }

  if (hasOwn(patch, 'data') && patch.data && typeof patch.data === 'object'
      && !Array.isArray(patch.data)) {
    const nextData = { ...patchData };
    const nextPay = { ...asRecord(patchData.pay) };
    for (const key of PAYMENT_KEYS) {
      if (hasOwn(savedPay, key)) nextPay[key] = savedPay[key];
    }
    nextData.pay = nextPay;
    nextData.status = 'done';
    nextData.state = 'done';
    for (const key of ORDER_FINANCE_KEYS) {
      if (hasOwn(data, key)) nextData[key] = data[key];
    }
    safe.data = nextData;
  }

  return safe;
}
