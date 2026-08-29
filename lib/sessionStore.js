import { normalizeRole } from './roles';
import { normalizeRealPin, resolveActorPin } from './pinIdentity';
import {
  purgeRetiredStaffPinCaches,
  reconcileRetiredStaffActor,
} from './staffIdentityAliases';

export const LS_USER = 'CURRENT_USER_DATA';
export const LS_SESSION = 'tepiha_session_v1';
export const LS_TRANSPORT = 'tepiha_transport_session_v1';
export const LEGACY_SESSION_KEYS = [
  'tepiha_user',
  'user',
  'tepiha_actor',
  'actor',
  'transport_actor',
  'tepiha_current_user_v1',
  'tepiha_user_v1',
  'tepiha_auth_user_v1',
  'tepiha_active_worker_v1',
  'tepiha_staff_user_v1',
];
export const ALL_SESSION_KEYS = [LS_USER, LS_SESSION, LS_TRANSPORT, ...LEGACY_SESSION_KEYS];

function isBrowser() {
  return typeof window !== 'undefined' && typeof localStorage !== 'undefined';
}

function emitSessionChanged(type, detail = {}) {
  if (!isBrowser()) return;
  try {
    window.dispatchEvent(new CustomEvent('tepiha:session-changed', {
      detail: {
        type: String(type || 'session_changed'),
        at: new Date().toISOString(),
        ts: Date.now(),
        ...detail,
      },
    }));
  } catch {}
}

