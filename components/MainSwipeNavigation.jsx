'use client';

import React from 'react';
import { usePathname, useRouter } from '@/lib/routerCompat.jsx';

const EDGE_GUARD_PX = 24;
const MIN_HORIZONTAL_DISTANCE = 80;
const MAX_VERTICAL_DISTANCE = 50;
const TOAST_NAV_DELAY_MS = 560;
const TOAST_CLEAR_DELAY_MS = 720;

const SWIPE_ROUTES = {
  '/pastrimi': {
    left: { path: '/gati', label: 'GATI' },
    right: { path: '/', label: 'HOME' },
  },
  '/gati': {
    left: { path: '/marrje-sot', label: 'MARRJE SOT' },
    right: { path: '/pastrimi', label: 'PASTRIMI' },
  },
  '/marrje-sot': {
    left: { path: '/', label: 'HOME' },
    right: { path: '/gati', label: 'GATI' },
  },
};

function normalizePath(pathname) {
  const raw = String(pathname || '/').split('?')[0].split('#')[0] || '/';
  if (raw.length > 1 && raw.endsWith('/')) return raw.slice(0, -1);
  return raw;
}

function getTouchPoint(event) {
  const touch = event?.changedTouches?.[0] || event?.touches?.[0];
  if (!touch) return null;
  return {
    x: Number(touch.clientX || 0),
    y: Number(touch.clientY || 0),
  };
}

function isInteractiveTarget(target) {
  try {
    const node = target?.nodeType === 1 ? target : target?.parentElement;
    if (!node?.closest) return false;
    return !!node.closest([
      'button',
      'input',
      'textarea',
      'select',
      'a',
      'label',
      '[role="button"]',
      '[contenteditable="true"]',
      '[data-no-swipe]',
      '[data-swipe-block]',
      '.no-swipe',
    ].join(','));
  } catch {
    return false;
  }
}

function classOrDataSuggestsOverlay(element) {
  try {
    if (!element) return false;
    const className = String(element.className || '').toLowerCase();
    const dataset = element.dataset || {};
    if (dataset.modalOpen === 'true' || dataset.overlayOpen === 'true') return true;
    if (element.getAttribute?.('data-modal-open') === 'true') return true;
    if (element.getAttribute?.('data-overlay-open') === 'true') return true;
    return /(^|\s)(modal-open|overlay-open|sheet-open|dialog-open|drawer-open)(\s|$)/.test(className);
  } catch {
    return false;
  }
}

