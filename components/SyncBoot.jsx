'use client';

import { useEffect } from 'react';
import { startAutoSync } from '@/lib/syncManager';

// Mount once (e.g., in app/layout.js) to auto-sync outbox.
export default function SyncBoot() {
  useEffect(() => {
    const stop = startAutoSync();
    return () => {
      try { stop && stop(); } catch {}
    };
  }, []);

  return null;
}
