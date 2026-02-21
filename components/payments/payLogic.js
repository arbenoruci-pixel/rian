export function toMoney(n) {
  const x = Number(n || 0);
  return Number.isFinite(x) ? Number(x.toFixed(2)) : 0;
}

/** due = total - paidSoFar */
export function calcDue(total, paidSoFar) {
  return Math.max(0, toMoney(total) - toMoney(paidSoFar));
}

/**
 * Given how much client gave, compute:
 * - applied: how much enters the system (min(given, due))
 * - change: if given > due
 * - remaining: due - applied
 */
export function calcApply({ total, paidSoFar, given }) {
  const due = calcDue(total, paidSoFar);
  const g = Math.max(0, toMoney(given));
  const applied = Math.min(g, due);
  const remaining = toMoney(due - applied);
  const change = g > due ? toMoney(g - due) : 0;
  return { due: toMoney(due), given: toMoney(g), applied: toMoney(applied), remaining, change };
}
