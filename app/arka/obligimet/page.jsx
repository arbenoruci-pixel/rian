'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { getActor } from '@/lib/actorSession';
import { listUserRecords } from '@/lib/usersService';
import { supabase } from '@/lib/supabaseClient';
import { spendFromCompanyBudget, deleteCompanyBudgetEntry } from '@/lib/corporateFinance';
import {
  createCompanyFixedExpense,
  deleteCompanyFixedExpense,
  importLegacyFixedExpenses,
  isMissingRelationError,
  listCompanyFixedExpenses,
  updateCompanyFixedExpense,
} from '@/lib/companyFixedExpensesDb';

const MONTHLY_EXPENSES_KEY = 'ARKA_MONTHLY_FIXED_EXPENSES_V1';
const LEGACY_MIGRATED_KEY = 'ARKA_MONTHLY_FIXED_EXPENSES_DB_MIGRATED_V1';
const MONEY = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const WORKER_ROLES = new Set(['PUNTOR', 'PUNETOR', 'WORKER', 'TRANSPORT']);
const MANAGER_ROLES = new Set(['DISPATCH', 'ADMIN', 'ADMIN_MASTER', 'OWNER', 'PRONAR', 'SUPERADMIN']);
const AUTH_REPAIR_WAIT_MS = 1800;

