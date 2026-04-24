// Local UI/runtime error ring buffer.
// Scope: client-side diagnostics only. No DB/write-flow side effects.

export const LOCAL_ERROR_LOG_KEY = 'tepiha_local_error_log_v1';
export const LOCAL_ERROR_LAST_KEY = 'tepiha_local_error_last_v1';
export const LOCAL_ERROR_MAX = 160;

const ROUTE_DIAG_LOG_KEY = 'tepiha_route_diag_log_v1';
const SYNC_SNAPSHOT_KEY = 'tepiha_sync_snapshot_v1';
const OFFLINE_SYNC_LAST_KEY = 'tepiha_offline_sync_last_v1';
const TRANSPORT_SYNC_LOCK_KEY = 'tepiha_transport_sync_lock_v1';
const SYNC_RECOVERY_KEY = 'tepiha_sync_recovery_v1';

function isBrowser() {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

function safeParse(raw, fallback = null) {
  try {
    if (!raw) return fallback;
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
    // ignore diagnostics write failures
  }
}

function readLastRouteEvent() {
  const list = readJson(ROUTE_DIAG_LOG_KEY, []);
  if (Array.isArray(list) && list.length) return safeClone(list[0], null);
  return null;
}

function readLastSyncOfflineEvent() {
  const candidates = [];
  const snapshot = readJson(SYNC_SNAPSHOT_KEY, null);
  if (snapshot) {
    candidates.push({ key: SYNC_SNAPSHOT_KEY, value: snapshot });
  }
  const offlineLast = readJson(OFFLINE_SYNC_LAST_KEY, null);
  if (offlineLast) {
    candidates.push({ key: OFFLINE_SYNC_LAST_KEY, value: offlineLast });
  }
  const transportLock = readJson(TRANSPORT_SYNC_LOCK_KEY, null);
  if (transportLock) {
    candidates.push({ key: TRANSPORT_SYNC_LOCK_KEY, value: transportLock });
  }
  const recovery = readJson(SYNC_RECOVERY_KEY, null);
  if (recovery) {
    candidates.push({ key: SYNC_RECOVERY_KEY, value: recovery });
  }
  const best = candidates
    .map((item) => {
      const value = item.value && typeof item.value === 'object' ? item.value : {};
      const ts = Number(value.ts || value.atMs || value.updatedAt || value.lastRunAt || value.createdAt || 0) || 0;
      return { ...item, ts };
    })
    .sort((a, b) => b.ts - a.ts)[0];
  return best ? safeClone(best, null) : null;
}

function normalizeError(error) {
  if (!error) return { name: '', message: 'UNKNOWN_LOCAL_ERROR', stack: '' };
  if (typeof error === 'string') return { name: '', message: error, stack: '' };
  return {
    name: String(error?.name || ''),
    message: String(error?.message || error || 'UNKNOWN_LOCAL_ERROR'),
    stack: String(error?.stack || ''),
    code: error?.code ? String(error.code) : '',
    details: error?.details ? String(error.details) : '',
    hint: error?.hint ? String(error.hint) : '',
  };
}

function browserContext() {
  if (!isBrowser()) {
    return {
      href: '',
      route: '',
      path: '',
      search: '',
      appEpoch: '',
      buildId: '',
      visibilityState: '',
      online: null,
      bootId: '',
      userAgent: '',
    };
  }
  return {
    href: (() => { try { return String(window.location?.href || ''); } catch { return ''; } })(),
    route: (() => { try { return String(window.location?.pathname || '/'); } catch { return '/'; } })(),
    path: (() => { try { return String(window.location?.pathname || '/'); } catch { return '/'; } })(),
    search: (() => { try { return String(window.location?.search || ''); } catch { return ''; } })(),
    appEpoch: (() => { try { return String(window.__TEPIHA_APP_EPOCH || ''); } catch { return ''; } })(),
    buildId: (() => { try { return String(window.__TEPIHA_BUILD_ID || ''); } catch { return ''; } })(),
    visibilityState: (() => { try { return String(document?.visibilityState || 'unknown'); } catch { return 'unknown'; } })(),
    online: (() => { try { return navigator.onLine; } catch { return null; } })(),
    bootId: (() => {
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
    })(),
    userAgent: (() => {
      try { return String(navigator.userAgent || ''); } catch { return ''; }
    })(),
  };
}

export function buildLocalErrorEntry(error, info = {}, meta = {}) {
  const ctx = browserContext();
  const route = String(meta?.route || meta?.routePath || meta?.path || ctx.path || '/');
  const moduleName = String(meta?.module || meta?.moduleName || meta?.moduleId || '');
  const componentName = String(meta?.component || meta?.componentName || meta?.routeName || '');
  const boundaryKind = String(meta?.boundaryKind || meta?.kind || 'local');
  const at = new Date().toISOString();
  const failedAssets = Array.isArray(meta?.failedAssets) ? meta.failedAssets.map((item) => String(item || '')).filter(Boolean).slice(0, 12) : [];
  const autoRetryCount = Number(meta?.autoRetryCount ?? meta?.importAutoRetryCount ?? 0) || 0;
  const maxAutoRetries = Number(meta?.maxAutoRetries ?? 0) || 0;
  const routeRecovered = typeof meta?.routeRecovered === 'boolean' ? meta.routeRecovered : null;
  return {
    id: `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    ts: Date.now(),
    at,
    timestamp: at,
    errorType: boundaryKind,
    boundaryKind,
    route,
    path: route,
    module: moduleName,
    moduleName,
    componentName,
    component: componentName,
    sourceLayer: String(meta?.sourceLayer || 'local_error_boundary'),
    error: normalizeError(error),
    componentStack: String(info?.componentStack || meta?.componentStack || ''),
    importRetryCount: Number(meta?.importRetryCount ?? meta?.retryCount ?? 0) || 0,
    retryCount: Number(meta?.retryCount ?? meta?.importRetryCount ?? 0) || 0,
    autoRetryCount,
    maxAutoRetries,
    routeRecovered,
    retrySucceeded: typeof meta?.retrySucceeded === 'boolean' ? meta.retrySucceeded : null,
    autoRetryExhausted: !!meta?.autoRetryExhausted,
    retryStrategy: String(meta?.retryStrategy || meta?.localRetryStrategy || ''),
    retryDelayPlanMs: Array.isArray(meta?.retryDelayPlanMs) ? meta.retryDelayPlanMs : [],
    probableModuleLoadFailure: !!meta?.probableModuleLoadFailure,
    failedAssets,
    failedAssetCount: Number(meta?.failedAssetCount ?? failedAssets.length) || failedAssets.length,
    requestedModule: String(meta?.requestedModule || meta?.moduleId || meta?.moduleName || ''),
    importCaller: String(meta?.importCaller || ''),
    appEpoch: ctx.appEpoch,
    buildId: ctx.buildId,
    visibilityState: ctx.visibilityState,
    online: ctx.online,
    href: ctx.href,
    search: ctx.search,
    bootId: ctx.bootId,
    userAgent: ctx.userAgent,
    lastRouteEvent: readLastRouteEvent(),
    lastSyncOfflineEvent: readLastSyncOfflineEvent(),
    meta: safeClone(meta, {}) || {},
  };
}

export function pushLocalErrorLog(error, info = {}, meta = {}) {
  if (!isBrowser()) return null;
  const entry = buildLocalErrorEntry(error, info, meta);
  try {
    const existing = readJson(LOCAL_ERROR_LOG_KEY, []);
    const list = Array.isArray(existing) ? existing : [];
    const next = [entry, ...list].slice(0, LOCAL_ERROR_MAX);
    writeJson(LOCAL_ERROR_LOG_KEY, next);
    writeJson(LOCAL_ERROR_LAST_KEY, entry);
    try { window.__TEPIHA_LAST_LOCAL_ERROR__ = entry; } catch {}
    try { window.dispatchEvent(new CustomEvent('tepiha:local-error-boundary', { detail: entry })); } catch {}
  } catch {
    // ignore diagnostics write failures
  }
  return entry;
}

export function readLocalErrorLog() {
  return readJson(LOCAL_ERROR_LOG_KEY, []);
}

export function readLastLocalError() {
  return readJson(LOCAL_ERROR_LAST_KEY, null);
}

export function exportLocalErrorLogText(entry = null) {
  const payload = {
    current: entry || readLastLocalError(),
    log: readLocalErrorLog(),
  };
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return '{}';
  }
}
