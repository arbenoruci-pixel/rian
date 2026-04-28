/* TEPIHA SW Navigation Flight Recorder V34.3 — navigation shell fallback before safe screen. */
/* eslint-disable no-restricted-globals */
(function () {
  'use strict';

  var NAV_DIAG_CACHE = 'tepiha-sw-navigation-diag-v1';
  var NAV_LAST_KEY = '/__tepiha_sw_nav_last.json';
  var NAV_LOG_KEY = '/__tepiha_sw_nav_log.json';
  var NAV_LOG_LIMIT = 50;
  var NAV_TIMEOUT_MS = 10000;
  var APP_EPOCH = 'RESET-2026-04-28-VITE-NAV-SHELL-FALLBACK-V34-3';
  var APP_VERSION = '2.0.42-vite-nav-shell-fallback-v34-3';
  var SW_NAV_DIAG_VERSION = 'sw-navigation-diag-v34.3';
  var SAFE_SCREEN_VERSION = 'safe-screen-v34.3-nav-shell-fallback';

  function nowIso() { try { return new Date().toISOString(); } catch (_) { return ''; } }
  function safeString(value) { try { return String(value == null ? '' : value); } catch (_) { return ''; } }
  function sameOrigin(url) { try { return new URL(url, self.location.origin).origin === self.location.origin; } catch (_) { return false; } }
  function requestPath(url) { try { var u = new URL(url, self.location.origin); return safeString(u.pathname + u.search); } catch (_) { return safeString(url || ''); } }
  function absoluteUrl(path) { try { return new URL(path || '/', self.location.origin).href; } catch (_) { return self.location.origin + '/'; } }
  function cacheBustUrl(path, label) {
    try {
      var u = new URL(path || '/', self.location.origin);
      u.searchParams.set('__tepiha_nav_shell_fallback', label || String(Date.now()));
      return u.href;
    } catch (_) {
      return absoluteUrl(path || '/');
    }
  }

  function isNavigationRequest(request) {
    try {
      if (!request || request.method !== 'GET') return false;
      if (request.mode !== 'navigate') return false;
      if (!sameOrigin(request.url)) return false;
      var path = new URL(request.url).pathname || '/';
      if (/^\/api(?:\/|$)/.test(path)) return false;
      if (/^\/debug(?:\/|$)/.test(path)) return false;
      if (/^\/diag-lite(?:\/|$)/.test(path)) return false;
      if (/^\/diag-raw(?:\/|$)/.test(path)) return false;
      return true;
    } catch (_) { return false; }
  }

  async function controlledClientsCount() {
    try {
      if (!self.clients || !self.clients.matchAll) return null;
      var list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      return Array.isArray(list) ? list.length : null;
    } catch (_) { return null; }
  }

  async function readJson(cache, key, fallback) {
    try {
      var response = await cache.match(key, { ignoreSearch: true });
      if (!response) return fallback;
      var parsed = JSON.parse(await response.text());
      return parsed == null ? fallback : parsed;
    } catch (_) { return fallback; }
  }

  async function writeJson(cache, key, value) {
    try {
      await cache.put(new Request(key, { cache: 'no-store' }), new Response(JSON.stringify(value), {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
      }));
    } catch (_) {}
  }

  async function recordNavigation(entry) {
    try {
      var cache = await caches.open(NAV_DIAG_CACHE);
      var normalized = Object.assign({ recordedAt: nowIso() }, entry || {});
      await writeJson(cache, NAV_LAST_KEY, normalized);
      var log = await readJson(cache, NAV_LOG_KEY, []);
      if (!Array.isArray(log)) log = [];
      log.unshift(normalized);
      if (log.length > NAV_LOG_LIMIT) log = log.slice(0, NAV_LOG_LIMIT);
      await writeJson(cache, NAV_LOG_KEY, log);
    } catch (_) {}
  }

  function escapeHtml(value) {
    return safeString(value).replace(/[<>&"]/g, function (ch) {
      return ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[ch] || ch;
    });
  }

  function isUsableShellResponse(response) {
    try {
      if (!response) return false;
      if (!(response.status === 0 || (response.status >= 200 && response.status < 400))) return false;
      var ct = safeString(response.headers && response.headers.get ? response.headers.get('content-type') : '').toLowerCase();
      return !ct || ct.indexOf('text/html') !== -1;
    } catch (_) { return !!response; }
  }

  function addAttempt(entry, name, status, detail) {
    try {
      if (!entry.attempts || !Array.isArray(entry.attempts)) entry.attempts = [];
      entry.attempts.push(Object.assign({
        name: safeString(name),
        status: safeString(status),
        at: nowIso(),
        elapsedMs: Math.max(0, Date.now() - (entry.startTime || Date.now())),
      }, detail || {}));
    } catch (_) {}
  }

  async function matchCachedShellCandidates(request, entry) {
    var path = requestPath(request && request.url) || '/';
    var pathname = '/';
    try { pathname = new URL(request.url, self.location.origin).pathname || '/'; } catch (_) {}
    var candidates = [request, path, pathname, pathname + '/', '/index.html', '/'];
    var seen = {};

    for (var i = 0; i < candidates.length; i += 1) {
      try {
        var candidate = candidates[i];
        var key = typeof candidate === 'string' ? candidate : safeString(candidate && candidate.url);
        if (!key || seen[key]) continue;
        seen[key] = true;
        var response = await caches.match(candidate, { ignoreSearch: false });
        if (!response && typeof candidate === 'string') response = await caches.match(candidate, { ignoreSearch: true });
        if (isUsableShellResponse(response)) {
          addAttempt(entry, 'cached_shell', 'hit', { cacheKey: key, responseStatus: response.status });
          return response;
        }
        addAttempt(entry, 'cached_shell', 'miss', { cacheKey: key, responseStatus: response ? response.status : null });
      } catch (error) {
        addAttempt(entry, 'cached_shell', 'error', { errorMessage: safeString(error && (error.message || error.name) ? (error.message || error.name) : error) });
      }
    }
    return null;
  }

  async function fetchNetworkShell(entry) {
    var stamp = 'v34_3_' + Date.now();
    var candidates = ['/index.html', '/'];
    for (var i = 0; i < candidates.length; i += 1) {
      var url = cacheBustUrl(candidates[i], stamp + '_' + i);
      try {
        var response = await fetch(new Request(url, {
          method: 'GET',
          credentials: 'same-origin',
          cache: 'no-store',
          redirect: 'follow',
          headers: { 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
        }));
        if (isUsableShellResponse(response)) {
          addAttempt(entry, 'network_shell', 'success', { shellUrl: url, responseStatus: response.status });
          return response;
        }
        addAttempt(entry, 'network_shell', 'bad_response', { shellUrl: url, responseStatus: response ? response.status : null });
      } catch (error) {
        addAttempt(entry, 'network_shell', 'error', { shellUrl: url, errorMessage: safeString(error && (error.message || error.name) ? (error.message || error.name) : error) });
      }
    }
    return null;
  }

  function safeDarkHtml(reason, detail, retryHref, entry) {
    var escapedReason = escapeHtml(reason || 'RRJETI U VONUA');
    var escapedDetail = escapeHtml(detail || '');
    var escapedRetryHref = escapeHtml(retryHref || '/');
    var escapedPayload = escapeHtml(JSON.stringify(entry || {}, null, 2));
    return '<!doctype html><html lang="sq" style="background:#05070d;color-scheme:dark"><head>' +
      '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">' +
      '<meta name="theme-color" content="#05070d"><title>TEPIHA - RRJETI U VONUA</title></head>' +
      '<body style="margin:0;min-height:100vh;background:#05070d;color:#e8eef6;font-family:system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;display:grid;place-items:center;padding:22px;box-sizing:border-box">' +
      '<main style="width:min(560px,100%);border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.06);border-radius:22px;padding:22px;box-shadow:0 20px 70px rgba(0,0,0,.38)">' +
      '<div style="font-size:13px;letter-spacing:.18em;color:#93c5fd;font-weight:1000;margin-bottom:10px">TEPIHA</div>' +
      '<h1 style="margin:0 0 8px;font-size:28px;line-height:1.08;color:#fff">RRJETI U VONUA</h1>' +
      '<p style="margin:0 0 18px;color:#cbd5e1;font-size:15px;line-height:1.45">Service Worker provoi network navigation, cached shell dhe network shell. Safe screen u shfaq vetëm pasi fallback-et dështuan.</p>' +
      '<pre id="tepiha-nav-detail" style="white-space:pre-wrap;word-break:break-word;background:#020617;border:1px solid rgba(255,255,255,.12);border-radius:14px;padding:12px;color:#cbd5e1;font-size:12px;line-height:1.4;margin:0 0 16px">' + escapedReason + (escapedDetail ? '\n' + escapedDetail : '') + '\n\n' + escapedPayload + '</pre>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">' +
      '<a href="/" style="text-align:center;text-decoration:none;border-radius:14px;background:#2563eb;color:#fff;padding:13px 10px;font-weight:1000">HOME</a>' +
      '<a href="/diag-raw" style="text-align:center;text-decoration:none;border-radius:14px;background:rgba(96,165,250,.18);color:#bfdbfe;padding:13px 10px;font-weight:1000">DIAG RAW</a>' +
      '<button id="tepiha-copy-nav-log" type="button" style="border:0;text-align:center;border-radius:14px;background:rgba(255,255,255,.10);color:#fff;padding:13px 10px;font-weight:1000;font:inherit">COPY NAV LOG</button>' +
      '<button id="tepiha-probe" type="button" style="border:0;text-align:center;border-radius:14px;background:rgba(255,255,255,.10);color:#fff;padding:13px 10px;font-weight:1000;font:inherit">PROBE</button>' +
      '<a href="' + escapedRetryHref + '" style="grid-column:1 / -1;text-align:center;text-decoration:none;border-radius:14px;background:rgba(255,255,255,.10);color:#fff;padding:13px 10px;font-weight:1000">RETRY</a>' +
      '</div><div id="tepiha-probe-out" style="margin-top:12px;color:#93c5fd;font-size:12px;font-weight:800;word-break:break-word"></div>' +
      '<script>(function(){var C="' + NAV_DIAG_CACHE + '",L="' + NAV_LOG_KEY + '",S="' + SAFE_SCREEN_VERSION + '";function t(v){try{return String(v==null?"":v)}catch(e){return""}}async function read(){try{var c=await caches.open(C);var r=await c.match(L,{ignoreSearch:true});return r?await r.text():"[]"}catch(e){return JSON.stringify({error:t(e&&e.message||e),safeScreenVersion:S})}}async function copy(){var out=document.getElementById("tepiha-probe-out");var txt=await read();try{await navigator.clipboard.writeText(txt);if(out)out.textContent="NAV LOG COPIED"}catch(e){var pre=document.getElementById("tepiha-nav-detail");if(pre)pre.textContent=txt;if(out)out.textContent="COPY FAILED - LOG SHOWN ABOVE"}}async function probe(){var out=document.getElementById("tepiha-probe-out");try{var r=await fetch("/__tepiha_version.txt?probe="+Date.now(),{cache:"no-store"});var tx=await r.text();if(out)out.textContent="PROBE "+r.status+": "+tx.slice(0,160)}catch(e){if(out)out.textContent="PROBE FAILED: "+t(e&&e.message||e)}}try{document.getElementById("tepiha-copy-nav-log").addEventListener("click",copy);document.getElementById("tepiha-probe").addEventListener("click",probe)}catch(e){}})();</script>' +
      '</main></body></html>';
  }

  async function navigationTimeoutPromise(controller) {
    return new Promise(function (_, reject) {
      setTimeout(function () {
        try { if (controller && controller.abort) controller.abort(); } catch (_) {}
        reject(new Error('navigation network timeout after ' + NAV_TIMEOUT_MS + 'ms'));
      }, NAV_TIMEOUT_MS);
    });
  }

  async function fetchNavigationWithTimeout(request) {
    var controller = null;
    var init = { credentials: 'same-origin', cache: 'no-store', redirect: 'follow' };
    try {
      if (typeof AbortController !== 'undefined') {
        controller = new AbortController();
        init.signal = controller.signal;
      }
    } catch (_) {}
    return Promise.race([fetch(request, init), navigationTimeoutPromise(controller)]);
  }

  async function handleNavigation(event) {
    var request = event.request;
    var startedAt = Date.now();
    var entry = {
      timestamp: nowIso(),
      ts: startedAt,
      url: safeString(request && request.url),
      path: requestPath(request && request.url),
      requestMode: safeString(request && request.mode),
      requestDestination: safeString(request && request.destination),
      online: (function () { try { return self.navigator && 'onLine' in self.navigator ? self.navigator.onLine : null; } catch (_) { return null; } })(),
      swVersion: APP_VERSION,
      swEpoch: APP_EPOCH,
      swNavDiagVersion: SW_NAV_DIAG_VERSION,
      safeScreenVersion: SAFE_SCREEN_VERSION,
      navTimeoutMs: NAV_TIMEOUT_MS,
      startTime: startedAt,
      outcome: 'network_pending',
      networkOutcome: 'pending',
      durationMs: 0,
      errorMessage: '',
      responseStatus: null,
      controlledClientsCount: null,
      attempts: [],
      noAutoReload: true,
      noSkipWaiting: true,
      noClientsClaim: true,
      noUnregister: true,
      noCachePurge: true,
      noBusinessStorageTouch: true,
    };

    try { entry.controlledClientsCount = await controlledClientsCount(); } catch (_) {}

    try {
      var response = await fetchNavigationWithTimeout(request);
      entry.durationMs = Date.now() - startedAt;
      entry.outcome = 'network_success';
      entry.networkOutcome = 'network_success';
      entry.responseStatus = response ? response.status : null;
      addAttempt(entry, 'navigation_network', 'success', { responseStatus: entry.responseStatus });
      await recordNavigation(entry);
      return response;
    } catch (error) {
      var errorMessage = safeString(error && (error.message || error.name) ? (error.message || error.name) : error);
      entry.durationMs = Date.now() - startedAt;
      entry.errorMessage = errorMessage;
      entry.networkOutcome = /timeout|aborted|abort/i.test(errorMessage) ? 'network_timeout' : 'network_error';
      entry.outcome = entry.networkOutcome;
      addAttempt(entry, 'navigation_network', entry.networkOutcome, { errorMessage: errorMessage });

      var cachedShell = await matchCachedShellCandidates(request, entry);
      if (cachedShell) {
        entry.durationMs = Date.now() - startedAt;
        entry.outcome = 'fallback_cached_shell';
        try { entry.responseStatus = cachedShell.status; } catch (_) { entry.responseStatus = 200; }
        await recordNavigation(entry);
        return cachedShell;
      }

      var networkShell = await fetchNetworkShell(entry);
      if (networkShell) {
        entry.durationMs = Date.now() - startedAt;
        entry.outcome = 'fallback_network_shell';
        try { entry.responseStatus = networkShell.status; } catch (_) { entry.responseStatus = 200; }
        await recordNavigation(entry);
        return networkShell;
      }

      entry.durationMs = Date.now() - startedAt;
      entry.outcome = 'fallback_offline_safe_screen';
      entry.responseStatus = 503;
      await recordNavigation(entry);
      return new Response(safeDarkHtml('RRJETI U VONUA', errorMessage, entry.path || '/', entry), {
        status: 503,
        statusText: 'Navigation Fallback Failed',
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }
  }

  self.addEventListener('fetch', function (event) {
    try {
      var request = event && event.request;
      if (!isNavigationRequest(request)) return;
      event.respondWith(handleNavigation(event));
    } catch (_) {}
  });
})();
