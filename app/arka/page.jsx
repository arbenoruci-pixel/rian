'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { getActor } from '@/lib/actorSession';
import { confirmHandoffByDispatch, handoffActorPendingCash, listPendingCashForActor } from '@/lib/arkaCashSync';
import { budgetListMoves } from '@/lib/companyBudgetDb';
import { supabase } from '@/lib/supabaseClient';

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

function euro(n) {
  return `€${Number(n || 0).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function normalizeRole(role) {
  return String(role || '').trim().toLowerCase();
}

function readLS(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

export default function ArkaPage() {
  const [actor, setActor] = useState(null);
  const [mine, setMine] = useState([]);
  const [busy, setBusy] = useState(false);
  const [pendingGroups, setPendingGroups] = useState([]);
  const [workers, setWorkers] = useState([]);
  const [budgetRows, setBudgetRows] = useState([]);
  const [expenseRows, setExpenseRows] = useState([]);
  const [reloadTick, setReloadTick] = useState(0);

  const isAdmin = actor?.role === 'admin' || normalizeRole(actor?.role) === 'dispatch' || normalizeRole(actor?.role) === 'admin_master';

  async function refreshMine(a = null) {
    const act = a || getActor();
    setActor(act || null);
    const pin = String(act?.pin || '').trim();
    if (!pin) { setMine([]); return; }
    const res = await listPendingCashForActor(pin, 200);
    setMine(Array.isArray(res?.items) ? res.items.filter((x) => ['PENDING', 'COLLECTED', 'HANDED'].includes(String(x?.status || '').toUpperCase())) : []);
  }

  async function refreshAdminData() {
    const localWorkers = [];
    let dbWorkers = [];
    try {
      const { data } = await supabase.from('users').select('id,name,pin,role,salary,avans_manual,borxh_afatgjat,is_active').order('name', { ascending: true });
      dbWorkers = Array.isArray(data) ? data : [];
    } catch {}
    setWorkers(dbWorkers);

    const groupsMap = new Map();
    try {
      const { data } = await supabase
        .from('arka_pending_payments')
        .select('*')
        .eq('status', 'HANDED')
        .order('created_at', { ascending: true })
        .limit(500);
      (Array.isArray(data) ? data : []).forEach((r) => {
        const pin = String(r?.created_by_pin || '').trim() || 'PA_PIN';
        const g = groupsMap.get(pin) || { pin, name: r?.created_by_name || 'PUNËTOR', total: 0, count: 0, items: [] };
        g.total += Number(r?.amount || 0) || 0;
        g.count += 1;
        g.items.push(r);
        groupsMap.set(pin, g);
      });
    } catch {}

    if (!groupsMap.size) {
      const lsPending = readLS('arka_pending_payments_v1', []);
      (Array.isArray(lsPending) ? lsPending : []).forEach((r) => {
        if (String(r?.status || '').toUpperCase() !== 'HANDED') return;
        const pin = String(r?.created_by_pin || '').trim() || 'PA_PIN';
        const g = groupsMap.get(pin) || { pin, name: r?.created_by_name || 'PUNËTOR', total: 0, count: 0, items: [] };
        g.total += Number(r?.amount || 0) || 0;
        g.count += 1;
        g.items.push(r);
        groupsMap.set(pin, g);
      });
    }

    setPendingGroups(Array.from(groupsMap.values()).sort((a, b) => b.total - a.total));

    try {
      const rows = await budgetListMoves(500);
      setBudgetRows(Array.isArray(rows) ? rows : []);
    } catch {
      setBudgetRows([]);
    }

    try {
      const { data } = await supabase.from('company_budget').select('*').order('created_at', { ascending: false }).limit(500);
      if (Array.isArray(data) && data.length) {
        const mapped = data.map((r) => ({
          id: r.id,
          direction: r.direction || 'IN',
          amount: r.amount,
          note: r.note,
          created_at: r.created_at,
          reason: r.reason,
        }));
        setBudgetRows((prev) => {
          const seen = new Set(prev.map((x) => `${x.id}`));
          const merged = [...prev];
          mapped.forEach((x) => { if (!seen.has(`${x.id}`)) merged.push(x); });
          return merged;
        });
      }
    } catch {}

    try {
      const { data } = await supabase.from('company_budget_moves').select('*').eq('direction', 'OUT').order('created_at', { ascending: false }).limit(300);
      setExpenseRows(Array.isArray(data) ? data : []);
    } catch {
      setExpenseRows([]);
    }

    void localWorkers;
  }

  useEffect(() => {
    void refreshMine();
  }, [reloadTick]);

  useEffect(() => {
    if (isAdmin) void refreshAdminData();
  }, [isAdmin, reloadTick]);

  const myTotal = useMemo(() => mine.reduce((sum, x) => sum + (Number(x?.amount || 0) || 0), 0), [mine]);

  const workerRecord = useMemo(() => {
    const pin = String(actor?.pin || '').trim();
    return (workers || []).find((w) => String(w?.pin || '').trim() === pin) || null;
  }, [workers, actor?.pin]);

  const mySalary = Number(workerRecord?.salary || actor?.salary || 0);
  const myAdvances = useMemo(() => {
    const pin = String(actor?.pin || '').trim();
    return (expenseRows || []).filter((x) => {
      const reason = String(x?.reason || '').toUpperCase();
      return (reason.includes('ADVANCE') || reason.includes('AVANS')) && String(x?.created_by_pin || '').trim() === pin;
    });
  }, [expenseRows, actor?.pin]);
  const myDebts = useMemo(() => {
    const pin = String(actor?.pin || '').trim();
    return (expenseRows || []).filter((x) => {
      const reason = String(x?.reason || '').toUpperCase();
      return (reason.includes('DEBT') || reason.includes('BORXH')) && String(x?.created_by_pin || '').trim() === pin;
    });
  }, [expenseRows, actor?.pin]);

  const budgetIn = useMemo(() => (budgetRows || []).filter((x) => String(x?.direction || '').toUpperCase() === 'IN').reduce((s, x) => s + Number(x?.amount || 0), 0), [budgetRows]);
  const budgetOut = useMemo(() => (budgetRows || []).filter((x) => String(x?.direction || '').toUpperCase() === 'OUT').reduce((s, x) => s + Number(x?.amount || 0), 0), [budgetRows]);
  const totalBudget = budgetIn - budgetOut;

  async function onHandoff() {
    if (!actor?.pin) return alert('Mungon PIN-i i punëtorit.');
    if (myTotal <= 0) return alert('Arka jote është 0€.');
    const ok = window.confirm(`A don me i dorëzu ${myTotal.toFixed(2)}€ te dispatch?`);
    if (!ok) return;
    setBusy(true);
    try {
      const res = await handoffActorPendingCash({ actor });
      if (!res?.ok) throw new Error(res?.error || 'Dështoi dorëzimi');
      setReloadTick((x) => x + 1);
      alert(`U dorëzuan ${Number(res.total || 0).toFixed(2)}€.`);
    } catch (e) {
      alert(e?.message || 'Gabim gjatë dorëzimit.');
    } finally {
      setBusy(false);
    }
  }

  async function onAcceptGroup(pin, name) {
    const group = (pendingGroups || []).find((g) => String(g?.pin || '') === String(pin || ''));
    const total = Number(group?.total || 0);
    if (!pin || total <= 0) return;
    const ok = window.confirm(`A don me i pranu ${euro(total)} nga ${name || pin}?`);
    if (!ok) return;
    setBusy(true);
    try {
      const res = await confirmHandoffByDispatch(pin);
      if (!res?.ok) throw new Error(res?.error || 'Dështoi pranimi');
      setReloadTick((x) => x + 1);
      alert(`U pranuan ${euro(res.total || total)}.`);
    } catch (e) {
      alert(e?.message || 'Gabim gjatë pranimit.');
    } finally {
      setBusy(false);
    }
  }

  const personalDashboard = (
    <>
      <div className="myArkaCard">
        <div className="myArkaHead">
          <div>
            <div className="myArkaEyebrow">DASHBOARD PERSONAL</div>
            <div className="myArkaName">{actor?.name || 'PUNËTORI'}</div>
            <div className="myArkaMeta">PIN: {actor?.pin || '—'}</div>
          </div>
          <div className="myArkaAmount">{euro(myTotal)}</div>
        </div>
        <button className="handoffBtn" disabled={busy || myTotal <= 0} onClick={onHandoff}>DORËZO PARET TE DISPATCH</button>
        <div className="personalGrid">
          <div className="softCard">
            <div className="softEyebrow">ARKA IME</div>
            <div className="softBig">{euro(myTotal)}</div>
            <div className="myArkaList">
              {mine.length ? mine.slice(0, 6).map((x) => (
                <div key={x.external_id || x.id} className="myArkaRow">
                  <div>
                    <div className="myArkaRowTitle">{x.client_name || x.order_code || 'PAGESË CASH'}</div>
                    <div className="myArkaRowSub">{x.order_code ? `KODI ${x.order_code}` : (x.note || 'Pa shënim')}</div>
                  </div>
                  <div className="myArkaRowAmt">{euro(x.amount)}</div>
                </div>
              )) : <div className="myArkaEmpty">S’ke pagesa cash të padorëzuara.</div>}
            </div>
          </div>

          <div className="softCard">
            <div className="softEyebrow">RROGA IME</div>
            <div className="softBig">{euro(mySalary)}</div>
            <div className="softHint">Vlerë vetëm për lexim.</div>
          </div>

          <div className="softCard">
            <div className="softEyebrow">AVANSET E MIA</div>
            <div className="listMini">
              {myAdvances.length ? myAdvances.slice(0, 8).map((x) => (
                <div className="miniRow" key={x.id || x.external_id}>
                  <span>{String(x.note || x.reason || 'AVANS').toUpperCase()}</span>
                  <strong>{euro(x.amount)}</strong>
                </div>
              )) : <div className="emptyMini">S’ka avanse.</div>}
            </div>
          </div>

          <div className="softCard">
            <div className="softEyebrow">BORXHET E MIA</div>
            <div className="listMini">
              {myDebts.length ? myDebts.slice(0, 8).map((x) => (
                <div className="miniRow" key={x.id || x.external_id}>
                  <span>{String(x.note || x.reason || 'BORXH').toUpperCase()}</span>
                  <strong>{euro(x.amount)}</strong>
                </div>
              )) : <div className="emptyMini">S’ka borxhe.</div>}
            </div>
          </div>
        </div>
      </div>
    </>
  );

  return (
    <div className="arkaHubPage">
      <div className="arkaHubShell">
        <div className="arkaHubTop">
          <div>
            <div className="arkaEyebrow">ARKA / HUB</div>
            <h1 className="arkaTitle">Menu Kryesore e Arkës</h1>
            <p className="arkaSubtitle">
              {isAdmin ? 'Kontrollo pranimet nga terreni, buxhetin dhe modulet kryesore.' : 'Pamje personale vetëm me të dhënat e tua.'}
            </p>
          </div>

          <Link href="/" className="homeBtn">
            ← HOME
          </Link>
        </div>

        {!isAdmin ? personalDashboard : (
          <>
            <div className="budgetHero">
              <div className="budgetHeroCard dark">
                <div className="softEyebrow">BUXHETI TOTAL I KOMPANISË</div>
                <div className="budgetValue">{euro(totalBudget)}</div>
                <div className="budgetMeta">HYRJE {euro(budgetIn)} • DALJE {euro(budgetOut)}</div>
              </div>
              <div className="budgetHeroCard light">
                <div className="softEyebrow">PRANIMET NGA TERRENI</div>
                <div className="budgetValue small">{pendingGroups.length}</div>
                <div className="budgetMeta">Punëtorë në pritje për pranim nga dispatch.</div>
              </div>
            </div>

            <div className="softCard bigSection">
              <div className="sectionTop">
                <div>
                  <div className="softEyebrow">PRANIMET NGA TERRENI</div>
                  <div className="sectionTitle">Dispatch → Prano dorëzimet</div>
                </div>
              </div>
              <div className="adminList">
                {pendingGroups.length ? pendingGroups.map((g) => (
                  <div className="adminRow" key={g.pin}>
                    <div>
                      <div className="adminName">{g.name || 'PUNËTOR'}</div>
                      <div className="adminSub">PIN {g.pin} • {g.count} pagesa</div>
                    </div>
                    <div className="adminRight">
                      <div className="adminAmt">{euro(g.total)}</div>
                      <button className="acceptBtn" disabled={busy} onClick={() => onAcceptGroup(g.pin, g.name)}>✅ PRANO</button>
                    </div>
                  </div>
                )) : <div className="emptyMini">Nuk ka asnjë dorëzim në pritje.</div>}
              </div>
            </div>

            <div className="heroCard">
              <div className="heroBadge">LIGHT UI</div>
              <div className="heroHeading">Hub i ri për Stafin, Payroll-in, Shpenzimet dhe Buxhetin</div>
              <div className="heroText">
                Kjo faqe shërben si menu kryesore. Dispatch/Admin sheh vetëm kartat strategjike dhe pranimet në pritje.
              </div>
            </div>

            <div className="hubGrid">
              <HubTile href="/arka/stafi" icon="👥" title="MENAXHIMI I STAFIT" desc="Pajisjet në pritje, krijimi/editimi i stafit, rolet, PIN-et dhe statusi aktiv/joaktiv." accent="#0f766e" />
              <HubTile href="/arka/payroll" icon="💸" title="PAYROLL & RROGAT" desc="Rroga bazë, dita e rrogës, avanset, borxhet afatgjata dhe Smart Payroll." accent="#2563eb" />
              <HubTile href="/arka/shpenzime" icon="🧾" title="SHPENZIMET" desc="Daljet cash, regjistrimi i shpenzimeve dhe historiku i lëvizjeve të shpenzimeve." accent="#c2410c" />
              <HubTile href="/arka/buxheti" icon="📊" title="BUXHETI & INVESTIMET" desc="Buxheti live, investimet, ndarja e fitimit dhe historiku i lëvizjeve të buxhetit." accent="#7c3aed" />
            </div>
          </>
        )}
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
        .arkaHubShell { max-width: 1120px; margin: 0 auto; }
        .arkaHubTop { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; flex-wrap: wrap; margin-bottom: 18px; }
        .arkaEyebrow { font-size: 12px; line-height: 1; font-weight: 900; letter-spacing: 0.16em; text-transform: uppercase; color: #64748b; margin-bottom: 10px; }
        .arkaTitle { margin: 0; font-size: clamp(30px, 4vw, 46px); line-height: 0.98; letter-spacing: -0.05em; font-weight: 900; color: #0f172a; }
        .arkaSubtitle { margin: 12px 0 0; max-width: 760px; color: #475569; font-size: 15px; line-height: 1.55; }
        .homeBtn { text-decoration: none; background: rgba(255, 255, 255, 0.95); color: #0f172a; border: 1px solid #e2e8f0; border-radius: 16px; padding: 13px 18px; font-weight: 800; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.05); }
        .myArkaCard,.softCard,.heroCard,.budgetHeroCard { background: rgba(255,255,255,.96); border: 1px solid #e2e8f0; border-radius: 28px; padding: 22px; box-shadow: 0 10px 30px rgba(15, 23, 42, 0.05); margin-bottom: 20px; }
        .myArkaCard { background:#0f172a; color:#fff; border-color: rgba(255,255,255,.08); }
        .myArkaHead,.adminRow,.miniRow,.myArkaRow,.sectionTop,.moneyTop { display:flex; justify-content:space-between; gap:16px; align-items:center; }
        .myArkaHead { align-items:flex-start; flex-wrap:wrap; }
        .myArkaEyebrow,.softEyebrow { font-size: 11px; font-weight: 900; letter-spacing: 0.14em; text-transform: uppercase; color: rgba(255,255,255,0.55); }
        .softEyebrow { color:#64748b; }
        .myArkaName { margin-top: 8px; font-size: 24px; font-weight: 900; line-height: 1; }
        .myArkaMeta,.budgetMeta { margin-top: 6px; font-size: 13px; color: rgba(255,255,255,0.62); }
        .myArkaAmount,.budgetValue { font-size: clamp(28px, 4vw, 42px); font-weight: 900; letter-spacing: -0.04em; }
        .budgetValue.small { font-size: clamp(24px, 3.6vw, 34px); }
        .handoffBtn,.acceptBtn { margin-top: 16px; border: none; border-radius: 18px; padding: 16px 18px; background: linear-gradient(180deg, #22c55e, #16a34a); color: #fff; font-size: 16px; font-weight: 900; cursor: pointer; }
        .handoffBtn { width:100%; }
        .handoffBtn:disabled,.acceptBtn:disabled { opacity: 0.45; cursor: not-allowed; }
        .myArkaList,.adminList,.listMini { margin-top: 14px; display: grid; gap: 10px; }
        .myArkaRow { justify-content:space-between; padding: 11px 12px; border-radius: 16px; background: rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.06); }
        .myArkaRowTitle,.adminName { font-size: 14px; font-weight: 800; }
        .myArkaRowSub,.adminSub,.softHint,.emptyMini { margin-top: 3px; font-size: 12px; color: rgba(255,255,255,0.58); }
        .softHint,.emptyMini,.adminSub { color:#64748b; }
        .myArkaRowAmt,.adminAmt,strong { font-size: 16px; font-weight: 900; white-space: nowrap; }
        .myArkaEmpty { padding: 12px; border-radius: 14px; background: rgba(255,255,255,0.05); color: rgba(255,255,255,0.72); font-size: 13px; }
        .personalGrid,.budgetHero { display:grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap:18px; margin-top:18px; }
        .budgetHeroCard.dark { background:#0f172a; color:#fff; }
        .budgetHeroCard.light { background:rgba(255,255,255,.96); }
        .sectionTitle,.heroHeading { margin-top: 8px; font-size: clamp(22px, 2.8vw, 34px); line-height: 1.02; letter-spacing: -0.04em; font-weight: 900; color: #0f172a; }
        .adminRow { padding: 14px 16px; border-radius: 18px; border:1px solid #e2e8f0; background:#fff; }
        .adminRight { display:flex; align-items:center; gap:12px; }
        .heroBadge { display:inline-flex; min-height:30px; padding:0 12px; border-radius:999px; background:#eff6ff; color:#1d4ed8; border:1px solid #bfdbfe; font-size:11px; font-weight:900; letter-spacing:.12em; text-transform:uppercase; }
        .heroText { margin-top:10px; color:#64748b; font-size:15px; line-height:1.6; max-width:720px; }
        .hubGrid { display:grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap:18px; }
        .hubTile { display:grid; grid-template-columns:auto 1fr auto; gap:16px; align-items:center; min-height:160px; padding:22px; border-radius:28px; background: rgba(255,255,255,.96); border:1px solid #e2e8f0; box-shadow:0 10px 30px rgba(15,23,42,.05); }
        .hubTileIconWrap { width:74px; height:74px; border-radius:22px; display:flex; align-items:center; justify-content:center; }
        .hubTileIcon { font-size:34px; line-height:1; }
        .hubTileTitle { font-size:22px; line-height:1.05; letter-spacing:-.035em; font-weight:900; color:#0f172a; }
        .hubTileDesc { margin-top:10px; color:#64748b; font-size:14px; line-height:1.6; }
        .hubTileArrow { font-size:34px; line-height:1; color:#94a3b8; font-weight:500; }
        .bigSection { margin-bottom:20px; }
        @media (max-width: 980px) { .hubGrid,.personalGrid,.budgetHero { grid-template-columns: 1fr; } }
        @media (max-width: 640px) {
          .arkaHubPage { padding:18px 12px 30px; }
          .heroCard,.hubTile,.myArkaCard,.softCard,.budgetHeroCard { border-radius:22px; }
          .hubTile { grid-template-columns:1fr; align-items:flex-start; }
          .hubTileArrow { display:none; }
          .hubTileIconWrap { width:64px; height:64px; border-radius:18px; }
          .homeBtn { width:100%; text-align:center; }
          .arkaHubTop { gap:14px; }
          .adminRow,.miniRow,.myArkaRow { align-items:flex-start; flex-direction:column; }
          .adminRight { width:100%; justify-content:space-between; }
        }
      `}</style>
    </div>
  );
}
