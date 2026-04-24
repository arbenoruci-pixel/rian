'use client';

import { useEffect, useRef } from 'react';
import { bootLog } from '@/lib/bootLog';
import { readRuntimeTransition, sealRootResumePanicSnapshot } from '@/lib/rootResumePanic';
import { recordDomPreHealSnapshot, recordPersistentTimelineEvent } from '@/lib/lazyImportRuntime';

const AUTH_RESUME_EVENT_LOG_KEY = 'tepiha_auth_resume_event_log_v1';

const WATCHED_PATHS = new Set([
  '/',
  '/login',
  '/diag-raw',
  '/diag-lite',
  '/debug-lite',
  '/debug',
  '/pranimi',
  '/pastrimi',
  '/gati',
  '/marrje-sot',
  '/arka',
  '/transport',
  '/transport/login',
  '/transport/board',
  '/transport/pranimi',
  '/dispatch',
]);

const SOFT_RECOVER_DELAY_MS = 140;
const RESUME_STALL_CHECK_MS = 3400;
const DUPLICATE_WINDOW_MS = 1200;
const HEALTHY_LOG_WINDOW_MS = 300;

const SOFT_ONLY_PATHS = new Set([
  '/diag-raw',
  '/radar',
  '/runtime',
  '/diag-lite',
  '/debug-lite',
  '/debug',
  '/debug/boot',
  '/debug/sync',
]);

function isSoftOnlyPath(path = '') {
  const value = String(path || '/');
  return SOFT_ONLY_PATHS.has(value) || value.startsWith('/debug/');
}

function isBrowser() {
  return typeof window !== 'undefined';
}

function noteHiddenAt(ts = Date.now()) {
  if (!isBrowser()) return 0;
  const hiddenAt = Number(ts || Date.now()) || Date.now();
  try { window.__tepihaLastHiddenAt = hiddenAt; } catch {}
  try { window.localStorage?.setItem('tepiha_last_hidden_at_v3', String(hiddenAt)); } catch {}
  try {
    const key = '__TEPIHA_RESUME_GATE_V3__';
    if (!window[key] || typeof window[key] !== 'object') {
      window[key] = {
        claims: {},
        globalClaim: { token: '', at: 0, source: '', scope: '' },
        globalOwnerScope: String(window.__TEPIHA_RESUME_OWNER_SCOPE__ || 'sw_recovery_owner'),
        lastHiddenAt: hiddenAt,
        lastAcceptedAt: 0,
        lastAcceptedSource: '',
      };
    }
    window[key].lastHiddenAt = hiddenAt;
  } catch {}
  return hiddenAt;
}

function currentPath() {
  if (!isBrowser()) return '/';
  try { return String(window.location?.pathname || '/'); } catch { return '/'; }
}

function currentSearch() {
  if (!isBrowser()) return '';
  try { return String(window.location?.search || ''); } catch { return ''; }
}

function readHiddenAt() {
  if (!isBrowser()) return 0;
  let ts = 0;
  try { ts = Number(window.__tepihaLastHiddenAt || 0) || 0; } catch {}
  if (!ts) {
    try { ts = Number(window.localStorage?.getItem('tepiha_last_hidden_at_v3') || 0) || 0; } catch {}
  }
  return ts;
}

function buildResumeToken() {
  const hiddenAt = readHiddenAt();
  if (hiddenAt) return `hidden:${hiddenAt}`;
  return `burst:${Math.floor(Date.now() / 900)}`;
}

