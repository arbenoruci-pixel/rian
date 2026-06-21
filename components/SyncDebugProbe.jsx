'use client';

import { useEffect } from 'react';
import { getOutboxSnapshot } from '@/lib/syncManager';
import { syncDebugLog } from '@/lib/syncDebug';

function pendingCount() {
  try {
    const items = getOutboxSnapshot();
    return Array.isArray(items)
      ? items.filter((item) => String(item?.status || 'pending') !== 'failed_permanently').length
      : 0;
  } catch {
    return 0;
  }
}

export default function SyncDebugProbe() {
  useEffect(() => {
    syncDebugLog('probe_mount', { pending: pendingCount() });

    const onOnline = () => syncDebugLog('probe_online', { pending: pendingCount() });
    const onOffline = () => syncDebugLog('probe_offline', { pending: pendingCount() });
    const onFocus = () => syncDebugLog('probe_focus', { pending: pendingCount() });
    const onPageShow = () => syncDebugLog('probe_pageshow', { pending: pendingCount() });
    const onVisible = () => {
      try {
        syncDebugLog('probe_visibility', {
          state: document.visibilityState || '',
          pending: pendingCount(),
        });
      } catch {}
    };
    const onOutboxChanged = () => syncDebugLog('probe_outbox_changed', { pending: pendingCount() });
    const onSyncStatus = (event) => syncDebugLog('probe_sync_status', event?.detail || {});

    window.addEventListener('online', onOnline, { passive: true });
    window.addEventListener('offline', onOffline, { passive: true });
    window.addEventListener('focus', onFocus, { passive: true });
    window.addEventListener('pageshow', onPageShow, { passive: true });
    window.addEventListener('tepiha:outbox-changed', onOutboxChanged);
    window.addEventListener('tepiha:sync-status', onSyncStatus);
    document.addEventListener('visibilitychange', onVisible, { passive: true });

    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('pageshow', onPageShow);
      window.removeEventListener('tepiha:outbox-changed', onOutboxChanged);
      window.removeEventListener('tepiha:sync-status', onSyncStatus);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  return null;
}
