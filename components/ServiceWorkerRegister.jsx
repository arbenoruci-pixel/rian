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
    passiveUpdate: true,
    autoReloadDisabled: true,
    manualUpdateOnly: true,
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
      autoReloadDisabled: true,
      autoRepairDisabled: true,
      autoUnregisterDisabled: true,
      autoCachePurgeDisabled: true,
      manualRepairOnly: true,
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
}) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;

    const finish = (payload) => {
      if (settled) return;
      settled = true;
      try { if (timer) window.clearTimeout(timer); } catch {}
      resolve(payload || { ok: false, type, timeout: false });
    };

    try {
      const controller = navigator.serviceWorker?.controller || null;
      const scriptURL = String(controller?.scriptURL || '');

      if (!controller || !isLegacySwScriptURL(scriptURL)) {
        finish({ ok: false, type, skipped: true, reason: 'no_legacy_controller', controllerScriptURL: scriptURL });
        return;
      }

      if (typeof MessageChannel === 'function') {
        const channel = new MessageChannel();
        channel.port1.onmessage = (event) => finish(event?.data || { ok: true, type });
        timer = window.setTimeout(() => finish({ ok: false, type, timeout: true }), LEGACY_REPAIR_TIMEOUT_MS);
        controller.postMessage({ type, manual: true, appEpoch: APP_DATA_EPOCH, ...detail }, [channel.port2]);
        return;
      }

      controller.postMessage({ type, manual: true, appEpoch: APP_DATA_EPOCH, ...detail });
      timer = window.setTimeout(() => finish({ ok: true, type, fireAndForget: true }), 350);
    } catch (error) {
      finish({ ok: false, type, error: safeMessage(error, 'legacy_message_failed') });
    }
  });
}

function hideLegacySwBanner() {
  try {
    const node = document.getElementById('tepiha-legacy-sw-bridge-banner');
    if (node && node.parentNode) node.parentNode.removeChild(node);
  } catch {}
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
    logSwEvent('vite_pwa_sw_update_apply_quarantined_v29', {
      source,
      hasUpdateSW: typeof updateSW === 'function',
      requestedReloadPage: Boolean(reloadPage),
      noUpdateSWApply: true,
      noSkipWaiting: true,
      noReload: true,
      noCacheDelete: true,
      noSwUnregister: true,
    });
  } catch {}
  return false;
}

