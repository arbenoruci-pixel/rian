import { logDebugEvent } from '@/lib/sensor';
import { pushGlobalError } from '@/lib/globalErrors';
import { isDiagEnabled, isDiagLevel } from '@/lib/diagMode';

export const LS_NETWORK_TRACE = 'tepiha_network_trace_v1';
const MAX_TRACE = 120;
const SLOW_MS = 2500;
const HUNG_MS = 7000;
const FLUSH_DELAY_MS = 700;
const COLLAPSE_WINDOW_MS = 1200;

let pendingTrace = [];
let flushTimer = 0;

function isBrowser() {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

function safeJsonParse(raw, fallback) {
  try {
    const parsed = JSON.parse(raw);
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function safeRead() {
  if (!isBrowser()) return [];
  try {
    const raw = window.localStorage.getItem(LS_NETWORK_TRACE);
    const parsed = raw ? safeJsonParse(raw, []) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function safeWrite(list) {
  if (!isBrowser()) return;
  try {
    window.localStorage.setItem(LS_NETWORK_TRACE, JSON.stringify((Array.isArray(list) ? list : []).slice(0, MAX_TRACE)));
  } catch {}
}

function nowIso() {
  try { return new Date().toISOString(); } catch { return ''; }
}

function currentPath() {
  if (!isBrowser()) return '';
  try { return String(window.location?.pathname || ''); } catch { return ''; }
}

function isDebugRoute(path = currentPath()) {
  return /^\/debug(?:\/|$)/.test(String(path || ''));
}

function classifyUrl(url) {
  const raw = String(url || '');
  if (!raw || !isBrowser()) return null;
  let parsed = null;
  try {
    parsed = new URL(raw, window.location.origin);
  } catch {
    return null;
  }

  const href = String(parsed.href || '');
  const pathname = String(parsed.pathname || '');
  const sameOrigin = parsed.origin === window.location.origin;
  const isSupabase = /supabase\.co/i.test(parsed.hostname || '') || /^\/rest\/v1\//.test(pathname) || /^\/auth\/v1\//.test(pathname) || /^\/storage\/v1\//.test(pathname) || /^\/functions\/v1\//.test(pathname);
  const isApi = sameOrigin && pathname.startsWith('/api/');
  if (!isSupabase && !isApi) return null;

  let lane = 'other';
  if (/\/rest\/v1\//.test(pathname)) lane = 'rest';
  else if (/\/auth\/v1\//.test(pathname)) lane = 'auth';
  else if (/\/storage\/v1\//.test(pathname)) lane = 'storage';
  else if (/\/functions\/v1\//.test(pathname)) lane = 'functions';
  else if (isApi) lane = 'api';

  return {
    href,
    pathname,
    sameOrigin,
    kind: isSupabase ? 'supabase' : 'api',
    lane,
  };
}

function makeEntry(type, data = {}) {
  return {
    ts: Date.now(),
    at: nowIso(),
    type: String(type || 'event'),
    data: data || {},
    path: (() => { try { return window.location?.pathname || ''; } catch { return ''; } })(),
    search: (() => { try { return window.location?.search || ''; } catch { return ''; } })(),
    visibilityState: (() => { try { return document.visibilityState || ''; } catch { return ''; } })(),
    online: (() => { try { return navigator.onLine; } catch { return null; } })(),
  };
}

function sameFingerprint(a, b) {
  if (!a || !b) return false;
  return (
    String(a.type || '') === String(b.type || '') &&
    String(a.path || '') === String(b.path || '') &&
    JSON.stringify(a.data || {}) === JSON.stringify(b.data || {})
  );
}

function collapseInto(list, entry) {
  if (!Array.isArray(list) || !entry) return [entry];
  const head = list[0];
  if (head && sameFingerprint(head, entry) && Math.abs(Number(entry.ts || 0) - Number(head.ts || 0)) <= COLLAPSE_WINDOW_MS) {
    return [{ ...head, ts: entry.ts, at: entry.at, count: Number(head.count || 1) + 1 }, ...list.slice(1)];
  }
  return [entry, ...list];
}

function flushPendingTrace() {
  flushTimer = 0;
  if (!isBrowser() || pendingTrace.length === 0) return;
  let next = safeRead();
  for (let i = pendingTrace.length - 1; i >= 0; i -= 1) {
    next = collapseInto(next, pendingTrace[i]);
  }
  pendingTrace = [];
  safeWrite(next.slice(0, MAX_TRACE));
}

function scheduleFlush() {
  if (!isBrowser() || flushTimer) return;
  flushTimer = window.setTimeout(() => flushPendingTrace(), FLUSH_DELAY_MS);
}

function shouldRecord(type, data = {}) {
  const path = currentPath();
  const alwaysKeep = /fetch_(hung|throw)/i.test(String(type || '')) || (String(type || '') === 'fetch_end' && data?.ok === false);
  if (isDebugRoute(path)) return alwaysKeep;
  if (alwaysKeep) return true;
  if (!isDiagEnabled({ path })) return false;
  if (isDiagLevel('deep', { path })) return true;
  const raw = String(type || '');
  return /fetch_(slow|hung|throw)|install/i.test(raw);
}

export function appendNetworkTrace(type, data = {}) {
  if (!isBrowser()) return false;
  if (!shouldRecord(type, data)) return false;
  const entry = makeEntry(type, data);
  pendingTrace = collapseInto(pendingTrace, entry).slice(0, MAX_TRACE);
  scheduleFlush();
  if (!isDebugRoute(entry.path)) {
    try { logDebugEvent(`net_${String(type || 'event')}`, data || {}); } catch {}
  }
  try {
    window.dispatchEvent(new CustomEvent('tepiha:network-trace', { detail: entry }));
  } catch {}
  return true;
}

export function readNetworkTrace() {
  return safeRead();
}

export function clearNetworkTrace() {
  if (!isBrowser()) return;
  pendingTrace = [];
  try { window.localStorage.removeItem(LS_NETWORK_TRACE); } catch {}
}

export function installNetworkTrace() {
  if (!isBrowser()) return false;
  if (!isDiagEnabled()) return false;
  if (window.__TEPIHA_NETWORK_TRACE_INSTALLED__) return true;
  window.__TEPIHA_NETWORK_TRACE_INSTALLED__ = true;

  const nativeFetch = typeof window.fetch === 'function' ? window.fetch.bind(window) : null;
  if (!nativeFetch) {
    appendNetworkTrace('install_skip', { reason: 'NO_FETCH' });
    return false;
  }

  window.__TEPIHA_NETWORK_TRACE__ = {
    read: readNetworkTrace,
    clear: clearNetworkTrace,
  };

  appendNetworkTrace('install', {
    href: (() => { try { return window.location?.href || ''; } catch { return ''; } })(),
  });

  window.fetch = async (...args) => {
    const input = args[0];
    const init = args[1];
    const url = typeof input === 'string' ? input : input?.url || '';
    const match = classifyUrl(url);
    if (!match) return nativeFetch(...args);

    const method = String(init?.method || input?.method || 'GET').toUpperCase();
    const traceId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const startedAt = Date.now();
    let settled = false;

    appendNetworkTrace('fetch_start', {
      id: traceId,
      url: match.href,
      pathname: match.pathname,
      kind: match.kind,
      lane: match.lane,
      method,
      sameOrigin: match.sameOrigin,
    });

    const slowTimer = window.setTimeout(() => {
      if (settled) return;
      appendNetworkTrace('fetch_slow', {
        id: traceId,
        url: match.href,
        pathname: match.pathname,
        kind: match.kind,
        lane: match.lane,
        method,
        ms: Date.now() - startedAt,
      });
    }, SLOW_MS);

    const hungTimer = window.setTimeout(() => {
      if (settled) return;
      const ms = Date.now() - startedAt;
      appendNetworkTrace('fetch_hung', {
        id: traceId,
        url: match.href,
        pathname: match.pathname,
        kind: match.kind,
        lane: match.lane,
        method,
        ms,
      });
      try {
        pushGlobalError('network/fetch_hung', new Error('FETCH_HUNG'), {
          id: traceId,
          url: match.href,
          pathname: match.pathname,
          kind: match.kind,
          lane: match.lane,
          method,
          ms,
        });
      } catch {}
    }, HUNG_MS);

    try {
      const res = await nativeFetch(...args);
      settled = true;
      window.clearTimeout(slowTimer);
      window.clearTimeout(hungTimer);

      const ms = Date.now() - startedAt;
      const status = Number(res?.status || 0);
      const ok = !!res?.ok;
      const contentType = (() => {
        try { return res?.headers?.get?.('content-type') || ''; } catch { return ''; }
      })();

      appendNetworkTrace('fetch_end', {
        id: traceId,
        url: match.href,
        pathname: match.pathname,
        kind: match.kind,
        lane: match.lane,
        method,
        ms,
        status,
        ok,
        contentType,
      });

      if (!ok) {
        try {
          pushGlobalError('network/fetch_status', new Error(`HTTP_${status || 'UNKNOWN'}`), {
            id: traceId,
            url: match.href,
            pathname: match.pathname,
            kind: match.kind,
            lane: match.lane,
            method,
            ms,
            status,
          });
        } catch {}
      }

      return res;
    } catch (err) {
      settled = true;
      window.clearTimeout(slowTimer);
      window.clearTimeout(hungTimer);

      const ms = Date.now() - startedAt;
      const message = err?.message || String(err || 'FETCH_THROW');
      appendNetworkTrace('fetch_throw', {
        id: traceId,
        url: match.href,
        pathname: match.pathname,
        kind: match.kind,
        lane: match.lane,
        method,
        ms,
        message,
        name: err?.name || '',
      });

      try {
        pushGlobalError('network/fetch_throw', err, {
          id: traceId,
          url: match.href,
          pathname: match.pathname,
          kind: match.kind,
          lane: match.lane,
          method,
          ms,
        });
      } catch {}

      throw err;
    }
  };

  return true;
}
