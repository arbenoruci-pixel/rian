import React, { useMemo, useState } from 'react';

const DEFAULT_RELOAD_WINDOW_MS = 30000;
const DEFAULT_STORAGE_PREFIX = 'tepiha_lazy_reload_once_v1';
const LAST_ERROR_KEY = 'tepiha_lazy_reload_last_error_v1';
const UPDATE_AVAILABLE_KEY = 'tepiha_update_available_v1';
const UPDATE_AVAILABLE_EVENT = 'tepiha:update-available';
const MANUAL_UPDATE_TIMEOUT_MS = 15000;

function safeString(value, fallback = '') {
  try {
    const text = String(value ?? '');
    return text || fallback;
  } catch {
    return fallback;
  }
}

function safeNow() {
  try { return Date.now(); } catch { return 0; }
}

function getSessionStorage() {
  try {
    if (typeof window === 'undefined') return null;
    return window.sessionStorage || null;
  } catch {
    return null;
  }
}

function getLocalStorage() {
  try {
    if (typeof window === 'undefined') return null;
    return window.localStorage || null;
  } catch {
    return null;
  }
}

const SILENT_RUNTIME_MODULE_LABELS = new Set([
  'ChunkLoadRuntime',
  'RootResumeWatchdog',
  'ServiceWorkerRegister',
  'SyncStarter',
  'RuntimeIncidentUploader',
  'SessionDock',
  'OfflineFirstWarmup',
]);

function isSilentRuntimeModuleLabel(value) {
  try {
    const text = safeString(value || '', '').trim();
    if (!text) return false;
    if (SILENT_RUNTIME_MODULE_LABELS.has(text)) return true;
    const tail = text.split(/[\\/]/).pop().replace(/\.(jsx?|tsx?)$/i, '');
    return SILENT_RUNTIME_MODULE_LABELS.has(tail);
  } catch {
    return false;
  }
}

function normalizeReloadKey(value) {
  return safeString(value || 'unknown', 'unknown')
    .replace(/[^a-zA-Z0-9:_./-]+/g, '_')
    .slice(0, 180);
}

