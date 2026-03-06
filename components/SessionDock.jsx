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
        left: '50%',
        bottom: 'calc(15px + env(safe-area-inset-bottom, 0px))',
        transform: 'translateX(-50%)',
        zIndex: 9999,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
      }}
    >
      {/* KARTELA QE HAPET SIPËR */}
      {isOpen && (
        <div style={{
          background: 'rgba(15, 23, 42, 0.95)',
          border: '1px solid rgba(255,255,255,0.1)',
          borderRadius: '16px',
          padding: '16px',
          marginBottom: '12px',
          width: '220px',
          boxShadow: '0 20px 40px rgba(0,0,0,0.5)',
          backdropFilter: 'blur(10px)',
          WebkitBackdropFilter: 'blur(10px)',
          display: 'flex',
          flexDirection: 'column',
          gap: '12px',
          animation: 'fadeIn 0.2s ease-out'
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

      {/* RRETHI (PULLA) POSHTË */}
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        style={{
          width: '48px',
          height: '48px',
          borderRadius: '50%',
          background: isOpen ? '#2563eb' : 'rgba(12,12,14,0.92)',
          border: isOpen ? '2px solid #60a5fa' : '1px solid rgba(255,255,255,0.15)',
          color: '#fff',
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          fontSize: '22px',
          boxShadow: '0 10px 24px rgba(0,0,0,0.32)',
          backdropFilter: 'blur(10px)',
          WebkitBackdropFilter: 'blur(10px)',
          cursor: 'pointer',
          transition: 'all 0.2s ease',
          transform: isOpen ? 'scale(1.05)' : 'scale(1)'
        }}
      >
        👤
      </button>
      
      <style dangerouslySetInnerHTML={{__html: `
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(10px) scale(0.95); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }
      `}} />
    </div>
  );
}
