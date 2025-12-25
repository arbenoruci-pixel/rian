'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';

const LS_DAY_OPEN = (day) => `arka_day_open_${day}`;
const LS_DAY_CLOSE = (day) => `arka_day_close_${day}`;
const LS_EXP = (day) => `arka_exp_${day}`;
const LS_BUDGET = 'arka_company_budget_v1';
const LS_OWNERS = 'arka_owners_v1';

function todayISO() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function safeParse(v, fallback) {
  try {
    const x = JSON.parse(v);
    return x ?? fallback;
  } catch {
    return fallback;
  }
}

export default function ArkaBuxhetiPage() {
  const day = useMemo(() => todayISO(), []);

  const [cashStart, setCashStart] = useState('');
  const [cashClose, setCashClose] = useState('');
  const [expenses, setExpenses] = useState([]);
  const [expLabel, setExpLabel] = useState('');
  const [expAmount, setExpAmount] = useState('');
  const [companyBudget, setCompanyBudget] = useState('');
  const [owners, setOwners] = useState([]);

  // ARKA records (nga pagesat e porosive)
  const [arkaList, setArkaList] = useState([]);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    setCashStart(localStorage.getItem(LS_DAY_OPEN(day)) || '');
    setCashClose(localStorage.getItem(LS_DAY_CLOSE(day)) || '');
    setExpenses(safeParse(localStorage.getItem(LS_EXP(day)) || '[]', []));
    setCompanyBudget(localStorage.getItem(LS_BUDGET) || '');

    const o = safeParse(localStorage.getItem(LS_OWNERS) || '[]', null);
    if (Array.isArray(o) && o.length) setOwners(o);

    const list = safeParse(localStorage.getItem('arka_list_v1') || '[]', []);
    setArkaList(Array.isArray(list) ? list : []);
  }, [day]);

  function saveOwners(next) {
    setOwners(next);
    if (typeof window !== 'undefined') {
      localStorage.setItem(LS_OWNERS, JSON.stringify(next));
    }
  }

  const totalCollected = useMemo(() => {
    return arkaList.reduce((sum, r) => sum + (Number(r.paid) || 0), 0);
  }, [arkaList]);

  const totalExpenses = useMemo(() => {
    return expenses.reduce((sum, e) => sum + (Number(e.amount) || 0), 0);
  }, [expenses]);

  const startNum = Number(cashStart || 0) || 0;
  const closeNum = Number(cashClose || 0) || 0;
  const expectedCash = startNum + totalCollected - totalExpenses;
  const diff = closeNum ? (closeNum - expectedCash) : 0;

  function openDay() {
    if (!cashStart) return alert('SHKRUJ CASH START');
    localStorage.setItem(LS_DAY_OPEN(day), String(Number(cashStart) || 0));
    alert('DITA U HAP.');
  }

  function closeDay() {
    if (!cashClose) return alert('SHKRUJ CASH CLOSE');
    localStorage.setItem(LS_DAY_CLOSE(day), String(Number(cashClose) || 0));
    alert('DITA U MBYLL.');
  }

  function addExpense() {
    const amt = Number(expAmount);
    if (!expLabel.trim()) return alert('SHKRUJ ARSYEN');
    if (!amt || amt <= 0) return alert('SHKRUJ SHUMËN');

    const next = [
      { id: `exp_${Date.now()}`, label: expLabel.trim(), amount: amt, ts: Date.now() },
      ...expenses,
    ].slice(0, 200);

    setExpenses(next);
    localStorage.setItem(LS_EXP(day), JSON.stringify(next));
    setExpLabel('');
    setExpAmount('');
  }

  function setBudget() {
    localStorage.setItem(LS_BUDGET, String(Number(companyBudget) || 0));
    alert('BUXHETI U RUAJ.');
  }

  return (
    <div className="page">
      <header className="topbar">
        <div>
          <div className="title">BUXHETI</div>
          <div className="subtitle">DITA • CASH • SHPENZIME • Ndarja</div>
        </div>
        <Link className="btnGhost" href="/arka">KTHEHU</Link>
      </header>

      <div className="card">
        <div className="cardTitle">DITA E SOTME ({day})</div>

        <div className="grid2">
          <div>
            <div className="label">CASH START (€)</div>
            <input className="inp" value={cashStart} onChange={(e) => setCashStart(e.target.value)} aria-label="0" />
            <button className="btn" onClick={openDay}>HAP DITËN</button>
          </div>

          <div>
            <div className="label">CASH CLOSE (€)</div>
            <input className="inp" value={cashClose} onChange={(e) => setCashClose(e.target.value)} aria-label="0" />
            <button className="btn" onClick={closeDay}>MBYLLE DITËN</button>
          </div>
        </div>

        <div className="statsRow">
          <div className="stat">
            <div className="statK">SOT (PAGESA)</div>
            <div className="statV">{totalCollected.toFixed(2)} €</div>
          </div>
          <div className="stat">
            <div className="statK">SHPENZIME</div>
            <div className="statV">{totalExpenses.toFixed(2)} €</div>
          </div>
          <div className="stat">
            <div className="statK">CASH PRITET</div>
            <div className="statV">{expectedCash.toFixed(2)} €</div>
          </div>
          <div className="stat">
            <div className="statK">DISKREPANCË</div>
            <div className="statV">{diff.toFixed(2)} €</div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="cardTitle">SHPENZIME</div>

        <div className="grid2">
          <div>
            <div className="label">ARSYEJA</div>
            <input className="inp" value={expLabel} onChange={(e) => setExpLabel(e.target.value)} aria-label="NAFTE / UJË / QIRA..." />
          </div>
          <div>
            <div className="label">SHUMA (€)</div>
            <input className="inp" value={expAmount} onChange={(e) => setExpAmount(e.target.value)} aria-label="0" />
          </div>
        </div>

        <button className="btn" onClick={addExpense}>SHTO SHPENZIM</button>

        <div className="list">
          {expenses.length === 0 ? (
            <div className="muted">S'KA SHPENZIME SOT.</div>
          ) : (
            expenses.map((e) => (
              <div key={e.id} className="row">
                <div className="rowMain">{String(e.label || '').toUpperCase()}</div>
                <div className="rowRight">-{Number(e.amount || 0).toFixed(2)} €</div>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="card">
        <div className="cardTitle">BUXHETI I KOMPANISË (TOTAL)</div>
        <div className="label">SHUMA (€)</div>
        <input className="inp" value={companyBudget} onChange={(e) => setCompanyBudget(e.target.value)} aria-label="0" />
        <button className="btn" onClick={setBudget}>RUAJ BUXHETIN</button>
      </div>

      <div className="card">
        <div className="cardTitle">NDARJA E PROFITIT (OWNER SPLIT)</div>
        <div className="muted">Kjo është bazë. Më vonë e lidhim me raport mujor.</div>

        {owners.map((o, idx) => (
          <div key={o.id} className="grid2" style={{ marginBottom: 10 }}>
            <div>
              <div className="label">EMRI</div>
              <input
                className="inp"
                value={o.name}
                onChange={(e) => {
                  const next = owners.map((x) => ({ ...x }));
                  next[idx].name = e.target.value;
                  saveOwners(next);
                }}
              />
            </div>
            <div>
              <div className="label">%</div>
              <input
                className="inp"
                value={o.pct}
                onChange={(e) => {
                  const pct = Math.max(0, Math.min(100, Number(e.target.value) || 0));
                  const next = owners.map((x) => ({ ...x }));
                  next[idx].pct = pct;
                  saveOwners(next);
                }}
              />
            </div>
          </div>
        ))}
      </div>

      <style jsx>{`
        .page { padding: 18px; max-width: 920px; margin: 0 auto; }
        .topbar { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; margin-bottom: 16px; }
        .title { font-size: 40px; font-weight: 900; letter-spacing: 1px; }
        .subtitle { opacity: .75; font-weight: 700; }
        .btn, .btnGhost { display:inline-block; padding: 12px 14px; border-radius: 14px; font-weight: 900; letter-spacing: .5px; text-transform: uppercase; }
        .btn { background:#2d6cdf; color:#fff; border:0; width:100%; margin-top: 10px; }
        .btnGhost { border: 1px solid rgba(255,255,255,.18); }
        .card { background: rgba(255,255,255,.04); border: 1px solid rgba(255,255,255,.10); border-radius: 20px; padding: 16px; margin-bottom: 14px; }
        .cardTitle { font-weight: 900; letter-spacing: 1px; margin-bottom: 12px; }
        .label { opacity: .75; font-size: 12px; font-weight: 800; letter-spacing: 1px; margin: 10px 0 6px; }
        .inp { width:100%; padding: 12px 12px; border-radius: 14px; border: 1px solid rgba(255,255,255,.12); background: rgba(0,0,0,.20); color:#fff; font-weight: 800; }
        .grid2 { display:grid; grid-template-columns: 1fr 1fr; gap: 12px; }
        @media (max-width: 640px) { .grid2 { grid-template-columns: 1fr; } .title { font-size: 34px; } }
        .statsRow { display:grid; grid-template-columns: repeat(2, 1fr); gap: 10px; margin-top: 14px; }
        @media (min-width: 820px) { .statsRow { grid-template-columns: repeat(4, 1fr); } }
        .stat { background: rgba(0,0,0,.20); border: 1px solid rgba(255,255,255,.10); border-radius: 16px; padding: 12px; }
        .statK { opacity: .75; font-weight: 900; font-size: 11px; letter-spacing: 1px; }
        .statV { font-weight: 900; font-size: 20px; margin-top: 4px; }
        .list { margin-top: 10px; }
        .row { display:flex; align-items:center; justify-content:space-between; gap: 10px; padding: 10px 12px; border-radius: 14px; border: 1px solid rgba(255,255,255,.10); background: rgba(0,0,0,.18); margin-bottom: 8px; }
        .rowMain { font-weight: 900; letter-spacing: .5px; }
        .rowRight { font-weight: 900; }
        .muted { opacity: .7; font-weight: 700; }
      `}</style>
    </div>
  );
}
