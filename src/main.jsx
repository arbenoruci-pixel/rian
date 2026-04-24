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

function unregisterLegacyServiceWorkers() {
  if (typeof window === 'undefined') return;
  if (!('serviceWorker' in navigator)) return;

  const run = async () => {
    try {
      const regs = await navigator.serviceWorker.getRegistrations();
      if (!Array.isArray(regs) || regs.length === 0) return;

      const hadController = !!navigator.serviceWorker.controller;
      const results = [];

      for (const reg of regs) {
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
          hadController,
          results,
        }));
      } catch {}

      if (hadController) {
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
