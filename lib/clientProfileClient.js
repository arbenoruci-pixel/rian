import {
  buildClientProfileAnchor,
  clientProfileCacheKey,
} from './clientProfileIdentity.js';

const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

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

export function readCachedClientProfile(anchorLike) {
  return readCache(clientProfileCacheKey(anchorLike));
}

export function clearCachedClientProfile(anchorLike) {
  const key = clientProfileCacheKey(anchorLike);
  if (!key || typeof window === 'undefined') return;
  try { window.localStorage.removeItem(key); } catch {}
}
