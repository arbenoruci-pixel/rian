const LAST_CHUNK_CAPTURE_KEY = 'tepiha_chunk_last_capture_v1';
const LAST_LAZY_IMPORT_KEY = 'tepiha_last_lazy_import_failure_v1';
const LAST_LAZY_IMPORT_ATTEMPT_KEY = 'tepiha_last_lazy_import_attempt_v1';
const LAZY_IMPORT_LOG_KEY = 'tepiha_lazy_import_log_v1';
const ROUTE_DIAG_LOG_KEY = 'tepiha_route_diag_log_v1';
const DOM_PREHEAL_LOG_KEY = 'tepiha_dom_preheal_log_v1';
const DOM_PREHEAL_LAST_KEY = 'tepiha_dom_preheal_last_v1';
const ACTIVE_ROUTE_REQUEST_KEY = 'tepiha_active_route_request_v1';
const ROUTE_TRANSITION_KEY = 'tepiha_route_transition_v1';
const MAX_LOG = 24;
const MAX_ROUTE_DIAG_LOG = 160;
const MAX_DOM_PREHEAL_LOG = 80;

function isBrowser() {
  return typeof window !== 'undefined';
}

function safeParse(raw, fallback = null) {
  try {
    const parsed = JSON.parse(raw);
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function safeClone(value, fallback = null) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return fallback;
  }
}

function readJson(key, fallback = null, storage = null) {
  if (!isBrowser()) return fallback;
  try {
    const target = storage || window.localStorage;
    return safeParse(target?.getItem(key), fallback);
  } catch {
    return fallback;
  }
}

function writeJson(key, value, storage = null) {
  if (!isBrowser()) return;
  try {
    const target = storage || window.localStorage;
    target?.setItem(key, JSON.stringify(value));
  } catch {
    // ignore
  }
}

function removeJson(key, storage = null) {
  if (!isBrowser()) return;
  try {
    const target = storage || window.localStorage;
    target?.removeItem(key);
  } catch {
    // ignore
  }
}

function nowIso() {
  try {
    return new Date().toISOString();
  } catch {
    return '';
  }
}

function getBootId() {
  if (!isBrowser()) return '';
  try {
    return String(
      window.BOOT_ID
      || window.sessionStorage?.getItem('tepiha_boot_current_id')
      || window.localStorage?.getItem('tepiha_boot_current_id')
      || ''
    );
  } catch {
    return '';
  }
}

function currentContext() {
  if (!isBrowser()) {
    return {
      href: '',
      path: '',
      search: '',
      visibilityState: '',
      hidden: false,
      online: null,
      appEpoch: '',
      buildId: '',
      bootId: '',
      baseURI: '',
      userAgent: '',
    };
  }
  return {
    href: String(window.location?.href || ''),
    path: String(window.location?.pathname || ''),
    search: String(window.location?.search || ''),
    visibilityState: (() => {
      try { return String(document.visibilityState || ''); } catch { return ''; }
    })(),
    hidden: (() => {
      try { return document.visibilityState !== 'visible'; } catch { return false; }
    })(),
    online: (() => {
      try { return navigator.onLine; } catch { return null; }
    })(),
    appEpoch: (() => {
      try { return String(window.__TEPIHA_APP_EPOCH || ''); } catch { return ''; }
    })(),
    buildId: (() => {
      try { return String(window.__TEPIHA_BUILD_ID || ''); } catch { return ''; }
    })(),
    bootId: getBootId(),
    baseURI: (() => {
      try { return String(document.baseURI || window.location?.href || ''); } catch { return ''; }
    })(),
    userAgent: (() => {
      try { return String(navigator.userAgent || ''); } catch { return ''; }
    })(),
  };
}

function appendLog(key, entry) {
  const list = readJson(key, []);
  const next = [entry, ...((Array.isArray(list) ? list : []).filter(Boolean))].slice(0, MAX_LOG);
  writeJson(key, next);
}

export function appendPersistentRing(key, entry, max = 100, storage = null) {
  const list = readJson(key, [], storage);
  const next = [entry, ...((Array.isArray(list) ? list : []).filter(Boolean))].slice(0, Math.max(8, Number(max) || 100));
  writeJson(key, next, storage);
  return next;
}

export function readPersistentJson(key, fallback = null, storage = null) {
  return readJson(key, fallback, storage);
}

function readActiveRouteRequest() {
  if (!isBrowser()) return null;
  try {
    const live = window.__TEPIHA_ACTIVE_ROUTE_REQUEST__;
    if (live && typeof live === 'object') return safeClone(live, null);
  } catch {
    // ignore
  }
  const session = readJson(ACTIVE_ROUTE_REQUEST_KEY, null, isBrowser() ? window.sessionStorage : null);
  if (session) return session;
  return readJson(ACTIVE_ROUTE_REQUEST_KEY, null);
}

