// Shared roles for TEPIHA
// DISPATCH remains an elevated operational role and is treated as admin-level
// for route access / approvals / transport admin views.

export const ADMIN_ROLES = ['SUPERADMIN', 'OWNER', 'PRONAR', 'ADMIN_MASTER', 'ADMIN', 'DISPATCH'];
export const ROLES = [...ADMIN_ROLES, 'PUNTOR', 'TRANSPORT'];

export function normalizeRole(role) {
  return String(role || '').trim().toUpperCase();
}

export function isAdmin(role) {
  return ADMIN_ROLES.includes(normalizeRole(role));
}

export function isDispatch(role) {
  return normalizeRole(role) === 'DISPATCH';
}

export function canAccessTransportAdmin(role) {
  return isAdmin(role);
}

export function canAutoApproveDevice(role) {
  return isAdmin(role);
}

export function rolesCompatible(requestedRole, userRole) {
  const req = normalizeRole(requestedRole);
  const actual = normalizeRole(userRole);
  if (!req || !actual) return false;
  if (req === actual) return true;
  const adminPair = new Set(['ADMIN', 'ADMIN_MASTER']);
  return adminPair.has(req) && adminPair.has(actual);
}
