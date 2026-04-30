import { normalizeRole } from './roles';

export const LS_USER = 'CURRENT_USER_DATA';
export const LS_SESSION = 'tepiha_session_v1';
export const LS_TRANSPORT = 'tepiha_transport_session_v1';
export const LEGACY_SESSION_KEYS = ['tepiha_user', 'user', 'tepiha_actor', 'actor', 'transport_actor'];
export const ALL_SESSION_KEYS = [LS_USER, LS_SESSION, LS_TRANSPORT, ...LEGACY_SESSION_KEYS];

function isBrowser() {
  return typeof window !== 'undefined' && typeof localStorage !== 'undefined';
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
  } catch {}
}

export function removeStoredKeys(keys = []) {
  if (!isBrowser()) return;
  for (const key of keys) {
    try { localStorage.removeItem(key); } catch {}
  }
}

export function clearAllSessionState({ preserveTransport = false } = {}) {
  const keys = preserveTransport ? ALL_SESSION_KEYS.filter((key) => key !== LS_TRANSPORT) : ALL_SESSION_KEYS;
  removeStoredKeys(keys);
}

export function normalizeActor(input, fallbackRole = '') {
  if (!input || typeof input !== 'object') return null;
  const role = normalizeRole(input.role || fallbackRole || '');
  const pin = String(input.pin ?? input.transport_pin ?? '').trim();
  const name = String(input.name ?? input.username ?? input.transport_name ?? '').trim();
  const user_id = input.user_id || input.id || null;
  const next = {
    ...input,
    role,
    pin,
    name,
    user_id,
    id: input.id || user_id || null,
  };
  if (!next.transport_id && input.transport_id) next.transport_id = String(input.transport_id);
  if (!next.transport_pin && input.transport_pin) next.transport_pin = String(input.transport_pin);
  return next;
}

export function readMainSession() {
  const raw = readStoredJson(LS_SESSION);
  return raw && typeof raw === 'object' ? raw : null;
}

export function readMainActor() {
  const direct = normalizeActor(readStoredJson(LS_USER));
  if (direct) return direct;
  const session = readMainSession();
  return normalizeActor(session?.actor || session?.user || null);
}

export function readTransportSession() {
  const s = readStoredJson(LS_TRANSPORT);
  if (!s || typeof s !== 'object') return null;
  const transport_id = String(s.transport_id || '').trim();
  const pin = String(s.pin || s.transport_pin || '').trim();
  if (!transport_id && !pin) return null;
  const name = String(s.transport_name || s.name || 'TRANSPORT').trim() || 'TRANSPORT';
  return {
    ...s,
    role: normalizeRole(s.role || 'TRANSPORT') || 'TRANSPORT',
    transport_id: transport_id || pin,
    transport_pin: String(s.transport_pin || s.pin || transport_id || '').trim(),
    pin: pin || String(s.transport_pin || transport_id || '').trim(),
    transport_name: name,
    name,
    user_id: s.user_id || s.id || transport_id || null,
    id: s.id || s.user_id || transport_id || null,
  };
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
  const nextActor = normalizeActor(actor);
  if (!nextActor) return null;
  writeStoredJson(LS_USER, nextActor);
  writeStoredJson(LS_SESSION, { actor: nextActor, user: nextActor, ts: Date.now(), ...extra });
  removeStoredKeys(LEGACY_SESSION_KEYS);
  return nextActor;
}

export function persistTransportSession(payload) {
  const next = readTransportSessionFromPayload(payload);
  if (!next) return null;
  writeStoredJson(LS_TRANSPORT, next);
  removeStoredKeys(['tepiha_actor', 'actor', 'transport_actor']);
  return next;
}

export function readTransportSessionFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const transport_id = String(payload.transport_id || payload.user_id || payload.id || '').trim();
  const transport_pin = String(payload.transport_pin || payload.pin || '').trim();
  if (!transport_id && !transport_pin) return null;
  const name = String(payload.transport_name || payload.name || 'TRANSPORT').trim() || 'TRANSPORT';
  return {
    ...payload,
    role: normalizeRole(payload.role || 'TRANSPORT') || 'TRANSPORT',
    transport_id: transport_id || transport_pin,
    transport_pin: transport_pin || transport_id,
    pin: transport_pin || transport_id,
    transport_name: name,
    name,
    user_id: payload.user_id || payload.id || transport_id || null,
    id: payload.id || payload.user_id || transport_id || null,
    ts: payload.ts || Date.now(),
  };
}
