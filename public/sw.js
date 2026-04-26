/* LEGACY /sw.js BRIDGE — inert compatibility worker for old controllers. */
/* eslint-disable no-restricted-globals */

const APP_DATA_EPOCH = 'RESET-2026-04-26-VITE-PASTRIMI-BANNER-COMPACT-V18-1';
const APP_VERSION = '2.0.23-vite-pastrimi-banner-compact-v18-1';
const SW_BUILD_LABEL = 'sw-vite-pwa-pastrimi-safe-v17';
const OFFLINE_FALLBACK = '/offline.html';
const LEGACY_OFFLINE_CACHE = 'tepiha-legacy-sw-offline-v17';

function nowIso() {
  try {
    return new Date().toISOString();
  } catch (_) {
    return '';
  }
}

function safeString(value) {
  try {
    return String(value == null ? '' : value);
  } catch (_) {
    return '';
  }
}

function sameOrigin(url) {
  try {
    return new URL(url, self.location.origin).origin === self.location.origin;
  } catch (_) {
    return false;
  }
}

function replyToClient(event, payload) {
  try {
    if (event?.ports?.[0]) {
      event.ports[0].postMessage(payload);
      return;
    }
  } catch (_) {}

  try {
    event?.source?.postMessage?.(payload);
  } catch (_) {}
}

function isProtectedModernCache(cacheName) {
  const key = safeString(cacheName);
  return (
    key.startsWith('tepiha-vite-') ||
    key.startsWith('workbox-') ||
    key.startsWith('vite-') ||
    key.startsWith('assets-')
  );
}

function isLegacyOnlyCache(cacheName) {
  const key = safeString(cacheName);
  if (!key || isProtectedModernCache(key)) return false;

  return (
    key.startsWith('pages-') ||
    key.startsWith('next-data-') ||
    key.startsWith('nextjs-') ||
    key.startsWith('next-') ||
    key.startsWith('tepiha-next-') ||
    key.startsWith('tepiha-legacy-') ||
    key.startsWith('tepiha-sw-legacy-') ||
    key.startsWith('legacy-sw-') ||
    key.startsWith('sw-route-containment') ||
    key.startsWith('sw-pwa-staleness') ||
    key.startsWith('pwa-staleness') ||
    key === LEGACY_OFFLINE_CACHE
  );
}

async function precacheOfflineFallbackOnly() {
  try {
    const cache = await caches.open(LEGACY_OFFLINE_CACHE);
    const response = await fetch(OFFLINE_FALLBACK, {
      credentials: 'same-origin',
      cache: 'no-cache',
    });
    if (response?.ok) await cache.put(OFFLINE_FALLBACK, response.clone());
  } catch (_) {}
}

async function purgeLegacyOnlyCaches() {
  const deleted = [];

  try {
    const keys = await caches.keys();
    await Promise.allSettled(
      (Array.isArray(keys) ? keys : []).map(async (key) => {
        if (!isLegacyOnlyCache(key)) return false;
        try {
          const ok = await caches.delete(key);
          if (ok) deleted.push(key);
          return ok;
        } catch (_) {
          return false;
        }
      }),
    );
  } catch (_) {}

  return deleted;
}

async function offlineFallbackResponse() {
  try {
    const cached = await caches.match(OFFLINE_FALLBACK, { ignoreSearch: true });
    if (cached) return cached;
  } catch (_) {}

  try {
    const response = await fetch(OFFLINE_FALLBACK, {
      credentials: 'same-origin',
      cache: 'no-cache',
    });
    if (response?.ok) return response;
  } catch (_) {}

  return new Response('Offline', {
    status: 503,
    statusText: 'Offline',
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

self.addEventListener('install', (event) => {
  event.waitUntil(precacheOfflineFallbackOnly());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(Promise.resolve({ ok: true, label: SW_BUILD_LABEL, at: nowIso() }));
});

self.addEventListener('message', (event) => {
  const data = event?.data || {};
  const type = safeString(data?.type).trim();

  if (type === 'GET_SW_STATE') {
    replyToClient(event, {
      type: 'SW_STATE',
      label: SW_BUILD_LABEL,
      version: APP_VERSION,
      epoch: APP_DATA_EPOCH,
      controlledByLegacy: true,
      locationHref: safeString(self.location?.href),
      at: nowIso(),
    });
    return;
  }

  if (type === 'PURGE_LEGACY_ONLY_CACHES') {
    event.waitUntil((async () => {
      const deletedCaches = await purgeLegacyOnlyCaches();
      replyToClient(event, {
        type: 'PURGE_LEGACY_ONLY_CACHES_RESULT',
        ok: true,
        label: SW_BUILD_LABEL,
        deletedCaches,
        protectedModernCachesPreserved: true,
        at: nowIso(),
      });
    })());
    return;
  }

  if (type === 'LEGACY_SW_SELF_UNREGISTER') {
    event.waitUntil((async () => {
      let ok = false;
      let error = '';
      try {
        ok = await self.registration.unregister();
      } catch (err) {
        error = safeString(err?.message || err || 'legacy_self_unregister_failed');
      }
      replyToClient(event, {
        type: 'LEGACY_SW_SELF_UNREGISTER_RESULT',
        ok: !!ok,
        label: SW_BUILD_LABEL,
        error,
        noClientReload: true,
        at: nowIso(),
      });
    })());
    return;
  }
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (!request || request.method !== 'GET') return;
  if (request.mode !== 'navigate') return;
  if (!sameOrigin(request.url)) return;

  event.respondWith((async () => {
    try {
      return await fetch(request);
    } catch (_) {
      return offlineFallbackResponse();
    }
  })());
});
