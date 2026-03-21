'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { getActor } from '@/lib/actorSession';
import {
  addOwnerInvestment,
  acceptDispatchHandoff,
  listCompanyLedger,
  listOwners,
  listPendingDispatchHandoffs,
  listWorkerReadyCash,
  rejectDispatchHandoff,
  repayOwnerInvestment,
  spendFromCompanyBudget,
  splitProfitToOwners,
  submitWorkerCashToDispatch,
} from '@/lib/corporateFinance';
import { supabase } from '@/lib/supabaseClient';

const euro = (n) => `€${Number(n || 0).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const norm = (v) => Number(v || 0) || 0;

function Stat({ label, value, danger }) {
  return (
    <div className={`statCard ${danger ? 'danger' : ''}`}>
      <div className="statLabel">{label}</div>
      <div className="statValue">{value}</div>
    </div>
  );
}

function SectionCard({ title, sub, children, right }) {
  return (
    <section className="sectionCard">
      <div className="sectionHead">
        <div>
          <div className="sectionTitle">{title}</div>
          {sub ? <div className="sectionSub">{sub}</div> : null}
        </div>
        {right}
      </div>
      {children}
    </section>
  );
}

export default function CorporateFinancePage() {
  const [actor, setActor] = useState(null);
  const [tab, setTab] = useState('WORKER');
  const [summary, setSummary] = useState({ current_balance: 0, total_in: 0, total_out: 0 });
  const [workerCash, setWorkerCash] = useState([]);
  const [handoffs, setHandoffs] = useState([]);
  const [ledger, setLedger] = useState([]);
  const [owners, setOwners] = useState([]);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [expense, setExpense] = useState({ amount: '', category: 'MATERIALE', description: '' });
  const [split, setSplit] = useState({ amount: '', description: 'Ndarje fitimi mujor' });
  const [investment, setInvestment] = useState({ ownerId: '', amount: '', description: '', mode: 'ADDITIONAL' });
  const [repayment, setRepayment] = useState({ ownerId: '', amount: '', description: '' });

  const role = String(actor?.role || '').trim().toUpperCase();
  const workerOnly = ['PUNTOR', 'PUNETOR', 'WORKER', 'TRANSPORT'].includes(role);
  const dispatch = role === 'DISPATCH';
  const admin = ['ADMIN', 'ADMIN_MASTER', 'OWNER', 'PRONAR', 'SUPERADMIN'].includes(role);
  const canWorkerTab = workerOnly || admin;
  const canDispatchTab = dispatch || admin;
  const canCompanyTab = admin;
  const canOwnersTab = admin;

  async function loadAll(a = null) {
    const act = a || getActor();
    setActor(act || null);
    setErr('');
    try {
      const [sumRes, workerRes, ledgerRes, handoffsRes, ownersRes] = await Promise.all([
        supabase.from('company_budget_summary').select('*').eq('id', 1).single(),
        act?.pin ? listWorkerReadyCash(act.pin) : Promise.resolve([]),
        admin ? listCompanyLedger(80) : Promise.resolve([]),
        (admin || dispatch) ? listPendingDispatchHandoffs() : Promise.resolve([]),
        admin ? listOwners() : Promise.resolve([]),
      ]);
      if (sumRes?.error) throw sumRes.error;
      setSummary(sumRes.data || { current_balance: 0, total_in: 0, total_out: 0 });
      setWorkerCash(Array.isArray(workerRes) ? workerRes : []);
      setLedger(Array.isArray(ledgerRes) ? ledgerRes : []);
      setHandoffs(Array.isArray(handoffsRes) ? handoffsRes : []);
      setOwners(Array.isArray(ownersRes) ? ownersRes : []);
    } catch (e) {
      setErr(e?.message || String(e));
    }
  }

  useEffect(() => {
    void loadAll();
  }, []);

  useEffect(() => {
    if (!actor?.pin) return;
    if (workerOnly && tab !== 'WORKER') {
      setTab('WORKER');
      return;
    }
    if (dispatch && tab !== 'DISPATCH') {
      setTab('DISPATCH');
      return;
    }
    if (tab === 'WORKER' && !canWorkerTab) {
      setTab(canDispatchTab ? 'DISPATCH' : canCompanyTab ? 'COMPANY' : 'WORKER');
      return;
    }
    if (tab === 'DISPATCH' && !canDispatchTab) {
      setTab(canWorkerTab ? 'WORKER' : canCompanyTab ? 'COMPANY' : 'WORKER');
      return;
    }
    if (tab === 'COMPANY' && !canCompanyTab) {
      setTab(canDispatchTab ? 'DISPATCH' : 'WORKER');
      return;
    }
    if (tab === 'OWNERS' && !canOwnersTab) {
      setTab(canCompanyTab ? 'COMPANY' : canDispatchTab ? 'DISPATCH' : 'WORKER');
    }
  }, [actor?.pin, workerOnly, dispatch, canWorkerTab, canDispatchTab, canCompanyTab, canOwnersTab, tab]);

  const workerTotal = useMemo(() => workerCash.reduce((s, x) => s + norm(x.amount), 0), [workerCash]);

  async function actWrap(key, fn) {
    setBusy(key);
    setErr('');
    setMsg('');
    try {
      await fn();
      setMsg('U KRY ME SUKSES.');
      await loadAll();
    } catch (e) {
      setErr(e?.message || String(e));
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="corpPage">
      <div className="corpShell">
        <div className="topBar">
          <div>
            <div className="eyebrow">KORPORATË / FINANCA</div>
            <h1 className="title">SISTEMI FINANCIAR ME 4 NIVELE</h1>
            <div className="sub">PUNËTORI → DISPATCH → BUXHETI I KOMPANISË → PRONARËT</div>
          </div>
          <div className="topActions">
            <Link href="/arka" className="ghostBtn">← ARKA</Link>
            <Link href="/" className="ghostBtn">HOME</Link>
          </div>
        </div>

        <div className="statsGrid">
          {(admin || dispatch) ? <Stat label="BUXHETI I KOMPANISË" value={euro(summary.current_balance)} /> : null}
          {admin ? <Stat label="HYRJE TOTALE" value={euro(summary.total_in)} /> : null}
          {admin ? <Stat label="DALJE TOTALE" value={euro(summary.total_out)} danger /> : null}
          <Stat label="ARKA IME NË TERREN" value={euro(workerTotal)} />
        </div>

        <div className="tabs">
          {canWorkerTab ? <button className={tab === 'WORKER' ? 'tab active' : 'tab'} onClick={() => setTab('WORKER')}>1. PUNËTORI</button> : null}
          {canDispatchTab ? <button className={tab === 'DISPATCH' ? 'tab active' : 'tab'} onClick={() => setTab('DISPATCH')}>2. DISPATCH</button> : null}
          {canCompanyTab ? <button className={tab === 'COMPANY' ? 'tab active' : 'tab'} onClick={() => setTab('COMPANY')}>3. KOMPANIA</button> : null}
          {canOwnersTab ? <button className={tab === 'OWNERS' ? 'tab active' : 'tab'} onClick={() => setTab('OWNERS')}>4. OWNERS</button> : null}
        </div>

        {msg ? <div className="okBox">{msg}</div> : null}
        {err ? <div className="errBox">{err}</div> : null}

        {tab === 'WORKER' && canWorkerTab ? (
          <SectionCard
            title="PANELI I PUNËTORIT"
            sub="Punëtori mbledh cash dhe e dorëzon te Dispatch. Paratë nuk hyjnë direkt në buxhet."
            right={workerOnly ? (
              <button
                className="primaryBtn"
                disabled={busy === 'handoff' || workerTotal <= 0}
                onClick={() => actWrap('handoff', () => submitWorkerCashToDispatch({ actor }))}
              >
                DORËZO LEKËT TE DISPATCH
              </button>
            ) : null}
          >
            <div className="listCard">
              {workerCash.length ? workerCash.map((row) => (
                <div className="listRow" key={row.id}>
                  <div>
                    <div className="rowTitle">{row.client_name || `KODI ${row.order_code || '—'}`}</div>
                    <div className="rowSub">{row.order_code ? `POROSIA ${row.order_code}` : (row.note || 'PAGESË CASH')}</div>
                  </div>
                  <div className="rowAmt">{euro(row.amount)}</div>
                </div>
              )) : <div className="empty">NUK KA CASH TË PADORËZUAR.</div>}
            </div>
          </SectionCard>
        ) : null}

        {tab === 'DISPATCH' && canDispatchTab ? (
          <SectionCard title="PRANIMI NGA DISPATCH" sub="Vetëm kur Dispatch pranon, lekët hyjnë në buxhetin e kompanisë.">
            <div className="listCard">
              {(dispatch || admin) ? (handoffs.length ? handoffs.map((h) => (
                <div key={h.id} className="handoffCard">
                  <div className="handoffTop">
                    <div>
                      <div className="rowTitle">{h.worker_name || h.worker_pin}</div>
                      <div className="rowSub">KËRKON TË DORËZOJË {euro(h.amount)}</div>
                    </div>
                    <div className="badge">{(h.cash_handoff_items || []).length} PAGESA</div>
                  </div>
                  <div className="rowActions">
                    <button className="secondaryBtn" disabled={busy === `reject-${h.id}`} onClick={() => actWrap(`reject-${h.id}`, () => rejectDispatchHandoff({ handoffId: h.id, actor, note: 'REFUZUAR NGA DISPATCH' }))}>REFUZO</button>
                    <button className="primaryBtn" disabled={busy === `accept-${h.id}`} onClick={() => actWrap(`accept-${h.id}`, () => acceptDispatchHandoff({ handoffId: h.id, actor }))}>PRANO</button>
                  </div>
                </div>
              )) : <div className="empty">NUK KA DORËZIME NË PRITJE.</div>) : <div className="empty">KËTU HYJNË VETËM DISPATCH / ADMIN.</div>}
            </div>
          </SectionCard>
        ) : null}

        {tab === 'COMPANY' && canCompanyTab ? (
          <SectionCard title="BUXHETI I KOMPANISË" sub="Shpenzime të detajuara dhe kalimi i fitimit te pronarët.">
            {admin ? (
              <>
                <div className="formGrid">
                  <div className="fieldCard">
                    <div className="fieldLabel">PAGUAJ FATURA / SHPENZIME</div>
                    <input className="input" placeholder="Shuma" value={expense.amount} onChange={(e) => setExpense((s) => ({ ...s, amount: e.target.value }))} />
                    <select className="input" value={expense.category} onChange={(e) => setExpense((s) => ({ ...s, category: e.target.value }))}>
                      <option value="RROGA">RROGA</option>
                      <option value="RRYMA">RRYMA</option>
                      <option value="QIRA">QIRA</option>
                      <option value="MATERIALE">MATERIALE</option>
                      <option value="KARBURANT">KARBURANT</option>
                      <option value="TJERA">TJERA</option>
                    </select>
                    <textarea className="textarea" placeholder="PËRSHKRIMI ËSHTË I DETYRUESHËM" value={expense.description} onChange={(e) => setExpense((s) => ({ ...s, description: e.target.value }))} />
                    <button className="primaryBtn" disabled={busy === 'expense'} onClick={() => actWrap('expense', () => spendFromCompanyBudget({ actor, amount: expense.amount, category: expense.category, description: expense.description }))}>REGJISTRO SHPENZIM</button>
                  </div>

                  <div className="fieldCard gold">
                    <div className="fieldLabel">KALO FITIMIN TE PRONARËT</div>
                    <input className="input" placeholder="Shuma e fitimit" value={split.amount} onChange={(e) => setSplit((s) => ({ ...s, amount: e.target.value }))} />
                    <textarea className="textarea" placeholder="PËRSHKRIMI" value={split.description} onChange={(e) => setSplit((s) => ({ ...s, description: e.target.value }))} />
                    <button className="goldBtn" disabled={busy === 'split'} onClick={() => actWrap('split', () => splitProfitToOwners({ actor, totalProfit: split.amount, description: split.description }))}>SPLIT PROFIT</button>
                  </div>
                </div>

                <div className="ledgerList">
                  {ledger.length ? ledger.slice(0, 20).map((row) => (
                    <div className="listRow" key={row.id}>
                      <div>
                        <div className="rowTitle">{row.category}</div>
                        <div className="rowSub">{row.description}</div>
                      </div>
                      <div className={String(row.direction).toUpperCase() === 'IN' ? 'amtIn' : 'amtOut'}>
                        {String(row.direction).toUpperCase() === 'IN' ? '+' : '-'}{euro(row.amount)}
                      </div>
                    </div>
                  )) : <div className="empty">NUK KA LËVIZJE NË LEDGER.</div>}
                </div>
              </>
            ) : <div className="empty">VETËM ADMIN / OWNER MUND TË MENAXHOJNË BUXHETIN.</div>}
          </SectionCard>
        ) : null}

        {tab === 'OWNERS' && canOwnersTab ? (
          <SectionCard title="OWNERS BOARD" sub="Investim fillestar, kthim investimi dhe ndarje fitimi.">
            {admin ? (
              <>
                <div className="formGrid">
                  <div className="fieldCard">
                    <div className="fieldLabel">DEDUCT INVESTMENT</div>
                    <select className="input" value={repayment.ownerId} onChange={(e) => setRepayment((s) => ({ ...s, ownerId: e.target.value }))}>
                      <option value="">ZGJIDH PRONARIN</option>
                      {owners.map((o) => <option key={o.owner_id} value={o.owner_id}>{o.owner_name}</option>)}
                    </select>
                    <input className="input" placeholder="Shuma" value={repayment.amount} onChange={(e) => setRepayment((s) => ({ ...s, amount: e.target.value }))} />
                    <textarea className="textarea" placeholder="PËRSHKRIMI" value={repayment.description} onChange={(e) => setRepayment((s) => ({ ...s, description: e.target.value }))} />
                    <button className="primaryBtn" disabled={busy === 'repay'} onClick={() => actWrap('repay', () => repayOwnerInvestment({ actor, ownerId: repayment.ownerId, amount: repayment.amount, description: repayment.description }))}>DEDUCT INVESTMENT</button>
                  </div>

                  <div className="fieldCard">
                    <div className="fieldLabel">SHTO INVESTIM</div>
                    <select className="input" value={investment.ownerId} onChange={(e) => setInvestment((s) => ({ ...s, ownerId: e.target.value }))}>
                      <option value="">ZGJIDH PRONARIN</option>
                      {owners.map((o) => <option key={o.owner_id} value={o.owner_id}>{o.owner_name}</option>)}
                    </select>
                    <select className="input" value={investment.mode} onChange={(e) => setInvestment((s) => ({ ...s, mode: e.target.value }))}>
                      <option value="INITIAL">INVESTIM FILLESTAR</option>
                      <option value="ADDITIONAL">INVESTIM SHTESË</option>
                    </select>
                    <input className="input" placeholder="Shuma" value={investment.amount} onChange={(e) => setInvestment((s) => ({ ...s, amount: e.target.value }))} />
                    <textarea className="textarea" placeholder="PËRSHKRIMI" value={investment.description} onChange={(e) => setInvestment((s) => ({ ...s, description: e.target.value }))} />
                    <button className="primaryBtn" disabled={busy === 'invest'} onClick={() => actWrap('invest', () => addOwnerInvestment({ actor, ownerId: investment.ownerId, amount: investment.amount, description: investment.description, investmentType: investment.mode }))}>SHTO INVESTIM</button>
                  </div>
                </div>

                <div className="ownerGrid">
                  {owners.length ? owners.map((o) => (
                    <div className="ownerCard" key={o.owner_id}>
                      <div className="ownerName">{o.owner_name}</div>
                      <div className="ownerMeta">SHARE {Number(o.share_percent || 0).toFixed(2)}%</div>
                      <div className="ownerLine"><span>INVESTUAR</span><strong>{euro(o.total_invested)}</strong></div>
                      <div className="ownerLine"><span>KTHYER</span><strong>{euro(o.total_repaid)}</strong></div>
                      <div className="ownerLine"><span>MBETUR</span><strong>{euro(o.remaining_investment)}</strong></div>
                      <div className="ownerLine"><span>FITIM I MARRË</span><strong>{euro(o.total_profit_received)}</strong></div>
                    </div>
                  )) : <div className="empty">NUK KA PRONARË TË KONFIGURUAR.</div>}
                </div>
              </>
            ) : <div className="empty">OWNERS BOARD ËSHTË VETËM PËR ADMIN / OWNER.</div>}
          </SectionCard>
        ) : null}
      </div>

      <style jsx>{`
        .corpPage { min-height:100vh; background:#07111f; color:#eef4ff; padding:20px; }
        .corpShell { width:min(1240px,100%); margin:0 auto; display:grid; gap:18px; }
        .topBar { display:flex; justify-content:space-between; gap:16px; align-items:flex-start; }
        .eyebrow { color:#91a4c7; font-size:12px; font-weight:900; letter-spacing:.16em; }
        .title { margin:6px 0 8px; font-size:34px; line-height:1; font-weight:1000; }
        .sub { color:#8fa3c8; font-size:14px; font-weight:800; }
        .topActions { display:flex; gap:10px; flex-wrap:wrap; }
        .ghostBtn, .tab, .primaryBtn, .secondaryBtn, .goldBtn { border:none; cursor:pointer; }
        .ghostBtn { background:#0a1730; color:#eef4ff; border:1px solid rgba(74,120,255,.28); padding:12px 16px; border-radius:16px; font-weight:900; text-decoration:none; }
        .statsGrid { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:12px; }
        .statCard { background:linear-gradient(180deg,#0a1831,#071325); border:1px solid rgba(84,124,255,.2); border-radius:22px; padding:18px; box-shadow:0 14px 40px rgba(0,0,0,.28); }
        .statCard.danger { border-color:rgba(255,105,105,.26); }
        .statLabel { color:#8ea4c7; font-size:12px; font-weight:900; letter-spacing:.12em; }
        .statValue { margin-top:8px; font-size:31px; font-weight:1000; }
        .tabs { display:flex; gap:10px; flex-wrap:wrap; }
        .tab { background:#0b1730; color:#dfe9ff; border:1px solid rgba(77,123,255,.2); padding:12px 16px; border-radius:16px; font-weight:1000; }
        .tab.active { background:linear-gradient(135deg,#2563eb,#3b82f6); color:#fff; }
        .okBox,.errBox { border-radius:18px; padding:14px 16px; font-weight:900; }
        .okBox { background:rgba(34,197,94,.12); border:1px solid rgba(34,197,94,.28); color:#b8ffd1; }
        .errBox { background:rgba(255,87,87,.12); border:1px solid rgba(255,87,87,.26); color:#ffc1c1; }
        .sectionCard { background:linear-gradient(180deg,#09162b,#06111f); border:1px solid rgba(77,123,255,.18); border-radius:28px; padding:22px; box-shadow:0 18px 44px rgba(0,0,0,.30); }
        .sectionHead { display:flex; justify-content:space-between; align-items:flex-start; gap:14px; margin-bottom:16px; }
        .sectionTitle { font-size:26px; font-weight:1000; }
        .sectionSub { margin-top:6px; color:#8ea4c7; font-weight:800; }
        .listCard,.ledgerList,.ownerGrid,.formGrid { display:grid; gap:12px; }
        .listRow,.handoffCard,.ownerCard,.fieldCard { background:rgba(10,24,49,.72); border:1px solid rgba(74,120,255,.16); border-radius:22px; padding:16px; }
        .handoffTop,.rowActions,.ownerLine { display:flex; align-items:center; justify-content:space-between; gap:12px; }
        .rowTitle,.ownerName { font-size:20px; font-weight:1000; }
        .rowSub,.ownerMeta { color:#8ea4c7; font-weight:800; }
        .rowAmt,.amtIn,.amtOut,.badge { font-weight:1000; }
        .amtIn { color:#69f0ae; }
        .amtOut { color:#ff9d9d; }
        .badge { background:#102244; color:#dbe7ff; border:1px solid rgba(74,120,255,.24); border-radius:999px; padding:8px 12px; }
        .primaryBtn,.secondaryBtn,.goldBtn { border-radius:16px; padding:14px 18px; font-weight:1000; }
        .primaryBtn { background:linear-gradient(135deg,#2563eb,#3b82f6); color:white; }
        .secondaryBtn { background:#0a1730; color:#eef4ff; border:1px solid rgba(74,120,255,.24); }
        .goldBtn { background:linear-gradient(135deg,#d4a62c,#f7c948); color:#1c1400; }
        .primaryBtn:disabled,.secondaryBtn:disabled,.goldBtn:disabled { opacity:.5; cursor:not-allowed; }
        .formGrid { grid-template-columns:repeat(2,minmax(0,1fr)); }
        .fieldCard.gold { border-color:rgba(247,201,72,.28); }
        .fieldLabel { font-size:13px; color:#9eb3d7; font-weight:1000; letter-spacing:.12em; margin-bottom:12px; }
        .input,.textarea { width:100%; background:#06101e; color:#f2f6ff; border:1px solid rgba(76,123,255,.16); border-radius:16px; padding:14px 16px; font-size:16px; font-weight:800; outline:none; margin-bottom:10px; }
        .textarea { min-height:110px; resize:vertical; }
        .ownerGrid { grid-template-columns:repeat(2,minmax(0,1fr)); }
        .empty { color:#8ea4c7; font-weight:900; padding:8px 2px; }
        @media (max-width:980px){ .statsGrid,.formGrid,.ownerGrid { grid-template-columns:1fr; } .topBar,.sectionHead { flex-direction:column; } }
      `}</style>
    </div>
  );
}
