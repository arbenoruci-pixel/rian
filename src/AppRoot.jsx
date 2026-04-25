import React from 'react';
import { BrowserRouter, Routes, Route, useLocation } from 'react-router-dom';
import '@/app/globals.css';
import '@/phone-safearea.css';
import AuthGate from '@/components/AuthGate';
import GlobalErrorBoundary from '@/components/GlobalErrorBoundary';
import LocalErrorBoundary from '@/components/LocalErrorBoundary';
import OfflineSyncRunner from '@/components/OfflineSyncRunner.jsx';
import DeferredMount from '@/components/DeferredMount';
import { appRoutes } from './generated/routes.generated.jsx';
import { ACTIVE_ROUTE_REQUEST_KEY, recordRouteDiagEvent } from '@/lib/lazyImportRuntime';
import { lazyWithReload } from '@/lib/lazyWithReload.jsx';
import { clearRuntimeTransition, readRuntimeTransition } from '@/lib/rootResumePanic';

try {
  if (typeof window !== 'undefined') {
    window.__TEPIHA_ALLOW_BROWSER_OFFLINE_RUNTIME__ = true;
  }
} catch {}

const RUNTIME_MODULE_DISABLED_KEY = 'tepiha_runtime_module_disabled_v1';
const RUNTIME_MODULE_RETRY_DELAY_MS = 15000;
const RUNTIME_MODULE_MAX_SILENT_RETRIES = 1;

