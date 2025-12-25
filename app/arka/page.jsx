'use client';

import Link from 'next/link';

// ARKA MENU — ekran i pastër (MODULAR)
// Qëllimi: preke ARKA -> hapet vetëm menyja me module.
// MODULËT (HAPI B):
// - /arka/puntoret
// - /arka/cash
// - /arka/shpenzime
// - /arka/debts
// - /arka/owners

function Tile({ href, title, desc, icon }) {
  return (
    <Link href={href} className="arkaTile">
      <div className="arkaTileIcon" aria-hidden="true">{icon}</div>
      <div className="arkaTileText">
        <div className="arkaTileTitle">{title}</div>
        <div className="arkaTileDesc">{desc}</div>
      </div>
      <div className="arkaTileArrow" aria-hidden="true">›</div>
    </Link>
  );
}

export default function ArkaMenuPage() {
  return (
    <div className="arkaWrap">
      <div className="arkaHeader">
        <div className="arkaH1">ARKA</div>
        <div className="arkaH2">ZGJEDH MODULIN</div>
      </div>

      <div className="arkaGrid">
        <Tile
          href="/arka/cash"
          icon="💶"
          title="BUXHETI"
          desc="CASH SOT, HAP/MBYLLE DITËN"
        />

        <Tile
          href="/arka/shpenzime"
          icon="🧾"
          title="SHPENZIME"
          desc="DALJE CASH (OUT), LISTË + SHTO"
        />
        <Tile
          href="/arka/puntoret"
          icon="👷"
          title="PUNTORËT"
          desc="LISTA, ROLE, PIN (ADMIN/DISPATCH/PUNTOR/TRANSPORT)"
        />
        <Tile
          href="/arka/debts"
          icon="📌"
          title="BORXHET"
          desc="KUSH NA KA BORXH / KUJT I KEMI BORXH"
        />
        <Tile
          href="/arka/owners"
          icon="📈"
          title="INVESTIMET"
          desc="OWNER-AT, % PROFITIT, NDAHJE MUJORE"
        />

      </div>

      <div className="arkaFooter">
        <Link href="/" className="arkaBtn">HOME</Link>
      </div>

      <style jsx>{`
        .arkaWrap{min-height:100vh;padding:18px 14px 30px;max-width:720px;margin:0 auto;}
        .arkaHeader{padding:6px 4px 16px;}
        .arkaH1{font-size:44px;letter-spacing:1px;font-weight:900;}
        .arkaH2{margin-top:6px;opacity:.75;font-weight:700;letter-spacing:.18em;}
        .arkaGrid{display:grid;gap:12px;margin-top:12px;}
        .arkaTile{display:flex;align-items:center;gap:12px;padding:14px 14px;border-radius:16px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);text-decoration:none;}
        .arkaTileIcon{font-size:26px;width:38px;height:38px;display:flex;align-items:center;justify-content:center;border-radius:12px;background:rgba(255,255,255,.06);}
        .arkaTileText{flex:1;min-width:0;}
        .arkaTileTitle{font-weight:900;letter-spacing:.14em;}
        .arkaTileDesc{margin-top:6px;opacity:.75;font-size:12px;letter-spacing:.08em;line-height:1.3;}
        .arkaTileArrow{opacity:.5;font-size:26px;padding-left:6px;}
        .arkaFooter{margin-top:18px;display:flex;justify-content:center;}
        .arkaBtn{display:inline-flex;align-items:center;justify-content:center;padding:10px 16px;border-radius:14px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);text-decoration:none;font-weight:900;letter-spacing:.14em;}
      `}</style>
    </div>
  );
}
