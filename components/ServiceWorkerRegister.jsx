'use client';

import { useEffect } from 'react';

/**
 * ServiceWorkerRegister
 * - Registers /sw.js
 * - Forces AUTO UPDATE: when a new SW is waiting, we SKIP_WAITING + reload.
 * Works with next-pwa/workbox (message type: 'SKIP_WAITING').
 */
export default function ServiceWorkerRegister() {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!('serviceWorker' in navigator)) return;

    let refreshing = false;

    const hardReload = () => {
      if (refreshing) return;
      refreshing = true;
      // Force reload to get newest JS bundle
      window.location.reload();
    };

    const onControllerChange = () => {
      // The new SW took control -> reload
      hardReload();
    };

    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);

    (async () => {
      try {
        const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });

        // If there's already a waiting worker (cached old build), activate it now
        if (reg.waiting) {
          try {
            reg.waiting.postMessage({ type: 'SKIP_WAITING' });
          } catch {}
        }

        // Listen for updates
        reg.addEventListener('updatefound', () => {
          const newWorker = reg.installing;
          if (!newWorker) return;

          newWorker.addEventListener('statechange', () => {
            // When installed AND there is an existing controller, it's an update
            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
              try {
                // Activate immediately
                newWorker.postMessage({ type: 'SKIP_WAITING' });
              } catch {}
              // If controllerchange doesn't fire (edge cases), reload anyway
              setTimeout(hardReload, 600);
            }
          });
        });

        // Also, periodically check for updates (every 30 minutes)
        const interval = window.setInterval(() => {
          try { reg.update(); } catch {}
        }, 30 * 60 * 1000);

        return () => window.clearInterval(interval);
      } catch (e) {
        // Silent - app must still run without SW
        // console.warn('SW register failed', e);
      }
    })();

    return () => {
      try { navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange); } catch {}
    };
  }, []);

  return null;
}