function readRouteTransition() {
  if (!isBrowser()) return null;
  try {
    const live = window.__TEPIHA_ROUTE_TRANSITION__;
    if (live && typeof live === 'object') return safeClone(live, null);
  } catch {
    // ignore
  }
  const session = readJson(ROUTE_TRANSITION_KEY, null, isBrowser() ? window.sessionStorage : null);
  if (session) return session;
  return readJson(ROUTE_TRANSITION_KEY, null);
}

function normalizeError(error) {
  return {
    name: String(error?.name || ''),
    message: String(error?.message || error || ''),
    stack: String(error?.stack || ''),
  };
}

function extractAssetUrls() {
  const hits = [];
  for (const value of arguments) {
    const text = String(value || '');
    if (!text) continue;
    const matches = text.match(/https?:\/\/[^\s)"']+|\/_next\/static\/chunks\/[^\s)"']+|\/assets\/[^\s)"']+\.(?:js|mjs)(?:\?[^\s)"']*)?/gi) || [];
    hits.push(...matches.map((item) => String(item || '')));
  }
  return Array.from(new Set(hits.filter(Boolean))).slice(0, 8);
}

function resolveAssetUrl(raw) {
  if (!raw) return '';
  try {
    return String(new URL(String(raw), String(document.baseURI || window.location?.href || '/')).toString());
  } catch {
    try { return String(raw || ''); } catch { return ''; }
  }
}

function readLastLazyImportAttempt() {
  if (!isBrowser()) return null;
  try {
    const live = window.__TEPIHA_LAST_LAZY_IMPORT_ATTEMPT__;
    if (live && typeof live === 'object') return safeClone(live, null);
  } catch {}
  return readJson(LAST_LAZY_IMPORT_ATTEMPT_KEY, null);
}

function buildBaseTimelineEntry(type, payload = {}) {
  const ctx = currentContext();
  const routeTransition = safeClone(payload?.routeTransition, null) || readRouteTransition();
  const activeRouteRequest = safeClone(payload?.activeRouteRequest, null) || readActiveRouteRequest();
  const ts = Number(payload?.ts || Date.now()) || Date.now();
  const routeTransitionToken = String(
    payload?.routeTransitionToken
    || activeRouteRequest?.token
    || (routeTransition?.at ? `${routeTransition.at}:${routeTransition?.toPath || ''}` : '')
    || ''
  );
  const currentPath = String(payload?.currentPath || payload?.path || ctx.path || '');
  const previousPath = String(
    payload?.previousPath
    || activeRouteRequest?.previousPath
    || routeTransition?.fromPath
    || ''
  );
  const transitionInFlight = typeof payload?.transitionInFlight === 'boolean'
    ? payload.transitionInFlight
    : !!(routeTransition?.toPath && routeTransition.toPath !== currentPath);

  return {
    type: String(type || 'event'),
    ts,
    at: nowIso(),
    ...ctx,
    currentPath,
    previousPath,
    routeTransitionToken,
    transitionInFlight,
    activeRouteRequest,
    routeTransition,
    ...safeClone(payload, {}),
  };
}

export function recordPersistentTimelineEvent(key, type, payload = {}, max = 100) {
  if (!isBrowser()) return null;
  const entry = buildBaseTimelineEntry(type, payload);
  appendPersistentRing(key, entry, max);
  try { window.__TEPIHA_LAST_TIMELINE_EVENT__ = entry; } catch {}
  try { window.dispatchEvent(new CustomEvent('tepiha:timeline-event', { detail: entry })); } catch {}
  return entry;
}

export function recordRouteDiagEvent(type, payload = {}, max = MAX_ROUTE_DIAG_LOG) {
  if (!isBrowser()) return null;
  const entry = buildBaseTimelineEntry(type, payload);
  appendPersistentRing(ROUTE_DIAG_LOG_KEY, entry, max);
  try { window.__TEPIHA_LAST_ROUTE_DIAG__ = entry; } catch {}
  try { window.dispatchEvent(new CustomEvent('tepiha:route-diag', { detail: entry })); } catch {}
  return entry;
}

function queryOverlayPresent() {
  if (!isBrowser() || typeof document === 'undefined') return false;
  try {
    const selectors = [
      '[data-overlay="1"]',
      '[data-auth-overlay="1"]',
      '[data-loading-overlay="1"]',
      '[data-route-overlay="1"]',
      '.loading-overlay',
      '.route-overlay',
      '.auth-overlay',
      '[data-modal-backdrop="1"]',
      '[data-screen-cover="1"]',
      '[data-blackout-overlay="1"]',
    ];
    return !!document.querySelector(selectors.join(','));
  } catch {
    return false;
  }
}

export function recordDomPreHealSnapshot(reason = 'pre_heal', payload = {}, max = MAX_DOM_PREHEAL_LOG) {
  if (!isBrowser() || typeof document === 'undefined') return null;
  const ctx = currentContext();
  const root = document.getElementById('root') || document.body?.firstElementChild || document.body || document.documentElement || null;
  let computed = null;
  try { computed = root && window.getComputedStyle ? window.getComputedStyle(root) : null; } catch { computed = null; }
  const snapshot = {
    type: 'dom_preheal_snapshot',
    ts: Date.now(),
    at: nowIso(),
    ...ctx,
    currentPath: String(payload?.currentPath || payload?.path || ctx.path || ''),
    activeRoutePath: String(payload?.activeRoutePath || payload?.path || ctx.path || ''),
    source: String(payload?.source || payload?.sourceLayer || 'runtime'),
    sourceLayer: String(payload?.sourceLayer || payload?.source || 'runtime'),
    reason: String(reason || payload?.reason || 'pre_heal'),
    bootId: String(payload?.bootId || ctx.bootId || ''),
    rootExists: !!root,
    rootId: String(root?.id || ''),
    rootTag: String(root?.tagName || ''),
    display: String(computed?.display || ''),
    visibility: String(computed?.visibility || ''),
    opacity: String(computed?.opacity ?? ''),
    pointerEvents: String(computed?.pointerEvents || ''),
    hiddenAttr: !!root?.hasAttribute?.('hidden'),
    inert: !!root?.inert,
    ariaHidden: String(root?.getAttribute?.('aria-hidden') || ''),
    overlayPresent: queryOverlayPresent(),
    fallbackPresent: (() => {
      try { return !!document.querySelector?.('[data-route-fallback="1"]'); } catch { return false; }
    })(),
    docHidden: (() => {
      try { return !!document.hidden; } catch { return false; }
    })(),
    extra: safeClone(payload, {}),
  };
  writeJson(DOM_PREHEAL_LAST_KEY, snapshot);
  appendPersistentRing(DOM_PREHEAL_LOG_KEY, snapshot, max);
  try { window.__TEPIHA_LAST_DOM_PREHEAL__ = snapshot; } catch {}
  try { window.dispatchEvent(new CustomEvent('tepiha:dom-preheal', { detail: snapshot })); } catch {}
  return snapshot;
}

function waitForVisibility(maxWaitMs = 1800) {
  if (!isBrowser()) return Promise.resolve();
  try {
    if (document.visibilityState === 'visible') return Promise.resolve();
  } catch {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let done = false;
    let timer = 0;
    const finish = () => {
      if (done) return;
      done = true;
      try { window.clearTimeout(timer); } catch {}
      try { document.removeEventListener('visibilitychange', onVisible, true); } catch {}
      resolve();
    };
    const onVisible = () => {
      try {
        if (document.visibilityState === 'visible') finish();
      } catch {
        finish();
      }
    };
    try { document.addEventListener('visibilitychange', onVisible, true); } catch {}
    timer = window.setTimeout(finish, Math.max(300, Number(maxWaitMs) || 1800));
  });
}

