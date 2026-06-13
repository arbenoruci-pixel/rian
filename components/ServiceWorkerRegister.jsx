'use client';

import { useEffect, useRef } from 'react';
import { APP_DATA_EPOCH } from '@/lib/appEpoch';
import { bootLog } from '@/lib/bootLog';
import { isSafeModeDisabledUntil, safeModeLeftMs } from '@/lib/safeMode';

const CLEAN_LAUNCH_UPDATE_CHECK_DELAY_MS = 1400;
const VITE_SW_URL = '/vite-sw.js';
const PASSIVE_UPDATE_KEY = 'tepiha_update_available_v1';
const PASSIVE_UPDATE_EVENT = 'tepiha:update-available';
const MANUAL_UPDATE_TIMEOUT_MS = 15000;
const LEGACY_SW_DETECTED_EVENT = 'tepiha:legacy-sw-detected';
const LEGACY_REPAIR_TIMEOUT_MS = 9000;
const AUTO_UPDATE_SAVE_SETTLE_MS = 250;
const AUTO_UPDATE_RELOAD_FALLBACK_MS = 12000;
const AUTO_UPDATE_IN_PROGRESS_KEY = 'tepiha_pwa_auto_update_in_progress_v1';
const AUTO_UPDATE_SAVE_REQUEST_KEY = 'tepiha_pwa_auto_update_save_request_v1';
const AUTO_UPDATE_RELOAD_PARAM = '__tepiha_pwa_auto_update_reload';
const AUTO_UPDATE_SW_PREPARE_MESSAGE = 'TEPIHA_PWA_AUTO_UPDATE_PREPARE_RELOAD';
const AUTO_UPDATE_SW_RELOAD_MESSAGE = 'TEPIHA_PWA_AUTO_UPDATE_RELOAD_NOW';

function isBrowser() {
  return typeof window !== 'undefined' && typeof navigator !== 'undefined';
}

function isSupported() {
  try {
    return isBrowser() && 'serviceWorker' in navigator;
  } catch {
    return false;
  }
}

function isSwKillMode() {
  if (!isBrowser()) return false;

  try {
    return (
      (window.__TEPIHA_SW_KILL_SWITCH__ === true || window.__TEPIHA_FORCE_NETWORK_MODE__ === true) &&
      window.__TEPIHA_SW_KILL_SWITCH_EPOCH__ === APP_DATA_EPOCH &&
      window.__TEPIHA_SW_KILL_CONFIRM__ === 'YES'
    );
  } catch {
    return false;
  }
}

function shouldSkipUpdateChecksForSafeMode() {
  try {
    return isSafeModeDisabledUntil('disableUpdateChecksUntil');
  } catch {
    return false;
  }
}
function shouldShowVisualUpdateBanner() {
  try {
    const params = new URLSearchParams(window.location?.search || "");
    if (params.has("hideUpdateBanner")) return false;
  } catch {}
  return true;
}


function safeMessage(error, fallback = 'unknown_error') {
  try {
    if (error?.message) return String(error.message);
    if (error) return String(error);
    return fallback;
  } catch {
    return fallback;
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
    window.dispatchEvent(
      new CustomEvent('tepiha:runtime-owner-ready', {
        detail: { source, at: Date.now() },
      }),
    );
  } catch {}
}

