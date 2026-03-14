'use client';

import Link from 'next/link';

function HubTile({ href, icon, title, desc, accent = '#0f172a' }) {
  return (
    <Link href={href} className="hubTile" style={{ textDecoration: 'none' }}>
      <div className="hubTileIconWrap" style={{ background: `${accent}12` }}>
        <div className="hubTileIcon" aria-hidden="true">{icon}</div>
      </div>

      <div className="hubTileBody">
        <div className="hubTileTitle">{title}</div>
        <div className="hubTileDesc">{desc}</div>
      </div>

      <div className="hubTileArrow" aria-hidden="true">›</div>
    </Link>
  );
}

export default function ArkaPage() {
  return (
    <div className="arkaHubPage">
      <div className="arkaHubShell">
        <div className="arkaHubTop">
          <div>
            <div className="arkaEyebrow">ARKA / HUB</div>
            <h1 className="arkaTitle">Menu Kryesore e Arkës</h1>
            <p className="arkaSubtitle">
              Zgjidh sektorin që dëshiron të menaxhosh. Faqe e pastër, e lehtë dhe pa lëmsh listash.
            </p>
          </div>

          <Link href="/" className="homeBtn">
            ← HOME
          </Link>
        </div>

        <div className="heroCard">
          <div className="heroBadge">LIGHT UI</div>
          <div className="heroHeading">Hub i ri për Stafin, Payroll-in dhe Shpenzimet</div>
          <div className="heroText">
            Kjo faqe tani shërben vetëm si menu kryesore. Nuk shfaq më lista punëtorësh, rroga apo llogaritje.
          </div>
        </div>

        <div className="hubGrid">
          <HubTile
            href="/arka/stafi"
            icon="👥"
            title="MENAXHIMI I STAFIT"
            desc="Pajisjet në pritje, krijimi/editimi i stafit, rolet, PIN-et dhe statusi aktiv/joaktiv."
            accent="#0f766e"
          />

          <HubTile
            href="/arka/payroll"
            icon="💸"
            title="PAYROLL & RROGAT"
            desc="Rroga bazë, dita e rrogës, avanset, borxhet afatgjata dhe Smart Payroll."
            accent="#2563eb"
          />

          <HubTile
            href="/arka/shpenzime"
            icon="🧾"
            title="SHPENZIMET"
            desc="Daljet cash, regjistrimi i shpenzimeve dhe historiku i lëvizjeve të shpenzimeve."
            accent="#c2410c"
          />
        </div>
      </div>

      <style jsx>{`
        .arkaHubPage {
          min-height: 100vh;
          background:
            radial-gradient(circle at top left, rgba(191, 219, 254, 0.35), transparent 28%),
            radial-gradient(circle at top right, rgba(167, 243, 208, 0.22), transparent 24%),
            #f8fafc;
          color: #0f172a;
          padding: 28px 16px 40px;
          font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        }

        .arkaHubShell {
          max-width: 1120px;
          margin: 0 auto;
        }

        .arkaHubTop {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 18px;
          flex-wrap: wrap;
          margin-bottom: 18px;
        }

        .arkaEyebrow {
          font-size: 12px;
          line-height: 1;
          font-weight: 900;
          letter-spacing: 0.16em;
          text-transform: uppercase;
          color: #64748b;
          margin-bottom: 10px;
        }

        .arkaTitle {
          margin: 0;
          font-size: clamp(30px, 4vw, 46px);
          line-height: 0.98;
          letter-spacing: -0.05em;
          font-weight: 900;
          color: #0f172a;
        }

        .arkaSubtitle {
          margin: 12px 0 0;
          max-width: 760px;
          color: #475569;
          font-size: 15px;
          line-height: 1.55;
        }

        .homeBtn {
          text-decoration: none;
          background: rgba(255, 255, 255, 0.95);
          color: #0f172a;
          border: 1px solid #e2e8f0;
          border-radius: 16px;
          padding: 13px 18px;
          font-weight: 800;
          box-shadow: 0 4px 6px rgba(0, 0, 0, 0.05);
          transition: transform 0.16s ease, box-shadow 0.16s ease, border-color 0.16s ease;
        }

        .homeBtn:hover {
          transform: translateY(-1px);
          box-shadow: 0 10px 22px rgba(15, 23, 42, 0.08);
          border-color: #cbd5e1;
        }

        .heroCard {
          background: rgba(255, 255, 255, 0.94);
          border: 1px solid rgba(226, 232, 240, 0.95);
          border-radius: 28px;
          padding: 24px;
          box-shadow: 0 10px 30px rgba(15, 23, 42, 0.05);
          margin-bottom: 20px;
        }

        .heroBadge {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          min-height: 30px;
          padding: 0 12px;
          border-radius: 999px;
          background: #eff6ff;
          color: #1d4ed8;
          border: 1px solid #bfdbfe;
          font-size: 11px;
          font-weight: 900;
          letter-spacing: 0.12em;
          text-transform: uppercase;
        }

        .heroHeading {
          margin-top: 14px;
          font-size: clamp(22px, 2.8vw, 34px);
          line-height: 1.02;
          letter-spacing: -0.04em;
          font-weight: 900;
          color: #0f172a;
        }

        .heroText {
          margin-top: 10px;
          color: #64748b;
          font-size: 15px;
          line-height: 1.6;
          max-width: 720px;
        }

        .hubGrid {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 18px;
        }

        .hubTile {
          display: grid;
          grid-template-columns: auto 1fr auto;
          gap: 16px;
          align-items: center;
          min-height: 160px;
          padding: 22px;
          border-radius: 28px;
          background: rgba(255, 255, 255, 0.96);
          border: 1px solid #e2e8f0;
          box-shadow: 0 10px 30px rgba(15, 23, 42, 0.05);
          transition: transform 0.18s ease, box-shadow 0.18s ease, border-color 0.18s ease;
        }

        .hubTile:hover {
          transform: translateY(-2px);
          box-shadow: 0 18px 34px rgba(15, 23, 42, 0.08);
          border-color: #cbd5e1;
        }

        .hubTileIconWrap {
          width: 74px;
          height: 74px;
          border-radius: 22px;
          display: flex;
          align-items: center;
          justify-content: center;
          flex: 0 0 auto;
        }

        .hubTileIcon {
          font-size: 34px;
          line-height: 1;
        }

        .hubTileBody {
          min-width: 0;
        }

        .hubTileTitle {
          font-size: 22px;
          line-height: 1.05;
          letter-spacing: -0.035em;
          font-weight: 900;
          color: #0f172a;
        }

        .hubTileDesc {
          margin-top: 10px;
          color: #64748b;
          font-size: 14px;
          line-height: 1.6;
        }

        .hubTileArrow {
          font-size: 34px;
          line-height: 1;
          color: #94a3b8;
          font-weight: 500;
        }

        @media (max-width: 980px) {
          .hubGrid {
            grid-template-columns: 1fr;
          }
        }

        @media (max-width: 640px) {
          .arkaHubPage {
            padding: 18px 12px 30px;
          }

          .heroCard,
          .hubTile {
            border-radius: 22px;
          }

          .hubTile {
            grid-template-columns: 1fr;
            align-items: flex-start;
          }

          .hubTileArrow {
            display: none;
          }

          .hubTileIconWrap {
            width: 64px;
            height: 64px;
            border-radius: 18px;
          }

          .homeBtn {
            width: 100%;
            text-align: center;
          }

          .arkaHubTop {
            gap: 14px;
          }
        }
      `}</style>
    </div>
  );
}
