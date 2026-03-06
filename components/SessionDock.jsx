'use client';

import React from 'react';
import { usePathname, useRouter } from 'next/navigation';

function readUser() {
  try {
    const raw =
      localStorage.getItem('CURRENT_USER_DATA') ||
      localStorage.getItem('tepiha_user') ||
      localStorage.getItem('user');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export default function SessionDock() {
  const pathname = usePathname();
  const router = useRouter();
  const [user, setUser] = React.useState(null);

  React.useEffect(() => {
    setUser(readUser());

    const onStorage = () => setUser(readUser());
    window.addEventListener('storage', onStorage);

    const onFocus = () => setUser(readUser());
    window.addEventListener('focus', onFocus);

    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('focus', onFocus);
    };
  }, []);

  if (pathname !== '/') return null;
  if (!user) return null;

  const displayName =
    String(user?.name || user?.username || user?.full_name || 'PËRDORUES')
      .trim()
      .split(' ')[0]
      .toUpperCase();

  function openDoctor() {
    router.push('/doctor');
  }

  function logout() {
    try {
      localStorage.removeItem('CURRENT_USER_DATA');
      localStorage.removeItem('tepiha_user');
      localStorage.removeItem('user');
      localStorage.removeItem('session');
    } catch {}
    router.push('/login');
  }

  return (
    <div
      style={{
        position: 'fixed',
        left: '50%',
        bottom: 10,
        transform: 'translateX(-50%)',
        zIndex: 9999,
        pointerEvents: 'none',
      }}
    >
      <div
        style={{
          pointerEvents: 'auto',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          background: 'rgba(15,15,15,0.96)',
          border: '1px solid rgba(255,255,255,0.12)',
          borderRadius: 999,
          padding: '4px 6px',
          boxShadow: '0 6px 20px rgba(0,0,0,0.35)',
          backdropFilter: 'blur(8px)',
          WebkitBackdropFilter: 'blur(8px)',
        }}
      >
        <button
          type="button"
          onClick={openDoctor}
          aria-label="Profili"
          style={{
            width: 22,
            height: 22,
            minWidth: 22,
            borderRadius: '999px',
            border: '1px solid rgba(255,255,255,0.12)',
            background: '#1c1c1e',
            color: '#fff',
            display: 'grid',
            placeItems: 'center',
            fontSize: 11,
            lineHeight: 1,
            cursor: 'pointer',
            padding: 0,
          }}
        >
          👤
        </button>

        <button
          type="button"
          onClick={openDoctor}
          style={{
            border: 0,
            background: 'transparent',
            color: '#f5f5f5',
            fontSize: 10,
            fontWeight: 600,
            letterSpacing: '0.04em',
            lineHeight: 1,
            padding: '0 2px',
            cursor: 'pointer',
            textTransform: 'uppercase',
            whiteSpace: 'nowrap',
          }}
        >
          {displayName}
        </button>

        <div
          style={{
            width: 1,
            height: 12,
            background: 'rgba(255,255,255,0.12)',
            margin: '0 1px',
          }}
        />

        <button
          type="button"
          onClick={logout}
          style={{
            border: '1px solid rgba(255,255,255,0.12)',
            background: '#111',
            color: '#fff',
            borderRadius: 999,
            fontSize: 10,
            fontWeight: 700,
            lineHeight: 1,
            padding: '4px 7px',
            cursor: 'pointer',
            textTransform: 'uppercase',
          }}
        >
          DIL
        </button>
      </div>
    </div>
  );
}