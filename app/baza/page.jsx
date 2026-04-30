'use client';

import Link from '@/lib/routerCompat.jsx';

export default function BazaMenuPage() {
  return (
    <div className="wrap">
      <header className="header-row">
        <h1 className="title">BAZA</h1>
        <div style={{ width: 40 }} />
      </header>

      <section className="card">
        <h2 className="card-title">MODULET E BAZËS</h2>

        <div className="home-nav">
          <Link prefetch={false} className="home-btn" href="/pranimi?fresh=1">
            <span>🧾</span>
            <div>
              <div>PRANIMI</div>
              <small>Regjistro klientin &amp; tepihat</small>
            </div>
          </Link>

          <Link prefetch={false} className="home-btn" href="/pastrimi">
            <span>🧼</span>
            <div>
              <div>PASTRIMI</div>
              <small>Lista në pastrim + detaje</small>
            </div>
          </Link>

          <Link prefetch={false} className="home-btn" href="/gati">
            <span>✅</span>
            <div>
              <div>GATI</div>
              <small>Gati për marrje</small>
            </div>
          </Link>

          <Link className="home-btn" href="/marrje-sot">
            <span>📦</span>
            <div>
              <div>MARRJE SOT</div>
              <small>Dorëzime / marrje</small>
            </div>
          </Link>

          <Link prefetch={false} className="home-btn" href="/arka">
            <span>💰</span>
            <div>
              <div>ARKA</div>
              <small>Pagesa &amp; mbyllja e ditës</small>
            </div>
          </Link>

          <Link className="home-btn" href="/fletore">
            <span>📒</span>
            <div>
              <div>FLETORJA</div>
              <small>Backup / lista</small>
            </div>
          </Link>
        </div>

        <div style={{ marginTop: 14 }}>
          <Link className="btn" href="/">← HOME</Link>
        </div>
      </section>
    </div>
  );
}
