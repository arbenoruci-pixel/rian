/* TEPIHA PRO OFFLINE SW */
const CACHE_VER = "tepiha-v202602132111";
const PRECACHE = [
  "/", "/offline",
  "/pranimi", "/pastrimi", "/gati", "/marrje-sot",
  "/transport", "/transport/board",
  "/manifest.json"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VER)
      .then((c) => c.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.map(k => (k !== CACHE_VER ? caches.delete(k) : null)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;

    // Navigation requests: cache-first for already-cached routes, then network, fallback to offline
  if (req.mode === "navigate") {
    event.respondWith((async () => {
      const cached = await caches.match(req, { ignoreSearch: true });
      if (cached) return cached;
      try {
        const res = await fetch(req);
        // cache the HTML for next offline navigation
        const copy = res.clone();
        caches.open(CACHE_VER).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      } catch (e) {
        return (await caches.match("/offline")) || Response.error();
      }
    })());
    return;
  }

  // Static/cache-first for everything else
  event.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit;
      return fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE_VER).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      }).catch(() => hit || Response.error());
    })
  );
});

self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type === 'SKIP_WAITING') { self.skipWaiting(); return; }
  if (data.type === "NUKE_CACHES") {
    event.waitUntil(caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k)))));
  }
});
