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

export function buildPastrimiPaymentPinLabel({ code = '', decision = null, destinationLine = '' } = {}) {
  if (!decision?.ok) return '';
  const applied = Number(decision.applied);
  const cashGiven = Number(decision.cashGiven);
  const change = Number(decision.change);
  const remaining = Number(decision.remaining);
  if (![applied, cashGiven, change, remaining].every(Number.isFinite)) return '';

  return `PAGESË NË PASTRIMI\nKODI: ${String(code || '').trim() || '—'}\n\nPAGESË SOT: ${applied.toFixed(2)}€\nKLIENTI DHA: ${cashGiven.toFixed(2)}€\nKUSURI: ${change.toFixed(2)}€\nBORXHI I KLIENTIT PAS: ${remaining.toFixed(2)}€\n${String(destinationLine || '').trim()}\n\n👉 SHKRUAJ PIN-IN TËND PËR TË KRYER PAGESËN:`;
}
