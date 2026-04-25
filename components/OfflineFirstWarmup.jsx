'use client';

import { useEffect } from 'react';
import { APP_DATA_EPOCH } from '@/lib/appEpoch';
import { bootLog } from '@/lib/bootLog';

const WARMUP_VERSION = 'offline-first-warmup-v4-fast-home-v12';
const WARMUP_DONE_PREFIX = 'tepiha_offline_first_warmup_done_v2';
const WARMUP_LAST_KEY = 'tepiha_offline_first_warmup_last_v2';

const ROUTE_URLS = [
  // V12: do not warm Home or the eager daily routes before/around first paint.
  // Warmup is background convenience only for lazy secondary surfaces.
  '/arka',
  '/transport',
  '/transport/menu',
  '/transport/board',
];

const MODULE_WARMERS = [
  // V12: keep daily business routes eager and avoid warming runtime modules here.
  ['ARKA', () => import('@/app/arka/page.jsx')],
  ['TRANSPORT_HOME', () => import('@/app/transport/page.jsx')],
  ['TRANSPORT_MENU', () => import('@/app/transport/menu/page.jsx')],
  ['TRANSPORT_BOARD', () => import('@/app/transport/board/page.jsx')],
  ['SMART_SMS_MODAL', () => import('@/components/SmartSmsModal.jsx')],
  ['POS_MODAL', () => import('@/components/PosModal.jsx')],
  ['RACK_LOCATION_MODAL', () => import('@/components/RackLocationModal.jsx')],
];

function safeString(value, fallback = '') {
  try {
    const text = String(value ?? '');
    return text || fallback;
  } catch {
    return fallback;
  }
}

function isOnline() {
  try {
    return typeof navigator === 'undefined' ? true : navigator.onLine !== false;
  } catch {
    return true;
  }
}

function isVisible() {
  try {
    return typeof document === 'undefined' || document.visibilityState === 'visible';
  } catch {
    return true;
  }
}
function isSafeMode() {
  try {
    if (typeof window === 'undefined') return true;
    if (window.__TEPIHA_HOME_SAFE_MODE__ === true) return true;
    const sp = new URLSearchParams(window.location?.search || '');
    if (sp.get('homeSafeMode') === '1' || sp.get('safeMode') === '1') return true;
    return false;
  } catch {
    return true;
  }
}

function networkLooksWeak() {
  try {
    const conn = navigator?.connection || navigator?.mozConnection || navigator?.webkitConnection;
    if (!conn) return false;
    if (conn.saveData === true) return true;
    const effective = String(conn.effectiveType || '').toLowerCase();
    return effective === 'slow-2g' || effective === '2g';
  } catch {
    return false;
  }
}

function waitForHomeReadyOrTimeout(cancelledRef, timeoutMs = 5000) {
  return new Promise((resolve) => {
    if (typeof window === 'undefined') return resolve(false);
    let done = false;
    let timer = 0;
    const finish = (reason) => {
      if (done) return;
      done = true;
      try { window.clearTimeout(timer); } catch {}
      try { window.removeEventListener('tepiha:first-ui-ready', onReady, true); } catch {}
      try { window.removeEventListener('tepiha:route-ui-alive', onReady, true); } catch {}
      resolve(reason);
    };
    const onReady = (event) => {
      if (cancelledRef.cancelled) return finish('cancelled');
      const detail = event?.detail && typeof event.detail === 'object' ? event.detail : {};
      const path = String(detail?.path || window.location?.pathname || '/');
      if (path === '/') finish('home_route_ui_ready');
    };
    try {
      if (window.__TEPIHA_HOME_STATIC_SHELL_RENDERED__ === true || window.__TEPIHA_UI_READY === true) {
        return finish('already_ready');
      }
    } catch {}
    try { window.addEventListener('tepiha:first-ui-ready', onReady, true); } catch {}
    try { window.addEventListener('tepiha:route-ui-alive', onReady, true); } catch {}
    timer = window.setTimeout(() => finish('timeout'), Math.max(800, Number(timeoutMs) || 5000));
  });
}


