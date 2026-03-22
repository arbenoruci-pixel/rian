'use client';

import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient';
import { getActor } from '@/lib/actorSession';
import {
  addOwnerInvestment,
  listCompanyLedger,
  listOwners,
  repayOwnerInvestment,
  spendFromCompanyBudget,
  splitProfitToOwners,
} from '@/lib/corporateFinance';
import { isAdmin } from '@/lib/roles';

const euro = (n) => `€${Number(n || 0).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const num = (v) => Number(v || 0) || 0;

function parseAmount(v) {
  const s = String(v ?? '').trim().replace(/\s/g, '').replace(',', '.');
  const n = Number(s || 0);
  return Number.isFinite(n) ? n : NaN;
}

function monthKeyFromDate(value) {
  const raw = String(value || '');
  if (!raw) return new Date().toISOString().slice(0, 7);
  return raw.slice(0, 7);
}

function normalizeLedgerRow(row = {}) {
  const direction = String(row?.direction || '').toUpperCase();
  const amount = num(row?.amount);
  return {
    ...row,
    direction,
    amount,
    created_at: row?.created_at || null,
    category: row?.category || 'TJERA',
    description: row?.description || '',
    month_key: monthKeyFromDate(row?.created_at),
  };
}

export default function CompanyBudgetDashboardPage() {
  const router = useRouter();
  const [actor, setActor] = useState(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [info, setInfo] = useState('');
  const [summary, setSummary] = useState({ current_balance: 0, total_in: 0, total_out: 0 });
  const [ledger, setLedger] = useState([]);
  const [owners, setOwners] = useState([]);
  const [investments, setInvestments] = useState([]);
  const [expense, setExpense] = useState({ amount: '', category: 'TJERA', description: '' });
  const [split, setSplit] = useState({ amount: '', description: 'NDARJE FITIMI MUJOR' });
  const [investmentForm, setInvestmentForm] = useState({ ownerId: '', amount: '', description: '', mode: 'ADDITIONAL' });
  const [repayForm, setRepayForm] = useState({ ownerId: '', amount: '', description: '' });

  const canSee = useMemo(() => isAdmin(actor?.role), [actor?.role]);
  const monthKey = useMemo(() => new Date().toISOString().slice(0, 7), []);

  const monthRows = useMemo(
    () => ledger.filter((r) => String(r.month_key || '') === monthKey),
    [ledger, monthKey],
  );

  const monthProfit = useMemo(() => {
    const ins = monthRows.filter((r) => r.direction === 'IN').reduce((a, r) => a + r.amount, 0);
    const outs = monthRows.filter((r) => r.direction === 'OUT').reduce((a, r) => a + r.amount, 0);
    return ins - outs;
  }, [monthRows]);

  const monthOwnerSplit = useMemo(() => {
    return monthRows
      .filter((r) => String(r.category || '').toUpperCase() === 'OWNER_PROFIT_SPLIT')
      .reduce((a, r) => a + r.amount, 0);
  }, [monthRows]);

  async function loadData(currentActor = null) {
    const a = currentActor || getActor();
    if (!a) {
      router.push('/');
      return;
    }
    setActor(a);
    setErr('');

    try {
      const [summaryRes, ledgerRes, ownersRes, invRes] = await Promise.all([
        supabase.from('company_budget_summary').select('*').eq('id', 1).single(),
        listCompanyLedger(120).catch(() => []),
        listOwners().catch(() => []),
        supabase
          .from('owner_investments')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(80)
          .then((r) => (r.error ? [] : (r.data || [])))
          .catch(() => []),
      ]);

      if (summaryRes?.error) throw summaryRes.error;

      const nextOwners = Array.isArray(ownersRes) ? ownersRes : [];
      setSummary(summaryRes.data || { current_balance: 0, total_in: 0, total_out: 0 });
      setLedger((Array.isArray(ledgerRes) ? ledgerRes : []).map(normalizeLedgerRow));
      setOwners(nextOwners);
      setInvestments(Array.isArray(invRes) ? invRes : []);

      const fallbackOwnerId = nextOwners[0]?.owner_id || nextOwners[0]?.id || '';
      setInvestmentForm((f) => ({ ...f, ownerId: f.ownerId || fallbackOwnerId }));
      setRepayForm((f) => ({ ...f, ownerId: f.ownerId || fallbackOwnerId }));
    } catch (e) {
      setSummary({ current_balance: 0, total_in: 0, total_out: 0 });
      setLedger([]);
      setOwners([]);
      setInvestments([]);
      setErr(e?.message || 'NUK U NGARKUA BUXHETI I KOMPANISË.');
    }
  }

  useEffect(() => {
    void loadData();
  }, []);

  async function actWrap(key, fn, okMsg) {
    setBusy(key);
    setErr('');
    setInfo('');
    try {
      await fn();
      setInfo(okMsg || 'U RUAJT ME SUKSES.');
      await loadData(actor);
    } catch (e) {
      setErr(e?.message || String(e));
    } finally {
      setBusy('');
    }
  }

  async function doExpense() {
    const amount = parseAmount(expense.amount);
    await actWrap(
      'expense',
      () => spendFromCompanyBudget({
        actor,
        amount,
        category: expense.category,
        description: expense.description,
      }),
      'SHPENZIMI U REGJISTRUA NË LEDGER.',
    );
    setExpense({ amount: '', category: expense.category, description: '' });
  }

  async function doSplit() {
    const amount = parseAmount(split.amount);
    await actWrap(
      'split',
      () => splitProfitToOwners({ actor, totalProfit: amount, description: split.description }),
      'FITIMI U NDA TE PRONARËT.',
    );
    setSplit((s) => ({ ...s, amount: '' }));
  }

  async function doInvestment() {
    const amount = parseAmount(investmentForm.amount);
    await actWrap(
      'investment',
      () => addOwnerInvestment({
        actor,
        ownerId: investmentForm.ownerId,
        amount,
        description: investmentForm.description,
        investmentType: investmentForm.mode,
      }),
      'INVESTIMI U REGJISTRUA.',
    );
    setInvestmentForm((s) => ({ ...s, amount: '', description: '' }));
  }

  async function doRepay() {
    const amount = parseAmount(repayForm.amount);
    await actWrap(
      'repay',
      () => repayOwnerInvestment({
        actor,
        ownerId: repayForm.ownerId,
        amount,
        description: repayForm.description,
      }),
      'KTHIMI I INVESTIMIT U REGJISTRUA.',
    );
    setRepayForm((s) => ({ ...s, amount: '', description: '' }));
  }

  if (!actor) return null;

  return (
    <div className="pageWrap">
      <div className="topRow">
        <div>
          <div className="title">BUXHETI I KOMPANISË</div>
          <div className="sub">KORPORATË • COMPANY_BUDGET_SUMMARY • COMPANY_BUDGET_LEDGER</div>
        </div>
        <div className="topActions">
          <button className="ghostBtn" type="button" onClick={() => loadData(actor)}>RIFRESKO</button>
          <Link className="ghostBtn" href="/arka/corporate">KORPORATË</Link>
          <Link className="ghostBtn" href="/arka">KTHEHU</Link>
        </div>
      </div>

      {err ? <div className="err">{err}</div> : null}
      {info ? <div className="ok">{info}</div> : null}

      {!canSee ? (
        <div className="card premiumCard">
          <div className="cardTitle">VETËM ADMIN / DISPATCH</div>
          <div className="muted">KJO FAQE ËSHTË E MBYLLUR PËR PËRDORUESIT E TJERË.</div>
        </div>
      ) : (
        <>
          <div className="metricsGrid">
            <div className="heroCard live">
              <div className="metricLabel">💼 BUXHETI AKTUAL</div>
              <div className="metricValue">{euro(summary.current_balance)}</div>
              <div className="metricHint">LEXUAR NGA COMPANY_BUDGET_SUMMARY</div>
            </div>
            <div className="heroCard profit">
              <div className="metricLabel">📈 FITIMI I MUAJIT</div>
              <div className="metricValue">{euro(monthProfit)}</div>
              <div className="metricHint">IN − OUT PËR {monthKey}</div>
            </div>
            <div className="heroCard splitStatus">
              <div className="metricLabel">🧮 SPLIT I MUAJIT</div>
              <div className="metricValue small">{monthOwnerSplit > 0 ? 'I KRYER' : 'NË PRITJE'}</div>
              <div className="metricHint">OWNER_PROFIT_SPLIT KËTË MUAJ: {euro(monthOwnerSplit)}</div>
            </div>
          </div>

          <div className="splitSummary">
            <div className="summaryPill"><span>HYRJE TOTALE</span><strong>{euro(summary.total_in)}</strong></div>
            <div className="summaryPill"><span>DALJE TOTALE</span><strong>{euro(summary.total_out)}</strong></div>
            <div className="summaryPill accent"><span>BALANCA LIVE</span><strong>{euro(summary.current_balance)}</strong></div>
          </div>

          <div className="sectionHeader">BALANCA E PRONARËVE</div>
          <div className="ownersGrid">
            {owners.length ? owners.map((owner, idx) => {
              const id = owner.owner_id || owner.id || idx;
              const name = owner.owner_name || owner.name || `OWNER ${idx + 1}`;
              const pct = num(owner.share_percent || owner.percentage);
              const bal = num(owner.current_balance);
              const invested = num(owner.total_invested);
              const repaid = num(owner.total_repaid);
              const profit = num(owner.total_profit_received);
              return (
                <div key={id} className="ownerCard">
                  <div className="ownerTop">
                    <div>
                      <div className="ownerName">{String(name).toUpperCase()}</div>
                      <div className="ownerPct">{pct}%</div>
                    </div>
                    <div className="ownerIcon">👤</div>
                  </div>
                  <div className="ownerBalance">{euro(bal)}</div>
                  <div className="ownerMetaRow"><span>INVESTUAR</span><strong>{euro(invested)}</strong></div>
                  <div className="ownerMetaRow"><span>KTHYER</span><strong>{euro(repaid)}</strong></div>
                  <div className="ownerMetaRow"><span>FITIM</span><strong>{euro(profit)}</strong></div>
                </div>
              );
            }) : (
              <div className="card premiumCard"><div className="muted">S’KA PRONARË AKTIVË.</div></div>
            )}
          </div>

          <div className="twoCols">
            <div className="card premiumCard">
              <div className="cardHeaderLine">
                <div>
                  <div className="cardTitle">SHPENZIM I RI NGA BUXHETI</div>
                  <div className="muted">REGJISTRON OUT NË COMPANY_BUDGET_LEDGER DHE UL COMPANY_BUDGET_SUMMARY.</div>
                </div>
              </div>
              <div className="row compactTop">
                <input className="input" value={expense.amount} onChange={(e) => setExpense((s) => ({ ...s, amount: e.target.value }))} placeholder="SHUMA (€)" inputMode="decimal" />
                <select className="input" value={expense.category} onChange={(e) => setExpense((s) => ({ ...s, category: e.target.value }))}>
                  <option value="RROGA">RROGA</option>
                  <option value="QIRA">QIRA</option>
                  <option value="RRYMA">RRYMA</option>
                  <option value="MATERIALE">MATERIALE</option>
                  <option value="KARBURANT">KARBURANT</option>
                  <option value="TJERA">TJERA</option>
                </select>
              </div>
              <textarea className="input textarea" value={expense.description} onChange={(e) => setExpense((s) => ({ ...s, description: e.target.value }))} placeholder="PËRSHKRIMI I SHPENZIMIT" />
              <button className="primary" disabled={busy === 'expense'} onClick={doExpense}>{busy === 'expense' ? 'DUKE RUAJTUR…' : 'REGJISTRO SHPENZIM'}</button>
            </div>

            <div className="card premiumCard">
              <div className="cardTitle">NDARJA E FITIMIT TE PRONARËT</div>
              <div className="muted">PËRDOR SPLITPROFITTOOWNERS() DHE SHKRUAN NË LEDGER + OWNER_PROFIT_TRANSFERS.</div>
              <input className="input" value={split.amount} onChange={(e) => setSplit((s) => ({ ...s, amount: e.target.value }))} placeholder="SHUMA E FITIMIT (€)" inputMode="decimal" />
              <textarea className="input textarea" value={split.description} onChange={(e) => setSplit((s) => ({ ...s, description: e.target.value }))} placeholder="PËRSHKRIMI" />
              <button className="primary goldAction" disabled={busy === 'split'} onClick={doSplit}>{busy === 'split' ? 'DUKE KRYER…' : 'KRYEJ NDARJEN'}</button>
            </div>
          </div>

          <div className="twoCols historyCols">
            <div className="card premiumCard">
              <div className="cardTitle">INVESTIM I RI I PRONARIT</div>
              <div className="row compactTop">
                <select className="input" value={investmentForm.ownerId} onChange={(e) => setInvestmentForm((s) => ({ ...s, ownerId: e.target.value }))}>
                  {owners.map((owner, idx) => {
                    const id = owner.owner_id || owner.id || idx;
                    const name = owner.owner_name || owner.name || `OWNER ${idx + 1}`;
                    return <option key={id} value={id}>{String(name).toUpperCase()}</option>;
                  })}
                </select>
                <select className="input" value={investmentForm.mode} onChange={(e) => setInvestmentForm((s) => ({ ...s, mode: e.target.value }))}>
                  <option value="INITIAL">INITIAL</option>
                  <option value="ADDITIONAL">ADDITIONAL</option>
                </select>
              </div>
              <input className="input" value={investmentForm.amount} onChange={(e) => setInvestmentForm((s) => ({ ...s, amount: e.target.value }))} placeholder="SHUMA (€)" inputMode="decimal" />
              <textarea className="input textarea" value={investmentForm.description} onChange={(e) => setInvestmentForm((s) => ({ ...s, description: e.target.value }))} placeholder="PËRSHKRIMI I INVESTIMIT" />
              <button className="primary" disabled={busy === 'investment'} onClick={doInvestment}>{busy === 'investment' ? 'DUKE RUAJTUR…' : 'REGJISTRO INVESTIM'}</button>
            </div>

            <div className="card premiumCard">
              <div className="cardTitle">KTHIM I INVESTIMIT</div>
              <div className="muted">PËRDOR REPAYOWNERINVESTMENT() DHE UL BUXHETIN E KOMPANISË.</div>
              <select className="input" value={repayForm.ownerId} onChange={(e) => setRepayForm((s) => ({ ...s, ownerId: e.target.value }))}>
                {owners.map((owner, idx) => {
                  const id = owner.owner_id || owner.id || idx;
                  const name = owner.owner_name || owner.name || `OWNER ${idx + 1}`;
                  return <option key={id} value={id}>{String(name).toUpperCase()}</option>;
                })}
              </select>
              <input className="input" value={repayForm.amount} onChange={(e) => setRepayForm((s) => ({ ...s, amount: e.target.value }))} placeholder="SHUMA (€)" inputMode="decimal" />
              <textarea className="input textarea" value={repayForm.description} onChange={(e) => setRepayForm((s) => ({ ...s, description: e.target.value }))} placeholder="PËRSHKRIMI I KTHIMIT" />
              <button className="primary" disabled={busy === 'repay'} onClick={doRepay}>{busy === 'repay' ? 'DUKE RUAJTUR…' : 'REGJISTRO KTHIM'}</button>
            </div>
          </div>

          <div className="card premiumCard">
            <div className="cardTitle">INVESTIMET E FUNDIT</div>
            {investments.length === 0 ? (
              <div className="muted">S’KA INVESTIME TË REGJISTRUARA.</div>
            ) : (
              <div className="investList">
                {investments.slice(0, 18).map((inv, idx) => {
                  const amount = num(inv.amount || inv.total_amount);
                  const t = String(inv.investment_type || inv.type || 'ADDITIONAL').toUpperCase();
                  const desc = inv.description || inv.note || 'PA PËRSHKRIM';
                  return (
                    <div key={inv.id || idx} className="investItem">
                      <div className="investTop">
                        <div>
                          <div className="investName">{t}</div>
                          <div className="investMeta">{String(desc).toUpperCase()}</div>
                        </div>
                        <div className="investRight">{euro(amount)}</div>
                      </div>
                      <div className="tiny">{inv.created_at ? new Date(inv.created_at).toLocaleString('de-DE') : '—'}</div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="card">
            <div className="cardTitle">HISTORIKU I LEDGER-IT</div>
            {ledger.length === 0 ? (
              <div className="muted">S’KA LËVIZJE.</div>
            ) : (
              <div className="list">
                {ledger.slice(0, 30).map((r) => (
                  <div key={r.id} className="item">
                    <div className="itemTop">
                      <div>
                        <div className="strong">{euro(r.amount)} • {r.direction}</div>
                        <div className="badgeRow">
                          <span className="miniBadge">{String(r.category || 'TJERA').toUpperCase()}</span>
                          {r.month_key ? <span className="miniBadge">{String(r.month_key).toUpperCase()}</span> : null}
                        </div>
                      </div>
                      <div className={r.direction === 'OUT' ? 'pill danger' : 'pill success'}>{r.direction}</div>
                    </div>
                    {r.description ? <div className="muted">{String(r.description).toUpperCase()}</div> : null}
                    {r.created_at ? <div className="tiny">{new Date(r.created_at).toLocaleString('de-DE')}</div> : null}
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      <style jsx>{`
        .pageWrap{max-width:1180px;margin:0 auto;padding:18px 14px 40px;text-transform:uppercase;color:#f2f5f9;}
        .topRow{display:flex;justify-content:space-between;align-items:flex-end;gap:12px;margin-bottom:14px;}
        .topActions{display:flex;gap:10px;flex-wrap:wrap;}
        .title{font-size:34px;letter-spacing:1px;font-weight:950;line-height:1;}
        .sub{opacity:.75;margin-top:6px;font-size:12px;letter-spacing:.12em;font-weight:800;}
        .ghostBtn{height:40px;padding:0 14px;border-radius:12px;border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.06);display:inline-flex;align-items:center;justify-content:center;font-weight:900;letter-spacing:.12em;text-decoration:none;color:#fff;}
        .err,.ok{padding:12px 14px;border-radius:14px;margin-bottom:12px;font-weight:950;letter-spacing:.08em;font-size:11px;}
        .err{border:2px solid rgba(255,80,80,.35);background:rgba(255,0,0,.08);color:#ffd1d1;}
        .ok{border:2px solid rgba(70,220,150,.35);background:rgba(20,140,90,.12);color:#cbffe4;}
        .metricsGrid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-bottom:14px;}
        .heroCard{position:relative;overflow:hidden;border-radius:22px;padding:18px 18px 16px;border:1px solid rgba(255,255,255,.12);background:linear-gradient(180deg,rgba(255,255,255,.08),rgba(255,255,255,.03));box-shadow:0 20px 50px rgba(0,0,0,.26);}
        .metricLabel{font-size:11px;letter-spacing:.18em;font-weight:950;opacity:.85;}
        .metricValue{font-size:40px;line-height:1;margin-top:12px;font-weight:1000;letter-spacing:.03em;}
        .metricValue.small{font-size:28px;}
        .metricHint{margin-top:10px;font-size:10px;opacity:.74;letter-spacing:.14em;font-weight:800;}
        .sectionHeader{margin:18px 2px 10px;font-size:11px;font-weight:950;letter-spacing:.2em;opacity:.72;}
        .ownersGrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-bottom:14px;}
        .ownerCard{border:1px solid rgba(255,255,255,.12);background:linear-gradient(180deg,rgba(18,24,33,.94),rgba(10,12,18,.92));border-radius:20px;padding:16px;box-shadow:0 18px 40px rgba(0,0,0,.22);}
        .ownerTop{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;}
        .ownerName{font-weight:1000;letter-spacing:.16em;font-size:11px;}
        .ownerPct{opacity:.7;font-weight:900;letter-spacing:.16em;font-size:10px;margin-top:4px;}
        .ownerIcon{font-size:22px;opacity:.95;}
        .ownerBalance{font-size:34px;font-weight:1000;line-height:1.05;margin:16px 0 14px;}
        .ownerMetaRow{display:flex;justify-content:space-between;gap:12px;font-size:10px;letter-spacing:.14em;padding:6px 0;opacity:.88;}
        .ownerMetaRow strong{font-size:11px;}
        .twoCols{display:grid;grid-template-columns:1.1fr .9fr;gap:12px;margin-bottom:14px;}
        .historyCols{grid-template-columns:1fr 1fr;}
        .card{border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.04);border-radius:18px;padding:15px 15px 14px;}
        .premiumCard{background:linear-gradient(180deg,rgba(255,255,255,.055),rgba(255,255,255,.028));box-shadow:0 16px 36px rgba(0,0,0,.22);}
        .cardHeaderLine{display:flex;justify-content:space-between;gap:14px;align-items:center;flex-wrap:wrap;}
        .cardTitle{font-weight:950;letter-spacing:.18em;opacity:.85;font-size:10px;margin-bottom:10px;}
        .splitSummary{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin:0 0 14px;}
        .summaryPill{border:1px solid rgba(255,255,255,.12);background:rgba(0,0,0,.28);border-radius:16px;padding:14px;display:flex;flex-direction:column;gap:6px;}
        .summaryPill span{font-size:10px;letter-spacing:.14em;opacity:.7;font-weight:900;}
        .summaryPill strong{font-size:18px;letter-spacing:.04em;}
        .summaryPill.accent{background:rgba(0,140,255,.12);border-color:rgba(0,170,255,.28);}
        .row{display:flex;gap:10px;}
        .compactTop{margin-top:10px;}
        .input{width:100%;background:rgba(0,0,0,.55);border:1px solid rgba(255,255,255,.16);padding:12px;border-radius:12px;font-size:12px;color:#fff;outline:none;letter-spacing:.08em;font-weight:900;}
        .textarea{min-height:90px;resize:vertical;}
        .primary{width:100%;margin-top:10px;padding:12px;border-radius:12px;border:1px solid rgba(0,150,255,.35);background:rgba(0,150,255,.12);color:rgba(190,230,255,.95);font-size:10px;font-weight:950;letter-spacing:.16em;opacity:1;}
        .goldAction{border-color:rgba(255,205,80,.35);background:rgba(255,205,80,.12);color:#ffe7a5;}
        .primary:disabled{opacity:.55;}
        .muted{opacity:.72;padding:6px 0;font-size:10px;letter-spacing:.14em;}
        .investList{display:grid;gap:12px;}
        .investItem{border:1px solid rgba(255,255,255,.10);background:rgba(0,0,0,.28);border-radius:16px;padding:14px;}
        .investTop{display:flex;justify-content:space-between;gap:12px;align-items:flex-start;}
        .investName{font-weight:950;letter-spacing:.12em;font-size:11px;}
        .investMeta{margin-top:6px;opacity:.7;font-size:10px;letter-spacing:.13em;}
        .investRight{font-size:18px;font-weight:1000;letter-spacing:.04em;}
        .list{display:grid;gap:10px;max-height:720px;overflow:auto;padding-right:2px;}
        .item{border:1px solid rgba(255,255,255,.10);background:rgba(0,0,0,.35);border-radius:14px;padding:12px;}
        .itemTop{display:flex;justify-content:space-between;gap:10px;align-items:flex-start;}
        .strong{font-weight:950;letter-spacing:.12em;font-size:11px;}
        .badgeRow{display:flex;gap:6px;flex-wrap:wrap;margin-top:7px;}
        .miniBadge{padding:5px 8px;border-radius:999px;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.05);font-size:9px;letter-spacing:.12em;font-weight:900;}
        .pill{padding:6px 10px;border-radius:999px;font-size:10px;letter-spacing:.12em;font-weight:900;border:1px solid transparent;}
        .pill.success{background:rgba(55,190,120,.14);border-color:rgba(55,190,120,.28);color:#cbffe4;}
        .pill.danger{background:rgba(255,80,80,.12);border-color:rgba(255,80,80,.28);color:#ffd6d6;}
        .tiny{opacity:.62;font-size:10px;letter-spacing:.10em;margin-top:8px;}
        @media (max-width:980px){.metricsGrid,.ownersGrid,.twoCols,.historyCols,.splitSummary{grid-template-columns:1fr;}.metricValue{font-size:32px;}.ownerBalance{font-size:28px;}.topRow{align-items:flex-start;flex-direction:column;}.topActions{width:100%;}.ghostBtn{flex:1;}}
      `}</style>
    </div>
  );
}