function readRuntimeModuleDisabledMap() {
  try {
    if (typeof window === 'undefined') return {};
    const raw = window.sessionStorage?.getItem?.(RUNTIME_MODULE_DISABLED_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function isRuntimeModuleDisabled(name) {
  try {
    const key = String(name || '').trim();
    if (!key) return false;
    const map = readRuntimeModuleDisabledMap();
    return !!map[key];
  } catch {
    return false;
  }
}

function markRuntimeModuleDisabled(name, reason = 'runtime_module_disabled', extra = {}) {
  try {
    if (typeof window === 'undefined') return null;
    const key = String(name || '').trim();
    if (!key) return null;
    const map = readRuntimeModuleDisabledMap();
    const entry = {
      name: key,
      reason: String(reason || 'runtime_module_disabled'),
      at: new Date().toISOString(),
      ts: Date.now(),
      path: String(window.location?.pathname || '/'),
      ...extra,
    };
    map[key] = entry;
    window.sessionStorage?.setItem?.(RUNTIME_MODULE_DISABLED_KEY, JSON.stringify(map));
    try { window.dispatchEvent(new CustomEvent('tepiha:runtime-module-disabled', { detail: entry })); } catch {}
    try { recordRouteDiagEvent('app_root_runtime_module_disabled', entry); } catch {}
    return entry;
  } catch {
    return null;
  }
}

function safeParseJson(raw, fallback = null) {
  try {
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function readActiveRouteRequestSnapshot() {
  try {
    const live = window.__TEPIHA_ACTIVE_ROUTE_REQUEST__;
    if (live && typeof live === 'object') return live;
  } catch {}
  try {
    return safeParseJson(window.sessionStorage?.getItem(ACTIVE_ROUTE_REQUEST_KEY), null)
      || safeParseJson(window.localStorage?.getItem(ACTIVE_ROUTE_REQUEST_KEY), null);
  } catch {
    return null;
  }
}

function writeActiveRouteRequestSnapshot(payload) {
  try { window.__TEPIHA_ACTIVE_ROUTE_REQUEST__ = payload; } catch {}
  try { window.sessionStorage?.setItem(ACTIVE_ROUTE_REQUEST_KEY, JSON.stringify(payload)); } catch {}
  try { window.localStorage?.setItem(ACTIVE_ROUTE_REQUEST_KEY, JSON.stringify(payload)); } catch {}
}

function clearStaleRouteRuntimeState(currentPath = '/', reason = 'path_mismatch') {
  try {
    const path = String(currentPath || window.location?.pathname || '/');
    const active = readActiveRouteRequestSnapshot();
    const activePath = String(active?.currentPath || active?.path || '');
    if (active && activePath && activePath !== path) {
      const settledAt = Date.now();
      const next = {
        ...active,
        path,
        currentPath: path,
        previousPath: activePath,
        transitionInFlight: false,
        settledAt,
        settledReason: String(reason || 'path_mismatch'),
        staleCleared: true,
      };
      writeActiveRouteRequestSnapshot(next);
      try {
        recordRouteDiagEvent('stale_active_route_request_cleared', {
          path,
          currentPath: path,
          previousPath: activePath,
          reason,
          sourceLayer: 'app_root',
          staleActiveRouteRequest: active,
        });
      } catch {}
    }

    const transition = readRuntimeTransition();
    const toPath = String(transition?.toPath || '');
    if (transition && toPath && toPath !== path) {
      const cleared = clearRuntimeTransition({
        reason: String(reason || 'path_mismatch'),
        path,
        fromPath: String(transition?.fromPath || ''),
        toPath,
      });
      try {
        recordRouteDiagEvent('stale_route_transition_cleared', {
          path,
          currentPath: path,
          previousPath: String(transition?.fromPath || ''),
          toPath,
          reason,
          clearedTransition: cleared,
          sourceLayer: 'app_root',
        });
      } catch {}
    }
  } catch {}
}

function RouteRequestTracker() {
  const location = useLocation();
  const previousRef = React.useRef({ path: '', search: '' });


  React.useEffect(() => {
    const onRouteDiag = (event) => {
      const detail = event?.detail && typeof event.detail === 'object' ? event.detail : null;
      if (!detail || String(detail?.type || '') !== 'route_ui_ready') return;
      const livePath = String(location?.pathname || '/');
      const detailPath = String(detail?.currentPath || detail?.path || '');
      if (!detailPath || detailPath !== livePath) {
        clearStaleRouteRuntimeState(livePath, 'route_ui_ready_path_mismatch');
        return;
      }

      const settledAt = Date.now();
      let nextRequest = null;
      try {
        const current = window.__TEPIHA_ACTIVE_ROUTE_REQUEST__ && typeof window.__TEPIHA_ACTIVE_ROUTE_REQUEST__ === 'object'
          ? window.__TEPIHA_ACTIVE_ROUTE_REQUEST__
          : null;
        nextRequest = current ? {
          ...current,
          transitionInFlight: false,
          settledAt,
          settledReason: 'route_ui_ready',
          currentPath: livePath,
          path: livePath,
        } : {
          path: livePath,
          currentPath: livePath,
          previousPath: String(previousRef.current?.path || ''),
          transitionInFlight: false,
          settledAt,
          settledReason: 'route_ui_ready',
        };
      } catch {
        nextRequest = {
          path: livePath,
          currentPath: livePath,
          previousPath: String(previousRef.current?.path || ''),
          transitionInFlight: false,
          settledAt,
          settledReason: 'route_ui_ready',
        };
      }

      try { window.__TEPIHA_ACTIVE_ROUTE_REQUEST__ = nextRequest; } catch {}
      try { window.sessionStorage?.setItem(ACTIVE_ROUTE_REQUEST_KEY, JSON.stringify(nextRequest)); } catch {}
      try { window.localStorage?.setItem(ACTIVE_ROUTE_REQUEST_KEY, JSON.stringify(nextRequest)); } catch {}

      const previousTransition = readRuntimeTransition();
      const cleared = clearRuntimeTransition({
        reason: 'route_ui_ready',
        path: livePath,
        fromPath: String(previousTransition?.fromPath || nextRequest?.previousPath || ''),
        toPath: livePath,
      });

      recordRouteDiagEvent('route_transition_cleared', {
        path: livePath,
        currentPath: livePath,
        previousPath: String(previousTransition?.fromPath || nextRequest?.previousPath || ''),
        transitionInFlight: false,
        clearedTransition: cleared,
        sourceLayer: 'app_root',
      });
    };

    try { window.addEventListener('tepiha:route-diag', onRouteDiag, true); } catch {}
    return () => {
      try { window.removeEventListener('tepiha:route-diag', onRouteDiag, true); } catch {}
    };
  }, [location?.pathname]);

  React.useEffect(() => {
    const check = (reason = 'visibility_or_focus') => clearStaleRouteRuntimeState(String(location?.pathname || '/'), reason);
    const onFocus = () => check('focus_path_mismatch_cleanup');
    const onPageShow = () => check('pageshow_path_mismatch_cleanup');
    const onVisible = () => {
      try { if (document.visibilityState !== 'visible') return; } catch {}
      check('visibility_visible_path_mismatch_cleanup');
    };
    try { window.addEventListener('focus', onFocus, { passive: true }); } catch {}
    try { window.addEventListener('pageshow', onPageShow, { passive: true }); } catch {}
    try { document.addEventListener('visibilitychange', onVisible, { passive: true }); } catch {}
    check('route_tracker_mount_path_mismatch_cleanup');
    return () => {
      try { window.removeEventListener('focus', onFocus); } catch {}
      try { window.removeEventListener('pageshow', onPageShow); } catch {}
      try { document.removeEventListener('visibilitychange', onVisible); } catch {}
    };
  }, [location?.pathname]);

  React.useEffect(() => {
    const now = Date.now();
    const path = String(location?.pathname || '/');
    clearStaleRouteRuntimeState(path, 'route_request_start_path_change');
    const search = String(location?.search || '');
    const previousPath = String(previousRef.current?.path || '');
    const previousSearch = String(previousRef.current?.search || '');
    const token = `req_${now}_${Math.random().toString(36).slice(2, 8)}`;
    const payload = {
      token,
      ts: now,
      at: new Date(now).toISOString(),
      path,
      search,
      currentPath: path,
      previousPath,
      previousSearch,
      locationKey: String(location?.key || ''),
      sourceLayer: 'app_root',
      transitionInFlight: true,
    };

    try { window.__TEPIHA_ACTIVE_ROUTE_REQUEST__ = payload; } catch {}
    try { window.sessionStorage?.setItem(ACTIVE_ROUTE_REQUEST_KEY, JSON.stringify(payload)); } catch {}
    try { window.localStorage?.setItem(ACTIVE_ROUTE_REQUEST_KEY, JSON.stringify(payload)); } catch {}
    try { window.dispatchEvent(new CustomEvent('tepiha:route-request-start', { detail: payload })); } catch {}

    recordRouteDiagEvent('route_request_start', payload);
    previousRef.current = { path, search };
  }, [location?.key, location?.pathname, location?.search]);

  return null;
}

function getRuntimeStatus() {
  try {
    if (!window.__TEPIHA_APP_ROOT_RUNTIME_STATUS__ || typeof window.__TEPIHA_APP_ROOT_RUNTIME_STATUS__ !== 'object') {
      window.__TEPIHA_APP_ROOT_RUNTIME_STATUS__ = {
        version: 'app-root-vite-fast-home-v12',
        criticalMode: 'home_eager_business_safe_lazy_fastboot',
        criticalModules: {},
        lazyModules: {},
        failures: [],
        lastUpdatedAt: new Date().toISOString(),
      };
    }
    return window.__TEPIHA_APP_ROOT_RUNTIME_STATUS__;
  } catch {
    return null;
  }
}

function markRuntimeModule(name, source = 'home_eager_business_safe_lazy_fastboot', extra = {}) {
  try {
    const status = getRuntimeStatus();
    if (!status) return;
    const bucket = source === 'lazy_chunk' ? 'lazyModules' : 'criticalModules';
    status[bucket] = status[bucket] && typeof status[bucket] === 'object' ? status[bucket] : {};
    status[bucket][name] = {
      name,
      source,
      loaded: true,
      loadedAt: new Date().toISOString(),
      ts: Date.now(),
      ...extra,
    };
    status.lastUpdatedAt = new Date().toISOString();
    try { window.dispatchEvent(new CustomEvent('tepiha:app-root-runtime-status', { detail: status })); } catch {}
  } catch {}
}

function recordRuntimeFailure(name, error, source = 'core_bundle_static_import', extra = {}) {
  try {
    const status = getRuntimeStatus();
    const entry = {
      name,
      moduleName: name,
      source,
      sourceLayer: source === 'lazy_chunk' ? 'app_root_runtime_lazy' : 'app_root_runtime_core',
      message: String(error?.message || error || 'runtime_module_failure'),
      stack: String(error?.stack || ''),
      at: new Date().toISOString(),
      ts: Date.now(),
      path: String(window.location?.pathname || '/'),
      assetUrl: String(extra?.assetUrl || extra?.resolvedAssetUrl || ''),
      ...extra,
    };
    if (status) {
      status.failures = Array.isArray(status.failures) ? status.failures : [];
      status.failures.unshift(entry);
      status.failures = status.failures.slice(0, 20);
      status.lastFailure = entry;
      status.lastUpdatedAt = entry.at;
    }
    try { window.__TEPIHA_LAST_APP_ROOT_RUNTIME_FAILURE__ = entry; } catch {}
    try { window.localStorage?.setItem('tepiha_app_root_runtime_failure_last_v1', JSON.stringify(entry)); } catch {}
    try {
      const list = JSON.parse(window.localStorage?.getItem('tepiha_app_root_runtime_failure_log_v1') || '[]');
      const next = [entry, ...((Array.isArray(list) ? list : []).filter(Boolean))].slice(0, 40);
      window.localStorage?.setItem('tepiha_app_root_runtime_failure_log_v1', JSON.stringify(next));
    } catch {}
    try { recordRouteDiagEvent('app_root_runtime_failure', entry); } catch {}
    return entry;
  } catch {
    return null;
  }
}

function RuntimeBoundary({ name, source = 'core_bundle_static_import', children }) {
  const handleError = React.useCallback((entry, error) => {
    recordRuntimeFailure(name, error, source, {
      localErrorEntry: entry,
      silentRuntimeModule: true,
    });
  }, [name, source]);

  return (
    <LocalErrorBoundary
      boundaryKind="runtime"
      routePath="/runtime"
      routeName="APP RUNTIME"
      moduleName={name}
      moduleId={name}
      componentName={name}
      sourceLayer={source === 'lazy_chunk' ? 'app_root_runtime_lazy' : 'app_root_runtime_core'}
      showHome={false}
      onError={handleError}
      renderFallback={() => null}
    >
      {children}
    </LocalErrorBoundary>
  );
}

function CoreRuntimeModule({ name, children }) {
  React.useEffect(() => {
    markRuntimeModule(name, 'core_bundle_static_import');
    try {
      recordRouteDiagEvent('app_root_runtime_core_loaded', {
        path: String(window.location?.pathname || '/'),
        moduleName: name,
        sourceLayer: 'app_root_runtime_core',
        criticalRuntimeMode: 'core_bundle_static_import',
      });
    } catch {}
  }, [name]);

  return (
    <RuntimeBoundary name={name} source="core_bundle_static_import">
      {children}
    </RuntimeBoundary>
  );
}

function normalizeRuntimeLazyModule(mod, name) {
  if (mod && typeof mod === 'object' && mod.default) return mod;

  const message = `AppRoot runtime lazy module ${name} resolved without a default export`;
  const error = new TypeError(message);
  try {
    error.moduleName = name;
    error.sourceLayer = 'app_root_runtime_lazy';
    error.resolvedModuleType = typeof mod;
    error.resolvedModuleKeys = mod && typeof mod === 'object' ? Object.keys(mod).slice(0, 12) : [];
  } catch {}
  throw error;
}

async function importRuntimeLazyModule(importer, name, retryCount) {
  const meta = {
    path: String(window.location?.pathname || '/runtime'),
    currentPath: String(window.location?.pathname || '/runtime'),
    kind: 'component',
    label: name,
    moduleName: name,
    moduleId: name,
    requestedModule: name,
    importerHint: name,
    importCaller: 'AppRootRuntime',
    componentName: name,
    retryCount,
    importRetryCount: retryCount,
    sourceLayer: 'app_root_runtime_lazy',
  };

  try {
    recordRouteDiagEvent('app_root_runtime_lazy_import_start', meta);
  } catch {}

  try {
    const mod = normalizeRuntimeLazyModule(await importer(), name);
    try {
      recordRouteDiagEvent('app_root_runtime_lazy_import_success', {
        ...meta,
        settledAt: new Date().toISOString(),
      });
    } catch {}
    return mod;
  } catch (error) {
    try {
      recordRouteDiagEvent('app_root_runtime_lazy_import_failure', {
        ...meta,
        settledAt: new Date().toISOString(),
        error: {
          name: String(error?.name || ''),
          message: String(error?.message || error || ''),
          stack: String(error?.stack || '').slice(0, 4000),
          moduleName: String(error?.moduleName || name),
          sourceLayer: String(error?.sourceLayer || 'app_root_runtime_lazy'),
          resolvedModuleType: String(error?.resolvedModuleType || ''),
          resolvedModuleKeys: Array.isArray(error?.resolvedModuleKeys) ? error.resolvedModuleKeys : [],
        },
      });
    } catch {}
    throw error;
  }
}

function makeRuntimeLazy(importer, name, retryCount, onSilentFailure) {
  return lazyWithReload(() => importRuntimeLazyModule(importer, name, retryCount), {
    label: name,
    moduleId: name,
    storageKey: `app_root_runtime_lazy:${name}`,
    sourceLayer: 'app_root_runtime_lazy',
    reloadWindowMs: 30000,
    silentFallback: true,
    silentRuntimeModule: true,
    onSilentFailure,
    meta: {
      kind: 'component',
      moduleName: name,
      requestedModule: name,
      importerHint: name,
      importCaller: 'AppRootRuntime',
      componentName: name,
      retryCount,
      importRetryCount: retryCount,
      silentRuntimeModule: true,
    },
  });
}

function SafeRuntimeLazy({ name, importer }) {
  const [retryCount, setRetryCount] = React.useState(0);
  const [disabled, setDisabled] = React.useState(() => isRuntimeModuleDisabled(name));
  const autoRetryRef = React.useRef(0);
  const timersRef = React.useRef([]);

  const disableForSession = React.useCallback((reason, extra = {}) => {
    markRuntimeModuleDisabled(name, reason, {
      retryCount,
      importRetryCount: retryCount,
      autoRetryCount: autoRetryRef.current,
      ...extra,
    });
    setDisabled(true);
  }, [name, retryCount]);

  const scheduleSilentRetryOrDisable = React.useCallback((reason, extra = {}) => {
    const autoRetryCount = Number(autoRetryRef.current || 0) || 0;
    if (autoRetryCount >= RUNTIME_MODULE_MAX_SILENT_RETRIES) {
      disableForSession(`${reason || 'runtime_module_failure'}_after_retry`, extra);
      return;
    }

    autoRetryRef.current = autoRetryCount + 1;
    const delay = RUNTIME_MODULE_RETRY_DELAY_MS;
    try {
      recordRouteDiagEvent('app_root_runtime_silent_retry_scheduled', {
        path: String(window.location?.pathname || '/'),
        moduleName: name,
        sourceLayer: 'app_root_runtime_lazy',
        retryCount,
        nextRetryCount: retryCount + 1,
        autoRetryCount: autoRetryRef.current,
        delayMs: delay,
        reason,
        ...extra,
      });
    } catch {}

    const timer = window.setTimeout(() => {
      setRetryCount((value) => Number(value || 0) + 1);
    }, delay);
    timersRef.current.push(timer);
  }, [disableForSession, name, retryCount]);

  const handleRetry = React.useCallback(() => {
    autoRetryRef.current = 0;
    setDisabled(false);
    setRetryCount((value) => Number(value || 0) + 1);
  }, []);

  const handleSilentImportFailure = React.useCallback((payload, error) => {
    const normalizedError = error || payload?.error || payload?.payload?.error || new Error(`Runtime module ${name} failed to import`);
    recordRuntimeFailure(name, normalizedError, 'lazy_chunk', {
      silentRuntimeModule: true,
      lazyImportPayload: payload || null,
      retryCount,
      importRetryCount: retryCount,
      autoRetryCount: autoRetryRef.current,
    });
    scheduleSilentRetryOrDisable('runtime_lazy_import_failure', {
      lazyImportPayload: payload || null,
    });
  }, [name, retryCount, scheduleSilentRetryOrDisable]);

  const handleError = React.useCallback((entry, error) => {
    recordRuntimeFailure(name, error, 'lazy_chunk', {
      localErrorEntry: entry,
      silentRuntimeModule: true,
      retryCount,
      importRetryCount: retryCount,
      autoRetryCount: autoRetryRef.current,
      assetUrl: String(entry?.assetUrl || entry?.resolvedAssetUrl || entry?.meta?.assetUrl || entry?.meta?.resolvedAssetUrl || ''),
    });
    scheduleSilentRetryOrDisable('runtime_render_failure', {
      localErrorEntry: entry,
      assetUrl: String(entry?.assetUrl || entry?.resolvedAssetUrl || entry?.meta?.assetUrl || entry?.meta?.resolvedAssetUrl || ''),
    });
  }, [name, retryCount, scheduleSilentRetryOrDisable]);

  const LazyRuntime = React.useMemo(
    () => makeRuntimeLazy(importer, name, retryCount, handleSilentImportFailure),
    [handleSilentImportFailure, importer, name, retryCount],
  );

  React.useEffect(() => () => {
    try { timersRef.current.forEach((timer) => window.clearTimeout(timer)); } catch {}
    timersRef.current = [];
  }, []);

  React.useEffect(() => {
    if (disabled) return;
    markRuntimeModule(name, 'lazy_chunk', {
      retryCount,
      silentRuntimeModule: true,
    });
  }, [disabled, name, retryCount]);

  if (disabled) return null;

  return (
    <RuntimeBoundary name={name} source="lazy_chunk">
      <LocalErrorBoundary
        boundaryKind="runtime"
        routePath="/runtime"
        routeName="APP RUNTIME"
        moduleName={name}
        moduleId={name}
        componentName={name}
        sourceLayer="app_root_runtime_lazy"
        showHome={false}
        resetKeys={[name, retryCount]}
        onRetry={handleRetry}
        onError={handleError}
        renderFallback={() => null}
        extraMeta={{ moduleName: name, moduleId: name, importCaller: 'AppRootRuntime', retryCount, importRetryCount: retryCount, autoRetryCount: autoRetryRef.current, silentRuntimeModule: true }}
      >
        <React.Suspense fallback={null}>
          <LazyRuntime />
        </React.Suspense>
      </LocalErrorBoundary>
    </RuntimeBoundary>
  );
}


export default function AppRoot() {
  return (
    <BrowserRouter>
      <RouteRequestTracker />
      <GlobalErrorBoundary>
        <AuthGate>
          <Routes>
            {appRoutes.map((route) => (
              <Route key={route.path} path={route.path} element={route.element} />
            ))}
          </Routes>

          <DeferredMount delay={1500} idle wakeSafe wakeBufferMs={350} waitForOwnerSignal={false}>
            <SafeRuntimeLazy name="ChunkLoadRuntime" importer={() => import('@/components/ChunkLoadRuntime.jsx')} />
          </DeferredMount>

          <DeferredMount delay={2000} idle wakeSafe wakeBufferMs={450} waitForOwnerSignal={false}>
            <SafeRuntimeLazy name="RootResumeWatchdog" importer={() => import('@/components/RootResumeWatchdog.jsx')} />
          </DeferredMount>

          <DeferredMount delay={2100} idle wakeSafe wakeBufferMs={500} waitForOwnerSignal={false} runtimeOwner>
            <SafeRuntimeLazy name="ServiceWorkerRegister" importer={() => import('@/components/ServiceWorkerRegister.jsx')} />
          </DeferredMount>

          <DeferredMount delay={3600} idle wakeSafe wakeBufferMs={700} waitForOwnerSignal={false}>
            <CoreRuntimeModule name="OfflineSyncRunner">
              <OfflineSyncRunner />
            </CoreRuntimeModule>
          </DeferredMount>

          <DeferredMount delay={3900} idle wakeSafe wakeBufferMs={700} waitForOwnerSignal={false}>
            <SafeRuntimeLazy name="SyncStarter" importer={() => import('@/components/SyncStarter.jsx')} />
          </DeferredMount>

          <DeferredMount delay={4500} idle wakeSafe wakeBufferMs={900} waitForOwnerSignal={false}>
            <SafeRuntimeLazy name="RuntimeIncidentUploader" importer={() => import('@/components/RuntimeIncidentUploader.jsx')} />
          </DeferredMount>

          <DeferredMount delay={2800} idle wakeSafe wakeBufferMs={500} waitForOwnerSignal={false}>
            <SafeRuntimeLazy name="SessionDock" importer={() => import('@/components/SessionDock.jsx')} />
          </DeferredMount>

          <DeferredMount delay={5600} idle wakeSafe wakeBufferMs={1200} waitForOwnerSignal={false}>
            <SafeRuntimeLazy name="OfflineFirstWarmup" importer={() => import('@/components/OfflineFirstWarmup.jsx')} />
          </DeferredMount>
        </AuthGate>
      </GlobalErrorBoundary>
    </BrowserRouter>
  );
}
