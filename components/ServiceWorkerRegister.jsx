'use client';

import { useEffect } from 'react';
import { APP_DATA_EPOCH } from '@/lib/appEpoch';
import { bootLog } from '@/lib/bootLog';

const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;
const VITE_SW_URL = '/vite-sw.js';

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
      window.__TEPIHA_SW_KILL_SWITCH__ === true ||
      window.__TEPIHA_FORCE_NETWORK_MODE__ === true
    );
  } catch {
    return false;
  }
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
  if (!isSupported()) return { count: 0 };

  let regs = [];

  try {
    regs = await navigator.serviceWorker.getRegistrations();
  } catch {
    regs = [];
  }

  const safeRegs = Array.isArray(regs) ? regs : [];

  await Promise.allSettled(
    safeRegs.map(async (reg) => {
      try {
        reg?.waiting?.postMessage?.({ type: 'SKIP_WAITING' });
      } catch {}

      try {
        reg?.active?.postMessage?.({ type: 'SKIP_WAITING' });
      } catch {}

      try {
        if (typeof reg?.unregister === 'function') {
          await reg.unregister();
        }
      } catch {}
    }),
  );

  return { count: safeRegs.length };
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

function safeUpdateRegistration(registration, source, swUrl = '') {
  try {
    if (!registration || typeof registration.update !== 'function') {
      logSwEvent('vite_pwa_sw_update_registration_missing', {
        source,
        swUrl: String(swUrl || ''),
      });
      return;
    }

    void registration
      .update()
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
  } catch (error) {
    logSwEvent('vite_pwa_sw_update_check_throw', {
      source,
      swUrl: String(swUrl || ''),
      message: safeMessage(error, 'update_check_throw'),
    });
  }
}

