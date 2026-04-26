import React from 'react';
import { BrowserRouter, Routes, Route, useLocation } from 'react-router-dom';
import '@/app/globals.css';
import '@/phone-safearea.css';
import AuthGate from '@/components/AuthGate';
import GlobalErrorBoundary from '@/components/GlobalErrorBoundary';
import LocalErrorBoundary from '@/components/LocalErrorBoundary';
import OfflineSyncRunner from '@/components/OfflineSyncRunner.jsx';
import ChunkLoadRuntime from '@/components/ChunkLoadRuntime.jsx';
import RootResumeWatchdog from '@/components/RootResumeWatchdog.jsx';
import ServiceWorkerRegister from '@/components/ServiceWorkerRegister.jsx';
import SyncStarter from '@/components/SyncStarter.jsx';
import RuntimeIncidentUploader from '@/components/RuntimeIncidentUploader.jsx';
import SessionDock from '@/components/SessionDock.jsx';
import OfflineFirstWarmup from '@/components/OfflineFirstWarmup.jsx';
import DeferredMount from '@/components/DeferredMount';
import { appRoutes } from './generated/routes.generated.jsx';
import { ACTIVE_ROUTE_REQUEST_KEY, recordRouteDiagEvent } from '@/lib/lazyImportRuntime';
import { clearRuntimeTransition, readRuntimeTransition } from '@/lib/rootResumePanic';

try {
  if (typeof window !== 'undefined') {
    window.__TEPIHA_ALLOW_BROWSER_OFFLINE_RUNTIME__ = true;
  }
} catch {}

const APP_ROOT_RUNTIME_DIAG_CLEANUP_MARKER = 'tepiha_runtime_diag_cleanup_done_RESET-2026-04-26-VITE-ROUTE-READINESS-V25';
const OLD_RUNTIME_DIAG_KEYS = [
  'tepiha_app_root_runtime_failure_log_v1',
  'tepiha_app_root_runtime_failure_last_v1',
  'tepiha_silent_lazy_failure_log_v1',
  'tepiha_runtime_module_disabled_v1',
];

function clearStaleRuntimeDiagnosticsForV23() {
  try {
    if (typeof window === 'undefined') return;
    const marker = window.localStorage?.getItem?.(APP_ROOT_RUNTIME_DIAG_CLEANUP_MARKER)
      || window.sessionStorage?.getItem?.(APP_ROOT_RUNTIME_DIAG_CLEANUP_MARKER);
    if (marker === '1') return;

    OLD_RUNTIME_DIAG_KEYS.forEach((key) => {
      try { window.localStorage?.removeItem?.(key); } catch {}
      try { window.sessionStorage?.removeItem?.(key); } catch {}
    });

    try { window.__TEPIHA_LAST_APP_ROOT_RUNTIME_FAILURE__ = null; } catch {}
    try {
      window.__TEPIHA_APP_ROOT_RUNTIME_STATUS__ = {
        version: 'app-root-vite-route-readiness-v25',
        criticalMode: 'static_runtime_deferred_no_lazy_chunks',
        criticalModules: {},
        lazyModules: {},
        failures: [],
        lastUpdatedAt: new Date().toISOString(),
        staleRuntimeDiagCleanup: true,
      };
    } catch {}
    try { window.localStorage?.setItem?.(APP_ROOT_RUNTIME_DIAG_CLEANUP_MARKER, '1'); } catch {}
    try { window.sessionStorage?.setItem?.(APP_ROOT_RUNTIME_DIAG_CLEANUP_MARKER, '1'); } catch {}
    try {
      recordRouteDiagEvent('app_root_runtime_diag_cleanup_v23', {
        path: String(window.location?.pathname || '/'),
        sourceLayer: 'app_root',
        appEpoch: 'RESET-2026-04-26-VITE-ROUTE-READINESS-V25',
        removedKeys: OLD_RUNTIME_DIAG_KEYS,
      });
    } catch {}
  } catch {}
}