export function safeParseJson(raw) {
  try {
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function readStoredJson(key) {
  if (!isBrowser()) return null;
  try {
    return safeParseJson(localStorage.getItem(key) || '');
  } catch {
    return null;
  }
}

export function writeStoredJson(key, value) {
  if (!isBrowser()) return;
  try {
    localStorage.setItem(key, JSON.stringify(value));
    if (ALL_SESSION_KEYS.includes(String(key || ''))) {
      emitSessionChanged('session_storage_write', { key: String(key || '') });
    }
  } catch {}
}

export function removeStoredKeys(keys = []) {
  if (!isBrowser()) return;
  const removedSessionKeys = [];
  for (const key of keys) {
    try {
      localStorage.removeItem(key);
      if (ALL_SESSION_KEYS.includes(String(key || ''))) removedSessionKeys.push(String(key || ''));
    } catch {}
  }
  if (removedSessionKeys.length) {
    emitSessionChanged('session_storage_remove', { keys: removedSessionKeys });
  }
}

export function clearAllSessionState({ preserveTransport = false } = {}) {
  const keys = preserveTransport ? ALL_SESSION_KEYS.filter((key) => key !== LS_TRANSPORT) : ALL_SESSION_KEYS;
  removeStoredKeys(keys);
}

export function normalizeActor(input, fallbackRole = '') {
  if (!input || typeof input !== 'object') return null;
  const identity = reconcileRetiredStaffActor(input);
  if (identity.status === 'rejected') return null;
  const source = identity.actor || input;
  const role = normalizeRole(source.role || fallbackRole || '');
  const pin = resolveActorPin(source);
  const name = String(source.name ?? source.username ?? source.transport_name ?? '').trim();
  const user_id = source.user_id || source.id || null;
  const next = {
    ...source,
    role,
    pin,
    name,
    user_id,
    id: source.id || user_id || null,
  };
  // Preserve the legacy alias for old modules while making `pin` canonical.
  if (pin) next.pinCode = pin;
  if (!next.transport_id && source.transport_id) next.transport_id = String(source.transport_id);
  if (!next.transport_pin && source.transport_pin) {
    next.transport_pin = normalizeRealPin(source.transport_pin) || String(source.transport_pin).trim();
  }
  return next;
}

function inspectStoredActor(input) {
  const identity = reconcileRetiredStaffActor(input);
  if (identity?.alias && isBrowser()) {
    try { purgeRetiredStaffPinCaches(localStorage, identity.alias.retiredPin); } catch {}
  }
  return identity;
}

function purgeAllSessionsIfRetiredCopyExists() {
  if (!isBrowser()) return false;
  for (const key of ALL_SESSION_KEYS) {
    const raw = readStoredJson(key);
    if (!raw || typeof raw !== 'object') continue;
    const candidates = [raw, raw?.actor, raw?.user]
      .filter((candidate) => candidate && typeof candidate === 'object');
    const identity = candidates
      .map((candidate) => inspectStoredActor(candidate))
      .find((result) => result.status === 'rejected');
    if (!identity) continue;

    // Any retired credential in any cached session copy makes the combined
    // browser session untrustworthy. Do not heal it from another local copy;
    // remove all auth state and require the current PIN at the server again.
    clearAllSessionState();
    emitSessionChanged('retired_pin_session_purged', {
      reason: identity.reason || 'RETIRED_PIN_RELOGIN_REQUIRED',
    });
    return true;
  }
  return false;
}

export function readMainSession() {
  const raw = readStoredJson(LS_SESSION);
  return raw && typeof raw === 'object' ? raw : null;
}

export function readMainActor() {
  if (purgeAllSessionsIfRetiredCopyExists()) return null;
  const directRaw = readStoredJson(LS_USER);
  const session = readMainSession();
  const sessionRaw = session?.actor || session?.user || null;
  const directIdentity = inspectStoredActor(directRaw);
  const sessionIdentity = inspectStoredActor(sessionRaw);
  const direct = directIdentity.status === 'rejected' ? null : normalizeActor(directIdentity.actor);
  const sessionActor = sessionIdentity.status === 'rejected' ? null : normalizeActor(sessionIdentity.actor);

  // A retired PIN is never repaired in browser code because that would expose
  // or bypass the current credential. Clear it and require a fresh login.
  if (directIdentity.status === 'rejected') removeStoredKeys([LS_USER]);
  if (sessionIdentity.status === 'rejected') removeStoredKeys([LS_SESSION]);

  // Prefer the timestamped session record when both copies contain different
  // valid PINs. Old PWA builds could update `tepiha_session_v1` while leaving a
  // stale CURRENT_USER_DATA actor behind; choosing the direct copy first then
  // warmed one worker pool and reserved from another identity.
  let selected = null;
  if (direct?.pin && sessionActor?.pin) {
    selected = direct.pin === sessionActor.pin
      ? { ...direct, ...sessionActor, pin: sessionActor.pin, pinCode: sessionActor.pin }
      : sessionActor;
  } else {
    selected = sessionActor?.pin ? sessionActor : (direct?.pin ? direct : (sessionActor || direct));
  }

  if (selected?.pin && isBrowser()) {
    const directPin = resolveActorPin(directIdentity.actor || {});
    const sessionPin = resolveActorPin(sessionIdentity.actor || {});
    const needsMigration = directPin !== selected.pin
      || sessionPin !== selected.pin
      || String(directRaw?.pin || '').trim() !== selected.pin
      || String(sessionRaw?.pin || '').trim() !== selected.pin;

    if (needsMigration) {
      try {
        writeStoredJson(LS_USER, selected);
        writeStoredJson(LS_SESSION, {
          ...(session && typeof session === 'object' ? session : {}),
          actor: selected,
          user: selected,
          ts: Date.now(),
          migrated_pin_shape_at: new Date().toISOString(),
        });
      } catch {}
    }
  }

  if (selected?.pin) return selected;

  // Last chance for older builds that used one of the legacy keys.
  for (const key of LEGACY_SESSION_KEYS) {
    const raw = readStoredJson(key);
    const legacyRaw = raw?.actor || raw?.user || raw;
    const identity = inspectStoredActor(legacyRaw);
    if (identity.status === 'rejected') {
      removeStoredKeys([key]);
      continue;
    }
    const candidate = normalizeActor(identity.actor);
    if (!candidate?.pin) continue;
    try { persistMainSession(candidate, { migrated_from_legacy_key: key }); } catch {}
    return candidate;
  }

  return selected || null;
}

export function readTransportSession() {
  if (purgeAllSessionsIfRetiredCopyExists()) return null;
  const s = readStoredJson(LS_TRANSPORT);
  if (!s || typeof s !== 'object') return null;
  const identity = inspectStoredActor(s);
  if (identity.status === 'rejected') {
    removeStoredKeys([LS_TRANSPORT]);
    return null;
  }
  const source = identity.actor || s;
  const transport_id = String(source.transport_id || '').trim();
  const pin = String(source.pin || source.transport_pin || '').trim();
  if (!transport_id && !pin) return null;
  const name = String(source.transport_name || source.name || 'TRANSPORT').trim() || 'TRANSPORT';
  const next = {
    ...source,
    role: normalizeRole(source.role || 'TRANSPORT') || 'TRANSPORT',
    transport_id: transport_id || pin,
    transport_pin: String(source.transport_pin || source.pin || transport_id || '').trim(),
    pin: pin || String(source.transport_pin || transport_id || '').trim(),
    transport_name: name,
    name,
    user_id: source.user_id || source.id || transport_id || null,
    id: source.id || source.user_id || transport_id || null,
  };
  return next;
}

export function hasTransportSession() {
  return !!readTransportSession();
}

export function readBestActor({ allowTransportFallback = true } = {}) {
  const main = readMainActor();
  if (main) return main;
  if (!allowTransportFallback) return null;
  const transport = readTransportSession();
  if (!transport) return null;
  return normalizeActor({
    ...transport,
    role: transport.role || 'TRANSPORT',
    pin: transport.pin || transport.transport_pin || '',
    name: transport.name || transport.transport_name || 'TRANSPORT',
    transport_id: transport.transport_id || null,
  }, 'TRANSPORT');
}

export function persistMainSession(actor, extra = {}) {
  const identity = inspectStoredActor(actor);
  if (identity.status === 'rejected') {
    clearAllSessionState();
    return null;
  }
  const nextActor = normalizeActor(identity.actor);
  if (!nextActor) return null;
  writeStoredJson(LS_USER, nextActor);
  writeStoredJson(LS_SESSION, { actor: nextActor, user: nextActor, ts: Date.now(), ...extra });
  removeStoredKeys(LEGACY_SESSION_KEYS);
  emitSessionChanged('main_session_persisted', { pin: nextActor.pin || '', role: nextActor.role || '' });
  return nextActor;
}

export function persistTransportSession(payload) {
  const next = readTransportSessionFromPayload(payload);
  if (!next) return null;
  writeStoredJson(LS_TRANSPORT, next);
  removeStoredKeys(['tepiha_actor', 'actor', 'transport_actor']);
  emitSessionChanged('transport_session_persisted', {
    pin: next.transport_pin || next.pin || '',
    transport_id: next.transport_id || '',
    role: next.role || 'TRANSPORT',
  });
  return next;
}

export function readTransportSessionFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const identity = inspectStoredActor(payload);
  if (identity.status === 'rejected') {
    clearAllSessionState();
    return null;
  }
  const source = identity.actor || payload;
  const transport_id = String(source.transport_id || source.user_id || source.id || '').trim();
  const transport_pin = String(source.transport_pin || source.pin || '').trim();
  if (!transport_id && !transport_pin) return null;
  const name = String(source.transport_name || source.name || 'TRANSPORT').trim() || 'TRANSPORT';
  return {
    ...source,
    role: normalizeRole(source.role || 'TRANSPORT') || 'TRANSPORT',
    transport_id: transport_id || transport_pin,
    transport_pin: transport_pin || transport_id,
    pin: transport_pin || transport_id,
    transport_name: name,
    name,
    user_id: source.user_id || source.id || transport_id || null,
    id: source.id || source.user_id || transport_id || null,
    ts: source.ts || Date.now(),
  };
}