function hasVisibleOverlayElement() {
  try {
    const selectors = [
      'dialog[open]',
      '[role="dialog"]',
      '[aria-modal="true"]',
      '[data-modal-open="true"]',
      '[data-overlay-open="true"]',
      '.modal-open',
      '.overlay-open',
      '.sheet-open',
      '.dialog-open',
      '.drawer-open',
      '.modal',
      '.modal-backdrop',
      '.bottom-sheet',
      '.sms-modal',
      '.paketimi-modal',
      '.payment-modal',
    ].join(',');

    const nodes = Array.from(document.querySelectorAll(selectors)).slice(0, 20);
    return nodes.some((node) => {
      try {
        if (!node || node.getAttribute?.('aria-hidden') === 'true') return false;
        const rect = node.getBoundingClientRect?.();
        const style = window.getComputedStyle?.(node);
        if (!rect || !style) return false;
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || 1) === 0) return false;
        return rect.width > 20 && rect.height > 20;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

function isPageOverlayOpen() {
  try {
    const body = document.body;
    const html = document.documentElement;
    if (classOrDataSuggestsOverlay(body) || classOrDataSuggestsOverlay(html)) return true;
    if (hasVisibleOverlayElement()) return true;
    return false;
  } catch {
    return false;
  }
}

export default function MainSwipeNavigation() {
  const router = useRouter();
  const pathname = usePathname();
  const path = normalizePath(pathname);
  const routeConfig = SWIPE_ROUTES[path] || null;
  const touchRef = React.useRef(null);
  const timersRef = React.useRef([]);
  const navigatingRef = React.useRef(false);
  const [toast, setToast] = React.useState(null);

  React.useEffect(() => () => {
    try {
      timersRef.current.forEach((timer) => window.clearTimeout(timer));
      timersRef.current = [];
    } catch {}
  }, []);

  React.useEffect(() => {
    if (!routeConfig) {
      touchRef.current = null;
      navigatingRef.current = false;
      setToast(null);
      return undefined;
    }

    const clearTimers = () => {
      try {
        timersRef.current.forEach((timer) => window.clearTimeout(timer));
        timersRef.current = [];
      } catch {}
    };

    const start = (event) => {
      try {
        if (navigatingRef.current) return;
        if (!routeConfig) return;
        if (!event?.touches || event.touches.length !== 1) return;
        if (isInteractiveTarget(event.target)) return;
        if (isPageOverlayOpen()) return;

        const point = getTouchPoint(event);
        if (!point) return;
        const width = Number(window.innerWidth || document.documentElement?.clientWidth || 0);
        if (point.x <= EDGE_GUARD_PX || (width && point.x >= width - EDGE_GUARD_PX)) return;

        touchRef.current = {
          startX: point.x,
          startY: point.y,
          lastX: point.x,
          lastY: point.y,
          cancelled: false,
          verticalScroll: false,
          startedAt: Date.now(),
        };
      } catch {
        touchRef.current = null;
      }
    };

    const move = (event) => {
      try {
        const active = touchRef.current;
        if (!active || active.cancelled) return;
        const point = getTouchPoint(event);
        if (!point) return;
        active.lastX = point.x;
        active.lastY = point.y;
        const dx = point.x - active.startX;
        const dy = point.y - active.startY;
        const absX = Math.abs(dx);
        const absY = Math.abs(dy);
        if (absY > 20 && absY > absX) {
          active.verticalScroll = true;
          active.cancelled = true;
        }
      } catch {}
    };

    const end = (event) => {
      try {
        const active = touchRef.current;
        touchRef.current = null;
        if (!active || active.cancelled || active.verticalScroll || navigatingRef.current) return;
        if (isPageOverlayOpen()) return;

        const point = getTouchPoint(event) || { x: active.lastX, y: active.lastY };
        const dx = point.x - active.startX;
        const dy = point.y - active.startY;
        const absX = Math.abs(dx);
        const absY = Math.abs(dy);

        if (absX < MIN_HORIZONTAL_DISTANCE) return;
        if (absY > MAX_VERTICAL_DISTANCE) return;
        if (absX < absY * 1.35) return;

        const direction = dx < 0 ? 'left' : 'right';
        const target = routeConfig?.[direction];
        if (!target?.path) return;

        navigatingRef.current = true;
        clearTimers();
        setToast(String(target.label || '').trim() || 'HAPET');

        const navTimer = window.setTimeout(() => {
          try { router.push(target.path); } catch {}
        }, TOAST_NAV_DELAY_MS);
        const clearTimer = window.setTimeout(() => {
          try { setToast(null); } catch {}
          navigatingRef.current = false;
        }, TOAST_CLEAR_DELAY_MS);
        timersRef.current = [navTimer, clearTimer];
      } catch {
        navigatingRef.current = false;
      }
    };

    const cancel = () => {
      touchRef.current = null;
    };

    try { window.addEventListener('touchstart', start, { passive: true, capture: true }); } catch {}
    try { window.addEventListener('touchmove', move, { passive: true, capture: true }); } catch {}
    try { window.addEventListener('touchend', end, { passive: true, capture: true }); } catch {}
    try { window.addEventListener('touchcancel', cancel, { passive: true, capture: true }); } catch {}

    return () => {
      try { window.removeEventListener('touchstart', start, true); } catch {}
      try { window.removeEventListener('touchmove', move, true); } catch {}
      try { window.removeEventListener('touchend', end, true); } catch {}
      try { window.removeEventListener('touchcancel', cancel, true); } catch {}
      touchRef.current = null;
    };
  }, [routeConfig, router, path]);

  if (!routeConfig || !toast) return null;

  return (
    <>
      <div className="main-swipe-nav-toast" aria-live="polite" role="status">
        {toast}
      </div>
      <style>{`
        .main-swipe-nav-toast {
          position: fixed;
          left: 50%;
          top: calc(18px + env(safe-area-inset-top, 0px));
          transform: translateX(-50%);
          z-index: 2147483000;
          min-width: 118px;
          max-width: calc(100vw - 48px);
          padding: 11px 16px;
          border-radius: 999px;
          border: 1px solid rgba(255,255,255,0.16);
          background: rgba(10, 16, 28, 0.88);
          color: #fff;
          box-shadow: 0 18px 44px rgba(0,0,0,0.32);
          backdrop-filter: blur(14px);
          -webkit-backdrop-filter: blur(14px);
          font-size: 13px;
          font-weight: 900;
          letter-spacing: 0.08em;
          text-align: center;
          pointer-events: none;
          user-select: none;
          animation: mainSwipeToastIn 160ms ease-out both;
        }
        @keyframes mainSwipeToastIn {
          from { opacity: 0; transform: translateX(-50%) translateY(-6px) scale(0.96); }
          to { opacity: 1; transform: translateX(-50%) translateY(0) scale(1); }
        }
      `}</style>
    </>
  );
}