function buildRegisterOptions({
  cancelledRef,
  registrationRef,
  updateSWRef,
  installCleanLaunchUpdateCheck,
  startManualFallback,
  showPassiveUpdateBanner,
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
          note: 'Service Worker found a new version. Auto reload is disabled during an active session.',
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

    const clearCleanLaunchUpdateCheck = () => {
      try {
        if (typeof cleanupCleanLaunchUpdateCheckRef.current === 'function') {
          cleanupCleanLaunchUpdateCheckRef.current();
        }
      } catch {}

      cleanupCleanLaunchUpdateCheckRef.current = null;
    };

    const showPassiveUpdateBanner = (payload = {}) => {
      try {
        if (!shouldShowVisualUpdateBanner()) return;
        if (cancelledRef.current) return;
        if (typeof document === 'undefined') return;

        let banner = document.getElementById('tepiha-update-available-banner');
        if (!banner) {
          banner = document.createElement('div');
          banner.id = 'tepiha-update-available-banner';
          banner.setAttribute('data-passive-update-banner', '1');
          banner.style.cssText = 'position:fixed;left:10px;right:10px;bottom:calc(10px + env(safe-area-inset-bottom,0px));z-index:2147482500;display:flex;justify-content:center;pointer-events:none;font-family:system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;color:#e5e7eb';
          banner.innerHTML = ''
            + '<div style="width:min(560px,100%);border-radius:18px;border:1px solid rgba(96,165,250,.38);background:rgba(15,23,42,.97);box-shadow:0 18px 45px rgba(0,0,0,.42);padding:12px;pointer-events:auto">'
            + '<div style="font-size:11px;font-weight:1000;letter-spacing:.12em;color:#93c5fd">VERSION I RI GATI</div>'
            + '<div style="margin-top:5px;font-size:15px;line-height:1.25;font-weight:950">Version i ri është gati.</div>'
            + '<div style="margin-top:5px;font-size:12.5px;line-height:1.35;color:rgba(226,232,240,.82);font-weight:700">Mbylle app-in komplet dhe hape prap kur nuk je në punë aktive.</div>'
            + '<div id="tepiha-update-available-status" style="display:none;margin-top:8px;font-size:12px;line-height:1.35;color:#bae6fd;font-weight:850"></div>'
            + '<div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">'
            + '<button id="tepiha-update-available-now" type="button" style="border:0;border-radius:12px;padding:10px 12px;background:#2563eb;color:#fff;font-weight:1000;font-size:13px">UDHËZIM</button>'
            + '<button id="tepiha-update-available-later" type="button" style="border:0;border-radius:12px;padding:10px 12px;background:rgba(255,255,255,.08);color:#fff;font-weight:950;font-size:13px">MË VONË</button>'
            + '</div>'
            + '</div>';
          (document.body || document.documentElement).appendChild(banner);
        }

        try { banner.__TEPIHA_UPDATE_PAYLOAD__ = payload; } catch {}

        const status = document.getElementById('tepiha-update-available-status');
        const setStatus = (text) => {
          try {
            if (!status) return;
            status.textContent = String(text || '');
            status.style.display = text ? 'block' : 'none';
          } catch {}
        };

        const later = document.getElementById('tepiha-update-available-later');
        if (later && !later.__TEPIHA_BOUND__) {
          later.__TEPIHA_BOUND__ = true;
          later.onclick = () => {
            try { logSwEvent('vite_pwa_sw_update_banner_later'); } catch {}
            hidePassiveUpdateBanner();
          };
        }

        const now = document.getElementById('tepiha-update-available-now');
        if (now && !now.__TEPIHA_BOUND__) {
          now.__TEPIHA_BOUND__ = true;
          now.onclick = () => {
            try {
              logSwEvent('vite_pwa_sw_manual_update_click_quarantined_v29', {
                hasApplyUpdate: typeof updateSWRef.current === 'function',
                hasRegistration: Boolean(registrationRef.current),
                noUpdateSWApply: true,
                noRegistrationUpdateFromButton: true,
                noSkipWaiting: true,
                noReload: true,
                noCacheDelete: true,
                noSwUnregister: true,
              });
            } catch {}
            setStatus('Version i ri është gati. Mbylle app-in komplet dhe hape prap kur nuk je në punë aktive. Nuk u bë reload, cache delete, skipWaiting ose SW unregister.');
          };
        }
      } catch (error) {
        logSwEvent('vite_pwa_sw_update_banner_error', {
          message: safeMessage(error, 'update_banner_failed'),
        });
      }
    };

    const onPassiveUpdateAvailable = (event) => {
      try {
        const payload = event?.detail && typeof event.detail === 'object' ? event.detail : updateAvailablePayload('passive_update_event');
        showPassiveUpdateBanner(payload);
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
        if (typeof document === 'undefined') return;

        const currentPayload = payload && payload.legacyController
          ? payload
          : readLegacyControllerPayload('legacy_banner_check');
        if (!currentPayload?.legacyController) {
          hideLegacySwBanner();
          return;
        }

        markLegacyDetected(currentPayload);

        let banner = document.getElementById('tepiha-legacy-sw-bridge-banner');
        if (!banner) {
          banner = document.createElement('div');
          banner.id = 'tepiha-legacy-sw-bridge-banner';
          banner.setAttribute('data-legacy-sw-bridge-banner', '1');
          banner.style.cssText = 'position:fixed;left:10px;right:10px;bottom:calc(10px + env(safe-area-inset-bottom,0px));z-index:2147482600;display:flex;justify-content:center;pointer-events:none;font-family:system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;color:#e5e7eb';
          banner.innerHTML = ''
            + '<div style="width:min(620px,100%);border-radius:18px;border:1px solid rgba(251,191,36,.42);background:rgba(15,23,42,.98);box-shadow:0 18px 45px rgba(0,0,0,.42);padding:12px;pointer-events:auto">'
            + '<div style="font-size:11px;font-weight:1000;letter-spacing:.12em;color:#fbbf24">RUNTIME I VJETËR</div>'
            + '<div style="margin-top:5px;font-size:15px;line-height:1.25;font-weight:950">Ky telefon po përdor runtime të vjetër.</div>'
            + '<div style="margin-top:5px;font-size:12.5px;line-height:1.35;color:rgba(226,232,240,.82);font-weight:750">App-i vazhdon punën. Mbylle/hape manualisht kur nuk je në punë aktive.</div>'
            + '<div id="tepiha-legacy-sw-bridge-status" style="display:none;margin-top:8px;font-size:12px;line-height:1.35;color:#fde68a;font-weight:850"></div>'
            + '<div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">'
            + '<button id="tepiha-legacy-sw-bridge-repair" type="button" style="border:0;border-radius:12px;padding:10px 12px;background:#f59e0b;color:#111827;font-weight:1000;font-size:13px">UDHËZIM</button>'
            + '<button id="tepiha-legacy-sw-bridge-later" type="button" style="border:0;border-radius:12px;padding:10px 12px;background:rgba(255,255,255,.08);color:#fff;font-weight:950;font-size:13px">MË VONË</button>'
            + '</div>'
            + '</div>';
          (document.body || document.documentElement).appendChild(banner);
        }

        try { banner.__TEPIHA_LEGACY_SW_PAYLOAD__ = currentPayload; } catch {}

        const status = document.getElementById('tepiha-legacy-sw-bridge-status');
        const setStatus = (text) => {
          try {
            if (!status) return;
            status.textContent = String(text || '');
            status.style.display = text ? 'block' : 'none';
          } catch {}
        };

        const later = document.getElementById('tepiha-legacy-sw-bridge-later');
        if (later && !later.__TEPIHA_BOUND__) {
          later.__TEPIHA_BOUND__ = true;
          later.onclick = () => {
            try { logSwEvent('legacy_sw_bridge_banner_later', currentPayload); } catch {}
            hideLegacySwBanner();
          };
        }

        const repair = document.getElementById('tepiha-legacy-sw-bridge-repair');
        if (repair && !repair.__TEPIHA_BOUND__) {
          repair.__TEPIHA_BOUND__ = true;
          repair.onclick = async () => {
            try {
              repair.disabled = false;
              repair.style.opacity = '1';
            } catch {}
            setStatus('Runtime i vjetër u detektua. Mbylle app-in komplet dhe hape prap kur nuk je në punë aktive. PATCH V29 nuk bën cache delete, unregister, skipWaiting ose reload.');
            try {
              logSwEvent('legacy_sw_bridge_manual_repair_quarantined_v29', {
                ...currentPayload,
                noCacheDelete: true,
                noSwUnregister: true,
                noSkipWaiting: true,
                noReload: true,
              });
            } catch {}
          };
        }
      } catch (error) {
        logSwEvent('legacy_sw_bridge_banner_error', {
          message: safeMessage(error, 'legacy_banner_failed'),
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
    };
  }, []);

  return null;
}
