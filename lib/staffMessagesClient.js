import { readBestActor } from './sessionStore.js';

const cache = new Map();
const inFlight = new Map();
const generations = new Map();
const CACHE_MS = 60000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const errors = {
  AUTH_REQUIRED: 'Hyr përsëri për t’i hapur mesazhet.',
  DEVICE_NOT_APPROVED: 'Pajisja duhet të jetë e aprovuar.',
  STAFF_MESSAGE_FORBIDDEN: 'Nuk ke qasje për këtë veprim.',
  STAFF_MESSAGE_SESSION_CHANGED: 'Llogaria ndryshoi. Hapi mesazhet përsëri.',
  STAFF_MESSAGE_RECIPIENT_INVALID: 'Lista e punëtorëve ndryshoi. Rifreskoje dhe zgjidhi përsëri.',
  STAFF_MESSAGE_RECIPIENTS_UNAVAILABLE: 'Lista e punëtorëve nuk u ngarkua. Provo përsëri.',
  STAFF_MESSAGE_IDEMPOTENCY_CONFLICT: 'Ky dërgim është regjistruar me përmbajtje tjetër. Kontrollo mesazhet e dërguara.',
  STAFF_MESSAGE_RATE_LIMIT: 'Ke dërguar shumë mesazhe gjatë orës së fundit. Provo më vonë.',
  STAFF_MESSAGE_BODY_INVALID: 'Kontrollo titullin, mesazhin dhe marrësit.',
  STAFF_MESSAGE_NOT_FOUND: 'Ky mesazh nuk është në llogarinë tënde.',
};

export function readStaffMessagesActor() {
  const actor = readBestActor();
  return actor && UUID_RE.test(String(actor.id || actor.user_id || ''))
    ? { id: String(actor.id || actor.user_id), role: String(actor.role || ''), name: String(actor.name || '') }
    : null;
}
export const staffMessagesIdentity = actor => actor?.id ? actor.id + ':' + String(actor.role || '').toUpperCase() : '';

function requestError(code, httpStatus = 0) {
  const error = new Error(errors[code] || 'Mesazhet nuk u përditësuan. Kontrollo lidhjen dhe provo përsëri.');
  error.code = code;
  error.httpStatus = httpStatus;
  return error;
}

export function clearStaffMessagesCache(identity = '') {
  if (!identity) { cache.clear(); for (const key of generations.keys()) generations.set(key, (generations.get(key) || 0) + 1); return; }
  for (const key of cache.keys()) if (key.startsWith(identity + '|')) cache.delete(key);
  generations.set(identity, (generations.get(identity) || 0) + 1);
}

export async function staffMessagesRequest(input, { force = false } = {}) {
  const actor = readStaffMessagesActor();
  const identity = staffMessagesIdentity(actor);
  if (!identity) throw requestError('AUTH_REQUIRED', 401);
  const readOnly = ['badge', 'list', 'recipients'].includes(input.action);
  const cacheKey = identity + '|' + JSON.stringify(input);
  const generation = generations.get(identity) || 0;
  const cached = cache.get(cacheKey);
  if (readOnly && !force && cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  if (readOnly && inFlight.has(cacheKey)) return inFlight.get(cacheKey);
  const promise = (async () => {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new Error('Je pa internet. Mesazhi mbetet i shkruar; dërgoje kur të lidhet interneti.');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch('/api/staff-messages', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...input, expectedActorId: actor.id }),
      });
      const data = await response.json();
      if (!response.ok || !data?.ok) {
        if ([401, 403].includes(response.status)) clearStaffMessagesCache(identity);
        throw requestError(data?.error || 'STAFF_MESSAGE_REQUEST_FAILED', response.status);
      }
      if (identity !== staffMessagesIdentity(readStaffMessagesActor()) || generation !== (generations.get(identity) || 0)) {
        clearStaffMessagesCache(identity);
        throw requestError('STAFF_MESSAGE_SESSION_CHANGED', 403);
      }
      if (readOnly) {
        cache.set(cacheKey, { at: Date.now(), value: data });
        while (cache.size > 20) cache.delete(cache.keys().next().value);
      } else {
        for (const key of cache.keys()) if (key.startsWith(identity + '|')) cache.delete(key);
        if (typeof window !== 'undefined') window.dispatchEvent(new Event('tepiha:staff-messages-changed'));
      }
      return data;
    } catch (error) {
      if (error?.code || error?.httpStatus || typeof navigator !== 'undefined' && navigator.onLine === false) throw error;
      const uncertain = new Error(input.action === 'send'
        ? 'Dërgimi nuk u konfirmua. Provo përsëri me të njëjtin mesazh; sistemi e ruan vetëm një herë.'
        : 'Mesazhet nuk u ngarkuan. Provo përsëri.');
      uncertain.code = 'STAFF_MESSAGE_CONNECTION_FAILED';
      throw uncertain;
    } finally { clearTimeout(timer); }
  })();
  if (readOnly) inFlight.set(cacheKey, promise);
  try { return await promise; } finally { if (inFlight.get(cacheKey) === promise) inFlight.delete(cacheKey); }
}

export function newStaffMessageRequestKey() {
  if (typeof crypto?.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const value = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return [value.slice(0, 8), value.slice(8, 12), value.slice(12, 16), value.slice(16, 20), value.slice(20)].join('-');
}

export function openStaffMessages() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('tepiha:open-staff-messages'));
}
