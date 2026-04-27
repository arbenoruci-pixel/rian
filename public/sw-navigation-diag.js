/* TEPIHA SW Navigation Flight Recorder v34.2 — safe-screen self-report navigation diagnostics. */
/* eslint-disable no-restricted-globals */
(function () {
  'use strict';

  var NAV_DIAG_CACHE = 'tepiha-sw-navigation-diag-v1';
  var NAV_LAST_KEY = '/__tepiha_sw_nav_last.json';
  var NAV_LOG_KEY = '/__tepiha_sw_nav_log.json';
  var NAV_LOG_LIMIT = 50;
  var NAV_TIMEOUT_MS = 4500;
  var APP_EPOCH = 'RESET-2026-04-27-VITE-SAFE-SCREEN-SELF-REPORT-V34-2';
  var APP_VERSION = '2.0.41-vite-safe-screen-self-report-v34-2';
  var SW_NAV_DIAG_VERSION = 'sw-navigation-diag-v34.2-safe-screen-self-report';

  function nowIso() { try { return new Date().toISOString(); } catch (_) { return ''; } }
  function safeString(value) { try { return String(value == null ? '' : value); } catch (_) { return ''; } }
  function sameOrigin(url) { try { return new URL(url, self.location.origin).origin === self.location.origin; } catch (_) { return false; } }
  function requestPath(url) { try { var u = new URL(url, self.location.origin); return safeString(u.pathname + u.search); } catch (_) { return safeString(url || ''); } }

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
      return log;
    } catch (_) {
      return [entry || {}];
    }
  }

  function escapeHtml(value) {
    return safeString(value).replace(/[<>&"]/g, function (ch) {
      return ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[ch] || ch;
    });
  }

  function safeJson(value) {
    try { return JSON.stringify(value, null, 2); } catch (_) { return '{}'; }
  }

  function jsonForHtmlScript(value) {
    return safeJson(value).replace(/<\//g, '<\\/').replace(/<!--/g, '<\\!--');
  }

  function withCacheBust(path, stamp) {
    try {
      var raw = safeString(path || '/');
      var hash = '';
      var hashIndex = raw.indexOf('#');
      if (hashIndex >= 0) {
        hash = raw.slice(hashIndex);
        raw = raw.slice(0, hashIndex);
      }
      return raw + (raw.indexOf('?') >= 0 ? '&' : '?') + 't=' + encodeURIComponent(stamp) + hash;
    } catch (_) {
      return '/?t=' + encodeURIComponent(stamp);
    }
  }

  function buildSafeScreenPayload(reason, detail, retryHref, currentEvent, navigationLog) {
    var log = Array.isArray(navigationLog) ? navigationLog.slice(0, 20) : [];
    if (log.length < 1 && currentEvent) log = [currentEvent];
    return {
      title: 'RRJETI U VONUA',
      reason: safeString(reason || 'RRJETI U VONUA'),
      detail: safeString(detail || ''),
      generatedAt: nowIso(),
      safeScreenVersion: 'V34.2-SAFE-SCREEN-SELF-REPORT',
      noAutoReload: true,
      currentTimeoutEvent: currentEvent || null,
      last20NavigationEvents: log,
      sw: {
        version: APP_VERSION,
        epoch: APP_EPOCH,
        swNavigationDiagnosticVersion: SW_NAV_DIAG_VERSION,
        cacheName: NAV_DIAG_CACHE,
        keys: {
          last: NAV_LAST_KEY,
          log: NAV_LOG_KEY,
        },
      },
      links: {
        probe: withCacheBust('/__tepiha_probe.txt', Date.now()),
        diagRaw: withCacheBust('/diag-raw', Date.now()),
        home: withCacheBust('/', Date.now()),
        retry: withCacheBust(retryHref || '/', Date.now()),
      },
    };
  }

  function safeDarkHtml(reason, detail, retryHref, currentEvent, navigationLog) {
    var payload = buildSafeScreenPayload(reason, detail, retryHref, currentEvent, navigationLog);
    var escapedReason = escapeHtml(payload.reason || 'RRJETI U VONUA');
    var escapedDetail = escapeHtml(payload.detail || '');
    var escapedProbeHref = escapeHtml(payload.links.probe);
    var escapedDiagHref = escapeHtml(payload.links.diagRaw);
    var escapedHomeHref = escapeHtml(payload.links.home);
    var escapedRetryHref = escapeHtml(payload.links.retry);
    var jsonText = safeJson(payload);
    var escapedJson = escapeHtml(jsonText);
    var scriptJson = jsonForHtmlScript(payload);

    return '<!doctype html><html lang="sq" style="background:#05070d;color-scheme:dark"><head>' +
      '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">' +
      '<meta name="theme-color" content="#05070d"><title>TEPIHA - RRJETI U VONUA</title></head>' +
      '<body style="margin:0;min-height:100vh;background:#05070d;color:#e8eef6;font-family:system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;padding:22px;box-sizing:border-box">' +
      '<main style="width:min(760px,100%);margin:0 auto;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.06);border-radius:22px;padding:22px;box-shadow:0 20px 70px rgba(0,0,0,.38)">' +
      '<div style="font-size:13px;letter-spacing:.18em;color:#93c5fd;font-weight:1000;margin-bottom:10px">TEPIHA · SAFE SCREEN V34.2</div>' +
      '<h1 style="margin:0 0 8px;font-size:28px;line-height:1.08;color:#fff">RRJETI U VONUA</h1>' +
      '<p style="margin:0 0 18px;color:#cbd5e1;font-size:15px;line-height:1.45">Safari nuk mori përgjigje në kohë. Ky ekran po e tregon logun direkt nga Service Worker, para React-it, index.html, route bundle ose /diag-raw.</p>' +
      '<pre style="white-space:pre-wrap;word-break:break-word;background:#020617;border:1px solid rgba(255,255,255,.12);border-radius:14px;padding:12px;color:#cbd5e1;font-size:12px;line-height:1.4;margin:0 0 16px">' + escapedReason + (escapedDetail ? '\n' + escapedDetail : '') + '</pre>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px">' +
      '<button id="copy-nav-log" type="button" style="grid-column:1 / -1;border:0;border-radius:14px;background:#16a34a;color:#fff;padding:13px 10px;font-weight:1000;font-size:14px">COPY NAV LOG</button>' +
      '<a href="' + escapedProbeHref + '" style="text-align:center;text-decoration:none;border-radius:14px;background:rgba(96,165,250,.18);color:#bfdbfe;padding:13px 10px;font-weight:1000">PROBE</a>' +
      '<a href="' + escapedDiagHref + '" style="text-align:center;text-decoration:none;border-radius:14px;background:rgba(96,165,250,.18);color:#bfdbfe;padding:13px 10px;font-weight:1000">DIAG RAW</a>' +
      '<a href="' + escapedHomeHref + '" style="text-align:center;text-decoration:none;border-radius:14px;background:#2563eb;color:#fff;padding:13px 10px;font-weight:1000">HOME</a>' +
      '<a href="' + escapedRetryHref + '" style="text-align:center;text-decoration:none;border-radius:14px;background:rgba(255,255,255,.10);color:#fff;padding:13px 10px;font-weight:1000">RETRY</a>' +
      '</div>' +
      '<div style="margin:0 0 8px;color:#93c5fd;font-size:12px;letter-spacing:.08em;font-weight:1000">NAVIGATION DIAGNOSTIC JSON</div>' +
      '<pre id="nav-log-pre" style="max-height:48vh;overflow:auto;white-space:pre-wrap;word-break:break-word;background:#020617;border:1px solid rgba(255,255,255,.12);border-radius:14px;padding:12px;color:#dbeafe;font-size:11px;line-height:1.42;margin:0">' + escapedJson + '</pre>' +
      '<script id="tepiha-nav-log-json" type="application/json">' + scriptJson + '</script>' +
      '<script>(function(){try{var btn=document.getElementById("copy-nav-log");var raw=(document.getElementById("tepiha-nav-log-json")||{}).textContent||"{}";function fallbackCopy(text){var el=document.createElement("textarea");el.value=text;el.setAttribute("readonly","");el.style.position="fixed";el.style.left="-9999px";document.body.appendChild(el);el.focus();el.select();var ok=document.execCommand("copy");document.body.removeChild(el);return ok;}btn&&btn.addEventListener("click",function(){var done=false;Promise.resolve().then(function(){if(navigator.clipboard&&navigator.clipboard.writeText)return navigator.clipboard.writeText(raw).then(function(){done=true;});}).catch(function(){}).then(function(){if(!done)done=fallbackCopy(raw);btn.textContent=done?"NAV LOG U KOPJUA":"COPY FAILED - SELECT JSON";setTimeout(function(){btn.textContent="COPY NAV LOG";},1600);});});}catch(e){}})();</script>' +
      '</main></body></html>';
  }

  async function cachedIndexResponse() {
    try {
      var cached = await caches.match('/index.html', { ignoreSearch: true });
      if (cached) return cached;
    } catch (_) {}
    return null;
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
    var init = { credentials: 'same-origin', cache: 'no-store' };
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
      startTime: startedAt,
      outcome: 'no_fallback',
      networkOutcome: 'pending',
      durationMs: 0,
      errorMessage: '',
      responseStatus: null,
      controlledClientsCount: null,
    };

    try { entry.controlledClientsCount = await controlledClientsCount(); } catch (_) {}

    try {
      var response = await fetchNavigationWithTimeout(request);
      entry.durationMs = Date.now() - startedAt;
      entry.outcome = 'network_success';
      entry.networkOutcome = 'network_success';
      entry.responseStatus = response ? response.status : null;
      await recordNavigation(entry);
      return response;
    } catch (error) {
      var errorMessage = safeString(error && (error.message || error.name) ? (error.message || error.name) : error);
      entry.durationMs = Date.now() - startedAt;
      entry.errorMessage = errorMessage;
      entry.networkFailure = /timeout|aborted|abort/i.test(errorMessage) ? 'network_timeout' : 'network_error';
      entry.networkOutcome = entry.networkFailure;

      var cached = await cachedIndexResponse();
      if (cached) {
        entry.outcome = 'fallback_cache';
        try { entry.responseStatus = cached.status; } catch (_) { entry.responseStatus = 200; }
        await recordNavigation(entry);
        return cached;
      }

      entry.outcome = 'fallback_offline_safe_screen';
      entry.responseStatus = 503;
      var navigationLog = await recordNavigation(entry);
      return new Response(safeDarkHtml('RRJETI U VONUA', errorMessage, entry.path || '/', entry, navigationLog), {
        status: 503,
        statusText: 'Navigation Timeout',
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }
  }

  self.addEventListener('fetch', function (event) {
    try {
      var request = event && event.request;
      if (!request || request.method !== 'GET') return;
      if (request.mode !== 'navigate') return;
      if (!sameOrigin(request.url)) return;
      event.respondWith(handleNavigation(event));
    } catch (_) {}
  });
})();
