'use client';

import { Suspense, useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { usePathname } from 'next/navigation';
import DeferredMount from '@/components/DeferredMount';

const ServiceWorkerRegister = dynamic(() => import('@/components/ServiceWorkerRegister'), { ssr: false });
const OfflineSyncRunner = dynamic(() => import('@/components/OfflineSyncRunner'), { ssr: false });
const SyncFab = dynamic(() => import('@/components/SyncFab'), { ssr: false });
const SessionDock = dynamic(() => import('@/components/SessionDock'), { ssr: false });

function isStandaloneLike() {
  try {
    if (typeof window === 'undefined') return false;
    if (window.navigator?.standalone === true) return true;
    if (typeof window.matchMedia === 'function') {
      if (window.matchMedia('(display-mode: standalone)').matches) return true;
      if (window.matchMedia('(display-mode: fullscreen)').matches) return true;
      if (window.matchMedia('(display-mode: minimal-ui)').matches) return true;
    }
  } catch {}
  return false;
}

function readForceFlag() {
  try {
    const qs = new URLSearchParams(window.location.search || '');
    if (qs.get('offlineengines') === '1') return true;
    if (window.__TEPIHA_ALLOW_BROWSER_OFFLINE_RUNTIME__ === true) return true;
    if (window.localStorage?.getItem('tepiha_allow_browser_offline_runtime') === '1') return true;
  } catch {}
  return false;
}

export default function OfflineEngineRuntime() {
  const pathname = usePathname() || '';
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    const debugPath = /^\/debug\//.test(pathname);
    const standalone = isStandaloneLike();
    const forced = readForceFlag();
    const next = !!(debugPath || standalone || forced);
    setEnabled(next);
    try {
      window.__tepihaBootDebug?.logEvent?.('offline_engine_runtime_mode', {
        path: pathname,
        enabled: next,
        debugPath,
        standalone,
        forced,
      });
    } catch {}
  }, [pathname]);

  if (!enabled) return null;

  return (
    <div id="offline-engine-container" style={{ display: 'none' }}>
      <Suspense fallback={null}>
        <DeferredMount delay={1200} idle wakeSafe wakeBufferMs={900}>
          <ServiceWorkerRegister />
        </DeferredMount>

        <DeferredMount delay={7000} idle wakeSafe wakeBufferMs={2500}>
          <OfflineSyncRunner />
          <SyncFab />
          <SessionDock />
        </DeferredMount>
      </Suspense>
    </div>
  );
}
