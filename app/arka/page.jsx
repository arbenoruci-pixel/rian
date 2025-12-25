'use client';

import Link from 'next/link';

function Tile({ href, title, desc, icon }) {
  return (
    <Link href={href} className="arkaTile">
      <div className="arkaTileTop">
        <div className="arkaTileIcon" aria-hidden="true">{icon}</div>
        <div className="arkaTileArrow" aria-hidden="true">›</div>
      </div>
      <div className="arkaTileTitle">{title}</div>
      <div className="arkaTileDesc">{desc}</div>
    </Link>
  );
}

export default function ArkaMenuPage() {
  return (
    <div>
      <div className="arkaHomeHeader">
        <div className="arkaHomeTitle">MENU</div>
        <div className="arkaHomeSub">ZGJEDH MODULIN</div>
      </div>

      <div className="arkaTiles">
        <Tile href="/arka/cash" icon="💶" title="CASH" desc="HAP / MBYLLE • LËVIZJE SOT" />
        <Tile href="/arka/shpenzime" icon="🧾" title="SHPENZIME" desc="DALJE CASH • LISTË + SHTO" />
        <Tile href="/arka/puntoret" icon="👷" title="PUNTORËT" desc="ROLE • PIN • AKSES" />
        <Tile href="/arka/debts" icon="📌" title="BORXHET" desc="KUSH NA KA / KUJT I KEMI" />
        <Tile href="/arka/owners" icon="📈" title="INVESTIME" desc="OWNER SPLIT • MUJOR" />
        <Tile href="/" icon="🏠" title="HOME" desc="KTHEHU NË HOME" />
      </div>
    </div>
  );
}
