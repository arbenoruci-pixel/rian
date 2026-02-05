'use client';

import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';

function readActor() {
  // Primary session used across the app
  try {
    const raw = localStorage.getItem('CURRENT_USER_DATA');
    if (raw) return JSON.parse(raw);
  } catch {}

  // Fallback (older session keys)
  try {
    const s = JSON.parse(localStorage.getItem('tepiha_session_v1') || 'null');
    const users = JSON.parse(localStorage.getItem('tepiha_users_v1') || '[]');
    if (s?.uid) return users.find(x => x.id === s.uid) || null;
  } catch {}

  return null;
}

export default function TransportPage() {
  const [me, setMe] = useState(null);

  useEffect(() => {
    setMe(readActor());
  }, []);

  const role = String(me?.role || '').toUpperCase();

  const canSee = useMemo(() => {
    return role === 'TRANSPORT' || role === 'ADMIN' || role === 'OWNER' || role === 'DISPATCH';
  }, [role]);

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
          <div className="p">Kjo faqe është vetëm për TRANSPORT / DISPATCH / ADMIN / OWNER.</div>
          <Link className="btn" href="/">KTHEHU HOME</Link>
        </div>
      ) : (
        <>
          <div className="card">
            <div className="row">
              <div>
                <div className="t">I KYÇUR:</div>
                <div className="p"><b>{me.name || 'USER'}</b> • {role}</div>
              </div>
            </div>
          </div>

          <section className="card">
            <div className="t">ZGJEDH MODULIN (TRANSPORT)</div>
            <div className="home-nav">
              <Link className="home-btn" href="/transport/pranim">
                <span>🧾</span>
                <div>
                  <div>PRANIMI (T)</div>
                  <small>Krijo porosi transporti (T-kode)</small>
                </div>
              </Link>

              <Link className="home-btn" href="/transport/gati">
                <span>✅</span>
                <div>
                  <div>GATI (T)</div>
                  <small>Shfaq vetëm porositë e tua</small>
                </div>
              </Link>


              <Link className="home-btn" href="/pastrimi">
                <span>🧼</span>
                <div>
                  <div>PASTRIMI</div>
                  <small>Përbashkët për të gjithë</small>
                </div>
              </Link>
            </div>
          </section>
        </>
      )}
    </main>
  );
}