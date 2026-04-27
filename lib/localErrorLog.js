// Smart local UI/runtime incident ring buffer.
// Scope: client-side diagnostics only. No DB/write-flow side effects.

export const LOCAL_ERROR_LOG_KEY = 'tepiha_local_error_log_v1';
export const LOCAL_ERROR_LAST_KEY = 'tepiha_local_error_last_v1';
export const LOCAL_ERROR_MAX = 20;

const ROUTE_DIAG_LOG_KEY = 'tepiha_route_diag_log_v1';
const SYNC_SNAPSHOT_KEY = 'tepiha_sync_snapshot_v1';
const OFFLINE_SYNC_LAST_KEY = 'tepiha_offline_sync_last_v1';
const TRANSPORT_SYNC_LOCK_KEY = 'tepiha_transport_sync_lock_v1';
const SYNC_RECOVERY_KEY = 'tepiha_sync_recovery_v1';

const SMART_LOG_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SMART_LOG_DEDUPE_MS = 10 * 60 * 1000;
const SMART_LOG_EXPORT_LIMIT = 8;
const SMART_LOG_FULL_LIMIT = 20;
const SMART_LOG_OLD_LIMIT = 8;

function isBrowser() {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

function nowMs() {
  try { return Date.now(); } catch { return 0; }
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

function currentAppEpoch() {
  if (!isBrowser()) return '';
  try { return String(window.__TEPIHA_APP_EPOCH || ''); } catch { return ''; }
}

function currentBuildId() {
  if (!isBrowser()) return '';
  try { return String(window.__TEPIHA_BUILD_ID || ''); } catch { return ''; }
}

function trimText(value, max = 900) {
  try {
    const text = value == null ? '' : String(value);
    if (text.length <= max) return text;
    return `${text.slice(0, max)}...[trimmed:${text.length}]`;
  } catch {
    return '';
  }
}

function compactError(error) {
  const value = error && typeof error === 'object' ? error : {};
  const message = typeof error === 'string' ? error : value?.message;
  return {
    name: trimText(value?.name || '', 80),
    message: trimText(message || error || 'UNKNOWN_LOCAL_ERROR', 300),
    stack: trimText(value?.stack || '', 1200),
    code: trimText(value?.code || '', 80),
    details: trimText(value?.details || '', 300),
    hint: trimText(value?.hint || '', 300),
  };
}

function compactStringArray(items, maxItems = 6, maxLen = 260) {
  if (!Array.isArray(items)) return [];
  return items.map((item) => trimText(item || '', maxLen)).filter(Boolean).slice(0, maxItems);
}

function extractAsset(value = {}) {
  try {
    return trimText(
      value?.asset
      || value?.assetUrl
      || value?.resolvedAssetUrl
      || value?.targetSrc
      || value?.resolvedTargetSrc
      || value?.currentIndexAsset
      || '',
      360
    );
  } catch {
    return '';
  }
}

function compactRouteEvent(event) {
  if (!event || typeof event !== 'object') return null;
  return {
    type: trimText(event.type || event.eventType || '', 100),
    at: trimText(event.at || event.timestamp || '', 80),
    path: trimText(event.path || event.currentPath || event.route || '', 160),
    previousPath: trimText(event.previousPath || event.previousRoute || '', 160),
    sourceLayer: trimText(event.sourceLayer || '', 120),
    requestedModule: trimText(event.requestedModule || event.label || '', 240),
    asset: extractAsset(event),
    appEpoch: trimText(event.appEpoch || '', 120),
    buildId: trimText(event.buildId || '', 120),
    online: typeof event.online === 'boolean' ? event.online : null,
    visibilityState: trimText(event.visibilityState || '', 80),
  };
}

function compactSyncEvent(event) {
  if (!event || typeof event !== 'object') return null;
  const value = event.value && typeof event.value === 'object' ? event.value : event;
  return {
    key: trimText(event.key || '', 120),
    type: trimText(value.type || value.kind || value.event || '', 120),
    at: trimText(value.at || value.timestamp || '', 80),
    ts: Number(value.ts || value.atMs || value.updatedAt || value.lastRunAt || value.createdAt || 0) || 0,
    ok: typeof value.ok === 'boolean' ? value.ok : null,
    error: trimText(value.error || value.message || '', 240),
  };
}

function compactMeta(meta = {}) {
  if (!meta || typeof meta !== 'object') return {};
  return {
    boundaryKind: trimText(meta.boundaryKind || meta.kind || '', 120),
    routePath: trimText(meta.routePath || meta.route || meta.path || '', 180),
    routeName: trimText(meta.routeName || '', 180),
    componentName: trimText(meta.componentName || meta.component || '', 220),
    moduleName: trimText(meta.moduleName || meta.module || meta.moduleId || '', 260),
    requestedModule: trimText(meta.requestedModule || '', 260),
    sourceLayer: trimText(meta.sourceLayer || '', 140),
    incidentType: trimText(meta.incidentType || '', 140),
    reason: trimText(meta.reason || '', 180),
    tagName: trimText(meta.tagName || '', 80),
    targetRel: trimText(meta.targetRel || '', 80),
    asset: extractAsset(meta),
    importCaller: trimText(meta.importCaller || '', 160),
    currentRoute: trimText(meta.currentRoute || '', 180),
    previousRoute: trimText(meta.previousRoute || '', 180),
    navigationType: trimText(meta.navigationType || '', 100),
    hiddenElapsedMs: Number(meta.hiddenElapsedMs || 0) || 0,
    moduleLoadPhase: trimText(meta.moduleLoadPhase || '', 140),
  };
}

function readLastRouteEvent() {
  const list = readJson(ROUTE_DIAG_LOG_KEY, []);
  if (Array.isArray(list) && list.length) return compactRouteEvent(list[0]);
  return null;
}

function readLastSyncOfflineEvent() {
  const candidates = [];
  const snapshot = readJson(SYNC_SNAPSHOT_KEY, null);
  if (snapshot) candidates.push({ key: SYNC_SNAPSHOT_KEY, value: snapshot });
  const offlineLast = readJson(OFFLINE_SYNC_LAST_KEY, null);
  if (offlineLast) candidates.push({ key: OFFLINE_SYNC_LAST_KEY, value: offlineLast });
  const transportLock = readJson(TRANSPORT_SYNC_LOCK_KEY, null);
  if (transportLock) candidates.push({ key: TRANSPORT_SYNC_LOCK_KEY, value: transportLock });
  const recovery = readJson(SYNC_RECOVERY_KEY, null);
  if (recovery) candidates.push({ key: SYNC_RECOVERY_KEY, value: recovery });
  const best = candidates
    .map((item) => {
      const value = item.value && typeof item.value === 'object' ? item.value : {};
      const ts = Number(value.ts || value.atMs || value.updatedAt || value.lastRunAt || value.createdAt || 0) || 0;
      return { ...item, ts };
    })
    .sort((a, b) => b.ts - a.ts)[0];
  return best ? compactSyncEvent(best) : null;
}

function normalizeError(error) {
  return compactError(error);
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
    href: (() => { try { return trimText(window.location?.href || '', 360); } catch { return ''; } })(),
    route: (() => { try { return trimText(window.location?.pathname || '/', 180); } catch { return '/'; } })(),
    path: (() => { try { return trimText(window.location?.pathname || '/', 180); } catch { return '/'; } })(),
    search: (() => { try { return trimText(window.location?.search || '', 180); } catch { return ''; } })(),
    appEpoch: currentAppEpoch(),
    buildId: currentBuildId(),
    visibilityState: (() => { try { return trimText(document?.visibilityState || 'unknown', 80); } catch { return 'unknown'; } })(),
    online: (() => { try { return navigator.onLine; } catch { return null; } })(),
    bootId: (() => {
      try {
        return trimText(
          window.BOOT_ID
          || window.sessionStorage?.getItem('tepiha_boot_current_id')
          || window.localStorage?.getItem('tepiha_boot_current_id')
          || '',
          140
        );
      } catch {
        return '';
      }
    })(),
    userAgent: (() => {
      try { return trimText(navigator.userAgent || '', 260); } catch { return ''; }
    })(),
  };
}

function isCurrentEpoch(entry) {
  const epoch = currentAppEpoch();
  if (!epoch) return true;
  const entryEpoch = String(entry?.appEpoch || entry?.meta?.appEpoch || '');
  if (!entryEpoch) return true;
  return entryEpoch === epoch;
}

function entryAgeOk(entry, tsNow = nowMs()) {
  const ts = Number(entry?.ts || 0) || 0;
  if (!ts) return true;
  return tsNow - ts <= SMART_LOG_TTL_MS;
}

function incidentKind(entry) {
  return [
    entry?.errorType,
    entry?.boundaryKind,
    entry?.sourceLayer,
    entry?.error?.message,
    entry?.meta?.incidentType,
    entry?.meta?.reason,
    entry?.lastRouteEvent?.type,
  ].map((item) => String(item || '').toLowerCase()).join(' ');
}

function isStorableIncident(entry) {
  const hay = incidentKind(entry);
  if (!hay) return true;

  if (
    /visibilitychange|pagehide|pageshow|route_transition|route_visible|route_alive|ui_ready|first_ui_ready|boot_mark_ready/.test(hay)
    && !/error|crash|fail|stuck|timeout|module|chunk|overlay|boundary/.test(hay)
  ) {
    return false;
  }

  if (/fallback/.test(hay) && /success|succeeded|recovered|ok/.test(hay) && !/fail|error|crash|stuck|timeout/.test(hay)) {
    return false;
  }

  if (/timeout/.test(hay) && /fallback/.test(hay) && /success|succeeded|local_cache/.test(hay)) {
    return false;
  }

  return /error|crash|fail|failed|failure|fatal|stuck|timeout|module|chunk|overlay|boundary|window_module_error|ui_crash|app_error|black/.test(hay)
    || entry?.routeRecovered === false
    || entry?.autoRetryExhausted === true;
}

function dedupeKey(entry) {
  const err = entry?.error || {};
  return [
    entry?.errorType || '',
    entry?.boundaryKind || '',
    entry?.route || entry?.path || '',
    entry?.moduleName || entry?.module || '',
    entry?.componentName || entry?.component || '',
    err.name || '',
    err.message || '',
    extractAsset(entry?.meta || {}) || extractAsset(entry?.lastRouteEvent || {}),
  ].map((item) => String(item || '').slice(0, 180)).join('|');
}

function compactEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const error = compactError(entry.error || {});
  const meta = compactMeta(entry.meta || {});
  return {
    id: trimText(entry.id || `local_${entry.ts || nowMs()}`, 120),
    ts: Number(entry.ts || 0) || nowMs(),
    at: trimText(entry.at || entry.timestamp || '', 80),
    timestamp: trimText(entry.timestamp || entry.at || '', 80),
    errorType: trimText(entry.errorType || entry.boundaryKind || 'local', 120),
    boundaryKind: trimText(entry.boundaryKind || entry.errorType || 'local', 120),
    route: trimText(entry.route || entry.path || meta.routePath || '/', 180),
    path: trimText(entry.path || entry.route || meta.routePath || '/', 180),
    module: trimText(entry.module || entry.moduleName || meta.moduleName || '', 260),
    moduleName: trimText(entry.moduleName || entry.module || meta.moduleName || '', 260),
    componentName: trimText(entry.componentName || entry.component || meta.componentName || '', 220),
    component: trimText(entry.component || entry.componentName || meta.componentName || '', 220),
    sourceLayer: trimText(entry.sourceLayer || meta.sourceLayer || 'local_error_boundary', 140),
    error,
    componentStack: trimText(entry.componentStack || '', 1200),
    importRetryCount: Number(entry.importRetryCount ?? entry.retryCount ?? 0) || 0,
    retryCount: Number(entry.retryCount ?? entry.importRetryCount ?? 0) || 0,
    autoRetryCount: Number(entry.autoRetryCount || 0) || 0,
    maxAutoRetries: Number(entry.maxAutoRetries || 0) || 0,
    routeRecovered: typeof entry.routeRecovered === 'boolean' ? entry.routeRecovered : null,
    retrySucceeded: typeof entry.retrySucceeded === 'boolean' ? entry.retrySucceeded : null,
    autoRetryExhausted: !!entry.autoRetryExhausted,
    retryStrategy: trimText(entry.retryStrategy || '', 160),
    retryDelayPlanMs: Array.isArray(entry.retryDelayPlanMs) ? entry.retryDelayPlanMs.slice(0, 8) : [],
    probableModuleLoadFailure: !!entry.probableModuleLoadFailure,
    failedAssets: compactStringArray(entry.failedAssets, 6, 360),
    failedAssetCount: Number(entry.failedAssetCount || 0) || 0,
    requestedModule: trimText(entry.requestedModule || meta.requestedModule || '', 260),
    importCaller: trimText(entry.importCaller || meta.importCaller || '', 160),
    appEpoch: trimText(entry.appEpoch || meta.appEpoch || '', 140),
    buildId: trimText(entry.buildId || meta.buildId || '', 140),
    visibilityState: trimText(entry.visibilityState || '', 80),
    online: typeof entry.online === 'boolean' ? entry.online : null,
    href: trimText(entry.href || '', 360),
    search: trimText(entry.search || '', 180),
    bootId: trimText(entry.bootId || '', 140),
    userAgent: trimText(entry.userAgent || '', 260),
    lastRouteEvent: compactRouteEvent(entry.lastRouteEvent),
    lastSyncOfflineEvent: compactSyncEvent(entry.lastSyncOfflineEvent),
    meta,
  };
}

