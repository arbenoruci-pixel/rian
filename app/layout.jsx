// LEGACY / INACTIVE NEXT LAYOUT
// ------------------------------------------------------------
// Runtime aktiv në këtë repo është Vite + React Router:
//   - src/main.jsx
//   - src/AppRoot.jsx
//   - src/generated/routes.generated.jsx
// Ky file mbahet vetëm si referencë historike nga migrimi.
// MOS E PËRDORE SI source of truth për startup/runtime patches.

import './globals.css';
import dynamic from '@/lib/dynamicCompat.jsx';
import Script from '@/lib/scriptCompat.jsx';
import AuthGate from '@/components/AuthGate';
import GlobalErrorBoundary from '@/components/GlobalErrorBoundary';
import DeferredMount from '@/components/DeferredMount';
import BootReadyMark from '@/components/BootReadyMark';
import { APP_DATA_EPOCH as APP_EPOCH } from '@/lib/appEpoch';

const ServiceWorkerRegister = dynamic(() => import('@/components/ServiceWorkerRegister'), { ssr: false });
const OfflineSyncRunner = dynamic(() => import('@/components/OfflineSyncRunner'), { ssr: false });
const SyncStarter = dynamic(() => import('@/components/SyncStarter'), { ssr: false });
const RuntimeIncidentUploader = dynamic(() => import('@/components/RuntimeIncidentUploader'), { ssr: false });

export const metadata = {
  title: 'TEPIHA',
  manifest: '/manifest.json',
};

export const viewport = {
  themeColor: '#0b0f14',
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
};

const ROOT_VISIBILITY_WATCHDOG = `
(function(){
  try {
    var STORE_KEY = 'tepiha_root_watchdog_last_v1';
    function uniq(list) {
      var seen = [];
      return list.filter(function(node){
        if (!node) return false;
        if (seen.indexOf(node) >= 0) return false;
        seen.push(node);
        return true;
      });
    }
    function roots() {
      var list = [];
      try { list.push(document.documentElement); } catch (e) {}
      try { list.push(document.body); } catch (e) {}
      try { list.push(document.getElementById('__next')); } catch (e) {}
      try { list.push(document.querySelector('[data-nextjs-scroll-focus-boundary]')); } catch (e) {}
      try { list.push(document.querySelector('body > main')); } catch (e) {}
      try { list.push(document.body && document.body.firstElementChild); } catch (e) {}
      try { list.push(document.querySelector('body > div')); } catch (e) {}
      return uniq(list);
    }
    function readState(node) {
      if (!node || !window.getComputedStyle) return null;
      try {
        var cs = window.getComputedStyle(node);
        return {
          tag: String(node.tagName || '').toLowerCase(),
          id: String(node.id || ''),
          display: String(cs.display || ''),
          visibility: String(cs.visibility || ''),
          opacity: String(cs.opacity || ''),
          pointerEvents: String(cs.pointerEvents || ''),
          hiddenAttr: !!(node.hasAttribute && node.hasAttribute('hidden')),
          childCount: Number(node.childElementCount || 0) || 0
        };
      } catch (e) {
        return null;
      }
    }
    function persist(reason, changed, details) {
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify({
          at: new Date().toISOString(),
          reason: String(reason || ''),
          changed: !!changed,
          visibilityState: String(document.visibilityState || ''),
          appEpoch: window.__TEPIHA_APP_EPOCH || '',
          details: details || []
        }));
      } catch (e) {}
    }
    function shouldFix(state, isRoot) {
      if (!state) return false;
      var opacity = parseFloat(state.opacity || '1');
      if (state.hiddenAttr) return true;
      if (state.visibility === 'hidden') return true;
      if (isFinite(opacity) && opacity < 0.05) return true;
      if (state.pointerEvents === 'none' && isRoot) return true;
      if (state.display === 'none' && (isRoot || state.childCount > 0)) return true;
      return false;
    }
    function fixNode(node, isRoot) {
      if (!node || !node.style) return false;
      var state = readState(node);
      if (!shouldFix(state, isRoot)) return false;
      try {
        if (state.display === 'none') node.style.display = isRoot ? 'block' : '';
        if (state.visibility === 'hidden') node.style.visibility = 'visible';
        if (parseFloat(state.opacity || '1') < 0.05) node.style.opacity = '1';
        if (state.pointerEvents === 'none') node.style.pointerEvents = 'auto';
        if (node.hasAttribute && node.hasAttribute('hidden')) node.removeAttribute('hidden');
        if ('inert' in node && node.inert) node.inert = false;
        try { node.removeAttribute('aria-hidden'); } catch (e) {}
        return true;
      } catch (e) {
        return false;
      }
    }
    function run(reason) {
      try {
        if (document.visibilityState === 'hidden') return;
        var list = roots();
        var changed = false;
        var details = [];
        for (var i = 0; i < list.length; i += 1) {
          var node = list[i];
          var before = readState(node);
          var fixed = fixNode(node, i < 2);
          var after = readState(node);
          if (before || after) details.push({ before: before, after: after, fixed: !!fixed });
          if (fixed) changed = true;
        }
        if (changed) {
          try { document.documentElement.setAttribute('data-root-watchdog-recovered', String(reason || '1')); } catch (e) {}
          try { document.body && document.body.setAttribute('data-root-watchdog-recovered', String(reason || '1')); } catch (e) {}
        }
        persist(reason, changed, details.slice(0, 6));
      } catch (e) {}
    }
    function later(reason, delay) {
      setTimeout(function(){ run(reason); }, delay);
    }
    function inStartupIsolation() {
      try {
        if (window.__TEPIHA_STARTUP_ISOLATION__ !== true) return false;
        var until = Number(window.__TEPIHA_STARTUP_ISOLATION_UNTIL__ || 0) || 0;
        return until > Date.now();
      } catch (e) {
        return false;
      }
    }
    later('startup_60', 60);
    later('startup_450', 450);
    later('startup_1200', 1200);
    if (!inStartupIsolation()) {
      window.addEventListener('pageshow', function(){ later('pageshow', 40); }, { passive: true });
      window.addEventListener('focus', function(){ later('focus', 40); }, { passive: true });
      window.addEventListener('storage', function(){ later('storage', 40); }, { passive: true });
      document.addEventListener('visibilitychange', function(){
        if (document.visibilityState === 'visible') later('visibility_visible', 40);
      }, { passive: true });
    }
  } catch (e) {}
})();
`;

