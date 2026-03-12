'use client';

import { useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';

const CANDIDATE_KEYS = [
  'tepiha_session_v1',
  'CURRENT_USER_DATA',
  'tepiha_user',
  'user',
  'auth_user',
  'session',
];

function pickUser(payload) {
  if (!payload) return null;
  if (payload.user && typeof payload.user === 'object') return payload.user;
  if (payload.currentUser && typeof payload.currentUser === 'object') return payload.currentUser;
  if (payload.name || payload.username || payload.full_name || payload.pin || payload.role) return payload;
  return null;
}

function readSessionUser() {
  try {
    for (const key of CANDIDATE_KEYS) {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw);
        const user = pickUser(parsed);
        if (user) return user;
      } catch {
        if (key === 'CURRENT_USER_DATA' || key === 'tepiha_user' || key === 'user') {
          return { name: String(raw || '').trim() };
        }
      }
    }
  } catch {}
  return null;
}

export default function SessionDock() {
  const pathname = usePathname();
  const router = useRouter();
  const [user, setUser] = useState(null);

  useEffect(() => {
    const sync = () => setUser(readSessionUser());
    sync();
    window.addEventListener('storage', sync);
    window.addEventListener('focus', sync);
    const id = window.setInterval(sync, 1200);
    return () => {
      window.removeEventListener('storage', sync);
      window.removeEventListener('focus', sync);
      window.clearInterval(id);
    };
  }, []);

  const label = useMemo(() => {
    const raw = String(user?.name || user?.username || user?.full_name || user?.pin || 'MJESHTRI').trim();
    return (raw.split(' ')[0] || 'MJESHTRI').toUpperCase();
  }, [user]);

  function openDoctor() {
    router.push('/doctor');
  }

  function doLogout() {
    try {
      localStorage.removeItem('tepiha_session_v1');
      localStorage.removeItem('CURRENT_USER_DATA');
      localStorage.removeItem('tepiha_user');
      localStorage.removeItem('user');
      localStorage.removeItem('auth_user');
      localStorage.removeItem('session');
    } catch {}
    setUser(null);
    router.push('/login');
  }

  if (pathname !== '/') return null;

  if (!user) {
    return (
      <div
        style={{
          position: 'fixed',
          left: '50%',
          bottom: 'max(10px, env(safe-area-inset-bottom))',
          transform: 'translateX(-50%)',
          zIndex: 9999,
        }}
      >
        <button
          type="button"
          onClick={() => router.push('/login')}
          style={{
            border: '1px solid rgba(255,255,255,0.12)',
            background: 'rgba(10,14,20,0.94)',
            color: '#fff',
            borderRadius: 999,
            padding: '5px 10px',
            fontSize: 10,
            fontWeight: 800,
            letterSpacing: '0.06em',
            boxShadow: '0 8px 22px rgba(0,0,0,0.35)',
          }}
        >
          HYJ
        </button>
      </div>
    );
  }

  return (
    <div
      style={{
        position: 'fixed',
        left: '50%',
        bottom: 'max(10px, env(safe-area-inset-bottom))',
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
          background: 'rgba(10,14,20,0.94)',
          border: '1px solid rgba(255,255,255,0.10)',
          borderRadius: 999,
          padding: '4px 5px',
          boxShadow: '0 8px 22px rgba(0,0,0,0.35)',
          backdropFilter: 'blur(8px)',
          WebkitBackdropFilter: 'blur(8px)',
        }}
      >
        <button
          type="button"
          onClick={openDoctor}
          aria-label="Profili"
          style={{
            width: 20,
            height: 20,
            minWidth: 20,
            borderRadius: 999,
            border: '1px solid rgba(255,255,255,0.10)',
            background: '#171b22',
            color: '#fff',
            display: 'grid',
            placeItems: 'center',
            fontSize: 10,
            lineHeight: 1,
            padding: 0,
            cursor: 'pointer',
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
            fontWeight: 700,
            lineHeight: 1,
            padding: '0 1px',
            cursor: 'pointer',
            textTransform: 'uppercase',
            whiteSpace: 'nowrap',
            letterSpacing: '0.04em',
          }}
        >
          {label}
        </button>

        <div
          style={{
            width: 1,
            height: 11,
            background: 'rgba(255,255,255,0.12)',
            margin: '0 1px',
          }}
        />

        <button
          type="button"
          onClick={doLogout}
          style={{
            border: '1px solid rgba(255,255,255,0.10)',
            background: '#11151b',
            color: '#fff',
            borderRadius: 999,
            fontSize: 10,
            fontWeight: 800,
            lineHeight: 1,
            padding: '4px 6px',
            cursor: 'pointer',
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
          }}
        >
          DIL
        </button>
      </div>
    </div>
  );
}
