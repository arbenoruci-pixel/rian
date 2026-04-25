'use client';

import { useEffect } from 'react';
import { APP_DATA_EPOCH } from '@/lib/appEpoch';
import { bootLog } from '@/lib/bootLog';

const WARMUP_VERSION = 'offline-first-warmup-v1';
const WARMUP_DONE_PREFIX = 'tepiha_offline_first_warmup_done_v1';
const WARMUP_LAST_KEY = 'tepiha_offline_first_warmup_last_v1';

const ROUTE_URLS = [
  '/',
  '/pranimi',
  '/pastrimi',
  '/gati',
  '/marrje-sot',
  '/arka',
  '/transport',
  '/transport/menu',
  '/transport/board',
];

const MODULE_WARMERS = [
  ['PRANIMI', () => import('@/app/pranimi/page.jsx')],
  ['PASTRIMI', () => import('@/app/pastrimi/page.jsx')],
  ['GATI', () => import('@/app/gati/page.jsx')],
  ['MARRJE_SOT', () => import('@/app/marrje-sot/page.jsx')],
  ['ARKA', () => import('@/app/arka/page.jsx')],
  ['TRANSPORT_HOME', () => import('@/app/transport/page.jsx')],
  ['TRANSPORT_MENU', () => import('@/app/transport/menu/page.jsx')],
  ['TRANSPORT_BOARD', () => import('@/app/transport/board/page.jsx')],
  ['SMART_SMS_MODAL', () => import('@/components/SmartSmsModal.jsx')],
  ['POS_MODAL', () => import('@/components/PosModal.jsx')],
  ['RACK_LOCATION_MODAL', () => import('@/components/RackLocationModal.jsx')],
  ['OFFLINE_SYNC_RUNNER', () => import('@/components/OfflineSyncRunner.jsx')],
  ['SYNC_STARTER', () => import('@/components/SyncStarter.jsx')],
  ['RUNTIME_INCIDENT_UPLOADER', () => import('@/components/RuntimeIncidentUploader.jsx')],
  ['SESSION_DOCK', () => import('@/components/SessionDock.jsx')],
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

      const ready = await waitForReadyToWarm(cancelledRef);
      if (!ready || cancelledRef.cancelled) return;

      await sleep(2600);
      if (cancelledRef.cancelled || !isOnline() || !isVisible()) return;

      const failures = [];
      writeWarmupStatus('start', { buildKey, routes: ROUTE_URLS.length, modules: MODULE_WARMERS.length });

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