export function isProbablyChunkLikeMessage(input) {
  try {
    const value = String(input || '');
    return /loading chunk|chunkloaderror|chunk [0-9]+ failed|failed to fetch dynamically imported module|error loading dynamically imported module|importing a module script failed|failed to load module script|module script failed|module script|dynamically imported module|\/assets\/.*\.(?:js|mjs)(?:\?|$)|\/_next\/static\/chunks\//i.test(value);
  } catch {
    return false;
  }
}

export function getLastChunkCapture() {
  return readJson(LAST_CHUNK_CAPTURE_KEY, null);
}

export function getLastLazyImportFailure() {
  return readJson(LAST_LAZY_IMPORT_KEY, null);
}

export function getLastLazyImportAttempt() {
  return readLastLazyImportAttempt();
}

export function recordChunkCapture(reason = 'chunk_capture', payload = {}) {
  if (!isBrowser()) return null;
  const entry = {
    at: nowIso(),
    reason: String(reason || 'chunk_capture'),
    ...currentContext(),
    ...(payload && typeof payload === 'object' ? payload : {}),
  };
  writeJson(LAST_CHUNK_CAPTURE_KEY, entry);
  appendLog(LAZY_IMPORT_LOG_KEY, entry);
  try {
    window.__TEPIHA_LAST_CHUNK_CAPTURE__ = entry;
  } catch {
    // ignore
  }
  try {
    window.dispatchEvent(new CustomEvent('tepiha:chunk-capture', { detail: entry }));
  } catch {
    // ignore
  }
  return entry;
}

