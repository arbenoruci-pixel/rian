export const PASTRIMI_PAYMENT_PURPOSE = Object.freeze({
  PREPAY: 'PREPAY_STAYS_PASTRIMI',
  PICKUP_NOW: 'CLIENT_PICKED_UP_TO_DORZIM',
});

function cents(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}
export function buildPastrimiPaymentDecision({ due, cashGiven, purpose } = {}) {
  const dueCents = cents(due);
  const cashCents = cents(cashGiven);
  if (dueCents <= 0) return { ok: false, error: 'ORDER_ALREADY_PAID' };
  if (cashCents <= 0) return { ok: false, error: 'AMOUNT_INVALID' };
  if (!Object.values(PASTRIMI_PAYMENT_PURPOSE).includes(purpose)) {
    return { ok: false, error: 'PAYMENT_PURPOSE_REQUIRED' };
  }

  const appliedCents = Math.min(cashCents, dueCents);
  const remainingCents = dueCents - appliedCents;
  const changeCents = Math.max(0, cashCents - dueCents);
  const pickupNow = purpose === PASTRIMI_PAYMENT_PURPOSE.PICKUP_NOW;
  if (pickupNow && remainingCents !== 0) {
    return {
      ok: false,
      error: 'PICKUP_REQUIRES_FULL_PAYMENT',
      due: dueCents / 100,
      applied: appliedCents / 100,
      remaining: remainingCents / 100,
      change: changeCents / 100,
    };
  }

  return {
    ok: true,
    purpose,
    paymentOutcome: purpose,
    pickupNow,
    due: dueCents / 100,
    cashGiven: cashCents / 100,
    applied: appliedCents / 100,
    remaining: remainingCents / 100,
    change: changeCents / 100,
    settlesFull: remainingCents === 0,
    statusOnFullPayment: pickupNow ? 'dorzim' : 'pastrim',
  };
}