function sleep(ms) {
  return new Promise((resolve) => {
    try { window.setTimeout(resolve, Math.max(0, Number(ms) || 0)); } catch { resolve(); }
  });
}

function waitForReadyToWarm(cancelledRef) {
  return new Promise((resolve) => {
    if (typeof window === 'undefined') return resolve(false);

    const finish = (ok) => {
      try { window.removeEventListener('online', onReady); } catch {}
      try { window.removeEventListener('focus', onReady); } catch {}
      try { document.removeEventListener('visibilitychange', onReady); } catch {}
      resolve(ok);
    };

    const onReady = () => {
      if (cancelledRef.cancelled) return finish(false);
      if (!isOnline() || !isVisible()) return;
      finish(true);
    };

    if (isOnline() && isVisible()) return finish(true);

    try { window.addEventListener('online', onReady, { passive: true }); } catch {}
    try { window.addEventListener('focus', onReady, { passive: true }); } catch {}
    try { document.addEventListener('visibilitychange', onReady, { passive: true }); } catch {}
  });
}

function getBuildKey() {
  const buildId = safeString(typeof window !== 'undefined' ? window.__TEPIHA_BUILD_ID : '', 'unknown-build');
  return `${WARMUP_DONE_PREFIX}:${APP_DATA_EPOCH}:${buildId}`;
}

function writeWarmupStatus(status, extra = {}) {
  const payload = {
    version: WARMUP_VERSION,
    status,
    at: new Date().toISOString(),
    ts: Date.now(),
    appEpoch: APP_DATA_EPOCH,
    buildId: safeString(typeof window !== 'undefined' ? window.__TEPIHA_BUILD_ID : '', ''),
    online: isOnline(),
    path: safeString(typeof window !== 'undefined' ? window.location?.pathname : '', ''),
    ...extra,
  };

  try { window.__TEPIHA_OFFLINE_FIRST_WARMUP_LAST__ = payload; } catch {}
  try { window.localStorage?.setItem(WARMUP_LAST_KEY, JSON.stringify(payload)); } catch {}
  try { bootLog('offline_first_warmup_' + status, payload); } catch {}
  return payload;
}

async function fetchWithTimeout(url, timeoutMs = 7000) {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  let timer = null;
  try {
    if (controller) {
      timer = window.setTimeout(() => {
        try { controller.abort(); } catch {}
      }, Math.max(1000, Number(timeoutMs) || 7000));
    }
    const response = await fetch(url, {
      credentials: 'same-origin',
      cache: 'reload',
      signal: controller?.signal,
    });
    return !!response && (response.ok || response.type === 'opaqueredirect');
  } finally {
    try { if (timer) window.clearTimeout(timer); } catch {}
  }
}

function collectCurrentAssetUrls() {
  const out = [];
  try {
    const scripts = Array.from(document.scripts || [])
      .map((script) => safeString(script?.src, ''))
      .filter((src) => src.includes('/assets/') || src.includes('/src/main.jsx'));
    out.push(...scripts);
  } catch {}
  try {
    const links = Array.from(document.querySelectorAll('link[href]') || [])
      .map((link) => safeString(link?.href, ''))
      .filter((href) => href.includes('/assets/') || /\.(?:css|js|mjs|json|webmanifest|png|ico|svg|webp)(?:\?|$)/i.test(href));
    out.push(...links);
  } catch {}
  return Array.from(new Set(out.filter(Boolean))).slice(0, 80);
}

function tellServiceWorkerToWarmCache(assets = []) {
  try {
    const controller = navigator?.serviceWorker?.controller;
    if (!controller || typeof controller.postMessage !== 'function') return false;
    const safeAssets = Array.from(new Set((assets || []).map((asset) => safeString(asset, '')).filter(Boolean))).slice(0, 120);
    if (!safeAssets.length) return false;
    controller.postMessage({ type: 'WARM_CACHE', assets: safeAssets, source: WARMUP_VERSION, at: Date.now() });
    return true;
  } catch {
    return false;
  }
}

