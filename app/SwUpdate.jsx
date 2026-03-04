'use client';

import { useEffect } from 'react';

export default function SwUpdate() {
  useEffect(() => {
    const buildId =
      process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA ||
      process.env.NEXT_PUBLIC_APP_VERSION ||
      'dev';

    try {
      // ONLINE only: never break offline mode.
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return;

      const key = 'tepiha_last_build_id';
      const prev = localStorage.getItem(key);
      if (prev === buildId) return;

      localStorage.setItem(key, buildId);

      (async () => {
        try {
          if ('serviceWorker' in navigator) {
            const regs = await navigator.serviceWorker.getRegistrations();
            await Promise.all(regs.map((r) => r.unregister()));
          }
        } catch {}

        try {
          if (typeof caches !== 'undefined') {
            const keys = await caches.keys();
            await Promise.all(keys.map((k) => caches.delete(k)));
          }
        } catch {}

        // Force reload from network
        try {
          window.location.reload(true);
        } catch {
          window.location.reload();
        }
      })();
    } catch {}
  }, []);

  return null;
}