function markRootRuntimeSettled(source = 'vite_pwa_register_settled') {
  try {
    window.__TEPIHA_ROOT_RUNTIME_SETTLED__ = true;
    window.dispatchEvent(
      new CustomEvent('tepiha:root-runtime-settled', {
        detail: { source, at: Date.now() },
      }),
    );
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

function reportInlineIncident(type, error, extra = {}) {
  try {
    if (!incidentsEnabled()) return;
    if (typeof window.__TEPIHA_INLINE_INCIDENT__ !== 'function') return;

    window.__TEPIHA_INLINE_INCIDENT__(type, {
      source: 'vite_pwa_service_worker_register',
      path: String(window.location?.pathname || ''),
      message: safeMessage(error, type),
      appEpoch: APP_DATA_EPOCH,
      ...extra,
    });
  } catch {}
}

async function unregisterAllServiceWorkersForKillMode() {
  return {
    count: 0,
    skipped: true,
    reason: 'update_flow_quarantine_v29_no_sw_unregister',
    noSkipWaiting: true,
    noCacheDelete: true,
    noReload: true,
  };
}

function setOfflineReadyFlag(source) {
  try {
    window.__TEPIHA_PWA_OFFLINE_READY__ = true;
  } catch {}

  try {
    window.dispatchEvent(
      new CustomEvent('tepiha:pwa-offline-ready', {
        detail: { at: Date.now(), epoch: APP_DATA_EPOCH, source },
      }),
    );
  } catch {}
}

function updateAvailablePayload(source = 'unknown', extra = {}) {
  const payload = {
    at: (() => { try { return new Date().toISOString(); } catch { return ''; } })(),
    ts: (() => { try { return Date.now(); } catch { return 0; } })(),
    source: String(source || 'unknown'),
    appEpoch: APP_DATA_EPOCH,
    passiveUpdate: false,
    autoReloadDisabled: false,
    manualUpdateOnly: false,
    autoUpdate: true,
    blockingUpdate: true,
    skipWaitingRequested: true,
    path: (() => { try { return String(window.location?.pathname || ''); } catch { return ''; } })(),
    href: (() => { try { return String(window.location?.href || ''); } catch { return ''; } })(),
    visibilityState: (() => { try { return String(document.visibilityState || ''); } catch { return ''; } })(),
    online: (() => { try { return navigator.onLine; } catch { return null; } })(),
    ...extra,
  };

  try { window.__TEPIHA_UPDATE_AVAILABLE__ = payload; } catch {}
  try { window.sessionStorage?.setItem?.('tepiha_update_available_last_v7', JSON.stringify(payload)); } catch {}
  try { window.dispatchEvent(new CustomEvent(PASSIVE_UPDATE_EVENT, { detail: payload })); } catch {}

  return payload;
}

function hidePassiveUpdateBanner() {
  try {
    const node = document.getElementById('tepiha-update-available-banner');
    if (node && node.parentNode) node.parentNode.removeChild(node);
    try { window.localStorage?.removeItem?.(PASSIVE_UPDATE_KEY); } catch {}
    try { window.sessionStorage?.removeItem?.("tepiha_vite_pwa_update_v1"); } catch {}
  } catch {}
}

function isLegacySwScriptURL(scriptURL) {
  try {
    const raw = String(scriptURL || '');
    if (!raw) return false;
    if (raw.includes(VITE_SW_URL)) return false;
    const url = new URL(raw, window.location.origin);
    return url.pathname === '/sw.js';
  } catch {
    return false;
  }
}

function readLegacyControllerPayload(source = 'service_worker_register') {
  try {
    const controller = navigator.serviceWorker?.controller || null;
    const scriptURL = String(controller?.scriptURL || '');
    if (!isLegacySwScriptURL(scriptURL)) return null;

    return {
      at: (() => { try { return new Date().toISOString(); } catch { return ''; } })(),
      ts: (() => { try { return Date.now(); } catch { return 0; } })(),
      source: String(source || 'service_worker_register'),
      sourceLayer: 'vite_pwa_service_worker_register',
      controllerScriptURL: scriptURL,
      legacyController: true,
      appEpoch: APP_DATA_EPOCH,
      path: (() => { try { return String(window.location?.pathname || ''); } catch { return ''; } })(),
      href: (() => { try { return String(window.location?.href || ''); } catch { return ''; } })(),
      autoReloadDisabled: false,
      autoRepairDisabled: false,
      autoUnregisterDisabled: true,
      autoCachePurgeDisabled: true,
      manualRepairOnly: false,
      autoUpdate: true,
      blockingUpdate: true,
    };
  } catch {
    return null;
  }
}

function markLegacyDetected(payload) {
  try { window.__TEPIHA_LEGACY_SW_DETECTED__ = payload; } catch {}
  try { window.localStorage?.setItem?.('tepiha_legacy_sw_detected_v1', JSON.stringify(payload)); } catch {}
  try { window.sessionStorage?.setItem?.('tepiha_legacy_sw_detected_v1', JSON.stringify(payload)); } catch {}
}

function postLegacyControllerMessage(type, detail = {}) {
  return Promise.resolve({
    ok: false,
    type: safeMessage(type, 'unknown'),
    skipped: true,
    reason: 'update_flow_quarantine_v29_no_controller_postmessage',
    noCacheDelete: true,
    noSwUnregister: true,
    noSkipWaiting: true,
    noReload: true,
    detailSource: safeMessage(detail?.source || '', ''),
  });
}

function hideLegacySwBanner() {
  try {
    const node = document.getElementById('tepiha-legacy-sw-bridge-banner');
    if (node && node.parentNode) node.parentNode.removeChild(node);
  } catch {}
}

function isPranimiActivePath(pathname = '') {
  try {
    const path = String(pathname || window.location?.pathname || '').toLowerCase();
    return path === '/pranimi' || path.startsWith('/pranimi/') || path === '/transport/pranimi' || path.startsWith('/transport/pranimi/');
  } catch {
    return false;
  }
}

function requestLocalWorkSnapshotBeforePwaReload(source = 'pwa_auto_update') {
  const detail = {
    at: (() => { try { return new Date().toISOString(); } catch { return ''; } })(),
    ts: (() => { try { return Date.now(); } catch { return 0; } })(),
    source: String(source || 'pwa_auto_update'),
    appEpoch: APP_DATA_EPOCH,
    path: (() => { try { return String(window.location?.pathname || ''); } catch { return ''; } })(),
    href: (() => { try { return String(window.location?.href || ''); } catch { return ''; } })(),
    pranimiActive: (() => { try { return isPranimiActivePath(window.location?.pathname || ''); } catch { return false; } })(),
    localOnlySnapshot: true,
    outboxPreserved: true,
    noStorageDelete: true,
    noCacheDelete: true,
    noSwUnregister: true,
  };

  try { window.__TEPIHA_PWA_AUTO_UPDATE_SAVE_REQUEST__ = detail; } catch {}
  try { window.sessionStorage?.setItem?.(AUTO_UPDATE_SAVE_REQUEST_KEY, JSON.stringify(detail)); } catch {}
  try { window.dispatchEvent(new CustomEvent('tepiha:pwa-auto-update-before-reload', { detail })); } catch {}

  if (detail.pranimiActive) {
    try { window.dispatchEvent(new Event('pagehide')); } catch {}
    try { window.dispatchEvent(new Event('beforeunload')); } catch {}
  }

  try {
    logSwEvent('vite_pwa_auto_update_local_snapshot_requested', detail);
  } catch {}

  return detail;
}

function markAutoUpdateStarted(source = 'unknown', payload = {}) {
  const detail = {
    at: (() => { try { return new Date().toISOString(); } catch { return ''; } })(),
    ts: (() => { try { return Date.now(); } catch { return 0; } })(),
    source: String(source || 'unknown'),
    appEpoch: APP_DATA_EPOCH,
    path: (() => { try { return String(window.location?.pathname || ''); } catch { return ''; } })(),
    href: (() => { try { return String(window.location?.href || ''); } catch { return ''; } })(),
    updateSource: safeMessage(payload?.source || '', ''),
    outboxPreserved: true,
    noCacheDelete: true,
    noSwUnregister: true,
  };

  let alreadyStarted = false;
  try { alreadyStarted = !!window.__TEPIHA_PWA_AUTO_UPDATE_STARTED__; } catch {}

  try {
    if (!alreadyStarted) window.__TEPIHA_PWA_AUTO_UPDATE_STARTED__ = detail;
  } catch {}

  try { window.sessionStorage?.setItem?.(AUTO_UPDATE_IN_PROGRESS_KEY, JSON.stringify(detail)); } catch {}

  try {
    logSwEvent(alreadyStarted ? 'vite_pwa_auto_update_already_started' : 'vite_pwa_auto_update_started', detail);
  } catch {}

  return { alreadyStarted, detail };
}

function showAutoUpdateOverlay(payload = {}) {
  try {
    if (!isBrowser()) return;
    if (typeof document === 'undefined') return;

    hidePassiveUpdateBanner();
    hideLegacySwBanner();

    let overlay = document.getElementById('tepiha-pwa-auto-update-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'tepiha-pwa-auto-update-overlay';
      overlay.setAttribute('data-pwa-auto-update-overlay', '1');
      overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;background:rgba(3,7,18,.96);color:#f8fafc;font-family:system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;padding:18px;text-align:center;pointer-events:auto';
      overlay.innerHTML = ''
        + '<div style="width:min(460px,100%);border:1px solid rgba(96,165,250,.42);border-radius:22px;background:linear-gradient(180deg,rgba(15,23,42,.98),rgba(2,6,23,.98));box-shadow:0 24px 75px rgba(0,0,0,.58);padding:22px">'
        + '<div style="width:42px;height:42px;border-radius:999px;border:4px solid rgba(147,197,253,.28);border-top-color:#93c5fd;margin:0 auto 14px;animation:tepihaPwaAutoUpdateSpin .85s linear infinite"></div>'
        + '<div style="font-size:21px;line-height:1.18;font-weight:1000">Duke marrë versionin e ri…</div>'
        + '<div id="tepiha-pwa-auto-update-status" style="margin-top:10px;font-size:12.5px;line-height:1.45;color:#bfdbfe;font-weight:800">Drafti dhe outbox ruhen lokalisht para rifreskimit.</div>'
        + '</div>';
      (document.body || document.documentElement).appendChild(overlay);
    }

    try { overlay.__TEPIHA_UPDATE_PAYLOAD__ = payload; } catch {}

    try {
      if (!document.getElementById('tepiha-pwa-auto-update-style')) {
        const style = document.createElement('style');
        style.id = 'tepiha-pwa-auto-update-style';
        style.textContent = '@keyframes tepihaPwaAutoUpdateSpin{to{transform:rotate(360deg)}}';
        (document.head || document.documentElement).appendChild(style);
      }
    } catch {}

    try {
      document.documentElement?.setAttribute?.('data-tepiha-pwa-auto-updating', '1');
      document.body?.setAttribute?.('data-tepiha-pwa-auto-updating', '1');
    } catch {}
  } catch (error) {
    logSwEvent('vite_pwa_auto_update_overlay_error', {
      message: safeMessage(error, 'auto_update_overlay_failed'),
    });
  }
}

function postSkipWaitingToWorker(worker, source = 'unknown', extra = {}) {
  try {
    if (!worker || typeof worker.postMessage !== 'function') return false;
    worker.postMessage({
      type: 'SKIP_WAITING',
      source: String(source || 'unknown'),
      appEpoch: APP_DATA_EPOCH,
      autoUpdate: true,
      outboxPreserved: true,
      noCacheDelete: true,
      noSwUnregister: true,
      ...extra,
    });
    logSwEvent('vite_pwa_auto_update_skip_waiting_posted', {
      source,
      workerState: String(worker?.state || ''),
      scriptURL: String(worker?.scriptURL || ''),
    });
    return true;
  } catch (error) {
    logSwEvent('vite_pwa_auto_update_skip_waiting_error', {
      source,
      message: safeMessage(error, 'skip_waiting_post_failed'),
    });
    return false;
  }
}

function bindControllerChangeReloadOnce(source = 'unknown') {
  try {
    if (!isSupported()) return false;
    if (window.__TEPIHA_PWA_CONTROLLER_RELOAD_BOUND__) return true;
    window.__TEPIHA_PWA_CONTROLLER_RELOAD_BOUND__ = true;

    navigator.serviceWorker.addEventListener('controllerchange', () => {
      try {
        if (window.__TEPIHA_PWA_CONTROLLER_RELOAD_DONE__) return;
        window.__TEPIHA_PWA_CONTROLLER_RELOAD_DONE__ = true;
        showAutoUpdateOverlay({ source: 'controllerchange', appEpoch: APP_DATA_EPOCH });
        requestLocalWorkSnapshotBeforePwaReload(`${source}:controllerchange_reload`);
        logSwEvent('vite_pwa_auto_update_controllerchange_reload', { source });
        window.setTimeout(() => {
          try { window.location.reload(); } catch {}
        }, 120);
      } catch (error) {
        logSwEvent('vite_pwa_auto_update_controllerchange_reload_error', {
          source,
          message: safeMessage(error, 'controllerchange_reload_failed'),
        });
      }
    });

    logSwEvent('vite_pwa_auto_update_controllerchange_bound', { source });
    return true;
  } catch (error) {
    logSwEvent('vite_pwa_auto_update_controllerchange_bind_error', {
      source,
      message: safeMessage(error, 'controllerchange_bind_failed'),
    });
    return false;
  }
}

function scheduleAutoUpdateFallbackReload(source = 'unknown') {
  try {
    if (!isBrowser()) return false;
    if (window.__TEPIHA_PWA_AUTO_UPDATE_FALLBACK_TIMER__) return true;

    window.__TEPIHA_PWA_AUTO_UPDATE_FALLBACK_TIMER__ = window.setTimeout(() => {
      try {
        if (window.__TEPIHA_PWA_CONTROLLER_RELOAD_DONE__) return;
        window.__TEPIHA_PWA_CONTROLLER_RELOAD_DONE__ = true;
        showAutoUpdateOverlay({ source: 'fallback_reload', appEpoch: APP_DATA_EPOCH });
        requestLocalWorkSnapshotBeforePwaReload(`${source}:fallback_reload`);
        logSwEvent('vite_pwa_auto_update_fallback_reload', {
          source,
          delayMs: AUTO_UPDATE_RELOAD_FALLBACK_MS,
        });
        window.location.reload();
      } catch (error) {
        logSwEvent('vite_pwa_auto_update_fallback_reload_error', {
          source,
          message: safeMessage(error, 'fallback_reload_failed'),
        });
      }
    }, AUTO_UPDATE_RELOAD_FALLBACK_MS);

    logSwEvent('vite_pwa_auto_update_fallback_reload_scheduled', {
      source,
      delayMs: AUTO_UPDATE_RELOAD_FALLBACK_MS,
    });
    return true;
  } catch (error) {
    logSwEvent('vite_pwa_auto_update_fallback_schedule_error', {
      source,
      message: safeMessage(error, 'fallback_schedule_failed'),
    });
    return false;
  }
}


function removeAutoUpdateReloadParam(source = 'unknown') {
  try {
    if (!isBrowser()) return false;
    const url = new URL(window.location.href);
    if (!url.searchParams.has(AUTO_UPDATE_RELOAD_PARAM)) return false;
    url.searchParams.delete(AUTO_UPDATE_RELOAD_PARAM);
    window.history.replaceState(window.history.state || {}, '', url.toString());
    logSwEvent('vite_pwa_auto_update_reload_param_removed', { source });
    return true;
  } catch (error) {
    logSwEvent('vite_pwa_auto_update_reload_param_remove_error', {
      source,
      message: safeMessage(error, 'reload_param_remove_failed'),
    });
    return false;
  }
}

function safeUpdateRegistration(registration, source, swUrl = '') {
  try {
    if (shouldSkipUpdateChecksForSafeMode()) {
      logSwEvent('vite_pwa_sw_update_check_skip_safe_mode', {
        source,
        swUrl: String(swUrl || ''),
        leftMs: safeModeLeftMs('disableUpdateChecksUntil'),
      });
      return false;
    }

    if (!registration || typeof registration.update !== 'function') {
      logSwEvent('vite_pwa_sw_update_registration_missing', {
        source,
        swUrl: String(swUrl || ''),
      });
      return false;
    }

    let updatePromise = null;

    try {
      updatePromise = registration.update();
    } catch (error) {
      logSwEvent('vite_pwa_sw_update_check_throw', {
        source,
        swUrl: String(swUrl || ''),
        message: safeMessage(error, 'update_check_throw'),
      });
      return false;
    }

    Promise.resolve(updatePromise)
      .then(() => {
        logSwEvent('vite_pwa_sw_update_check_ok', {
          source,
          swUrl: String(swUrl || ''),
          scope: String(registration?.scope || ''),
        });
      })
      .catch((error) => {
        logSwEvent('vite_pwa_sw_update_check_error', {
          source,
          swUrl: String(swUrl || ''),
          message: safeMessage(error, 'update_check_failed'),
        });
      });

    return true;
  } catch (error) {
    logSwEvent('vite_pwa_sw_update_check_outer_error', {
      source,
      swUrl: String(swUrl || ''),
      message: safeMessage(error, 'update_check_outer_error'),
    });
    return false;
  }
}

function safeApplyViteUpdate(updateSW, reloadPage, source) {
  try {
    if (typeof updateSW !== 'function') {
      logSwEvent('vite_pwa_sw_update_apply_missing', {
        source,
        requestedReloadPage: Boolean(reloadPage),
      });
      return false;
    }

    const result = updateSW(Boolean(reloadPage));
    Promise.resolve(result).catch((error) => {
      logSwEvent('vite_pwa_sw_update_apply_error', {
        source,
        requestedReloadPage: Boolean(reloadPage),
        message: safeMessage(error, 'update_apply_failed'),
      });
    });

    logSwEvent('vite_pwa_sw_update_apply_requested', {
      source,
      requestedReloadPage: Boolean(reloadPage),
      skipWaitingRequested: true,
      controllerchangeReloadBound: true,
      noCacheDelete: true,
      noSwUnregister: true,
    });
    return true;
  } catch (error) {
    logSwEvent('vite_pwa_sw_update_apply_throw', {
      source,
      requestedReloadPage: Boolean(reloadPage),
      message: safeMessage(error, 'update_apply_throw'),
    });
    return false;
  }
}

function buildRegisterOptions({
  cancelledRef,
  registrationRef,
  updateSWRef,
  installCleanLaunchUpdateCheck,
  startManualFallback,
  showPassiveUpdateBanner,
  applyReadyServiceWorkerUpdate,
  wireRegistrationAutoUpdate,
}) {
  const options = {
    immediate: true,

    onRegisteredSW(swUrl, registration) {
      try {
        if (cancelledRef.current) return;

        if (registration && typeof registration.update === 'function') {
          registrationRef.current = registration;
        } else {
          registrationRef.current = null;
        }

        logSwEvent('vite_pwa_sw_registered', {
          swUrl: String(swUrl || ''),
          scope: String(registration?.scope || ''),
          hasRegistrationUpdate: typeof registration?.update === 'function',
        });

        markRuntimeOwnerReady('vite_pwa_sw_registered');
        markRootRuntimeSettled('vite_pwa_sw_registered');

        installCleanLaunchUpdateCheck('virtual_pwa_register', swUrl);

        try {
          if (typeof wireRegistrationAutoUpdate === 'function') {
            wireRegistrationAutoUpdate(registration, 'virtual_pwa_register', swUrl);
          }
        } catch {}
      } catch (error) {
        logSwEvent('vite_pwa_sw_registered_callback_error', {
          message: safeMessage(error, 'registered_callback_failed'),
        });
      }
    },

    onRegisterError(error) {
      try {
        logSwEvent('vite_pwa_sw_register_error', {
          message: safeMessage(error, 'sw_register_failed'),
        });

        markRuntimeOwnerReady('vite_pwa_sw_register_error');
        markRootRuntimeSettled('vite_pwa_sw_register_error');
        reportInlineIncident('vite_pwa_sw_register_error', error);

        void startManualFallback('onRegisterError', error);
      } catch {}
    },

    onOfflineReady() {
      try {
        logSwEvent('vite_pwa_sw_offline_ready');
        markRuntimeOwnerReady('vite_pwa_sw_offline_ready');
        markRootRuntimeSettled('vite_pwa_sw_offline_ready');
        setOfflineReadyFlag('virtual_pwa_register');
      } catch (error) {
        logSwEvent('vite_pwa_sw_offline_ready_callback_error', {
          message: safeMessage(error, 'offline_ready_callback_failed'),
        });
      }
    },

    onNeedRefresh() {
      try {
        const payload = updateAvailablePayload('onNeedRefresh', {
          hasApplyUpdate: typeof updateSWRef.current === 'function',
          note: 'Service Worker found a new version. Auto update will apply after local work snapshot.',
        });

        logSwEvent('vite_pwa_sw_need_refresh_passive', payload);

        try {
          window.sessionStorage?.setItem?.(
            'tepiha_vite_pwa_update_v1',
            JSON.stringify(payload),
          );
        } catch {}

        try {
          if (typeof showPassiveUpdateBanner === 'function') {
            showPassiveUpdateBanner(payload);
          }
        } catch {}

        try {
          if (typeof applyReadyServiceWorkerUpdate === 'function') {
            void applyReadyServiceWorkerUpdate('onNeedRefresh', payload);
          }
        } catch {}
      } catch (error) {
        logSwEvent('vite_pwa_sw_need_refresh_callback_error', {
          message: safeMessage(error, 'need_refresh_callback_failed'),
        });
      }
    },
  };

  return options;
}

export default function ServiceWorkerRegister() {
  const cancelledRef = useRef(false);
  const registrationRef = useRef(null);
  const updateSWRef = useRef(null);
  const cleanupCleanLaunchUpdateCheckRef = useRef(null);

  useEffect(() => {
    cancelledRef.current = false;

    if (!isSupported()) {
      markRuntimeOwnerReady('vite_pwa_sw_not_supported');
      markRootRuntimeSettled('vite_pwa_sw_not_supported');
      return undefined;
    }

    let manualFallbackStarted = false;

    removeAutoUpdateReloadParam('service_worker_register_mount');
    bindControllerChangeReloadOnce('service_worker_register_mount');

    const onServiceWorkerAutoUpdateMessage = (event) => {
      try {
        const data = event?.data || {};
        const type = String(data?.type || '');
        if (type !== AUTO_UPDATE_SW_PREPARE_MESSAGE && type !== AUTO_UPDATE_SW_RELOAD_MESSAGE) return;
        const payload = updateAvailablePayload(type === AUTO_UPDATE_SW_PREPARE_MESSAGE ? 'sw_prepare_reload_message' : 'sw_reload_now_message', {
          messageType: type,
          swVersion: safeMessage(data?.swVersion || '', ''),
          swEpoch: safeMessage(data?.swEpoch || '', ''),
          swReason: safeMessage(data?.reason || '', ''),
          forcedByServiceWorker: true,
        });
        showAutoUpdateOverlay(payload);
        requestLocalWorkSnapshotBeforePwaReload(`service_worker_message:${type}`);
        if (type === AUTO_UPDATE_SW_RELOAD_MESSAGE && !window.__TEPIHA_PWA_CONTROLLER_RELOAD_DONE__) {
          window.__TEPIHA_PWA_CONTROLLER_RELOAD_DONE__ = true;
          window.setTimeout(() => {
            try { window.location.reload(); } catch {}
          }, 180);
        }
      } catch (error) {
        logSwEvent('vite_pwa_auto_update_sw_message_error', {
          message: safeMessage(error, 'sw_message_handler_failed'),
        });
      }
    };

    try { navigator.serviceWorker.addEventListener('message', onServiceWorkerAutoUpdateMessage); } catch {}

    const clearCleanLaunchUpdateCheck = () => {
      try {
        if (typeof cleanupCleanLaunchUpdateCheckRef.current === 'function') {
          cleanupCleanLaunchUpdateCheckRef.current();
        }
      } catch {}

      cleanupCleanLaunchUpdateCheckRef.current = null;
    };

    async function resolveCurrentRegistration(source = 'unknown') {
      let registration = registrationRef.current;

      try {
        if (!registration && typeof navigator.serviceWorker?.getRegistration === 'function') {
          registration = await navigator.serviceWorker.getRegistration();
        }
      } catch (error) {
        logSwEvent('vite_pwa_auto_update_get_registration_error', {
          source,
          message: safeMessage(error, 'get_registration_failed'),
        });
      }

      try {
        const controllerScriptURL = String(navigator.serviceWorker?.controller?.scriptURL || '');
        const activeScriptURL = String(registration?.active?.scriptURL || '');
        const legacyController = isLegacySwScriptURL(controllerScriptURL) || isLegacySwScriptURL(activeScriptURL);
        if (legacyController && typeof navigator.serviceWorker?.register === 'function') {
          logSwEvent('legacy_sw_bridge_auto_register_vite_start', {
            source,
            controllerScriptURL,
            activeScriptURL,
            noCacheDelete: true,
            noSwUnregister: true,
          });
          const replacement = await navigator.serviceWorker.register(VITE_SW_URL, {
            scope: '/',
            updateViaCache: 'none',
          });
          if (replacement) registration = replacement;
          logSwEvent('legacy_sw_bridge_auto_register_vite_ok', {
            source,
            scope: String(replacement?.scope || ''),
            waiting: Boolean(replacement?.waiting),
            installing: Boolean(replacement?.installing),
            active: Boolean(replacement?.active),
          });
        }
      } catch (error) {
        logSwEvent('legacy_sw_bridge_auto_register_vite_error', {
          source,
          message: safeMessage(error, 'legacy_auto_register_failed'),
        });
      }

      try {
        if (registration && typeof registration.update === 'function') {
          registrationRef.current = registration;
        }
      } catch {}

      return registration || null;
    }

    function trackInstallingWorker(worker, source = 'unknown', payload = {}) {
      try {
        if (!worker || worker.__TEPIHA_AUTO_UPDATE_BOUND__) return;
        worker.__TEPIHA_AUTO_UPDATE_BOUND__ = true;

        worker.addEventListener('statechange', () => {
          try {
            const state = String(worker.state || '');
            logSwEvent('vite_pwa_auto_update_worker_statechange', {
              source,
              state,
              scriptURL: String(worker.scriptURL || ''),
            });

            if (state === 'installed' || state === 'activated') {
              const hasController = Boolean(navigator.serviceWorker?.controller);
              if (!hasController && state === 'installed') return;

              const nextPayload = updateAvailablePayload(`${source}:worker_${state}`, {
                ...payload,
                workerState: state,
                scriptURL: String(worker.scriptURL || ''),
                hasController,
              });
              showAutoUpdateOverlay(nextPayload);
              void applyReadyServiceWorkerUpdate(`${source}:worker_${state}`, nextPayload);
            }
          } catch (error) {
            logSwEvent('vite_pwa_auto_update_worker_statechange_error', {
              source,
              message: safeMessage(error, 'worker_statechange_failed'),
            });
          }
        });
      } catch (error) {
        logSwEvent('vite_pwa_auto_update_track_installing_error', {
          source,
          message: safeMessage(error, 'track_installing_failed'),
        });
      }
    }

    async function tryApplyWaitingWorker(source = 'unknown', payload = {}) {
      const registration = await resolveCurrentRegistration(source);

      try {
        if (registration?.waiting) {
          requestLocalWorkSnapshotBeforePwaReload(`${source}:before_skip_waiting`);
          bindControllerChangeReloadOnce(source);
          const posted = postSkipWaitingToWorker(registration.waiting, source, {
            payloadSource: safeMessage(payload?.source || '', ''),
          });
          if (typeof updateSWRef.current === 'function') {
            safeApplyViteUpdate(updateSWRef.current, true, `${source}:updateSW_after_waiting`);
          }
          scheduleAutoUpdateFallbackReload(source);
          return posted || true;
        }

        if (registration?.installing) {
          trackInstallingWorker(registration.installing, `${source}:installing`, payload);
        }

        if (typeof updateSWRef.current === 'function') {
          requestLocalWorkSnapshotBeforePwaReload(`${source}:before_updateSW`);
          bindControllerChangeReloadOnce(source);
          const applied = safeApplyViteUpdate(updateSWRef.current, true, `${source}:updateSW`);
          if (applied) scheduleAutoUpdateFallbackReload(source);
          return applied;
        }

        logSwEvent('vite_pwa_auto_update_no_waiting_worker_yet', {
          source,
          hasRegistration: Boolean(registration),
          waiting: Boolean(registration?.waiting),
          installing: Boolean(registration?.installing),
          hasUpdateSW: typeof updateSWRef.current === 'function',
        });
        return false;
      } catch (error) {
        logSwEvent('vite_pwa_auto_update_try_apply_error', {
          source,
          message: safeMessage(error, 'try_apply_waiting_failed'),
        });
        return false;
      }
    }

    async function applyReadyServiceWorkerUpdate(source = 'unknown', payload = {}) {
      try {
        if (cancelledRef.current) return false;
        markAutoUpdateStarted(source, payload);
        showAutoUpdateOverlay(payload);
        bindControllerChangeReloadOnce(source);
        requestLocalWorkSnapshotBeforePwaReload(`${source}:start`);

        await new Promise((resolve) => {
          try { window.setTimeout(resolve, AUTO_UPDATE_SAVE_SETTLE_MS); } catch { resolve(); }
        });

        let applied = await tryApplyWaitingWorker(source, payload);
        if (applied) return true;

        const registration = await resolveCurrentRegistration(`${source}:after_initial_try`);
        if (registration?.installing) {
          trackInstallingWorker(registration.installing, `${source}:after_initial_try`, payload);
        }

        if (registration && typeof registration.update === 'function') {
          safeUpdateRegistration(registration, `${source}:auto_update_check`, VITE_SW_URL);
          await new Promise((resolve) => {
            try { window.setTimeout(resolve, 350); } catch { resolve(); }
          });
          applied = await tryApplyWaitingWorker(`${source}:after_update_check`, payload);
          if (applied) return true;
        }

        scheduleAutoUpdateFallbackReload(source);
        return false;
      } catch (error) {
        logSwEvent('vite_pwa_auto_update_apply_ready_error', {
          source,
          message: safeMessage(error, 'apply_ready_update_failed'),
        });
        scheduleAutoUpdateFallbackReload(source);
        return false;
      }
    }

    function wireRegistrationAutoUpdate(registration, source = 'unknown', swUrl = '') {
      try {
        if (!registration) return;
        if (typeof registration.update === 'function') registrationRef.current = registration;
        bindControllerChangeReloadOnce(`${source}:wire`);

        if (registration.waiting) {
          const payload = updateAvailablePayload(`${source}:waiting`, {
            swUrl: String(swUrl || ''),
            registrationScope: String(registration.scope || ''),
            hasApplyUpdate: typeof updateSWRef.current === 'function',
          });
          showAutoUpdateOverlay(payload);
          void applyReadyServiceWorkerUpdate(`${source}:waiting`, payload);
        }

        if (registration.installing) {
          trackInstallingWorker(registration.installing, `${source}:initial_installing`, { swUrl: String(swUrl || '') });
        }

        if (!registration.__TEPIHA_AUTO_UPDATEFOUND_BOUND__ && typeof registration.addEventListener === 'function') {
          registration.__TEPIHA_AUTO_UPDATEFOUND_BOUND__ = true;
          registration.addEventListener('updatefound', () => {
            try {
              const worker = registration.installing;
              logSwEvent('vite_pwa_auto_updatefound', {
                source,
                swUrl: String(swUrl || ''),
                scope: String(registration.scope || ''),
                workerState: String(worker?.state || ''),
              });
              if (worker) trackInstallingWorker(worker, `${source}:updatefound`, { swUrl: String(swUrl || '') });
            } catch (error) {
              logSwEvent('vite_pwa_auto_updatefound_error', {
                source,
                message: safeMessage(error, 'updatefound_handler_failed'),
              });
            }
          });
        }
      } catch (error) {
        logSwEvent('vite_pwa_auto_update_wire_registration_error', {
          source,
          swUrl: String(swUrl || ''),
          message: safeMessage(error, 'wire_registration_failed'),
        });
      }
    }

    const showPassiveUpdateBanner = (payload = {}) => {
      try {
        if (cancelledRef.current) return;
        showAutoUpdateOverlay(payload);
      } catch (error) {
        logSwEvent('vite_pwa_sw_update_overlay_error', {
          message: safeMessage(error, 'update_overlay_failed'),
        });
      }
    };

    const onPassiveUpdateAvailable = (event) => {
      try {
        const payload = event?.detail && typeof event.detail === 'object' ? event.detail : updateAvailablePayload('update_event_without_detail');
        showPassiveUpdateBanner(payload);
        void applyReadyServiceWorkerUpdate('update_available_event', payload);
      } catch {}
    };

    try {
      window.addEventListener(PASSIVE_UPDATE_EVENT, onPassiveUpdateAvailable);
    } catch {}

    try {
      window.localStorage?.removeItem?.(PASSIVE_UPDATE_KEY);
      window.sessionStorage?.removeItem?.("tepiha_vite_pwa_update_v1");
    } catch {}

    const showLegacySwBanner = (payload = {}) => {
      try {
        if (cancelledRef.current) return;
        const currentPayload = payload && payload.legacyController
          ? payload
          : readLegacyControllerPayload('legacy_banner_check');
        if (!currentPayload?.legacyController) {
          hideLegacySwBanner();
          return;
        }

        const nextPayload = updateAvailablePayload('legacy_sw_auto_update', {
          ...currentPayload,
          legacyController: true,
          note: 'Legacy service worker detected; registering vite service worker and applying update automatically.',
        });
        markLegacyDetected(nextPayload);
        showAutoUpdateOverlay(nextPayload);
        void applyReadyServiceWorkerUpdate('legacy_sw_auto_update', nextPayload);
      } catch (error) {
        logSwEvent('legacy_sw_bridge_auto_update_error', {
          message: safeMessage(error, 'legacy_auto_update_failed'),
        });
      }
    };

    const onLegacySwDetected = (event) => {
      try {
        const payload = event?.detail && typeof event.detail === 'object'
          ? event.detail
          : readLegacyControllerPayload('legacy_event_without_detail');
        if (payload?.legacyController) showLegacySwBanner(payload);
      } catch {}
    };

    try {
      window.addEventListener(LEGACY_SW_DETECTED_EVENT, onLegacySwDetected);
    } catch {}

    try {
      const initialLegacyPayload = readLegacyControllerPayload('service_worker_register_mount');
      if (initialLegacyPayload?.legacyController) {
        logSwEvent('legacy_sw_bridge_detected_passive', initialLegacyPayload);
        showLegacySwBanner(initialLegacyPayload);
      }
    } catch {}

    const recoverRegistrationAndUpdate = (source, swUrl = '') => {
      try {
        if (cancelledRef.current) return;
        if (typeof navigator.serviceWorker?.getRegistration !== 'function') return;

        Promise.resolve(navigator.serviceWorker.getRegistration())
          .then((registration) => {
            try {
              if (cancelledRef.current) return;

              if (registration && typeof registration.update === 'function') {
                registrationRef.current = registration;
                wireRegistrationAutoUpdate(registration, `${source}:recovered`, swUrl);
                safeUpdateRegistration(registration, `${source}:recovered`, swUrl);
              } else {
                logSwEvent('vite_pwa_sw_update_registration_missing_after_recover', {
                  source,
                  swUrl: String(swUrl || ''),
                });
              }
            } catch (error) {
              logSwEvent('vite_pwa_sw_update_recover_handler_error', {
                source,
                swUrl: String(swUrl || ''),
                message: safeMessage(error, 'update_recover_handler_failed'),
              });
            }
          })
          .catch((error) => {
            logSwEvent('vite_pwa_sw_update_recover_error', {
              source,
              swUrl: String(swUrl || ''),
              message: safeMessage(error, 'update_recover_failed'),
            });
          });
      } catch (error) {
        logSwEvent('vite_pwa_sw_update_recover_throw', {
          source,
          swUrl: String(swUrl || ''),
          message: safeMessage(error, 'update_recover_throw'),
        });
      }
    };

    const checkForUpdate = (source, reason, swUrl = '') => {
      try {
        if (cancelledRef.current) return;
        if (shouldSkipUpdateChecksForSafeMode()) {
          logSwEvent('vite_pwa_sw_update_check_skip_safe_mode', {
            source,
            reason,
            swUrl: String(swUrl || ''),
            leftMs: safeModeLeftMs('disableUpdateChecksUntil'),
          });
          return;
        }

        try {
          if (document.visibilityState !== 'visible') return;
        } catch {}

        const registration = registrationRef.current;

        if (registration && typeof registration.update === 'function') {
          wireRegistrationAutoUpdate(registration, `${source}:${reason}`, swUrl);
          safeUpdateRegistration(registration, `${source}:${reason}`, swUrl);
          return;
        }

        logSwEvent('vite_pwa_sw_update_registration_missing', {
          source: `${source}:${reason}`,
          swUrl: String(swUrl || ''),
          hasUpdateSW: typeof updateSWRef.current === 'function',
        });

        recoverRegistrationAndUpdate(`${source}:${reason}`, swUrl);
      } catch (error) {
        logSwEvent('vite_pwa_sw_update_check_handler_error', {
          source,
          reason,
          swUrl: String(swUrl || ''),
          message: safeMessage(error, 'update_check_handler_failed'),
        });
      }
    };

    const readNavigationType = () => {
      try {
        const entries = typeof performance?.getEntriesByType === 'function'
          ? performance.getEntriesByType('navigation')
          : [];
        return String(entries?.[0]?.type || 'navigate');
      } catch {
        return 'navigate';
      }
    };

    const isManualUpdateLaunch = () => {
      try {
        const sp = new URLSearchParams(window.location?.search || '');
        if (sp.has('__manual_update')) return true;
        if (sp.get('pwaRepair') === '1' || sp.get('pwa_repair') === '1' || sp.get('repairPwa') === '1') return true;
      } catch {}

      try {
        const raw = window.sessionStorage?.getItem?.('tepiha_manual_update_requested_v1') || '';
        if (raw) return true;
      } catch {}

      return false;
    };

    const shouldRunCleanLaunchUpdateCheck = () => {
      try {
        if (cancelledRef.current) return false;
        if (document.visibilityState && document.visibilityState !== 'visible') return false;
      } catch {}

      if (isManualUpdateLaunch()) return true;

      const navType = readNavigationType();
      if (navType === 'back_forward') return false;

      try {
        const key = `tepiha_clean_launch_sw_update_check_v4:${APP_DATA_EPOCH}`;
        if (window.sessionStorage?.getItem?.(key) === '1') return false;
        window.sessionStorage?.setItem?.(key, '1');
      } catch {}

      return navType === 'navigate' || navType === 'reload' || navType === '';
    };

    const installCleanLaunchUpdateCheck = (source, swUrl = '') => {
      try {
        clearCleanLaunchUpdateCheck();
        if (shouldSkipUpdateChecksForSafeMode()) {
          logSwEvent('vite_pwa_sw_clean_launch_update_skip_safe_mode', {
            source,
            swUrl: String(swUrl || ''),
            leftMs: safeModeLeftMs('disableUpdateChecksUntil'),
          });
          cleanupCleanLaunchUpdateCheckRef.current = () => {};
          return;
        }

        let timerId = null;
        const allowed = shouldRunCleanLaunchUpdateCheck();

        if (allowed) {
          try {
            timerId = window.setTimeout(() => {
              checkForUpdate(source, isManualUpdateLaunch() ? 'manual_update_launch_once' : 'clean_launch_once', swUrl);
            }, CLEAN_LAUNCH_UPDATE_CHECK_DELAY_MS);
          } catch (error) {
            logSwEvent('vite_pwa_sw_clean_launch_timer_error', {
              source,
              swUrl: String(swUrl || ''),
              message: safeMessage(error, 'clean_launch_timer_failed'),
            });
          }
        }

        cleanupCleanLaunchUpdateCheckRef.current = () => {
          try {
            if (timerId !== null) window.clearTimeout(timerId);
          } catch {}
        };

        logSwEvent('vite_pwa_sw_clean_launch_update_check_ready', {
          source,
          swUrl: String(swUrl || ''),
          allowed,
          navigationType: readNavigationType(),
          manualUpdateLaunch: isManualUpdateLaunch(),
          hasRegistrationUpdate: typeof registrationRef.current?.update === 'function',
          hasUpdateSW: typeof updateSWRef.current === 'function',
          delayMs: CLEAN_LAUNCH_UPDATE_CHECK_DELAY_MS,
          noVisibilityUpdateChecks: true,
          noIntervalUpdateChecks: true,
        });
      } catch (error) {
        logSwEvent('vite_pwa_sw_clean_launch_update_setup_error', {
          source,
          swUrl: String(swUrl || ''),
          message: safeMessage(error, 'clean_launch_update_setup_failed'),
        });
      }
    };

    const startManualFallback = async (reason = 'unknown', originalError = null) => {
      if (manualFallbackStarted || cancelledRef.current) return null;
      manualFallbackStarted = true;

      try {
        logSwEvent('vite_pwa_manual_register_start', {
          reason: String(reason || 'unknown'),
          previousMessage: safeMessage(originalError, ''),
        });

        const registration = await navigator.serviceWorker.register(VITE_SW_URL, {
          scope: '/',
          updateViaCache: 'none',
        });

        if (cancelledRef.current) return registration;

        if (registration && typeof registration.update === 'function') {
          registrationRef.current = registration;
        } else {
          registrationRef.current = null;
        }

        logSwEvent('vite_pwa_manual_register_ok', {
          scope: String(registration?.scope || ''),
          active: Boolean(registration?.active),
          waiting: Boolean(registration?.waiting),
          installing: Boolean(registration?.installing),
          hasRegistrationUpdate: typeof registration?.update === 'function',
        });

        markRuntimeOwnerReady('vite_pwa_manual_register_ok');
        markRootRuntimeSettled('vite_pwa_manual_register_ok');
        setOfflineReadyFlag('manual_fallback_register');

        installCleanLaunchUpdateCheck('manual_fallback_register', VITE_SW_URL);
        wireRegistrationAutoUpdate(registration, 'manual_fallback_register', VITE_SW_URL);

        return registration;
      } catch (error) {
        if (cancelledRef.current) return null;

        registrationRef.current = null;

        logSwEvent('vite_pwa_manual_register_error', {
          reason: String(reason || 'unknown'),
          message: safeMessage(error, 'manual_register_failed'),
        });

        reportInlineIncident('vite_pwa_manual_register_error', error, {
          reason: String(reason || 'unknown'),
        });

        markRuntimeOwnerReady('vite_pwa_manual_register_error');
        markRootRuntimeSettled('vite_pwa_manual_register_error');

        return null;
      }
    };

    async function start() {
      if (isSwKillMode()) {
        try {
          const info = await unregisterAllServiceWorkersForKillMode();

          if (cancelledRef.current) return;

          registrationRef.current = null;
          updateSWRef.current = null;

          logSwEvent('vite_pwa_sw_kill_mode_active', {
            removed: Number(info?.count || 0),
          });

          markRuntimeOwnerReady('vite_pwa_sw_kill_mode');
          markRootRuntimeSettled('vite_pwa_sw_kill_mode');
        } catch (error) {
          if (cancelledRef.current) return;

          logSwEvent('vite_pwa_sw_kill_mode_error', {
            message: safeMessage(error, 'sw_kill_mode_failed'),
          });

          markRuntimeOwnerReady('vite_pwa_sw_kill_mode_error');
          markRootRuntimeSettled('vite_pwa_sw_kill_mode_error');
        }

        return;
      }

      markRuntimeOwnerReady('vite_pwa_register_start');
      markRootRuntimeSettled('vite_pwa_register_start');

      try {
        let virtualPwaModule = null;

        try {
          virtualPwaModule = await import('virtual:pwa-register');
        } catch (error) {
          if (cancelledRef.current) return;

          updateSWRef.current = null;
          registrationRef.current = null;

          logSwEvent('vite_pwa_virtual_import_error', {
            message: safeMessage(error, 'virtual_pwa_register_import_failed'),
          });

          reportInlineIncident('vite_pwa_virtual_import_error', error);

          markRuntimeOwnerReady('vite_pwa_virtual_import_error');
          markRootRuntimeSettled('vite_pwa_virtual_import_error');

          await startManualFallback('virtual_import_error', error);
          return;
        }

        if (cancelledRef.current) return;

        const registerSW =
          typeof virtualPwaModule?.registerSW === 'function'
            ? virtualPwaModule.registerSW
            : typeof virtualPwaModule?.default === 'function'
              ? virtualPwaModule.default
              : null;

        if (typeof registerSW !== 'function') {
          updateSWRef.current = null;
          registrationRef.current = null;

          logSwEvent('vite_pwa_registersw_missing', {
            moduleKeys: virtualPwaModule ? Object.keys(virtualPwaModule).join(',') : '',
          });

          markRuntimeOwnerReady('vite_pwa_registersw_missing');
          markRootRuntimeSettled('vite_pwa_registersw_missing');

          await startManualFallback('registersw_missing');
          return;
        }

        const registerOptions = buildRegisterOptions({
          cancelledRef,
          registrationRef,
          updateSWRef,
          installCleanLaunchUpdateCheck,
          startManualFallback,
          showPassiveUpdateBanner,
          applyReadyServiceWorkerUpdate,
          wireRegistrationAutoUpdate,
        });

        try {
          const result = registerSW(registerOptions || {});

          if (typeof result === 'function') {
            updateSWRef.current = result;
          } else {
            updateSWRef.current = null;
          }

          logSwEvent('vite_pwa_register_call_ok', {
            hasApplyUpdate: typeof updateSWRef.current === 'function',
            hasRegistrationUpdate: typeof registrationRef.current?.update === 'function',
          });

          try {
            if (registrationRef.current) {
              wireRegistrationAutoUpdate(registrationRef.current, 'register_call_ok', VITE_SW_URL);
            }
          } catch {}

          markRuntimeOwnerReady('vite_pwa_register_call_ok');
          markRootRuntimeSettled('vite_pwa_register_call_ok');
        } catch (error) {
          if (cancelledRef.current) return;

          updateSWRef.current = null;
          registrationRef.current = null;

          logSwEvent('vite_pwa_register_throw', {
            message: safeMessage(error, 'sw_register_throw'),
          });

          reportInlineIncident('vite_pwa_register_throw', error);

          markRuntimeOwnerReady('vite_pwa_register_throw');
          markRootRuntimeSettled('vite_pwa_register_throw');

          await startManualFallback('registersw_throw', error);
        }
      } catch (error) {
        if (cancelledRef.current) return;

        updateSWRef.current = null;
        registrationRef.current = null;

        logSwEvent('vite_pwa_register_outer_error', {
          message: safeMessage(error, 'sw_register_outer_error'),
        });

        reportInlineIncident('vite_pwa_register_outer_error', error);

        markRuntimeOwnerReady('vite_pwa_register_outer_error');
        markRootRuntimeSettled('vite_pwa_register_outer_error');

        await startManualFallback('outer_error', error);
      }
    }

    void start();

    return () => {
      cancelledRef.current = true;
      clearCleanLaunchUpdateCheck();
      try { window.removeEventListener(PASSIVE_UPDATE_EVENT, onPassiveUpdateAvailable); } catch {}
      try { window.removeEventListener(LEGACY_SW_DETECTED_EVENT, onLegacySwDetected); } catch {}
      try { navigator.serviceWorker.removeEventListener('message', onServiceWorkerAutoUpdateMessage); } catch {}
    };
  }, []);

  return null;
}
