// lib/deviceApprovalsCache.js
// Offline cache: which (pin, role) is allowed on THIS device.

const LS_APPROVALS = 'tepiha_device_approvals_v1';
const LS_USER = 'CURRENT_USER_DATA';
const LS_SESSION = 'tepiha_session_v1';
const LS_TRANSPORT = 'tepiha_transport_session_v1';

function isBrowser() {
  return typeof window !== 'undefined' && typeof localStorage !== 'undefined';
}

function safeParse(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}

function sameStr(a, b) {
  return String(a ?? '').trim() === String(b ?? '').trim();
}

function sameRole(a, b) {
  return String(a ?? '').trim().toUpperCase() === String(b ?? '').trim().toUpperCase();
}

function readStoredActorFallback() {
  if (!isBrowser()) return null;

  try {
    const raw = localStorage.getItem(LS_USER);
    const u = safeParse(raw, null);
    if (u && typeof u === 'object') return u;
  } catch {}

  try {
    const raw = localStorage.getItem(LS_SESSION);
    const s = safeParse(raw, null);
    const actor = s?.actor || s?.user || null;
    if (actor && typeof actor === 'object') return actor;
  } catch {}

  try {
    const raw = localStorage.getItem(LS_TRANSPORT);
    const t = safeParse(raw, null);
    if (t && typeof t === 'object') {
      return {
        pin: t.transport_pin || t.pin || t.transport_id || null,
        role: t.role || 'TRANSPORT',
        name: t.transport_name || t.name || 'TRANSPORT',
        device_id: t.device_id || null,
      };
    }
  } catch {}

  return null;
}

export function cacheApprovedLogin({ pin, role, deviceId, actor }) {
  if (!isBrowser()) return;
  try {
    const raw = localStorage.getItem(LS_APPROVALS);
    const data = safeParse(raw, { byPin: {} });
    const key = String(pin);
    if (!data.byPin[key]) data.byPin[key] = {};
    data.byPin[key][String(role).toUpperCase()] = {
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
    const rec = data?.byPin?.[String(pin)]?.[String(role).toUpperCase()];
    if (rec && sameStr(rec.deviceId, deviceId)) {
      return { ok: true, actor: rec.actor || null, source: 'approval-cache' };
    }
  } catch {}

  try {
    const actor = readStoredActorFallback();
    if (!actor) return { ok: false };
    if (!sameStr(actor.pin, pin)) return { ok: false };
    if (!sameRole(actor.role, role)) return { ok: false };

    const actorDeviceId = actor.device_id || actor.deviceId || null;
    if (actorDeviceId && !sameStr(actorDeviceId, deviceId)) return { ok: false };

    return { ok: true, actor, source: 'stored-session' };
  } catch {
    return { ok: false };
  }
}