function forceRootVisible(reason = 'root_resume_watchdog') {
  if (typeof document === 'undefined') return false;
  try {
    recordDomPreHealSnapshot(reason, {
      path: currentPath(),
      source: 'watchdog',
      sourceLayer: 'root_resume_watchdog',
    });
  } catch {}
  let changed = false;
  const touch = (node, isRoot = false) => {
    if (!node || !node.style) return;
    try {
      const cs = window.getComputedStyle ? window.getComputedStyle(node) : null;
      const display = String(cs?.display || '').toLowerCase();
      const visibility = String(cs?.visibility || '').toLowerCase();
      const opacity = Number.parseFloat(String(cs?.opacity ?? '1'));
      const pointerEvents = String(cs?.pointerEvents || '').toLowerCase();
      if (isRoot && display === 'none') {
        node.style.display = 'block';
        changed = true;
      }
      if (visibility === 'hidden') {
        node.style.visibility = 'visible';
        changed = true;
      }
      if (Number.isFinite(opacity) && opacity < 0.05) {
        node.style.opacity = '1';
        changed = true;
      }
      if (pointerEvents === 'none') {
        node.style.pointerEvents = 'auto';
        changed = true;
      }
      if (node.hasAttribute && node.hasAttribute('hidden')) {
        node.removeAttribute('hidden');
        changed = true;
      }
      if ('inert' in node && node.inert) {
        node.inert = false;
        changed = true;
      }
      try { node.removeAttribute?.('aria-hidden'); } catch {}
    } catch {}
  };

  try { touch(document.documentElement, true); } catch {}
  try { touch(document.body, true); } catch {}
  try { touch(document.getElementById('root'), true); } catch {}
  try {
    const first = document.body?.firstElementChild || null;
    if (first) touch(first, false);
  } catch {}
  try {
    if (changed) {
      document.documentElement?.setAttribute?.('data-root-resume-recovered', String(reason || '1'));
      document.body?.setAttribute?.('data-root-resume-recovered', String(reason || '1'));
    }
  } catch {}
  return changed;
}

function hasVisibleLocalShell() {
  if (typeof document === 'undefined') return false;
  try {
    return !!document.querySelector?.([
      '[data-safe-route-shell="1"]',
      '[data-local-error-boundary="1"]',
      '[data-route-fallback="1"]',
      '[data-home-shell-ready="1"]',
      '[data-ui-ready="1"]',
    ].join(','));
  } catch {
    return false;
  }
}

function isRootActuallyVisible() {
  if (typeof document === 'undefined') return false;
  const target = document.getElementById('root') || document.body || document.documentElement;
  if (!target) return false;
  try {
    const cs = window.getComputedStyle ? window.getComputedStyle(target) : null;
    const display = String(cs?.display || '').toLowerCase();
    const visibility = String(cs?.visibility || '').toLowerCase();
    const opacity = Number.parseFloat(String(cs?.opacity ?? '1'));
    const hiddenAttr = !!target.hasAttribute?.('hidden');
    const inert = !!target.inert;
    return display !== 'none' && visibility !== 'hidden' && !hiddenAttr && !inert && !(Number.isFinite(opacity) && opacity < 0.05);
  } catch {
    return true;
  }
}

