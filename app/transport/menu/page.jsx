'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { getActor } from '@/lib/actorSession';

export default function TransportMenuPage(){
  const [me, setMe] = useState(null);

  useEffect(() => { setMe(getActor()); }, []);

  const role = String(me?.role || '').toUpperCase();
  const canSee = role === 'TRANSPORT' || role === 'ADMIN' || role === 'OWNER' || role === 'DISPATCH';

  return (
    <main className="wrap">
      <header className="top">
        <div>
          <div className="h1">TRANSPORT</div>
          <div className="sub">MENU</div>
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
          <div className="p">Kjo pjesë është vetëm për TRANSPORT / ADMIN / DISPATCH.</div>
          <Link className="btn" href="/">KTHEHU HOME</Link>
        </div>
      ) : (
        <>
          <div className="card">
            <div className="t">I KYÇUR</div>
            <div className="p"><b>{me?.name || 'USER'}</b> • {role} • PIN: <b>{me?.pin || '-'}</b></div>
          </div>

          <div className="grid">
            <Link className="tile" href="/transport/pranimi">
              <div className="k">PRANIMI</div>
              <div className="d">POROSI T*</div>
            </Link>

            <Link className="tile" href="/transport/gati">
              <div className="k">GATI (VETEM TË MIAT)</div>
              <div className="d">FILTRIM ME PIN</div>
            </Link>

            <Link className="tile" href="/pastrimi">
              <div className="k">PASTRIMI (I PËRBASHKËT)</div>
              <div className="d">SHFAQ KREJT</div>
            </Link>
          </div>
        </>
      )}

      <style jsx>{`
        .grid{ display:grid; grid-template-columns:1fr; gap:12px; }
        .tile{
          display:block;
          padding:14px;
          border:1px solid rgba(255,255,255,.14);
          border-radius:12px;
          background: rgba(255,255,255,.04);
          text-decoration:none;
        }
        .k{ font-weight:800; letter-spacing:.08em; }
        .d{ opacity:.8; margin-top:6px; }
      `}</style>
    </main>
  );
}
