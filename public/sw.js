/* ACTIVE SERVICE WORKER SOURCE OF TRUTH (Vite public asset) */
/* eslint-disable no-restricted-globals */

const APP_DATA_EPOCH = (() => {
  try {
    return String(new URL(self.location.href).searchParams.get('epoch') || 'dev-local').trim() || 'dev-local';
  } catch {
    return 'dev-local';
  }
})();

const VERSION = APP_DATA_EPOCH;
const STATIC_CACHE = `assets-${VERSION}`;
const SW_BUILD_LABEL = 'sw-vite-core-eager-v8';
const OFFLINE_FALLBACK = '/offline.html';
const PRECACHE_URLS = [
  OFFLINE_FALLBACK,
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/apple-touch-icon.png',
  '/favicon.ico',
];

function isSameOrigin(url) {
  try {
    return new URL(url, self.location.origin).origin === self.location.origin;
  } catch {
    return false;
  }
}

function normalizePath(input) {
  try {
    const url = new URL(input, self.location.origin);
    return `${url.pathname}${url.search}`;
  } catch {
    return String(input || '').trim();
  }
}

function isStaticAssetPath(pathname = '') {
  const path = String(pathname || '');
  if (!path) return false;
  if (path === OFFLINE_FALLBACK) return true;
  if (path === '/manifest.json') return true;
  if (path === '/favicon.ico') return true;
  if (path === '/icon-192.png') return true;
  if (path === '/icon-512.png') return true;
  if (path === '/apple-touch-icon.png') return true;
  if (path.startsWith('/_next/static/')) return true;
  if (path.startsWith('/assets/')) return true;
  return /\.(?:js|css|mjs|png|jpg|jpeg|webp|svg|ico|woff2?|ttf|otf|eot|json|txt|webmanifest)$/i.test(path);
}

async function putIfOk(cacheName, request, response) {
  try {
    if (!response || !response.ok) return;
    const cache = await caches.open(cacheName);
    await cache.put(request, response.clone());
  } catch (_) {}
}

async function purgeOldCaches() {
  try {
    const keys = await caches.keys();
    await Promise.allSettled(
      keys.map((key) => {
        if (key.startsWith('pages-')) return caches.delete(key);
        if (key.startsWith('next-data-')) return caches.delete(key);
        if (key.startsWith('vite-')) return caches.delete(key);
        if (key.startsWith('tepiha-')) return caches.delete(key);
        if (key.startsWith('assets-') && key !== STATIC_CACHE) return caches.delete(key);
        return Promise.resolve(false);
      })
    );
  } catch (_) {}
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    try {
      const cache = await caches.open(STATIC_CACHE);
      await Promise.allSettled(
        PRECACHE_URLS.map(async (asset) => {
          try {
            const response = await fetch(asset, { credentials: 'same-origin', cache: 'no-cache' });
            if (response?.ok) await cache.put(asset, response.clone());
          } catch (_) {}
        })
      );
    } catch (_) {}
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    await purgeOldCaches();
    // ALIGN-FASTBOOT-V6: do not claim already-open PWA windows automatically.
    // Existing sessions keep their current controller until a manual update/clean launch.
  })());
});

self.addEventListener('message', (event) => {
  const data = event?.data || {};
  const type = String(data?.type || '').trim();

  if (type === 'SKIP_WAITING') {
    event.waitUntil(self.skipWaiting());
    return;
  }

  if (type === 'GET_SW_STATE') {
    try {
      event?.source?.postMessage?.({
        type: 'SW_STATE',
        epoch: APP_DATA_EPOCH,
        version: VERSION,
        buildLabel: SW_BUILD_LABEL,
        staticCache: STATIC_CACHE,
        locationHref: String(self.location?.href || ''),
        at: new Date().toISOString(),
      });
    } catch (_) {}
    return;
  }

  if (type === 'PURGE_RUNTIME_CACHES' || type === 'PURGE_OLD_CACHES') {
    event.waitUntil(purgeOldCaches());
    return;
  }

  if (type === 'WARM_CACHE') {
    const assets = Array.isArray(data?.assets) ? data.assets : [];
    event.waitUntil((async () => {
      try {
        const cache = await caches.open(STATIC_CACHE);
        await Promise.allSettled(
          assets
            .map((asset) => normalizePath(asset))
            .filter((asset) => isStaticAssetPath(new URL(asset, self.location.origin).pathname))
            .map(async (asset) => {
              try {
                const response = await fetch(asset, { credentials: 'same-origin', cache: 'no-cache' });
                if (response?.ok) await cache.put(asset, response.clone());
              } catch (_) {}
            })
        );
      } catch (_) {}
    })());
    return;
  }
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (!request || request.method !== 'GET') return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }

  if (!isSameOrigin(url.href)) return;

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        return await fetch(request);
      } catch (_) {
        try {
          const offline = await caches.match(OFFLINE_FALLBACK);
          if (offline) return offline;
        } catch (_) {}
        return new Response('Offline', {
          status: 503,
          statusText: 'Offline',
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
      }
    })());
    return;
  }

  if (isStaticAssetPath(url.pathname)) {
    event.respondWith((async () => {
      const cached = await caches.match(request, { ignoreSearch: false });
      if (cached) return cached;
      try {
        const network = await fetch(request);
        if (network?.ok) await putIfOk(STATIC_CACHE, request, network);
        return network;
      } catch (_) {
        const fallback = await caches.match(normalizePath(url.pathname), { ignoreSearch: true });
        if (fallback) return fallback;
        throw _;
      }
    })());
  }
});
