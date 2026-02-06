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
            <div className="userBox">
              <div>
                <div className="label">PËRDORUESI</div>
                <div className="userName">{String(me?.name || '').toUpperCase()}</div>
                <div className="muted">{role}</div>
              </div>
              <div className="pillTag">TRANSPORT</div>
            </div>

            <div className="grid">
              <Link className="tile" href="/transport/pranimi">
                <div className="ico">➕</div>
                <div>
                  <div className="t">PRANIMI (T)</div>
                  <div className="muted">KRIJO / MERRE KLIENT</div>
                </div>
              </Link>

              <Link className="tile" href="/transport/gati">
                <div className="ico">✅</div>
                <div>
                  <div className="t">GATI (T)</div>
                  <div className="muted">VETËM POROSITË E TUA</div>
                </div>
              </Link>

              <Link className="tile" href="/transport/arka">
                <div className="ico">💶</div>
                <div>
                  <div className="t">ARKA (T)</div>
                  <div className="muted">COLLECTED / TRANSFER</div>
                </div>
              </Link>

              <Link className="tile" href="/pastrimi">
                <div className="ico">🧽</div>
                <div>
                  <div className="t">PASTRIMI (ALL)</div>
                  <div className="muted">BAZË + TRANSPORT</div>
                </div>
              </Link>
            </div>

            <div className="hint">TIP: PREK = SMS DIRECT • MBAJ SHTYP = OPSIONET</div>
          </>
        )}
      </section>

      <style jsx>{`
        .wrap { padding: 18px; max-width: 980px; margin: 0 auto; }
        .header-row { display:flex; justify-content:space-between; align-items:flex-start; gap: 12px; margin-bottom: 14px; }
        .title { margin:0; font-size: 22px; letter-spacing: .5px; }
        .subtitle { opacity:.8; font-size: 12px; margin-top: 2px; }
        .card { background: rgba(255,255,255,.04); border: 1px solid rgba(255,255,255,.08); border-radius: 14px; padding: 14px; }
        .pill { padding: 8px 10px; border-radius: 999px; border: 1px solid rgba(255,255,255,.14); text-decoration:none; font-weight:700; font-size: 12px; }
        .btn { padding: 10px 12px; border-radius: 12px; border: 1px solid rgba(255,255,255,.16); background: rgba(255,255,255,.08); color: inherit; font-weight: 900; font-size: 12px; text-decoration:none; display:inline-flex; align-items:center; justify-content:center; }
        .btn-primary { background: rgba(59,130,246,.25); border-color: rgba(59,130,246,.35); }
        .muted { opacity:.75; font-size: 12px; }
        .label { font-weight: 900; letter-spacing: .6px; opacity: .8; font-size: 11px; }
        .userName { font-weight: 900; letter-spacing: .6px; margin-top: 2px; }
        .userBox { display:flex; justify-content:space-between; align-items:center; gap: 10px; padding: 12px; border-radius: 14px; border: 1px solid rgba(255,255,255,.10); background: rgba(255,255,255,.03); }
        .pillTag { padding: 8px 12px; border-radius: 999px; border: 1px solid rgba(255,255,255,.14); background: rgba(255,255,255,.04); font-weight: 900; }
        .grid { display:grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 12px; }
        .tile { display:flex; gap: 10px; align-items:center; padding: 12px; border-radius: 14px; border: 1px solid rgba(255,255,255,.12); background: rgba(255,255,255,.03); text-decoration:none; color: inherit; }
        .tile:active { transform: scale(.99); }
        .ico { width: 44px; height: 44px; display:flex; align-items:center; justify-content:center; border-radius: 12px; border: 1px solid rgba(255,255,255,.12); background: rgba(255,255,255,.04); font-size: 18px; }
        .t { font-weight: 900; letter-spacing: .6px; }
        .hint { margin-top: 12px; opacity: .7; font-size: 11px; letter-spacing: .5px; }
        @media (max-width: 520px) {
          .wrap { padding: 14px; }
          .grid { grid-template-columns: 1fr; }
          .tile { min-height: 64px; }
        }
      `}</style>
    </div>
  );
}
