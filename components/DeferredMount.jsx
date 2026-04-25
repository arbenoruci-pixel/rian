'use client';

import { useEffect, useState } from 'react';
import { usePathname } from '@/lib/routerCompat.jsx';

let deferredMountChain = Promise.resolve();
let deferredRuntimeMountChain = Promise.resolve();

function sleep(ms) {
  return new Promise((resolve) => {
    try {
      window.setTimeout(resolve, Math.max(0, Number(ms) || 0));
    } catch {
      resolve();
    }
  });
}

function waitForRuntimeOwnerReady(maxWaitMs = 5000) {
  return new Promise((resolve) => {
    if (typeof window === 'undefined') return resolve();
    try {
      if (window.__TEPIHA_RUNTIME_OWNER_READY__ === true) return resolve();
    } catch {}

    let done = false;
    let timerId = 0;

    const finish = () => {
      if (done) return;
      done = true;
      try { window.clearTimeout(timerId); } catch {}
      try { window.removeEventListener('tepiha:runtime-owner-ready', onReady); } catch {}
      resolve();
    };

    const onReady = () => finish();

    try { window.addEventListener('tepiha:runtime-owner-ready', onReady, { passive: true }); } catch {}
    timerId = window.setTimeout(finish, Math.max(0, Number(maxWaitMs) || 0));
  });
}

function waitForVisibleStable(bufferMs = 0) {
  return new Promise((resolve) => {
    if (typeof window === 'undefined') return resolve();
    const stableFor = Math.max(0, Number(bufferMs) || 0);
    let done = false;
    let timerId = null;

    const cleanup = () => {
      if (timerId) window.clearTimeout(timerId);
      window.removeEventListener('focus', handleVisible);
      document.removeEventListener('visibilitychange', handleVisible);
    };

    const finish = () => {
      if (done) return;
      done = true;
      cleanup();
      resolve();
    };

    const handleVisible = () => {
      if (document?.hidden) return;
      if (timerId) window.clearTimeout(timerId);
      timerId = window.setTimeout(finish, stableFor);
    };

    if (!document?.hidden) {
      handleVisible();
    } else {
      window.addEventListener('focus', handleVisible, { passive: true });
      document.addEventListener('visibilitychange', handleVisible, { passive: true });
    }
  });
}

function waitForIdle(idle) {
  return new Promise((resolve) => {
    if (!idle || typeof window === 'undefined') return resolve();
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(() => resolve(), { timeout: 2500 });
      return;
    }
    window.setTimeout(resolve, 0);
  });
}

function waitForHomeInteractive(maxWaitMs = 0) {
  return new Promise((resolve) => {
    if (typeof window === 'undefined') return resolve();
    const onHome = () => {
      try { return String(window.location?.pathname || '/') === '/'; } catch { return false; }
    };
    if (!onHome()) return resolve();

    let done = false;
    let timerId = 0;

    const finish = () => {
      if (done) return;
      done = true;
      try { window.clearTimeout(timerId); } catch {}
      try { window.removeEventListener('pointerdown', handleDone, true); } catch {}
      try { window.removeEventListener('touchstart', handleDone, true); } catch {}
      try { window.removeEventListener('keydown', handleDone, true); } catch {}
      try { window.removeEventListener('tepiha:home-interactive', handleDone, true); } catch {}
      try { window.removeEventListener('popstate', handleRouteExit, true); } catch {}
      try { document.removeEventListener('visibilitychange', handleRouteExit, true); } catch {}
      resolve();
    };

    const handleDone = () => finish();
    const handleRouteExit = () => {
      if (!onHome()) finish();
    };

    try { window.addEventListener('pointerdown', handleDone, true); } catch {}
    try { window.addEventListener('touchstart', handleDone, true); } catch {}
    try { window.addEventListener('keydown', handleDone, true); } catch {}
    try { window.addEventListener('tepiha:home-interactive', handleDone, true); } catch {}
    try { window.addEventListener('popstate', handleRouteExit, true); } catch {}
    try { document.addEventListener('visibilitychange', handleRouteExit, true); } catch {}

    timerId = window.setTimeout(finish, Math.max(0, Number(maxWaitMs) || 0));
  });
}

export default function DeferredMount({
  children,
  delay = 0,
  idle = false,
  wakeSafe = false,
  wakeBufferMs = 0,
  chain = false,
  homeExtraDelay = 0,
  waitForHomeInteractive: waitForHomeInteractiveProp = false,
  maxHomeInteractiveWaitMs = 12000,
  waitForOwnerSignal = true,
  maxOwnerWaitMs = 5000,
  runtimeOwner = false,
}) {
  const pathname = usePathname();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const onHome = String(pathname || '/') === '/';

    const runMount = async () => {
      if (!runtimeOwner && waitForOwnerSignal) {
        await waitForRuntimeOwnerReady(maxOwnerWaitMs);
        if (cancelled) return;
      }
      await sleep(delay);
      if (cancelled) return;
      if (onHome && homeExtraDelay > 0) {
        await sleep(homeExtraDelay);
        if (cancelled) return;
      }
      if (wakeSafe) {
        await waitForVisibleStable(wakeBufferMs);
        if (cancelled) return;
      }
      if (onHome && waitForHomeInteractiveProp) {
        await waitForHomeInteractive(maxHomeInteractiveWaitMs);
        if (cancelled) return;
      }
      await waitForIdle(idle);
      if (!cancelled) setReady(true);
    };

    const shouldRuntimeChain = !runtimeOwner && waitForOwnerSignal;
    if (runtimeOwner) {
      void runMount();
    } else if (shouldRuntimeChain) {
      deferredRuntimeMountChain = deferredRuntimeMountChain.then(runMount, runMount);
    } else if (chain) {
      deferredMountChain = deferredMountChain.then(runMount, runMount);
    } else {
      void runMount();
    }

    return () => {
      cancelled = true;
    };
  }, [delay, idle, wakeSafe, wakeBufferMs, chain, pathname, homeExtraDelay, waitForHomeInteractiveProp, maxHomeInteractiveWaitMs, waitForOwnerSignal, maxOwnerWaitMs, runtimeOwner]);

  return ready ? children : null;
}
