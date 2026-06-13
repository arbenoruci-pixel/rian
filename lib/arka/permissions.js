import { normalizeRole } from '../roles';

// NOTE: Structure only. UI wiring will be done file-by-file later.

export const DEFAULTS = {
  EXPENSE_AUTO_APPROVE_EUR: 10, // <= 10€ puntori e shton vet
};

export function canSeeBudgetTotals(role) {
  return normalizeRole(role) === 'ADMIN';
}

export function canSeeDailyTotal(role) {
  // user asked: worker can see payments list, but not totals.
  // So totals are ADMIN only.
  return normalizeRole(role) === 'ADMIN';
}

export function canAddExpense(role) {
  const r = normalizeRole(role);
  return r === 'ADMIN' || r === 'PUNTOR' || r === 'DISPATCH';
}

export function needsDispatchApprovalForExpense(role, amountCent, cfg = DEFAULTS) {
  const r = normalizeRole(role);
  if (r === 'ADMIN' || r === 'DISPATCH') return false;
  const limitCent = Math.round(Number(cfg.EXPENSE_AUTO_APPROVE_EUR || 0) * 100);
  return Number(amountCent || 0) > limitCent;
}
