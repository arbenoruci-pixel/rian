'use client';

import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';

// Minimal, crash-proof TRANSPORT page.
// Uses the same localStorage session/user storage as the PIN system.

const LS_SESSION = 'tepiha_session_v1';
const LS_USERS = 'tepiha_users_v1';
const SS_MODE = 'tepiha_mode_v1'; // optional: 'BASE'

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

export default function TransportPage() {
  const [me, setMe] = useState(null);
  const [mode, setMode] = useState('TRANSPORT');

  useEffect(() => {
    // session
    const s = readJson(LS_SESSION, null);
    const users = readJson(LS_USERS, []);
    const u = s?.uid ? users.find(x => x.id === s.uid) : null;
    setMe(u || null);

    // mode override
    try {
      const m = sessionStorage.getItem(SS_MODE);
      setMode(m || 'TRANSPORT');
    } catch {
      setMode('TRANSPORT');
    }
  }, []);

  const canSee = useMemo(() => {
    const r = (me?.role || '').toUpperCase();
    // allow ADMIN too
    return r === 'TRANSPORT' || r === 'ADMIN';
  }, [me]);

  function switchToBase() {
    try {
      sessionStorage.setItem(SS_MODE, 'BASE');
      setMode('BASE');
      // go to home so they can do base actions (pranimi/pagesa)
      window.location.href = '/';
    } catch {
      window.location.href = '/';
    }
  }

  function switchToTransport() {
    try {
      sessionStorage.removeItem(SS_MODE);
      setMode('TRANSPORT');
      window.location.href = '/transport';
    } catch {
      window.location.href = '/transport';
    }
  }

  return (
    <main className="wrap">
      <header className="top">
        <div>
          <div className="h1">TRANSPORT</div>
          <div className="sub">HYRJE ME PIN</div>
        </div>
        <Link className="btn ghost" href="/">HOME</Link>
      </header>

      {!me ? (
        <div className="card">
          <div className="t">NUK JE I KYÇUR</div>
          <div className="p">Shko te LOGIN dhe hyn me PIN.</div>
          <Link className="btn" href="/login">LOGIN</Link>
        </div>
      ) : !canSee ? (
        <div className="card">
          <div className="t">S’KE LEJE</div>
          <div className="p">Kjo faqe është vetëm për TRANSPORT / ADMIN.</div>
          <Link className="btn" href="/">KTHEHU HOME</Link>
        </div>
      ) : (
        <>
          <div className="card">
            <div className="row">
              <div>
                <div className="t">I KYÇUR:</div>
                <div className="p"><b>{me.name || 'USER'}</b> • {String(me.role || '').toUpperCase()} • MODE: <b>{mode}</b></div>
              </div>
              {mode === 'BASE' ? (
                <button className="btn" onClick={switchToTransport}>KTHEHU TRANSPORT</button>
              ) : (
                <button className="btn" onClick={switchToBase}>KALO NË BAZË</button>
              )}
            </div>
          </div>

          <div className="card">
            <div className="t">POROSITË PËR TRANSPORT</div>
            <div className="p">(HAPI 3) Këtu do ta lidhim listën e porosive për transport + pranim në bazë. Për momentin është placeholder i sigurt (pa crash).</div>
          </div>
        </>
      )}
    </main>
  );
}
