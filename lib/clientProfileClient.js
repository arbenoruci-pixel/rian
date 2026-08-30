import {
  buildClientProfileAnchor,
  clientProfileCacheKey,
} from './clientProfileIdentity.js';

const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const CLIENT_PROFILE_CACHE_PREFIX = 'tepiha_client_profile_v1:';
const CLIENT_INDEX_CACHE_KEY = 'tepiha_clients_index_v1';
const BASE_MASTER_CACHE_KEY = 'tepiha_base_master_cache_v1';
const UPDATE_ENDPOINT = '/api/client-profile';

function clean(value) {
  return String(value ?? '').trim();
}

function stableHash(value) {
  const text = String(value ?? '');
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    first ^= code;
    first = Math.imul(first, 0x01000193);
    second ^= code + index;
    second = Math.imul(second, 0x85ebca6b);
  }
  return `${(first >>> 0).toString(36)}${(second >>> 0).toString(36)}`;
}

export function buildBaseClientProfileIdempotencyKey({
  clientId,
  expectedCode,
  expectedUpdatedAt,
  name,
  phone,
  photoUrl,
} = {}) {
  const identity = [
    clean(clientId).toLowerCase(),
    clean(expectedCode),
    clean(expectedUpdatedAt),
    clean(name).replace(/\s+/g, ' '),
    clean(phone).replace(/[\s()-]+/g, ''),
    clean(photoUrl),
  ].join('\u001f');
  return `BASE_CLIENT_PROFILE_UPDATE_V1:${clean(clientId).toLowerCase()}:${stableHash(identity)}`.slice(0, 240);
}

function clientProfileUpdateError(message, { status = 0, ambiguous = false, idempotencyKey = '' } = {}) {
  const error = new Error(String(message || 'BASE_CLIENT_PROFILE_UPDATE_FAILED'));
  error.code = String(message || 'BASE_CLIENT_PROFILE_UPDATE_FAILED');
  error.status = Number(status || 0);
  error.requestAmbiguous = ambiguous === true;
  error.idempotencyKey = clean(idempotencyKey);
  return error;
}

function invalidateBaseClientProfileCaches(client) {
  if (typeof window === 'undefined') return;
  try {
    const keys = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (key?.startsWith(CLIENT_PROFILE_CACHE_PREFIX)) keys.push(key);
    }
    for (const key of keys) window.localStorage.removeItem(key);
    window.localStorage.removeItem(CLIENT_INDEX_CACHE_KEY);
    window.localStorage.removeItem(BASE_MASTER_CACHE_KEY);
  } catch {}
  try {
    window.dispatchEvent(new CustomEvent('tepiha:base-client-profile:updated', {
      detail: { client: client && typeof client === 'object' ? { ...client } : null },
    }));
  } catch {}
}

async function postBaseClientProfileUpdate(payload, { signal, timeoutMs = 12000 } = {}) {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  let timedOut = false;
  let responseReceived = false;
  const abortFromCaller = () => controller?.abort();
  const timer = controller ? setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, Math.max(1000, Number(timeoutMs || 12000))) : null;
  try { signal?.addEventListener?.('abort', abortFromCaller, { once: true }); } catch {}

  try {
    const response = await fetch(UPDATE_ENDPOINT, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller?.signal || signal,
    });
    responseReceived = true;
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw clientProfileUpdateError(result?.error || `BASE_CLIENT_PROFILE_HTTP_${response.status}`, {
        status: response.status,
        ambiguous: response.status >= 500 || response.status === 408 || response.status === 429,
        idempotencyKey: payload.idempotencyKey,
      });
    }
    if (result?.ok !== true || !result?.client?.id || !result?.client?.updatedAt) {
      throw clientProfileUpdateError(result?.error || 'BASE_CLIENT_PROFILE_UPDATE_NOT_VERIFIED', {
        status: response.status,
        ambiguous: true,
        idempotencyKey: payload.idempotencyKey,
      });
    }
    return result;
  } catch (error) {
    if (typeof error?.requestAmbiguous === 'boolean') throw error;
    if (signal?.aborted && !timedOut) {
      throw clientProfileUpdateError('BASE_CLIENT_PROFILE_UPDATE_ABORTED', {
        ambiguous: false,
        idempotencyKey: payload.idempotencyKey,
      });
    }
    if (error?.name === 'AbortError' && timedOut) {
      throw clientProfileUpdateError('BASE_CLIENT_PROFILE_UPDATE_TIMEOUT', {
        ambiguous: true,
        idempotencyKey: payload.idempotencyKey,
      });
    }
    throw clientProfileUpdateError(error?.message || 'BASE_CLIENT_PROFILE_UPDATE_NETWORK_ERROR', {
      ambiguous: !responseReceived,
      idempotencyKey: payload.idempotencyKey,
    });
  } finally {
    if (timer) clearTimeout(timer);
    try { signal?.removeEventListener?.('abort', abortFromCaller); } catch {}
  }
}

