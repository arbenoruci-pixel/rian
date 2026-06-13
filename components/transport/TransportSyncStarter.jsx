'use client';

import { useEffect } from 'react';
import { startTransportSyncLoop } from '@/lib/transportCore/syncBootstrap';
import { isTransportPath } from '@/lib/transportCore/scope';

export default function TransportSyncStarter() {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mountPath = window.location.pathname || '';
    if (!isTransportPath(mountPath)) return;
    const stop = startTransportSyncLoop();
    return () => {
      try { if (typeof stop === 'function') stop(); } catch {}
    };
  }, []);

  return null;
}
