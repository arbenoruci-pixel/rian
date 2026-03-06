'use client';

import { useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';

const LS_SESSION = 'tepiha_session_v1';
const LS_USER = 'CURRENT_USER_DATA';

function readSession() {
  try {
    const raw = localStorage.getItem(LS_SESSION);
    if (raw) {
      const s = JSON.parse(raw);
      const u = s?.user || null;
      if (u) return u;
    }
  } catch {}
  try {
    const raw2 = localStorage.getItem(LS_USER);
    if (raw2) return JSON.parse(raw2);
  } catch {}
  return null;
}

export default function SessionDock() {
  const router = useRouter();
  const pathname = usePathname();
  const [user, setUser] = useState(null);

  useEffect(() => {
    const tick = () => setUser(readSession());
    tick();
    const id = setInterval(tick, 1000);
    window.addEventListener('storage', tick);
    return () => {
      clearInterval(id);
      window.removeEventListener('storage', tick);
    };
  }, []);

  const label = useMemo(() => {
    const name = String(user?.name || '').trim();
    return name || 'MJESHTRI';
  }, [user]);

  async function doLogout() {
    try {
      localStorage.removeItem(LS_SESSION);
      localStorage.removeItem(LS_USER);
      localStorage.removeItem('session');
      localStorage.removeItem('user');
      localStorage.removeItem('auth_user');
    } catch {}
    setUser(null);
    try {
      router.replace('/login');
    } catch {}
  }

  function openDoctor() {
    try {
      router.push('/doctor');
    } catch {}
  }

  if (pathname !== '/') return null;

  return (
    <div
      style={{
        position: 'fixed',
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 9999,
        display: 'flex',
        justifyContent: 'center',
        padding: '10px 12px calc(10px + env(safe-area-inset-bottom))',
        pointerEvents: 'none',
      }}
    >
      <div
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          maxWidth: 'calc(100vw - 24px)',
          borderRadius: 999,
          border: '1px solid rgba(255,255,255,0.10)',
          background: 'rgba(10,14,20,0.92)',
          boxShadow: '0 12px 34px rgba(0,0,0,0.40)',
          padding: '8px 10px',
          pointerEvents: 'auto',
          backdropFilter: 'blur(10px)',
          WebkitBackdropFilter: 'blur(10px)',
        }}
      >
        <button
          type="button"
          onClick={openDoctor}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            minWidth: 0,
            border: 'none',
            background: 'transparent',
            color: '#fff',
            padding: '2px 4px',
            cursor: 'pointer',
          }}
        >
          <span
            aria-hidden
            style={{
              width: 30,
              height: 30,
              borderRadius: 999,
              background: 'rgba(255,255,255,0.08)',
              display: 'grid',
              placeItems: 'center',
              fontSize: 16,
              flex: '0 0 auto',
            }}
          >
            👤
          </span>
          <span
            style={{
              maxWidth: '42vw',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              fontWeight: 800,
              fontSize: 12,
              letterSpacing: 0.6,
              textTransform: 'uppercase',
            }}
          >
            {label}
          </span>
        </button>

        <div
          style={{
            width: 1,
            height: 18,
            background: 'rgba(255,255,255,0.10)',
            flex: '0 0 auto',
          }}
        />

        {!user ? (
          <button
            type="button"
            onClick={() => router.push('/login')}
            style={{
              border: 'none',
              background: 'rgba(255,255,255,0.95)',
              color: '#000',
              borderRadius: 999,
              padding: '8px 12px',
              fontWeight: 900,
              fontSize: 10,
              letterSpacing: 1,
              textTransform: 'uppercase',
              cursor: 'pointer',
            }}
          >
            HYJ
          </button>
        ) : (
          <button
            type="button"
            onClick={doLogout}
            style={{
              borderRadius: 999,
              background: 'rgba(255,70,70,0.14)',
              color: '#ffb3b3',
              border: '1px solid rgba(255,70,70,0.25)',
              padding: '8px 12px',
              fontWeight: 900,
              fontSize: 10,
              letterSpacing: 1,
              textTransform: 'uppercase',
              cursor: 'pointer',
            }}
          >
            DIL
          </button>
        )}
      </div>
    </div>
  );
}
