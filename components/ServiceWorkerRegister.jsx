'use client';

import { useEffect } from 'react';
import { APP_DATA_EPOCH } from '@/lib/appEpoch';
import { bootLog } from '@/lib/bootLog';
import { getStartupIsolationLeftMs, isWithinStartupIsolationWindow, scheduleAfterStartupIsolation } from '@/lib/startupIsolation';

const SW_URL = `/sw.js?epoch=${encodeURIComponent(APP_DATA_EPOCH)}`;
const REGISTER_DELAY_MS = 1200;

function isBrowser() {
  return typeof window !== 'undefined';
}

function isSupported() {
  return isBrowser() && 'serviceWorker' in navigator;
}

function isSwKillMode() {
  if (!isBrowser()) return false;
  try {
    return window.__TEPIHA_SW_KILL_SWITCH__ === true || window.__TEPIHA_FORCE_NETWORK_MODE__ === true;
  } catch {
    return false;
  }
}

function isTepihaRuntimeCacheName(key = '') {
  const value = String(key || '');
  return /^(assets-|pages-|tepiha-|workbox-|vite-|next-data-)/i.test(value) || /tepiha/i.test(value);
}

function parseEpochFromSwUrl(url = '') {
  try {
    return String(new URL(String(url || ''), window.location.origin).searchParams.get('epoch') || '').trim();
  } catch {
    return '';
  }
}

function readControllerEpochInfo() {
  if (!isSupported()) return { controller: false, scriptURL: '', controllerEpoch: '', epochMismatch: false };
  const controller = navigator.serviceWorker.controller || null;
  const scriptURL = String(controller?.scriptURL || '');
  const controllerEpoch = parseEpochFromSwUrl(scriptURL);
  return {
    controller: !!controller,
    scriptURL,
    controllerEpoch,
    appEpoch: APP_DATA_EPOCH,
    epochMismatch: !!(APP_DATA_EPOCH && controllerEpoch && controllerEpoch !== APP_DATA_EPOCH),
  };
}

async function clearTepihaRuntimeCaches() {
  const deleted = [];
  try {
    if (!('caches' in window)) return deleted;
    const keys = await window.caches.keys();
    await Promise.allSettled((Array.isArray(keys) ? keys : []).filter(isTepihaRuntimeCacheName).map((key) => {
      deleted.push(key);
      try { return window.caches.delete(key); } catch { return Promise.resolve(false); }
    }));
  } catch {}
  return deleted;
}

async function unregisterAllServiceWorkers({ clearRuntimeCaches = true } = {}) {
  if (!isSupported()) return { count: 0, deletedCaches: [] };
  let regs = [];
  try { regs = await navigator.serviceWorker.getRegistrations(); } catch {}
  await Promise.allSettled((Array.isArray(regs) ? regs : []).map(async (reg) => {
    try { reg.waiting?.postMessage?.({ type: 'SKIP_WAITING' }); } catch {}
    try { reg.active?.postMessage?.({ type: 'SKIP_WAITING' }); } catch {}
    try { await reg.unregister(); } catch {}
  }));
  const deletedCaches = clearRuntimeCaches ? await clearTepihaRuntimeCaches() : [];
  return { count: Array.isArray(regs) ? regs.length : 0, deletedCaches };
}

function makeRepairUrl(reason = 'sw_epoch_mismatch') {
  try {
    const url = new URL(window.location.href);
    url.searchParams.set('__sw_repair_v2', String(reason || '1'));
    url.searchParams.set('__html_epoch', APP_DATA_EPOCH.slice(0, 90));
    url.searchParams.set('t', String(Date.now()));
    return url.toString();
  } catch {
    return `/?__sw_repair_v2=${encodeURIComponent(String(reason || '1'))}&t=${Date.now()}`;
  }
}

function isPublicLitePath(pathname = '') {
  const path = String(pathname || '');
  return path === '/porosit' || path.startsWith('/porosit/') || path === '/k' || path.startsWith('/k/');
}

function incidentsEnabled() {
  try {
    return window.__TEPIHA_SIMPLE_INCIDENTS_ENABLED__ !== false;
  } catch {
    return true;
  }
}

function markRuntimeOwnerReady(source = 'sw_register_mount') {
  try {
    window.__TEPIHA_RUNTIME_OWNER_READY__ = true;
    window.dispatchEvent(new CustomEvent('tepiha:runtime-owner-ready', {
      detail: { source, at: Date.now() },
    }));
  } catch {}
}

function markRootRuntimeSettled(source = 'sw_register_settled') {
  try {
    window.__TEPIHA_ROOT_RUNTIME_SETTLED__ = true;
    window.dispatchEvent(new CustomEvent('tepiha:root-runtime-settled', {
      detail: { source, at: Date.now() },
    }));
  } catch {}
}