function readCache(key) {
  if (!key || typeof window === 'undefined') return null;
  try {
    const parsed = JSON.parse(window.localStorage.getItem(key) || 'null');
    if (!parsed?.profile || !parsed?.savedAt) return null;
    if ((Date.now() - Number(parsed.savedAt || 0)) > CACHE_MAX_AGE_MS) return null;
    return { ...parsed.profile, offlineSnapshot: true };
  } catch {
    return null;
  }
}

function writeCache(key, profile) {
  if (!key || !profile || typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, JSON.stringify({ savedAt: Date.now(), profile }));
  } catch {}
}

export async function fetchClientProfile(anchorLike, { signal, timeoutMs = 9500, requireFresh = false } = {}) {
  const anchor = buildClientProfileAnchor(anchorLike);
  const cacheKey = clientProfileCacheKey(anchorLike);
  const fallback = readCache(cacheKey);
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    if (!requireFresh && fallback) return { profile: fallback, fromCache: true };
    throw new Error('CLIENT_PROFILE_OFFLINE_NO_CACHE');
  }

  const ownController = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ownController ? window.setTimeout(() => ownController.abort(), timeoutMs) : null;
  const abort = () => ownController?.abort();
  try { signal?.addEventListener?.('abort', abort, { once: true }); } catch {}
  try {
    const response = await fetch('/api/client-profile', {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'GET_PROFILE', ...anchor }),
      signal: ownController?.signal || signal,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.ok !== true || !payload?.profile) {
      const error = new Error(String(payload?.error || `CLIENT_PROFILE_HTTP_${response.status}`));
      error.code = String(payload?.error || 'CLIENT_PROFILE_REQUEST_FAILED');
      error.status = response.status;
      throw error;
    }
    writeCache(cacheKey, payload.profile);
    return { profile: payload.profile, fromCache: false };
  } catch (error) {
    if (!requireFresh && fallback) return { profile: fallback, fromCache: true, networkError: String(error?.code || error?.message || error) };
    throw error;
  } finally {
    if (timer) window.clearTimeout(timer);
    try { signal?.removeEventListener?.('abort', abort); } catch {}
  }
}

export async function updateBaseClientProfile({
  clientId,
  expectedCode,
  expectedUpdatedAt,
  name,
  phone,
  photoUrl = '',
  idempotencyKey = '',
} = {}, { signal, timeoutMs = 12000, retryAmbiguous = true } = {}) {
  const stableIdempotencyKey = clean(idempotencyKey) || buildBaseClientProfileIdempotencyKey({
    clientId,
    expectedCode,
    expectedUpdatedAt,
    name,
    phone,
    photoUrl,
  });
  const payload = {
    action: 'UPDATE_BASE_CLIENT',
    clientId: clean(clientId),
    expectedCode: clean(expectedCode),
    expectedUpdatedAt: clean(expectedUpdatedAt),
    newName: clean(name).replace(/\s+/g, ' '),
    newCanonicalPhone: clean(phone),
    photoUrl: clean(photoUrl),
    idempotencyKey: stableIdempotencyKey,
  };

  const attempts = retryAmbiguous === false ? 1 : 2;
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const result = await postBaseClientProfileUpdate(payload, { signal, timeoutMs });
      const client = {
        id: clean(result.client.id),
        code: clean(result.client.code),
        name: clean(result.client.name),
        phone: clean(result.client.phone) || null,
        photoUrl: clean(result.client.photoUrl) || null,
        updatedAt: clean(result.client.updatedAt),
        idempotencyKey: clean(result.client.idempotencyKey || stableIdempotencyKey),
      };
      invalidateBaseClientProfileCaches(client);
      return { client };
    } catch (error) {
      lastError = error;
      const retry = attempt + 1 < attempts
        && error?.requestAmbiguous === true
        && !signal?.aborted;
      if (!retry) throw error;
      await new Promise((resolve) => setTimeout(resolve, 140));
    }
  }
  throw lastError || clientProfileUpdateError('BASE_CLIENT_PROFILE_UPDATE_FAILED', {
    idempotencyKey: stableIdempotencyKey,
  });
}

export function readCachedClientProfile(anchorLike) {
  return readCache(clientProfileCacheKey(anchorLike));
}

export function clearCachedClientProfile(anchorLike) {
  const key = clientProfileCacheKey(anchorLike);
  if (!key || typeof window === 'undefined') return;
  try { window.localStorage.removeItem(key); } catch {}
}
