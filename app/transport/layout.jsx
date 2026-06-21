'use client';

import React, { useEffect, useState } from 'react';
import { usePathname, useRouter } from '@/lib/routerCompat.jsx';
import { getTransportSession } from '@/lib/transportAuth';
import { readBestActor } from '@/lib/sessionStore';
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

function normalizeBridgeRole(role) {
  return String(role || '').trim().toUpperCase();
}

const TRANSPORT_BRIDGE_ACCESS_ROLES = new Set(['PUNTOR', 'PUNETOR', 'WORKER', 'DISPATCH', 'ADMIN', 'ADMIN_MASTER', 'OWNER', 'PRONAR', 'SUPERADMIN']);

function isTransportBridgeAccessRole(role) {
  return TRANSPORT_BRIDGE_ACCESS_ROLES.has(normalizeBridgeRole(role));
}

function isPastrimiTransportBridgeRoute(pathname) {
  if (typeof window === 'undefined') return false;
  if (String(pathname || '') !== '/transport/pranimi') return false;
  try {
    const sp = new URLSearchParams(window.location.search || '');
    return Boolean(
      String(sp.get('edit') || sp.get('id') || '').trim()
      && sp.get('from') === 'pastrimi-edit'
      && sp.get('baseBridge') === '1'
    );
  } catch {
    return false;
  }
}

function hasPastrimiBaseBridgeAccess(pathname) {
  if (!isPastrimiTransportBridgeRoute(pathname)) return false;
  try {
    const actor = readBestActor({ allowTransportFallback: false });
    return isTransportBridgeAccessRole(actor?.role);
  } catch {
    return false;
  }
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
      const isBridge = isPastrimiTransportBridgeRoute(pathname);

      // Limited bridge: base/admin users may open an existing transport order only
      // when the navigation comes from Pastrimi edit. Bridge mode must never trust
      // a stale transport session left in Safari/iPhone storage by a previous user.
      if (isBridge) {
        if (hasPastrimiBaseBridgeAccess(pathname)) {
          if (!cancelled) setStatus('ok');
          return;
        }
        if (!cancelled) setStatus('redirecting');
        redirectTimer = window.setTimeout(() => {
          if (!cancelled) router.replace('/login');
        }, 80);
        return;
      }

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
