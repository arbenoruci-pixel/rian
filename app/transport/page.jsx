'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';

function readActor() {
  try {
    const raw = localStorage.getItem('CURRENT_USER_DATA');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export default function TransportHome() {
  const [me, setMe] = useState(null);

  useEffect(() => {
    setMe(readActor());
  }, []);

  const role = String(me?.role || '').toUpperCase();
  const ok = role === 'TRANSPORT' || role === 'OWNER' || role === 'ADMIN' || role === 'DISPATCH';

  return (
    <div className="wrap">
      <header className="header-row">
        <div>
          <h1 className="title">TRANSPORT</h1>
          <div className="subtitle">HYRJE ME PIN</div>
        </div>
        <Link className="pill" href="/">HOME</Link>
      </header>

      <section className="card">
        {!ok ? (
          <>
            <div className="muted" style={{ marginBottom: 10 }}>
              NUK JE I KYÇUR — Shko te LOGIN dhe hyn me PIN.
            </div>
            <Link className="btn btn-primary" href="/login">LOGIN</Link>
          </>
        ) : (
          <>
            <div className="userHead">
              <div>
                <div className="label">PËRDORUESI</div>
                <div className="userName">{String(me?.name || '').toUpperCase()}</div>
                <div className="roleChip">{role}</div>
              </div>
            </div>

            <div className="tiles">
              <Link className="tile tilePrimary" href="/transport/pranimi">
                <div className="tileIcon">➕</div>
                <div className="tileText">
                  <div className="tileTitle">PRANIMI (T)</div>
                  <div className="tileSub">KRIJO / MERRE KLIENT</div>
                </div>
              </Link>

              <Link className="tile" href="/transport/gati">
                <div className="tileIcon">✅</div>
                <div className="tileText">
                  <div className="tileTitle">GATI (T)</div>
                  <div className="tileSub">VETËM POROSITË E TUA</div>
                </div>
              </Link>

              <Link className="tile tileWide" href="/pastrimi">
                <div className="tileIcon">🧽</div>
                <div className="tileText">
                  <div className="tileTitle">PASTRIMI (ALL)</div>
                  <div className="tileSub">BAZË + TRANSPORT</div>
                </div>
              </Link>
            </div>

            <div className="hint">TIP: PREK = SMS DIRECT • MBAJ SHTYP = OPSIONET</div>
          </>
        )}
      </section>

      <style jsx>{`
        .userHead { display:flex; align-items:center; justify-content:space-between; }
        .userName { font-weight: 900; letter-spacing: .06em; margin-top: 2px; }
        .roleChip {
          display:inline-block;
          margin-top: 8px;
          padding: 6px 10px;
          border-radius: 999px;
          border: 1px solid rgba(255,255,255,.16);
          background: rgba(255,255,255,.06);
          font-weight: 800;
          font-size: 12px;
          letter-spacing: .12em;
          text-transform: uppercase;
        }
        .tiles { margin-top: 14px; display:grid; grid-template-columns: 1fr 1fr; gap: 10px; }
        .tile {
          display:flex;
          gap: 10px;
          align-items:center;
          padding: 14px 12px;
          border-radius: 14px;
          border: 1px solid rgba(255,255,255,.14);
          background: rgba(255,255,255,.04);
          text-decoration: none;
        }
        .tilePrimary {
          border-color: rgba(60,160,255,.35);
          background: rgba(20,120,255,.14);
        }
        .tileWide { grid-column: 1 / -1; }
        .tileIcon { font-size: 22px; width: 26px; text-align:center; }
        .tileTitle { font-weight: 900; letter-spacing: .10em; }
        .tileSub { margin-top: 4px; opacity: .7; font-size: 11px; letter-spacing: .08em; }
        .hint { margin-top: 12px; opacity: .55; font-size: 11px; letter-spacing: .08em; }
        @media (max-width: 420px) {
          .tiles { grid-template-columns: 1fr; }
          .tileWide { grid-column: auto; }
        }
      `}</style>
    </div>
  );
}
