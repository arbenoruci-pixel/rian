// Shared roles for TEPIHA
// NOTE: DISPATCH is treated as an approver/admin for expense approvals,
// but ONLY DISPATCH can mark cycles as RECEIVED.
export const ROLES = ['ADMIN_MASTER', 'ADMIN', 'PUNTOR', 'TRANSPORT', 'DISPATCH'];

export function normalizeRole(role) {
  return String(role || '').trim().toUpperCase();
}

export function isAdmin(role) {
  const r = normalizeRole(role);
  return r === 'ADMIN' || r === 'ADMIN_MASTER' || r === 'DISPATCH';
}

export function isDispatch(role) {
  return normalizeRole(role) === 'DISPATCH';
}