function normalizeStoredList(list, options = {}) {
  const tsNow = nowMs();
  const includeOld = !!options.includeOld;
  const includeNonCritical = !!options.includeNonCritical;
  const source = Array.isArray(list) ? list : [];
  const next = [];
  const hiddenOld = [];
  const hiddenExpired = [];
  const hiddenNoise = [];
  const seen = new Map();

  source.forEach((raw) => {
    const entry = compactEntry(raw);
    if (!entry) return;

    if (!entryAgeOk(entry, tsNow)) {
      hiddenExpired.push(entry);
      return;
    }

    const currentEpoch = isCurrentEpoch(entry);
    if (!currentEpoch && !includeOld) {
      hiddenOld.push(entry);
      return;
    }

    if (!includeNonCritical && !isStorableIncident(entry)) {
      hiddenNoise.push(entry);
      return;
    }

    const key = dedupeKey(entry);
    const previousTs = seen.get(key);
    if (previousTs && Math.abs((Number(entry.ts) || 0) - previousTs) < SMART_LOG_DEDUPE_MS) return;
    seen.set(key, Number(entry.ts) || tsNow);
    next.push(entry);
  });

  next.sort((a, b) => (Number(b.ts) || 0) - (Number(a.ts) || 0));

  return {
    current: next.slice(0, LOCAL_ERROR_MAX),
    oldBuildHidden: hiddenOld.slice(0, SMART_LOG_OLD_LIMIT),
    oldBuildHiddenCount: hiddenOld.length,
    expiredHiddenCount: hiddenExpired.length,
    noiseHiddenCount: hiddenNoise.length,
  };
}

