'use client';

import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { bootLog, bootMarkReady } from '@/lib/bootLog';

function afterPaint(fn) {
  try {
    requestAnimationFrame(() => requestAnimationFrame(fn));
  } catch {
    setTimeout(fn, 0);
  }
}

function setUiReadyFlag(value) {
  try {
    if (value) {
      window.__TEPIHA_UI_READY = true;
      document?.documentElement?.setAttribute?.('data-ui-ready', '1');
      document?.body?.setAttribute?.('data-ui-ready', '1');
    } else {
      window.__TEPIHA_UI_READY = false;
      document?.documentElement?.removeAttribute?.('data-ui-ready');
      document?.body?.removeAttribute?.('data-ui-ready');
    }
  } catch {}
}

function hasRouteFallback() {
  try {
    return !!document?.querySelector?.('[data-route-fallback="1"]');
  } catch {
    return false;
  }
}

function canMarkReady() {
  try {
    if (typeof document === 'undefined') return false;
    const state = String(document.readyState || '');
    if (state !== 'interactive' && state !== 'complete') return false;
    if (!document.body) return false;
    if (hasRouteFallback()) return false;
    return true;
  } catch {
    return false;
  }
}

export default function BootReadyMark() {
  const location = useLocation();
  const pathname = location?.pathname || '/';
  const markedRef = useRef(false);

  useEffect(() => {
    markedRef.current = false;
    setUiReadyFlag(false);

    let cancelled = false;
    let observer = null;
    let timeoutId = 0;

    const mark = (source) => {
      if (cancelled || markedRef.current) return true;
      if (!canMarkReady()) return false;
      markedRef.current = true;
      setUiReadyFlag(true);
      try { bootLog('boot_ready_mark_layout', { path: pathname, source }); } catch {}
      try { bootMarkReady({ path: pathname, source }); } catch {}
      try {
        window.dispatchEvent(new CustomEvent('tepiha:first-ui-ready', {
          detail: { page: String(pathname || '/'), ts: Date.now(), source },
        }));
      } catch {}
      try { observer?.disconnect?.(); } catch {}
      return true;
    };

    const tryMark = (source) => {
      afterPaint(() => {
        if (markedRef.current || cancelled) return;
        mark(source);
      });
    };

    tryMark('layout_boot_ready_mark');

    try {
      observer = new MutationObserver(() => {
        if (markedRef.current || cancelled) return;
        if (!hasRouteFallback()) {
          tryMark('layout_boot_ready_mark_after_fallback');
        }
      });
      if (document?.body) {
        observer.observe(document.body, { childList: true, subtree: true, attributes: true });
      }
    } catch {}

    const onPageShow = () => tryMark('layout_boot_ready_mark_pageshow');
    const onVisible = () => {
      try {
        if (document.visibilityState === 'visible') tryMark('layout_boot_ready_mark_visible');
      } catch {}
    };

    try { window.addEventListener('pageshow', onPageShow, true); } catch {}
    try { document.addEventListener('visibilitychange', onVisible, true); } catch {}

    timeoutId = window.setTimeout(() => {
      if (cancelled || markedRef.current) return;
      try {
        bootLog('boot_ready_mark_waiting', {
          path: pathname,
          source: 'layout_boot_ready_mark_waiting',
          routeFallbackVisible: hasRouteFallback(),
        });
      } catch {}
      if (!hasRouteFallback()) {
        tryMark('layout_boot_ready_mark_timeout');
      }
    }, 8000);

    return () => {
      cancelled = true;
      try { observer?.disconnect?.(); } catch {}
      try { window.removeEventListener('pageshow', onPageShow, true); } catch {}
      try { document.removeEventListener('visibilitychange', onVisible, true); } catch {}
      try { window.clearTimeout(timeoutId); } catch {}
    };
  }, [pathname]);

  return null;
}
