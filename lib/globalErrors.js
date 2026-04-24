// lib/globalErrors.js
// Global error sensor storage (client-side).
// Stores critical app errors (UI crashes, Supabase/RLS, Auth, Sync, API failures)
// into localStorage key: tepiha_global_errors

export const LS_GLOBAL_ERRORS = 'tepiha_global_errors';

const MAX_ERRORS = 200;
const CHUNK_HEAL_RELOAD_TS_KEY = '__tepiha_chunk_heal_reload_ts_v1';
const CHUNK_HEAL_RELOAD_REASON_KEY = '__tepiha_chunk_heal_reload_reason_v1';
const CHUNK_HEAL_RELOAD_WINDOW_MS = 10000;
const CHUNK_HEAL_FALLBACK_ID = 'tepiha-chunk-heal-fallback';
const CHUNK_HEAL_SESSION_GUARD_KEY = '__tepiha_chunk_heal_session_guard_v2';
const ROUTE_ALIVE_SESSION_KEY = 'tepiha_route_alive_v1';
const ROUTE_ALIVE_MAX_AGE_MS = 120000;
const CONTROLLED_RECOVERY_EVENT = 'tepiha:sw-controlled-recovery-request';
const pendingQueue = [];
let flushScheduled = false;
let hooksBound = false;

