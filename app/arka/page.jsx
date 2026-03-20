'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { getActor } from '@/lib/actorSession';
import { handoffActorPendingCash, listPendingCashForActor } from '@/lib/arkaCashSync';
import { supabase } from '@/lib/supabaseClient';
import { isAdmin } from '@/lib/roles';

const euro = (n) => `€${Number(n || 0).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const MONTH_KEY = () => new Date().toISOString().slice(0, 7);

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
  const [budgetLive, setBudgetLive] = useState(0);
  const [monthProfit, setMonthProfit] = useState(0);
  const [investments, setInvestments] = useState([]);
  const [splitDone, setSplitDone] = useState(false);

  const admin = isAdmin(actor?.role);

  async function refreshMine(a = null) {
    const act = a || getActor();
    setActor(act || null);
    const pin = String(act?.pin || '').trim();
    if (!pin) {
      setMine([]);
      return;
    }
    try {
      const res = await listPendingCashForActor(pin, 200);
      const items = Array.isArray(res?.items) ? res.items : [];
      setMine(items.filter((x) => ['PENDING', 'COLLECTED'].includes(String(x?.status || '').toUpperCase())));
    } catch {
      setMine([]);
    }
  }

  async function refreshFinance() {
    const monthKey = MONTH_KEY();

    let live = 0;
    try {
      const { data, error } = await supabase.rpc('get_company_budget_live');
      if (error) throw error;
      live = Number(data || 0) || 0;
    } catch {
      live = 0;
    }
    setBudgetLive(live);

    try {
      const { data, error } = await supabase
        .from('company_budget_moves')
        .select('direction,amount,category,month_key,created_at,status')
        .order('created_at', { ascending: false })
        .limit(500);
      if (error) throw error;
      const rows = Array.isArray(data) ? data : [];
      const activeRows = rows.filter((r) => String(r?.status || 'ACTIVE').toUpperCase() === 'ACTIVE');
      const monthRows = activeRows.filter((r) => String(r?.month_key || (r?.created_at || '').slice(0, 7)) === monthKey);
      const ins = monthRows
        .filter((r) => String(r?.direction || '').toUpperCase() === 'IN')
        .reduce((sum, r) => sum + (Number(r?.amount || 0) || 0), 0);
      const outs = monthRows
        .filter((r) => String(r?.direction || '').toUpperCase() === 'OUT')
        .filter((r) => !['PARTNER', 'PARTNER_WITHDRAW'].includes(String(r?.category || '').toUpperCase()))
        .reduce((sum, r) => sum + (Number(r?.amount || 0) || 0), 0);
      setMonthProfit(ins - outs);
      setSplitDone(monthRows.some((r) => String(r?.category || '').toUpperCase() === 'PARTNER'));
    } catch {
      setMonthProfit(0);
      setSplitDone(false);
    }

    try {
      const { data, error } = await supabase
        .from('investments')
        .select('*')
        .eq('is_active', true)
        .order('created_at', { ascending: false });
      if (error) throw error;
      setInvestments(Array.isArray(data) ? data : []);
    } catch {
      setInvestments([]);
    }
  }

  useEffect(() => {
    void refreshMine();
    void refreshFinance();
  }, []);

  const myTotal = useMemo(() => mine.reduce((sum, x) => sum + (Number(x?.amount || 0) || 0), 0), [mine]);

  async function onHandoff() {
    if (!actor?.pin) return alert('MUNGON PIN-I I PËRDORUESIT.');
    if (myTotal <= 0) return alert('ARKA JOTE ËSHTË 0€');
    const ok = window.confirm(`A DON ME I DORËZU ${myTotal.toFixed(2)}€ TE DISPATCH?`);
    if (!ok) return;
    setBusy(true);
    try {
      const res = await handoffActorPendingCash({ actor });
      if (!res?.ok) throw new Error(res?.error || 'DËSHTOI DORËZIMI');
      await refreshMine(actor);
      alert(`U DORËZUAN ${Number(res.total || 0).toFixed(2)}€.`);
    } catch (e) {
      alert(e?.message || 'GABIM GJATË DORËZIMIT.');
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
            <h1 className="arkaTitle">MENU KRYESORE E ARKËS</h1>
            <p className="arkaSubtitle">MENAXHIM I STAFIT, PAYROLL-IT, SHPENZIMEVE DHE BUXHETIT TË KOMPANISË.</p>
          </div>
          <Link href="/" className="homeBtn">← HOME</Link>
        </div>

        <div className="myArkaCard">
          <div className="myArkaHead">
            <div>
              <div className="myArkaEyebrow">ARKA IME</div>
              <div className="myArkaName">{actor?.name || 'PËRDORUESI'}</div>
              <div className="myArkaMeta">PIN: {actor?.pin || '—'} • ROLI: {String(actor?.role || '—').toUpperCase()}</div>
            </div>
            <div className="myArkaAmount">{euro(myTotal)}</div>
          </div>
          {!admin ? <button className="handoffBtn" disabled={busy || myTotal <= 0} onClick={onHandoff}>DORËZO PARET TE DISPATCH</button> : null}
          <div className="myArkaList">
            {mine.length ? mine.slice(0, 6).map((x) => (
              <div key={x.external_id || x.id} className="myArkaRow">
                <div>
                  <div className="myArkaRowTitle">{x.client_name || x.order_code || 'PAGESË CASH'}</div>
                  <div className="myArkaRowSub">{x.order_code ? `KODI ${x.order_code}` : (x.note || 'PA SHËNIM')}</div>
                </div>
                <div className="myArkaRowAmt">{euro(x.amount)}</div>
              </div>
            )) : <div className="myArkaEmpty">S’KE PAGESA CASH TË PADORËZUARA.</div>}
          </div>
        </div>

        {admin ? (
          <>
            <div className="financePreview">
              <div className="previewCard">
                <div className="previewLabel">💼 BUXHETI LIVE</div>
                <div className="previewValue">{euro(budgetLive)}</div>
                <div className="previewHint">GET_COMPANY_BUDGET_LIVE() ME FALLBACK 0</div>
              </div>
              <div className="previewCard">
                <div className="previewLabel">📈 FITIMI I MUAJIT</div>
                <div className="previewValue">{euro(monthProfit)}</div>
                <div className="previewHint">IN − OUT PËR {MONTH_KEY()}</div>
              </div>
              <div className="previewCard">
                <div className="previewLabel">🧮 PARTNER SPLIT</div>
                <div className={`previewValue ${splitDone ? 'small' : 'small'}`}>{splitDone ? 'I KRYER' : 'NË PRITJE'}</div>
                <div className="previewHint">KONTROLL MUJOR I NDARJES</div>
              </div>
            </div>

            <div className="investCard">
              <div className="investHead">
                <div>
                  <div className="cardEyebrow">📊 BUXHETI & INVESTIMET</div>
                  <div className="investTitle">PAMJE E SHPEJTË E DASHBOARD-IT TË PRONARËVE</div>
                  <div className="investSub">INVESTIME AKTIVE, BUXHET LIVE DHE NDARJA E FITIMIT.</div>
                </div>
                <Link href="/arka/buxheti" className="goBudgetBtn">HAP DASHBOARD-IN</Link>
              </div>
              <div className="investMiniGrid">
                {investments.length ? investments.slice(0, 3).map((inv) => {
                  const total = Number(inv?.total_amount || 0) || 0;
                  const remaining = Number(inv?.remaining_amount || 0) || 0;
                  const paid = Math.max(0, total - remaining);
                  const progress = total > 0 ? Math.max(0, Math.min(100, Math.round((paid / total) * 100))) : 0;
                  return (
                    <div key={inv.id} className="miniInv">
                      <div className="miniInvTitle">{String(inv?.name || inv?.title || 'INVESTIM').toUpperCase()}</div>
                      <div className="miniInvMeta">{euro(paid)} / {euro(total)}</div>
                      <div className="miniTrack"><div className="miniFill" style={{ width: `${progress}%` }} /></div>
                      <div className="miniInvMeta">MBETUR {euro(remaining)}</div>
                    </div>
                  );
                }) : <div className="miniEmpty">S’KA INVESTIME AKTIVE. DASHBOARD-I I RI ËSHTË TE /ARKA/BUXHETI.</div>}
              </div>
            </div>
          </>
        ) : null}

        <div className="hubGrid">
          <HubTile href="/arka/stafi" icon="👥" title="MENAXHIMI I STAFIT" desc="ROLET, PIN-ET DHE STATUSI AKTIV/JOAKTIV." accent="#0f766e" />
          <HubTile href="/arka/payroll" icon="💸" title="PAYROLL & RROGAT" desc="RROGA BAZË, AVANSET, BORXHET DHE SMART PAYROLL." accent="#2563eb" />
          <HubTile href="/arka/shpenzime" icon="🧾" title="SHPENZIMET" desc="DALJET CASH DHE HISTORIKU I SHPENZIMEVE." accent="#c2410c" />
          <HubTile href="/arka/corporate" icon="🏛️" title="KORPORATË / 4 NIVELE" desc="PUNËTORI → DISPATCH → KOMPANIA → OWNERS. CASH FLOW I KONTROLLUAR DHE CLEAN." accent="#9333ea" />
          {admin ? <HubTile href="/arka/buxheti" icon="📊" title="BUXHETI & INVESTIMET" desc="PROFIT DASHBOARD, INVESTIME, OWNER BALANCES DHE PARTNER SPLIT." accent="#7c3aed" /> : null}
        </div>
      </div>

      <style jsx>{`
        .arkaHubPage{min-height:100vh;background:radial-gradient(circle at top left,rgba(59,130,246,.18),transparent 28%),radial-gradient(circle at top right,rgba(16,185,129,.14),transparent 24%),#0b1120;color:#f8fafc;padding:28px 16px 40px;font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;}
        .arkaHubShell{max-width:1120px;margin:0 auto;}
        .arkaHubTop{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;flex-wrap:wrap;margin-bottom:18px;}
        .arkaEyebrow{font-size:12px;line-height:1;font-weight:900;letter-spacing:.16em;text-transform:uppercase;color:#94a3b8;margin-bottom:10px;}
        .arkaTitle{margin:0;font-size:clamp(30px,4vw,46px);line-height:.98;letter-spacing:-.05em;font-weight:900;color:#f8fafc;}
        .arkaSubtitle{margin:12px 0 0;max-width:760px;color:#94a3b8;font-size:15px;line-height:1.55;}
        .homeBtn{text-decoration:none;background:rgba(255,255,255,.08);color:#fff;border:1px solid rgba(255,255,255,.12);border-radius:16px;padding:13px 18px;font-weight:800;box-shadow:0 4px 12px rgba(0,0,0,.22);transition:transform .16s ease,box-shadow .16s ease,border-color .16s ease;}
        .homeBtn:hover{transform:translateY(-1px);box-shadow:0 10px 22px rgba(0,0,0,.3);border-color:rgba(255,255,255,.2);}
        .myArkaCard{background:linear-gradient(180deg,#0f172a,#111827);color:#fff;border-radius:28px;padding:22px;border:1px solid rgba(255,255,255,.08);box-shadow:0 10px 30px rgba(0,0,0,.24);margin-bottom:20px;}
        .myArkaHead{display:flex;justify-content:space-between;gap:16px;align-items:flex-start;flex-wrap:wrap;}
        .myArkaEyebrow{font-size:11px;font-weight:900;letter-spacing:.14em;text-transform:uppercase;color:rgba(255,255,255,.55);}
        .myArkaName{margin-top:8px;font-size:24px;font-weight:900;line-height:1;}
        .myArkaMeta{margin-top:6px;font-size:13px;color:rgba(255,255,255,.62);}
        .myArkaAmount{font-size:clamp(28px,4vw,42px);font-weight:900;letter-spacing:-.04em;}
        .handoffBtn{margin-top:16px;width:100%;border:none;border-radius:18px;padding:16px 18px;background:linear-gradient(180deg,#22c55e,#16a34a);color:#fff;font-size:16px;font-weight:900;cursor:pointer;}
        .handoffBtn:disabled{opacity:.45;cursor:not-allowed;}
        .myArkaList{margin-top:14px;display:grid;gap:10px;}
        .myArkaRow{display:flex;justify-content:space-between;gap:12px;align-items:center;padding:11px 12px;border-radius:16px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.06);}
        .myArkaRowTitle{font-size:14px;font-weight:800;}
        .myArkaRowSub{margin-top:3px;font-size:12px;color:rgba(255,255,255,.58);}
        .myArkaRowAmt{font-size:16px;font-weight:900;white-space:nowrap;}
        .myArkaEmpty{padding:12px;border-radius:14px;background:rgba(255,255,255,.05);color:rgba(255,255,255,.72);font-size:13px;}
        .financePreview{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-bottom:18px;}
        .previewCard{position:relative;overflow:hidden;border-radius:24px;padding:18px;background:linear-gradient(180deg,rgba(255,255,255,.08),rgba(255,255,255,.03));border:1px solid rgba(255,255,255,.12);box-shadow:0 16px 36px rgba(0,0,0,.22);}
        .previewLabel{font-size:11px;letter-spacing:.16em;font-weight:950;color:#cbd5e1;}
        .previewValue{margin-top:14px;font-size:38px;font-weight:1000;letter-spacing:-.04em;line-height:1;}
        .previewValue.small{font-size:28px;}
        .previewHint{margin-top:10px;font-size:10px;letter-spacing:.14em;color:#94a3b8;font-weight:800;}
        .investCard{background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.12);border-radius:24px;padding:18px;margin-bottom:20px;box-shadow:0 16px 36px rgba(0,0,0,.18);}
        .investHead{display:flex;justify-content:space-between;gap:16px;align-items:flex-start;flex-wrap:wrap;}
        .cardEyebrow{font-size:11px;font-weight:950;letter-spacing:.16em;color:#a78bfa;}
        .investTitle{margin-top:8px;font-size:24px;line-height:1.02;font-weight:950;letter-spacing:-.03em;}
        .investSub{margin-top:8px;font-size:12px;letter-spacing:.12em;color:#94a3b8;font-weight:800;}
        .goBudgetBtn{text-decoration:none;padding:14px 18px;border-radius:16px;background:linear-gradient(180deg,#8b5cf6,#7c3aed);color:#fff;font-weight:900;letter-spacing:.12em;border:1px solid rgba(255,255,255,.12);}
        .investMiniGrid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-top:16px;}
        .miniInv,.miniEmpty{border-radius:18px;padding:14px;background:rgba(0,0,0,.26);border:1px solid rgba(255,255,255,.08);}
        .miniInvTitle{font-size:11px;letter-spacing:.14em;font-weight:950;}
        .miniInvMeta{margin-top:8px;font-size:11px;letter-spacing:.1em;color:#cbd5e1;}
        .miniTrack{height:10px;border-radius:999px;background:rgba(255,255,255,.08);overflow:hidden;border:1px solid rgba(255,255,255,.06);margin:10px 0;}
        .miniFill{height:100%;border-radius:999px;background:linear-gradient(90deg,#38bdf8,#22d3ee);}
        .miniEmpty{grid-column:1/-1;color:#94a3b8;font-size:12px;letter-spacing:.12em;}
        .hubGrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;}
        .hubTile{display:flex;align-items:center;gap:16px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);border-radius:22px;padding:18px;box-shadow:0 14px 28px rgba(0,0,0,.16);transition:transform .16s ease,border-color .16s ease,box-shadow .16s ease;}
        .hubTile:hover{transform:translateY(-2px);border-color:rgba(255,255,255,.24);box-shadow:0 18px 34px rgba(0,0,0,.22);}
        .hubTileIconWrap{width:56px;height:56px;border-radius:18px;display:flex;align-items:center;justify-content:center;border:1px solid rgba(255,255,255,.08);}
        .hubTileIcon{font-size:24px;}
        .hubTileBody{min-width:0;flex:1;}
        .hubTileTitle{font-size:15px;font-weight:950;letter-spacing:.12em;color:#fff;}
        .hubTileDesc{margin-top:6px;font-size:12px;line-height:1.45;color:#94a3b8;letter-spacing:.04em;}
        .hubTileArrow{font-size:26px;color:#cbd5e1;line-height:1;}
        @media (max-width: 920px){.financePreview,.investMiniGrid,.hubGrid{grid-template-columns:1fr;}.previewValue{font-size:32px;}}
      `}</style>
    </div>
  );
}
