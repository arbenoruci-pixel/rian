/* LEGACY /sw.js BRIDGE — inert compatibility worker for old controllers. */
/* eslint-disable no-restricted-globals */

const APP_DATA_EPOCH = 'RESET-2026-04-27-VITE-UPDATE-QUARANTINE-V29';
const APP_VERSION = '2.0.48-pwa-auto-update-v3-black-screen-guard-legacy-bridge';
const SW_BUILD_LABEL = 'sw-pwa-auto-update-v3-black-screen-guard-legacy-bridge';
const OFFLINE_FALLBACK = '/offline.html';
const LEGACY_OFFLINE_CACHE = 'tepiha-legacy-sw-offline-v19';

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
  return [];
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


const AUTO_UPDATE_RELOAD_PARAM = '__tepiha_pwa_auto_update_reload';
const AUTO_UPDATE_PREPARE_MESSAGE = 'TEPIHA_PWA_AUTO_UPDATE_PREPARE_RELOAD';
const AUTO_UPDATE_RELOAD_MESSAGE = 'TEPIHA_PWA_AUTO_UPDATE_RELOAD_NOW';
const AUTO_UPDATE_CLIENT_RELOAD_DELAY_MS = 900;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms || 0))));
}

function autoUpdateNavigationUrl(rawUrl) {
  try {
    const u = new URL(rawUrl || '/', self.location.origin);
    if (u.origin !== self.location.origin) return '';
    u.searchParams.set(AUTO_UPDATE_RELOAD_PARAM, String(Date.now()));
    return u.href;
  } catch (_) {
    return self.location.origin + '/?' + AUTO_UPDATE_RELOAD_PARAM + '=' + Date.now();
  }
}

async function notifyClientsAndNavigateForAutoUpdate(reason) {
  try {
    if (!self.clients?.matchAll) return { count: 0, skipped: true };
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const payload = {
      type: AUTO_UPDATE_PREPARE_MESSAGE,
      reason: safeString(reason || 'legacy_bridge_activate'),
      swVersion: APP_VERSION,
      swEpoch: APP_DATA_EPOCH,
      swBuildLabel: SW_BUILD_LABEL,
      at: nowIso(),
      ts: Date.now(),
      localDraftShouldSnapshot: true,
      outboxPreserved: true,
      noBusinessStorageDelete: true,
      noCacheDelete: true,
      noSwUnregister: true,
    };
    for (const client of list || []) {
      try { client.postMessage(payload); } catch (_) {}
    }
    await delay(AUTO_UPDATE_CLIENT_RELOAD_DELAY_MS);
    let navigated = 0;
    for (const client of list || []) {
      try {
        const nextUrl = autoUpdateNavigationUrl(client?.url || '/');
        if (nextUrl && typeof client?.navigate === 'function') {
          await client.navigate(nextUrl);
          navigated += 1;
        } else {
          client?.postMessage?.({ ...payload, type: AUTO_UPDATE_RELOAD_MESSAGE });
        }
      } catch (_) {}
    }
    return { count: Array.isArray(list) ? list.length : 0, navigated, skipped: false };
  } catch (_) {
    return { count: 0, skipped: true, error: true };
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    await precacheOfflineFallbackOnly();
    try { await self.skipWaiting(); } catch (_) {}
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try { if (self.clients?.claim) await self.clients.claim(); } catch (_) {}
    const result = await notifyClientsAndNavigateForAutoUpdate('legacy_bridge_activate_clients_claim');
    return { ok: true, label: SW_BUILD_LABEL, result, at: nowIso(), noCacheDelete: true, noSwUnregister: true };
  })());
});

self.addEventListener('message', (event) => {
  const data = event?.data || {};
  const type = safeString(data?.type).trim();

  if (type === 'SKIP_WAITING') {
    try { event?.waitUntil?.(Promise.resolve(self.skipWaiting()).catch(() => {})); } catch (_) { try { self.skipWaiting(); } catch (__) {} }
    replyToClient(event, { type: 'SKIP_WAITING_RESULT', ok: true, label: SW_BUILD_LABEL, at: nowIso(), noCacheDelete: true, noSwUnregister: true });
    return;
  }

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
    replyToClient(event, {
      type: 'PURGE_LEGACY_ONLY_CACHES_RESULT',
      ok: false,
      skipped: true,
      label: SW_BUILD_LABEL,
      reason: 'update_flow_quarantine_v29_no_cache_delete',
      protectedModernCachesPreserved: true,
      at: nowIso(),
    });
    return;
  }

  if (type === 'LEGACY_SW_SELF_UNREGISTER') {
    replyToClient(event, {
      type: 'LEGACY_SW_SELF_UNREGISTER_RESULT',
      ok: false,
      skipped: true,
      label: SW_BUILD_LABEL,
      reason: 'update_flow_quarantine_v29_no_sw_unregister',
      noClientReload: true,
      at: nowIso(),
    });
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
