/* TEPIHA OFFLINE SW
 *
 * Safari sometimes keeps stale HTML when navigations are cache-first.
 * We therefore do NETWORK-FIRST for navigations (documents), with cache fallback.
 *
 * Static assets: cache-first.
 */

const CACHE_VER = 'tepiha-runtime-v1';
const PRECACHE = [
  '/',
  '/offline',
  '/pranimi',
  '/pastrimi',
  '/gati',
  '/marrje-sot',
  '/transport',
  '/transport/board',
  '/manifest.json',
  '/version.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_VER);
      await cache.addAll(PRECACHE);
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => (k !== CACHE_VER ? caches.delete(k) : Promise.resolve())));
      await self.clients.claim();
    })()
  );
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE_VER);
  try {
    const res = await fetch(request);
    // Cache only successful GET responses
    if (res && res.ok && request.method === 'GET') {
      cache.put(request, res.clone()).catch(() => {});
    }
    return res;
  } catch {
    const cached = await cache.match(request, { ignoreSearch: true });
    return cached || (await cache.match('/offline'));
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_VER);
  const cached = await cache.match(request, { ignoreSearch: true });
  if (cached) return cached;
  try {
    const res = await fetch(request);
    if (res && res.ok && request.method === 'GET') {
      cache.put(request, res.clone()).catch(() => {});
    }
    return res;
  } catch {
    return (await cache.match('/offline')) || new Response('', { status: 503 });
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Always fetch version.json fresh when online (but still allow cache fallback offline)
  if (url.pathname === '/version.json') {
    event.respondWith(networkFirst(req));
    return;
  }

  // Navigations / documents: NETWORK-FIRST (fixes Safari stale)
  if (req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html')) {
    event.respondWith(networkFirst(req));
    return;
  }

  // Static assets: CACHE-FIRST
  if (
    url.pathname.startsWith('/_next/') ||
    url.pathname.startsWith('/assets/') ||
    url.pathname.endsWith('.js') ||
    url.pathname.endsWith('.css') ||
    url.pathname.endsWith('.png') ||
    url.pathname.endsWith('.jpg') ||
    url.pathname.endsWith('.jpeg') ||
    url.pathname.endsWith('.svg') ||
    url.pathname.endsWith('.webp') ||
    url.pathname.endsWith('.ico') ||
    url.pathname.endsWith('.json')
  ) {
    event.respondWith(cacheFirst(req));
    return;
  }

  // Default: network-first
  event.respondWith(networkFirst(req));
});
