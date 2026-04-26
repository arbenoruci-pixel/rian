'use client';

import { useEffect } from 'react';
import { bootLog, bootSnapshot } from '@/lib/bootLog';
import { pushGlobalError, isChunkLoadLikeError } from '@/lib/globalErrors';
import { pushLocalErrorLog } from '@/lib/localErrorLog';
import { getLastChunkCapture, getLastLazyImportFailure, getLastLazyImportAttempt, isProbablyChunkLikeMessage, recordChunkCapture, recordRouteDiagEvent } from '@/lib/lazyImportRuntime';

const CONTROLLED_RECOVERY_EVENT = 'tepiha:sw-controlled-recovery-request';
function isBrowser() {
  return typeof window !== 'undefined';
}

function emitSimpleIncident(incidentType, meta = {}) {
  if (!isBrowser()) return;
  try {
    const snap = bootSnapshot() || {};
    window.dispatchEvent(new CustomEvent('tepiha:simple-incident', {
      detail: {
        ...snap,
        incidentType,
        lastEventType: incidentType,
        lastEventAt: new Date().toISOString(),
        meta,
      },
    }));
  } catch {
    // ignore
  }
}

function safeTargetMeta(event) {
  const target = event?.target;
  return {
    tagName: String(target?.tagName || ''),
    targetSrc: String(target?.currentSrc || target?.src || target?.href || ''),
    targetType: String(target?.type || ''),
    targetRel: String(target?.rel || ''),
    filename: String(event?.filename || ''),
    message: String(event?.message || ''),
    lineno: Number(event?.lineno || 0) || 0,
    colno: Number(event?.colno || 0) || 0,
    stack: String(event?.error?.stack || ''),
  };
}

function resolveAssetUrl(raw) {
  try {
    return raw ? String(new URL(String(raw), String(document.baseURI || window.location?.href || '/')).toString()) : '';
  } catch {
    try { return String(raw || ''); } catch { return ''; }
  }
}

function readPerformanceEntriesByName(assetUrl) {
  try {
    if (!assetUrl || typeof performance === 'undefined' || typeof performance.getEntriesByName !== 'function') return [];
    return (performance.getEntriesByName(String(assetUrl || '')) || []).map((item) => ({
      name: String(item?.name || ''),
      entryType: String(item?.entryType || ''),
      initiatorType: String(item?.initiatorType || ''),
      startTime: Number(item?.startTime || 0) || 0,
      duration: Number(item?.duration || 0) || 0,
      transferSize: Number(item?.transferSize || 0) || 0,
      encodedBodySize: Number(item?.encodedBodySize || 0) || 0,
      decodedBodySize: Number(item?.decodedBodySize || 0) || 0,
      responseStatus: Number(item?.responseStatus || 0) || 0,
    })).slice(0, 4);
  } catch {
    return [];
  }
}

function readNavigationType() {
  try {
    const list = typeof performance !== 'undefined' && typeof performance.getEntriesByType === 'function'
      ? performance.getEntriesByType('navigation')
      : [];
    return String(list?.[0]?.type || '');
  } catch {
    return '';
  }
}

function readHiddenElapsedMs() {
  try {
    const hiddenAt = Number(window.__tepihaLastHiddenAt || window.localStorage?.getItem('tepiha_last_hidden_at_v3') || 0) || 0;
    if (!hiddenAt) return -1;
    return Math.max(0, Date.now() - hiddenAt);
  } catch {
    return -1;
  }
}

function readModuleLoadPhase() {
  const hiddenElapsedMs = readHiddenElapsedMs();
  if (hiddenElapsedMs >= 0 && hiddenElapsedMs <= 12000) return 'resume_recent';
  const navigationType = readNavigationType();
  if (navigationType) return `navigation_${navigationType}`;
  return 'initial_load';
}

function readPreviousPath() {
  try {
    const active = window.__TEPIHA_ACTIVE_ROUTE_REQUEST__ && typeof window.__TEPIHA_ACTIVE_ROUTE_REQUEST__ === 'object'
      ? window.__TEPIHA_ACTIVE_ROUTE_REQUEST__
      : JSON.parse(window.sessionStorage?.getItem('tepiha_active_route_request_v1') || 'null');
    if (active?.previousPath) return String(active.previousPath || '');
  } catch {}
  try {
    const transition = window.__TEPIHA_ROUTE_TRANSITION__ && typeof window.__TEPIHA_ROUTE_TRANSITION__ === 'object'
      ? window.__TEPIHA_ROUTE_TRANSITION__
      : JSON.parse(window.sessionStorage?.getItem('tepiha_route_transition_v1') || 'null');
    return String(transition?.fromPath || '');
  } catch {}
  return '';
}

function isModuleScriptTarget(meta = {}) {
  const tag = String(meta.tagName || '').toUpperCase();
  const type = String(meta.targetType || '').toLowerCase();
  const rel = String(meta.targetRel || '').toLowerCase();
  const src = String(meta.targetSrc || meta.filename || '');
  if (tag === 'SCRIPT' && (type === 'module' || /\/(?:assets|src)\/.*\.(?:js|mjs)(?:\?|$)/i.test(src))) return true;
  if (tag === 'LINK' && rel === 'modulepreload') return true;
  return false;
}

