'use client';

import React, { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function TransportRedirect() {
  const router = useRouter();

  useEffect(() => {
    router.replace('/transport');
  }, [router]);

  return (
    <div className="wrap">
      <header className="header-row">
        <h1 className="title">TRANSPORT</h1>
      </header>
      <section className="card">
        <div className="muted">DUKE HAPUR...</div>
      </section>
    </div>
  );
}