function euro(v) { return `€${MONEY.format(Number(v || 0) || 0)}`; }
function n(v) { const x = Number(v || 0); return Number.isFinite(x) ? x : 0; }
function safeUpper(v) { return String(v || '').trim().toUpperCase(); }
function parseAmount(v) { return n(String(v ?? '').trim().replace(/\s/g, '').replace(',', '.')); }
function daysLeftInMonth() {
  const now = new Date();
  const last = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  return Math.max(1, last - now.getDate() + 1);
}
function monthStartIso() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
}
function fmtDate(v) {
  if (!v) return '—';
  try { return new Date(v).toLocaleDateString('sq-AL', { day: '2-digit', month: '2-digit' }); } catch { return '—'; }
}
function readFixedExpenses() {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(MONTHLY_EXPENSES_KEY);
    const arr = JSON.parse(raw || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}
function writeFixedExpenses(items) {
  if (typeof window === 'undefined') return;
  localStorage.setItem(MONTHLY_EXPENSES_KEY, JSON.stringify(items || []));
}
function summaryFrom({ users = [], summaryRow = null, fixedExpenses = [], ledger = [] } = {}) {
  const payrollUsers = (users || []).filter((u) => WORKER_ROLES.has(safeUpper(u?.role)) && n(u?.salary) > 0);
  const payrollGross = payrollUsers.reduce((sum, u) => sum + n(u?.salary), 0);
  const payrollDeductions = payrollUsers.reduce((sum, u) => sum + n(u?.avans_manual) + n(u?.borxh_afatgjat), 0);
  const payrollNet = Math.max(0, payrollGross - payrollDeductions);
  const activeFixed = (fixedExpenses || []).filter((x) => x && x.active !== false);
  const fixedTotal = activeFixed.reduce((sum, x) => sum + n(x?.amount), 0);
  const essentialFixed = activeFixed.filter((x) => x.essential !== false).reduce((sum, x) => sum + n(x?.amount), 0);
  const available = n(summaryRow?.current_balance);
  const obligationsTotal = payrollNet + fixedTotal;
  const essentialNeed = payrollNet + essentialFixed;
  const gap = available - obligationsTotal;
  const essentialGap = available - essentialNeed;
  const daysLeft = daysLeftInMonth();
  const targetPerDay = gap < 0 ? Math.abs(gap) / daysLeft : 0;
  const essentialTargetPerDay = essentialGap < 0 ? Math.abs(essentialGap) / daysLeft : 0;
  const monthIn = (ledger || []).filter((x) => safeUpper(x?.direction) === 'IN').reduce((sum, x) => sum + n(x?.amount), 0);
  const monthOut = (ledger || []).filter((x) => safeUpper(x?.direction) === 'OUT').reduce((sum, x) => sum + n(x?.amount), 0);
  return { payrollUsers, payrollGross, payrollDeductions, payrollNet, fixedTotal, essentialFixed, available, obligationsTotal, essentialNeed, gap, essentialGap, daysLeft, targetPerDay, essentialTargetPerDay, monthIn, monthOut };
}

function Mini({ label, value, tone = 'neutral' }) {
  return (
    <div className={`arkaMiniStat ${tone}`}>
      <div className="arkaMiniStatLabel">{label}</div>
      <div className="arkaMiniStatValue">{value}</div>
    </div>
  );
}

export default function ArkaObligimetPage() {
  const router = useRouter();
  const [actor, setActor] = useState(null);
  const [loading, setLoading] = useState(true);
  const [staff, setStaff] = useState([]);
  const [summaryRow, setSummaryRow] = useState(null);
  const [ledger, setLedger] = useState([]);
  const [fixedExpenses, setFixedExpenses] = useState([]);
  const [title, setTitle] = useState('');
  const [amount, setAmount] = useState('');
  const [dueDay, setDueDay] = useState('');
  const [essential, setEssential] = useState(true);
  const [budgetTitle, setBudgetTitle] = useState('');
  const [budgetAmount, setBudgetAmount] = useState('');
  const [budgetCategory, setBudgetCategory] = useState('SHPENZIM');
  const [budgetBusy, setBudgetBusy] = useState(false);
  const [usingDb, setUsingDb] = useState(false);
  const [dbMissing, setDbMissing] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const boot = () => {
      const a = getActor() || null;
      if (!a?.pin) return false;
      if (!MANAGER_ROLES.has(safeUpper(a?.role))) {
        router.replace('/arka');
        return true;
      }
      setActor(a);
      return true;
    };

    if (boot()) return undefined;

    const timer = window.setTimeout(() => {
      if (cancelled) return;
      if (boot()) return;
      router.replace('/arka');
    }, AUTH_REPAIR_WAIT_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [router]);

  async function loadFixedExpenses(currentActor) {
    try {
      const dbItems = await listCompanyFixedExpenses({ includeInactive: true });
      setUsingDb(true);
      setDbMissing(false);
      if (typeof window !== 'undefined') {
        const legacy = readFixedExpenses();
        const migrated = localStorage.getItem(LEGACY_MIGRATED_KEY) === '1';
        if (!dbItems.length && legacy.length && !migrated) {
          try {
            const imported = await importLegacyFixedExpenses({ actor: currentActor, items: legacy });
            if (imported.length) {
              localStorage.setItem(LEGACY_MIGRATED_KEY, '1');
              return imported;
            }
          } catch {}
        }
      }
      return dbItems;
    } catch (e) {
      if (isMissingRelationError(e)) {
        setDbMissing(true);
        setUsingDb(false);
        return readFixedExpenses();
      }
      throw e;
    }
  }

  async function reload() {
    setLoading(true);
    try {
      const [users, summaryRes, ledgerRes, fixed] = await Promise.all([
        listUserRecords({ orderBy: 'name', ascending: true }).catch(() => []),
        supabase.from('company_budget_summary').select('id,current_balance,total_in,total_out').eq('id', 1).maybeSingle(),
        supabase.from('company_budget_ledger').select('id,direction,amount,category,description,created_at').gte('created_at', monthStartIso()).order('created_at', { ascending: false }).limit(240),
        loadFixedExpenses(actor),
      ]);
      setStaff(Array.isArray(users) ? users : []);
      setSummaryRow(summaryRes?.data || null);
      setLedger(Array.isArray(ledgerRes?.data) ? ledgerRes.data : []);
      setFixedExpenses(Array.isArray(fixed) ? fixed : []);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!actor?.pin) return;
    let alive = true;
    const t = setTimeout(() => { if (alive) void reload(); }, 120);
    const onStorage = (e) => {
      if (!e?.key || e.key === MONTHLY_EXPENSES_KEY) {
        if (!usingDb) setFixedExpenses(readFixedExpenses());
      }
    };
    window.addEventListener('storage', onStorage);
    return () => { alive = false; clearTimeout(t); window.removeEventListener('storage', onStorage); };
  }, [actor?.pin, usingDb]);

  const summary = useMemo(() => summaryFrom({ users: staff, summaryRow, fixedExpenses, ledger }), [staff, summaryRow, fixedExpenses, ledger]);
  const dueSoon = useMemo(() => (fixedExpenses || []).filter((x) => x && x.active !== false).sort((a, b) => n(a?.dueDay) - n(b?.dueDay)), [fixedExpenses]);

  async function addExpense() {
    const cleanTitle = String(title || '').trim().toUpperCase();
    const cleanAmount = parseAmount(amount);
    const cleanDay = Math.max(1, Math.min(31, n(dueDay) || 1));
    if (!cleanTitle || cleanAmount <= 0) return alert('SHKRUAJ EMRIN DHE SHUMËN.');
    try {
      setBudgetBusy(true);
      if (usingDb) {
        await createCompanyFixedExpense({ actor, title: cleanTitle, amount: cleanAmount, dueDay: cleanDay, essential, active: true });
        await reload();
      } else {
        const next = [{ id: `fx_${Date.now()}`, title: cleanTitle, amount: cleanAmount, dueDay: cleanDay, essential, active: true }, ...fixedExpenses];
        setFixedExpenses(next);
        writeFixedExpenses(next);
      }
      setTitle(''); setAmount(''); setDueDay(''); setEssential(true);
    } catch (e) {
      alert(`🔴 ${e?.message || 'NUK U SHTUA SHPENZIMI.'}`);
    } finally {
      setBudgetBusy(false);
    }
  }
  async function toggleActive(id) {
    if (usingDb) {
      const row = fixedExpenses.find((x) => x.id === id);
      if (!row) return;
      await updateCompanyFixedExpense(id, { active: row.active === false });
      await reload();
      return;
    }
    const next = fixedExpenses.map((x) => x.id === id ? { ...x, active: x.active === false ? true : false } : x);
    setFixedExpenses(next); writeFixedExpenses(next);
  }
  async function toggleEssential(id) {
    if (usingDb) {
      const row = fixedExpenses.find((x) => x.id === id);
      if (!row) return;
      await updateCompanyFixedExpense(id, { essential: row.essential === false });
      await reload();
      return;
    }
    const next = fixedExpenses.map((x) => x.id === id ? { ...x, essential: x.essential === false ? true : false } : x);
    setFixedExpenses(next); writeFixedExpenses(next);
  }
  async function removeExpense(id) {
    if (usingDb) {
      await deleteCompanyFixedExpense(id);
      await reload();
      return;
    }
    const next = fixedExpenses.filter((x) => x.id !== id);
    setFixedExpenses(next); writeFixedExpenses(next);
  }

  async function addBudgetExpense() {
    const cleanTitle = String(budgetTitle || '').trim().toUpperCase();
    const cleanAmount = parseAmount(budgetAmount);
    if (!cleanTitle || cleanAmount <= 0) return alert('SHKRUAJ SHPENZIMIN DHE SHUMËN.');
    try {
      setBudgetBusy(true);
      await spendFromCompanyBudget({ actor, amount: cleanAmount, category: budgetCategory || 'SHPENZIM', description: cleanTitle });
      setBudgetTitle(''); setBudgetAmount(''); setBudgetCategory('SHPENZIM');
      await reload();
      alert('✅ SHPENZIMI U SHTUA NË BUXHET.');
    } catch (e) {
      alert(`🔴 ${e?.message || 'NUK U SHTUA SHPENZIMI.'}`);
    } finally {
      setBudgetBusy(false);
    }
  }

  async function removeBudgetEntry(row) {
    if (!row?.id) return;
    const ok = window.confirm(`A DON ME E FSHI KËTË HYRJE ${euro(row?.amount)}?`);
    if (!ok) return;
    try {
      setBudgetBusy(true);
      await deleteCompanyBudgetEntry({ entryId: row.id });
      await reload();
      alert('✅ HYRJA U FSHI NGA BUXHETI.');
    } catch (e) {
      alert(`🔴 ${e?.message || 'NUK U FSHI HYRJA.'}`);
    } finally {
      setBudgetBusy(false);
    }
  }

  return (
    <div className="arkaSimplePage">
      <div className="arkaSimpleTop">
        <div>
          <div className="arkaSimpleEyebrow">ARKA • OBLIGIMET</div>
          <h1 className="arkaSimpleTitle">OBLIGIMET E MUAJIT</h1>
          <div className="arkaSimpleSub">SHIH SA KUSHTON PAYROLL-I, CILAT JANË SHPENZIMET FIKSE, SA CASH KEMI NË KOMPANI DHE SA NA MUNGOJNË PËR SHPENZIMET E DOMOSDOSHME.</div>
          <div className="arkaSimpleSub" style={{ marginTop: 8 }}>
            {usingDb ? 'OBLIGIMET PO LEXOHEN NGA DB.' : 'OBLIGIMET PO LEXOHEN NGA KJO PAJISJE.'}
            {dbMissing ? ' — RUN SQL PATCH-IN QË TË KALOHEN NË DB.' : ''}
          </div>
        </div>
        <div className="arkaSimpleNav">
          <Link prefetch={false} href="/arka" className="arkaTopBtn">ARKA</Link>
          <Link prefetch={false} href="/arka/payroll" className="arkaTopBtn">PAYROLL</Link>
        </div>
      </div>

      {loading ? <div className="arkaLoaderCard">PO NGARKOHEN OBLIGIMET...</div> : null}

      {!loading ? (
        <>
          <div className="arkaWorkerStats adminObligationGrid obligationTopGrid">
            <Mini label="PAYROLL NETO" value={euro(summary.payrollNet)} tone="info" />
            <Mini label="SHPENZIME FIKSE" value={euro(summary.fixedTotal)} tone="warn" />
            <Mini label="BUXHETI AKTUAL" value={euro(summary.available)} tone="ok" />
            <Mini label={summary.gap >= 0 ? 'TEPRICË' : 'MUNGOJNË'} value={euro(Math.abs(summary.gap))} tone={summary.gap >= 0 ? 'ok' : 'strong'} />
            <Mini label="TARGET / DITË" value={euro(summary.targetPerDay)} tone="neutral" />
          </div>

          <div className="arkaSplitGrid detailPage">
            <section className="arkaSectionCard">
              <div className="arkaSectionTitle">PËRMBLEDHJA</div>
              <div className="arkaSectionSub">PAMJA E SHPEJTË E MUAJIT</div>
              <div className="arkaWorkerStats adminObligationGrid">
                <Mini label="PAYROLL BRUTO" value={euro(summary.payrollGross)} tone="neutral" />
                <Mini label="ZBRITJE PAYROLL" value={euro(summary.payrollDeductions)} tone="muted" />
                <Mini label="OBLIGIME TOTALE" value={euro(summary.obligationsTotal)} tone="strong" />
                <Mini label="DOMOSDOSHME" value={euro(summary.essentialNeed)} tone="warn" />
                <Mini label="DITË TË MBETURA" value={String(summary.daysLeft)} tone="neutral" />
                <Mini label="TARGET DOMOSDOSHME" value={euro(summary.essentialTargetPerDay)} tone="info" />
              </div>

              <div className="arkaSectionDivider" />
              <div className="arkaSectionTitle">SHTO SHPENZIM MUJOR</div>
              <div className="arkaInlineForm obligationForm">
                <input className="arkaField" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="P.SH. QIRAA" />
                <input className="arkaField small" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="600" />
                <input className="arkaField small" inputMode="numeric" value={dueDay} onChange={(e) => setDueDay(e.target.value)} placeholder="DATA 5" />
                <label className="arkaCheckRow"><input type="checkbox" checked={essential} onChange={(e) => setEssential(e.target.checked)} /> DOMOSDOSHËM</label>
                <button type="button" className="arkaSolidBtn" disabled={budgetBusy} onClick={addExpense}>+ SHTO</button>
              </div>
              <div className="arkaWorkerFoot muted"><span>{usingDb ? 'RUHET NË DB.' : 'RUHET PËRKOHËSISHT NË KËTË PAJISJE.'}</span><span>{usingDb ? 'DEL NJËSOJ NË TË GJITHA PAJISJET.' : 'RUN SQL PATCH-IN PËR STABILITET NË DB.'}</span></div>
            </section>

            <section className="arkaSectionCard sideRail">
              <div className="arkaSectionTitle">SHPENZIME FIKSE</div>
              <div className="arkaSectionSub">QIRA, RRYMË, INTERNET, CHASSIS, ETJ.</div>
              {dueSoon.length ? dueSoon.map((row) => (
                <div className="arkaHistoryRow" key={row.id}>
                  <div>
                    <div className="arkaHistoryTitle">{String(row.title || 'SHPENZIM').toUpperCase()}</div>
                    <div className="arkaHistoryMeta">DATA {row.dueDay || '—'} • {row.essential !== false ? 'DOMOSDOSHËM' : 'JO URGJENT'} • {row.active === false ? 'JOAKTIV' : 'AKTIV'}</div>
                  </div>
                  <div className="arkaPendingRight">
                    <div className="arkaHistoryAmount">{euro(row.amount)}</div>
                    <div className="arkaPendingActions">
                      <button type="button" className="arkaTinyBtn" onClick={() => toggleEssential(row.id)}>{row.essential !== false ? 'HIQ DOMOSD.' : 'BËJE DOMOSD.'}</button>
                      <button type="button" className="arkaTinyBtn" onClick={() => toggleActive(row.id)}>{row.active === false ? 'AKTIVO' : 'PAUZO'}</button>
                      <button type="button" className="arkaTinyBtn bad" onClick={() => removeExpense(row.id)}>FSHIJ</button>
                    </div>
                  </div>
                </div>
              )) : <div className="arkaEmpty">S’KA SHPENZIME FIKSE AKOMA.</div>}
            </section>
          </div>

          <div className="arkaSplitGrid detailPage">
            <section className="arkaSectionCard">
              <div className="arkaSectionTitle">PAYROLL</div>
              <div className="arkaSectionSub">KJO LEXOHET DIREKT NGA STAFI / PAYROLL-I</div>
              {(summary.payrollUsers || []).length ? summary.payrollUsers.map((u) => (
                <div className="arkaHistoryRow" key={u.id || u.pin || u.name}>
                  <div>
                    <div className="arkaHistoryTitle">{String(u.name || 'PUNTOR').toUpperCase()}</div>
                    <div className="arkaHistoryMeta">DITA {u.salary_day || '—'} • ZBRITJE {euro(n(u.avans_manual) + n(u.borxh_afatgjat))}</div>
                  </div>
                  <div className="arkaHistoryAmount">{euro(u.salary)}</div>
                </div>
              )) : <div className="arkaEmpty">S’KA PAGA TË KONFIGURUARA.</div>}
            </section>

            <section className="arkaSectionCard sideRail">
              <div className="arkaSectionTitle">PARA TË MBLEDHURA KËTË MUAJ</div>
              <div className="arkaSectionSub">LLOGARITET NGA COMPANY LEDGER + BALANCI AKTUAL</div>
              <div className="arkaWorkerStats adminObligationGrid">
                <Mini label="BALANCI AKTUAL" value={euro(summary.available)} tone="ok" />
                <Mini label="HYRJE MUAJORE" value={euro(summary.monthIn)} tone="info" />
                <Mini label="DALJE MUAJORE" value={euro(summary.monthOut)} tone="warn" />
              </div>
              <div className="arkaSectionDivider" />
              <div className="arkaSectionTitle">SHTO SHPENZIM TË KOMPANISË</div>
              <div className="arkaInlineForm obligationForm">
                <input className="arkaField" value={budgetTitle} onChange={(e) => setBudgetTitle(e.target.value)} placeholder="P.SH. NAFTË, QIRAA, SERVIS" />
                <input className="arkaField small" inputMode="decimal" value={budgetAmount} onChange={(e) => setBudgetAmount(e.target.value)} placeholder="50" />
                <input className="arkaField small" value={budgetCategory} onChange={(e) => setBudgetCategory(e.target.value)} placeholder="SHPENZIM" />
                <button type="button" className="arkaSolidBtn" disabled={budgetBusy} onClick={addBudgetExpense}>+ SHTO</button>
              </div>
              <div className="arkaSectionDivider" />
              {(ledger || []).length ? ledger.slice(0, 12).map((row) => (
                <div className="arkaHistoryRow" key={row.id}>
                  <div>
                    <div className="arkaHistoryTitle">{safeUpper(row?.description || row?.category || 'LËVIZJE')}</div>
                    <div className="arkaHistoryMeta">{safeUpper(row?.direction || '—')} • {fmtDate(row?.created_at)}</div>
                  </div>
                  <div className="arkaPendingRight">
                    <div className="arkaHistoryAmount">{euro(row?.amount)}</div>
                    <button type="button" className="arkaTinyBtn bad" disabled={budgetBusy} onClick={() => removeBudgetEntry(row)}>FSHIJ</button>
                  </div>
                </div>
              )) : <div className="arkaEmpty">S’KA LËVIZJE NË LEDGER.</div>}
            </section>
          </div>
        </>
      ) : null}
    </div>
  );
}
