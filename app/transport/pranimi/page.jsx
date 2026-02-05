'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';

let ClientComp = null;
try {
  // This path exists in your current project (app/transport/pranim/Client.jsx)
  // If you later delete /pranim, replace this import with the inlined code.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  ClientComp = require('../pranim/Client').default;
} catch (e) {
  ClientComp = null;
}

export default function TransportPranimiPage() {
  const [ok, setOk] = useState(false);
  useEffect(() => setOk(true), []);

  if (!ok) return null;

  if (ClientComp) return <ClientComp />;

  return (
    <main className="wrap">
      <header className="top">
        <div>
          <div className="h1">TRANSPORT • PRANIMI</div>
          <div className="sub">PRANIMI PAGE U HAP • POR CLIENT.jsx S’U GJET</div>
        </div>
        <Link className="btn ghost" href="/transport">MENU</Link>
      </header>

      <section className="card">
        <div className="t">DUHET FILE-I:</div>
        <div className="p"><b>app/transport/pranim/Client.jsx</b></div>
        <div className="p">Nëse e ke fshi /pranim, atëherë duhet me e vendos kodin e formës direkt këtu.</div>
      </section>
    </main>
  );
}
