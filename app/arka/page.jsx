'use client';

import Link from 'next/link';

function Tile({ href, name, desc, icon }) {
  return (
    <Link href={href} className="arka-card arka-tile" style={{ textDecoration: 'none' }}>
      <div className="arka-tile-top">
        <div className="arka-icon" aria-hidden="true">{icon}</div>
        <div aria-hidden="true" style={{ opacity: 0.55, fontSize: 22 }}>›</div>
      </div>
      <div>
        <div className="arka-tile-name">{name}</div>
        <div className="arka-tile-desc">{desc}</div>
      </div>
    </Link>
  );
}

export default function ArkaPage() {
  return (
    <div>
      <div className="arka-top">
        <div>
          <div className="arka-title">ARKA</div>
          <div className="arka-sub">CASH • HISTORI • PUNTORË • SHPENZIME</div>
        </div>
        <Link href="/" className="arka-back">HOME</Link>
      </div>

      <div className="arka-grid">
        <Tile href="/arka/cash" icon="💶" name="ARKA DITORE" desc="CASH SOT, CIKLET (OPEN/HANDED/RECEIVED)" />
        <Tile href="/arka/buxheti" icon="🏦" name="BUXHETI I KOMPANIS" desc="IN/OUT + BALANC" />
        <Tile href="/arka/shpenzime" icon="🧾" name="SHPENZIME" desc="DALJE CASH (OUT), LISTË + SHTO" />
        <Tile href="/arka/puntoret" icon="👷" name="PUNTORËT" desc="LISTA, ROLE, PIN (ADMIN/DISPATCH/PUNTOR/TRANSPORT)" />
        <Tile href="/arka/debts" icon="📌" name="BORXHET" desc="KUSH NA KA BORXH / KUJT I KEMI BORXH" />
        <Tile href="/arka/owners" icon="📈" name="INVESTIMET" desc="OWNER-AT, % PROFITIT, NDAHJE MUJORE" />
        <Tile href="/arka/reset" icon="⚠️" name="FACTORY RESET" desc="FSHI KREJT TË DHËNAT (ADMIN)" />
      </div>
    </div>
  );
}