function readStoredErrorListRaw() {
  return readJson(LOCAL_ERROR_LOG_KEY, []);
}

function getControllerScriptURL() {
  if (!isBrowser()) return '';
  try { return String(navigator.serviceWorker?.controller?.scriptURL || ''); } catch { return ''; }
}

function isStandalone() {
  if (!isBrowser()) return null;
  try {
    return !!(window.matchMedia?.('(display-mode: standalone)')?.matches || window.navigator?.standalone);
  } catch {
    return null;
  }
}

function getHealthSnapshot() {
  return {
    appEpoch: currentAppEpoch(),
    buildId: currentBuildId(),
    standalone: isStandalone(),
    controller: getControllerScriptURL(),
    serviceWorkerControllerScriptURL: getControllerScriptURL(),
    epochMismatch: (() => {
      try {
        const check = window.__TEPIHA_PWA_STALENESS_CHECK__ || window.__TEPIHA_SW_EPOCH_CHECK__ || null;
        if (typeof check?.epochMismatch === 'boolean') return check.epochMismatch;
        return false;
      } catch {
        return false;
      }
    })(),
    path: (() => { try { return String(window.location?.pathname || ''); } catch { return ''; } })(),
    online: (() => { try { return navigator.onLine; } catch { return null; } })(),
    visibilityState: (() => { try { return String(document?.visibilityState || ''); } catch { return ''; } })(),
  };
}

