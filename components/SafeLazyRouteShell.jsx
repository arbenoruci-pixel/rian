'use client';

import React, { Suspense } from 'react';
import { lazyWithReload } from '@/lib/lazyWithReload.jsx';
import LocalErrorBoundary from '@/components/LocalErrorBoundary';
import {
  getLastChunkCapture,
  getLastLazyImportFailure,
  isProbablyChunkLikeMessage,
  loadLazyModule,
  recordRouteDiagEvent,
} from '@/lib/lazyImportRuntime';
import useRouteAlive from '@/lib/routeAlive';

const LOCAL_IMPORT_RETRY_DELAYS_MS = [300, 1200];

function safeString(value, fallback = '') {
  try {
    const text = String(value ?? '');
    return text || fallback;
  } catch {
    return fallback;
  }
}

function currentRuntimeContext() {
  if (typeof window === 'undefined') {
    return {
      href: '',
      appEpoch: '',
      buildId: '',
      online: null,
      visibilityState: '',
      bootId: '',
      userAgent: '',
    };
  }
  return {
    href: (() => { try { return String(window.location?.href || ''); } catch { return ''; } })(),
    appEpoch: (() => { try { return String(window.__TEPIHA_APP_EPOCH || ''); } catch { return ''; } })(),
    buildId: (() => { try { return String(window.__TEPIHA_BUILD_ID || ''); } catch { return ''; } })(),
    online: (() => { try { return navigator.onLine; } catch { return null; } })(),
    visibilityState: (() => { try { return String(document?.visibilityState || 'unknown'); } catch { return 'unknown'; } })(),
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
    userAgent: (() => { try { return String(navigator.userAgent || ''); } catch { return ''; } })(),
  };
}

function sleep(ms) {
  return new Promise((resolve) => {
    try { window.setTimeout(resolve, Math.max(0, Number(ms) || 0)); } catch { resolve(); }
  });
}

function normalizeError(error) {
  return {
    name: safeString(error?.name, ''),
    message: safeString(error?.message || error, 'UNKNOWN_IMPORT_ERROR'),
    stack: safeString(error?.stack, ''),
  };
}

