/* public/sw.js - Minimal PWA cache + offline fallback */
const CACHE_NAME = "tepiha-cache-v2";
const OFFLINE_URL = "/offline";

const PRECACHE = [
  "/",
  "/pranimi",
  "/pastrimi",
  "/gati",
  "/marrje-sot",
  "/transport",
  "/transport/board",
  OFFLINE_URL,
  "/manifest.json",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => (k === CACHE_NAME ? null : caches.delete(k))));
      await self.clients.claim();
    })()
  );
});

// Network-first for navigations, cache-first for static GET
self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  if (req.method !== "GET") return;
  if (url.origin !== self.location.origin) return;

  // Navigation requests: try network, fallback to offline
  if (req.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const netRes = await fetch(req);
          const cache = await caches.open(CACHE_NAME);
          cache.put(req, netRes.clone());
          return netRes;
        } catch (e) {
          const cache = await caches.open(CACHE_NAME);
          const cached = await cache.match(req);
          return cached || cache.match(OFFLINE_URL);
        }
      })()
    );
    return;
  }

  // Static/cache-first
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(req);
      if (cached) return cached;

      try {
        const netRes = await fetch(req);
        // Cache common assets
        if (
          url.pathname.startsWith("/_next/") ||
          url.pathname.startsWith("/assets/") ||
          url.pathname.endsWith(".png") ||
          url.pathname.endsWith(".jpg") ||
          url.pathname.endsWith(".jpeg") ||
          url.pathname.endsWith(".webp") ||
          url.pathname.endsWith(".svg") ||
          url.pathname.endsWith(".css") ||
          url.pathname.endsWith(".js")
        ) {
          cache.put(req, netRes.clone());
        }
        return netRes;
      } catch (e) {
        return cached || new Response("", { status: 504 });
      }
    })()
  );
});
