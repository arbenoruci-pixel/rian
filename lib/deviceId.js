// lib/deviceId.js
// TEPIHA — stable per-device id (offline-safe)

const LS_DEVICE_ID = 'tepiha_device_id_v1';

function isBrowser() {
  return typeof window !== 'undefined' && typeof localStorage !== 'undefined';
}

function uuid() {
  // RFC4122 v4-ish
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  } catch {}
  const s4 = () => Math.floor((1 + Math.random()) * 0x10000).toString(16).slice(1);
  return `${s4()}${s4()}-${s4()}-${s4()}-${s4()}-${s4()}${s4()}${s4()}`;
}

export function getDeviceId() {
  if (!isBrowser()) return 'server';
  try {
    let id = localStorage.getItem(LS_DEVICE_ID);
    if (!id) {
      id = uuid();
      localStorage.setItem(LS_DEVICE_ID, id);
    }
    return String(id);
  } catch {
    return 'unknown';
  }
}