clearStaleRuntimeDiagnosticsForV23();

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
      if (!detail) return;
      const routeDiagType = String(detail?.type || '');
      // PATCH M / V25: component_mount / first_paint / first_interactive are
      // diagnostic only. They no longer clear transitionInFlight because they
      // can happen while the page is still waiting for data.
      const routeSettleTypes = new Set(['route_ui_ready']);
      if (!routeSettleTypes.has(routeDiagType)) return;
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
          settledReason: routeDiagType === 'route_ui_ready' ? 'route_ui_ready' : `route_soft_settled_${routeDiagType}`,
          currentPath: livePath,
          path: livePath,
        } : {
          path: livePath,
          currentPath: livePath,
          previousPath: String(previousRef.current?.path || ''),
          transitionInFlight: false,
          settledAt,
          settledReason: routeDiagType === 'route_ui_ready' ? 'route_ui_ready' : `route_soft_settled_${routeDiagType}`,
        };
      } catch {
        nextRequest = {
          path: livePath,
          currentPath: livePath,
          previousPath: String(previousRef.current?.path || ''),
          transitionInFlight: false,
          settledAt,
          settledReason: routeDiagType === 'route_ui_ready' ? 'route_ui_ready' : `route_soft_settled_${routeDiagType}`,
        };
      }

      try { window.__TEPIHA_ACTIVE_ROUTE_REQUEST__ = nextRequest; } catch {}
      try { window.sessionStorage?.setItem(ACTIVE_ROUTE_REQUEST_KEY, JSON.stringify(nextRequest)); } catch {}
      try { window.localStorage?.setItem(ACTIVE_ROUTE_REQUEST_KEY, JSON.stringify(nextRequest)); } catch {}

      const previousTransition = readRuntimeTransition();
      const cleared = clearRuntimeTransition({
        reason: routeDiagType === 'route_ui_ready' ? 'route_ui_ready' : `route_soft_settled_${routeDiagType}`,
        path: livePath,
        fromPath: String(previousTransition?.fromPath || nextRequest?.previousPath || ''),
        toPath: livePath,
      });

      recordRouteDiagEvent(routeDiagType === 'route_ui_ready' ? 'route_transition_cleared' : 'route_transition_soft_cleared', {
        path: livePath,
        currentPath: livePath,
        previousPath: String(previousTransition?.fromPath || nextRequest?.previousPath || ''),
        transitionInFlight: false,
        clearedTransition: cleared,
        sourceLayer: 'app_root',
      });
    };

    const onForceSettled = (event) => {
      try {
        const detail = event?.detail && typeof event.detail === 'object' ? event.detail : {};
        const livePath = String(location?.pathname || window.location?.pathname || '/');
        const detailPath = String(detail?.path || detail?.currentPath || livePath);
        if (detailPath !== livePath) return;
        const settledAt = Date.now();
        const current = window.__TEPIHA_ACTIVE_ROUTE_REQUEST__ && typeof window.__TEPIHA_ACTIVE_ROUTE_REQUEST__ === 'object'
          ? window.__TEPIHA_ACTIVE_ROUTE_REQUEST__
          : readActiveRouteRequestSnapshot();
        const nextRequest = current ? {
          ...current,
          path: livePath,
          currentPath: livePath,
          transitionInFlight: false,
          settledAt,
          settledReason: String(detail?.reason || 'force_route_settled'),
          forcedRouteSettled: true,
          source: String(detail?.source || 'force_route_settled'),
        } : {
          path: livePath,
          currentPath: livePath,
          previousPath: String(previousRef.current?.path || ''),
          transitionInFlight: false,
          settledAt,
          settledReason: String(detail?.reason || 'force_route_settled'),
          forcedRouteSettled: true,
          source: String(detail?.source || 'force_route_settled'),
        };
        writeActiveRouteRequestSnapshot(nextRequest);
        const previousTransition = readRuntimeTransition();
        const cleared = clearRuntimeTransition({
          reason: String(detail?.reason || 'force_route_settled'),
          path: livePath,
          fromPath: String(previousTransition?.fromPath || nextRequest?.previousPath || ''),
          toPath: livePath,
        });
        recordRouteDiagEvent('route_transition_force_cleared', {
          path: livePath,
          currentPath: livePath,
          previousPath: String(previousTransition?.fromPath || nextRequest?.previousPath || ''),
          transitionInFlight: false,
          clearedTransition: cleared,
          sourceLayer: 'app_root',
          patch: 'PATCH_M_V25_route_readiness',
          forceDetail: detail,
        });
      } catch {}
    };
    try { window.addEventListener('tepiha:route-diag', onRouteDiag, true); } catch {}
    try { window.addEventListener('tepiha:force-route-settled', onForceSettled, true); } catch {}
    return () => {
      try { window.removeEventListener('tepiha:route-diag', onRouteDiag, true); } catch {}
      try { window.removeEventListener('tepiha:force-route-settled', onForceSettled, true); } catch {}
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

    const settleIfStillCurrent = (delayMs, reason) => window.setTimeout(() => {
      try {
        const livePath = String(window.location?.pathname || '/');
        const current = window.__TEPIHA_ACTIVE_ROUTE_REQUEST__ && typeof window.__TEPIHA_ACTIVE_ROUTE_REQUEST__ === 'object'
          ? window.__TEPIHA_ACTIVE_ROUTE_REQUEST__
          : readActiveRouteRequestSnapshot();
        if (!current || current.token !== token || livePath !== path || current.transitionInFlight === false) return;
        const settledAt = Date.now();
        const next = {
          ...current,
          path: livePath,
          currentPath: livePath,
          transitionInFlight: false,
          settledAt,
          settledReason: String(reason || 'route_soft_settled_timeout'),
          failOpenSoftSettled: true,
        };
        writeActiveRouteRequestSnapshot(next);
        const previousTransition = readRuntimeTransition();
        const cleared = clearRuntimeTransition({
          reason: String(reason || 'route_soft_settled_timeout'),
          path: livePath,
          fromPath: String(previousTransition?.fromPath || previousPath || ''),
          toPath: livePath,
        });
        recordRouteDiagEvent('route_transition_soft_timeout_cleared', {
          path: livePath,
          currentPath: livePath,
          previousPath: String(previousTransition?.fromPath || previousPath || ''),
          transitionInFlight: false,
          clearedTransition: cleared,
          reason: String(reason || 'route_soft_settled_timeout'),
          sourceLayer: 'app_root',
        });
      } catch {}
    }, delayMs);

    const softSettleFast = settleIfStillCurrent(1200, 'route_soft_settled_1200ms');
    const softSettleSlow = settleIfStillCurrent(3600, 'route_soft_settled_3600ms');
    return () => {
      try { window.clearTimeout(softSettleFast); } catch {}
      try { window.clearTimeout(softSettleSlow); } catch {}
    };
  }, [location?.key, location?.pathname, location?.search]);

  return null;
}