export async function loadLazyModule(importer, meta = {}) {
  const ctx = currentContext();
  const activeRouteRequest = readActiveRouteRequest();
  const routeTransition = readRouteTransition();
  const entry = {
    at: nowIso(),
    ts: Date.now(),
    kind: String(meta?.kind || 'lazy'),
    label: String(meta?.label || meta?.moduleId || 'lazy-module'),
    moduleId: String(meta?.moduleId || meta?.label || ''),
    requestedModule: String(meta?.requestedModule || meta?.moduleId || meta?.label || ''),
    importerHint: String(meta?.importerHint || meta?.moduleId || meta?.label || ''),
    importCaller: String(meta?.importCaller || meta?.caller || ''),
    componentName: String(meta?.componentName || ''),
    importRetryCount: Number(meta?.importRetryCount ?? meta?.retryCount ?? 0) || 0,
    retryCount: Number(meta?.retryCount ?? meta?.importRetryCount ?? 0) || 0,
    currentPath: String(meta?.path || ctx.path || ''),
    previousPath: String(meta?.previousPath || activeRouteRequest?.previousPath || routeTransition?.fromPath || ''),
    routeTransitionToken: String(meta?.routeTransitionToken || activeRouteRequest?.token || ''),
    baseURI: String(ctx.baseURI || ''),
    ...ctx,
  };

  try {
    window.__TEPIHA_LAST_LAZY_IMPORT_ATTEMPT__ = entry;
  } catch {
    // ignore
  }
  writeJson(LAST_LAZY_IMPORT_ATTEMPT_KEY, entry);

  appendLog(LAZY_IMPORT_LOG_KEY, {
    ...entry,
    phase: 'start',
  });

  recordRouteDiagEvent('route_module_import_start', {
    path: entry.currentPath || entry.path,
    currentPath: entry.currentPath || entry.path,
    previousPath: entry.previousPath,
    kind: entry.kind,
    label: entry.label,
    moduleId: entry.moduleId,
    requestedModule: entry.requestedModule,
    importerHint: entry.importerHint,
    importCaller: entry.importCaller,
    componentName: entry.componentName,
    importRetryCount: entry.importRetryCount,
    retryCount: entry.retryCount,
    userAgent: entry.userAgent,
    appEpoch: entry.appEpoch,
    baseURI: entry.baseURI,
    sourceLayer: 'lazy_import_runtime',
  });

  if (entry.kind === 'component') {
    recordRouteDiagEvent('dynamic_component_import_start', {
      path: entry.currentPath || entry.path,
      currentPath: entry.currentPath || entry.path,
      previousPath: entry.previousPath,
      kind: entry.kind,
      label: entry.label,
      moduleId: entry.moduleId,
      requestedModule: entry.requestedModule,
      importerHint: entry.importerHint,
      importCaller: entry.importCaller,
      componentName: entry.componentName,
      importRetryCount: entry.importRetryCount,
      retryCount: entry.retryCount,
      userAgent: entry.userAgent,
      appEpoch: entry.appEpoch,
      baseURI: entry.baseURI,
      visibilityState: entry.visibilityState,
      hidden: entry.hidden,
      online: entry.online,
      sourceLayer: 'lazy_import_runtime',
    });
  }

  if (ctx.visibilityState === 'hidden') {
    recordChunkCapture('lazy_import_wait_visible', {
      label: entry.label,
      moduleId: entry.moduleId,
      kind: entry.kind,
    });
    await waitForVisibility(1800);
  }

  const lastChunkBeforeImport = getLastChunkCapture();

  try {
    const mod = await importer();
    appendLog(LAZY_IMPORT_LOG_KEY, {
      ...entry,
      phase: 'success',
      settledAt: nowIso(),
    });
    const successCtx = currentContext();
    recordRouteDiagEvent('route_module_import_success', {
      path: successCtx.path,
      currentPath: successCtx.path,
      previousPath: entry.previousPath,
      kind: entry.kind,
      label: entry.label,
      moduleId: entry.moduleId,
      requestedModule: entry.requestedModule,
      importerHint: entry.importerHint,
      importCaller: entry.importCaller,
      componentName: entry.componentName,
      importRetryCount: entry.importRetryCount,
      retryCount: entry.retryCount,
      userAgent: successCtx.userAgent || entry.userAgent,
      appEpoch: successCtx.appEpoch || entry.appEpoch,
      baseURI: successCtx.baseURI,
      sourceLayer: 'lazy_import_runtime',
      settledAt: nowIso(),
    });
    if (entry.kind === 'component') {
      recordRouteDiagEvent('dynamic_component_import_success', {
        path: successCtx.path,
        currentPath: successCtx.path,
        previousPath: entry.previousPath,
        kind: entry.kind,
        label: entry.label,
        moduleId: entry.moduleId,
        requestedModule: entry.requestedModule,
        importerHint: entry.importerHint,
        importCaller: entry.importCaller,
        componentName: entry.componentName,
        importRetryCount: entry.importRetryCount,
        retryCount: entry.retryCount,
        userAgent: successCtx.userAgent || entry.userAgent,
        appEpoch: successCtx.appEpoch || entry.appEpoch,
        baseURI: successCtx.baseURI,
        sourceLayer: 'lazy_import_runtime',
        settledAt: nowIso(),
      });
    }
    return mod;
  } catch (error) {
    const normalized = normalizeError(error);
    const assetUrls = extractAssetUrls(normalized.message, normalized.stack, entry.moduleId, entry.label);
    const failureChunkCapture = getLastChunkCapture();
    const assetUrl = assetUrls[0] || String(failureChunkCapture?.resolvedTargetSrc || failureChunkCapture?.targetSrc || '');
    const failure = recordChunkCapture('lazy_import_failure', {
      ...entry,
      settledAt: nowIso(),
      error: normalized,
      message: normalized.message,
      name: normalized.name,
      stack: normalized.stack,
      assetUrls,
      assetUrl,
      resolvedAssetUrl: resolveAssetUrl(assetUrl),
      lastChunkCaptureBeforeImport: lastChunkBeforeImport,
      lastChunkCaptureAtFailure: failureChunkCapture,
    });
    const failureCtx = currentContext();
    recordRouteDiagEvent('route_module_import_failure', {
      path: failureCtx.path,
      currentPath: failureCtx.path,
      previousPath: entry.previousPath,
      kind: entry.kind,
      label: entry.label,
      moduleId: entry.moduleId,
      requestedModule: entry.requestedModule,
      importerHint: entry.importerHint,
      importCaller: entry.importCaller,
      componentName: entry.componentName,
      importRetryCount: entry.importRetryCount,
      retryCount: entry.retryCount,
      userAgent: failureCtx.userAgent || entry.userAgent,
      appEpoch: failureCtx.appEpoch || entry.appEpoch,
      baseURI: failureCtx.baseURI,
      sourceLayer: 'lazy_import_runtime',
      settledAt: nowIso(),
      error: normalized,
      assetUrls,
      assetUrl,
      resolvedAssetUrl: resolveAssetUrl(assetUrl),
      lastChunkCaptureAtFailure: failureChunkCapture,
    });
    if (entry.kind === 'component') {
      recordRouteDiagEvent('dynamic_component_import_failure', {
        path: failureCtx.path,
        currentPath: failureCtx.path,
        previousPath: entry.previousPath,
        kind: entry.kind,
        label: entry.label,
        moduleId: entry.moduleId,
        requestedModule: entry.requestedModule,
        importerHint: entry.importerHint,
        importCaller: entry.importCaller,
        componentName: entry.componentName,
        importRetryCount: entry.importRetryCount,
        retryCount: entry.retryCount,
        userAgent: failureCtx.userAgent || entry.userAgent,
        appEpoch: failureCtx.appEpoch || entry.appEpoch,
        baseURI: failureCtx.baseURI,
        sourceLayer: 'lazy_import_runtime',
        settledAt: nowIso(),
        error: normalized,
        assetUrls,
        assetUrl,
        resolvedAssetUrl: resolveAssetUrl(assetUrl),
        lastChunkCaptureAtFailure: failureChunkCapture,
      });
    }
    writeJson(LAST_LAZY_IMPORT_KEY, failure);
    try {
      window.__TEPIHA_LAST_LAZY_IMPORT_FAILURE__ = failure;
    } catch {
      // ignore
    }
    try {
      window.dispatchEvent(new CustomEvent('tepiha:lazy-import-failure', { detail: failure }));
    } catch {
      // ignore
    }
    throw error;
  }
}

export {
  ROUTE_DIAG_LOG_KEY,
  DOM_PREHEAL_LOG_KEY,
  DOM_PREHEAL_LAST_KEY,
  ACTIVE_ROUTE_REQUEST_KEY,
  ROUTE_TRANSITION_KEY,
  LAST_LAZY_IMPORT_ATTEMPT_KEY,
};
