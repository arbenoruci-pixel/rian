import { ARKA_PAYMENT_STATUS, normalizeLegacyArkaStatus } from './arkaConstants.js';

export function cleanText(value, fallback = '') {
  const out = String(value ?? '').trim();
  return out || fallback;
}

export function money(value) {
  const n = Number(String(value ?? 0).replace(',', '.'));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

export function positiveMoney(value, label = 'AMOUNT_INVALID') {
  const n = money(value);
  if (!(n > 0)) throw new Error(label);
  return n;
}

export function normalizePin(value) {
  return String(value ?? '').replace(/\D/g, '').trim();
}

export function normalizeDbId(value) {
  if (value == null || value === '') return null;
  const raw = String(value).trim();
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export function normalizeUuid(value) {
  const raw = String(value || '').trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(raw) ? raw : null;
}

export function normalizeTransportCode(value) {
  const raw = String(value || '').replace(/#/g, '').trim().toUpperCase();
  return /^T\d+$/.test(raw) ? raw : null;
}

export function normalizeBaseCode(value) {
  const raw = String(value || '').replace(/#/g, '').trim().toUpperCase();
  if (!raw || raw === '0' || raw.startsWith('T') || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export function normalizeArkaReadStatus(status) {
  return normalizeLegacyArkaStatus(status);
}

export function isReadyForHandoffStatus(status) {
  const s = normalizeArkaReadStatus(status);
  return s === ARKA_PAYMENT_STATUS.PENDING || s === ARKA_PAYMENT_STATUS.COLLECTED;
}

export function isMissingColumnOrFunctionError(error) {
  const msg = String(error?.message || error?.details || error?.hint || error || '').toLowerCase();
  return msg.includes('does not exist') ||
    msg.includes('schema cache') ||
    msg.includes('could not find') ||
    msg.includes('function') && msg.includes('not found');
}

export function round2(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

export function asObject(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}
