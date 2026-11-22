// Display-only cash preview. The existing atomic handoff remains authoritative
// and applies the bonus once after the meal deduction.
function cents(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? Math.max(0, Math.round((amount + Number.EPSILON) * 100)) : 0;
}
const euro = (value) => value / 100;

export function buildHandoffCashSummary({
  grossTotal = 0,
  baseTotal,
  commissionTotal = 0,
  workerHybrid = false,
  mealDeduct = 0,
  bonusAvailable = 0,
} = {}) {
  const gross = cents(grossTotal);
  const commission = workerHybrid ? Math.min(gross, cents(commissionTotal)) : 0;
  const base = baseTotal == null ? Math.max(0, gross - commission) : cents(baseTotal);
  const meal = cents(mealDeduct);
  const afterMeal = Math.max(0, base - meal);
  const available = cents(bonusAvailable);
  // Mirrors submit_cash_handoff_with_ready_bonus_v1 and the existing client
  // deduction helper: a bonus cannot consume the final cent of a handoff.
  const bonus = Math.min(available, Math.max(0, afterMeal - 1));
  return {
    gross: euro(gross),
    commission: euro(commission),
    baseBeforeDeductions: euro(base),
    mealDeduct: euro(meal),
    afterMeal: euro(afterMeal),
    bonusHeld: euro(bonus),
    bonusRemaining: euro(available - bonus),
    netToDispatch: euro(afterMeal - bonus),
    canSubmit: afterMeal > 0,
  };
}

export function readConfirmedHandoffReceipt(result) {
  if (result?.ok !== true) return null;
  const handoff = result.handoff || result.result?.handoff;
  const bonus = result.readyBonusTotal ?? result.result?.readyBonusTotal;
  const values = [handoff?.amount, bonus];
  if (values.some((value) => !['number', 'string'].includes(typeof value) || String(value).trim() === '' || !Number.isFinite(Number(value)) || Number(value) < 0)) return null;
  return {
    handoffId: String(handoff?.id ?? ''),
    netToDispatch: euro(cents(handoff.amount)),
    bonusHeld: euro(cents(bonus)),
  };
}