function isOptionalReconcileAssetError(meta = {}, lastAttempt = null) {
  try {
    const values = [
      meta?.targetSrc,
      meta?.filename,
      meta?.resolvedTargetSrc,
      meta?.message,
      lastAttempt?.requestedModule,
      lastAttempt?.importerHint,
      lastAttempt?.label,
      lastAttempt?.moduleName,
      lastAttempt?.importCaller,
    ].map((value) => String(value || '')).join(' ');

    return /\/assets\/reconcile-[^/]*\.js(?:\?|$|\s)/i.test(values)
      || /(?:^|\s|['"])@?\/?lib\/reconcile\//i.test(values)
      || /(?:^|\s|['"])@\/lib\/reconcile\//i.test(values);
  } catch {
    return false;
  }
}

function chunkMetaFromErrorLike(errorLike, extra = {}) {
  const message = String(errorLike?.message || errorLike || '');
  const stack = String(errorLike?.stack || '');
  const lazy = getLastLazyImportFailure();
  const capture = getLastChunkCapture();
  return {
    message,
    stack,
    name: String(errorLike?.name || ''),
    lastLazyImport: lazy,
    lastChunkCapture: capture,
    ...extra,
  };
}

function logLocalModuleLoadError(errorLike, meta = {}) {
  try {
    pushLocalErrorLog(errorLike || meta?.message || 'MODULE_LOAD_ERROR', { componentStack: '' }, {
      boundaryKind: 'module_load',
      routePath: (() => { try { return String(window.location?.pathname || '/'); } catch { return '/'; } })(),
      routeName: 'RUNTIME MODULE LOAD',
      moduleName: String(meta?.requestedModule || meta?.lazyLabel || meta?.moduleName || meta?.incidentType || meta?.sourceLayer || 'ChunkLoadRuntime'),
      componentName: String(meta?.componentName || meta?.lazyLabel || 'ChunkLoadRuntime'),
      sourceLayer: 'chunk_load_runtime',
      ...meta,
    });
  } catch {}
}

export default function ChunkLoadRuntime() {
  useEffect(() => {
    if (!isBrowser()) return undefined;

    const onLazyImportFailure = (event) => {
      const detail = event?.detail && typeof event.detail === 'object' ? event.detail : null;
      if (!detail) return;
      try { pushGlobalError('ui/lazy_import_failure', detail?.message || 'LAZY_IMPORT_FAILURE', detail); } catch {}
      try { bootLog('lazy_import_failure', detail); } catch {}
      try { emitSimpleIncident('lazy_import_failure', detail); } catch {}
      const message = String(detail?.message || detail?.error?.message || '');
      if (isProbablyChunkLikeMessage(message)) {
        try { logLocalModuleLoadError(detail?.error || message || 'LAZY_IMPORT_FAILURE', { incidentType: 'lazy_import_failure', ...detail }); } catch {}
      }
    };

    const onWindowError = (event) => {
      const meta = safeTargetMeta(event);
      const moduleTarget = isModuleScriptTarget(meta);
      const chunkLike = moduleTarget || isProbablyChunkLikeMessage(meta.message) || isProbablyChunkLikeMessage(meta.stack);
      if (!chunkLike) return;
      const lastAttempt = getLastLazyImportAttempt();
      const resolvedTargetSrc = resolveAssetUrl(meta.targetSrc || meta.filename || '');
      const routePath = (() => { try { return String(window.location?.pathname || ''); } catch { return ''; } })();
      const previousPath = readPreviousPath();

      if (isOptionalReconcileAssetError({ ...meta, resolvedTargetSrc }, lastAttempt)) {
        try {
          recordRouteDiagEvent('optional_reconcile_modulepreload_error_suppressed', {
            path: routePath,
            currentPath: routePath,
            previousPath,
            targetSrc: String(meta.targetSrc || ''),
            targetRel: String(meta.targetRel || ''),
            resolvedAssetUrl: resolvedTargetSrc,
            importCaller: String(lastAttempt?.importCaller || ''),
            label: String(lastAttempt?.label || ''),
            requestedModule: String(lastAttempt?.requestedModule || ''),
            sourceLayer: 'chunk_load_runtime',
            message: String(meta.message || ''),
            navigationType: readNavigationType(),
            hiddenElapsedMs: readHiddenElapsedMs(),
            moduleLoadPhase: readModuleLoadPhase(),
            performanceEntries: readPerformanceEntriesByName(resolvedTargetSrc),
            optionalHelper: true,
          });
        } catch {}
        try { bootLog('optional_reconcile_modulepreload_error_suppressed', { targetSrc: String(meta.targetSrc || ''), resolvedAssetUrl: resolvedTargetSrc, path: routePath }); } catch {}
        return;
      }

      const capture = recordChunkCapture('window_module_error', {
        ...meta,
        moduleTarget,
        resolvedTargetSrc,
        currentRoute: routePath,
        previousRoute: previousPath,
        importCaller: String(lastAttempt?.importCaller || ''),
        lazyLabel: String(lastAttempt?.label || ''),
        requestedModule: String(lastAttempt?.requestedModule || ''),
        lastLazyImportAttempt: lastAttempt,
        href: (() => { try { return String(window.location?.href || ''); } catch { return ''; } })(),
        baseURI: (() => { try { return String(document.baseURI || window.location?.href || ''); } catch { return ''; } })(),
        readyState: (() => { try { return String(document.readyState || ''); } catch { return ''; } })(),
        visibilityState: (() => { try { return String(document.visibilityState || ''); } catch { return ''; } })(),
        online: (() => { try { return navigator.onLine; } catch { return null; } })(),
        navigationType: readNavigationType(),
        hiddenElapsedMs: readHiddenElapsedMs(),
        moduleLoadPhase: readModuleLoadPhase(),
        performanceEntries: readPerformanceEntriesByName(resolvedTargetSrc),
      });
      try {
        recordRouteDiagEvent('modulepreload_asset_error', {
          path: routePath,
          currentPath: routePath,
          previousPath,
          targetSrc: String(meta.targetSrc || ''),
          targetRel: String(meta.targetRel || ''),
          resolvedAssetUrl: resolvedTargetSrc,
          importCaller: String(lastAttempt?.importCaller || ''),
          label: String(lastAttempt?.label || ''),
          requestedModule: String(lastAttempt?.requestedModule || ''),
          sourceLayer: 'chunk_load_runtime',
          message: String(meta.message || ''),
          navigationType: readNavigationType(),
          hiddenElapsedMs: readHiddenElapsedMs(),
          moduleLoadPhase: readModuleLoadPhase(),
          performanceEntries: readPerformanceEntriesByName(resolvedTargetSrc),
        });
      } catch {}
      try { pushGlobalError('ui/window_module_error', meta.message || 'WINDOW_MODULE_ERROR', capture || meta); } catch {}
      try { bootLog('window_module_error', capture || meta); } catch {}
      try { emitSimpleIncident('window_module_error', capture || meta); } catch {}
      try { logLocalModuleLoadError(meta?.message || 'WINDOW_MODULE_ERROR', { incidentType: 'window_module_error', ...(capture || meta) }); } catch {}
    };

    const onUnhandledRejection = (event) => {
      const reason = event?.reason;
      const message = String(reason?.message || reason || '');
      const stack = String(reason?.stack || '');
      const chunkLike = isChunkLoadLikeError(reason) || isProbablyChunkLikeMessage(message) || isProbablyChunkLikeMessage(stack);
      if (!chunkLike) return;
      const capture = recordChunkCapture('chunk_unhandled_rejection', {
        message,
        stack,
        name: String(reason?.name || ''),
      });
      const meta = chunkMetaFromErrorLike(reason, capture || {});
      try { pushGlobalError('ui/chunk_unhandled_rejection', reason || 'CHUNK_UNHANDLED_REJECTION', meta); } catch {}
      try { bootLog('chunk_unhandled_rejection', meta); } catch {}
      try { emitSimpleIncident('chunk_unhandled_rejection', meta); } catch {}
      try { logLocalModuleLoadError(reason || message || 'CHUNK_UNHANDLED_REJECTION', { incidentType: 'chunk_unhandled_rejection', ...meta }); } catch {}
    };

    const onRecoveryRequest = (event) => {
      const detail = event?.detail && typeof event.detail === 'object' ? event.detail : {};
      try {
        recordChunkCapture('controlled_recovery_request_suppressed', {
          reason: String(detail?.reason || 'chunk_error'),
          detail,
          sourceLayer: 'chunk_load_runtime_local_strategy',
        });
      } catch {}
      try {
        logLocalModuleLoadError('CONTROLLED_RECOVERY_SUPPRESSED', {
          incidentType: 'controlled_recovery_request_suppressed',
          reason: String(detail?.reason || 'chunk_error'),
          detail,
        });
      } catch {}
      try { emitSimpleIncident('controlled_recovery_request_suppressed', detail); } catch {}
    };

    try { window.addEventListener('tepiha:lazy-import-failure', onLazyImportFailure); } catch {}
    try { window.addEventListener('error', onWindowError, true); } catch {}
    try { window.addEventListener('unhandledrejection', onUnhandledRejection, true); } catch {}
    try { window.addEventListener(CONTROLLED_RECOVERY_EVENT, onRecoveryRequest, true); } catch {}

    return () => {
      try { window.removeEventListener('tepiha:lazy-import-failure', onLazyImportFailure); } catch {}
      try { window.removeEventListener('error', onWindowError, true); } catch {}
      try { window.removeEventListener('unhandledrejection', onUnhandledRejection, true); } catch {}
      try { window.removeEventListener(CONTROLLED_RECOVERY_EVENT, onRecoveryRequest, true); } catch {}
    };
  }, []);

  return null;
}