const INLINE_RUNTIME_FLAGS = `
window.__TEPIHA_APP_EPOCH=${JSON.stringify(APP_EPOCH)};
window.__TEPIHA_SW_KILL_SWITCH__=false;
window.__TEPIHA_FORCE_NETWORK_MODE__=false;
window.__TEPIHA_DIAG_SYSTEM_ENABLED__=false;
window.__TEPIHA_DIAG_RUNTIME_ENABLED__=false;
window.__TEPIHA_RUNTIME_INCIDENTS_ENABLED__=true;
window.__TEPIHA_SIMPLE_INCIDENTS_ENABLED__=true;
window.__TEPIHA_STARTUP_ISOLATION__=true;
window.__TEPIHA_STARTUP_ISOLATION_WINDOW_MS__=12000;
(function(){
  try {
    var untilKey = '__TEPIHA_STARTUP_ISOLATION_UNTIL__';
    var nextUntil = Date.now() + 12000;
    try {
      var existingUntil = Number(sessionStorage.getItem(untilKey) || 0) || 0;
      if (existingUntil > nextUntil) nextUntil = existingUntil;
    } catch (e) {}
    window.__TEPIHA_STARTUP_ISOLATION_UNTIL__ = nextUntil;
    try { sessionStorage.setItem(untilKey, String(nextUntil)); } catch (e) {}
  } catch (e) {}
})();
(function(){
  try {
    var qs = new URLSearchParams((location && location.search) || '');
    var offKey = '__TEPIHA_SIMPLE_INCIDENTS_DISABLED__';
    var raw = qs.get('__incident_off');
    if (raw === '1') {
      try { sessionStorage.setItem(offKey, '1'); } catch (e) {}
      try { localStorage.setItem(offKey, '1'); } catch (e) {}
    } else if (raw === '0') {
      try { sessionStorage.removeItem(offKey); } catch (e) {}
      try { localStorage.removeItem(offKey); } catch (e) {}
    }
    var disabled = false;
    try { disabled = disabled || sessionStorage.getItem(offKey) === '1'; } catch (e) {}
    try { disabled = disabled || localStorage.getItem(offKey) === '1'; } catch (e) {}
    window.__TEPIHA_SIMPLE_INCIDENTS_ENABLED__ = !disabled;
    window.__TEPIHA_RUNTIME_INCIDENTS_ENABLED__ = !disabled;
  } catch (e) {
    window.__TEPIHA_SIMPLE_INCIDENTS_ENABLED__ = true;
    window.__TEPIHA_RUNTIME_INCIDENTS_ENABLED__ = true;
  }
})();
(function(){
  try {
    if (window.__TEPIHA_SIMPLE_INCIDENTS_ENABLED__ === false) return;
    var bootIdKey = 'tepiha_boot_current_id';
    var inProgressKey = 'tepiha_boot_in_progress';
    var lastInterruptedKey = 'tepiha_boot_last_interrupted';
    var historyKey = 'tepiha_boot_trace_last';
    var lastIncidentKey = 'tepiha_simple_last_incident_v1';
    var fallbackLogsKey = 'tepiha_diag_fallback_logs_v2';
    var bootId = '';
    try { bootId = String(sessionStorage.getItem(bootIdKey) || localStorage.getItem(bootIdKey) || ''); } catch (e) {}
    if (!bootId) {
      bootId = 'boot_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      try { sessionStorage.setItem(bootIdKey, bootId); } catch (e) {}
      try { localStorage.setItem(bootIdKey, bootId); } catch (e) {}
    }
    window.BOOT_ID = bootId;
    var sent = false;
    var startedAt = new Date().toISOString();
    function safeJson(v, fallback) {
      try { return JSON.parse(JSON.stringify(v)); } catch (e) { return fallback; }
    }
    function readJson(key, fallback) {
      try {
        var raw = localStorage.getItem(key);
        if (!raw) return fallback;
        var parsed = JSON.parse(raw);
        return parsed == null ? fallback : parsed;
      } catch (e) {
        return fallback;
      }
    }
    function writeJson(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
    }
    function appendHistory(entry) {
      try {
        var list = readJson(historyKey, []);
        if (!Array.isArray(list)) list = [];
        list.unshift(entry);
        if (list.length > 12) list = list.slice(0, 12);
        writeJson(historyKey, list);
      } catch (e) {}
    }
    function appendFallbackLog(entry) {
      try {
        var list = readJson(fallbackLogsKey, []);
        if (!Array.isArray(list)) list = [];
        list.unshift(entry);
        if (list.length > 20) list = list.slice(0, 20);
        writeJson(fallbackLogsKey, list);
      } catch (e) {}
    }
    function collectMeta(extra) {
      var root = null;
      try { root = document.getElementById('__next'); } catch (e) {}
      return Object.assign({
        source: 'inline_watchdog_v4',
        readyState: (document && document.readyState) || '',
        visibilityState: (document && document.visibilityState) || '',
        href: (location && location.href) || '',
        appEpoch: window.__TEPIHA_APP_EPOCH || '',
        referrer: (document && document.referrer) || '',
        bodyChildCount: (document && document.body && document.body.children && document.body.children.length) || 0,
        rootChildCount: (root && root.children && root.children.length) || 0,
        bodyHtmlLength: (document && document.body && document.body.innerHTML && document.body.innerHTML.length) || 0,
        hasUiReadyAttr: !!(document && document.documentElement && document.documentElement.getAttribute && document.documentElement.getAttribute('data-ui-ready') === '1'),
        hasBodyUiReadyAttr: !!(document && document.body && document.body.getAttribute && document.body.getAttribute('data-ui-ready') === '1'),
        hasNextScript: !!(document && document.querySelector && document.querySelector('script[src*="/_next/"]')),
        hasNextCss: !!(document && document.querySelector && document.querySelector('link[href*="/_next/"][rel="stylesheet"]')),
        standalone: !!(window.navigator && window.navigator.standalone),
        online: typeof navigator !== 'undefined' ? navigator.onLine : null
      }, extra || {});
    }
    function writeInProgress(pathOverride) {
      var path = pathOverride || ((location && location.pathname) || '/');
      var search = (location && location.search) || '';
      var snapshot = {
        bootId: bootId,
        sessionId: null,
        startedAt: startedAt,
        path: path,
        bootRootPath: path,
        currentPath: path,
        search: search,
        currentSearch: search,
        url: (location && location.href) || '',
        uiReady: !!window.__TEPIHA_UI_READY,
        readyAt: window.__TEPIHA_UI_READY ? new Date().toISOString() : null,
        endedCleanly: false,
        phase: window.__TEPIHA_UI_READY ? 'ready' : 'booting',
        incidentType: '',
        lastEventType: 'inline_boot_start',
        lastEventAt: new Date().toISOString(),
        online: typeof navigator !== 'undefined' ? navigator.onLine : null,
        visibilityState: (document && document.visibilityState) || '',
        swEpoch: window.__TEPIHA_APP_EPOCH || '',
        events: [{ type: 'inline_boot_start', at: startedAt, data: { path: path, search: search, source: 'inline_watchdog_v4' } }]
      };
      writeJson(inProgressKey, snapshot);
    }
    writeInProgress();
    function persistLocalIncident(reason, meta) {
      var path = (location && location.pathname) || '/';
      var search = (location && location.search) || '';
      var entry = {
        bootId: bootId,
        sessionId: null,
        startedAt: startedAt,
        bootRootPath: path,
        currentPath: path,
        currentSearch: search,
        readyAt: !!window.__TEPIHA_UI_READY ? new Date().toISOString() : '',
        uiReady: !!window.__TEPIHA_UI_READY,
        lastEventType: reason,
        lastEventAt: new Date().toISOString(),
        online: typeof navigator !== 'undefined' ? navigator.onLine : null,
        visibilityState: (document && document.visibilityState) || '',
        swEpoch: window.__TEPIHA_APP_EPOCH || '',
        overlayShown: false,
        incidentType: reason,
        endedCleanly: false,
        phase: 'booting',
        meta: safeJson(meta || {}, {}),
        events: [{ type: reason, at: new Date().toISOString(), data: safeJson(meta || {}, {}) }]
      };
      writeJson(lastInterruptedKey, entry);
      writeJson(lastIncidentKey, entry);
      appendHistory(entry);
      appendFallbackLog(entry);
      return entry;
    }
    function postIncident(reason, meta) {
      var entry = persistLocalIncident(reason, meta || {});
      if (sent) return entry;
      sent = true;
      try {
        fetch('/api/runtime-incident', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          keepalive: true,
          body: JSON.stringify({
            bootId: bootId,
            sessionId: null,
            incidentType: reason,
            reason: reason,
            startedAt: startedAt,
            lastEventAt: new Date().toISOString(),
            currentPath: (location && location.pathname) || '/',
            currentSearch: (location && location.search) || '',
            bootRootPath: (location && location.pathname) || '/',
            lastEventType: reason,
            uiReady: !!window.__TEPIHA_UI_READY,
            online: typeof navigator !== 'undefined' ? navigator.onLine : null,
            visibilityState: (document && document.visibilityState) || '',
            swEpoch: window.__TEPIHA_APP_EPOCH || '',
            userAgent: (navigator && navigator.userAgent) || '',
            meta: meta || {}
          })
        }).catch(function(){});
      } catch (e) {}
      return entry;
    }
    window.__TEPIHA_INLINE_INCIDENT__ = postIncident;
    setTimeout(function(){
      try {
        if (window.__TEPIHA_SIMPLE_INCIDENTS_ENABLED__ === false) return;
        if (document.visibilityState !== 'visible') return;
        if (window.__TEPIHA_UI_READY === true) return;
        postIncident('inline_boot_timeout', collectMeta());
      } catch (e) {}
    }, 10000);
    window.addEventListener('error', function(event){
      try {
        var message = String((event && event.message) || '');
        var stack = String((event && event.error && event.error.stack) || '');
        if (/window\.webkit\.messageHandlers/i.test(message) || /window\.webkit\.messageHandlers/i.test(stack)) return;
        postIncident('inline_window_error', collectMeta({
          message: message,
          filename: String((event && event.filename) || ''),
          lineno: Number((event && event.lineno) || 0) || 0,
          colno: Number((event && event.colno) || 0) || 0,
          stack: stack
        }));
      } catch (e) {}
    }, { passive: true });
    window.addEventListener('unhandledrejection', function(event){
      try {
        var reason = event && event.reason;
        postIncident('inline_unhandled_rejection', collectMeta({
          message: String((reason && reason.message) || reason || ''),
          stack: String((reason && reason.stack) || '')
        }));
      } catch (e) {}
    }, { passive: true });
  } catch (e) {}
})();
`;