async function warmRouteShells(cancelledRef, failures) {
  for (const route of ROUTE_URLS) {
    if (cancelledRef.cancelled || !isOnline()) break;
    try {
      const ok = await fetchWithTimeout(route, 6500);
      if (!ok) failures.push({ step: 'route', route, message: 'FETCH_NOT_OK' });
    } catch (error) {
      failures.push({ step: 'route', route, message: safeString(error?.message || error, 'FETCH_FAILED') });
    }
    await sleep(120);
  }
}

async function warmCurrentAssets(cancelledRef, failures) {
  const assets = collectCurrentAssetUrls();
  tellServiceWorkerToWarmCache(assets);
  for (const asset of assets) {
    if (cancelledRef.cancelled || !isOnline()) break;
    try {
      const ok = await fetchWithTimeout(asset, 6500);
      if (!ok) failures.push({ step: 'asset', asset, message: 'FETCH_NOT_OK' });
    } catch (error) {
      failures.push({ step: 'asset', asset, message: safeString(error?.message || error, 'FETCH_FAILED') });
    }
    await sleep(60);
  }
}

async function warmCriticalModules(cancelledRef, failures) {
  for (const [label, importer] of MODULE_WARMERS) {
    if (cancelledRef.cancelled || !isOnline()) break;
    try {
      await importer();
    } catch (error) {
      failures.push({ step: 'module', label, message: safeString(error?.message || error, 'IMPORT_FAILED') });
    }
    await sleep(180);
  }
}

export default function OfflineFirstWarmup() {
  useEffect(() => {
    const cancelledRef = { cancelled: false };

    try {
      window.__TEPIHA_ALLOW_BROWSER_OFFLINE_RUNTIME__ = true;
      window.localStorage?.setItem('tepiha_allow_browser_offline_runtime', '1');
    } catch {}

    const run = async () => {
      if (typeof window === 'undefined') return;

      const buildKey = getBuildKey();
      try {
        const done = window.localStorage?.getItem(buildKey);
        if (done === '1') {
          writeWarmupStatus('skip_already_done', { buildKey });
          return;
        }
      } catch {}

      if (isSafeMode()) {
        writeWarmupStatus('skip_safe_mode', { buildKey });
        return;
      }

      const ready = await waitForReadyToWarm(cancelledRef);
      if (!ready || cancelledRef.cancelled) return;

      const homeReadyReason = await waitForHomeReadyOrTimeout(cancelledRef, 5000);
      if (cancelledRef.cancelled) return;

      await sleep(5200);
      if (cancelledRef.cancelled || !isOnline() || !isVisible()) return;
      if (networkLooksWeak()) {
        writeWarmupStatus('skip_weak_network', { buildKey, homeReadyReason });
        return;
      }

      const failures = [];
      writeWarmupStatus('start', { buildKey, routes: ROUTE_URLS.length, modules: MODULE_WARMERS.length, homeReadyReason });

      await warmCurrentAssets(cancelledRef, failures);
      await warmRouteShells(cancelledRef, failures);
      await warmCriticalModules(cancelledRef, failures);

      if (cancelledRef.cancelled) return;

      const severeFailures = failures.filter((item) => item?.step === 'module');
      const status = severeFailures.length ? 'partial' : 'complete';
      writeWarmupStatus(status, {
        buildKey,
        failureCount: failures.length,
        moduleFailureCount: severeFailures.length,
        failures: failures.slice(0, 24),
      });

      if (status === 'complete') {
        try { window.localStorage?.setItem(buildKey, '1'); } catch {}
      }
    };

    void run();

    return () => {
      cancelledRef.cancelled = true;
    };
  }, []);

  return null;
}
