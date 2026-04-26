'use client';

import { useEffect } from 'react';
import { bootLog, bootSnapshot } from '@/lib/bootLog';
import { pushGlobalError, isChunkLoadLikeError } from '@/lib/globalErrors';
import { pushLocalErrorLog } from '@/lib/localErrorLog';
import { getLastChunkCapture, getLastLazyImportFailure, getLastLazyImportAttempt, isProbablyChunkLikeMessage, recordChunkCapture, recordRouteDiagEvent } from '@/lib/lazyImportRuntime';

const CONTROLLED_RECOVERY_EVENT = 'tepiha:sw-controlled-recovery-request';
const APP_DATA_EPOCH = 'RESET-2026-04-26-VITE-PASTRIMI-PRELOAD-NONFATAL-V22';
const APP_VERSION = '2.0.27-vite-pastrimi-preload-nonfatal-v22';
const V22_DIAG_CLEAR_KEY = 'tepiha_diag_clear_epoch_v22';

const OPTIONAL_MODULEPRELOAD_PATTERNS = [
  /(?:^|\/|-)reconcile-[^/]*\.(?:js|mjs)(?:\?|$)/i,
  /(?:^|\/|-)tombstones-[^/]*\.(?:js|mjs)(?:\?|$)/i,
  /(?:^|\/|-)RackLocationModal-[^/]*\.(?:js|mjs)(?:\?|$)/i,
  /(?:^|\/|-)transportOrdersDb-[^/]*\.(?:js|mjs)(?:\?|$)/i,
  /(?:^|\/|-)optional[^/]*\.(?:js|mjs)(?:\?|$)/i,
  /(?:^|\/|-)helper[^/]*\.(?:js|mjs)(?:\?|$)/i,
];

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

function safeString(value) {
  try { return String(value || ''); } catch { return ''; }
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

function safeJson(raw, fallback = null) {
  try {
    const parsed = JSON.parse(raw);
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function normalizePath(path) {
  const p = safeString(path || '/').split('?')[0].replace(/\/+$/, '') || '/';
  return p;
}

function currentPath() {
  try { return normalizePath(window.location?.pathname || '/'); } catch { return '/'; }
}

function isPastrimiOrGatiRoute(path) {
  const p = normalizePath(path);
  return p === '/pastrimi' || p === '/gati';
}

function isModulePreloadLink(meta = {}) {
  return String(meta.tagName || '').toUpperCase() === 'LINK' && String(meta.targetRel || '').toLowerCase() === 'modulepreload';
}

function looksLikeOptionalHelperAsset(value) {
  const text = safeString(value);
  if (!text) return false;
  return OPTIONAL_MODULEPRELOAD_PATTERNS.some((rx) => rx.test(text));
}

function readRouteUiReadyForPath(path) {
  const wanted = normalizePath(path || currentPath());
  try {
    if (window.__TEPIHA_UI_READY === true || window.__TEPIHA_FIRST_UI_READY === true) return true;
  } catch {}
  try {
    const alive = window.__TEPIHA_ROUTE_UI_ALIVE__;
    if (alive && typeof alive === 'object') {
      const p = normalizePath(alive.path || alive.currentPath || '');
      if (p && p === wanted) return true;
    }
  } catch {}
  try {
    const p = normalizePath(window.__TEPIHA_ROUTE_UI_ALIVE_PATH__ || '');
    if (p && p === wanted) return true;
  } catch {}
  try {
    const stored = safeJson(window.sessionStorage?.getItem('tepiha_route_ui_alive_v1') || 'null', null);
    const p = normalizePath(stored?.path || stored?.currentPath || '');
    if (p && p === wanted) return true;
  } catch {}
  try {
    const attrPath = normalizePath(document?.documentElement?.getAttribute?.('data-route-ui-alive-path') || document?.body?.getAttribute?.('data-route-ui-alive-path') || '');
    if (attrPath && attrPath === wanted) return true;
  } catch {}
  try {
    const docReady = document?.documentElement?.getAttribute?.('data-ui-ready') === '1' || document?.body?.getAttribute?.('data-ui-ready') === '1';
    if (docReady) return true;
  } catch {}
  return false;
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
      routePath: currentPath(),
      routeName: 'RUNTIME MODULE LOAD',
      moduleName: String(meta?.requestedModule || meta?.lazyLabel || meta?.moduleName || meta?.incidentType || meta?.sourceLayer || 'ChunkLoadRuntime'),
      componentName: String(meta?.componentName || meta?.lazyLabel || 'ChunkLoadRuntime'),
      sourceLayer: 'chunk_load_runtime',
      ...meta,
    });
  } catch {}
}