export default function RootLayout({ children }) {
  return (
    <html lang="sq" style={{ background: "#05070d", colorScheme: "dark" }}>
      <head>
        <meta name="tepiha-app-epoch" content={APP_EPOCH} />
        <Script
          id="tepiha-app-runtime-flags"
          strategy="beforeInteractive"
          dangerouslySetInnerHTML={{ __html: INLINE_RUNTIME_FLAGS }}
        />
        <Script
          id="tepiha-root-visibility-watchdog"
          strategy="beforeInteractive"
          dangerouslySetInnerHTML={{ __html: ROOT_VISIBILITY_WATCHDOG }}
        />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="default" />
        <link rel="apple-touch-icon" href="/icon-192.png" />
      </head>
      <body style={{ background: "#05070d", color: "#fff" }}>
        <AuthGate>
          <GlobalErrorBoundary>
            <BootReadyMark />
            {children}

            <DeferredMount delay={900} idle wakeSafe wakeBufferMs={1800}>
              <RuntimeIncidentUploader />
            </DeferredMount>

            <DeferredMount delay={1400} idle wakeSafe wakeBufferMs={2400} runtimeOwner waitForOwnerSignal={false}>
              <ServiceWorkerRegister />
            </DeferredMount>

            <DeferredMount delay={2600} idle wakeSafe wakeBufferMs={4200}>
              <OfflineSyncRunner />
            </DeferredMount>

            <DeferredMount delay={3400} idle wakeSafe wakeBufferMs={5200}>
              <SyncStarter />
            </DeferredMount>
          </GlobalErrorBoundary>
        </AuthGate>
      </body>
    </html>
  );
}
