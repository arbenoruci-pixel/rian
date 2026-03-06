// lib/deviceId.js
// TEPIHA — single source of truth for stable per-device id.

const LS_DEVICE_ID = 'tepiha_device_id_v1';
const COOKIE_DEVICE_ID = 'tepiha_device_id';
const ONE_YEAR = 60 * 60 * 24 * 365;

function isBrowser() {
  return typeof window !== 'undefined' && typeof document !== 'undefined' && typeof localStorage !== 'undefined';
}

function uuid() {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  } catch {}
  const s4 = () => Math.floor((1 + Math.random()) * 0x10000).toString(16).slice(1);
  return `${s4()}${s4()}-${s4()}-${s4()}-${s4()}-${s4()}${s4()}${s4()}`;
}

function readCookie(name) {
  if (!isBrowser()) return null;
  try {
    const parts = String(document.cookie || '').split(';').map((x) => x.trim());
    const hit = parts.find((x) => x.startsWith(name + '='));
    if (!hit) return null;
    return decodeURIComponent(hit.slice(name.length + 1));
  } catch {
    return null;
  }
}

export function syncDeviceIdCookie(deviceId) {
  if (!isBrowser()) return String(deviceId || '');
  const id = String(deviceId || '').trim();
  if (!id) return '';
  try {
    document.cookie = `${COOKIE_DEVICE_ID}=${encodeURIComponent(id)}; path=/; max-age=${ONE_YEAR}; samesite=lax`;
  } catch {}
  return id;
}

export function getDeviceId() {
  if (!isBrowser()) return 'server';
  try {
    let id = String(localStorage.getItem(LS_DEVICE_ID) || '').trim();
    const cookieId = String(readCookie(COOKIE_DEVICE_ID) || '').trim();

    if (!id && cookieId) {
      id = cookieId;
      localStorage.setItem(LS_DEVICE_ID, id);
    }

    if (!id) {
      id = uuid();
      localStorage.setItem(LS_DEVICE_ID, id);
    }

    syncDeviceIdCookie(id);
    return id;
  } catch {
    return 'unknown';
  }
}
