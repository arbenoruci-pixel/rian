'use client';
import React, { useEffect, useState } from 'react';

function safeSetLog(line) {
  try {
    const key = 'tepiha_offline_debug_log_v1';
    const arr = JSON.parse(localStorage.getItem(key) || '[]');
    arr.push({ t: new Date().toISOString(), line });
    while (arr.length > 200) arr.shift();
    localStorage.setItem(key, JSON.stringify(arr));
  } catch {}
}

async function getCacheInfo() {
  try {
    const names = await caches.keys();
    const checks = {};

    for (const n of names) {
      const c = await caches.open(n);
      const hitOffline = await c.match('/offline');
      const hitSw = await c.match('/sw.js');
      if (hitOffline) checks[`/offline@${n}`] = true;
      if (hitSw) checks[`/sw.js@${n}`] = true;
    }

    return { names, checks };
  } catch (e) {
    return { names: [], checks: { error: String(e?.message || e) } };
  }
}

export default function OfflineDebug({ compact = false }) {
  const [info, setInfo] = useState({
    online: true,
    swSupported: false,
    swController: false,
    swScope: '',
    swActive: false,
    caches: [],
    checks: {},
    ua: '',
  });

  useEffect(() => {
    let alive = true;

    const refresh = async () => {
      try {
        const online = navigator.onLine;
        const swSupported = 'serviceWorker' in navigator;
        let swController = false;
        let swScope = '';
        let swActive = false;

        if (swSupported) {
          swController = !!navigator.serviceWorker.controller;
          const reg = await navigator.serviceWorker.getRegistration();
          swScope = reg?.scope || '';
          swActive = !!reg?.active;
        }

        const cacheInfo = await getCacheInfo();
        const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';

        const next = {
          online,
          swSupported,
          swController,
          swScope,
          swActive,
          caches: cacheInfo.names,
          checks: cacheInfo.checks,
          ua,
        };

        if (!alive) return;
        setInfo(next);
        safeSetLog(
          `REFRESH online=${online} swSupported=${swSupported} controller=${swController} active=${swActive} caches=${cacheInfo.names.length}`
        );
      } catch (e) {
        safeSetLog(`REFRESH ERROR: ${String(e?.message || e)}`);
      }
    };

    const onOnline = () => {
      safeSetLog('EVENT: online');
      refresh();
    };
    const onOffline = () => {
      safeSetLog('EVENT: offline');
      refresh();
    };

    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);

    refresh();
    const t = setInterval(refresh, 3000);

    return () => {
      alive = false;
      clearInterval(t);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  if (compact) {
    return (
      <div style={{ fontSize: 12, opacity: 0.9 }}>
        <span>NET: {info.online ? 'ONLINE' : 'OFFLINE'} </span>
        <span>SW: {info.swController ? 'ON' : 'OFF'} </span>
        <span>CACHE: {info.caches.length}</span>
      </div>
    );
  }

  return (
    <div
      style={{
        position: 'fixed',
        right: 10,
        bottom: 90,
        zIndex: 99999,
        background: '#0b0f14',
        border: '1px solid rgba(255,255,255,0.12)',
        padding: 10,
        borderRadius: 12,
        width: 320,
        color: '#e8eef7',
        fontSize: 12,
        lineHeight: 1.3,
      }}
    >
      <div style={{ fontWeight: 800, marginBottom: 6 }}>OFFLINE DEBUG</div>

      <div>
        NET: <b>{info.online ? 'ONLINE' : 'OFFLINE'}</b>
      </div>
      <div>
        SW supported: <b>{String(info.swSupported)}</b>
      </div>
      <div>
        SW controller: <b>{String(info.swController)}</b>
      </div>
      <div>
        SW active: <b>{String(info.swActive)}</b>
      </div>
      <div>
        SW scope:{' '}
        <b style={{ wordBreak: 'break-all' }}>{info.swScope || '(none)'}</b>
      </div>

      <div style={{ marginTop: 6 }}>
        Caches: <b>{info.caches.length}</b>
      </div>
      <div style={{ opacity: 0.9, wordBreak: 'break-all' }}>
        {info.caches.length ? info.caches.join(', ') : '(none)'}
      </div>

      <div style={{ marginTop: 6, fontWeight: 700 }}>Checks:</div>
      <div style={{ opacity: 0.9, wordBreak: 'break-all' }}>
        {Object.keys(info.checks || {}).length ? JSON.stringify(info.checks) : '(none)'}
      </div>

      <div style={{ marginTop: 6, opacity: 0.7, wordBreak: 'break-all' }}>
        UA: {info.ua}
      </div>
    </div>
  );
}
