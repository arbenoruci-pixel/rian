// lib/actorSession.js
// TEPIHA — Professional actor / PIN handling
// Single source of truth for "who is operating this device right now".
// Stored in localStorage under CURRENT_USER_DATA.

const LS_USER = 'CURRENT_USER_DATA';

function isBrowser() {
  return typeof window !== 'undefined' && typeof localStorage !== 'undefined';
}

export function getActor() {
  if (!isBrowser()) return null;
  try {
    const raw = localStorage.getItem(LS_USER);
    const u = raw ? JSON.parse(raw) : null;
    if (!u || typeof u !== 'object') return null;
    const pin = String(u.pin ?? '').trim();
    const name = String(u.name ?? '').trim();
    const role = String(u.role ?? '').trim();
    return { ...u, pin, name, role };
  } catch {
    return null;
  }
}

export function requireActorPin() {
  const a = getActor();
  const pin = String(a?.pin ?? '').trim();
  if (!pin) {
    const err = new Error('MISSING_PIN');
    err.code = 'MISSING_PIN';
    throw err;
  }
  return a;
}

// Convenience payload for API calls / DB audit fields
export function actorPayload(action) {
  const a = getActor();
  return {
    actor_pin: a?.pin || null,
    actor_name: a?.name || null,
    actor_role: a?.role || null,
    actor_action: action || null,
  };
}