function readSnapshot(storageKey, globalKey) {
  if (!isBrowser()) return null;
  try {
    const live = window[globalKey];
    if (live && typeof live === 'object') return live;
  } catch {}
  try {
    const raw = window.sessionStorage?.getItem(storageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function readRouteAliveSnapshot() {
  return readSnapshot('tepiha_route_alive_v1', '__TEPIHA_ROUTE_ALIVE__');
}

function readRouteUiAliveSnapshot() {
  return readSnapshot('tepiha_route_ui_alive_v1', '__TEPIHA_ROUTE_UI_ALIVE__');
}

function persistRouteUiAlive(detail = {}, fallbackPath = '') {
  if (!isBrowser()) return null;
  const path = String(detail?.path || detail?.page || fallbackPath || currentPath() || '/');
  const payload = {
    ...(detail && typeof detail === 'object' ? detail : {}),
    path,
    label: String(detail?.label || detail?.source || detail?.reason || detail?.stage || 'ui_alive'),
    at: Number(detail?.at || Date.now()) || Date.now(),
  };
  try { window.__TEPIHA_ROUTE_UI_ALIVE__ = payload; } catch {}
  try { window.__TEPIHA_ROUTE_UI_ALIVE_PATH__ = path; } catch {}
  try { window.__TEPIHA_ROUTE_UI_ALIVE_AT__ = payload.at; } catch {}
  try { window.sessionStorage?.setItem('tepiha_route_ui_alive_v1', JSON.stringify(payload)); } catch {}
  try { document?.documentElement?.setAttribute?.('data-route-ui-alive-path', path); } catch {}
  try { document?.body?.setAttribute?.('data-route-ui-alive-path', path); } catch {}
  try { document?.documentElement?.setAttribute?.('data-ui-alive', '1'); } catch {}
  try { document?.body?.setAttribute?.('data-ui-alive', '1'); } catch {}
  return payload;
}

function readUiReady() {
  if (typeof document === 'undefined') return false;
  try {
    if (window.__TEPIHA_UI_READY === true) return true;
  } catch {}
  try {
    if (document.documentElement?.getAttribute?.('data-ui-ready') === '1') return true;
  } catch {}
  try {
    if (document.body?.getAttribute?.('data-ui-ready') === '1') return true;
  } catch {}
  return false;
}

function readHomeShellSnapshot() {
  if (!isBrowser()) return null;
  let path = '/';
  try { path = String(window.__TEPIHA_HOME_SHELL_READY_PATH__ || '/'); } catch {}
  const at = (() => {
    try { return Number(window.__TEPIHA_HOME_SHELL_READY_AT__ || 0) || 0; } catch { return 0; }
  })();
  const resumeToken = (() => {
    try { return Number(window.__TEPIHA_HOME_SHELL_READY_TOKEN__ || 0) || 0; } catch { return 0; }
  })();
  const ready = (() => {
    try {
      return window.__TEPIHA_HOME_SHELL_READY__ === true
        || document.documentElement?.getAttribute?.('data-home-shell-ready') === '1'
        || document.body?.getAttribute?.('data-home-shell-ready') === '1';
    } catch {
      return false;
    }
  })();
  return { path, at, resumeToken, ready };
}


function logRootResumeEvent(type, payload = {}) {
  const path = String(payload?.path || currentPath() || '/');
  const transition = readRuntimeTransition();
  return recordPersistentTimelineEvent(AUTH_RESUME_EVENT_LOG_KEY, type, {
    currentPath: path,
    path,
    previousPath: String(payload?.previousPath || transition?.fromPath || ''),
    bootId: (() => {
      try {
        return String(window.BOOT_ID || window.sessionStorage?.getItem('tepiha_boot_current_id') || window.localStorage?.getItem('tepiha_boot_current_id') || '');
      } catch {
        return '';
      }
    })(),
    visibilityState: (() => {
      try { return String(document.visibilityState || ''); } catch { return ''; }
    })(),
    hidden: (() => {
      try { return !!document.hidden; } catch { return false; }
    })(),
    sourceLayer: 'root_resume_watchdog',
    routeTransitionToken: String(payload?.routeTransitionToken || (transition?.at ? `${transition.at}:${transition?.toPath || ''}` : '') || ''),
    transitionInFlight: typeof payload?.transitionInFlight === 'boolean'
      ? payload.transitionInFlight
      : !!(transition?.toPath && transition.toPath !== path),
    routeTransition: payload?.routeTransition || transition,
    ...payload,
  }, 100);
}

function evaluateHealth({ path, resumeAt, uiToken }) {
  const routeAlive = readRouteAliveSnapshot();
  const routeUiAlive = readRouteUiAliveSnapshot();
  const homeShell = readHomeShellSnapshot();
  const now = Date.now();

  const routeAlivePath = String(routeAlive?.path || '');
  const routeAliveLabel = String(routeAlive?.label || '');
  const routeAliveAt = Number(routeAlive?.at || 0) || 0;
  const routeAliveAgeMs = routeAliveAt ? Math.max(0, now - routeAliveAt) : -1;
  const routeAliveFresh = !!(routeAlivePath === path && routeAliveAgeMs >= 0 && routeAliveAgeMs <= RESUME_STALL_CHECK_MS);

  const uiAlivePath = String(routeUiAlive?.path || '');
  const uiAliveLabel = String(routeUiAlive?.label || '');
  const uiAliveAt = Number(routeUiAlive?.at || 0) || 0;
  const uiAliveAgeMs = uiAliveAt ? Math.max(0, now - uiAliveAt) : -1;
  const uiAliveResumeToken = Number(routeUiAlive?.resumeToken || routeUiAlive?.token || 0) || 0;
  const uiAliveFreshBase = !!(uiAlivePath === path && uiAliveAgeMs >= 0 && uiAliveAgeMs <= RESUME_STALL_CHECK_MS);
  const uiAliveFresh = uiAliveFreshBase && (!uiToken || !uiAliveResumeToken || uiAliveResumeToken === uiToken || uiAliveAt >= resumeAt);

  const homeShellPath = String(homeShell?.path || '/');
  const homeShellAt = Number(homeShell?.at || 0) || 0;
  const homeShellAgeMs = homeShellAt ? Math.max(0, now - homeShellAt) : -1;
  const homeShellResumeToken = Number(homeShell?.resumeToken || 0) || 0;
  const homeShellFresh = !!(
    path === '/'
    && homeShell?.ready
    && homeShellPath === path
    && homeShellAgeMs >= 0
    && homeShellAgeMs <= RESUME_STALL_CHECK_MS
    && (!uiToken || !homeShellResumeToken || homeShellResumeToken === uiToken || homeShellAt >= resumeAt)
  );

  const uiReady = readUiReady();
  const rootVisible = isRootActuallyVisible();
  const softOnlyPath = isSoftOnlyPath(path);
  const visibleLocalShell = hasVisibleLocalShell();
  const foreignRouteFresh = !!(
    routeAlivePath
    && routeAlivePath !== path
    && routeAliveAgeMs >= 0
    && routeAliveAgeMs <= RESUME_STALL_CHECK_MS
  );
  const foreignUiFresh = !!(
    uiAlivePath
    && uiAlivePath !== path
    && uiAliveAgeMs >= 0
    && uiAliveAgeMs <= RESUME_STALL_CHECK_MS
  );
  const routeTransitionInFlight = foreignRouteFresh || foreignUiFresh;

  const samePathAliveStaleOk = !!(
    uiReady
    && path !== '/'
    && uiAlivePath === path
    && uiAliveAgeMs > RESUME_STALL_CHECK_MS
    && routeAlivePath === path
    && routeAliveAgeMs >= 0
    && routeAliveAgeMs <= RESUME_STALL_CHECK_MS
  );
  const samePathHomeStaleOk = !!(
    uiReady
    && path === '/'
    && ((uiAlivePath === path && uiAliveAgeMs > RESUME_STALL_CHECK_MS) || (homeShell?.ready && homeShellPath === path && homeShellAgeMs > RESUME_STALL_CHECK_MS))
    && routeAlivePath === path
    && routeAliveAgeMs >= 0
    && routeAliveAgeMs <= RESUME_STALL_CHECK_MS
  );

  const nonHomeRouteReady = !!(path !== '/' && uiReady && (uiAliveFresh || routeAliveFresh || samePathAliveStaleOk));
  const homeRouteReady = !!(path === '/' && uiReady && (uiAliveFresh || homeShellFresh || routeAliveFresh || samePathHomeStaleOk));
  const staleButVisibleOk = !!(rootVisible && uiReady && (visibleLocalShell || routeAlivePath === path || uiAlivePath === path || (path === '/' && homeShell?.ready)));
  const softOnlyVisibleOk = !!(rootVisible && softOnlyPath && (uiReady || visibleLocalShell));
  const healthy = !!(rootVisible && (homeRouteReady || nonHomeRouteReady || routeTransitionInFlight || staleButVisibleOk || softOnlyVisibleOk));

  return {
    healthy,
    rootVisible,
    uiReady,
    routeAlivePath,
    routeAliveLabel,
    routeAliveAgeMs,
    routeAliveFresh,
    uiAlivePath,
    uiAliveLabel,
    uiAliveAgeMs,
    uiAliveFresh,
    uiAliveResumeToken,
    homeShellAgeMs,
    homeShellFresh,
    homeShellResumeToken,
    samePathAliveStaleOk,
    samePathHomeStaleOk,
    routeTransitionInFlight,
    softOnlyPath,
    visibleLocalShell,
    staleButVisibleOk,
    softOnlyVisibleOk,
  };
}

export default function RootResumeWatchdog() {
  const timersRef = useRef([]);
  const activeRef = useRef({ seq: 0, token: '', path: '', reason: '', startedAt: 0, uiToken: 0 });
  const lastAcceptedRef = useRef({ token: '', at: 0 });
  const lastHealthyRef = useRef({ token: '', at: 0 });

  useEffect(() => {
    if (!isBrowser()) return undefined;

    const clearTimers = () => {
      const timers = Array.isArray(timersRef.current) ? timersRef.current : [];
      timers.forEach((timer) => {
        try { window.clearTimeout(timer); } catch {}
      });
      timersRef.current = [];
    };

    const onHidden = (reason) => {
      const ts = noteHiddenAt(Date.now());
      clearTimers();
      logRootResumeEvent('root_resume_pagehide', {
        path: currentPath(),
        reason,
        hiddenAt: ts,
        listenerReason: reason,
      });
      bootLog('root_hidden_mark', {
        path: currentPath(),
        search: currentSearch(),
        reason,
        hiddenAt: ts,
      });
    };

    const scheduleResumeCheck = (reason, extra = {}) => {
      let visible = true;
      try { visible = document.visibilityState === 'visible'; } catch {}
      if (!visible) return;

      const path = currentPath();
      const token = buildResumeToken();
      const now = Date.now();
      if (
        token
        && token === String(lastAcceptedRef.current?.token || '')
        && Math.max(0, now - Number(lastAcceptedRef.current?.at || 0)) < DUPLICATE_WINDOW_MS
      ) {
        return;
      }

      const uiToken = now;
      lastAcceptedRef.current = { token, at: now };
      activeRef.current = { seq: now, token, path, reason: String(reason || ''), startedAt: now, uiToken };
      clearTimers();

      const hiddenAt = readHiddenAt();
      const hiddenElapsedMs = hiddenAt ? Math.max(0, now - hiddenAt) : 0;
      const watchedPath = WATCHED_PATHS.has(path);

      try {
        window.__TEPIHA_ROOT_RESUME_ACTIVE__ = {
          path,
          token,
          reason: String(reason || ''),
          at: now,
          uiToken,
        };
      } catch {}

      forceRootVisible(`resume_${reason}`);
      logRootResumeEvent('root_resume_watchdog_start', {
        path,
        reason,
        hiddenElapsedMs,
        token,
        uiToken,
        watchedPath,
        listenerReason: String(reason || ''),
        ...(extra || {}),
      });
      bootLog('root_resume_watchdog_start', {
        path,
        search: currentSearch(),
        reason,
        token,
        uiToken,
        watchedPath,
        hiddenElapsedMs,
        ...(extra || {}),
      });

      try {
        window.dispatchEvent(new CustomEvent('tepiha:root-resume', {
          detail: {
            at: now,
            seq: now,
            token,
            uiToken,
            path,
            reason: String(reason || ''),
            hiddenElapsedMs,
            ...(extra || {}),
          },
        }));
      } catch {}

      timersRef.current.push(window.setTimeout(() => {
        if (activeRef.current.seq !== now) return;
        forceRootVisible(`resume_${reason}_soft`);
      }, SOFT_RECOVER_DELAY_MS));

      if (!watchedPath) return;

      timersRef.current.push(window.setTimeout(() => {
        if (activeRef.current.seq !== now) return;
        let stillVisible = true;
        try { stillVisible = document.visibilityState === 'visible'; } catch {}
        if (!stillVisible) return;

        const health = evaluateHealth({ path, resumeAt: now, uiToken });
        if (health.healthy) {
          const lastHealthyToken = String(lastHealthyRef.current?.token || '');
          const lastHealthyAt = Number(lastHealthyRef.current?.at || 0) || 0;
          if (lastHealthyToken !== token || Math.max(0, Date.now() - lastHealthyAt) > HEALTHY_LOG_WINDOW_MS) {
            lastHealthyRef.current = { token, at: Date.now() };
            bootLog('root_resume_watchdog_healthy', {
              path,
              search: currentSearch(),
              reason,
              token,
              uiToken,
              hiddenElapsedMs,
              ...health,
              ...(extra || {}),
            });
          }
          return;
        }

        forceRootVisible(`resume_${reason}_stall`);
        const routeTransition = readRuntimeTransition();
        const sealedSnapshot = sealRootResumePanicSnapshot({
          reason: 'root_resume_watchdog_stall',
          path,
          search: currentSearch(),
          token,
          hiddenToken: token,
          currentBootId: String(window.BOOT_ID || ''),
          previousPath: String(routeTransition?.fromPath || ''),
          previousBootId: String(routeTransition?.fromBootId || ''),
          routeTransitionInFlight: !!health?.routeTransitionInFlight,
          routeTransition,
          health: {
            ...health,
            hiddenElapsedMs,
            reason: String(reason || ''),
            uiToken,
          },
          online: typeof navigator !== 'undefined' ? navigator.onLine : null,
          visibilityState: (() => {
            try { return String(document.visibilityState || ''); } catch { return ''; }
          })(),
        });
        bootLog('boot_timeout_resume_visible_no_ui', {
          path,
          search: currentSearch(),
          reason,
          token,
          uiToken,
          hiddenElapsedMs,
          panicSnapshotSaved: !!sealedSnapshot,
          ...health,
          ...(extra || {}),
        });

        try {
          window.dispatchEvent(new CustomEvent('tepiha:root-resume-stall', {
            detail: {
              at: Date.now(),
              path,
              reason: String(reason || ''),
              token,
              uiToken,
              hiddenElapsedMs,
              panicSnapshotSaved: !!sealedSnapshot,
              ...health,
            },
          }));
        } catch {}
      }, RESUME_STALL_CHECK_MS));
    };

    const onFirstUiReady = (event) => {
      try {
        persistRouteUiAlive(event?.detail && typeof event.detail === 'object' ? event.detail : {}, currentPath());
      } catch {}
    };

    const onRouteUiAlive = (event) => {
      try {
        persistRouteUiAlive(event?.detail && typeof event.detail === 'object' ? event.detail : {}, currentPath());
      } catch {}
    };

    const onVisibility = () => {
      let visibilityState = '';
      try { visibilityState = String(document.visibilityState || ''); } catch {}
      logRootResumeEvent('root_resume_visibility', {
        path: currentPath(),
        reason: visibilityState === 'hidden' ? 'visibility_hidden' : 'visibility_visible',
        listenerReason: 'visibilitychange',
        visibilityState,
      });
      try {
        if (document.visibilityState === 'hidden') {
          onHidden('visibility_hidden');
          return;
        }
      } catch {}
      scheduleResumeCheck('visibility_visible');
    };

    const onPageHide = () => onHidden('pagehide');
    const onPageShow = (event) => {
      logRootResumeEvent('root_resume_pageshow', {
        path: currentPath(),
        reason: 'pageshow',
        listenerReason: 'pageshow',
        persisted: !!event?.persisted,
      });
      scheduleResumeCheck('pageshow', { persisted: !!event?.persisted });
    };
    const onFocus = () => {
      logRootResumeEvent('root_resume_focus', {
        path: currentPath(),
        reason: 'focus',
        listenerReason: 'focus',
      });
      scheduleResumeCheck('focus');
    };

    window.addEventListener('pagehide', onPageHide, { passive: true });
    window.addEventListener('pageshow', onPageShow, { passive: true });
    window.addEventListener('focus', onFocus, { passive: true });
    window.addEventListener('tepiha:first-ui-ready', onFirstUiReady, { passive: true });
    window.addEventListener('tepiha:route-ui-alive', onRouteUiAlive, { passive: true });
    document.addEventListener('visibilitychange', onVisibility, { passive: true });

    return () => {
      clearTimers();
      try { window.removeEventListener('pagehide', onPageHide); } catch {}
      try { window.removeEventListener('pageshow', onPageShow); } catch {}
      try { window.removeEventListener('focus', onFocus); } catch {}
      try { window.removeEventListener('tepiha:first-ui-ready', onFirstUiReady); } catch {}
      try { window.removeEventListener('tepiha:route-ui-alive', onRouteUiAlive); } catch {}
      try { document.removeEventListener('visibilitychange', onVisibility); } catch {}
    };
  }, []);

  return null;
}
