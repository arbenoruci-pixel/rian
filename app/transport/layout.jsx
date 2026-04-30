'use client';

import React, { useEffect, useState } from 'react';
import { usePathname, useRouter } from '@/lib/routerCompat.jsx';
import { getTransportSession } from '@/lib/transportAuth';
import TransportSyncStarter from '@/components/transport/TransportSyncStarter';

function TransportLayoutShell({ text = 'DUKE HAPUR TRANSPORT…' }) {
  return (
    <div style={{ minHeight: '100vh', background: '#0B1020', color: '#fff', display: 'grid', placeItems: 'center', padding: 24 }}>
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontWeight: 1000, letterSpacing: 0.6, fontSize: 18 }}>{text}</div>
        <div style={{ marginTop: 10, fontSize: 12, color: 'rgba(255,255,255,0.62)', fontWeight: 700 }}>TRANSPORT SHELL</div>
      </div>
    </div>
  );
}

// Guard for ALL /transport/* pages.
// Show a stable shell while the transport session is being resolved,
// instead of returning null and risking a blank view.
export default function TransportLayout({ children }) {
  const router = useRouter();
  const pathname = usePathname();
  const [status, setStatus] = useState('checking');

  useEffect(() => {
    let cancelled = false;
    let redirectTimer = null;

    const resolve = () => {
      const session = getTransportSession();
      const tid = session?.transport_id ? String(session.transport_id) : '';

      if (tid) {
        if (!cancelled) setStatus('ok');
        return;
      }

      if (!cancelled) setStatus('redirecting');
      redirectTimer = window.setTimeout(() => {
        if (!cancelled) router.replace('/login');
      }, 80);
    };

    resolve();
    const onResume = () => resolve();
    window.addEventListener('focus', onResume, { passive: true });
    document.addEventListener('visibilitychange', onResume, { passive: true });

    return () => {
      cancelled = true;
      try { if (redirectTimer) window.clearTimeout(redirectTimer); } catch {}
      window.removeEventListener('focus', onResume);
      document.removeEventListener('visibilitychange', onResume);
    };
  }, [router, pathname]);

  if (status !== 'ok') {
    return <TransportLayoutShell text={status === 'redirecting' ? 'PO RIDREJTOHESH…' : 'DUKE HAPUR TRANSPORT…'} />;
  }

  return <>
    {children}
    <TransportSyncStarter />
  </>;
}
