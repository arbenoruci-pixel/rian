'use client';

import { useEffect } from 'react';
import { startSyncLoop } from '@/lib/syncBootstrap';
import { bootLog } from '@/lib/bootLog';
import { isTransportPath } from '@/lib/transportCore/scope';
import { getStartupIsolationLeftMs, isWithinStartupIsolationWindow, scheduleAfterStartupIsolation } from '@/lib/startupIsolation';
import { isSafeModeDisabledUntil, safeModeLeftMs } from '@/lib/safeMode';

function waitForVisibleStable(delayMs = 0) {
  return new Promise((resolve) => {
    if (typeof window === 'undefined') return resolve();
    const delay = Math.max(0, Number(delayMs) || 0);
    let timer = null;
    let done = false;

    const cleanup = () => {
      if (timer) window.clearTimeout(timer);
      window.removeEventListener('focus', onVisible);
      document.removeEventListener('visibilitychange', onVisible);
    };

    const finish = () => {
      if (done) return;
      done = true;
      cleanup();
      resolve();
    };

    const onVisible = () => {
      try {
        if (document.hidden) return;
      } catch {}
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(finish, delay);
    };

    onVisible();
    window.addEventListener('focus', onVisible, { passive: true });
    document.addEventListener('visibilitychange', onVisible, { passive: true });
  });
}

function waitForIdleWindow(delayMs = 0, idleTimeoutMs = 5000) {
  return new Promise((resolve) => {
    if (typeof window === 'undefined') return resolve();

    let timer = null;
    let idleId = null;
    let done = false;

    const cleanup = () => {
      if (timer) window.clearTimeout(timer);
      timer = null;
      if (idleId && typeof window.cancelIdleCallback === 'function') {
        window.cancelIdleCallback(idleId);
      } else if (idleId) {
        window.clearTimeout(idleId);
      }
      idleId = null;
    };

    const finish = () => {
      if (done) return;
      done = true;
      cleanup();
      resolve();
    };

    const scheduleIdle = () => {
      if (typeof window.requestIdleCallback === 'function') {
        idleId = window.requestIdleCallback(() => {
          idleId = null;
          finish();
        }, { timeout: Math.max(1500, Number(idleTimeoutMs) || 5000) });
      } else {
        idleId = window.setTimeout(finish, 350);
      }
    };

    timer = window.setTimeout(scheduleIdle, Math.max(0, Number(delayMs) || 0));
  });
}

function isStandaloneLike() {
  try {
    if (typeof window === 'undefined') return false;
    if (window.navigator?.standalone === true) return true;
    if (typeof window.matchMedia === 'function') {
      if (window.matchMedia('(display-mode: standalone)').matches) return true;
      if (window.matchMedia('(display-mode: fullscreen)').matches) return true;
      if (window.matchMedia('(display-mode: minimal-ui)').matches) return true;
    }
  } catch {}
  return false;
}

function isPublicLitePath(pathname = '') {
  const path = String(pathname || '');
  return path === '/porosit' || path.startsWith('/porosit/') || path === '/k' || path.startsWith('/k/');
}

function shouldRunOfflineRuntime(pathname = '') {
  const path = String(pathname || '');
  if (isPublicLitePath(path)) return false;
  if (/^\/debug\//.test(path)) return true;
  if (isStandaloneLike()) return true;
  try {
    if (window.__TEPIHA_ALLOW_BROWSER_OFFLINE_RUNTIME__ === true) return true;
    const qs = new URLSearchParams(window.location.search || '');
    if (qs.get('offlineengines') === '1') return true;
    if (window.localStorage?.getItem('tepiha_allow_browser_offline_runtime') === '1') return true;
  } catch {}
  return false;
}

export default function SyncStarter() {
  useEffect(() => {
    let cleanup = null;
    let cancelled = false;
    let isolationCancel = null;

    const mountPath = typeof window !== 'undefined' ? window.location.pathname || '' : '';
    const standalone = isStandaloneLike();

    const start = () => {
      if (isSafeModeDisabledUntil('disableSyncUntil')) {
        bootLog('syncstarter_skip_safe_mode', { path: mountPath, standalone, leftMs: safeModeLeftMs('disableSyncUntil') });
        return;
      }
      const offlineRuntimeOwnsLoop = shouldRunOfflineRuntime(mountPath);
      const transportScopedRoute = isTransportPath(mountPath);

      if (transportScopedRoute) {
        bootLog('syncstarter_skip_transport_scope', { path: mountPath, standalone });
        return;
      }

      if (isPublicLitePath(mountPath)) {
        bootLog('syncstarter_skip_public_lite', { path: mountPath, standalone });
        return;
      }

      if (offlineRuntimeOwnsLoop) {
        bootLog('syncstarter_skip_offline_runtime_owner', { path: mountPath, standalone });
        return;
      }

      const config = standalone
        ? {
            visibleDelayMs: 1800,
            idleDelayMs: 1200,
            idleTimeoutMs: 4000,
            intervalMs: 5 * 60 * 1000,
            debounceMs: 1800,
            wakeDebounceMs: 2600,
            triggerDebounceMs: 2200,
            minGapMs: 60000,
          }
        : {
            visibleDelayMs: 4000,
            idleDelayMs: 1800,
            idleTimeoutMs: 5000,
            intervalMs: 5 * 60 * 1000,
            debounceMs: 2600,
            wakeDebounceMs: 5200,
            triggerDebounceMs: 4500,
            minGapMs: 60000,
          };

      bootLog('syncstarter_mount', {
        path: typeof window !== 'undefined' ? window.location.pathname || '' : '',
        standalone,
      });

      const boot = async () => {
        bootLog('syncstarter_boot_wait', {
          standalone,
          visibleDelayMs: config.visibleDelayMs,
          idleDelayMs: config.idleDelayMs,
          idleTimeoutMs: config.idleTimeoutMs,
        });
        await waitForVisibleStable(config.visibleDelayMs);
        if (cancelled) return;
        await waitForIdleWindow(config.idleDelayMs, config.idleTimeoutMs);
        if (cancelled) return;
        try {
          cleanup = startSyncLoop({
            intervalMs: config.intervalMs,
            debounceMs: config.debounceMs,
            wakeDebounceMs: config.wakeDebounceMs,
            triggerDebounceMs: config.triggerDebounceMs,
            minGapMs: config.minGapMs,
          });
          bootLog('syncstarter_started', { standalone, ...config });
        } catch (err) {
          bootLog('syncstarter_fail', { error: err?.message || 'startSyncLoop failed', standalone });
        }
      };

      void boot();
    };

    if (isWithinStartupIsolationWindow()) {
      bootLog('syncstarter_startup_isolation_delay', {
        path: mountPath,
        standalone,
        leftMs: getStartupIsolationLeftMs(),
      });
      isolationCancel = scheduleAfterStartupIsolation(() => {
        if (cancelled) return;
        bootLog('syncstarter_startup_isolation_retry', { path: mountPath, standalone });
        start();
      }, { bufferMs: 80 });
    } else {
      start();
    }

    return () => {
      cancelled = true;
      try { if (typeof cleanup === 'function') cleanup(); } catch {}
      try { if (typeof isolationCancel === 'function') isolationCancel(); } catch {}
    };
  }, []);

  return null;
}
