'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { getActor } from '@/lib/actorSession';
import { budgetListMoves } from '@/lib/companyBudgetDb';
import {
  handoffActorPendingCash,
  listPendingCashForActor,
  listDispatchHandoffs,
  confirmHandoffByDispatch,
  listAcceptedCashPayments,
} from '@/lib/arkaCashSync';

const LS_BUDGET_CACHE = 'company_budget_moves_cache_v1';
const LS_PENDING_KEY = 'arka_pending_payments_v1';

const euro = (n) => `€${Number(n || 0).toLocaleString('de-DE', { minimumFractionDigits: 2 })}`;

function roleNorm(role) {
  return String(role || '').trim().toLowerCase();
}

function isAdminRole(role) {
  return ['admin', 'dispatch', 'owner', 'admin_master'].includes(roleNorm(role));
}

function readLs(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    const parsed = raw ? JSON.parse(raw) : fallback;
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function writeLs(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

function uniqueByExternal(items = []) {
  const out = [];
  const seen = new Set();
  for (const row of items || []) {
    const id = String(row?.external_id || row?.externalId || row?.id || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(row);
  }
  return out;
}

function groupByActor(items = []) {
  const map = new Map();
  for (const row of items || []) {
    const pin = String(row?.created_by_pin || row?.pin || '').trim() || 'PA_PIN';
    const name = String(row?.created_by_name || row?.name || '').trim() || 'PUNËTOR';
    const key = `${pin}__${name}`;
    if (!map.has(key)) map.set(key, { pin, name, total: 0, count: 0, items: [] });
    const g = map.get(key);
    g.total += Number(row?.amount || 0) || 0;
    g.count += 1;
    g.items.push(row);
  }
  return Array.from(map.values()).sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
}

function collectLocalPersonalDebtRows(actor) {
  const pin = String(actor?.pin || '').trim();
  const name = String(actor?.name || '').trim().toUpperCase();
  const allowed = new Set(['ADVANCE', 'REJECTED', 'OWED', 'WORKER_DEBT']);
  const rows = [];

  const lsRows = readLs(LS_PENDING_KEY, []);
  for (const row of lsRows) {
    const st = String(row?.status || '').toUpperCase();
    const rowPin = String(row?.created_by_pin || row?.pin || '').trim();
    const rowName = String(row?.created_by_name || row?.name || '').trim().toUpperCase();
    if (allowed.has(st) && (rowPin === pin || (!!name && rowName === name))) rows.push(row);
  }

  const orderCache = readLs('tepiha_local_orders_v1', []);
  for (const order of Array.isArray(orderCache) ? orderCache : []) {
    const pends = order?.data?.pay?.pendingCash || order?.pay?.pendingCash || [];
    for (const row of pends) {
      const st = String(row?.status || '').toUpperCase();
      const rowPin = String(row?.created_by_pin || row?.pin || '').trim();
      const rowName = String(row?.created_by_name || row?.name || '').trim().toUpperCase();
      if (allowed.has(st) && (rowPin === pin || (!!name && rowName === name))) rows.push(row);
    }
  }

  return uniqueByExternal(rows);
}

function deriveBudgetTotals(acceptedRows = [], budgetMoves = []) {
  const acceptedIn = (acceptedRows || []).reduce((sum, row) => sum + (Number(row?.amount || 0) || 0), 0);
  const budgetOut = (budgetMoves || [])
    .filter((row) => String(row?.direction || '').toUpperCase() === 'OUT')
    .reduce((sum, row) => sum + (Number(row?.amount || 0) || 0), 0);
  const budgetIn = (budgetMoves || [])
    .filter((row) => String(row?.direction || '').toUpperCase() === 'IN')
    .reduce((sum, row) => sum + (Number(row?.amount || 0) || 0), 0);

  return {
    acceptedIn,
    budgetOut,
    budgetIn,
    companyTotal: acceptedIn - budgetOut,
  };
}

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
  const [salaryValue, setSalaryValue] = useState(0);
  const [myAdvances, setMyAdvances] = useState([]);
  const [myDebts, setMyDebts] = useState([]);
  const [handoffs, setHandoffs] = useState([]);
  const [acceptedRows, setAcceptedRows] = useState([]);
  const [budgetMoves, setBudgetMoves] = useState([]);
  const [adminBusyPin, setAdminBusyPin] = useState('');

  const isAdmin = isAdminRole(actor?.role);

  async function refreshMine(a = null) {
    const act = a || getActor();
    setActor(act || null);
    const pin = String(act?.pin || '').trim();
    if (!pin) {
      setMine([]);
      setSalaryValue(0);
      setMyAdvances([]);
      setMyDebts([]);
      return;
    }

    const res = await listPendingCashForActor(pin, 200);
    const items = Array.isArray(res?.items)
      ? res.items.filter((x) => ['PENDING', 'COLLECTED'].includes(String(x?.status || '').toUpperCase()))
      : [];
    setMine(items);

    try {
      const { data, error } = await supabase
        .from('users')
        .select('salary,name,pin')
        .eq('pin', pin)
        .maybeSingle();
      if (!error && data) {
        setSalaryValue(Number(data?.salary || 0) || 0);
        writeLs(`arka_user_salary_${pin}`, data);
      } else {
        const cached = readLs(`arka_user_salary_${pin}`, null);
        setSalaryValue(Number(cached?.salary || act?.salary || 0) || 0);
      }
    } catch {
      const cached = readLs(`arka_user_salary_${pin}`, null);
      setSalaryValue(Number(cached?.salary || act?.salary || 0) || 0);
    }

    try {
      const { data, error } = await supabase
        .from('arka_pending_payments')
        .select('*')
        .in('status', ['ADVANCE', 'REJECTED', 'OWED', 'WORKER_DEBT'])
        .or(`created_by_pin.eq.${pin},created_by_name.eq.${String(act?.name || '').trim()}`)
        .order('created_at', { ascending: false })
        .limit(200);

      if (!error && Array.isArray(data)) {
        const rows = uniqueByExternal(data);
        setMyAdvances(rows.filter((x) => String(x?.status || '').toUpperCase() === 'ADVANCE'));
        setMyDebts(rows.filter((x) => ['REJECTED', 'OWED', 'WORKER_DEBT'].includes(String(x?.status || '').toUpperCase())));
      } else {
        const rows = collectLocalPersonalDebtRows(act);
        setMyAdvances(rows.filter((x) => String(x?.status || '').toUpperCase() === 'ADVANCE'));
        setMyDebts(rows.filter((x) => ['REJECTED', 'OWED', 'WORKER_DEBT'].includes(String(x?.status || '').toUpperCase())));
      }
    } catch {
      const rows = collectLocalPersonalDebtRows(act);
      setMyAdvances(rows.filter((x) => String(x?.status || '').toUpperCase() === 'ADVANCE'));
      setMyDebts(rows.filter((x) => ['REJECTED', 'OWED', 'WORKER_DEBT'].includes(String(x?.status || '').toUpperCase())));
    }
  }

  async function refreshAdmin() {
    const handoffRes = await listDispatchHandoffs(500);
    setHandoffs(Array.isArray(handoffRes?.items) ? handoffRes.items : []);

    const acceptedRes = await listAcceptedCashPayments(500);
    setAcceptedRows(Array.isArray(acceptedRes?.items) ? acceptedRes.items : []);

    try {
      const rows = await budgetListMoves(400);
      setBudgetMoves(Array.isArray(rows) ? rows : []);
      writeLs(LS_BUDGET_CACHE, rows || []);
    } catch {
      setBudgetMoves(readLs(LS_BUDGET_CACHE, []));
    }
  }

  useEffect(() => {
    const act = getActor();
    setActor(act || null);
    void refreshMine(act);
    if (isAdminRole(act?.role)) void refreshAdmin();
  }, []);

  const myTotal = useMemo(() => mine.reduce((sum, x) => sum + (Number(x?.amount || 0) || 0), 0), [mine]);
  const myAdvanceTotal = useMemo(() => myAdvances.reduce((sum, x) => sum + (Number(x?.amount || x?.sum || 0) || 0), 0), [myAdvances]);
  const myDebtTotal = useMemo(() => myDebts.reduce((sum, x) => sum + (Number(x?.amount || x?.sum || 0) || 0), 0), [myDebts]);
  const budgetTotals = useMemo(() => deriveBudgetTotals(acceptedRows, budgetMoves), [acceptedRows, budgetMoves]);
  const pendingDispatchTotal = useMemo(() => handoffs.reduce((sum, x) => sum + (Number(x?.total || 0) || 0), 0), [handoffs]);

  async function onHandoff() {
    if (!actor?.pin) return alert('Mungon PIN-i i punëtorit.');
    if (myTotal <= 0) return alert('Arka jote është 0€.');
    const ok = window.confirm(`A don me i dorëzu ${myTotal.toFixed(2)}€ te dispatch?`);
    if (!ok) return;
    setBusy(true);
    try {
      const res = await handoffActorPendingCash({ actor });
      if (!res?.ok) throw new Error(res?.error || 'Dështoi dorëzimi');
      await refreshMine(actor);
      if (isAdmin) await refreshAdmin();
      alert(`U dorëzuan ${Number(res.total || 0).toFixed(2)}€ te dispatch.`);
    } catch (e) {
      alert(e?.message || 'Gabim gjatë dorëzimit.');
    } finally {
      setBusy(false);
    }
  }

  async function onAcceptHandoff(pin, name) {
    if (!pin) return;
    const group = handoffs.find((x) => String(x?.pin || '') === String(pin));
    const total = Number(group?.total || 0);
    const ok = window.confirm(`A jeni i sigurt që dëshironi të pranoni ${euro(total)} nga ${name || pin}?`);
    if (!ok) return;

    setAdminBusyPin(String(pin));
    try {
      const res = await confirmHandoffByDispatch(pin, actor);
      if (!res?.ok) throw new Error(res?.error || 'Pranimi dështoi');
      await refreshAdmin();
      if (String(actor?.pin || '').trim() === String(pin).trim()) await refreshMine(actor);
      alert(`U pranuan ${euro(res?.total || total)} dhe u shtuan në buxhet.`);
    } catch (e) {
      alert(e?.message || 'Gabim gjatë pranimit.');
    } finally {
      setAdminBusyPin('');
    }
  }

  return (
    <div className="arkaHubPage">
      <div className="arkaHubShell">
        <div className="arkaHubTop">
          <div>
            <div className="arkaEyebrow">ARKA / HUB</div>
            <h1 className="arkaTitle">{isAdmin ? 'Dispatch & Buxheti i Arkës' : 'Dashboard Personal i Arkës'}</h1>
            <p className="arkaSubtitle">
              {isAdmin
                ? 'Prano dorëzimet nga terreni, kontrollo buxhetin total të kompanisë dhe hyr shpejt te payroll-i, stafi dhe shpenzimet.'
                : 'Këtu sheh vetëm paranë tënde, rrogën tënde dhe detyrimet e tua. Dorëzimi kalon tani te Dispatch.'}
            </p>
          </div>

          <Link href="/" className="homeBtn">
            ← HOME
          </Link>
        </div>

        <div className="myArkaCard">
          <div className="myArkaHead">
            <div>
              <div className="myArkaEyebrow">{isAdmin ? 'DISPATCH WALLET' : 'ARKA IME'}</div>
              <div className="myArkaName">{actor?.name || 'PUNËTORI'}</div>
              <div className="myArkaMeta">PIN: {actor?.pin || '—'} · ROLI: {actor?.role || '—'}</div>
            </div>
            <div className="myArkaAmount">{euro(isAdmin ? pendingDispatchTotal : myTotal)}</div>
          </div>
          {!isAdmin && (
            <button className="handoffBtn" disabled={busy || myTotal <= 0} onClick={onHandoff}>DORËZO PARET TE DISPATCH</button>
          )}
          <div className="myArkaList">
            {!isAdmin ? (
              mine.length ? mine.slice(0, 6).map((x) => (
                <div key={x.external_id || x.id} className="myArkaRow">
                  <div>
                    <div className="myArkaRowTitle">{x.client_name || x.order_code || 'PAGESË CASH'}</div>
                    <div className="myArkaRowSub">{x.order_code ? `KODI ${x.order_code}` : (x.note || 'Pa shënim')}</div>
                  </div>
                  <div className="myArkaRowAmt">{euro(x.amount || 0)}</div>
                </div>
              )) : <div className="myArkaEmpty">S’ke pagesa cash të padorëzuara.</div>
            ) : (
              handoffs.length ? handoffs.slice(0, 6).map((x) => (
                <div key={`${x.pin}_${x.name}`} className="myArkaRow">
                  <div>
                    <div className="myArkaRowTitle">{x.name || 'PUNËTOR'}</div>
                    <div className="myArkaRowSub">PIN {x.pin || '—'} · {x.count || 0} dorëzime në pritje</div>
                  </div>
                  <div className="myArkaRowAmt">{euro(x.total || 0)}</div>
                </div>
              )) : <div className="myArkaEmpty">S’ka dorëzime në pritje nga terreni.</div>
            )}
          </div>
        </div>

        {!isAdmin ? (
          <>
            <div className="dashboardGrid">
              <div className="infoCard">
                <div className="heroBadge">READ ONLY</div>
                <div className="heroHeading smallHeading">RROGA IME</div>
                <div className="bigValue">{euro(salaryValue)}</div>
                <div className="heroText">Shfaqet vetëm vlera aktuale e rrogës tënde. Pa butona editimi.</div>
              </div>

              <div className="infoCard">
                <div className="heroBadge amber">AVANSET E MIA</div>
                <div className="bigValue">{euro(myAdvanceTotal)}</div>
                <div className="miniList">
                  {myAdvances.length ? myAdvances.slice(0, 5).map((row) => (
                    <div key={row.external_id || row.id} className="miniRow">
                      <span>{row.note || row.client_name || 'AVANS'}</span>
                      <strong>{euro(row.amount || 0)}</strong>
                    </div>
                  )) : <div className="miniEmpty">S’ke avanse aktive.</div>}
                </div>
              </div>

              <div className="infoCard">
                <div className="heroBadge rose">BORXHET E MIA</div>
                <div className="bigValue">{euro(myDebtTotal)}</div>
                <div className="miniList">
                  {myDebts.length ? myDebts.slice(0, 5).map((row) => (
                    <div key={row.external_id || row.id} className="miniRow">
                      <span>{row.note || row.client_name || String(row.status || 'BORXH')}</span>
                      <strong>{euro(row.amount || 0)}</strong>
                    </div>
                  )) : <div className="miniEmpty">S’ke borxhe aktive.</div>}
                </div>
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="budgetHeroRow">
              <div className="budgetBigCard">
                <div className="heroBadge emerald">BUXHETI TOTAL I KOMPANISË</div>
                <div className="budgetValue">{euro(budgetTotals.companyTotal)}</div>
                <div className="budgetMetaGrid">
                  <div className="budgetMetaItem">
                    <span>Pranime ACCEPTED</span>
                    <strong>{euro(budgetTotals.acceptedIn)}</strong>
                  </div>
                  <div className="budgetMetaItem">
                    <span>Dalje nga buxheti</span>
                    <strong>{euro(budgetTotals.budgetOut)}</strong>
                  </div>
                </div>
                <div className="heroText">Formula: të gjitha pranimet ACCEPTED minus të gjitha daljet OUT nga buxheti, ku hyjnë rrogat dhe shpenzimet e regjistruara.</div>
              </div>

              <div className="heroCard">
                <div className="heroBadge">PRANIMET NGA TERRENI</div>
                <div className="heroHeading">Dispatch Queue</div>
                <div className="heroText">Këtu shfaqen punëtorët që kanë shtypur “Dorëzo”. Me ✅ PRANO, statusi kalon në ACCEPTED dhe shtohet në buxhet.</div>
              </div>
            </div>

            <div className="acceptCard">
              <div className="sectionHead">
                <div>
                  <div className="sectionEyebrow">DISPATCH</div>
                  <div className="sectionTitle">PRANIMET NGA TERRENI</div>
                </div>
                <div className="sectionTotal">{euro(pendingDispatchTotal)}</div>
              </div>

              <div className="acceptList">
                {handoffs.length ? handoffs.map((g) => (
                  <div className="acceptRow" key={`${g.pin}_${g.name}`}>
                    <div>
                      <div className="acceptName">{g.name || 'PUNËTOR'}</div>
                      <div className="acceptSub">PIN {g.pin || '—'} · {g.count || 0} pagesa në pritje</div>
                    </div>
                    <div className="acceptRight">
                      <div className="acceptAmt">{euro(g.total || 0)}</div>
                      <button
                        className="acceptBtn"
                        disabled={adminBusyPin === String(g.pin)}
                        onClick={() => onAcceptHandoff(g.pin, g.name)}
                      >
                        {adminBusyPin === String(g.pin) ? 'DUKE PRANUAR…' : '✅ PRANO'}
                      </button>
                    </div>
                  </div>
                )) : <div className="myArkaEmpty darkText">S’ka asnjë dorëzim në pritje.</div>}
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
                desc="Rroga bazë, dita e rrogës, avanset, borxhet afatgjata dhe fshirja e punëtorëve vetëm për admin."
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
        .homeBtn { text-decoration: none; background: rgba(255, 255, 255, 0.95); color: #0f172a; border: 1px solid #e2e8f0; border-radius: 16px; padding: 13px 18px; font-weight: 800; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.05); transition: transform 0.16s ease, box-shadow 0.16s ease, border-color 0.16s ease; }
        .homeBtn:hover { transform: translateY(-1px); box-shadow: 0 10px 22px rgba(15, 23, 42, 0.08); border-color: #cbd5e1; }
        .myArkaCard { background: #0f172a; color: #fff; border-radius: 28px; padding: 22px; border: 1px solid rgba(255,255,255,0.08); box-shadow: 0 10px 30px rgba(15, 23, 42, 0.08); margin-bottom: 20px; }
        .myArkaHead { display:flex; justify-content:space-between; gap:16px; align-items:flex-start; flex-wrap:wrap; }
        .myArkaEyebrow { font-size: 11px; font-weight: 900; letter-spacing: 0.14em; text-transform: uppercase; color: rgba(255,255,255,0.55); }
        .myArkaName { margin-top: 8px; font-size: 24px; font-weight: 900; line-height: 1; }
        .myArkaMeta { margin-top: 6px; font-size: 13px; color: rgba(255,255,255,0.62); }
        .myArkaAmount { font-size: clamp(28px, 4vw, 42px); font-weight: 900; letter-spacing: -0.04em; }
        .handoffBtn, .acceptBtn { margin-top: 16px; border: none; border-radius: 18px; padding: 16px 18px; color: #fff; font-size: 16px; font-weight: 900; cursor: pointer; }
        .handoffBtn { width: 100%; background: linear-gradient(180deg, #22c55e, #16a34a); }
        .handoffBtn:disabled, .acceptBtn:disabled { opacity: 0.45; cursor: not-allowed; }
        .myArkaList { margin-top: 14px; display: grid; gap: 10px; }
        .myArkaRow { display:flex; justify-content:space-between; gap:12px; align-items:center; padding: 11px 12px; border-radius: 16px; background: rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.06); }
        .myArkaRowTitle { font-size: 14px; font-weight: 800; }
        .myArkaRowSub { margin-top: 3px; font-size: 12px; color: rgba(255,255,255,0.58); }
        .myArkaRowAmt { font-size: 16px; font-weight: 900; white-space: nowrap; }
        .myArkaEmpty { padding: 12px; border-radius: 14px; background: rgba(255,255,255,0.05); color: rgba(255,255,255,0.72); font-size: 13px; }
        .darkText { color: #64748b; background: rgba(15, 23, 42, 0.04); }
        .dashboardGrid, .budgetHeroRow { display:grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap:18px; margin-bottom:20px; }
        .budgetHeroRow { grid-template-columns: 1.3fr .9fr; }
        .infoCard, .heroCard, .budgetBigCard, .acceptCard, .hubTile { background: rgba(255, 255, 255, 0.94); border: 1px solid rgba(226, 232, 240, 0.95); border-radius: 28px; padding: 24px; box-shadow: 0 10px 30px rgba(15, 23, 42, 0.05); }
        .heroBadge { display: inline-flex; align-items: center; justify-content: center; min-height: 30px; padding: 0 12px; border-radius: 999px; background: #eff6ff; color: #1d4ed8; border: 1px solid #bfdbfe; font-size: 11px; font-weight: 900; letter-spacing: 0.12em; text-transform: uppercase; }
        .heroBadge.amber { background:#fffbeb; color:#92400e; border-color:#fde68a; }
        .heroBadge.rose { background:#fff1f2; color:#be123c; border-color:#fecdd3; }
        .heroBadge.emerald { background:#ecfdf5; color:#166534; border-color:#bbf7d0; }
        .heroHeading { margin-top: 14px; font-size: clamp(22px, 2.8vw, 34px); line-height: 1.02; letter-spacing: -0.04em; font-weight: 900; color: #0f172a; }
        .smallHeading { font-size: 22px; }
        .heroText { margin-top: 10px; color: #64748b; font-size: 15px; line-height: 1.6; max-width: 720px; }
        .bigValue, .budgetValue { margin-top: 14px; font-size: clamp(34px, 4vw, 54px); font-weight: 900; line-height: 1; letter-spacing: -.05em; color:#0f172a; }
        .budgetMetaGrid { display:grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap:12px; margin-top:16px; }
        .budgetMetaItem { border-radius:18px; background:#f8fafc; border:1px solid #e2e8f0; padding:14px; }
        .budgetMetaItem span { display:block; font-size:11px; font-weight:900; letter-spacing:.12em; text-transform:uppercase; color:#64748b; margin-bottom:8px; }
        .budgetMetaItem strong { font-size:24px; font-weight:900; letter-spacing:-.04em; color:#0f172a; }
        .miniList, .acceptList { margin-top: 14px; display:grid; gap:10px; }
        .miniRow, .acceptRow { display:flex; justify-content:space-between; align-items:center; gap:12px; border-radius:16px; padding:12px 14px; background:#f8fafc; border:1px solid #e2e8f0; }
        .miniRow span { color:#475569; font-size:13px; }
        .miniRow strong { font-size:15px; font-weight:900; }
        .miniEmpty { color:#64748b; font-size:13px; }
        .sectionHead { display:flex; justify-content:space-between; align-items:flex-start; gap:16px; flex-wrap:wrap; }
        .sectionEyebrow { font-size:11px; font-weight:900; letter-spacing:.14em; text-transform:uppercase; color:#64748b; }
        .sectionTitle { margin-top:8px; font-size:28px; line-height:1; font-weight:900; letter-spacing:-.04em; }
        .sectionTotal { font-size:32px; font-weight:900; letter-spacing:-.04em; }
        .acceptName { font-size:16px; font-weight:900; color:#0f172a; }
        .acceptSub { margin-top:4px; font-size:12px; color:#64748b; }
        .acceptRight { display:flex; align-items:center; gap:12px; flex-wrap:wrap; }
        .acceptAmt { font-size:18px; font-weight:900; color:#0f172a; }
        .acceptBtn { margin-top:0; background: linear-gradient(180deg, #22c55e, #16a34a); padding:12px 16px; min-width:140px; }
        .hubGrid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 18px; }
        .hubTile { display: grid; grid-template-columns: auto 1fr auto; gap: 16px; align-items: center; min-height: 160px; }
        .hubTile:hover { transform: translateY(-2px); box-shadow: 0 18px 34px rgba(15, 23, 42, 0.08); border-color: #cbd5e1; }
        .hubTileIconWrap { width: 74px; height: 74px; border-radius: 22px; display: flex; align-items: center; justify-content: center; flex: 0 0 auto; }
        .hubTileIcon { font-size: 34px; line-height: 1; }
        .hubTileBody { min-width: 0; }
        .hubTileTitle { font-size: 22px; line-height: 1.05; letter-spacing: -0.035em; font-weight: 900; color: #0f172a; }
        .hubTileDesc { margin-top: 10px; color: #64748b; font-size: 14px; line-height: 1.6; }
        .hubTileArrow { font-size: 34px; line-height: 1; color: #94a3b8; font-weight: 500; }

        @media (max-width: 980px) {
          .dashboardGrid, .hubGrid, .budgetHeroRow { grid-template-columns: 1fr; }
        }
        @media (max-width: 640px) {
          .arkaHubPage { padding: 18px 12px 30px; }
          .heroCard, .hubTile, .acceptCard, .budgetBigCard, .infoCard { border-radius: 22px; }
          .hubTile { grid-template-columns: 1fr; align-items: flex-start; }
          .hubTileArrow { display: none; }
          .hubTileIconWrap { width: 64px; height: 64px; border-radius: 18px; }
          .homeBtn { width: 100%; text-align: center; }
          .arkaHubTop { gap: 14px; }
          .budgetMetaGrid { grid-template-columns: 1fr; }
          .acceptRight { width:100%; justify-content:space-between; }
        }
      `}</style>
    </div>
  );
}
