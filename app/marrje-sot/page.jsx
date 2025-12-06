'use client';

import Link from 'next/link';

export default function Page() {
  return (
    <div className="wrap">
      <header className="header-row">
        <div>
          <h1 className="title">MARRJE SOT</h1>
          <div className="subtitle">NË NDËRTIM</div>
        </div>
      </header>

      <section className="card">
        <p>Kjo faqe është ende në ndërtim. Fluksi kryesor PRANIMI → PASTRIMI është aktiv.</p>
      </section>

      <footer className="footer-bar">
        <Link className="btn secondary" href="/">
          🏠 HOME
        </Link>
      </footer>
    </div>
  );
}
