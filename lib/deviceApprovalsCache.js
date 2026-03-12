// lib/deviceApprovalsCache.js
// Offline cache: which (pin, role) is allowed on THIS device.

const LS_APPROVALS = 'tepiha_device_approvals_v1';

function isBrowser() {
  return typeof window !== 'undefined' && typeof localStorage !== 'undefined';
}

function safeParse(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}

export function cacheApprovedLogin({ pin, role, deviceId, actor }) {
  if (!isBrowser()) return;
  try {
    const raw = localStorage.getItem(LS_APPROVALS);
    const data = safeParse(raw, { byPin: {} });
    const key = String(pin);
    if (!data.byPin[key]) data.byPin[key] = {};
    data.byPin[key][String(role)] = {
      deviceId: String(deviceId),
      actor,
      ts: Date.now(),
    };
    localStorage.setItem(LS_APPROVALS, JSON.stringify(data));
  } catch {}
}

export function canLoginOffline({ pin, role, deviceId }) {
  if (!isBrowser()) return { ok: false };
  try {
    const raw = localStorage.getItem(LS_APPROVALS);
    const data = safeParse(raw, { byPin: {} });
    const rec = data?.byPin?.[String(pin)]?.[String(role)];
    if (!rec) return { ok: false };
    if (String(rec.deviceId) !== String(deviceId)) return { ok: false };
    return { ok: true, actor: rec.actor || null };
  } catch {
    return { ok: false };
  }
}