function isBrowser() {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

function safeJsonParse(v, fallback) {
  try {
    return JSON.parse(v);
  } catch {
    return fallback;
  }
}

function safeGetStored() {
  if (!isBrowser()) return [];
  try {
    const raw = window.localStorage.getItem(LS_GLOBAL_ERRORS);
    const parsed = raw ? safeJsonParse(raw, []) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function safeSet(arr) {
  if (!isBrowser()) return;
  try {
    window.localStorage.setItem(LS_GLOBAL_ERRORS, JSON.stringify(arr));
  } catch {
    // ignore
  }
}

function safeStringify(x) {
  try {
    return JSON.stringify(x);
  } catch {
    try {
      return String(x);
    } catch {
      return '[unstringifiable]';
    }
  }
}

function normalizeError(err) {
  if (!err) return { message: 'UNKNOWN_ERROR' };
  if (typeof err === 'string') return { message: err };
  const message = err?.message ? String(err.message) : String(err);
  const name = err?.name ? String(err.name) : undefined;
  const stack = err?.stack ? String(err.stack) : undefined;
  const code = err?.code ? String(err.code) : undefined;
  const details = err?.details ? String(err.details) : undefined;
  const hint = err?.hint ? String(err.hint) : undefined;
  return { name, message, stack, code, details, hint };
}

function flushPendingErrors() {
  flushScheduled = false;
  if (!isBrowser() || pendingQueue.length === 0) return;

  try {
    const queued = pendingQueue.splice(0, pendingQueue.length);
    const existing = safeGetStored();
    const next = queued.concat(existing).slice(0, MAX_ERRORS);
    safeSet(next);
  } catch {
    // ignore
  }
}

function scheduleFlush() {
  if (!isBrowser() || flushScheduled) return;
  flushScheduled = true;

  const runner = () => flushPendingErrors();

  try {
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(runner, { timeout: 2500 });
      return;
    }
  } catch {
    // ignore
  }

  window.setTimeout(runner, 1200);
}

function bindFlushHooksOnce() {
  if (!isBrowser() || hooksBound) return;
  hooksBound = true;

  const flushSoon = () => {
    try {
      flushPendingErrors();
    } catch {
      // ignore
    }
  };

  try {
    window.addEventListener('pagehide', flushSoon);
    document.addEventListener('visibilitychange', () => {
      try {
        if (document.visibilityState === 'hidden') flushSoon();
      } catch {
        // ignore
      }
    });
  } catch {
    // ignore
  }
}

export function pushGlobalError(where, err, meta = {}) {
  if (!isBrowser()) return;
  bindFlushHooksOnce();
  const normalized = normalizeError(err);
  const entry = {
    ts: Date.now(),
    at: new Date().toISOString(),
    where: String(where || 'unknown'),
    error: normalized,
    meta: meta || {},
    path: getCurrentPath(),
    visibilityState: (() => { try { return document.visibilityState || ''; } catch { return ''; } })(),
    online: (() => { try { return navigator.onLine; } catch { return null; } })(),
  };
  pendingQueue.unshift(entry);
  while (pendingQueue.length > MAX_ERRORS) pendingQueue.pop();
  scheduleFlush();
}

export function readGlobalErrors() {
  return safeGetStored();
}

export function clearGlobalErrors() {
  if (!isBrowser()) return;
  pendingQueue.length = 0;
  try { window.localStorage.removeItem(LS_GLOBAL_ERRORS); } catch {}
}

export function exportGlobalErrorsText() {
  try {
    return JSON.stringify(readGlobalErrors(), null, 2);
  } catch {
    return '[]';
  }
}


export function isChunkLoadLikeError(input) {
  try {
    const haystack = [
      typeof input === 'string' ? input : '',
      input?.message,
      input?.name,
      input?.stack,
      input?.filename,
      input?.fileName,
      input?.targetSrc,
      input?.details,
      input?.hint,
      input?.reason?.message,
      input?.reason?.stack,
      input?.cause?.message,
      input?.cause?.stack,
      String(input || ''),
    ].map((value) => String(value || '')).join('\n');
    return /loading chunk|chunkloaderror|chunk [0-9]+ failed|failed to fetch dynamically imported module|error loading dynamically imported module|importing a module script failed|failed to load module script|module script failed|module script|dynamically imported module|\/assets\/.*\.(?:js|mjs)(?:\?|$)|\/_next\/static\/chunks\//i.test(haystack);
  } catch {
    return false;
  }
}


function readChunkHealTs() {
  if (!isBrowser()) return 0;
  try {
    const raw = Number(window.sessionStorage.getItem(CHUNK_HEAL_RELOAD_TS_KEY) || 0);
    return Number.isFinite(raw) ? raw : 0;
  } catch {
    return 0;
  }
}

function writeChunkHealTs(ts, reason = '') {
  if (!isBrowser()) return;
  try {
    window.sessionStorage.setItem(CHUNK_HEAL_RELOAD_TS_KEY, String(Number(ts || Date.now()) || Date.now()));
    window.sessionStorage.setItem(CHUNK_HEAL_RELOAD_REASON_KEY, String(reason || 'chunk_error'));
  } catch {
    // ignore
  }
}


function readChunkHealGuard() {
  if (!isBrowser()) return 0;
  try {
    const raw = Number(window.sessionStorage.getItem(CHUNK_HEAL_SESSION_GUARD_KEY) || 0);
    return Number.isFinite(raw) ? raw : 0;
  } catch {
    return 0;
  }
}

function clearChunkHealGuard() {
  if (!isBrowser()) return;
  try {
    window.sessionStorage.removeItem(CHUNK_HEAL_SESSION_GUARD_KEY);
  } catch {
    // ignore
  }
}

function writeChunkHealGuard(ts) {
  if (!isBrowser()) return;
  try {
    window.sessionStorage.setItem(CHUNK_HEAL_SESSION_GUARD_KEY, String(Number(ts || Date.now()) || Date.now()));
  } catch {
    // ignore
  }
}

function dispatchControlledRecoveryRequest(reason = 'chunk_error', meta = {}, extra = {}) {
  if (!isBrowser()) return false;
  const detail = {
    reason: String(reason || 'chunk_error'),
    source: String(extra?.source || 'globalErrors'),
    at: Date.now(),
    currentPath: getCurrentPath(),
    ...extra,
    meta,
  };
  try {
    window.dispatchEvent(new CustomEvent(CONTROLLED_RECOVERY_EVENT, { detail }));
    return true;
  } catch {
    return false;
  }
}

function getCurrentPath() {

  if (!isBrowser()) return '';
  try {
    return String(window.location?.pathname || '');
  } catch {
    return '';
  }
}

function readRouteAlive() {
  if (!isBrowser()) return null;
  try {
    const direct = window.__TEPIHA_ROUTE_ALIVE__;
    if (direct && typeof direct === 'object') return direct;
  } catch {
    // ignore
  }
  try {
    const raw = window.sessionStorage.getItem(ROUTE_ALIVE_SESSION_KEY);
    const parsed = raw ? safeJsonParse(raw, null) : null;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function readRuntimeOwnerReadyFlag() {
  if (!isBrowser()) return false;
  try {
    return window.__TEPIHA_RUNTIME_OWNER_READY__ === true;
  } catch {
    return false;
  }
}

function readRootRuntimeSettledFlag() {
  if (!isBrowser()) return false;
  try {
    return window.__TEPIHA_ROOT_RUNTIME_SETTLED__ === true;
  } catch {
    return false;
  }
}

function readUiReadyFlag() {
  if (!isBrowser()) return false;
  try {
    if (document?.querySelector?.('[data-route-fallback="1"]')) return false;
  } catch {
    // ignore
  }
  try {
    if (window.__TEPIHA_UI_READY === true) return true;
  } catch {
    // ignore
  }
  try {
    if (document?.documentElement?.getAttribute?.('data-ui-ready') === '1') return true;
  } catch {
    // ignore
  }
  try {
    if (document?.body?.getAttribute?.('data-ui-ready') === '1') return true;
  } catch {
    // ignore
  }
  return false;
}

function getChunkHealContext() {
  const now = Date.now();
  const currentPath = getCurrentPath();
  const routeAlive = readRouteAlive();
  const routeAlivePath = String(routeAlive?.path || '');
  const routeAliveAt = Number(routeAlive?.at || 0) || 0;
  const routeAliveAgeMs = routeAliveAt ? Math.max(0, now - routeAliveAt) : null;
  const samePathAlive = !!routeAlivePath && !!currentPath && routeAlivePath === currentPath;
  const freshRouteAlive = samePathAlive && routeAliveAgeMs != null && routeAliveAgeMs <= ROUTE_ALIVE_MAX_AGE_MS;
  const uiReady = readUiReadyFlag();
  const runtimeOwnerReady = readRuntimeOwnerReadyFlag();
  const rootRuntimeSettled = readRootRuntimeSettledFlag();
  const suppressReload = freshRouteAlive && runtimeOwnerReady && rootRuntimeSettled;
  return {
    currentPath,
    routeAlivePath,
    routeAliveAgeMs,
    uiReady,
    runtimeOwnerReady,
    rootRuntimeSettled,
    samePathAlive,
    freshRouteAlive,
    suppressReload,
  };
}

function buildDirectChunkHealUrl(reason = 'chunk_error') {
  if (!isBrowser()) return '';
  try {
    const url = new URL(window.location.href);
    url.searchParams.set('__chunk_heal', String(Date.now()));
    url.searchParams.set('__chunk_heal_reason', String(reason || 'chunk_error').slice(0, 48));
    return url.toString();
  } catch {
    return '';
  }
}

function maybeRunDirectChunkHealReload(ctx, reason = 'chunk_error', meta = {}) {
  if (!isBrowser()) return false;
  try {
    pushGlobalError('ui/chunk_self_heal_direct_reload_suppressed_local_strategy', 'CHUNK_SELF_HEAL_DIRECT_RELOAD_SUPPRESSED_LOCAL_STRATEGY', {
      reason: String(reason || 'chunk_error'),
      currentPath: ctx?.currentPath || '',
      routeAlivePath: ctx?.routeAlivePath || '',
      routeAliveAgeMs: ctx?.routeAliveAgeMs || -1,
      uiReady: !!ctx?.uiReady,
      runtimeOwnerReady: !!ctx?.runtimeOwnerReady,
      rootRuntimeSettled: !!ctx?.rootRuntimeSettled,
      samePathAlive: !!ctx?.samePathAlive,
      freshRouteAlive: !!ctx?.freshRouteAlive,
      suppressReload: true,
      ...meta,
    });
  } catch {
    // ignore
  }
  return false;
}

function ensureChunkHealFallbackUi(message = 'Lidhja e dobët, provo sërish.') {
  if (!isBrowser()) return;
  try {
    const existing = document.getElementById(CHUNK_HEAL_FALLBACK_ID);
    if (existing) return;

    const wrap = document.createElement('div');
    wrap.id = CHUNK_HEAL_FALLBACK_ID;
    wrap.setAttribute('role', 'alert');
    wrap.style.position = 'fixed';
    wrap.style.inset = '0';
    wrap.style.zIndex = '2147483647';
    wrap.style.background = 'rgba(5,7,13,0.96)';
    wrap.style.display = 'flex';
    wrap.style.alignItems = 'center';
    wrap.style.justifyContent = 'center';
    wrap.style.padding = '20px';

    const card = document.createElement('div');
    card.style.maxWidth = '460px';
    card.style.width = '100%';
    card.style.borderRadius = '16px';
    card.style.padding = '20px';
    card.style.background = '#0d1320';
    card.style.border = '1px solid rgba(255,255,255,0.14)';
    card.style.boxShadow = '0 20px 60px rgba(0,0,0,0.45)';
    card.style.color = '#fff';
    card.style.fontFamily = 'system-ui, -apple-system, Segoe UI, Roboto, Arial';

    const title = document.createElement('div');
    title.textContent = 'APP-I KËRKON RIFRESKIM';
    title.style.fontWeight = '900';
    title.style.letterSpacing = '1px';
    title.style.fontSize = '20px';

    const body = document.createElement('div');
    body.textContent = String(message || 'Versioni i ruajtur i app-it nuk përputhet me build-in aktual. Provo sërish.');
    body.style.marginTop = '10px';
    body.style.opacity = '0.88';
    body.style.lineHeight = '1.45';

    const sub = document.createElement('div');
    sub.textContent = 'Rifreskimi i dytë automatik u ndal për të shmangur loop dhe për të mbrojtur të dhënat lokale.';
    sub.style.marginTop = '8px';
    sub.style.opacity = '0.65';
    sub.style.fontSize = '13px';

    const actions = document.createElement('div');
    actions.style.display = 'flex';
    actions.style.gap = '10px';
    actions.style.flexWrap = 'wrap';
    actions.style.marginTop = '16px';

    const reloadBtn = document.createElement('button');
    reloadBtn.type = 'button';
    reloadBtn.textContent = 'PROVO SËRISH';
    reloadBtn.style.padding = '12px 14px';
    reloadBtn.style.borderRadius = '12px';
    reloadBtn.style.border = '1px solid rgba(255,255,255,0.18)';
    reloadBtn.style.background = 'rgba(255,255,255,0.08)';
    reloadBtn.style.color = '#fff';
    reloadBtn.style.fontWeight = '800';
    reloadBtn.style.letterSpacing = '0.6px';
    reloadBtn.style.cursor = 'pointer';
    reloadBtn.onclick = () => {
      try {
        window.sessionStorage.removeItem(CHUNK_HEAL_RELOAD_TS_KEY);
        window.sessionStorage.removeItem(CHUNK_HEAL_RELOAD_REASON_KEY);
        clearChunkHealGuard();
      } catch {
        // ignore
      }
      try {
        dispatchControlledRecoveryRequest('manual_retry', { source: 'fallback_ui' }, { source: 'globalErrors.fallback_ui' });
      } catch {
        // ignore
      }
    };

    actions.appendChild(reloadBtn);
    card.appendChild(title);
    card.appendChild(body);
    card.appendChild(sub);
    card.appendChild(actions);
    wrap.appendChild(card);
    document.body.appendChild(wrap);
  } catch {
    // ignore
  }
}

export function tryChunkLoadSelfHeal(reason = 'chunk_error', meta = {}) {
  if (!isBrowser()) return false;
  const ctx = getChunkHealContext();
  try {
    pushGlobalError('ui/chunk_self_heal_suppressed_local_strategy', 'CHUNK_SELF_HEAL_SUPPRESSED_LOCAL_STRATEGY', {
      reason: String(reason || 'chunk_error'),
      currentPath: ctx.currentPath,
      routeAlivePath: ctx.routeAlivePath,
      routeAliveAgeMs: ctx.routeAliveAgeMs,
      uiReady: ctx.uiReady,
      runtimeOwnerReady: ctx.runtimeOwnerReady,
      rootRuntimeSettled: ctx.rootRuntimeSettled,
      samePathAlive: ctx.samePathAlive,
      freshRouteAlive: ctx.freshRouteAlive,
      suppressReload: true,
      ...meta,
    });
  } catch {
    // ignore
  }
  return false;
}

