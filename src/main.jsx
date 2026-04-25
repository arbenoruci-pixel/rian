import React from 'react';
import ReactDOM from 'react-dom/client';
import AppRoot from './AppRoot.jsx';

const VITE_PWA_SW_BASENAME = '/vite-sw.js';

function writeRuntimeMarker(key, payload) {
  try {
    window.localStorage?.setItem?.(key, JSON.stringify(payload));
  } catch {}

  try {
    window.sessionStorage?.setItem?.(key, JSON.stringify(payload));
  } catch {}
}

function markManualRepairSuggested(reason, extra = {}) {
  if (typeof window === 'undefined') return;

  const payload = {
    at: new Date().toISOString(),
    ts: Date.now(),
    sourceLayer: 'src_main_manual_repair_v10',
    reason: String(reason || 'runtime_issue'),
    autoReloadDisabled: true,
    autoRepairDisabled: true,
    manualRepairOnly: true,
    href: String(window.location?.href || ''),
    path: String(window.location?.pathname || ''),
    ...extra,
  };

  writeRuntimeMarker('tepiha_manual_repair_suggested_v10', payload);

  try {
    window.__TEPIHA_UPDATE_AVAILABLE__ = payload;
    window.dispatchEvent(new CustomEvent('tepiha:update-available', { detail: payload }));
  } catch {}
}

function installVitePreloadPassiveGuard() {
  if (typeof window === 'undefined') return;

  try {
    window.addEventListener('vite:preloadError', (event) => {
      try { event?.preventDefault?.(); } catch {}
      markManualRepairSuggested('vite_preload_error_passive_no_reload', {
        eventType: 'vite:preloadError',
        error: (() => {
          try {
            const raw = event?.payload || event?.reason || null;
            if (!raw) return null;
            return {
              name: String(raw?.name || ''),
              message: String(raw?.message || raw || ''),
              stack: String(raw?.stack || ''),
            };
          } catch {
            return null;
          }
        })(),
      });
    });
  } catch {}
}

function isVitePwaRegistration(reg) {
  try {
    const urls = [
      reg?.active?.scriptURL,
      reg?.waiting?.scriptURL,
      reg?.installing?.scriptURL,
    ].map((value) => String(value || ''));
    return urls.some((url) => url.includes(VITE_PWA_SW_BASENAME));
  } catch {
    return false;
  }
}

function isLegacyServiceWorkerRegistration(reg) {
  try {
    if (!reg || isVitePwaRegistration(reg)) return false;

    const urls = [
      reg?.active?.scriptURL,
      reg?.waiting?.scriptURL,
      reg?.installing?.scriptURL,
    ].map((value) => String(value || ''));

    if (urls.length === 0) return false;

    return urls.some((url) => {
      if (!url) return false;
      if (url.includes('/vite-sw.js')) return false;
      if (url.includes('/sw.js')) return true;
      if (url.includes('/_next/')) return true;
      if (url.includes('next-data-')) return true;
      if (url.includes('sw-route-containment')) return true;
      if (url.includes('pwa-staleness')) return true;
      return false;
    });
  } catch {
    return false;
  }
}

function unregisterLegacyServiceWorkersPassively() {
  if (typeof window === 'undefined') return;
  if (!('serviceWorker' in navigator)) return;

  const run = async () => {
    try {
      const regs = await navigator.serviceWorker.getRegistrations();
      if (!Array.isArray(regs) || regs.length === 0) return;

      const legacyRegs = regs.filter(isLegacyServiceWorkerRegistration);
      if (legacyRegs.length === 0) {
        try {
          window.localStorage?.setItem?.('tepiha_legacy_sw_unregister_v1', JSON.stringify({
            at: new Date().toISOString(),
            href: window.location?.href || '',
            skipped: true,
            reason: 'no_legacy_service_worker_found',
            passiveNoReload: true,
            activeRegistrations: regs.map((reg) => ({
              scope: String(reg?.scope || ''),
              activeScript: String(reg?.active?.scriptURL || ''),
              waitingScript: String(reg?.waiting?.scriptURL || ''),
              installingScript: String(reg?.installing?.scriptURL || ''),
            })),
          }));
        } catch {}
        return;
      }

      const controllerScript = String(navigator.serviceWorker.controller?.scriptURL || '');
      const hadLegacyController = controllerScript && !controllerScript.includes(VITE_PWA_SW_BASENAME);
      const results = [];

      for (const reg of legacyRegs) {
        try {
          const scope = String(reg?.scope || '');
          const activeScript = String(reg?.active?.scriptURL || '');
          const waitingScript = String(reg?.waiting?.scriptURL || '');
          const installingScript = String(reg?.installing?.scriptURL || '');
          const ok = await reg.unregister();
          results.push({ scope, activeScript, waitingScript, installingScript, unregistered: !!ok });
        } catch (error) {
          results.push({ error: String(error?.message || error || 'unregister_failed') });
        }
      }

      const payload = {
        at: new Date().toISOString(),
        href: window.location?.href || '',
        hadLegacyController,
        passiveNoReload: true,
        manualRepairOnly: true,
        skippedVitePwa: regs.some(isVitePwaRegistration),
        results,
      };

      try {
        window.localStorage?.setItem?.('tepiha_legacy_sw_unregister_v1', JSON.stringify(payload));
      } catch {}

      if (hadLegacyController) {
        markManualRepairSuggested('legacy_service_worker_unregistered_passive_no_reload', {
          registrations: results,
        });
      }
    } catch (error) {
      try {
        window.localStorage?.setItem?.('tepiha_legacy_sw_unregister_error_v1', JSON.stringify({
          at: new Date().toISOString(),
          href: window.location?.href || '',
          passiveNoReload: true,
          error: String(error?.message || error || 'service_worker_unregister_failed'),
        }));
      } catch {}
    }
  };

  try {
    if (document.readyState === 'complete') {
      window.setTimeout(run, 0);
    } else {
      window.addEventListener('load', () => { window.setTimeout(run, 0); }, { once: true });
    }
  } catch {
    void run();
  }
}

installVitePreloadPassiveGuard();
unregisterLegacyServiceWorkersPassively();

ReactDOM.createRoot(document.getElementById('root')).render(
  <AppRoot />,
);