function buildRegisterOptions({
  cancelledRef,
  installAggressiveUpdateChecks,
  getApplyUpdate,
  startManualFallback,
}) {
  const options = {
    immediate: true,

    onRegisteredSW(swUrl, registration) {
      try {
        if (cancelledRef.current) return;

        logSwEvent('vite_pwa_sw_registered', {
          swUrl: String(swUrl || ''),
          scope: String(registration?.scope || ''),
        });

        markRuntimeOwnerReady('vite_pwa_sw_registered');
        markRootRuntimeSettled('vite_pwa_sw_registered');

        installAggressiveUpdateChecks(registration, 'virtual_pwa_register', swUrl);
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
        logSwEvent('vite_pwa_sw_need_refresh');

        try {
          window.sessionStorage?.setItem?.(
            'tepiha_vite_pwa_update_v1',
            JSON.stringify({
              at: new Date().toISOString(),
              path: String(window.location?.pathname || ''),
              epoch: APP_DATA_EPOCH,
            }),
          );
        } catch {}

        const applyUpdate = getApplyUpdate();

        if (typeof applyUpdate === 'function') {
          try {
            void applyUpdate(true);
          } catch (error) {
            logSwEvent('vite_pwa_sw_update_apply_error', {
              message: safeMessage(error, 'update_apply_failed'),
            });
          }
        } else {
          logSwEvent('vite_pwa_sw_update_apply_missing');
        }
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
  useEffect(() => {
    if (!isSupported()) {
      markRuntimeOwnerReady('vite_pwa_sw_not_supported');
      markRootRuntimeSettled('vite_pwa_sw_not_supported');
      return undefined;
    }

    const cancelledRef = { current: false };
    let cleanupAggressiveUpdateChecks = null;
    let applyUpdateFromVirtualPwa = null;
    let manualFallbackStarted = false;

    const clearAggressiveUpdateChecks = () => {
      try {
        if (typeof cleanupAggressiveUpdateChecks === 'function') {
          cleanupAggressiveUpdateChecks();
        }
      } catch {}

      cleanupAggressiveUpdateChecks = null;
    };

    const installAggressiveUpdateChecks = (registration, source, swUrl = '') => {
      try {
        clearAggressiveUpdateChecks();

        if (!registration || typeof registration.update !== 'function') {
          logSwEvent('vite_pwa_sw_update_registration_missing', {
            source,
            swUrl: String(swUrl || ''),
          });
          return;
        }

        const checkForUpdate = (reason) => {
          try {
            if (cancelledRef.current) return;
            if (document.visibilityState !== 'visible') return;

            safeUpdateRegistration(registration, `${source}:${reason}`, swUrl);
          } catch (error) {
            logSwEvent('vite_pwa_sw_update_check_handler_error', {
              source,
              reason,
              swUrl: String(swUrl || ''),
              message: safeMessage(error, 'update_check_handler_failed'),
            });
          }
        };

        const onVisibilityChange = () => {
          try {
            if (document.visibilityState === 'visible') {
              checkForUpdate('visibilitychange_visible');
            }
          } catch (error) {
            logSwEvent('vite_pwa_sw_visibility_update_error', {
              source,
              swUrl: String(swUrl || ''),
              message: safeMessage(error, 'visibility_update_failed'),
            });
          }
        };

        try {
          document.addEventListener('visibilitychange', onVisibilityChange);
        } catch (error) {
          logSwEvent('vite_pwa_sw_visibility_listener_error', {
            source,
            swUrl: String(swUrl || ''),
            message: safeMessage(error, 'visibility_listener_failed'),
          });
        }

        let intervalId = null;

        try {
          intervalId = window.setInterval(() => {
            checkForUpdate('interval_1h');
          }, UPDATE_CHECK_INTERVAL_MS);
        } catch (error) {
          logSwEvent('vite_pwa_sw_interval_setup_error', {
            source,
            swUrl: String(swUrl || ''),
            message: safeMessage(error, 'interval_setup_failed'),
          });
        }

        cleanupAggressiveUpdateChecks = () => {
          try {
            document.removeEventListener('visibilitychange', onVisibilityChange);
          } catch {}

          try {
            if (intervalId) {
              window.clearInterval(intervalId);
            }
          } catch {}
        };

        logSwEvent('vite_pwa_sw_aggressive_update_checks_installed', {
          source,
          swUrl: String(swUrl || ''),
          scope: String(registration?.scope || ''),
          intervalMs: UPDATE_CHECK_INTERVAL_MS,
        });
      } catch (error) {
        logSwEvent('vite_pwa_sw_aggressive_update_setup_error', {
          source,
          swUrl: String(swUrl || ''),
          message: safeMessage(error, 'aggressive_update_setup_failed'),
        });
      }
    };

    const getApplyUpdate = () => applyUpdateFromVirtualPwa;

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

        logSwEvent('vite_pwa_manual_register_ok', {
          scope: String(registration?.scope || ''),
          active: Boolean(registration?.active),
          waiting: Boolean(registration?.waiting),
          installing: Boolean(registration?.installing),
        });

        markRuntimeOwnerReady('vite_pwa_manual_register_ok');
        markRootRuntimeSettled('vite_pwa_manual_register_ok');
        setOfflineReadyFlag('manual_fallback_register');

        installAggressiveUpdateChecks(registration, 'manual_fallback_register', VITE_SW_URL);

        return registration;
      } catch (error) {
        if (cancelledRef.current) return null;

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
          installAggressiveUpdateChecks,
          getApplyUpdate,
          startManualFallback,
        });

        try {
          const result = registerSW(registerOptions || {});

          if (typeof result === 'function') {
            applyUpdateFromVirtualPwa = result;
          } else {
            applyUpdateFromVirtualPwa = null;
          }

          logSwEvent('vite_pwa_register_call_ok', {
            hasApplyUpdate: typeof applyUpdateFromVirtualPwa === 'function',
          });

          markRuntimeOwnerReady('vite_pwa_register_call_ok');
          markRootRuntimeSettled('vite_pwa_register_call_ok');
        } catch (error) {
          if (cancelledRef.current) return;

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
      clearAggressiveUpdateChecks();
    };
  }, []);

  return null;
}
