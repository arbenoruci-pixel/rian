'use client';

import { useEffect } from 'react';
import { usePathname } from '@/lib/routerCompat.jsx';
import { bootLog } from '@/lib/bootLog';
import { logDebugEvent } from '@/lib/sensor';

export function markRouteUiAlive(label = '', pathOverride = '', extra = {}) {
  // V33 readiness-chain fix: keep this legacy helper name for callers, but do
  // not mark UI ready from route mount/focus/visibility signals. Real UI ready
  // must come from lib/markRealUiReady.js after visible page content exists.
  if (typeof window === 'undefined') return;
  const path = String(pathOverride || window.location?.pathname || '/');
  const payload = {
    ...(extra && typeof extra === 'object' ? extra : {}),
    path,
    label: String(label || ''),
    source: String(extra?.source || label || 'route_alive'),
    at: Number(extra?.at ?? Date.now()) || Date.now(),
    noUiReady: true,
    patch: 'readiness_chain_v33',
  };

  try { window.__TEPIHA_ROUTE_ALIVE__ = payload; } catch {}
  try { window.__TEPIHA_ROUTE_ALIVE_PATH__ = path; } catch {}
  try { window.__TEPIHA_ROUTE_ALIVE_AT__ = payload.at; } catch {}
  try { window.__TEPIHA_LAST_ROUTE_ALIVE_SOURCE__ = payload.source; } catch {}
  try { window.sessionStorage.setItem('tepiha_route_alive_v1', JSON.stringify(payload)); } catch {}
  try { document?.documentElement?.setAttribute?.('data-route-alive', '1'); } catch {}
  try { document?.body?.setAttribute?.('data-route-alive', '1'); } catch {}
  try { document?.documentElement?.setAttribute?.('data-route-alive-path', path); } catch {}
  try { document?.body?.setAttribute?.('data-route-alive-path', path); } catch {}
  try { document?.documentElement?.setAttribute?.('data-route-alive-source', payload.source); } catch {}
  try { document?.body?.setAttribute?.('data-route-alive-source', payload.source); } catch {}
  try {
    window.dispatchEvent(new CustomEvent('tepiha:route-alive', { detail: payload }));
  } catch {}
  try {
    document.dispatchEvent(new CustomEvent('tepiha:route-alive', { detail: payload }));
  } catch {}
  try { logDebugEvent('route_alive', { path, label: payload.label, source: payload.source, resumeToken: Number(payload?.resumeToken || 0) || 0, noUiReady: true, patch: 'readiness_chain_v33' }); } catch {}
  try { bootLog('route_alive', { path, label: payload.label, source: payload.source, resumeToken: Number(payload?.resumeToken || 0) || 0, noUiReady: true, patch: 'readiness_chain_v33' }); } catch {}
}

export function markRouteAlive(label = '', pathOverride = '') {
  if (typeof window === 'undefined') return;
  const path = String(pathOverride || window.location?.pathname || '/');
  const payload = {
    path,
    label: String(label || ''),
    at: Date.now(),
  };

  try { window.__TEPIHA_ROUTE_ALIVE__ = payload; } catch {}
  try { window.__TEPIHA_ROUTE_ALIVE_PATH__ = path; } catch {}
  try { window.__TEPIHA_ROUTE_ALIVE_AT__ = payload.at; } catch {}
  try { window.__TEPIHA_LAST_ROUTE_ALIVE_SOURCE__ = payload.label; } catch {}
  try { window.sessionStorage.setItem('tepiha_route_alive_v1', JSON.stringify(payload)); } catch {}
  try { document?.documentElement?.setAttribute?.('data-route-alive', '1'); } catch {}
  try { document?.body?.setAttribute?.('data-route-alive', '1'); } catch {}
  try { document?.documentElement?.setAttribute?.('data-route-alive-path', path); } catch {}
  try { document?.body?.setAttribute?.('data-route-alive-path', path); } catch {}
  try { document?.documentElement?.setAttribute?.('data-route-alive-source', payload.label); } catch {}
  try { document?.body?.setAttribute?.('data-route-alive-source', payload.label); } catch {}
  try {
    window.dispatchEvent(new CustomEvent('tepiha:route-alive', { detail: payload }));
  } catch {}
  try {
    document.dispatchEvent(new CustomEvent('tepiha:route-alive', { detail: payload }));
  } catch {}
  try { logDebugEvent('route_alive', { path, label: payload.label }); } catch {}
  try { bootLog('route_alive', { path, label: payload.label }); } catch {}
}

export function useRouteAlive(label = '') {
  const pathname = usePathname() || '/';

  useEffect(() => {
    if (typeof document === 'undefined') {
      markRouteAlive(label, pathname);
      return;
    }

    let lastCommitAt = 0;
    const commit = (reason = 'commit') => {
      try {
        if (document.visibilityState !== 'visible') return;
      } catch {}
      const now = Date.now();
      if ((now - Number(lastCommitAt || 0)) < 180) return;
      lastCommitAt = now;
      markRouteAlive(label || reason, pathname);
      try { markRouteUiAlive(label || reason, pathname, { resumeToken: now, source: reason }); } catch {}
    };

    const onVisible = () => {
      try {
        if (document.visibilityState !== 'visible') return;
      } catch {}
      commit('visibility_visible');
    };

    const onPageShow = () => commit('pageshow');
    const onFocus = () => commit('focus');

    commit('mount');
    document.addEventListener('visibilitychange', onVisible, { passive: true });
    window.addEventListener('pageshow', onPageShow, { passive: true });
    window.addEventListener('focus', onFocus, { passive: true });

    return () => {
      try { document.removeEventListener('visibilitychange', onVisible); } catch {}
      try { window.removeEventListener('pageshow', onPageShow); } catch {}
      try { window.removeEventListener('focus', onFocus); } catch {}
    };
  }, [label, pathname]);
}

export default useRouteAlive;
