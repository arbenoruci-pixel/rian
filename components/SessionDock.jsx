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

    const refresh = () => setUser(readUser());
    window.addEventListener('storage', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      window.removeEventListener('storage', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, []);

  if (pathname !== '/') return null;

  const displayName = String(user?.name || user?.username || 'DOC')
    .trim()
    .split(' ')[0]
    .toUpperCase();

  function openDoctor() {
    router.push('/doctor');
  }

  return (
    <div
      style={{
        position: 'fixed',
        left: '50%',
        bottom: 'calc(10px + env(safe-area-inset-bottom, 0px))',
        transform: 'translateX(-50%)',
        zIndex: 9999,
      }}
    >
      <button
        type="button"
        onClick={openDoctor}
        aria-label="Open doctor"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          border: '1px solid rgba(255,255,255,0.12)',
          borderRadius: 999,
          background: 'rgba(12,12,14,0.92)',
          color: '#fff',
          padding: '7px 10px',
          boxShadow: '0 10px 24px rgba(0,0,0,0.32)',
          backdropFilter: 'blur(10px)',
          WebkitBackdropFilter: 'blur(10px)',
          cursor: 'pointer',
        }}
      >
        <span
          style={{
            width: 18,
            height: 18,
            minWidth: 18,
            borderRadius: 999,
            display: 'grid',
            placeItems: 'center',
            background: 'rgba(255,255,255,0.08)',
            fontSize: 10,
            lineHeight: 1,
          }}
        >
          👤
        </span>
        <span
          style={{
            fontSize: 10,
            fontWeight: 800,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            whiteSpace: 'nowrap',
            maxWidth: 92,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {displayName}
        </span>
        <span
          style={{
            fontSize: 9,
            fontWeight: 900,
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
            color: '#93c5fd',
          }}
        >
          DOC
        </span>
      </button>
    </div>
  );
}
