'use client';

import React from 'react';
import Link from 'next/link';

export default function TransportPranimiDebug() {
  return (
    <main className="wrap" style={ padding: 18 }>
      <div style={ fontSize: 22, fontWeight: 800, marginBottom: 10 }>
        TRANSPORT • PRANIMI — LIVE STAMP 2026-02-05 v999
      </div>
      <div style={ opacity: 0.85, marginBottom: 14 }>
        NËSE PO E SHEH KËTË, ATËHERË VERCEL PO SHËRBEN DEPLOY-IN E FUNDIT DHE ROUTE-I /transport/pranimi ËSHTË OK.
      </div>
      <div style={ display: 'flex', gap: 10 }>
        <Link className="pill" href="/transport">KTHEHU NË TRANSPORT</Link>
        <Link className="pill" href="/">HOME</Link>
      </div>
      <div style={ marginTop: 16, fontSize: 13, opacity: 0.8 }>
        Pasi ta konfirmosh këtë stamp, kthehemi e fusim formën e plotë (pa u përzi me /pranim).
      </div>
    </main>
  );
}