function clearRouteDiagModulepreloadOnly() {
  try {
    const key = 'tepiha_route_diag_log_v1';
    const raw = window.localStorage?.getItem(key);
    if (!raw) return false;
    const list = safeJson(raw, []);
    if (!Array.isArray(list)) return false;
    const kept = list.filter((item) => {
      const type = safeString(item?.type || item?.eventType || item?.data?.type || '');
      const sourceLayer = safeString(item?.sourceLayer || item?.data?.sourceLayer || '');
      const incident = safeString(item?.incidentType || item?.data?.incidentType || '');
      const text = `${type} ${sourceLayer} ${incident}`;
      return !/modulepreload|window_module_error|chunk_load_runtime|app_root_runtime|lazy_import_failure/i.test(text);
    });
    window.localStorage.setItem(key, JSON.stringify(kept.slice(0, 80)));
    return kept.length !== list.length;
  } catch {
    return false;
  }
}

function clearOldV8V17DiagnosticMarkersOnce() {
  if (!isBrowser()) return;
  try {
    const previous = safeJson(window.localStorage?.getItem(V22_DIAG_CLEAR_KEY) || 'null', null);
    if (previous?.epoch === APP_DATA_EPOCH) return;
  } catch {}

  const localKeys = [
    'tepiha_chunk_last_capture_v1',
    'tepiha_last_lazy_import_attempt_v1',
    'tepiha_last_lazy_import_failure_v1',
    'tepiha_lazy_import_log_v1',
    'tepiha_app_root_runtime_failure_last_v1',
    'tepiha_app_root_runtime_failure_log_v1',
    'tepiha_runtime_import_failure_last_v1',
    'tepiha_runtime_import_failure_log_v1',
  ];
  const sessionKeys = [
    'tepiha_module_boot_rescue_v1',
  ];
  const cleared = [];
  for (const key of localKeys) {
    try {
      if (window.localStorage?.getItem(key) != null) cleared.push(key);
      window.localStorage?.removeItem(key);
    } catch {}
  }
  for (const key of sessionKeys) {
    try {
      if (window.sessionStorage?.getItem(key) != null) cleared.push(`session:${key}`);
      window.sessionStorage?.removeItem(key);
    } catch {}
  }
  try { if (clearRouteDiagModulepreloadOnly()) cleared.push('tepiha_route_diag_log_v1:modulepreload_only'); } catch {}
  try {
    window.localStorage?.setItem(V22_DIAG_CLEAR_KEY, JSON.stringify({
      epoch: APP_DATA_EPOCH,
      version: APP_VERSION,
      at: new Date().toISOString(),
      cleared,
      scope: 'diagnostic_only_no_orders_outbox_indexeddb',
    }));
  } catch {}
}

function shouldTreatAsNonfatalModulepreload(meta = {}, routePath = currentPath(), routeUiReady = false) {
  if (!isModulePreloadLink(meta)) return false;
  const src = safeString(meta.resolvedTargetSrc || meta.targetSrc || meta.filename || '');
  const routeOk = isPastrimiOrGatiRoute(routePath);
  if (routeOk && looksLikeOptionalHelperAsset(src)) return 'optional_helper_chunk';
  if (routeOk && routeUiReady) return 'route_ui_ready_modulepreload';
  if (routeUiReady && looksLikeOptionalHelperAsset(src)) return 'ui_ready_optional_helper';
  return false;
}

function stopNonfatalWindowError(event) {
  try { event?.stopImmediatePropagation?.(); } catch {}
  try { event?.stopPropagation?.(); } catch {}
  try { event?.preventDefault?.(); } catch {}
}

function diagnosticNonfatalModulepreload(meta = {}) {
  try {
    recordRouteDiagEvent('modulepreload_asset_error_nonfatal', {
      ...meta,
      sourceLayer: 'chunk_load_runtime',
      severity: 'nonfatal_optional_modulepreload',
      noRepair: true,
      noReload: true,
      noRouteFailure: true,
      noUiError: true,
    });
  } catch {}
  try {
    bootLog('nonfatal_optional_modulepreload', {
      ...meta,
      severity: 'nonfatal_optional_modulepreload',
      sourceLayer: 'chunk_load_runtime',
    });
  } catch {}
  try {
    window.__TEPIHA_LAST_NONFATAL_MODULEPRELOAD__ = {
      ...meta,
      at: new Date().toISOString(),
      severity: 'nonfatal_optional_modulepreload',
    };
  } catch {}
}

