'use client';

import { useEffect } from 'react';
import { startSyncLoop } from '@/lib/syncBootstrap';

export default function SyncBoot() {
  useEffect(() => {
    try { startSyncLoop(); } catch {}
  }, []);
  return null;
}
