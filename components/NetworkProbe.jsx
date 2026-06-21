"use client";

import { useEffect } from 'react';
import { appendNetworkTrace, installNetworkTrace } from '@/lib/networkTrace';

export default function NetworkProbe() {
  useEffect(() => {
    try { installNetworkTrace(); } catch {}

    const onOnline = () => appendNetworkTrace('online', {});
    const onOffline = () => appendNetworkTrace('offline', {});
    const onPageShow = (event) => appendNetworkTrace('pageshow', { persisted: !!event?.persisted });
    const onVisible = () => appendNetworkTrace('visibility', { state: document.visibilityState || '' });

    try { window.addEventListener('online', onOnline, { passive: true }); } catch {}
    try { window.addEventListener('offline', onOffline, { passive: true }); } catch {}
    try { window.addEventListener('pageshow', onPageShow, { passive: true }); } catch {}
    try { document.addEventListener('visibilitychange', onVisible, { passive: true }); } catch {}

    return () => {
      try { window.removeEventListener('online', onOnline); } catch {}
      try { window.removeEventListener('offline', onOffline); } catch {}
      try { window.removeEventListener('pageshow', onPageShow); } catch {}
      try { document.removeEventListener('visibilitychange', onVisible); } catch {}
    };
  }, []);

  return null;
}