function getRuntimeStatus() {
  try {
    if (!window.__TEPIHA_APP_ROOT_RUNTIME_STATUS__ || typeof window.__TEPIHA_APP_ROOT_RUNTIME_STATUS__ !== 'object') {
      window.__TEPIHA_APP_ROOT_RUNTIME_STATUS__ = {
        version: 'app-root-vite-route-readiness-v25',
        criticalMode: 'static_runtime_deferred_no_lazy_chunks',
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
    const bucket = 'criticalModules';
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
      sourceLayer: 'app_root_runtime_core',
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
      sourceLayer="app_root_runtime_core"
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
            <CoreRuntimeModule name="ChunkLoadRuntime">
              <ChunkLoadRuntime />
            </CoreRuntimeModule>
          </DeferredMount>

          <DeferredMount delay={2000} idle wakeSafe wakeBufferMs={450} waitForOwnerSignal={false}>
            <CoreRuntimeModule name="RootResumeWatchdog">
              <RootResumeWatchdog />
            </CoreRuntimeModule>
          </DeferredMount>

          <DeferredMount delay={2100} idle wakeSafe wakeBufferMs={500} waitForOwnerSignal={false} runtimeOwner>
            <CoreRuntimeModule name="ServiceWorkerRegister">
              <ServiceWorkerRegister />
            </CoreRuntimeModule>
          </DeferredMount>

          <DeferredMount delay={2800} idle wakeSafe wakeBufferMs={500} waitForOwnerSignal={false}>
            <CoreRuntimeModule name="SessionDock">
              <SessionDock />
            </CoreRuntimeModule>
          </DeferredMount>

          <DeferredMount delay={3600} idle wakeSafe wakeBufferMs={700} waitForOwnerSignal={false}>
            <CoreRuntimeModule name="OfflineSyncRunner">
              <OfflineSyncRunner />
            </CoreRuntimeModule>
          </DeferredMount>

          <DeferredMount delay={3900} idle wakeSafe wakeBufferMs={700} waitForOwnerSignal={false}>
            <CoreRuntimeModule name="SyncStarter">
              <SyncStarter />
            </CoreRuntimeModule>
          </DeferredMount>

          <DeferredMount delay={4500} idle wakeSafe wakeBufferMs={900} waitForOwnerSignal={false}>
            <CoreRuntimeModule name="RuntimeIncidentUploader">
              <RuntimeIncidentUploader />
            </CoreRuntimeModule>
          </DeferredMount>

          <DeferredMount delay={5600} idle wakeSafe wakeBufferMs={1200} waitForOwnerSignal={false}>
            <CoreRuntimeModule name="OfflineFirstWarmup">
              <OfflineFirstWarmup />
            </CoreRuntimeModule>
          </DeferredMount>
        </AuthGate>
      </GlobalErrorBoundary>
    </BrowserRouter>
  );
}