function summarizeIncident(entry) {
  if (!entry) return null;
  const compact = compactEntry(entry);
  if (!compact) return null;
  const asset = extractAsset(compact.meta || {}) || extractAsset(compact.lastRouteEvent || {});
  return {
    type: compact.errorType || compact.boundaryKind || '',
    route: compact.route || compact.path || '',
    module: compact.moduleName || compact.module || compact.requestedModule || '',
    component: compact.componentName || compact.component || '',
    sourceLayer: compact.sourceLayer || '',
    message: compact.error?.message || '',
    errorName: compact.error?.name || '',
    asset,
    at: compact.at || compact.timestamp || '',
    appEpoch: compact.appEpoch || '',
    buildId: compact.buildId || '',
    oldBuild: currentAppEpoch() && compact.appEpoch ? compact.appEpoch !== currentAppEpoch() : false,
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
  const entry = {
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
    meta: compactMeta(meta),
  };

  return compactEntry(entry);
}

export function pushLocalErrorLog(error, info = {}, meta = {}) {
  if (!isBrowser()) return null;
  const entry = buildLocalErrorEntry(error, info, meta);
  if (!entry || !isStorableIncident(entry)) return entry;

  try {
    const existing = readStoredErrorListRaw();
    const normalized = normalizeStoredList([entry, ...(Array.isArray(existing) ? existing : [])], {
      includeOld: false,
      includeNonCritical: false,
    });

    const next = normalized.current.slice(0, LOCAL_ERROR_MAX);
    writeJson(LOCAL_ERROR_LOG_KEY, next);
    writeJson(LOCAL_ERROR_LAST_KEY, next[0] || entry);
    try { window.__TEPIHA_LAST_LOCAL_ERROR__ = next[0] || entry; } catch {}
    try { window.dispatchEvent(new CustomEvent('tepiha:local-error-boundary', { detail: next[0] || entry })); } catch {}
  } catch {
    // ignore diagnostics write failures
  }
  return entry;
}

export function readLocalErrorLog(options = {}) {
  const normalized = normalizeStoredList(readStoredErrorListRaw(), options);
  return normalized.current;
}

export function readLastLocalError() {
  const normalized = normalizeStoredList(readStoredErrorListRaw(), { includeOld: false, includeNonCritical: false });
  return normalized.current[0] || null;
}

export function readSmartIncidentSnapshot(options = {}) {
  const includeOld = !!options.includeOld;
  const includeNonCritical = !!options.includeNonCritical;
  const normalized = normalizeStoredList(readStoredErrorListRaw(), { includeOld, includeNonCritical });
  if (!includeOld && !includeNonCritical) {
    writeJson(LOCAL_ERROR_LOG_KEY, normalized.current.slice(0, LOCAL_ERROR_MAX));
    writeJson(LOCAL_ERROR_LAST_KEY, normalized.current[0] || null);
  }
  const currentIncident = normalized.current[0] || null;
  return {
    health: getHealthSnapshot(),
    currentIncident: summarizeIncident(currentIncident),
    recentIncidents: normalized.current.slice(1, SMART_LOG_EXPORT_LIMIT).map(summarizeIncident).filter(Boolean),
    oldBuildIncidentsHidden: normalized.oldBuildHiddenCount,
    expiredIncidentsHidden: normalized.expiredHiddenCount,
    noiseEventsHidden: normalized.noiseHiddenCount,
    storage: {
      localErrorMax: LOCAL_ERROR_MAX,
      ttlDays: 7,
      dedupeWindowMinutes: 10,
      currentStoredCount: normalized.current.length,
    },
    full: options.full ? {
      currentIncidents: normalized.current.slice(0, SMART_LOG_FULL_LIMIT),
      oldBuildIncidents: normalized.oldBuildHidden.map(summarizeIncident).filter(Boolean),
    } : undefined,
  };
}

export function exportLocalErrorLogText(entry = null) {
  const full = (() => {
    try { return new URLSearchParams(window.location?.search || '').get('full') === '1'; } catch { return false; }
  })();

  const snapshot = readSmartIncidentSnapshot({ full });
  if (entry) snapshot.currentIncident = summarizeIncident(entry);

  try {
    return JSON.stringify(snapshot, null, 2);
  } catch {
    return '{}';
  }
}

export const exportSmartIncidentLogText = exportLocalErrorLogText;