function shouldSuppressLazyOptionalFailure(detail = {}) {
  const routePath = currentPath();
  const routeUiReady = readRouteUiReadyForPath(routePath);
  if (!isPastrimiOrGatiRoute(routePath) && !routeUiReady) return false;
  const text = [
    detail?.message,
    detail?.error?.message,
    detail?.assetUrl,
    detail?.targetSrc,
    detail?.requestedModule,
    detail?.moduleName,
    detail?.label,
    detail?.lazyLabel,
  ].map(safeString).join(' ');
  if (!looksLikeOptionalHelperAsset(text)) return false;
  return { routePath, routeUiReady, reason: routeUiReady ? 'ui_ready_optional_lazy_failure' : 'optional_lazy_helper_failure' };
}

function shouldSuppressUnhandledOptionalFailure(reason) {
  const routePath = currentPath();
  const routeUiReady = readRouteUiReadyForPath(routePath);
  if (!routeUiReady || !isPastrimiOrGatiRoute(routePath)) return false;
  const lastAttempt = getLastLazyImportAttempt();
  const text = [
    reason?.message,
    reason?.stack,
    lastAttempt?.requestedModule,
    lastAttempt?.label,
    lastAttempt?.importCaller,
  ].map(safeString).join(' ');
  if (!looksLikeOptionalHelperAsset(text)) return false;
  return { routePath, routeUiReady, reason: 'ui_ready_optional_unhandled_failure', lastAttempt };
}

export default function ChunkLoadRuntime() {
  useEffect(() => {
    if (!isBrowser()) return undefined;
    clearOldV8V17DiagnosticMarkersOnce();

    const onLazyImportFailure = (event) => {
      const detail = event?.detail && typeof event.detail === 'object' ? event.detail : null;
      if (!detail) return;
      const optional = shouldSuppressLazyOptionalFailure(detail);
      if (optional) {
        diagnosticNonfatalModulepreload({
          incidentType: 'lazy_import_failure_nonfatal_optional',
          ...optional,
          detail,
          message: safeString(detail?.message || detail?.error?.message || 'LAZY_IMPORT_FAILURE'),
        });
        return;
      }
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
      const routePath = currentPath();
      const previousPath = readPreviousPath();
      const routeUiReady = readRouteUiReadyForPath(routePath);
      const nonfatalReason = shouldTreatAsNonfatalModulepreload({ ...meta, resolvedTargetSrc }, routePath, routeUiReady);
      const baseCapture = {
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
        routeUiReady,
        performanceEntries: readPerformanceEntriesByName(resolvedTargetSrc),
      };
      const capture = recordChunkCapture(nonfatalReason ? 'nonfatal_optional_modulepreload' : 'window_module_error', {
        ...baseCapture,
        severity: nonfatalReason ? 'nonfatal_optional_modulepreload' : 'fatal_candidate',
        nonfatalReason: nonfatalReason || '',
        noRepair: !!nonfatalReason,
        noReload: !!nonfatalReason,
        noRouteFailure: !!nonfatalReason,
        noUiError: !!nonfatalReason,
      });
      const diagMeta = {
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
        routeUiReady,
        severity: nonfatalReason ? 'nonfatal_optional_modulepreload' : 'fatal_candidate',
        nonfatalReason: nonfatalReason || '',
        performanceEntries: readPerformanceEntriesByName(resolvedTargetSrc),
      };
      try {
        recordRouteDiagEvent(nonfatalReason ? 'modulepreload_asset_error_nonfatal' : 'modulepreload_asset_error', diagMeta);
      } catch {}
      if (nonfatalReason) {
        stopNonfatalWindowError(event);
        diagnosticNonfatalModulepreload(capture || diagMeta);
        return;
      }
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
      const optional = shouldSuppressUnhandledOptionalFailure(reason);
      if (optional) {
        try { event?.preventDefault?.(); } catch {}
        const capture = recordChunkCapture('nonfatal_optional_unhandled_rejection', {
          message,
          stack,
          name: String(reason?.name || ''),
          ...optional,
          severity: 'nonfatal_optional_modulepreload',
          sourceLayer: 'chunk_load_runtime',
          noRepair: true,
          noReload: true,
          noRouteFailure: true,
          noUiError: true,
        });
        diagnosticNonfatalModulepreload(capture || optional);
        return;
      }
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
