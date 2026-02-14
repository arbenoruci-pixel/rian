'use client'

import { useEffect } from 'react';

const LS_KEY = '__tepiha_build_id__';

async function nukeCachesSoft() {
  // Keep localStorage business data; only clear SW caches + old SW.
  try {
    if (typeof caches !== 'undefined') {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch {}

  try {
    if (typeof navigator !== 'undefined' && navigator.serviceWorker) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
  } catch {}
}

export default function VersionGuard() {
  useEffect(() => {
    let cancelled = false;

    async function check() {
      try {
        const r = await fetch('/_next/static/BUILD_ID?ts=' + Date.now(), {
          cache: 'no-store',
          headers: { 'Cache-Control': 'no-store' },
        });
        if (!r.ok) return;
        const buildId = (await r.text()).trim();
        if (!buildId) return;

        const prev = (() => {
          try { return localStorage.getItem(LS_KEY) || ''; } catch { return ''; }
        })();

        // First run: store and exit.
        if (!prev) {
          try { localStorage.setItem(LS_KEY, buildId); } catch {}
          return;
        }

        if (prev !== buildId) {
          try { localStorage.setItem(LS_KEY, buildId); } catch {}
          await nukeCachesSoft();
          if (cancelled) return;
          // Hard reload to get fresh JS/CSS/HTML.
          window.location.reload();
        }
      } catch {
        // Offline or Safari fetch blocked — do nothing.
      }
    }

    // Run now and periodically (helps iOS home-screen mode)
    check();
    const t = setInterval(check, 30 * 60 * 1000);

    // Expose a manual escape hatch for admins/debug.
    try {
      window.__TEPIHA_FORCE_UPDATE__ = async () => {
        await nukeCachesSoft();
        window.location.reload();
      };
    } catch {}

    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  return null;
}
