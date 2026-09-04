'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from '@/lib/routerCompat.jsx';
import { supabase } from '@/lib/supabaseClient';
import WorkerCompensationEditor from '@/components/WorkerCompensationEditor';
import { createWorkerAdvance, resolveWorkerExpense } from '@/lib/arka/workerControlClient';

// STAFF_PAYROLL_PRO_V3: one clear worker card for payroll, advances, approvals and history.

const MONEY = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const MANAGER_ROLES = new Set([
  'ADMIN', 'ADMIN_MASTER', 'OWNER', 'PRONAR', 'SUPERADMIN',
  'MASTER', 'MASTER USER', 'MASTER_USER', 'MASTERUSER',
]);
const OPEN_EXPENSE_STATUSES = ['PENDING', 'COLLECTED', 'PENDING_DISPATCH_APPROVAL'];

function n(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}
function euro(value) { return `${MONEY.format(n(value))} €`; }
function upper(value) { return String(value || '').trim().toUpperCase(); }
function clean(value) { return String(value || '').trim(); }
function rows(value) { return Array.isArray(value) ? value : []; }
function dateKey(value = new Date()) {
  const d = value instanceof Date ? value : new Date(value || Date.now());
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function monthKey(value = new Date()) { return dateKey(value).slice(0, 7); }
function sixMonthsAgo() {
  const d = new Date();
  d.setMonth(d.getMonth() - 5, 1);
  return dateKey(d);
}
function stamp(value) {
  if (!value) return '—';
  try {
    return new Intl.DateTimeFormat('sq-AL', {
      timeZone: 'Europe/Belgrade', day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(value));
  } catch { return '—'; }
}
function isManager(actor = {}) {
  const role = upper(actor?.role);
  return actor?.is_master === true || MANAGER_ROLES.has(role);
}
function eventLabel(type) {
  const labels = {
    SALARY_EARNED: 'RROGË E FITUAR',
    SALARY_EARNED_ESTIMATED: 'RROGË E RINDËRTUAR',
    SALARY_PAID: 'RROGË E PAGUAR',
    ADVANCE_RECEIVED: 'AVANS I MARRË',
    COMMISSION_EARNED: 'KOMISION I FITUAR',
    COMMISSION_RECEIVED: 'KOMISION I MBAJTUR',
    READY_BONUS_EARNED: 'BONUS GATI I FITUAR',
    READY_BONUS_RECEIVED: 'BONUS GATI I MARRË',
    MEAL_EARNED: 'USHQIM I APROVUAR',
    MEAL_RECEIVED: 'USHQIM I MARRË',
    BUSINESS_EXPENSE_HANDLED: 'SHPENZIM BIZNESI',
    WORK_BASE_READY_M2: 'PUNË NË BAZË',
    WORK_TRANSPORT_M2: 'PUNË NË TRANSPORT',
    COMPENSATION_PROFILE_CHANGED: 'KUSHTET U NDRYSHUAN',
  };
  return labels[upper(type)] || upper(type || 'VEPRIM').replaceAll('_', ' ');
}
function toneForEvent(row = {}) {
  const family = upper(row?.event_family);
  if (family === 'EARNING') return 'green';
  if (family === 'PAYMENT') return 'blue';
  if (family === 'EXPENSE') return 'orange';
  if (family === 'WORK') return 'purple';
  return 'slate';
}
function parseAmountInput(value) {
  const parsed = Number(String(value ?? '').trim().replace(/\s+/g, '').replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : 0;
}

function Metric({ label, value, sub = '', tone = 'slate' }) {
  return (
    <div className={`wccMetric ${tone}`}>
      <div className="wccMetricLabel">{label}</div>
      <div className="wccMetricValue">{value}</div>
      {sub ? <div className="wccMetricSub">{sub}</div> : null}
    </div>
  );
}

function Empty({ children }) {
  return <div className="wccEmpty">{children}</div>;
}

export default function WorkerControlCenter({ actor, targetPin, worker: workerProp = null }) {
  const cleanPin = clean(targetPin || workerProp?.pin);
  const manager = isManager(actor);
  const seqRef = useRef(0);
  const [tab, setTab] = useState('OVERVIEW');
  const [finance, setFinance] = useState(null);
  const [history, setHistory] = useState(null);
  const [activeAdvances, setActiveAdvances] = useState([]);
  const [pendingExpenses, setPendingExpenses] = useState([]);
  const [budget, setBudget] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [advanceOpen, setAdvanceOpen] = useState(false);
  const [advanceAmount, setAdvanceAmount] = useState('');
  const [advanceNote, setAdvanceNote] = useState('AVANS');
  const [advanceBusy, setAdvanceBusy] = useState(false);
  const [decisionBusyId, setDecisionBusyId] = useState(null);
  const [showCompensation, setShowCompensation] = useState(false);

  async function load({ silent = false } = {}) {
    if (!cleanPin || !actor?.pin) return;
    const seq = ++seqRef.current;
    if (silent) setRefreshing(true); else setLoading(true);
    setError('');
    try {
      const historyFrom = sixMonthsAgo();
      const historyTo = dateKey(new Date());
      const tasks = [
        supabase.rpc('get_worker_finance_snapshot_v1', {
          p_actor_pin: String(actor.pin), p_worker_pin: cleanPin, p_date: historyTo,
        }),
        supabase.rpc('get_worker_history_card_v1', {
          p_actor_pin: String(actor.pin), p_worker_pin: cleanPin,
          p_from_date: historyFrom, p_to_date: historyTo, p_limit: 200, p_offset: 0,
        }),
        supabase.from('arka_pending_payments')
          .select('id,amount,type,status,note,created_at,updated_at,approved_by_pin,approved_by_name,source_module')
          .eq('created_by_pin', cleanPin)
          .eq('type', 'ADVANCE')
          .eq('status', 'ADVANCE')
          .order('created_at', { ascending: false })
          .limit(100),
        supabase.from('arka_pending_payments')
          .select('id,amount,type,status,note,created_at,updated_at,source_module')
          .eq('created_by_pin', cleanPin)
          .eq('type', 'EXPENSE')
          .in('status', OPEN_EXPENSE_STATUSES)
          .order('created_at', { ascending: false })
          .limit(100),
      ];
      if (manager) {
        tasks.push(supabase.from('company_budget_summary').select('current_balance,total_in,total_out,updated_at').eq('id', 1).maybeSingle());
      }

      const results = await Promise.all(tasks);
      if (seq !== seqRef.current) return;
      const [financeRes, historyRes, advancesRes, expensesRes, budgetRes] = results;
      if (financeRes?.error) throw financeRes.error;
      if (historyRes?.error) throw historyRes.error;
      if (advancesRes?.error) throw advancesRes.error;
      if (expensesRes?.error) throw expensesRes.error;
      if (manager && budgetRes?.error) throw budgetRes.error;

      setFinance(financeRes?.data || null);
      setHistory(historyRes?.data || null);
      setActiveAdvances(rows(advancesRes?.data));
      setPendingExpenses(rows(expensesRes?.data));
      setBudget(manager ? (budgetRes?.data || null) : null);
    } catch (err) {
      if (seq !== seqRef.current) return;
      setError(String(err?.message || err?.details || err || 'NUK U NGARKUA KARTELA E PUNTORIT.'));
    } finally {
      if (seq === seqRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }

  useEffect(() => {
    void load();
  }, [cleanPin, actor?.pin]);

  useEffect(() => {
    if (!manager || typeof window === 'undefined') return;
    try {
      if (new URLSearchParams(window.location.search).get('action') === 'advance') {
        setAdvanceOpen(true);
      }
    } catch {}
  }, [manager, cleanPin]);

  const profile = finance?.profile || {};
  const financeWorker = finance?.worker || {};
  const cash = finance?.cash || {};
  const payroll = finance?.payroll || {};
  const advances = finance?.advances || {};
  const currentMonth = useMemo(() => {
    const key = monthKey(new Date());
    return rows(history?.months).find((row) => String(row?.month_key || '') === key) || {};
  }, [history?.months]);
  const timeline = rows(history?.timeline);
  const activeAdvanceTotal = activeAdvances.reduce((sum, row) => sum + n(row?.amount), 0);
  const pendingExpenseTotal = pendingExpenses.reduce((sum, row) => sum + n(row?.amount), 0);
  const worker = useMemo(() => ({
    ...(workerProp || {}),
    ...(financeWorker || {}),
    pin: cleanPin,
    name: financeWorker?.name || workerProp?.name || cleanPin,
    role: financeWorker?.role || workerProp?.role || 'PUNTOR',
    salary: n(profile?.salary_amount),
    salary_day: profile?.salary_day || null,
    pay_salary_enabled: profile?.salary_enabled === true,
    pay_meal_enabled: profile?.meal_enabled === true,
    pay_meal_amount: n(profile?.meal_amount),
    pay_commission_enabled: profile?.commission_enabled === true,
    pay_commission_rate_m2: n(profile?.commission_rate_m2),
    pay_transport_bonus_enabled: profile?.transport_bonus_enabled === true,
    pay_transport_bonus_amount: n(profile?.transport_bonus_amount),
    pay_ready_bonus_enabled: profile?.ready_bonus_enabled === true,
    pay_cash_mode: profile?.cash_mode || 'FULL_CASH',
    pay_notes: profile?.notes || '',
  }), [workerProp, financeWorker, profile, cleanPin]);

  const advanceValue = parseAmountInput(advanceAmount);
  const budgetAfterAdvance = budget ? n(budget.current_balance) - advanceValue : null;

  async function submitAdvance() {
    if (!manager || advanceBusy) return;
    if (!(advanceValue > 0)) {
      setError('SHKRUAJ SHUMËN E AVANSIT.');
      return;
    }
    if (budget && budgetAfterAdvance < 0) {
      setError('BUXHETI I KOMPANISË NUK MJAFTON PËR KËTË AVANS.');
      return;
    }
    const ok = window.confirm(
      `Konfirmo avansin për ${upper(worker?.name)}\n\n` +
      `Shuma: ${euro(advanceValue)}\n` +
      `${budget ? `Buxheti para: ${euro(budget.current_balance)}\nBuxheti pas: ${euro(budgetAfterAdvance)}\n` : ''}` +
      `Shënimi: ${clean(advanceNote) || 'AVANS'}`
    );
    if (!ok) return;

    setAdvanceBusy(true);
    setError('');
    try {
      const result = await createWorkerAdvance({
        workerPin: cleanPin,
        amount: advanceValue,
        note: clean(advanceNote) || 'AVANS',
      });
      if (result?.ok === false) throw new Error(result?.error || 'AVANSI NUK U REGJISTRUA.');
      setAdvanceOpen(false);
      setAdvanceAmount('');
      setAdvanceNote('AVANS');
      await load({ silent: true });
      try { window.dispatchEvent(new Event('arka:refresh')); } catch {}
    } catch (err) {
      setError(String(err?.message || err || 'AVANSI NUK U REGJISTRUA.'));
    } finally {
      setAdvanceBusy(false);
    }
  }

  async function decideExpense(row, resolution) {
    if (!manager || !row?.id || decisionBusyId) return;
    const label = resolution === 'BUSINESS_EXPENSE'
      ? 'APROVO SI SHPENZIM BIZNESI'
      : resolution === 'PERSONAL_ADVANCE'
        ? 'KTHEJE NË AVANS PERSONAL'
        : 'REFUZO KËRKESËN';
    const budgetImpact = resolution === 'REJECTED_OPEN_CASH' ? 0 : n(row.amount);
    const ok = window.confirm(
      `${label}\n\n${upper(worker?.name)} • ${euro(row.amount)}\n` +
      `${budget && budgetImpact > 0 ? `Buxheti pas veprimit: ${euro(n(budget.current_balance) - budgetImpact)}\n` : ''}` +
      `${clean(row.note) || 'PA SHËNIM'}`
    );
    if (!ok) return;

    setDecisionBusyId(row.id);
    setError('');
    try {
      await resolveWorkerExpense({
        expensePaymentId: row.id,
        resolution,
        beneficiaryPin: resolution === 'PERSONAL_ADVANCE' ? cleanPin : null,
        beneficiaryName: resolution === 'PERSONAL_ADVANCE' ? worker?.name : null,
        note: `KARTELA E PUNTORIT • ${label}`,
      });
      await load({ silent: true });
      try { window.dispatchEvent(new Event('arka:refresh')); } catch {}
    } catch (err) {
      setError(String(err?.message || err || 'VENDIMI NUK U RUAJT.'));
    } finally {
      setDecisionBusyId(null);
    }
  }

  if (loading && !finance) {
    return <div className="wccLoading">DUKE NGARKUAR KARTELËN E PUNTORIT…</div>;
  }

  return (
    <section className="wccRoot" data-worker-control-center="STAFF_PAYROLL_PRO_V3">
      <header className="wccHeader">
        <div>
          <div className="wccEyebrow">KARTELA E PUNTORIT</div>
          <h1>{upper(worker?.name || cleanPin)}</h1>
          <div className="wccMeta">PIN {cleanPin} • {upper(worker?.role || 'PUNTOR')} • {worker?.active === false || worker?.is_active === false ? 'JOAKTIV' : 'AKTIV'}</div>
        </div>
        <div className="wccHeaderActions">
          <button type="button" className="wccGhost" disabled={refreshing} onClick={() => void load({ silent: true })}>{refreshing ? 'DUKE FRESKUAR…' : 'REFRESH'}</button>
          {manager ? <button type="button" className="wccPrimary" onClick={() => setAdvanceOpen(true)}>+ JEP AVANS</button> : null}
        </div>
      </header>

      <div className="wccProfileStrip">
        <span>RROGË: <b>{profile?.salary_enabled ? euro(profile?.salary_amount) : 'JO'}</b></span>
        <span>KOMISION: <b>{profile?.commission_enabled ? `${n(profile?.commission_rate_m2).toFixed(2)} €/m²` : 'JO'}</b></span>
        <span>USHQIM: <b>{profile?.meal_enabled ? euro(profile?.meal_amount) : 'JO'}</b></span>
        <span>CASH: <b>{upper(profile?.cash_mode || 'FULL_CASH')}</b></span>
      </div>

      {error ? <div className="wccError">{error}</div> : null}

      <nav className="wccTabs">
        {[
          ['OVERVIEW', 'PËRMBLEDHJE'],
          ['ADVANCES', `AVANSE${activeAdvances.length ? ` • ${activeAdvances.length}` : ''}`],
          ['APPROVALS', `APROVIME${pendingExpenses.length ? ` • ${pendingExpenses.length}` : ''}`],
          ['HISTORY', 'HISTORIA'],
          ...(manager ? [['SETTINGS', 'KUSHTET']] : []),
        ].map(([key, label]) => (
          <button type="button" key={key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>{label}</button>
        ))}
      </nav>

      {tab === 'OVERVIEW' ? (
        <div className="wccStack">
          <div className="wccMetrics">
            <Metric label="RROGË FIKSE PAS AVANSEVE" value={euro(payroll?.net_fixed_after_advances)} sub={`${euro(payroll?.gross_fixed)} fikse − ${euro(activeAdvanceTotal)} avanse`} tone="green" />
            <Metric label="AVANSE AKTIVE" value={euro(activeAdvanceTotal)} sub={`${activeAdvances.length} rreshta aktivë`} tone={activeAdvanceTotal > 0 ? 'orange' : 'slate'} />
            <Metric label="CASH PËR DORËZIM" value={euro(cash?.open_due_to_base)} sub={`${n(cash?.open_count)} pagesa të hapura`} tone={n(cash?.open_due_to_base) > 0 ? 'blue' : 'slate'} />
            <Metric label="KOMISION KËTË MUAJ" value={euro(currentMonth?.commission_earned)} sub={`Marrë ${euro(currentMonth?.commission_received)}`} tone="purple" />
            <Metric label="BONUS GATI KËTË MUAJ" value={euro(currentMonth?.ready_bonus_earned)} sub={`Marrë ${euro(currentMonth?.ready_bonus_received)}`} tone="green" />
            <Metric label="KËRKESA NË PRITJE" value={euro(pendingExpenseTotal)} sub={`${pendingExpenses.length} kërkesa`} tone={pendingExpenses.length ? 'orange' : 'slate'} />
          </div>

          <div className="wccTwoCol">
            <div className="wccPanel">
              <div className="wccPanelTitle">PUNA KËTË MUAJ</div>
              <div className="wccWorkGrid">
                <Metric label="BAZA" value={`${n(currentMonth?.base_m2).toFixed(2)} m²`} tone="green" />
                <Metric label="TRANSPORTI" value={`${n(currentMonth?.transport_m2).toFixed(2)} m²`} tone="blue" />
                <Metric label="TOTAL I FITUAR" value={euro(currentMonth?.total_earned)} tone="purple" />
                <Metric label="TOTAL I MARRË" value={euro(currentMonth?.total_received)} tone="orange" />
              </div>
            </div>

            <div className="wccPanel">
              <div className="wccPanelTitle">ÇKA KËRKON VEPRIM</div>
              <div className="wccActionList">
                <button type="button" onClick={() => setTab('ADVANCES')}><span>Avanse aktive</span><b>{euro(activeAdvanceTotal)}</b></button>
                <button type="button" onClick={() => setTab('APPROVALS')}><span>Kërkesa për aprovim</span><b>{pendingExpenses.length}</b></button>
                <button type="button" onClick={() => setTab('HISTORY')}><span>Historia e fundit</span><b>{timeline.length}</b></button>
              </div>
            </div>
          </div>

          {manager ? (
            <div className="wccManagerBar">
              <button type="button" onClick={() => setAdvanceOpen(true)}>+ JEP AVANS</button>
              <button type="button" onClick={() => setTab('APPROVALS')}>APROVIMET</button>
              <button type="button" onClick={() => setTab('SETTINGS')}>EDITO KUSHTET</button>
              <Link href="/arka/payroll" prefetch={false}>HAP PAYROLL</Link>
              <Link href="/arka/stafi" prefetch={false}>HAP STAFIN</Link>
            </div>
          ) : null}
        </div>
      ) : null}

      {tab === 'ADVANCES' ? (
        <div className="wccPanel">
          <div className="wccPanelHead">
            <div><div className="wccPanelTitle">AVANSET AKTIVE</div><div className="wccPanelSub">Vetëm rreshtat type=ADVANCE dhe status=ADVANCE. Shpenzimet e refuzuara nuk hyjnë këtu.</div></div>
            <strong>{euro(activeAdvanceTotal)}</strong>
          </div>
          {manager ? <button type="button" className="wccPrimary wccFull" onClick={() => setAdvanceOpen(true)}>+ REGJISTRO AVANS TË RI</button> : null}
          <div className="wccRows">
            {activeAdvances.length ? activeAdvances.map((row) => (
              <div className="wccRow" key={row.id}>
                <div><b>AVANS #{row.id}</b><small>{stamp(row.created_at)} • {clean(row.note) || 'AVANS'}</small></div>
                <strong className="orange">{euro(row.amount)}</strong>
              </div>
            )) : <Empty>S’KA AVANSE AKTIVE.</Empty>}
          </div>
          <div className="wccInfo">Avansi aktiv zbritet nga rroga vetëm një herë. Kur mbyllet në payroll, statusi kalon në SETTLED_IN_SALARY dhe mbetet në histori.</div>
        </div>
      ) : null}

      {tab === 'APPROVALS' ? (
        <div className="wccPanel">
          <div className="wccPanelHead">
            <div><div className="wccPanelTitle">KËRKESAT NË PRITJE</div><div className="wccPanelSub">Secila kërkesë ndahet qartë: biznes, avans personal ose refuzim.</div></div>
            <strong>{euro(pendingExpenseTotal)}</strong>
          </div>
          <div className="wccRows">
            {pendingExpenses.length ? pendingExpenses.map((row) => (
              <div className="wccApproval" key={row.id}>
                <div className="wccApprovalTop">
                  <div><b>KËRKESA #{row.id}</b><small>{stamp(row.created_at)} • {upper(row.status)}</small></div>
                  <strong>{euro(row.amount)}</strong>
                </div>
                <div className="wccNote">{clean(row.note).replace(/ARKA_EXPENSE_REQUEST[^\n]*/gi, '').trim() || 'PA SHËNIM'}</div>
                {manager ? (
                  <div className="wccDecisionGrid">
                    <button type="button" disabled={decisionBusyId === row.id} onClick={() => decideExpense(row, 'BUSINESS_EXPENSE')}>BIZNES</button>
                    <button type="button" disabled={decisionBusyId === row.id} onClick={() => decideExpense(row, 'PERSONAL_ADVANCE')}>AVANS PERSONAL</button>
                    <button type="button" className="danger" disabled={decisionBusyId === row.id} onClick={() => decideExpense(row, 'REJECTED_OPEN_CASH')}>REFUZO</button>
                  </div>
                ) : null}
              </div>
            )) : <Empty>S’KA KËRKESA NË PRITJE.</Empty>}
          </div>
        </div>
      ) : null}

      {tab === 'HISTORY' ? (
        <div className="wccPanel">
          <div className="wccPanelHead">
            <div><div className="wccPanelTitle">HISTORIA E PUNTORIT</div><div className="wccPanelSub">Rroga, avanset, komisionet, ushqimi, bonuset dhe puna në një kronologji.</div></div>
            <span className="wccQuality">EXACT {n(history?.totals?.exact_event_count)} • DERIVED {n(history?.totals?.derived_event_count)} • EST. {n(history?.totals?.estimated_event_count)}</span>
          </div>
          <div className="wccRows">
            {timeline.length ? timeline.map((row) => (
              <div className="wccHistoryRow" key={row.id}>
                <span className={`wccDot ${toneForEvent(row)}`} />
                <div className="wccHistoryMain">
                  <b>{eventLabel(row.event_type)}</b>
                  <small>{stamp(row.occurred_at)} • {upper(row.source_module)} • {upper(row.quality)}</small>
                  <p>{clean(row.description) || clean(row.source_ref) || '—'}</p>
                </div>
                <div className="wccHistoryValue">
                  {n(row.amount) ? <strong>{euro(row.amount)}</strong> : null}
                  {n(row.m2) ? <span>{n(row.m2).toFixed(2)} m²</span> : null}
                </div>
              </div>
            )) : <Empty>S’KA HISTORI PËR KËTË PERIUDHË.</Empty>}
          </div>
        </div>
      ) : null}

      {tab === 'SETTINGS' && manager ? (
        <div className="wccPanel">
          <div className="wccPanelTitle">KUSHTET E PAGESËS</div>
          <div className="wccPanelSub">Rroga, ushqimi, komisioni, bonuset dhe mënyra e cash-it ruhen në profilin unik të puntorit.</div>
          <button type="button" className="wccGhost wccFull" onClick={() => setShowCompensation((value) => !value)}>{showCompensation ? 'MBYLLE EDITIMIN' : 'HAPE EDITIMIN'}</button>
          {showCompensation ? <WorkerCompensationEditor actor={actor} worker={worker} onSaved={() => void load({ silent: true })} /> : null}
          <div className="wccManagerBar">
            <Link href="/arka/stafi" prefetch={false}>EMRI / ROLI / PIN-I</Link>
            <Link href="/arka/payroll" prefetch={false}>PAYROLL-I MUJOR</Link>
          </div>
        </div>
      ) : null}

      {advanceOpen && manager ? (
        <div className="wccModalBackdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !advanceBusy) setAdvanceOpen(false); }}>
          <div className="wccModal" role="dialog" aria-modal="true" aria-label="Jep avans">
            <div className="wccModalHead"><div><div className="wccEyebrow">AVANS I RI</div><h2>{upper(worker?.name)}</h2></div><button type="button" disabled={advanceBusy} onClick={() => setAdvanceOpen(false)}>×</button></div>
            <label>SHUMA (€)<input autoFocus inputMode="decimal" value={advanceAmount} onChange={(event) => setAdvanceAmount(event.target.value)} placeholder="300" /></label>
            <label>SHËNIMI<input value={advanceNote} onChange={(event) => setAdvanceNote(event.target.value)} placeholder="P.sh. avans personal" /></label>
            <div className="wccAdvancePreview">
              <div><span>Avanse aktive para</span><b>{euro(activeAdvanceTotal)}</b></div>
              <div><span>Avansi i ri</span><b>{euro(advanceValue)}</b></div>
              <div><span>Avanse aktive pas</span><b>{euro(activeAdvanceTotal + advanceValue)}</b></div>
              {budget ? <><div><span>Buxheti para</span><b>{euro(budget.current_balance)}</b></div><div className={budgetAfterAdvance < 0 ? 'bad' : ''}><span>Buxheti pas</span><b>{euro(budgetAfterAdvance)}</b></div></> : null}
            </div>
            <div className="wccInfo">Ruhet si ADVANCE, zbritet automatikisht nga buxheti dhe lidhet me historinë e këtij puntori. Nuk kërkohet një Master PIN i dytë; pajisja dhe roli yt verifikohen nga serveri.</div>
            <div className="wccModalActions"><button type="button" className="wccGhost" disabled={advanceBusy} onClick={() => setAdvanceOpen(false)}>ANULO</button><button type="button" className="wccPrimary" disabled={advanceBusy || advanceValue <= 0 || (budget && budgetAfterAdvance < 0)} onClick={submitAdvance}>{advanceBusy ? 'DUKE RUAJTUR…' : `KONFIRMO ${euro(advanceValue)}`}</button></div>
          </div>
        </div>
      ) : null}

      <style jsx>{`
        .wccRoot{display:grid;gap:13px;color:#f8fafc;font-family:Inter,system-ui,-apple-system,sans-serif}
        .wccHeader{display:flex;justify-content:space-between;gap:16px;align-items:flex-start;flex-wrap:wrap;padding:18px;border:1px solid rgba(59,130,246,.34);border-radius:22px;background:linear-gradient(145deg,#0c1d36,#07101f);box-shadow:0 18px 50px rgba(0,0,0,.25)}
        .wccEyebrow{font-size:10px;font-weight:1000;letter-spacing:.15em;color:#93c5fd}.wccHeader h1,.wccModal h2{margin:5px 0 0;font-size:clamp(25px,5vw,38px);line-height:1;font-weight:1000}.wccMeta{margin-top:8px;color:#94a3b8;font-size:11px;font-weight:850}.wccHeaderActions{display:flex;gap:8px;flex-wrap:wrap}
        button,a{font:inherit}.wccPrimary,.wccGhost,.wccManagerBar button,.wccManagerBar a{min-height:44px;border-radius:13px;padding:10px 13px;font-size:11px;font-weight:1000;cursor:pointer;text-decoration:none;display:grid;place-items:center}.wccPrimary{border:0;background:#22c58b;color:#03130d}.wccGhost{border:1px solid rgba(148,163,184,.25);background:rgba(51,65,85,.5);color:#fff}.wccFull{width:100%;margin-top:10px}
        .wccProfileStrip{display:flex;gap:7px;flex-wrap:wrap}.wccProfileStrip span{border:1px solid rgba(148,163,184,.2);border-radius:999px;background:rgba(15,23,42,.76);padding:7px 10px;color:#94a3b8;font-size:10px;font-weight:900}.wccProfileStrip b{color:#fff}.wccError{border:1px solid rgba(239,68,68,.45);border-radius:14px;background:rgba(127,29,29,.25);color:#fecaca;padding:11px;font-size:11px;font-weight:900}
        .wccTabs{display:flex;gap:7px;overflow-x:auto;padding-bottom:2px}.wccTabs button{white-space:nowrap;border:1px solid rgba(148,163,184,.2);border-radius:12px;background:rgba(15,23,42,.75);color:#94a3b8;padding:10px 12px;font-size:10px;font-weight:1000}.wccTabs button.active{background:#1d4ed8;border-color:#60a5fa;color:#fff}.wccStack{display:grid;gap:12px}.wccMetrics,.wccWorkGrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:8px}.wccMetric{border:1px solid rgba(148,163,184,.18);border-radius:16px;background:rgba(8,15,28,.94);padding:12px;min-width:0}.wccMetric.green{border-color:rgba(34,197,94,.35)}.wccMetric.blue{border-color:rgba(59,130,246,.35)}.wccMetric.orange{border-color:rgba(245,158,11,.38)}.wccMetric.purple{border-color:rgba(168,85,247,.38)}.wccMetricLabel{font-size:9px;letter-spacing:.08em;font-weight:1000;color:#94a3b8}.wccMetricValue{margin-top:7px;font-size:22px;line-height:1;font-weight:1000;color:#fff;overflow-wrap:anywhere}.wccMetricSub{margin-top:6px;color:#94a3b8;font-size:9.5px;font-weight:750;line-height:1.35}
        .wccTwoCol{display:grid;grid-template-columns:repeat(auto-fit,minmax(270px,1fr));gap:10px}.wccPanel{display:grid;gap:11px;border:1px solid rgba(148,163,184,.2);border-radius:19px;background:rgba(8,15,28,.94);padding:14px}.wccPanelHead{display:flex;justify-content:space-between;gap:12px;align-items:flex-start}.wccPanelHead>strong{font-size:20px;color:#fff}.wccPanelTitle{font-size:13px;font-weight:1000;color:#fff}.wccPanelSub{margin-top:4px;color:#94a3b8;font-size:10px;font-weight:750;line-height:1.4}.wccActionList{display:grid;gap:7px}.wccActionList button{display:flex;justify-content:space-between;gap:10px;border:1px solid rgba(148,163,184,.18);border-radius:13px;background:rgba(2,6,23,.48);color:#cbd5e1;padding:11px;font-size:11px;font-weight:900}.wccActionList b{color:#fff}
        .wccManagerBar{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:8px}.wccManagerBar button,.wccManagerBar a{border:1px solid rgba(59,130,246,.35);background:rgba(30,64,175,.2);color:#dbeafe}.wccRows{display:grid;gap:8px}.wccRow,.wccHistoryRow,.wccApproval{border:1px solid rgba(148,163,184,.17);border-radius:14px;background:rgba(2,6,23,.52);padding:11px}.wccRow{display:flex;justify-content:space-between;gap:12px;align-items:flex-start}.wccRow b,.wccApproval b,.wccHistoryRow b{font-size:11px;color:#fff}.wccRow small,.wccApproval small,.wccHistoryRow small{display:block;margin-top:4px;color:#94a3b8;font-size:9.5px;font-weight:750}.wccRow strong{font-size:16px}.orange{color:#fbbf24!important}.wccEmpty{padding:18px;text-align:center;color:#94a3b8;font-size:11px;font-weight:900}.wccInfo{border:1px solid rgba(59,130,246,.25);border-radius:13px;background:rgba(30,64,175,.13);color:#bfdbfe;padding:10px;font-size:10px;line-height:1.45;font-weight:750}
        .wccApproval{display:grid;gap:9px}.wccApprovalTop{display:flex;justify-content:space-between;gap:10px}.wccApprovalTop>strong{font-size:18px}.wccNote{font-size:11px;color:#e2e8f0;white-space:pre-wrap;line-height:1.4}.wccDecisionGrid{display:grid;grid-template-columns:repeat(3,1fr);gap:7px}.wccDecisionGrid button{min-height:42px;border:1px solid rgba(34,197,94,.35);border-radius:11px;background:rgba(21,128,61,.18);color:#bbf7d0;font-size:9px;font-weight:1000}.wccDecisionGrid button:nth-child(2){border-color:rgba(245,158,11,.4);background:rgba(146,64,14,.2);color:#fde68a}.wccDecisionGrid button.danger{border-color:rgba(239,68,68,.4);background:rgba(127,29,29,.24);color:#fecaca}.wccDecisionGrid button:disabled{opacity:.55}
        .wccHistoryRow{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:10px;align-items:start}.wccDot{width:9px;height:9px;border-radius:99px;margin-top:3px;background:#94a3b8}.wccDot.green{background:#4ade80}.wccDot.blue{background:#60a5fa}.wccDot.orange{background:#f59e0b}.wccDot.purple{background:#c084fc}.wccHistoryMain p{margin:6px 0 0;color:#cbd5e1;font-size:10px;line-height:1.4}.wccHistoryValue{text-align:right;display:grid;gap:4px}.wccHistoryValue strong{font-size:14px}.wccHistoryValue span{font-size:10px;color:#93c5fd;font-weight:900}.wccQuality{font-size:8.5px;color:#94a3b8;font-weight:900;text-align:right}
        .wccModalBackdrop{position:fixed;inset:0;z-index:100200;background:rgba(0,0,0,.82);display:flex;align-items:flex-end;justify-content:center;padding:10px}.wccModal{width:min(560px,100%);max-height:94dvh;overflow:auto;border:1px solid rgba(59,130,246,.42);border-radius:25px;background:#07101f;padding:17px;box-shadow:0 -22px 70px rgba(0,0,0,.6);display:grid;gap:13px}.wccModalHead{display:flex;justify-content:space-between;gap:12px}.wccModalHead button{width:44px;height:44px;border:1px solid rgba(148,163,184,.25);border-radius:13px;background:#111827;color:#fff;font-size:25px}.wccModal label{display:grid;gap:6px;color:#94a3b8;font-size:9.5px;font-weight:1000}.wccModal input{width:100%;box-sizing:border-box;min-height:52px;border:1px solid #334155;border-radius:14px;background:#0b1525;color:#fff;padding:0 13px;font-size:18px;font-weight:900}.wccAdvancePreview{border:1px solid rgba(148,163,184,.2);border-radius:15px;overflow:hidden}.wccAdvancePreview div{display:flex;justify-content:space-between;gap:10px;padding:10px 12px;border-bottom:1px solid rgba(148,163,184,.14);color:#94a3b8;font-size:10px;font-weight:850}.wccAdvancePreview div:last-child{border-bottom:0}.wccAdvancePreview b{color:#fff;font-size:12px}.wccAdvancePreview .bad b{color:#fca5a5}.wccModalActions{display:grid;grid-template-columns:1fr 1.7fr;gap:8px}.wccLoading{border:1px solid rgba(59,130,246,.3);border-radius:18px;background:#07101f;color:#93c5fd;padding:25px;text-align:center;font-weight:1000}
        @media(max-width:540px){.wccHeader{padding:15px}.wccHeaderActions{width:100%;display:grid;grid-template-columns:1fr 1fr}.wccDecisionGrid{grid-template-columns:1fr}.wccHistoryRow{grid-template-columns:auto minmax(0,1fr)}.wccHistoryValue{grid-column:2;text-align:left;display:flex}.wccModalActions{grid-template-columns:1fr}.wccMetricValue{font-size:20px}}
      `}</style>
    </section>
  );
}
