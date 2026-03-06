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
    const role = String(user?.role || '').trim();
    if (!user) return 'PA USER';
    return (name || 'USER') + (role ? ` • ${role}` : '');
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
        padding: '10px 12px calc(10px + env(safe-area-inset-bottom))',
        pointerEvents: 'none',
      }}
    >
      <div
        style={{
          maxWidth: 520,
          margin: '0 auto',
          borderRadius: 14,
          border: '1px solid rgba(255,255,255,0.10)',
          background: 'rgba(10,14,20,0.92)',
          boxShadow: '0 10px 30px rgba(0,0,0,0.45)',
          padding: '8px 10px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 10,
          pointerEvents: 'auto',
        }}
      >
        <button
          type="button"
          onClick={openDoctor}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            minWidth: 0,
            background: 'transparent',
            border: 'none',
            padding: 0,
            color: 'inherit',
            cursor: 'pointer',
          }}
        >
          <div
            aria-hidden
            style={{
              width: 34,
              height: 34,
              borderRadius: 10,
              background: 'rgba(255,255,255,0.08)',
              display: 'grid',
              placeItems: 'center',
              fontSize: 18,
              flex: '0 0 auto',
            }}
          >
            👤
          </div>
          <div style={{ minWidth: 0, textAlign: 'left' }}>
            <div style={{ fontWeight: 800, letterSpacing: 1, fontSize: 12, textTransform: 'uppercase', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {label}
            </div>
            <div style={{ fontSize: 10, opacity: 0.75, letterSpacing: 1, textTransform: 'uppercase' }}>
              {navigator.onLine === false ? 'OFFLINE' : 'ONLINE'}
            </div>
          </div>
        </button>

        {!user ? (
          <button
            type="button"
            onClick={() => router.push('/login')}
            style={{
              padding: '8px 10px',
              borderRadius: 999,
              background: 'rgba(255,255,255,0.95)',
              color: '#000',
              border: 'none',
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
              padding: '8px 10px',
              borderRadius: 999,
              background: 'rgba(255,70,70,0.14)',
              color: '#ffb3b3',
              border: '1px solid rgba(255,70,70,0.25)',
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
