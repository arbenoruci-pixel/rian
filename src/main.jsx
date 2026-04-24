import React from 'react';
import ReactDOM from 'react-dom/client';
import AppRoot from './AppRoot.jsx';
import { reloadPageOnce } from '@/lib/lazyWithReload.jsx';

function installVitePreloadReloadGuard() {
  if (typeof window === 'undefined') return;

  try {
    window.addEventListener('vite:preloadError', (event) => {
      try { event?.preventDefault?.(); } catch {}
      reloadPageOnce('vite_preload_error', {
        storageKey: 'vite-preload-error',
        reloadWindowMs: 30000,
        delayMs: 60,
        error: event?.payload || event?.reason || null,
        meta: {
          sourceLayer: 'main_vite_preload_error',
          eventType: 'vite:preloadError',
        },
      });
    });
  } catch {}
}

const VITE_PWA_SW_BASENAME = '/vite-sw.js';

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

function unregisterLegacyServiceWorkers() {
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

      try {
        window.localStorage?.setItem?.('tepiha_legacy_sw_unregister_v1', JSON.stringify({
          at: new Date().toISOString(),
          href: window.location?.href || '',
          hadLegacyController,
          skippedVitePwa: regs.some(isVitePwaRegistration),
          results,
        }));
      } catch {}

      if (hadLegacyController) {
        reloadPageOnce('legacy_service_worker_unregistered', {
          storageKey: 'legacy-service-worker-unregistered',
          reloadWindowMs: 30000,
          delayMs: 120,
          meta: {
            sourceLayer: 'main_legacy_sw_cleanup',
            registrations: results,
          },
        });
      }
    } catch (error) {
      try {
        window.localStorage?.setItem?.('tepiha_legacy_sw_unregister_error_v1', JSON.stringify({
          at: new Date().toISOString(),
          href: window.location?.href || '',
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
    run();
  }
}

installVitePreloadReloadGuard();
unregisterLegacyServiceWorkers();

ReactDOM.createRoot(document.getElementById('root')).render(
  <AppRoot />,
);
