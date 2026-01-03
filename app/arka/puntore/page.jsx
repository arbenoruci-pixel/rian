'use client';

import Link from 'next/link';

export default function ArkaPuntorePage() {
  return (
    <div className="pageWrap">
      <div className="topRow">
        <div className="hLeft">
          <div className="title">ARKA</div>
          <div className="subnav">
            <Link href="/arka" className="subItem">CASH</Link>
            <span className="dot">•</span>
            <Link href="/arka" className="subItem">HISTORI</Link>
            <span className="dot">•</span>
            <span className="subItem active">PUNTORË</span>
            <span className="dot">•</span>
            <Link href="/arka/shpenzime" className="subItem">SHPENZIME</Link>
          </div>
        </div>
        <div className="hRight">
          <Link className="homeBtn" href="/arka">KTHEHU</Link>
        </div>
      </div>

      <div className="card">
        <div className="cardTitle">PUNTORË</div>
        <div className="muted">
          Kjo faqe është placeholder (mos 404). Lista/menaxhimi i puntorëve mund të lidhet më vonë.
        </div>
      </div>

      <style jsx>{`
        .pageWrap { max-width: 600px; margin: 0 auto; padding: 20px; color: white; }
        .topRow { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
        .title { font-size: 24px; font-weight: 900; letter-spacing: 2px; }
        .subnav { display: flex; gap: 10px; font-size: 12px; margin-top: 5px; }
        .subItem { opacity: 0.6; text-decoration: none; color: white; font-weight: 700; }
        .subItem.active { opacity: 1; border-bottom: 2px solid white; }
        .dot { opacity: 0.35; }
        .homeBtn { background: rgba(255,255,255,0.1); color: white; padding: 8px 15px; border-radius: 10px; text-decoration: none; font-size: 12px; font-weight: 800; }
        .card { background: rgba(255,255,255,0.08); padding: 20px; border-radius: 20px; border: 1px solid rgba(255,255,255,0.1); }
        .cardTitle { font-size: 14px; font-weight: 900; margin-bottom: 10px; opacity: 0.5; }
        .muted { opacity: 0.7; font-weight: 700; font-size: 13px; }
      `}</style>
    </div>
  );
}
