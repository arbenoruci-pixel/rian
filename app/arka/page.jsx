'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { getActor } from '@/lib/actorSession';
import { handoffActorPendingCash, listPendingCashForActor } from '@/lib/arkaCashSync';

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
  const [actor, setActor] = useState(null);
  const [mine, setMine] = useState([]);
  const [busy, setBusy] = useState(false);

  async function refreshMine(a = null) {
    const act = a || getActor();
    setActor(act || null);
    const pin = String(act?.pin || '').trim();
    if (!pin) { setMine([]); return; }
    const res = await listPendingCashForActor(pin, 200);
    setMine(Array.isArray(res?.items) ? res.items.filter((x) => ['PENDING','COLLECTED'].includes(String(x?.status || '').toUpperCase())) : []);
  }

  useEffect(() => { void refreshMine(); }, []);

  const myTotal = useMemo(() => mine.reduce((sum, x) => sum + (Number(x?.amount || 0) || 0), 0), [mine]);

  async function onHandoff() {
    if (!actor?.pin) return alert('Mungon PIN-i i punëtorit.');
    if (myTotal <= 0) return alert('Arka jote është 0€.');
    const ok = window.confirm(`A don me i dorëzu ${myTotal.toFixed(2)}€ te bosi?`);
    if (!ok) return;
    setBusy(true);
    try {
      const res = await handoffActorPendingCash({ actor });
      if (!res?.ok) throw new Error(res?.error || 'Dështoi dorëzimi');
      await refreshMine(actor);
      alert(`U dorëzuan ${Number(res.total || 0).toFixed(2)}€.`);
    } catch (e) {
      alert(e?.message || 'Gabim gjatë dorëzimit.');
    } finally {
      setBusy(false);
    }
  }

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

        <div className="myArkaCard">
          <div className="myArkaHead">
            <div>
              <div className="myArkaEyebrow">ARKA IME</div>
              <div className="myArkaName">{actor?.name || 'PUNËTORI'}</div>
              <div className="myArkaMeta">PIN: {actor?.pin || '—'}</div>
            </div>
            <div className="myArkaAmount">€{Number(myTotal || 0).toFixed(2)}</div>
          </div>
          <button className="handoffBtn" disabled={busy || myTotal <= 0} onClick={onHandoff}>DORËZO PARET TE BOSI</button>
          <div className="myArkaList">
            {mine.length ? mine.slice(0, 6).map((x) => (
              <div key={x.external_id || x.id} className="myArkaRow">
                <div>
                  <div className="myArkaRowTitle">{x.client_name || x.order_code || 'PAGESË CASH'}</div>
                  <div className="myArkaRowSub">{x.order_code ? `KODI ${x.order_code}` : (x.note || 'Pa shënim')}</div>
                </div>
                <div className="myArkaRowAmt">€{Number(x.amount || 0).toFixed(2)}</div>
              </div>
            )) : <div className="myArkaEmpty">S’ke pagesa cash të padorëzuara.</div>}
          </div>
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

        .myArkaCard {
          background: #0f172a;
          color: #fff;
          border-radius: 28px;
          padding: 22px;
          border: 1px solid rgba(255,255,255,0.08);
          box-shadow: 0 10px 30px rgba(15, 23, 42, 0.08);
          margin-bottom: 20px;
        }
        .myArkaHead { display:flex; justify-content:space-between; gap:16px; align-items:flex-start; flex-wrap:wrap; }
        .myArkaEyebrow { font-size: 11px; font-weight: 900; letter-spacing: 0.14em; text-transform: uppercase; color: rgba(255,255,255,0.55); }
        .myArkaName { margin-top: 8px; font-size: 24px; font-weight: 900; line-height: 1; }
        .myArkaMeta { margin-top: 6px; font-size: 13px; color: rgba(255,255,255,0.62); }
        .myArkaAmount { font-size: clamp(28px, 4vw, 42px); font-weight: 900; letter-spacing: -0.04em; }
        .handoffBtn { margin-top: 16px; width: 100%; border: none; border-radius: 18px; padding: 16px 18px; background: linear-gradient(180deg, #22c55e, #16a34a); color: #fff; font-size: 16px; font-weight: 900; cursor: pointer; }
        .handoffBtn:disabled { opacity: 0.45; cursor: not-allowed; }
        .myArkaList { margin-top: 14px; display: grid; gap: 10px; }
        .myArkaRow { display:flex; justify-content:space-between; gap:12px; align-items:center; padding: 11px 12px; border-radius: 16px; background: rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.06); }
        .myArkaRowTitle { font-size: 14px; font-weight: 800; }
        .myArkaRowSub { margin-top: 3px; font-size: 12px; color: rgba(255,255,255,0.58); }
        .myArkaRowAmt { font-size: 16px; font-weight: 900; white-space: nowrap; }
        .myArkaEmpty { padding: 12px; border-radius: 14px; background: rgba(255,255,255,0.05); color: rgba(255,255,255,0.72); font-size: 13px; }

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
