'use client';

import React, { useEffect } from 'react';

function lsSet(k, v) { try { localStorage.setItem(k, String(v ?? '')); } catch {} }
function lsDel(k) { try { localStorage.removeItem(k); } catch {} }
function lsGet(k) { try { return localStorage.getItem(k); } catch { return null } }

async function clearWorkboxCaches() {
  if (!('caches' in window)) return;
  try {
    const keys = await caches.keys();
    for (const k of keys) {
      // remove workbox caches only
      if (k.startsWith('workbox-') || k.includes('workbox-precache')) {
        await caches.delete(k);
      }
    }
  } catch {}
}

async function unregisterAll() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const regs = await navigator.serviceWorker.getRegistrations();
    for (const r of regs) {
      try { await r.unregister(); } catch {}
    }
  } catch {}
}

export default function ServiceWorkerRegister() {
  useEffect(() => {
    let did = false;

    const run = async () => {
      if (did) return;
      did = true;

      lsSet('sw_last_time', new Date().toISOString());
      lsSet('sw_last_stage', 'start');
      lsDel('sw_last_error');
      lsDel('sw_last_state');

      if (!('serviceWorker' in navigator)) {
        lsSet('sw_last_error', 'serviceWorker not supported');
        lsSet('sw_last_stage', 'no_sw');
        return;
      }

      try {
        // IMPORTANT:
        // Do NOT unregister/clear caches on every load.
        // This breaks iOS cold-start offline (no SW on first navigation).
        const FORCE_KEY = 'sw_force_reset_v1';
        const force = lsGet(FORCE_KEY) === '1';

        if (force) {
          lsSet('sw_last_stage', 'force_unreg_all');
          await unregisterAll();

          lsSet('sw_last_stage', 'force_clear_workbox_caches');
          await clearWorkboxCaches();

          try { localStorage.removeItem(FORCE_KEY); } catch {}
        }

        // If already registered for scope '/', keep it (offline relies on it).
        lsSet('sw_last_stage', 'get_registration');
        let reg = await navigator.serviceWorker.getRegistration('/');

        // Register (or re-register) sw.js
        lsSet('sw_last_stage', 'navigator_register');
        reg = reg || (await navigator.serviceWorker.register('/sw.js', { scope: '/' }));

        // Wait for ready
        lsSet('sw_last_stage', 'ready_wait');
        const readyReg = await navigator.serviceWorker.ready;

        lsSet('sw_last_stage', 'ready_ok');
        lsSet('sw_last_state', JSON.stringify({
          scope: readyReg?.scope || null,
          active: readyReg?.active ? { state: readyReg.active.state, scriptURL: readyReg.active.scriptURL } : null,
        }));

        // iOS: controller can stay null until reload; do one safe reload ONCE per browser session (only if online).
        const flag = 'sw_controller_reload_once_v3';
        try {
          const hasController = !!navigator.serviceWorker.controller;
          const isOnline = (typeof navigator !== 'undefined') ? navigator.onLine !== false : true;

          if (!hasController && isOnline) {
            const done = sessionStorage.getItem(flag);
            if (!done) {
              sessionStorage.setItem(flag, '1');
              lsSet('sw_last_stage', 'controller_reload');
              location.reload();
              return;
            }
          }
        } catch {}
      } catch (e) {
        lsSet('sw_last_error', String(e?.message || e));
        lsSet('sw_last_stage', 'register_failed');
      }
    };

    run();
  }, []);

  return null;
}
