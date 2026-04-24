'use client';

import { useEffect } from 'react';
import { registerSW } from 'virtual:pwa-register';
import { APP_DATA_EPOCH } from '@/lib/appEpoch';
import { bootLog } from '@/lib/bootLog';

const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

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

function incidentsEnabled() {
  try {
    return window.__TEPIHA_SIMPLE_INCIDENTS_ENABLED__ !== false;
  } catch {
    return true;
  }
}

function markRuntimeOwnerReady(source = 'vite_pwa_register_mount') {
  try {
    window.__TEPIHA_RUNTIME_OWNER_READY__ = true;
    window.dispatchEvent(new CustomEvent('tepiha:runtime-owner-ready', {
      detail: { source, at: Date.now() },
    }));
  } catch {}
}

function markRootRuntimeSettled(source = 'vite_pwa_register_settled') {
  try {
    window.__TEPIHA_ROOT_RUNTIME_SETTLED__ = true;
    window.dispatchEvent(new CustomEvent('tepiha:root-runtime-settled', {
      detail: { source, at: Date.now() },
    }));
  } catch {}
}

function logSwEvent(type, detail = {}) {
  try {
    bootLog(type, {
      path: String(window.location?.pathname || ''),
      epoch: APP_DATA_EPOCH,
      sourceLayer: 'vite_pwa_service_worker_register',
      ...detail,
    });
  } catch {}
}

async function unregisterAllServiceWorkersForKillMode() {
  if (!isSupported()) return { count: 0 };
  let regs = [];
  try { regs = await navigator.serviceWorker.getRegistrations(); } catch {}
  await Promise.allSettled((Array.isArray(regs) ? regs : []).map(async (reg) => {
    try { reg.waiting?.postMessage?.({ type: 'SKIP_WAITING' }); } catch {}
    try { reg.active?.postMessage?.({ type: 'SKIP_WAITING' }); } catch {}
    try { await reg.unregister(); } catch {}
  }));
  return { count: Array.isArray(regs) ? regs.length : 0 };
}

export default function ServiceWorkerRegister() {
  useEffect(() => {
    if (!isSupported()) {
      markRuntimeOwnerReady('vite_pwa_sw_not_supported');
      markRootRuntimeSettled('vite_pwa_sw_not_supported');
      return undefined;
    }

    if (isSwKillMode()) {
      let cancelled = false;
      void unregisterAllServiceWorkersForKillMode().then((info) => {
        if (cancelled) return;
        logSwEvent('vite_pwa_sw_kill_mode_active', { removed: Number(info?.count || 0) });
        markRuntimeOwnerReady('vite_pwa_sw_kill_mode');
        markRootRuntimeSettled('vite_pwa_sw_kill_mode');
      }).catch((error) => {
        if (cancelled) return;
        logSwEvent('vite_pwa_sw_kill_mode_error', { message: String(error?.message || error || 'sw_kill_mode_failed') });
        markRuntimeOwnerReady('vite_pwa_sw_kill_mode_error');
        markRootRuntimeSettled('vite_pwa_sw_kill_mode_error');
      });
      return () => { cancelled = true; };
    }

    let cancelled = false;
    let updateInterval = null;
    let unregisterVirtualSW = null;

    markRuntimeOwnerReady('vite_pwa_register_start');
    markRootRuntimeSettled('vite_pwa_register_start');

    try {
      unregisterVirtualSW = registerSW({
        immediate: true,
        onRegisteredSW(swUrl, registration) {
          if (cancelled) return;

          logSwEvent('vite_pwa_sw_registered', {
            swUrl: String(swUrl || ''),
            scope: String(registration?.scope || ''),
          });
          markRuntimeOwnerReady('vite_pwa_sw_registered');
          markRootRuntimeSettled('vite_pwa_sw_registered');

          if (registration?.update) {
            updateInterval = window.setInterval(() => {
              try {
                if (document.visibilityState === 'visible') {
                  void registration.update();
                  logSwEvent('vite_pwa_sw_update_check', { swUrl: String(swUrl || '') });
                }
              } catch (error) {
                logSwEvent('vite_pwa_sw_update_check_error', { message: String(error?.message || error || 'update_check_failed') });
              }
            }, UPDATE_CHECK_INTERVAL_MS);
          }
        },
        onRegisterError(error) {
          logSwEvent('vite_pwa_sw_register_error', { message: String(error?.message || error || 'sw_register_failed') });
          markRuntimeOwnerReady('vite_pwa_sw_register_error');
          markRootRuntimeSettled('vite_pwa_sw_register_error');
          try {
            if (incidentsEnabled() && typeof window.__TEPIHA_INLINE_INCIDENT__ === 'function') {
              window.__TEPIHA_INLINE_INCIDENT__('vite_pwa_sw_register_error', {
                source: 'vite_pwa_service_worker_register',
                path: String(window.location?.pathname || ''),
                message: String(error?.message || error || 'sw_register_failed'),
                appEpoch: APP_DATA_EPOCH,
              });
            }
          } catch {}
        },
        onOfflineReady() {
          logSwEvent('vite_pwa_sw_offline_ready');
          markRuntimeOwnerReady('vite_pwa_sw_offline_ready');
          markRootRuntimeSettled('vite_pwa_sw_offline_ready');
          try { window.__TEPIHA_PWA_OFFLINE_READY__ = true; } catch {}
          try {
            window.dispatchEvent(new CustomEvent('tepiha:pwa-offline-ready', {
              detail: { at: Date.now(), epoch: APP_DATA_EPOCH },
            }));
          } catch {}
        },
        onNeedRefresh() {
          logSwEvent('vite_pwa_sw_need_refresh');
          try {
            window.sessionStorage?.setItem?.('tepiha_vite_pwa_update_v1', JSON.stringify({
              at: new Date().toISOString(),
              path: String(window.location?.pathname || ''),
              epoch: APP_DATA_EPOCH,
            }));
          } catch {}

          try {
            if (typeof unregisterVirtualSW === 'function') {
              unregisterVirtualSW(true);
            }
          } catch (error) {
            logSwEvent('vite_pwa_sw_update_apply_error', { message: String(error?.message || error || 'update_apply_failed') });
          }
        },
      });
    } catch (error) {
      logSwEvent('vite_pwa_sw_register_throw', { message: String(error?.message || error || 'sw_register_throw') });
      markRuntimeOwnerReady('vite_pwa_sw_register_throw');
      markRootRuntimeSettled('vite_pwa_sw_register_throw');
    }

    return () => {
      cancelled = true;
      if (updateInterval) window.clearInterval(updateInterval);
    };
  }, []);

  return null;
}
