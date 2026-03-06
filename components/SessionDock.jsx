'use client';

import React, { useState, useEffect, useRef } from 'react';
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
  const [user, setUser] = useState(null);
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef(null);

  useEffect(() => {
    setUser(readUser());
    const refresh = () => setUser(readUser());
    window.addEventListener('storage', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      window.removeEventListener('storage', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, []);

  // Mbyll kartelën nëse klikon jashtë saj
  useEffect(() => {
    function handleClickOutside(event) {
      if (menuRef.current && !menuRef.current.contains(event.target)) {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  if (pathname !== '/') return null;

  const fullName = String(user?.name || user?.username || 'I Panjohur').toUpperCase();
  const role = String(user?.role || 'PUNTOR').toUpperCase();

  function handleLogout() {
    localStorage.removeItem('CURRENT_USER_DATA');
    localStorage.removeItem('tepiha_session_v1');
    router.push('/login');
  }

  function goDoctor() {
    router.push('/doctor');
    setIsOpen(false);
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
        alignItems: 'flex-end', // E mban rrethin dhe menunë të ngjitura në të djathtë
      }}
    >
      {/* RRETHI (PULLA) LART DJATHTAS */}
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
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
          transform: isOpen ? 'scale(1.05)' : 'scale(1)'
        }}
      >
        👤
      </button>

      {/* KARTELA QE HAPET POSHTË RRETHIT */}
      {isOpen && (
        <div style={{
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
          transformOrigin: 'top right'
        }}>
          <div style={{ textAlign: 'center', borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: '10px' }}>
            <div style={{ fontSize: '14px', fontWeight: '900', color: '#fff', letterSpacing: '0.05em' }}>{fullName}</div>
            <div style={{ fontSize: '10px', color: '#94a3b8', fontWeight: '700', marginTop: '2px' }}>ROLI: {role}</div>
          </div>

          <button
            onClick={goDoctor}
            style={{
              background: 'rgba(59, 130, 246, 0.15)',
              color: '#60a5fa',
              border: '1px solid rgba(59, 130, 246, 0.3)',
              padding: '10px',
              borderRadius: '10px',
              fontWeight: '800',
              fontSize: '12px',
              cursor: 'pointer',
              display: 'flex',
              justifyContent: 'center',
              alignItems: 'center',
              gap: '6px'
            }}
          >
            🛠️ SISTEMI (DOC)
          </button>

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
              gap: '6px'
            }}
          >
            🚪 DIL (LOG OUT)
          </button>
        </div>
      )}
      
      <style dangerouslySetInnerHTML={{__html: `
        @keyframes fadeInMenu {
          from { opacity: 0; transform: translateY(-10px) scale(0.95); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }
      `}} />
    </div>
  );
}
