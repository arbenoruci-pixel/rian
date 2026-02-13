'use client';

import { useEffect } from 'react';

/**
 * VersionGuard
 * Fixes the classic iOS Safari / Home Screen mismatch where a PWA gets stuck on an old build.
 *
 * - Detects deploy changes via NEXT_PUBLIC_APP_VERSION (set by Vercel)
 * - If version changed: clears ONLY Service Worker caches + unregisters SW + reloads
 * - DOES NOT touch business localStorage (orders, offline queue, reserved codes)
 */

const LS_KEY = 'TEPIHA__APP_VERSION_SEEN';

async function softResetPwaCaches() {
  // Delete Cache Storage (SW caches) ONLY.
  try {
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch {}

  // Unregister SW so the new one can re-install cleanly.
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
  } catch {}
}

export default function VersionGuard() {
  useEffect(() => {
    if (typeof window === 'undefined') return;

    // Prefer a stable deploy id injected by Vercel.
    const current =
      process.env.NEXT_PUBLIC_APP_VERSION ||
      process.env.NEXT_PUBLIC_VERCEL_DEPLOYMENT_ID ||
      'dev';

    let prev = null;
    try {
      prev = localStorage.getItem(LS_KEY);
    } catch {}

    // First run: store version and continue.
    if (!prev) {
      try {
        localStorage.setItem(LS_KEY, current);
      } catch {}
      return;
    }

    // Deploy changed: self-heal.
    if (prev !== current) {
      (async () => {
        try {
          localStorage.setItem(LS_KEY, current);
        } catch {}

        await softResetPwaCaches();

        // Hard reload to fetch latest HTML/JS.
        try {
          window.location.reload();
        } catch {
          // last resort
          try {
            window.location.href = window.location.href;
          } catch {}
        }
      })();
    }
  }, []);

  return null;
}
