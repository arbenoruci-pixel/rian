'use client';

import { useEffect, useRef } from 'react';
import { bootLog } from '@/lib/bootLog';
import { noteHiddenAt } from '@/lib/resumeGate';

const WATCHED_PATHS = new Set([
  '/',
  '/login',
  '/pranimi',
  '/pastrimi',
  '/gati',
  '/marrje-sot',
  '/arka',
  '/transport/login',
  '/transport/board',
  '/transport/pranimi',
]);

const SOFT_RECOVER_DELAY_MS = 140;
const RESUME_STALL_CHECK_MS = 2600;
const DUPLICATE_WINDOW_MS = 1200;

function isBrowser() {
  return typeof window !== 'undefined';
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

function readRouteAliveSnapshot() {
  if (!isBrowser()) return null;
  try {
    const live = window.__TEPIHA_ROUTE_ALIVE__;
    if (live && typeof live === 'object') return live;
  } catch {}
  try {
    const raw = window.sessionStorage?.getItem('tepiha_route_alive_v1');
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
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

export default function RootResumeWatchdog() {
  const timersRef = useRef([]);
  const activeRef = useRef({ seq: 0, token: '', path: '', reason: '' });
  const lastAcceptedRef = useRef({ token: '', at: 0 });

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

      lastAcceptedRef.current = { token, at: now };
      activeRef.current = { seq: now, token, path, reason: String(reason || '') };
      clearTimers();

      const hiddenAt = readHiddenAt();
      const hiddenElapsedMs = hiddenAt ? Math.max(0, now - hiddenAt) : 0;
      const watchedPath = WATCHED_PATHS.has(path);

      forceRootVisible(`resume_${reason}`);
      bootLog('root_resume_watchdog_start', {
        path,
        search: currentSearch(),
        reason,
        token,
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

        const routeAlive = readRouteAliveSnapshot();
        const routeAlivePath = String(routeAlive?.path || '');
        const routeAliveLabel = String(routeAlive?.label || '');
        const routeAliveAt = Number(routeAlive?.at || 0) || 0;
        const routeAliveAgeMs = routeAliveAt ? Math.max(0, Date.now() - routeAliveAt) : -1;
        const routeAliveFresh = !!(routeAlivePath === path && routeAliveAgeMs >= 0 && routeAliveAgeMs <= RESUME_STALL_CHECK_MS);
        const uiReady = readUiReady();

        if (routeAliveFresh) return;

        forceRootVisible(`resume_${reason}_stall`);
        bootLog('boot_timeout_resume_visible_no_ui', {
          path,
          search: currentSearch(),
          reason,
          token,
          hiddenElapsedMs,
          uiReady,
          routeAlivePath,
          routeAliveLabel,
          routeAliveAgeMs,
          ...(extra || {}),
        });

        try {
          window.dispatchEvent(new CustomEvent('tepiha:root-resume-stall', {
            detail: {
              at: Date.now(),
              path,
              reason: String(reason || ''),
              token,
              hiddenElapsedMs,
              uiReady,
              routeAlivePath,
              routeAliveLabel,
              routeAliveAgeMs,
            },
          }));
        } catch {}
      }, RESUME_STALL_CHECK_MS));
    };

    const onVisibility = () => {
      try {
        if (document.visibilityState === 'hidden') {
          onHidden('visibility_hidden');
          return;
        }
      } catch {}
      scheduleResumeCheck('visibility_visible');
    };

    const onPageHide = () => onHidden('pagehide');
    const onPageShow = (event) => scheduleResumeCheck('pageshow', { persisted: !!event?.persisted });
    const onFocus = () => scheduleResumeCheck('focus');

    window.addEventListener('pagehide', onPageHide, { passive: true });
    window.addEventListener('pageshow', onPageShow, { passive: true });
    window.addEventListener('focus', onFocus, { passive: true });
    document.addEventListener('visibilitychange', onVisibility, { passive: true });

    return () => {
      clearTimers();
      try { window.removeEventListener('pagehide', onPageHide); } catch {}
      try { window.removeEventListener('pageshow', onPageShow); } catch {}
      try { window.removeEventListener('focus', onFocus); } catch {}
      try { document.removeEventListener('visibilitychange', onVisibility); } catch {}
    };
  }, []);

  return null;
}
