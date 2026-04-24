import { normalizeStatusForTable } from '@/lib/statusEngine';

export function stringOrEmpty(value) {
  return String(value ?? '').trim();
}

export function parseJsonBodySafe(req) {
  return req.json().catch(() => ({}));
}

export function requireFields(map) {
  const missing = Object.entries(map || {})
    .filter(([, value]) => value === undefined || value === null || String(value).trim() === '')
    .map(([key]) => key);
  if (missing.length) {
    const error = new Error(`MISSING_FIELDS:${missing.join(',')}`);
    error.code = 'MISSING_FIELDS';
    error.fields = missing;
    throw error;
  }
  return true;
}

export function normalizePin(value, { min = 3, max = 12, digitsOnly = false } = {}) {
  const pin = stringOrEmpty(value);
  if (!pin) return null;
  if (pin.length < min || pin.length > max) return null;
  if (digitsOnly && !/^\d+$/.test(pin)) return null;
  return pin;
}

export function normalizeDeviceId(value) {
  const id = stringOrEmpty(value);
  if (!id || id.length < 6) return null;
  return id;
}

export function normalizeRole(value) {
  const role = stringOrEmpty(value).toUpperCase();
  return role || null;
}

export function validateOrderStatus(table, status, allowed = []) {
  const nextStatus = normalizeStatusForTable(table, status);
  if (!nextStatus) return null;
  if (Array.isArray(allowed) && allowed.length && !allowed.includes(nextStatus)) return null;
  return nextStatus;
}

export function normalizeBoolean(value) {
  if (value === true || value === false) return value;
  const raw = stringOrEmpty(value).toLowerCase();
  if (!raw) return false;
  return ['1', 'true', 'yes', 'po', 'on'].includes(raw);
}
