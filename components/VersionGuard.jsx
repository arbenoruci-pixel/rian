'use client';

import { useEffect } from 'react';

const LS_KEY = 'tepiha_app_version_seen_v1';

async function purgeSwCachesAndRegs() {
  // Do NOT clear business localStorage. Only purge CacheStorage + SW registrations.
  try {
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch {}

  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
  } catch {}
}

export default function VersionGuard() {
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const res = await fetch('/api/version?ts=' + Date.now(), { cache: 'no-store' });
        const js = await res.json();
        const remoteV = String(js?.v || '');
        if (!remoteV) return;

        let localV = '';
        try { localV = String(localStorage.getItem(LS_KEY) || ''); } catch {}

        if (!localV) {
          try { localStorage.setItem(LS_KEY, remoteV); } catch {}
          return;
        }

        if (localV !== remoteV) {
          try { localStorage.setItem(LS_KEY, remoteV); } catch {}
          await purgeSwCachesAndRegs();
          if (!cancelled) {
            // Hard reload to pull new build assets
            window.location.reload(true);
          }
        }
      } catch {
        // Offline or blocked; do nothing
      }
    })();

    return () => { cancelled = true; };
  }, []);

  return null;
}
