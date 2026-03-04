/* public/sw.js */
// TEPIHA Offline-first SW (iOS/Safari friendly)
// Version bump this string to force update.
const CACHE_NAME = 'tepiha-v6';
const OFFLINE_URL = '/offline';
// Shto këtu faqet kryesore që do të punojnë offline menjëherë
const APP_SHELL = [
  '/', 
  '/offline',
  '/home', // Ose faqja e parë pas login
  '/manifest.json' 
];

// Pages that should open offline after you visited once online
const APP_SHELL = [
  '/',
  OFFLINE_URL,
  '/login',
  '/pranimi',
  '/pastrimi',
  '/gati',
  '/marrje-sot',
  '/arka',
  '/transport',
  '/manifest.json',
  '/icon-192.png',
];

async function cachePut(request, response) {
  try {
    if (request.method !== 'GET') return;
    const cache = await caches.open(CACHE_NAME);
    await cache.put(request, response);
  } catch (e) {
    // swallow
  }
}

function normalizeNavRequest(req) {
  try {
    const u = new URL(req.url);
    // keep only pathname so ?_rsc etc won't create cache misses for navigations
    return new Request(u.pathname, { headers: { 'Accept': 'text/html' } });
  } catch {
    return req;
  }
}

self.addEventListener('install', (event) => {
  self.skipWaiting(); // Aktivizo menjëherë
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    for (const path of APP_SHELL) {
      try {
        const res = await fetch(path, { cache: 'reload' });
        if (res && res.ok) await cache.put(path, res);
      } catch {
        // don't fail install
      }
    }
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => (k !== CACHE_NAME ? caches.delete(k) : null)));
    await clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // 1) NAVIGATIONS (this fixes "Safari can't open the page" offline)
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      const keyReq = normalizeNavRequest(req);
      try {
        const networkResponse = await fetch(req);
        // cache by normalized pathname
        cachePut(keyReq, networkResponse.clone());
        return networkResponse;
      } catch {
        const cached = await caches.match(keyReq);
        if (cached) return cached;
        const offlineShell = await caches.match(OFFLINE_URL);
        return offlineShell || new Response('OFFLINE', { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      }
    })());
    return;
  }

  // 2) Static assets: Cache First
  if (
    url.origin === self.location.origin &&
    (url.pathname.startsWith('/_next/static/') ||
      url.pathname.startsWith('/assets/') ||
      url.pathname.match(/\.(png|jpg|jpeg|webp|svg|css|js|ico|woff2?|ttf|otf)$/))
  ) {
    event.respondWith((async () => {
      const cached = await caches.match(req);
      if (cached) return cached;
      try {
        const res = await fetch(req);
        if (res && res.ok) cachePut(req, res.clone());
        return res;
      } catch {
        return new Response('', { status: 404 });
      }
    })());
    return;
  }

  // 3) RSC handling (Next.js App Router)
  // When offline, we prefer cached response; otherwise return a lightweight error
  // so Next can fallback to a full navigation (which is handled above).
  const accept = (req.headers.get('accept') || '').toLowerCase();
  if (url.searchParams.has('_rsc') || accept.includes('text/x-component')) {
    event.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res && res.ok) cachePut(req, res.clone());
        return res;
      } catch {
        const cached = await caches.match(req);
        if (cached) return cached;
        return new Response('{}', { status: 503, headers: { 'Content-Type': 'text/x-component' } });
      }
    })());
    return;
  }

  // default: network
  event.respondWith(fetch(req));
});