function readJson(storage, key, fallback = null) {
  try {
    const raw = storage?.getItem?.(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeJson(storage, key, value) {
  try { storage?.setItem?.(key, JSON.stringify(value)); } catch {}
}

function normalizeError(error) {
  return {
    name: safeString(error?.name, ''),
    message: safeString(error?.message || error, 'UNKNOWN_DYNAMIC_IMPORT_ERROR'),
    stack: safeString(error?.stack, '').slice(0, 4000),
  };
}


function isLikelyReactComponent(value) {
  if (typeof value === 'function') return true;
  if (value && typeof value === 'object') {
    try {
      const marker = String(value.$$typeof || '');
      if (marker.includes('react.')) return true;
    } catch {}
  }
  return false;
}

function createLazyDefaultExportError(meta = {}) {
  const moduleId = safeString(meta.moduleId || meta.label || meta.storageKey || 'UNKNOWN_MODULE', 'UNKNOWN_MODULE');
  const error = new Error(`LAZY_MODULE_DEFAULT_EXPORT_MISSING: ${moduleId}`);
  try { error.name = 'LazyModuleDefaultExportMissing'; } catch {}
  try { error.code = 'LAZY_MODULE_DEFAULT_EXPORT_MISSING'; } catch {}
  try {
    error.__tepihaLazyDefaultExportMissing = true;
    error.__tepihaLazyModuleMeta = runtimeSnapshot({
      moduleId,
      label: safeString(meta.label || moduleId, moduleId),
      sourceLayer: safeString(meta.sourceLayer || 'lazy_with_reload', 'lazy_with_reload'),
      importCaller: safeString(meta.importCaller || '', ''),
    });
  } catch {}
  return error;
}

function normalizeLazyModuleResult(result, meta = {}) {
  if (isLikelyReactComponent(result)) {
    return { default: result };
  }

  if (result && typeof result === 'object' && isLikelyReactComponent(result.default)) {
    return result;
  }

  throw createLazyDefaultExportError(meta);
}

function runtimeSnapshot(extra = {}) {
  const now = safeNow();
  return {
    ts: now,
    at: (() => { try { return new Date(now).toISOString(); } catch { return ''; } })(),
    href: (() => { try { return safeString(window.location?.href, ''); } catch { return ''; } })(),
    path: (() => { try { return safeString(window.location?.pathname, ''); } catch { return ''; } })(),
    search: (() => { try { return safeString(window.location?.search, ''); } catch { return ''; } })(),
    online: (() => { try { return navigator.onLine; } catch { return null; } })(),
    visibilityState: (() => { try { return safeString(document.visibilityState, ''); } catch { return ''; } })(),
    appEpoch: (() => { try { return safeString(window.__TEPIHA_APP_EPOCH || '', ''); } catch { return ''; } })(),
    buildId: (() => { try { return safeString(window.__TEPIHA_BUILD_ID || '', ''); } catch { return ''; } })(),
    userAgent: (() => { try { return safeString(navigator.userAgent || '', ''); } catch { return ''; } })(),
    ...extra,
  };
}

function dispatchUpdateAvailable(payload) {
  try {
    window.__TEPIHA_UPDATE_AVAILABLE__ = payload;
  } catch {}

  try {
    window.dispatchEvent(new CustomEvent(UPDATE_AVAILABLE_EVENT, { detail: payload }));
  } catch {}
}

function markUpdateAvailable(reason = 'dynamic_import_failed', options = {}) {
  if (typeof window === 'undefined') {
    return { scheduled: false, blocked: true, reason: 'server_runtime' };
  }

  const storage = getSessionStorage();
  const localStorageRef = getLocalStorage();
  const windowMs = Number(options.reloadWindowMs || DEFAULT_RELOAD_WINDOW_MS) || DEFAULT_RELOAD_WINDOW_MS;
  const keySeed = options.storageKey || options.key || options.moduleId || options.label || reason || 'global';
  const storageKey = `${DEFAULT_STORAGE_PREFIX}:${normalizeReloadKey(keySeed)}`;
  const now = safeNow();
  const previous = readJson(storage, storageKey, null);
  const previousTs = Number(previous?.ts || 0) || 0;
  const offlineNow = (() => { try { return navigator.onLine === false; } catch { return false; } })();
  const duplicateWithinWindow = !!(previousTs && now - previousTs < windowMs);

  const payload = runtimeSnapshot({
    reason: safeString(reason, 'dynamic_import_failed'),
    storageKey,
    keySeed: safeString(keySeed, ''),
    reloadWindowMs: windowMs,
    previousTs,
    blocked: true,
    offlineNow,
    duplicateWithinWindow,
    passiveUpdate: true,
    autoReloadDisabled: true,
    manualUpdateOnly: true,
    error: options.error ? normalizeError(options.error) : null,
    meta: options.meta || null,
  });

  writeJson(localStorageRef, LAST_ERROR_KEY, payload);

  if (!duplicateWithinWindow) {
    writeJson(storage, storageKey, payload);
  }

  try { window.__TEPIHA_UPDATE_AVAILABLE__ = payload; } catch {}

  return {
    scheduled: false,
    blocked: true,
    passive: true,
    offline: offlineNow,
    storageKey,
    payload,
  };
}

function requestManualUpdate(setStatus) {
  if (typeof window === 'undefined') return;

  const startedAt = safeNow();
  let escaped = false;

  const setSafeStatus = (text) => {
    try { if (typeof setStatus === 'function') setStatus(text); } catch {}
  };

  setSafeStatus('Duke përgatitur përditësimin...');

  try {
    window.sessionStorage?.setItem?.(
      'tepiha_manual_update_requested_v1',
      JSON.stringify({ at: new Date(startedAt).toISOString(), ts: startedAt, source: 'lazy_with_reload_banner' }),
    );
  } catch {}

  const escapeTimer = (() => {
    try {
      return window.setTimeout(() => {
        escaped = true;
        setSafeStatus('Përditësimi nuk u krye automatikisht. App-i mund të vazhdojë; provo prapë më vonë ose hape nga fillimi.');
      }, MANUAL_UPDATE_TIMEOUT_MS);
    } catch {
      return null;
    }
  })();

  const finishWithReload = () => {
    if (escaped) return;
    escaped = true;
    try { if (escapeTimer) window.clearTimeout(escapeTimer); } catch {}
    setSafeStatus('Versioni i ri u kërkua, por PATCH V27.1 nuk bën reload ose SKIP_WAITING automatik. Mbylle/hape manualisht kur të kesh kohë.');
    try {
      window.__TEPIHA_LAZY_WITH_RELOAD_AUTO_RELOAD_DISABLED__ = true;
      window.sessionStorage?.setItem?.('tepiha_lazy_with_reload_no_auto_reload_v27_1', JSON.stringify({
        at: new Date().toISOString(),
        ts: Date.now(),
        noReload: true,
        manualOnly: true,
      }));
    } catch {}
  };

  try {
    if (navigator.serviceWorker && typeof navigator.serviceWorker.getRegistration === 'function') {
      Promise.resolve(navigator.serviceWorker.getRegistration())
        .then((registration) => {
          // PATCH V27.1: no SKIP_WAITING from lazy fallback; keep update passive.
          finishWithReload();
        })
        .catch(() => finishWithReload());
      return;
    }
  } catch {}

  finishWithReload();
}

function LazyUpdateAvailableFallback({ payload, reloadBlocked }) {
  const [status, setStatus] = useState('');

  const detail = useMemo(() => {
    const label = safeString(payload?.meta?.label || payload?.keySeed || '', 'moduli');
    const offline = payload?.offlineNow === true;
    return { label, offline };
  }, [payload]);

  // Runtime/background modules must never render worker-facing cards.
  // Route/page modules still use the visible fallback below.
  if (isSilentRuntimeModuleLabel(detail.label) || payload?.meta?.silentRuntimeModule === true) {
    return null;
  }

  return (
    <div
      data-lazy-with-reload-fallback="1"
      data-lazy-with-reload-passive="1"
      data-lazy-with-reload-blocked={reloadBlocked ? '1' : '0'}
      style={{
        position: 'static',
        left: 10,
        right: 10,
        margin: '12px',
        zIndex: 2147482600,
        display: 'flex',
        justifyContent: 'center',
        pointerEvents: 'none',
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 560,
          borderRadius: 18,
          border: '1px solid rgba(96, 165, 250, 0.38)',
          backgroundColor: 'rgba(15, 23, 42, 0.97)',
          boxShadow: '0 18px 45px rgba(0,0,0,0.42)',
          padding: 12,
          color: '#e5e7eb',
          fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
          pointerEvents: 'auto',
        }}
      >
        <div style={{ fontSize: 11, fontWeight: 1000, letterSpacing: 1.1, color: '#93c5fd' }}>
          MODULI NUK U NGARKUA
        </div>
        <div style={{ marginTop: 5, fontSize: 15, lineHeight: 1.25, fontWeight: 950 }}>
          Provo përsëri ose kthehu në Home.
        </div>
        <div style={{ marginTop: 5, fontSize: 12.5, lineHeight: 1.35, color: 'rgba(226,232,240,0.82)', fontWeight: 700 }}>
          Moduli {detail.label} nuk u ngarkua. App-i kryesor mbetet aktiv.
          {detail.offline ? ' Je offline, prandaj përditësimi pret derisa të kesh internet.' : ''}
        </div>
        {status ? (
          <div style={{ marginTop: 8, fontSize: 12, lineHeight: 1.35, color: '#bae6fd', fontWeight: 850 }}>
            {status}
          </div>
        ) : null}
        <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
          <button
            type="button"
            onClick={() => requestManualUpdate(setStatus)}
            style={{
              border: 0,
              borderRadius: 12,
              padding: '10px 12px',
              backgroundColor: '#2563eb',
              color: '#fff',
              fontWeight: 1000,
              fontSize: 13,
            }}
          >
            RIPROVO
          </button>
          <a
            href="/"
            style={{
              borderRadius: 12,
              padding: '10px 12px',
              backgroundColor: 'rgba(255,255,255,0.08)',
              color: '#fff',
              textDecoration: 'none',
              fontWeight: 950,
              fontSize: 13,
            }}
          >
            HOME
          </a>
        </div>
      </div>
    </div>
  );
}

// Kept for compatibility with older callers. It now records “update available” and never force-refreshes.
export function reloadPageOnce(reason = 'dynamic_import_failed', options = {}) {
  return markUpdateAvailable(reason, options);
}

export function lazyWithReload(importer, options = {}) {
  const label = safeString(options.label || options.moduleId || options.storageKey || options.key || 'lazy-module', 'lazy-module');

  return React.lazy(async () => {
    try {
      const mod = await importer();
      return normalizeLazyModuleResult(mod, {
        ...options,
        label,
        moduleId: options.moduleId || options.meta?.moduleId || label,
        sourceLayer: options.sourceLayer || options.meta?.sourceLayer || 'lazy_with_reload',
        importCaller: options.meta?.importCaller || 'lazyWithReload',
      });
    } catch (error) {
      const missingDefaultCode = error?.code === 'SAFE_ROUTE_DEFAULT_EXPORT_MISSING'
        ? 'SAFE_ROUTE_DEFAULT_EXPORT_MISSING'
        : (error?.__tepihaLazyDefaultExportMissing || error?.code === 'LAZY_MODULE_DEFAULT_EXPORT_MISSING' ? 'LAZY_MODULE_DEFAULT_EXPORT_MISSING' : '');
      const isDefaultExportMissing = !!missingDefaultCode;
      const result = markUpdateAvailable(missingDefaultCode || 'dynamic_import_failed', {
        ...options,
        label,
        error,
        meta: {
          ...(options.meta || {}),
          label,
          moduleId: options.moduleId || options.meta?.moduleId || label,
          sourceLayer: options.sourceLayer || options.meta?.sourceLayer || 'lazy_with_reload',
          defaultExportMissing: isDefaultExportMissing,
          code: missingDefaultCode || undefined,
        },
      });

      const wantsSilentFallback = options.silentFallback === true
        || options.silent === true
        || options.silentRuntimeModule === true
        || options.meta?.silentRuntimeModule === true
        || isSilentRuntimeModuleLabel(label)
        || isSilentRuntimeModuleLabel(options.moduleId)
        || isSilentRuntimeModuleLabel(options.meta?.moduleName)
        || isSilentRuntimeModuleLabel(options.meta?.requestedModule)
        || isSilentRuntimeModuleLabel(options.meta?.componentName);

      if (wantsSilentFallback) {
        const SilentLazyUpdateFallback = function SilentLazyUpdateFallback() {
          const calledRef = React.useRef(false);
          React.useEffect(() => {
            if (calledRef.current) return;
            calledRef.current = true;
            try {
              options.onSilentFailure?.(result.payload, error);
            } catch {}
            try {
              const entry = {
                at: new Date().toISOString(),
                ts: Date.now(),
                label,
                moduleId: options.moduleId || options.meta?.moduleId || label,
                sourceLayer: options.sourceLayer || options.meta?.sourceLayer || 'lazy_with_reload',
                silentRuntimeModule: true,
                reason: missingDefaultCode || 'dynamic_import_failed',
                payload: result.payload || null,
              };
              window.__TEPIHA_LAST_SILENT_LAZY_FAILURE__ = entry;
              const key = 'tepiha_silent_lazy_failure_log_v1';
              const list = JSON.parse(window.localStorage?.getItem?.(key) || '[]');
              const next = [entry, ...((Array.isArray(list) ? list : []).filter(Boolean))].slice(0, 40);
              window.localStorage?.setItem?.(key, JSON.stringify(next));
              window.dispatchEvent(new CustomEvent('tepiha:silent-lazy-failure', { detail: entry }));
            } catch {}
          }, []);
          return null;
        };

        return { default: SilentLazyUpdateFallback };
      }

      const PassiveUpdateFallback = function PassiveLazyUpdateFallback() {
        return <LazyUpdateAvailableFallback payload={result.payload} reloadBlocked={!!result.blocked} />;
      };

      return { default: PassiveUpdateFallback };
    }
  });
}

export default lazyWithReload;
