import React from 'react';

const DEFAULT_RELOAD_WINDOW_MS = 30000;
const DEFAULT_STORAGE_PREFIX = 'tepiha_lazy_reload_once_v1';
const LAST_ERROR_KEY = 'tepiha_lazy_reload_last_error_v1';

function safeString(value, fallback = '') {
  try {
    const text = String(value ?? '');
    return text || fallback;
  } catch {
    return fallback;
  }
}

function safeNow() {
  try { return Date.now(); } catch { return 0; }
}

function getSessionStorage() {
  try {
    if (typeof window === 'undefined') return null;
    return window.sessionStorage || null;
  } catch {
    return null;
  }
}

function getLocalStorage() {
  try {
    if (typeof window === 'undefined') return null;
    return window.localStorage || null;
  } catch {
    return null;
  }
}

function normalizeReloadKey(value) {
  return safeString(value || 'unknown', 'unknown')
    .replace(/[^a-zA-Z0-9:_./-]+/g, '_')
    .slice(0, 180);
}

function readJson(storage, key, fallback = null) {
  try {
    const raw = storage?.getItem?.(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeJson(storage, key, value) {
  try { storage?.setItem?.(key, JSON.stringify(value)); } catch {}
}

function normalizeError(error) {
  return {
    name: safeString(error?.name, ''),
    message: safeString(error?.message || error, 'UNKNOWN_DYNAMIC_IMPORT_ERROR'),
    stack: safeString(error?.stack, '').slice(0, 4000),
  };
}

function runtimeSnapshot(extra = {}) {
  const now = safeNow();
  return {
    ts: now,
    at: (() => { try { return new Date(now).toISOString(); } catch { return ''; } })(),
    href: (() => { try { return safeString(window.location?.href, ''); } catch { return ''; } })(),
    path: (() => { try { return safeString(window.location?.pathname, ''); } catch { return ''; } })(),
    search: (() => { try { return safeString(window.location?.search, ''); } catch { return ''; } })(),
    online: (() => { try { return navigator.onLine; } catch { return null; } })(),
    visibilityState: (() => { try { return safeString(document.visibilityState, ''); } catch { return ''; } })(),
    appEpoch: (() => { try { return safeString(window.__TEPIHA_APP_EPOCH || '', ''); } catch { return ''; } })(),
    buildId: (() => { try { return safeString(window.__TEPIHA_BUILD_ID || '', ''); } catch { return ''; } })(),
    userAgent: (() => { try { return safeString(navigator.userAgent || '', ''); } catch { return ''; } })(),
    ...extra,
  };
}

function darkReloadComponentFactory({ title, text, reason, reloadBlocked }) {
  return function LazyReloadDarkFallback() {
    return (
      <div
        data-lazy-with-reload-fallback="1"
        data-lazy-with-reload-reason={safeString(reason, 'dynamic_import_failed')}
        data-lazy-with-reload-blocked={reloadBlocked ? '1' : '0'}
        style={{
          minHeight: '100vh',
          backgroundColor: '#0f172a',
          color: '#e5e7eb',
          display: 'grid',
          placeItems: 'center',
          padding: 18,
          fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        }}
      >
        <div
          style={{
            width: '100%',
            maxWidth: 560,
            borderRadius: 20,
            border: '1px solid rgba(148, 163, 184, 0.35)',
            backgroundColor: 'rgba(15, 23, 42, 0.96)',
            boxShadow: '0 22px 55px rgba(0,0,0,0.35)',
            padding: 18,
          }}
        >
          <div style={{ fontSize: 12, fontWeight: 900, letterSpacing: 1.1, color: '#93c5fd' }}>
            APP UPDATE
          </div>
          <div style={{ marginTop: 8, fontSize: 22, lineHeight: 1.15, fontWeight: 1000 }}>
            {title || (reloadBlocked ? 'MODULI NUK U NGARKUA' : 'DUKE RIFRESKUAR APP-IN')}
          </div>
          <div style={{ marginTop: 8, fontSize: 14, lineHeight: 1.45, color: 'rgba(226,232,240,0.82)', fontWeight: 700 }}>
            {text || (reloadBlocked
              ? 'U ndalua reload-i i dytë për të shmangur loop. Mbylle dhe hape aplikacionin përsëri ose përdor RIPARO APP.'
              : 'U gjet një chunk i vjetër pas deploy-it. App-i po rifreskohet për ta marrë versionin e ri.')}
          </div>
          {reloadBlocked ? (
            <a
              href="/pwa-repair.html?from=lazy_reload_blocked"
              style={{
                display: 'inline-flex',
                marginTop: 14,
                minHeight: 42,
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: 14,
                padding: '0 14px',
                backgroundColor: '#2563eb',
                color: '#fff',
                textDecoration: 'none',
                fontWeight: 950,
              }}
            >
              RIPARO APP
            </a>
          ) : null}
        </div>
      </div>
    );
  };
}

export function reloadPageOnce(reason = 'dynamic_import_failed', options = {}) {
  if (typeof window === 'undefined') {
    return { scheduled: false, blocked: true, reason: 'server_runtime' };
  }

  const storage = getSessionStorage();
  const localStorageRef = getLocalStorage();
  const windowMs = Number(options.reloadWindowMs || DEFAULT_RELOAD_WINDOW_MS) || DEFAULT_RELOAD_WINDOW_MS;
  const keySeed = options.storageKey || options.key || options.moduleId || options.label || reason || 'global';
  const storageKey = `${DEFAULT_STORAGE_PREFIX}:${normalizeReloadKey(keySeed)}`;
  const now = safeNow();
  const previous = readJson(storage, storageKey, null);
  const previousTs = Number(previous?.ts || 0) || 0;
  const blocked = !!(previousTs && now - previousTs < windowMs);

  const payload = runtimeSnapshot({
    reason: safeString(reason, 'dynamic_import_failed'),
    storageKey,
    keySeed: safeString(keySeed, ''),
    reloadWindowMs: windowMs,
    previousTs,
    blocked,
    error: options.error ? normalizeError(options.error) : null,
    meta: options.meta || null,
  });

  writeJson(localStorageRef, LAST_ERROR_KEY, payload);

  if (blocked) {
    return { scheduled: false, blocked: true, storageKey, payload };
  }

  writeJson(storage, storageKey, payload);

  try {
    window.setTimeout(() => {
      try {
        window.location.reload(true);
      } catch {
        try { window.location.reload(); } catch {}
      }
    }, Number(options.delayMs ?? 80) || 80);
  } catch {
    try { window.location.reload(true); } catch { try { window.location.reload(); } catch {} }
  }

  return { scheduled: true, blocked: false, storageKey, payload };
}

export function lazyWithReload(importer, options = {}) {
  const label = safeString(options.label || options.moduleId || options.storageKey || options.key || 'lazy-module', 'lazy-module');

  return React.lazy(async () => {
    try {
      return await importer();
    } catch (error) {
      const result = reloadPageOnce('dynamic_import_failed', {
        ...options,
        label,
        error,
        meta: {
          ...(options.meta || {}),
          label,
          sourceLayer: options.sourceLayer || 'lazy_with_reload',
        },
      });

      const ReloadingFallback = darkReloadComponentFactory({
        reason: 'dynamic_import_failed',
        reloadBlocked: !!result.blocked,
        title: result.blocked ? 'MODULI NUK U NGARKUA' : 'DUKE RIFRESKUAR APP-IN',
      });

      return { default: ReloadingFallback };
    }
  });
}

export default lazyWithReload;
