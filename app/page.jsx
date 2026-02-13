'use client';

import Link from 'next/link';

export default function HomePage() {
  return (
    <div className="wrap">
      <header className="header-row">
        <div>
          <h1 className="title">TEPIHA • HOME</h1>
          <div className="subtitle">RRJEDHA KRYESORE</div>
        </div>
      </header>

      <section className="card">
        <h2 className="card-title">ZGJEDH MODULIN</h2>
        <div className="home-nav">
          <Link className="home-btn" href="/pranimi">
            <span>🧾</span>
            <div>
              <div>PRANIMI</div>
              <small>Regjistro klientin &amp; tepihat</small>
            </div>
          </Link>
          <Link className="home-btn" href="/pastrimi">
            <span>🧼</span>
            <div>
              <div>PASTRIMI</div>
              <small>Lista në pastrim + detaje</small>
            </div>
          </Link>
          <Link className="home-btn" href="/gati">
            <span>✅</span>
            <div>
              <div>GATI</div>
              <small>Gati për marrje (placeholder)</small>
            </div>
          </Link>
          <Link className="home-btn" href="/marrje-sot">
            <span>📦</span>
            <div>
              <div>MARRJE SOT</div>
              <small>Planifiko dorëzimet e sotme (placeholder)</small>
            </div>
          </Link>
          <Link className="home-btn" href="/transport">
            <span>🚚</span>
            <div>
              <div>TRANSPORT</div>
              <small>Porosi &amp; dorëzime (T-kode)</small>
            </div>
          </Link>
          <Link className="home-btn" href="/arka">
            <span>💰</span>
            <div>
              <div>ARKA</div>
              <small>Shiko pagesat (placeholder)</small>
            </div>
          </Link>
          <Link className="home-btn" href="/fletore">
            <span>📒</span>
            <div>
              <div>FLETORJA</div>
              <small>Backup ditor (lista e klienteve)</small>
            </div>
          </Link>
        </div>
      </section>
    </div>
  );
}