function uniqueStrings(values) {
  const seen = new Set();
  const out = [];
  for (const value of values || []) {
    const text = safeString(value, '').trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

function readFailedAssetSnapshot() {
  let lazyFailure = null;
  let chunkCapture = null;
  try { lazyFailure = getLastLazyImportFailure?.() || null; } catch { lazyFailure = null; }
  try { chunkCapture = getLastChunkCapture?.() || null; } catch { chunkCapture = null; }

  const failedAssets = uniqueStrings([
    ...(Array.isArray(lazyFailure?.assetUrls) ? lazyFailure.assetUrls : []),
    lazyFailure?.assetUrl,
    lazyFailure?.resolvedAssetUrl,
    lazyFailure?.targetSrc,
    lazyFailure?.resolvedTargetSrc,
    ...(Array.isArray(chunkCapture?.assetUrls) ? chunkCapture.assetUrls : []),
    chunkCapture?.assetUrl,
    chunkCapture?.resolvedAssetUrl,
    chunkCapture?.targetSrc,
    chunkCapture?.resolvedTargetSrc,
  ]).slice(0, 12);

  return {
    failedAssets,
    failedAssetCount: failedAssets.length,
    lastLazyImportFailure: lazyFailure,
    lastChunkCapture: chunkCapture,
  };
}

function attachLocalImportMeta(error, meta = {}) {
  const target = error instanceof Error ? error : new Error(safeString(error, 'LOCAL_ROUTE_IMPORT_FAILURE'));
  try {
    Object.defineProperty(target, '__tepihaLocalMeta', {
      value: { ...(target.__tepihaLocalMeta || {}), ...(meta || {}) },
      configurable: true,
    });
  } catch {
    try { target.__tepihaLocalMeta = { ...(target.__tepihaLocalMeta || {}), ...(meta || {}) }; } catch {}
  }
  return target;
}

async function loadRouteModuleWithLocalRetry(importer, meta = {}) {
  const maxAutoRetries = LOCAL_IMPORT_RETRY_DELAYS_MS.length;
  let lastError = null;
  let lastSnapshot = readFailedAssetSnapshot();

  for (let attempt = 0; attempt <= maxAutoRetries; attempt += 1) {
    const attemptMeta = {
      ...meta,
      localRetryStrategy: 'safe_lazy_route_shell_import_retry',
      autoRetryAttempt: attempt,
      autoRetryCount: attempt,
      maxAutoRetries,
      retryDelayPlanMs: LOCAL_IMPORT_RETRY_DELAYS_MS,
      importRetryCount: attempt,
      retryCount: Number(meta?.retryCount || 0) || 0,
    };

    if (attempt > 0) {
      try {
        recordRouteDiagEvent('safe_route_import_retry_start', {
          ...attemptMeta,
          path: meta?.path,
          route: meta?.route || meta?.path,
          routeName: meta?.routeName,
          moduleId: meta?.moduleId,
          requestedModule: meta?.requestedModule || meta?.moduleId,
          componentName: meta?.componentName,
          failedAssets: lastSnapshot.failedAssets,
          failedAssetCount: lastSnapshot.failedAssetCount,
          sourceLayer: 'safe_lazy_route_shell',
          ...currentRuntimeContext(),
        });
      } catch {}
    }

    try {
      const mod = await loadLazyModule(importer, attemptMeta);
      if (attempt > 0) {
        try {
          recordRouteDiagEvent('safe_route_import_recovered', {
            ...attemptMeta,
            path: meta?.path,
            route: meta?.route || meta?.path,
            routeName: meta?.routeName,
            moduleId: meta?.moduleId,
            requestedModule: meta?.requestedModule || meta?.moduleId,
            componentName: meta?.componentName,
            recovered: true,
            routeRecovered: true,
            retrySucceeded: true,
            retryCount: attempt,
            autoRetryCount: attempt,
            failedAssets: lastSnapshot.failedAssets,
            failedAssetCount: lastSnapshot.failedAssetCount,
            sourceLayer: 'safe_lazy_route_shell',
            ...currentRuntimeContext(),
          });
        } catch {}
      }
      return mod;
    } catch (error) {
      lastError = error;
      lastSnapshot = readFailedAssetSnapshot();
      const normalized = normalizeError(error);
      const probableModuleLoadFailure = !!(
        lastSnapshot.failedAssets?.length
        || isProbablyChunkLikeMessage(normalized.message)
        || isProbablyChunkLikeMessage(normalized.stack)
      );

      if (attempt < maxAutoRetries) {
        const delayMs = LOCAL_IMPORT_RETRY_DELAYS_MS[attempt];
        try {
          recordRouteDiagEvent('safe_route_import_retry_scheduled', {
            ...attemptMeta,
            path: meta?.path,
            route: meta?.route || meta?.path,
            routeName: meta?.routeName,
            moduleId: meta?.moduleId,
            requestedModule: meta?.requestedModule || meta?.moduleId,
            componentName: meta?.componentName,
            nextRetryCount: attempt + 1,
            autoRetryCount: attempt + 1,
            delayMs,
            retryDelayMs: delayMs,
            retryScheduled: true,
            probableModuleLoadFailure,
            error: normalized,
            failedAssets: lastSnapshot.failedAssets,
            failedAssetCount: lastSnapshot.failedAssetCount,
            lastLazyImportFailure: lastSnapshot.lastLazyImportFailure,
            lastChunkCapture: lastSnapshot.lastChunkCapture,
            sourceLayer: 'safe_lazy_route_shell',
            ...currentRuntimeContext(),
          });
        } catch {}
        await sleep(delayMs);
        continue;
      }

      const finalMeta = {
        ...attemptMeta,
        path: meta?.path,
        route: meta?.route || meta?.path,
        routeName: meta?.routeName,
        module: meta?.moduleId,
        moduleName: meta?.moduleId,
        moduleId: meta?.moduleId,
        requestedModule: meta?.requestedModule || meta?.moduleId,
        componentName: meta?.componentName,
        sourceLayer: 'safe_lazy_route_shell',
        autoRetryExhausted: true,
        autoRetryCount: attempt,
        maxAutoRetries,
        retrySucceeded: false,
        recovered: false,
        routeRecovered: false,
        probableModuleLoadFailure,
        failedAssets: lastSnapshot.failedAssets,
        failedAssetCount: lastSnapshot.failedAssetCount,
        lastLazyImportFailure: lastSnapshot.lastLazyImportFailure,
        lastChunkCapture: lastSnapshot.lastChunkCapture,
        error: normalized,
      };

      try {
        recordRouteDiagEvent('safe_route_import_retry_exhausted', {
          ...finalMeta,
          ...currentRuntimeContext(),
        });
      } catch {}

      throw attachLocalImportMeta(lastError, finalMeta);
    }
  }

  throw attachLocalImportMeta(lastError, {
    ...meta,
    sourceLayer: 'safe_lazy_route_shell',
    autoRetryExhausted: true,
    routeRecovered: false,
    failedAssets: lastSnapshot.failedAssets,
    failedAssetCount: lastSnapshot.failedAssetCount,
  });
}

function makeLazyComponent(importer, meta) {
  return lazyWithReload(() => loadRouteModuleWithLocalRetry(importer, meta), {
    storageKey: `safe-route:${meta?.path || ''}:${meta?.moduleId || meta?.label || ''}`,
    label: meta?.moduleId || meta?.label || meta?.path || 'safe-route',
    moduleId: meta?.moduleId,
    sourceLayer: 'safe_lazy_route_shell',
    reloadWindowMs: 30000,
    meta,
  });
}

function SafeRouteLoading({ routePath, routeName, moduleId, componentName, retryCount }) {
  React.useEffect(() => {
    try {
      recordRouteDiagEvent('safe_route_shell_loading', {
        path: routePath,
        route: routePath,
        routeName,
        moduleId,
        requestedModule: moduleId,
        componentName,
        retryCount,
        importRetryCount: retryCount,
        sourceLayer: 'safe_lazy_route_shell',
        ...currentRuntimeContext(),
      });
    } catch {}
  }, [componentName, moduleId, retryCount, routeName, routePath]);

  return (
    <div style={ui.page} data-safe-route-shell="1" data-safe-route-loading="1" data-safe-route-path={routePath}>
      <div style={ui.card}>
        <div style={ui.eyebrow}>DUKE HAPUR FAQEN</div>
        <div style={ui.title}>{routeName || componentName || routePath}</div>
        <div style={ui.text}>Shell-i lokal është aktiv. Përmbajtja reale po ngarkohet brenda kufirit lokal.</div>
        <div style={ui.meta}>MODULE: {moduleId || '—'} · RETRY: {retryCount}</div>
      </div>
    </div>
  );
}

export default function SafeLazyRouteShell({
  routePath = '/',
  routeName = '',
  moduleId = '',
  componentName = '',
  importer,
}) {
  const safeRoutePath = safeString(routePath, '/');
  const safeRouteName = safeString(routeName, safeRoutePath);
  const safeModuleId = safeString(moduleId, 'UNKNOWN_MODULE');
  const safeComponentName = safeString(componentName, safeRouteName || safeRoutePath);
  const displayTitle = safeString(safeComponentName || safeRouteName || safeRoutePath, 'FAQJA').toUpperCase();
  const [retryCount, setRetryCount] = React.useState(0);

  useRouteAlive(`safe_shell:${safeRoutePath}`);

  const lazyMeta = React.useMemo(() => ({
    kind: 'route',
    label: safeModuleId,
    moduleId: safeModuleId,
    requestedModule: safeModuleId,
    importerHint: safeModuleId,
    importCaller: 'SafeLazyRouteShell',
    componentName: safeComponentName,
    path: safeRoutePath,
    route: safeRoutePath,
    routeName: safeRouteName,
    importRetryCount: 0,
    retryCount,
    manualRetryCount: retryCount,
    maxAutoRetries: LOCAL_IMPORT_RETRY_DELAYS_MS.length,
    retryDelayPlanMs: LOCAL_IMPORT_RETRY_DELAYS_MS,
  }), [retryCount, safeComponentName, safeModuleId, safeRouteName, safeRoutePath]);

  const LazyInner = React.useMemo(() => makeLazyComponent(importer, lazyMeta), [importer, lazyMeta]);

  React.useEffect(() => {
    try {
      recordRouteDiagEvent('safe_route_shell_mount', {
        path: safeRoutePath,
        route: safeRoutePath,
        routeName: safeRouteName,
        moduleId: safeModuleId,
        requestedModule: safeModuleId,
        componentName: safeComponentName,
        retryCount,
        importRetryCount: retryCount,
        sourceLayer: 'safe_lazy_route_shell',
        ...currentRuntimeContext(),
      });
    } catch {}
  }, [retryCount, safeComponentName, safeModuleId, safeRouteName, safeRoutePath]);

  const handleRetry = React.useCallback(() => {
    try {
      recordRouteDiagEvent('safe_route_shell_manual_retry', {
        path: safeRoutePath,
        route: safeRoutePath,
        routeName: safeRouteName,
        moduleId: safeModuleId,
        requestedModule: safeModuleId,
        componentName: safeComponentName,
        nextRetryCount: retryCount + 1,
        retryCount,
        importRetryCount: retryCount,
        sourceLayer: 'safe_lazy_route_shell',
        ...currentRuntimeContext(),
      });
    } catch {}
    setRetryCount((value) => Number(value || 0) + 1);
  }, [retryCount, safeComponentName, safeModuleId, safeRouteName, safeRoutePath]);

  if (typeof importer !== 'function') {
    throw new Error(`SAFE_ROUTE_IMPORTER_MISSING: ${safeRoutePath}`);
  }

  return (
    <LocalErrorBoundary
      boundaryKind="route"
      routePath={safeRoutePath}
      routeName={safeRouteName}
      moduleName={safeModuleId}
      moduleId={safeModuleId}
      componentName={safeComponentName}
      sourceLayer="safe_lazy_route_shell"
      title={`${displayTitle} NUK U NGARKUA`}
      helpText="Problemi duket te ngarkimi i modulit, jo te të dhënat. Provo përsëri. Nëse përsëritet, përdor RIPARO APP."
      repairHref="/pwa-repair.html?from=route_import_failure"
      repairLabel="RIPARO APP"
      resetKeys={[safeRoutePath, safeModuleId, retryCount]}
      onRetry={handleRetry}
      extraMeta={{
        route: safeRoutePath,
        routeName: safeRouteName,
        module: safeModuleId,
        moduleName: safeModuleId,
        moduleId: safeModuleId,
        requestedModule: safeModuleId,
        componentName: safeComponentName,
        importCaller: 'SafeLazyRouteShell',
        retryCount,
        manualRetryCount: retryCount,
        importRetryCount: retryCount,
        retryStrategy: 'safe_lazy_route_shell_import_retry',
        maxAutoRetries: LOCAL_IMPORT_RETRY_DELAYS_MS.length,
        retryDelayPlanMs: LOCAL_IMPORT_RETRY_DELAYS_MS,
      }}
    >
      <Suspense
        fallback={(
          <SafeRouteLoading
            routePath={safeRoutePath}
            routeName={safeRouteName}
            moduleId={safeModuleId}
            componentName={safeComponentName}
            retryCount={retryCount}
          />
        )}
      >
        <LazyInner />
      </Suspense>
    </LocalErrorBoundary>
  );
}

const ui = {
  page: {
    minHeight: '100vh',
    background: '#05070d',
    color: '#fff',
    padding: 16,
    display: 'grid',
    alignItems: 'start',
    fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif',
  },
  card: {
    width: '100%',
    maxWidth: 760,
    margin: '0 auto',
    borderRadius: 20,
    border: '1px solid rgba(96,165,250,0.28)',
    background: 'rgba(15,23,42,0.94)',
    boxShadow: '0 18px 40px rgba(0,0,0,0.35)',
    padding: 16,
  },
  eyebrow: {
    color: '#93c5fd',
    fontSize: 12,
    fontWeight: 950,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  title: {
    marginTop: 6,
    fontSize: 22,
    lineHeight: 1.12,
    fontWeight: 1000,
    letterSpacing: 0.2,
  },
  text: {
    marginTop: 8,
    color: 'rgba(255,255,255,0.78)',
    fontSize: 13,
    lineHeight: 1.5,
    fontWeight: 750,
  },
  meta: {
    marginTop: 12,
    color: 'rgba(255,255,255,0.62)',
    fontSize: 11,
    fontWeight: 900,
    letterSpacing: 0.8,
    wordBreak: 'break-word',
  },
};
