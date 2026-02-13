'use client';
import React, { useEffect, useState } from 'react';

/**
 * Registers the Service Worker and checks for updates every 30 minutes (while app is open).
 * Shows a small banner when a new version is available.
 */
export default function ServiceWorkerRegister() {
  const [updateReady, setUpdateReady] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;

    let intervalId = null;
    let regRef = null;

    async function registerSW() {
      try {
        regRef = await navigator.serviceWorker.register('/sw.js', { scope: '/' });

        // if a SW is already waiting, show banner
        if (regRef.waiting) setUpdateReady(true);

        // watch for updates becoming available
        regRef.addEventListener('updatefound', () => {
          const nw = regRef.installing;
          if (!nw) return;
          nw.addEventListener('statechange', () => {
            if (nw.state === 'installed' && navigator.serviceWorker.controller) {
              // new version is ready but waiting
              setUpdateReady(true);
            }
          });
        });
      } catch (e) {
        // ignore
      }
    }

    async function checkUpdate() {
      try {
        if (!regRef) regRef = await navigator.serviceWorker.getRegistration();
        if (!regRef) return;
        await regRef.update();
        if (regRef.waiting) setUpdateReady(true);
      } catch (e) {
        // ignore
      }
    }

    // When new SW takes control, refresh app shell
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      window.location.reload();
    });

    registerSW().then(() => {
      checkUpdate();
      intervalId = setInterval(checkUpdate, 30 * 60 * 1000);
    });

    return () => {
      if (intervalId) clearInterval(intervalId);
    };
  }, []);

  async function applyUpdate() {
    if (busy) return;
    setBusy(true);
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg?.waiting) {
        // tell waiting SW to activate
        reg.waiting.postMessage({ type: 'SKIP_WAITING' });
      } else if (navigator.serviceWorker.controller) {
        // fallback: nuke caches and reload
        navigator.serviceWorker.controller.postMessage({ type: 'NUKE_CACHES' });
      }
    } catch (e) {
      // ignore
    }
    setTimeout(() => window.location.reload(), 250);
  }

  if (!updateReady) return null;

  return (
    <div
      style={{
        position: 'fixed',
        left: 12,
        right: 12,
        bottom: 12,
        zIndex: 9999,
        background: 'rgba(0,0,0,0.92)',
        border: '1px solid rgba(255,255,255,0.12)',
        borderRadius: 16,
        padding: '12px 14px',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
      }}
    >
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 900 }}>KA UPDATE</div>
        <div style={{ fontSize: 12, opacity: 0.8 }}>Prek REFRESH për me marrë versionin e ri.</div>
      </div>

      <button
        onClick={applyUpdate}
        disabled={busy}
        style={{
          padding: '10px 14px',
          borderRadius: 14,
          background: '#0A84FF',
          color: '#fff',
          fontWeight: 900,
          border: 'none',
        }}
      >
        {busy ? '...' : 'REFRESH'}
      </button>
    </div>
  );
}
