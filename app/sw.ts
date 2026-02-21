/* eslint-disable no-restricted-globals */
import { precacheAndRoute, cleanupOutdatedCaches } from 'workbox-precaching';
import { registerRoute, setCatchHandler } from 'workbox-routing';
import { NetworkFirst, CacheFirst, StaleWhileRevalidate } from 'workbox-strategies';

// Serwist/Workbox globals
declare const self: ServiceWorkerGlobalScope & {
  __SW_MANIFEST: Array<any>;
};

cleanupOutdatedCaches();

// Avoid conflicting offline.html precache entries (iOS)
const rawManifest = (self.__SW_MANIFEST || []) as Array<any>;
const filteredManifest = rawManifest.filter((e) => {
  try {
    const url = String(e?.url || '');
    return !url.includes('/offline.html');
  } catch {
    return true;
  }
});
precacheAndRoute(filteredManifest);

// Runtime caches
const PAGES_CACHE = 'pages-v1';

// Static assets
registerRoute(
  ({ url }) =>
    url.pathname.startsWith('/_next/static/') ||
    url.pathname.startsWith('/icons/') ||
    url.pathname.startsWith('/favicon'),
  new CacheFirst({ cacheName: 'static-assets-v1' })
);

// RSC payloads
registerRoute(
  ({ url }) => url.searchParams.has('_rsc'),
  new StaleWhileRevalidate({ cacheName: 'rsc-v1' })
);

// Navigation: keep NetworkFirst, but rely on our catch handler (below) for cold-start offline
registerRoute(
  ({ request }) => request.mode === 'navigate',
  new NetworkFirst({
    cacheName: PAGES_CACHE,
    networkTimeoutSeconds: 1, // very short for iOS cold-start
  })
);

// Warm-cache: include all main routes so last-route cold start works
const WARM_URLS = [
  '/',
  '/login',
  '/offline.html',
  '/doctor',
  '/pranimi',
  '/pastrimi',
  '/gati',
  '/marrje-sot',
  '/transport',
  '/arka',
  '/fletore',
];

async function warmCache() {
  const cache = await caches.open(PAGES_CACHE);
  await Promise.all(
    WARM_URLS.map(async (u) => {
      try {
        const req = new Request(u, { cache: 'reload' });
        const res = await fetch(req);
        if (res && res.ok) await cache.put(u, res.clone());
      } catch {
        // ignore
      }
    })
  );
}

// V14: ULTIMATE iOS COLD-START FALLBACK
// When offline, ALWAYS serve the cached "/" shell (works even if iOS tries to open last deep route).
setCatchHandler(async ({ event }) => {
  try {
    if (event.request && event.request.mode === 'navigate') {
      const cache = await caches.open(PAGES_CACHE);

      // 1) Always prefer cached root shell
      const hitRoot = await cache.match('/');
      if (hitRoot) return hitRoot;

      // 2) Then offline page if cached
      const hitOffline = await cache.match('/offline.html');
      if (hitOffline) return hitOffline;

      // last resort minimal HTML
      return new Response(
        '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OFFLINE</title><body style="font-family:system-ui;background:#000;color:#fff;padding:20px">OFFLINE</body>',
        { headers: { 'content-type': 'text/html; charset=utf-8' } }
      );
    }
  } catch {}
  return Response.error();
});

// Take control ASAP
// @ts-ignore
addEventListener('install', (event: any) => {
  // @ts-ignore
  self.skipWaiting();
  event.waitUntil(warmCache());
});

// @ts-ignore
addEventListener('activate', (event: any) => {
  // @ts-ignore
  event.waitUntil((self as any).clients.claim());
});
