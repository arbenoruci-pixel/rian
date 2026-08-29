// Shared roles for TEPIHA
// DISPATCH remains an elevated operational role and is treated as admin-level
// for route access / approvals / transport admin views.

export const ADMIN_ROLES = ['SUPERADMIN', 'OWNER', 'PRONAR', 'ADMIN_MASTER', 'ADMIN', 'DISPATCH'];
export const ROLES = [...ADMIN_ROLES, 'PUNTOR', 'TRANSPORT'];

// Staff and device administration is more sensitive than operational route
// access. DISPATCH deliberately remains in ADMIN_ROLES for transport/Arka
// workflows, but it must never be treated as a staff-identity administrator.
export const STAFF_ADMIN_ROLES = ['SUPERADMIN', 'OWNER', 'PRONAR', 'ADMIN_MASTER', 'ADMIN'];

const STAFF_ROLE_RANKS = Object.freeze({
  SUPERADMIN: 50,
  OWNER: 40,
  PRONAR: 40,
  ADMIN_MASTER: 30,
  MASTER: 30,
  'MASTER USER': 30,
  MASTER_USER: 30,
  ADMIN: 20,
  DISPATCH: 10,
  PUNTOR: 0,
  PUNETOR: 0,
  WORKER: 0,
  BAZIST: 0,
  BASE: 0,
  TRANSPORT: 0,
});

export function normalizeRole(role) {
  return String(role || '').trim().toUpperCase();
}

export function isAdmin(role) {
  return ADMIN_ROLES.includes(normalizeRole(role));
}

export function isStaffAdmin(role) {
  return STAFF_ADMIN_ROLES.includes(normalizeRole(role));
}

export function staffRoleRank(role) {
  const normalized = normalizeRole(role);
  return Object.prototype.hasOwnProperty.call(STAFF_ROLE_RANKS, normalized)
    ? STAFF_ROLE_RANKS[normalized]
    : -1;
}

export function isDispatch(role) {
  return normalizeRole(role) === 'DISPATCH';
}

export function canAccessTransportAdmin(role) {
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
