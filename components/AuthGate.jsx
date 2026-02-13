'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import ApprovalsPopup from './ApprovalsPopup';
import OwedCashPopup from './OwedCashPopup';
import { startSyncLoop } from '@/lib/syncBootstrap';

// Login happens ONLY on /login.
// After login we keep a session in localStorage with an expiry (default 8h).
// We do NOT re-prompt for PIN on every navigation; we only re-auth when the session expires
// or when the user logs out / switches user.

const LS_USER = 'CURRENT_USER_DATA';
const LS_SESSION = 'tepiha_session_v1';

function readJSON(key, fallback = null) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function clearSession() {
  try {
    localStorage.removeItem(LS_SESSION);
    localStorage.removeItem(LS_USER);
  } catch {}
}

export default function AuthGate({ children }) {
  const router = useRouter();
  const pathname = usePathname();
  const [user, setUser] = useState(null);
  const timeoutRef = useRef(null);

  const isLogin = useMemo(() => pathname === '/login', [pathname]);

  useEffect(() => {
    // Always allow login route.
    if (isLogin) {
      setUser(null);
      return;
    }

    // Validate session.
    const session = readJSON(LS_SESSION, null);
    const now = Date.now();

    if (!session?.user || !session?.expiresAt || session.expiresAt <= now) {
      clearSession();
      router.replace('/login');
      return;
    }

    // Keep CURRENT_USER_DATA in sync for legacy pages.
    try {
      localStorage.setItem(LS_USER, JSON.stringify(session.user));
    } catch {}

    setUser(session.user);
    try { startSyncLoop(); } catch {}

    // --- ROLE BASED LANDING / ACCESS ---
    // TRANSPORT users should see transport-only tools by default.
    // Escape hatch: open a base URL once with ?base=1 to allow base screens on this device.
    try {
      const role = String(session?.user?.role || '').toUpperCase();
      if (role === 'TRANSPORT') {
        const isTransportPath = pathname === '/transport' || String(pathname || '').startsWith('/transport/');
        const isLogin = pathname === '/login';

        if (!isLogin && !isTransportPath) {
          let allowBase = false;
          try {
            allowBase = localStorage.getItem('ALLOW_BASE') === '1';
          } catch {}

          // one-time unlock via query
          try {
            const qs = new URLSearchParams(window.location.search || '');
            if (qs.get('base') === '1') {
              allowBase = true;
              try { localStorage.setItem('ALLOW_BASE', '1'); } catch {}
            }
          } catch {}

          if (!allowBase) {
            router.replace('/transport/menu');
            return;
          }
        }
      }
    } catch {}

    // Auto-logout exactly at expiry.
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    const ms = Math.max(0, session.expiresAt - now);
    timeoutRef.current = setTimeout(() => {
      clearSession();
      router.replace('/login');
    }, ms);

    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [isLogin, pathname, router]);

  const onLogout = () => {
    clearSession();
    router.replace('/login');
  };

  // For /login we don't wrap.
  if (isLogin) return <>{children}</>;

  // While checking session, avoid flashing content.
  if (!user) return null;

  return (
    <div>
      <ApprovalsPopup />
      <OwedCashPopup />
      {/* Session chip (fixed on screen) */}
      <div
        style={{
          position: 'fixed',
          bottom: 10,
          right: 10,
          zIndex: 9999,
          transform: 'scale(0.6)',
          transformOrigin: 'bottom right'
        }}
        className="bg-black/80 border border-gray-800 rounded px-3 py-2"
      >
        <div className="flex items-center gap-2">
          <div className="text-[10px] leading-tight">
            <div className="text-gray-300 font-black uppercase">{user?.name || 'USER'}</div>
            <div className="text-gray-500 font-black uppercase">{user?.role || ''}</div>
          </div>
          <button
            onClick={onLogout}
            className="px-2 py-1 text-[10px] font-black uppercase border border-gray-700 text-gray-200 rounded hover:bg-gray-900"
            title="LOG OUT / SWITCH USER"
          >
            LOG OUT
          </button>
        </div>
      </div>

      {children}
    </div>
  );
}
