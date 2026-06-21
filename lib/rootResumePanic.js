'use client';

import {
  bootReadHistory,
  bootReadInProgress,
  bootReadLastInterrupted,
  bootReadLastSuccess,
} from '@/lib/bootLog';

export const ROOT_RESUME_PANIC_LOCAL_KEY = 'tepiha_root_resume_panic_v1';
export const ROOT_RESUME_PANIC_SESSION_KEY = 'tepiha_root_resume_panic_session_v1';
export const ROUTE_TRANSITION_KEY = 'tepiha_route_transition_v1';
export const AUTHGATE_TRACE_LOCAL_KEY = 'tepiha_authgate_trace_v1';
export const AUTHGATE_TRACE_SESSION_KEY = 'tepiha_authgate_trace_session_v1';

function isBrowser() {
  return typeof window !== 'undefined';
}

function safeClone(value, fallback = null) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return fallback;
  }
}

function safeParse(raw, fallback = null) {
  try {
    const parsed = JSON.parse(raw);
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function readJson(storage, key, fallback = null) {
  try {
    if (!storage) return fallback;
    const raw = storage.getItem(key);
    if (!raw) return fallback;
    return safeParse(raw, fallback);
  } catch {
    return fallback;
  }
}

function writeJson(storage, key, value) {
  try {
    if (!storage) return;
    if (value == null) storage.removeItem(key);
    else storage.setItem(key, JSON.stringify(value));
  } catch {}
}

function currentPath() {
  if (!isBrowser()) return '/';
  try { return String(window.location?.pathname || '/'); } catch { return '/'; }
}

function currentSearch() {
  if (!isBrowser()) return '';
  try { return String(window.location?.search || ''); } catch { return ''; }
}

function currentVisibility() {
  if (!isBrowser()) return '';
  try { return String(document.visibilityState || ''); } catch { return ''; }
}

function currentOnline() {
  if (!isBrowser()) return null;
  try { return navigator.onLine; } catch { return null; }
}

function readBootIdFromStorage() {
  if (!isBrowser()) return '';
  try {
    return String(
      window.sessionStorage?.getItem('tepiha_boot_current_id')
      || window.localStorage?.getItem('tepiha_boot_current_id')
      || window.BOOT_ID
      || ''
    );
  } catch {
    return '';
  }
}

function readSnapshot(storageKey, globalKey) {
  if (!isBrowser()) return null;
  try {
    const live = window[globalKey];
    if (live && typeof live === 'object') return safeClone(live, null);
  } catch {}
  return readJson(window.sessionStorage, storageKey, null);
}

export function readRuntimeTransition() {
  if (!isBrowser()) return null;
  try {
    const live = window.__TEPIHA_ROUTE_TRANSITION__;
    if (live && typeof live === 'object') return safeClone(live, null);
  } catch {}
  const session = readJson(window.sessionStorage, ROUTE_TRANSITION_KEY, null);
  if (session) return session;
  return readJson(window.localStorage, ROUTE_TRANSITION_KEY, null);
}

export function writeRuntimeTransition(detail = {}) {
  if (!isBrowser()) return null;
  const now = Date.now();
  const existing = readRuntimeTransition();
  const payload = {
    fromPath: String(detail?.fromPath || existing?.fromPath || currentPath() || '/'),
    toPath: String(detail?.toPath || currentPath() || '/'),
    at: Number(detail?.at || now) || now,
    reason: String(detail?.reason || 'path_change'),
    fromBootId: String(detail?.fromBootId || readBootIdFromStorage() || ''),
    toBootId: String(detail?.toBootId || readBootIdFromStorage() || ''),
  };
  try { window.__TEPIHA_ROUTE_TRANSITION__ = payload; } catch {}
  writeJson(window.sessionStorage, ROUTE_TRANSITION_KEY, payload);
  writeJson(window.localStorage, ROUTE_TRANSITION_KEY, payload);
  return payload;
}

export function clearRuntimeTransition(detail = {}) {
  if (!isBrowser()) return null;
  const existing = readRuntimeTransition();
  const payload = {
    cleared: true,
    at: Number(detail?.at || Date.now()) || Date.now(),
    clearedAt: new Date(Number(detail?.at || Date.now()) || Date.now()).toISOString(),
    reason: String(detail?.reason || 'route_ui_ready'),
    fromPath: String(detail?.fromPath || existing?.fromPath || ''),
    toPath: String(detail?.toPath || detail?.path || existing?.toPath || currentPath() || '/'),
    fromBootId: String(detail?.fromBootId || existing?.fromBootId || ''),
    toBootId: String(detail?.toBootId || existing?.toBootId || readBootIdFromStorage() || ''),
  };
  try { window.__TEPIHA_ROUTE_TRANSITION__ = null; } catch {}
  writeJson(window.sessionStorage, ROUTE_TRANSITION_KEY, null);
  writeJson(window.localStorage, ROUTE_TRANSITION_KEY, null);
  try { window.__TEPIHA_LAST_CLEARED_ROUTE_TRANSITION__ = payload; } catch {}
  return payload;
}

export function writeAuthGateTrace(detail = {}) {
  if (!isBrowser()) return null;
  const now = Date.now();
  const prev = readAuthGateTrace();
  const payload = {
    ...(prev && typeof prev === 'object' ? prev : {}),
    path: String(detail?.path || currentPath() || '/'),
    at: Number(detail?.at || now) || now,
    reason: String(detail?.reason || prev?.reason || ''),
    phase: String(detail?.phase || prev?.phase || ''),
    scheduleReason: detail?.scheduleReason != null ? String(detail.scheduleReason || '') : String(prev?.scheduleReason || ''),
    evalReason: detail?.evalReason != null ? String(detail.evalReason || '') : String(prev?.evalReason || ''),
    listenerReason: detail?.listenerReason != null ? String(detail.listenerReason || '') : String(prev?.listenerReason || ''),
    source: detail?.source != null ? String(detail.source || '') : String(prev?.source || ''),
    hidden: typeof detail?.hidden === 'boolean' ? detail.hidden : !!prev?.hidden,
    isPublic: typeof detail?.isPublic === 'boolean' ? detail.isPublic : !!prev?.isPublic,
    isOffline: typeof detail?.isOffline === 'boolean' ? detail.isOffline : !!prev?.isOffline,
    localHasAuth: typeof detail?.localHasAuth === 'boolean' ? detail.localHasAuth : !!prev?.localHasAuth,
    localApprovalOk: typeof detail?.localApprovalOk === 'boolean' ? detail.localApprovalOk : !!prev?.localApprovalOk,
    shouldOpenImmediately: typeof detail?.shouldOpenImmediately === 'boolean' ? detail.shouldOpenImmediately : !!prev?.shouldOpenImmediately,
    redirecting: typeof detail?.redirecting === 'boolean' ? detail.redirecting : !!prev?.redirecting,
    suppressed: typeof detail?.suppressed === 'boolean' ? detail.suppressed : !!prev?.suppressed,
    suppressionReason: detail?.suppressionReason != null ? String(detail.suppressionReason || '') : String(prev?.suppressionReason || ''),
    routeTransition: detail?.routeTransition ? safeClone(detail.routeTransition, null) : (prev?.routeTransition || null),
    extra: detail?.extra ? safeClone(detail.extra, {}) : (prev?.extra || {}),
  };
  try { window.__TEPIHA_AUTHGATE_TRACE__ = payload; } catch {}
  writeJson(window.sessionStorage, AUTHGATE_TRACE_SESSION_KEY, payload);
  writeJson(window.localStorage, AUTHGATE_TRACE_LOCAL_KEY, payload);
  return payload;
}

export function readAuthGateTrace() {
  if (!isBrowser()) return null;
  try {
    const live = window.__TEPIHA_AUTHGATE_TRACE__;
    if (live && typeof live === 'object') return safeClone(live, null);
  } catch {}
  const session = readJson(window.sessionStorage, AUTHGATE_TRACE_SESSION_KEY, null);
  if (session) return session;
  return readJson(window.localStorage, AUTHGATE_TRACE_LOCAL_KEY, null);
}

export function readRootResumePanicSnapshot() {
  if (!isBrowser()) return null;
  try {
    const live = window.__TEPIHA_ROOT_RESUME_PANIC__;
    if (live && typeof live === 'object') return safeClone(live, null);
  } catch {}
  const session = readJson(window.sessionStorage, ROOT_RESUME_PANIC_SESSION_KEY, null);
  if (session) return session;
  return readJson(window.localStorage, ROOT_RESUME_PANIC_LOCAL_KEY, null);
}

function collectRecentEvents(limit = 50) {
  const items = [];
  const push = (event, source = '') => {
    if (!event) return;
    const row = {
      source: String(source || ''),
      type: String(event?.type || source || 'event'),
      at: event?.at || event?.created_at || null,
      data: safeClone(event?.data ?? event?.meta ?? event, {}),
    };
    items.push(row);
  };

  try {
    const inProgress = bootReadInProgress();
    const liveEvents = Array.isArray(inProgress?.events) ? inProgress.events : [];
    liveEvents.forEach((event) => push(event, 'in_progress'));
  } catch {}

  try {
    const lastInterrupted = bootReadLastInterrupted();
    const interruptedEvents = Array.isArray(lastInterrupted?.events) ? lastInterrupted.events : [];
    interruptedEvents.forEach((event) => push(event, 'last_interrupted'));
  } catch {}

  try {
    const lastSuccess = bootReadLastSuccess();
    const successEvents = Array.isArray(lastSuccess?.events) ? lastSuccess.events : [];
    successEvents.forEach((event) => push(event, 'last_success'));
  } catch {}

  try {
    const history = bootReadHistory();
    const firstHistoryEvents = Array.isArray(history?.[0]?.events) ? history[0].events : [];
    firstHistoryEvents.forEach((event) => push(event, 'history_latest'));
  } catch {}

  try {
    const fallbackLogs = readJson(window.localStorage, 'tepiha_diag_fallback_logs_v2', []);
    (Array.isArray(fallbackLogs) ? fallbackLogs : []).slice(0, 12).forEach((entry) => push(entry, 'fallback_log'));
  } catch {}

  items.sort((a, b) => {
    const ta = Date.parse(String(a?.at || '')) || 0;
    const tb = Date.parse(String(b?.at || '')) || 0;
    return tb - ta;
  });

  return items.slice(0, Math.max(1, Number(limit) || 50));
}

export function sealRootResumePanicSnapshot(detail = {}) {
  if (!isBrowser()) return null;
  const now = Date.now();
  const inProgress = (() => {
    try { return bootReadInProgress(); } catch { return null; }
  })();
  const lastSuccess = (() => {
    try { return bootReadLastSuccess(); } catch { return null; }
  })();
  const lastInterrupted = (() => {
    try { return bootReadLastInterrupted(); } catch { return null; }
  })();
  const transition = detail?.routeTransition ? safeClone(detail.routeTransition, null) : readRuntimeTransition();
  const authTrace = readAuthGateTrace();
  const routeAlive = readSnapshot('tepiha_route_alive_v1', '__TEPIHA_ROUTE_ALIVE__');
  const routeUiAlive = readSnapshot('tepiha_route_ui_alive_v1', '__TEPIHA_ROUTE_UI_ALIVE__');
  const path = String(detail?.path || currentPath() || '/');
  const snapshot = {
    version: 1,
    at: new Date(now).toISOString(),
    ts: now,
    reason: String(detail?.reason || 'root_resume_watchdog_stall'),
    path,
    search: String(detail?.search || currentSearch() || ''),
    previousPath: String(detail?.previousPath || transition?.fromPath || lastSuccess?.currentPath || lastInterrupted?.currentPath || ''),
    currentBootId: String(detail?.currentBootId || inProgress?.bootId || readBootIdFromStorage() || ''),
    previousBootId: String(detail?.previousBootId || transition?.fromBootId || lastSuccess?.bootId || lastInterrupted?.bootId || ''),
    hiddenToken: String(detail?.hiddenToken || detail?.token || ''),
    visibilityState: String(detail?.visibilityState || currentVisibility() || ''),
    online: typeof detail?.online === 'boolean' ? detail.online : currentOnline(),
    routeTransitionInFlight: typeof detail?.routeTransitionInFlight === 'boolean'
      ? detail.routeTransitionInFlight
      : !!(transition && String(transition?.toPath || '') === path && Math.max(0, now - Number(transition?.at || 0)) <= 1600),
    routeTransition: transition,
    routeAlive,
    routeUiAlive,
    health: detail?.health ? safeClone(detail.health, null) : null,
    auth: authTrace,
    appEpoch: (() => {
      try { return String(window.__TEPIHA_APP_EPOCH || ''); } catch { return ''; }
    })(),
    swEpoch: (() => {
      try { return String(window.__TEPIHA_APP_EPOCH || ''); } catch { return ''; }
    })(),
    recentEvents: collectRecentEvents(50),
  };

  try { window.__TEPIHA_ROOT_RESUME_PANIC__ = snapshot; } catch {}
  writeJson(window.sessionStorage, ROOT_RESUME_PANIC_SESSION_KEY, snapshot);
  writeJson(window.localStorage, ROOT_RESUME_PANIC_LOCAL_KEY, snapshot);
  return snapshot;
}
