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
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div className="label">PËRDORUESI</div>
                <div style={{ fontWeight: 800 }}>{String(me?.name || '').toUpperCase()}</div>
                <div className="muted">{role}</div>
              </div>
</div>

            <div style={{ height: 10 }} />
            <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
              <Link className="btn btn-primary" href="/transport/pranimi">PRANIMI (TRANSPORT)</Link>
              <Link className="btn" href="/transport/gati">GATI (TRANSPORT)</Link>
              <Link className="btn" href="/transport/arka">ARKA (TRANSPORT)</Link>
              <Link className="btn" href="/pastrimi">PASTRIMI (PËRBASHKËT)</Link>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
