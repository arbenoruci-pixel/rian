'use client';

import React, { useState, useEffect, useRef } from 'react';
import { bootLog } from '@/lib/bootLog';
import { usePathname, useRouter } from 'next/navigation';

const REFRESH_EVERY_MS = 5 * 60 * 60 * 1000;

function readJson(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function readUser() {
  const direct = readJson('CURRENT_USER_DATA') || readJson('tepiha_user') || readJson('user');
  if (direct && typeof direct === 'object') {
    return {
      ...direct,
      name: direct.name || direct.username || '',
      role: String(direct.role || '').toUpperCase() || '',
    };
  }

  const session = readJson('tepiha_session_v1');
  const actor = session?.actor || session?.user || null;
  if (actor && typeof actor === 'object') {
    return {
      ...actor,
      name: actor.name || actor.username || '',
      role: String(actor.role || '').toUpperCase() || '',
    };
  }

  const transport = readJson('tepiha_transport_session_v1');
  if (transport && typeof transport === 'object') {
    return {
      ...transport,
      name: transport.transport_name || transport.name || '',
      role: String(transport.role || 'TRANSPORT').toUpperCase(),
      pin: transport.transport_pin || transport.pin || '',
    };
  }

  return null;
}


function readHomeSessionDockFlags() {
  try {
    if (typeof window === 'undefined') return { safeMode: true, disableSessionDock: false };
    const globalFlags = window.__TEPIHA_HOME_SAFE_FLAGS__;
    const sp = new URLSearchParams(window.location.search || '');
    const raw = window.localStorage?.getItem('tepiha_home_flags_v1');
    let stored = null;
    if (raw) {
      try { stored = JSON.parse(raw); } catch {}
    }
    const readBool = (name, fallback = false) => {
      const qv = sp.get(name);
      if (qv === '1' || qv === 'true') return true;
      if (qv === '0' || qv === 'false') return false;
      const gv = globalFlags?.[name];
      if (typeof gv === 'boolean') return gv;
      const sv = stored?.[name];
      if (typeof sv === 'boolean') return sv;
      return fallback;
    };
    return {
      safeMode: readBool('homeSafeMode', true),
      disableSessionDock: readBool('homeNoSessionDock', false),
    };
  } catch {
    return { safeMode: true, disableSessionDock: false };
  }
}

function waitForHomeInteractive(cb) {
  try {
    if (typeof window === 'undefined') return () => {};
    if (window.__TEPIHA_HOME_INTERACTIVE__ === true) {
      cb?.();
      return () => {};
    }
    const onInteractive = () => {
      try { window.removeEventListener('tepiha:home-interactive', onInteractive); } catch {}
      cb?.();
    };
    window.addEventListener('tepiha:home-interactive', onInteractive, { passive: true });
    return () => {
      try { window.removeEventListener('tepiha:home-interactive', onInteractive); } catch {}
    };
  } catch {
    return () => {};
  }
}

export default function SessionDock() {
  const pathname = usePathname();
  const router = useRouter();
  const [user, setUser] = useState(null);
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
    if (pathname !== '/') return;
    const homeFlags = readHomeSessionDockFlags();
    if (homeFlags.disableSessionDock) {
      bootLog('home_sessiondock_disabled', { path: pathname, homeFlags });
      return;
    }

    let timer = null;
    let cleanupInteractive = null;

    const mountDock = () => {
      bootLog('home_sessiondock_start', { path: pathname, homeFlags });
      try {
        setUser(readUser());
      } finally {
        bootLog('home_sessiondock_end', { path: pathname, hasUser: !!readUser() });
      }
      timer = window.setInterval(() => {
        if (pathname !== '/') return;
        setUser(readUser());
      }, REFRESH_EVERY_MS);
    };

    if (homeFlags.safeMode) {
      cleanupInteractive = waitForHomeInteractive(mountDock);
    } else {
      mountDock();
    }

    return () => {
      try { cleanupInteractive?.(); } catch {}
      try { if (timer) window.clearInterval(timer); } catch {}
    };
  }, [pathname]);

  useEffect(() => {
    if (pathname !== '/') return;
    const homeFlags = readHomeSessionDockFlags();
    if (homeFlags.disableSessionDock) return;

    function handleClickOutside(event) {
      if (menuRef.current && !menuRef.current.contains(event.target)) {
        setIsOpen(false);
      }
    }

    let cleanupInteractive = null;
    const attach = () => {
      document.addEventListener('mousedown', handleClickOutside);
    };

    if (homeFlags.safeMode) cleanupInteractive = waitForHomeInteractive(attach);
    else attach();

    return () => {
      try { cleanupInteractive?.(); } catch {}
      try { document.removeEventListener('mousedown', handleClickOutside); } catch {}
    };
  }, [pathname]);

  useEffect(() => {
    if (pathname === '/') return;
    setIsOpen(false);
  }, [pathname]);

  if (pathname !== '/') return null;
  const homeFlags = readHomeSessionDockFlags();
  if (homeFlags.disableSessionDock) return null;

  const fullName = String(user?.name || user?.username || 'I PANJOHUR').toUpperCase();
  const role = String(user?.role || 'PUNTOR').toUpperCase();

  function handleLogout() {
    try {
      localStorage.removeItem('CURRENT_USER_DATA');
      localStorage.removeItem('tepiha_session_v1');
      localStorage.removeItem('tepiha_transport_session_v1');
    } catch {}
    router.push('/login');
  }

  return (
    <div
      ref={menuRef}
      style={{
        position: 'fixed',
        top: 'calc(20px + env(safe-area-inset-top, 0px))',
        right: '16px',
        zIndex: 9999,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-end',
      }}
    >
      <button
        type="button"
        onClick={() => setIsOpen((v) => !v)}
        style={{
          width: '44px',
          height: '44px',
          borderRadius: '50%',
          background: isOpen ? '#2563eb' : 'rgba(255,255,255,0.08)',
          border: isOpen ? '2px solid #60a5fa' : '1px solid rgba(255,255,255,0.15)',
          color: '#fff',
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          fontSize: '20px',
          boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
          backdropFilter: 'blur(10px)',
          WebkitBackdropFilter: 'blur(10px)',
          cursor: 'pointer',
          transition: 'all 0.2s ease',
          transform: isOpen ? 'scale(1.05)' : 'scale(1)',
        }}
      >
        👤
      </button>

      {isOpen && (
        <div
          style={{
            marginTop: '12px',
            background: 'rgba(15, 23, 42, 0.95)',
            border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: '16px',
            padding: '16px',
            width: '220px',
            boxShadow: '0 20px 40px rgba(0,0,0,0.5)',
            backdropFilter: 'blur(10px)',
            WebkitBackdropFilter: 'blur(10px)',
            display: 'flex',
            flexDirection: 'column',
            gap: '12px',
            animation: 'fadeInMenu 0.2s ease-out',
            transformOrigin: 'top right',
          }}
        >
          <div
            style={{
              textAlign: 'center',
              borderBottom: '1px solid rgba(255,255,255,0.1)',
              paddingBottom: '10px',
            }}
          >
            <div style={{ fontSize: '14px', fontWeight: '900', color: '#fff', letterSpacing: '0.05em' }}>
              {fullName}
            </div>
            <div style={{ fontSize: '10px', color: '#94a3b8', fontWeight: '700', marginTop: '2px' }}>
              ROLI: {role}
            </div>
          </div>

          <button
            onClick={handleLogout}
            style={{
              background: 'rgba(239, 68, 68, 0.15)',
              color: '#f87171',
              border: '1px solid rgba(239, 68, 68, 0.3)',
              padding: '10px',
              borderRadius: '10px',
              fontWeight: '800',
              fontSize: '12px',
              cursor: 'pointer',
              display: 'flex',
              justifyContent: 'center',
              alignItems: 'center',
              gap: '6px',
            }}
          >
            🚪 DIL (LOG OUT)
          </button>
        </div>
      )}

      <style
        dangerouslySetInnerHTML={{
          __html: `
            @keyframes fadeInMenu {
              from { opacity: 0; transform: translateY(-10px) scale(0.95); }
              to { opacity: 1; transform: translateY(0) scale(1); }
            }
          `,
        }}
      />
    </div>
  );
}
