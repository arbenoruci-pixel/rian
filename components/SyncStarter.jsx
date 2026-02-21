'use client';

import { useEffect } from 'react';
import { startSyncLoop } from '@/lib/syncBootstrap';

export default function SyncStarter(){
  useEffect(() => {
    try { startSyncLoop(); } catch {}
  }, []);
  return null;
}