export default function ServiceWorkerRegister() {
  useEffect(() => {
    if (!isSupported()) {
      markRootRuntimeSettled('sw_not_supported');
      return undefined;
    }

    const initialEpochInfo = readControllerEpochInfo();
    try {
      window.__TEPIHA_SW_EPOCH_STARTUP_CHECK__ = {
        at: new Date().toISOString(),
        path: String(window.location?.pathname || ''),
        ...initialEpochInfo,
      };
    } catch {}

    if (initialEpochInfo.epochMismatch) {
      const repairGuardKey = 'tepiha_sw_epoch_repair_guard_v2';
      const repairGuardValue = `${APP_DATA_EPOCH}:${initialEpochInfo.controllerEpoch || 'unknown'}`;
      try {
        const existingGuard = window.sessionStorage?.getItem(repairGuardKey) || '';
        if (existingGuard === repairGuardValue) {
          bootLog('sw_epoch_mismatch_repair_guard_skip', {
            path: String(window.location?.pathname || ''),
            appEpoch: APP_DATA_EPOCH,
            controllerEpoch: initialEpochInfo.controllerEpoch,
            controllerScriptURL: initialEpochInfo.scriptURL,
          });
          markRuntimeOwnerReady('sw_epoch_mismatch_repair_guard_skip');
          markRootRuntimeSettled('sw_epoch_mismatch_repair_guard_skip');
          return undefined;
        }
        window.sessionStorage?.setItem(repairGuardKey, repairGuardValue);
      } catch {}
      let cancelled = false;
      void unregisterAllServiceWorkers({ clearRuntimeCaches: true }).then((info) => {
        if (cancelled) return;
        try {
          bootLog('sw_epoch_mismatch_repaired', {
            path: String(window.location?.pathname || ''),
            appEpoch: APP_DATA_EPOCH,
            controllerEpoch: initialEpochInfo.controllerEpoch,
            controllerScriptURL: initialEpochInfo.scriptURL,
            removed: Number(info?.count || 0),
            deletedCaches: Array.isArray(info?.deletedCaches) ? info.deletedCaches : [],
          });
        } catch {}
        markRuntimeOwnerReady('sw_epoch_mismatch_repaired');
        markRootRuntimeSettled('sw_epoch_mismatch_repaired');
        try {
          window.setTimeout(() => {
            try { window.location.replace(makeRepairUrl('sw_epoch_mismatch')); } catch { window.location.href = makeRepairUrl('sw_epoch_mismatch'); }
          }, 120);
        } catch {}
      }).catch((error) => {
        if (cancelled) return;
        try { bootLog('sw_epoch_mismatch_repair_error', { path: String(window.location?.pathname || ''), message: String(error?.message || error || 'repair_failed'), appEpoch: APP_DATA_EPOCH }); } catch {}
        markRuntimeOwnerReady('sw_epoch_mismatch_repair_error');
        markRootRuntimeSettled('sw_epoch_mismatch_repair_error');
      });
      return () => { cancelled = true; };
    }

    if (isSwKillMode()) {
      let cancelled = false;
      void unregisterAllServiceWorkers().then((info) => {
        if (cancelled) return;
        try { bootLog('sw_kill_mode_active', { path: String(window.location?.pathname || ''), removed: Number(info?.count || 0), epoch: APP_DATA_EPOCH }); } catch {}
        markRuntimeOwnerReady('sw_kill_mode');
        markRootRuntimeSettled('sw_kill_mode');
      }).catch((error) => {
        try { bootLog('sw_kill_mode_error', { path: String(window.location?.pathname || ''), message: String(error?.message || error || 'sw_kill_mode_failed'), epoch: APP_DATA_EPOCH }); } catch {}
        markRuntimeOwnerReady('sw_kill_mode_error');
        markRootRuntimeSettled('sw_kill_mode_error');
      });
      return () => { cancelled = true; };
    }

    let cancelled = false;
    let timer = null;
    let isolationCancel = null;

    const path = isBrowser() ? String(window.location?.pathname || '') : '';
    const delay = isPublicLitePath(path) ? REGISTER_DELAY_MS + 1000 : REGISTER_DELAY_MS;

    const register = async () => {
      try {
        const reg = await navigator.serviceWorker.register(SW_URL, { scope: '/' });
        if (cancelled) return;
        try {
          const target = reg.active || reg.waiting || reg.installing || navigator.serviceWorker.controller;
          target?.postMessage?.({ type: 'PURGE_OLD_CACHES' });
        } catch {}
        try { bootLog('sw_registered_minimal', { path, scope: reg.scope || '/', epoch: APP_DATA_EPOCH }); } catch {}
        markRuntimeOwnerReady('sw_registered');
        markRootRuntimeSettled('sw_registered');
      } catch (error) {
        markRuntimeOwnerReady('sw_register_error');
        markRootRuntimeSettled('sw_register_error');
        try { bootLog('sw_register_error', { path, message: String(error?.message || error || 'sw_register_failed') }); } catch {}
        try {
          if (incidentsEnabled() && typeof window.__TEPIHA_INLINE_INCIDENT__ === 'function') {
            window.__TEPIHA_INLINE_INCIDENT__('sw_register_error', {
              source: 'minimal_sw_register',
              path,
              message: String(error?.message || error || 'sw_register_failed'),
              appEpoch: APP_DATA_EPOCH,
            });
          }
        } catch {}
      }
    };

    const scheduleRegister = (extraDelay = delay) => {
      if (cancelled) return;
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        void register();
      }, Math.max(0, Number(extraDelay) || 0));
    };

    if (isWithinStartupIsolationWindow()) {
      bootLog('sw_register_startup_isolation_delay', {
        path,
        leftMs: getStartupIsolationLeftMs(),
        epoch: APP_DATA_EPOCH,
      });
      isolationCancel = scheduleAfterStartupIsolation(() => {
        if (cancelled) return;
        bootLog('sw_register_startup_isolation_retry', { path, epoch: APP_DATA_EPOCH });
        scheduleRegister(120);
      }, { bufferMs: 80 });
    } else {
      scheduleRegister();
    }

    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
      if (typeof isolationCancel === 'function') isolationCancel();
    };
  }, []);

  return null;
}
