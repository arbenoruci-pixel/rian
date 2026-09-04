'use client';

import { useEffect, useState } from 'react';
import Link from '@/lib/routerCompat.jsx';
import { getActor } from '@/lib/actorSession';

const MANAGER_ROLES = new Set([
  'DISPATCH', 'MASTER', 'MASTER USER', 'MASTER_USER', 'MASTERUSER',
  'ADMIN', 'ADMIN_MASTER', 'OWNER', 'PRONAR', 'SUPERADMIN',
]);

function upper(value) {
  return String(value || '').trim().toUpperCase();
}

export default function ArkaDailyCloseShortcut() {
  const [actor, setActor] = useState(null);
  const [path, setPath] = useState('');

  useEffect(() => {
    const refresh = () => {
      try { setActor(getActor() || null); } catch { setActor(null); }
      try { setPath(String(window.location.pathname || '')); } catch { setPath(''); }
    };
    refresh();
    try {
      window.addEventListener('popstate', refresh);
      window.addEventListener('pageshow', refresh);
      window.addEventListener('focus', refresh);
      window.addEventListener('tepiha:route-ui-alive', refresh);
    } catch {}
    return () => {
      try {
        window.removeEventListener('popstate', refresh);
        window.removeEventListener('pageshow', refresh);
        window.removeEventListener('focus', refresh);
        window.removeEventListener('tepiha:route-ui-alive', refresh);
      } catch {}
    };
  }, []);

  if (!actor || !MANAGER_ROLES.has(upper(actor?.role)) || path === '/arka/ditore') return null;

  return (
    <Link
      to="/arka/ditore"
      aria-label="Hap pasqyrën e ditës dhe wizard-in për mbylljen ditore"
      style={{
        position: 'fixed',
        right: 12,
        bottom: 'calc(74px + env(safe-area-inset-bottom, 0px))',
        zIndex: 1200,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: 48,
        padding: '0 15px',
        border: '1px solid rgba(134,239,172,.55)',
        borderRadius: 15,
        background: 'linear-gradient(135deg,#14532d,#16a34a)',
        boxShadow: '0 16px 42px rgba(0,0,0,.42)',
        color: '#fff',
        textDecoration: 'none',
        fontSize: 11,
        fontWeight: 1000,
        letterSpacing: '.045em',
        textAlign: 'center',
      }}
    >
      PASQYRA / MBYLL DITËN
    </Link>
  );
}
