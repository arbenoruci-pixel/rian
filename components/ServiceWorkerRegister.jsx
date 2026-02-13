'use client';
import React, { useEffect, useState } from 'react';

export default function ServiceWorkerRegister() {
  const [updateReady, setUpdateReady] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;

    let regRef = null;
    let t = null;

    async function register() {
      try {
        regRef = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      } catch (e) {
        // ignore
      }
    }

    async function checkUpdate() {
      try {
        if (!regRef) regRef = await navigator.serviceWorker.getRegistration();
        if (!regRef) return;
        await regRef.update();
        // if a new worker is waiting, show banner
        if (regRef.waiting) setUpdateReady(true);
      } catch {}
    }

    // listen for waiting worker
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      // new SW took control -> reload to get fresh assets
      window.location.reload();
    });

    register().then(() => {
      checkUpdate();
      t = setInterval(checkUpdate, 30 * 60 * 1000); // 30 min while app open
    });

    return () => { if (t) clearInterval(t); };
  }, []);

  async function applyUpdate() {
    setBusy(true);
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg && reg.waiting) {
        reg.waiting.postMessage({ type: 'SKIP_WAITING' });
      }
      // fallback: nuke caches & reload
      if (navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage({ type: 'NUKE_CACHES' });
      }
    } catch {}
    setTimeout(() => window.location.reload(), 250);
  }

  if (!updateReady) return null;

  return (
    <div style={position:'fixed', left:12, right:12, bottom:12, zIndex:9999,
      background:'rgba(0,0,0,0.92)', border:'1px solid rgba(255,255,255,0.12)',
      borderRadius:16, padding:'12px 14px', display:'flex', alignItems:'center', gap:12}>
      <div style={flex:1}>
        <div style={fontWeight:900}>KA UPDATE</div>
        <div style={fontSize:12, opacity:0.8}>Prek REFRESH për me marrë versionin e ri.</div>
      </div>
      <button onClick={applyUpdate} disabled={busy}
        style={padding:'10px 14px', borderRadius:14, background:'#0A84FF', color:'#fff', fontWeight:900, border:'none'}>
        {busy ? '...' : 'REFRESH'}
      </button>
    </div>
  );
}
