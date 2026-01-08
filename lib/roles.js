// Shared roles for TEPIHA
export const ROLES = ['ADMIN', 'PUNTOR', 'TRANSPORT', 'DISPATCH'];

export function normalizeRole(role) {
  return String(role || '').trim().toUpperCase();
}

export function isAdmin(role) {
  return normalizeRole(role) === 'ADMIN';
}
