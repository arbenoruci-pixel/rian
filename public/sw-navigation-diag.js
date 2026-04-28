/* TEPIHA SW Navigation Flight Recorder V34.5 — verified last-good shell + module asset guard. */
/* eslint-disable no-restricted-globals */
(function () {
  'use strict';

  var NAV_DIAG_CACHE = 'tepiha-sw-navigation-diag-v1';
  var NAV_SHELL_CACHE = 'tepiha-sw-navigation-shell-v34-5';
  var NAV_LAST_GOOD_SHELL_KEY = '/__tepiha_last_good_shell_verified__.html';
  var NAV_LAST_GOOD_META_KEY = '/__tepiha_last_good_shell_verified_meta__.json';
  var NAV_LAST_KEY = '/__tepiha_sw_nav_last.json';
  var NAV_LOG_KEY = '/__tepiha_sw_nav_log.json';
  var NAV_LOG_LIMIT = 50;
  var NAV_TIMEOUT_MS = 10000;
  var APP_EPOCH = 'RESET-2026-04-28-VITE-VERIFIED-SHELL-V34-5';
  var APP_VERSION = '2.0.44-vite-verified-shell-v34-5';
  var SW_NAV_DIAG_VERSION = 'sw-navigation-diag-v34.5';
  var SAFE_SCREEN_VERSION = 'safe-screen-v34.5-verified-shell';

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

  function normalizedRouteKey(url) {
    try {
      var u = new URL(url || '/', self.location.origin);
      var path = safeString(u.pathname || '/').replace(/\/{2,}/g, '/');
      if (!path || path.charAt(0) !== '/') path = '/' + path;
      if (path.length > 1 && path.charAt(path.length - 1) === '/') path = path.slice(0, -1);
      return path || '/';
    } catch (_) { return '/'; }
  }

  function cacheKeyHref(key) {
    try {
      var u = new URL(key || '/', self.location.origin);
      u.search = '';
      u.hash = '';
      return u.href;
    } catch (_) { return absoluteUrl('/'); }
  }

  function cacheRequestForKey(key) {
    return new Request(cacheKeyHref(key), { method: 'GET', credentials: 'same-origin' });
  }

  function uniqueList(items) {
    var out = [];
    var seen = {};
    for (var i = 0; i < (items || []).length; i += 1) {
      var value = safeString(items[i] || '').trim();
      if (!value) continue;
      if (value === '//' || /^\/\/[^/]/.test(value)) continue;
      if (seen[value]) continue;
      seen[value] = true;
      out.push(value);
    }
    return out;
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

  function isUsableAssetResponse(response) {
    try {
      return !!response && (response.status === 0 || (response.status >= 200 && response.status < 400));
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

  function extractShellAssets(text) {
    var hits = [];
    var html = safeString(text || '');
    if (!html) return [];
    function push(raw) {
      try {
        var value = safeString(raw || '').trim();
        if (!value) return;
        var u = new URL(value, self.location.origin);
        if (u.origin !== self.location.origin) return;
        if (!/\.(?:js|mjs|css)(?:$|\?)/i.test(u.pathname + u.search)) return;
        hits.push(u.href);
      } catch (_) {}
    }
    var re = /(?:src|href)\s*=\s*["']([^"']+)["']/gi;
    var match;
    while ((match = re.exec(html))) push(match[1]);
    var assetRe = /\/assets\/[^\s"'<>]+\.(?:js|mjs|css)(?:\?[^\s"'<>]*)?/gi;
    while ((match = assetRe.exec(html))) push(match[0]);
    var srcMainRe = /\/src\/main\.jsx(?:\?[^\s"'<>]*)?/gi;
    while ((match = srcMainRe.exec(html))) push(match[0]);
    return uniqueList(hits).slice(0, 40);
  }

  async function verifyAndWarmShellAssets(text, entry, source) {
    var assets = extractShellAssets(text);
    var checked = [];
    var failures = [];
    if (!assets.length) {
      addAttempt(entry, 'shell_asset_verify', 'no_assets_found', { source: safeString(source || '') });
      return { ok: true, assets: [], checked: [], failures: [] };
    }

    var shellCache = null;
    try { shellCache = await caches.open(NAV_SHELL_CACHE); } catch (_) { shellCache = null; }

    for (var i = 0; i < assets.length; i += 1) {
      var assetUrl = assets[i];
      var assetStatus = { assetUrl: assetUrl, status: 'pending', responseStatus: null };
      try {
        var cached = await caches.match(assetUrl, { ignoreSearch: false });
        if (!cached) cached = await caches.match(assetUrl, { ignoreSearch: true });
        if (isUsableAssetResponse(cached)) {
          assetStatus.status = 'cached';
          assetStatus.responseStatus = cached.status;
          checked.push(assetStatus);
          continue;
        }
      } catch (cacheError) {
        assetStatus.cacheError = safeString(cacheError && (cacheError.message || cacheError.name) ? (cacheError.message || cacheError.name) : cacheError);
      }

      try {
        var response = await fetch(new Request(assetUrl, {
          method: 'GET',
          credentials: 'same-origin',
          cache: 'no-store',
          redirect: 'follow',
        }));
        assetStatus.responseStatus = response ? response.status : null;
        if (isUsableAssetResponse(response)) {
          assetStatus.status = 'network_warmed';
          if (shellCache) {
            try { await shellCache.put(new Request(assetUrl, { method: 'GET', credentials: 'same-origin' }), response.clone()); } catch (_) {}
          }
          checked.push(assetStatus);
          continue;
        }
        assetStatus.status = 'bad_response';
        failures.push(assetStatus);
      } catch (networkError) {
        assetStatus.status = 'network_error';
        assetStatus.errorMessage = safeString(networkError && (networkError.message || networkError.name) ? (networkError.message || networkError.name) : networkError);
        failures.push(assetStatus);
      }
    }

    addAttempt(entry, 'shell_asset_verify', failures.length ? 'failed' : 'success', {
      source: safeString(source || ''),
      assetCount: assets.length,
      checkedCount: checked.length,
      failureCount: failures.length,
      checked: checked.slice(0, 10),
      failures: failures.slice(0, 8),
    });

    return { ok: failures.length === 0, assets: assets, checked: checked, failures: failures };
  }

  async function storeVerifiedShellResponse(response, requestUrl, entry, source, options) {
    try {
      var opts = options || {};
      if (!isUsableShellResponse(response)) {
        addAttempt(entry, 'shell_cache_store', 'skip_unusable', {
          source: safeString(source || ''),
          responseStatus: response ? response.status : null,
        });
        return false;
      }

      var text = await response.clone().text();
      if (!text || text.length < 40 || text.indexOf('<') === -1) {
        addAttempt(entry, 'shell_cache_store', 'skip_empty', {
          source: safeString(source || ''),
          textLength: text ? text.length : 0,
        });
        return false;
      }

      var verification = await verifyAndWarmShellAssets(text, entry, source);
      if (!verification.ok && opts.requireVerified !== false) {
        addAttempt(entry, 'shell_cache_store', 'skip_unverified_assets', {
          source: safeString(source || ''),
          cacheName: NAV_SHELL_CACHE,
          failureCount: verification.failures.length,
          failures: verification.failures.slice(0, 8),
        });
        return false;
      }

      var cache = await caches.open(NAV_SHELL_CACHE);
      var routeKey = normalizedRouteKey(requestUrl || '/');
      var keys = uniqueList([NAV_LAST_GOOD_SHELL_KEY, routeKey, '/', '/index.html']);
      var stored = [];

      for (var i = 0; i < keys.length; i += 1) {
        var shell = new Response(text, {
          status: 200,
          statusText: 'OK',
          headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-Tepiha-Shell-Cache': 'verified-v34.5',
            'X-Tepiha-Shell-Source': safeString(source || 'unknown'),
            'X-Tepiha-Shell-Assets': safeString(verification.assets.length),
          },
        });
        await cache.put(cacheRequestForKey(keys[i]), shell);
        stored.push(keys[i]);
      }

      await writeJson(cache, NAV_LAST_GOOD_META_KEY, {
        at: nowIso(),
        ts: Date.now(),
        cacheName: NAV_SHELL_CACHE,
        source: safeString(source || ''),
        routeKey: routeKey,
        keys: stored,
        appEpoch: APP_EPOCH,
        appVersion: APP_VERSION,
        swNavDiagVersion: SW_NAV_DIAG_VERSION,
        assets: verification.assets,
        checked: verification.checked.slice(0, 20),
        verified: verification.ok,
      });

      addAttempt(entry, 'shell_cache_store', 'success_verified', {
        source: safeString(source || ''),
        cacheName: NAV_SHELL_CACHE,
        keys: stored,
        routeKey: routeKey,
        textLength: text.length,
        assetCount: verification.assets.length,
        checkedCount: verification.checked.length,
      });
      return true;
    } catch (error) {
      addAttempt(entry, 'shell_cache_store', 'error', {
        source: safeString(source || ''),
        cacheName: NAV_SHELL_CACHE,
        errorMessage: safeString(error && (error.message || error.name) ? (error.message || error.name) : error),
      });
      return false;
    }
  }

  async function matchCachedShellCandidates(request, entry) {
    var routeKey = normalizedRouteKey(request && request.url);
    var candidates = uniqueList([NAV_LAST_GOOD_SHELL_KEY, routeKey, '/', '/index.html']);

    try {
      var shellCache = await caches.open(NAV_SHELL_CACHE);
      for (var i = 0; i < candidates.length; i += 1) {
        var key = candidates[i];
        try {
          var response = await shellCache.match(cacheRequestForKey(key), { ignoreSearch: true });
          if (isUsableShellResponse(response)) {
            addAttempt(entry, 'cached_verified_shell', 'hit', {
              cacheName: NAV_SHELL_CACHE,
              cacheKey: key,
              responseStatus: response.status,
            });
            return response;
          }
          addAttempt(entry, 'cached_verified_shell', 'miss', {
            cacheName: NAV_SHELL_CACHE,
            cacheKey: key,
            responseStatus: response ? response.status : null,
          });
        } catch (error) {
          addAttempt(entry, 'cached_verified_shell', 'error', {
            cacheName: NAV_SHELL_CACHE,
            cacheKey: key,
            errorMessage: safeString(error && (error.message || error.name) ? (error.message || error.name) : error),
          });
        }
      }
    } catch (error2) {
      addAttempt(entry, 'cached_verified_shell', 'open_error', {
        cacheName: NAV_SHELL_CACHE,
        errorMessage: safeString(error2 && (error2.message || error2.name) ? (error2.message || error2.name) : error2),
      });
    }

    return null;
  }

  async function fetchNetworkShell(entry, requestUrl) {
    var stamp = 'v34_5_' + Date.now();
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
          var stored = await storeVerifiedShellResponse(response.clone(), requestUrl || '/', entry, 'network_shell', { requireVerified: true });
          if (stored) return response;
          addAttempt(entry, 'network_shell', 'not_returned_unverified_assets', { shellUrl: url });
          continue;
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
      '<p style="margin:0 0 18px;color:#cbd5e1;font-size:15px;line-height:1.45">Service Worker provoi network navigation, verified last-good shell, dhe verified network shell. Safe screen u shfaq vetëm pasi fallback-et e verifikuara dështuan.</p>' +
      '<pre id="tepiha-nav-detail" style="white-space:pre-wrap;word-break:break-word;background:#020617;border:1px solid rgba(255,255,255,.12);border-radius:14px;padding:12px;color:#cbd5e1;font-size:12px;line-height:1.4;margin:0 0 16px">' + escapedReason + (escapedDetail ? '\n' + escapedDetail : '') + '\n\n' + escapedPayload + '</pre>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">' +
      '<a href="/" style="text-align:center;text-decoration:none;border-radius:14px;background:#2563eb;color:#fff;padding:13px 10px;font-weight:1000">HOME</a>' +
      '<a href="/diag-raw" style="text-align:center;text-decoration:none;border-radius:14px;background:rgba(96,165,250,.18);color:#bfdbfe;padding:13px 10px;font-weight:1000">DIAG RAW</a>' +
      '<button id="tepiha-copy-nav-log" type="button" style="border:0;text-align:center;border-radius:14px;background:rgba(255,255,255,.10);color:#fff;padding:13px 10px;font-weight:1000;font:inherit">COPY NAV LOG</button>' +
      '<button id="tepiha-probe" type="button" style="border:0;text-align:center;border-radius:14px;background:rgba(255,255,255,.10);color:#fff;padding:13px 10px;font-weight:1000;font:inherit">PROBE</button>' +
      '<a href="' + escapedRetryHref + '" style="grid-column:1 / -1;text-align:center;text-decoration:none;border-radius:14px;background:rgba(255,255,255,.10);color:#fff;padding:13px 10px;font-weight:1000">RETRY</a>' +
      '</div><div id="tepiha-probe-out" style="margin-top:12px;color:#93c5fd;font-size:12px;font-weight:800;word-break:break-word"></div>' +
      '<script>(function(){var C="' + NAV_DIAG_CACHE + '",L="' + NAV_LOG_KEY + '",S="' + SAFE_SCREEN_VERSION + '";function t(v){try{return String(v==null?"":v)}catch(e){return""}}async function read(){try{var c=await caches.open(C);var r=await c.match(L,{ignoreSearch:true});return r?await r.text():"[]"}catch(e){return JSON.stringify({error:t(e&&e.message||e),safeScreenVersion:S})}}async function copy(){var out=document.getElementById("tepiha-probe-out");var txt=await read();try{await navigator.clipboard.writeText(txt);if(out)out.textContent="NAV LOG COPIED"}catch(e){var pre=document.getElementById("tepiha-nav-detail");if(pre)pre.textContent=txt;if(out)out.textContent="COPY FAILED - LOG SHOWN ABOVE"}}async function probe(){var out=document.getElementById("tepiha-probe-out");try{var r=await fetch("/__tepiha_version.txt?probe="+Date.now(),{cache:"no-store"});var tx=await r.text();if(out)out.textContent="PROBE "+r.status+": "+tx.slice(0,160)}catch(e){if(out)out.textContent="PROBE FAILED: "+t(e&&e.message||e)}}try{document.getElementById("tepiha-copy-nav-log").addEventListener("click",copy);document.getElementById("tepiha-probe").addEventListener("click",probe)}catch(e){}})();<\/script>' +
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
      normalizedRouteKey: normalizedRouteKey(request && request.url),
      requestMode: safeString(request && request.mode),
      requestDestination: safeString(request && request.destination),
      online: (function () { try { return self.navigator && 'onLine' in self.navigator ? self.navigator.onLine : null; } catch (_) { return null; } })(),
      swVersion: APP_VERSION,
      swEpoch: APP_EPOCH,
      swNavDiagVersion: SW_NAV_DIAG_VERSION,
      safeScreenVersion: SAFE_SCREEN_VERSION,
      shellCacheName: NAV_SHELL_CACHE,
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
      entry.responseStatus = response ? response.status : null;
      if (isUsableShellResponse(response)) {
        entry.outcome = 'network_success';
        entry.networkOutcome = 'network_success';
        addAttempt(entry, 'navigation_network', 'success', { responseStatus: entry.responseStatus });
        try {
          var storePromise = storeVerifiedShellResponse(response.clone(), request && request.url, entry, 'navigation_network', { requireVerified: true })
            .then(function () { return recordNavigation(entry); })
            .catch(function () { return recordNavigation(entry); });
          if (event && event.waitUntil) event.waitUntil(storePromise);
        } catch (_) {}
        await recordNavigation(entry);
        return response;
      }

      entry.errorMessage = 'navigation returned unusable shell status ' + safeString(entry.responseStatus);
      entry.networkOutcome = 'network_bad_response';
      entry.outcome = 'network_bad_response';
      addAttempt(entry, 'navigation_network', 'bad_response', { responseStatus: entry.responseStatus });
      throw new Error(entry.errorMessage);
    } catch (error) {
      var errorMessage = safeString(error && (error.message || error.name) ? (error.message || error.name) : error);
      entry.durationMs = Date.now() - startedAt;
      if (!entry.errorMessage) entry.errorMessage = errorMessage;
      if (entry.networkOutcome !== 'network_bad_response') {
        entry.networkOutcome = /timeout|aborted|abort/i.test(errorMessage) ? 'network_timeout' : 'network_error';
        entry.outcome = entry.networkOutcome;
        addAttempt(entry, 'navigation_network', entry.networkOutcome, { errorMessage: errorMessage });
      }

      var cachedShell = await matchCachedShellCandidates(request, entry);
      if (cachedShell) {
        entry.durationMs = Date.now() - startedAt;
        entry.outcome = 'fallback_verified_cached_shell';
        try { entry.responseStatus = cachedShell.status; } catch (_) { entry.responseStatus = 200; }
        await recordNavigation(entry);
        return cachedShell;
      }

      var networkShell = await fetchNetworkShell(entry, request && request.url);
      if (networkShell) {
        entry.durationMs = Date.now() - startedAt;
        entry.outcome = 'fallback_verified_network_shell';
        try { entry.responseStatus = networkShell.status; } catch (_) { entry.responseStatus = 200; }
        await recordNavigation(entry);
        return networkShell;
      }

      entry.durationMs = Date.now() - startedAt;
      entry.outcome = 'fallback_offline_safe_screen';
      entry.responseStatus = 503;
      await recordNavigation(entry);
      return new Response(safeDarkHtml('RRJETI U VONUA', entry.errorMessage || errorMessage, entry.path || '/', entry), {
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
