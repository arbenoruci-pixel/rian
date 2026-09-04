'use client';

import Link from '@/lib/routerCompat.jsx';
import { useEffect, useMemo, useRef, useState } from 'react';
import { getActor } from '@/lib/actorSession';
import { supabase } from '@/lib/supabaseClient';
import useRouteAlive from '@/lib/routeAlive';
import { bootMarkReady } from '@/lib/bootLog';

const TIME_ZONE = 'Europe/Belgrade';
const BUSINESS_DAY_CUTOFF_HOUR = 4; // ARKA_DAILY_OPERATIONS_V3
const PREVIEW_RPC = 'get_arka_daily_close_preview_v4';
const CLOSE_RPC = 'close_arka_day_v2';
const EXPENSE_RESOLVE_RPC = 'resolve_arka_expense_v2';
const EXPENSE_CREATE_RPC = 'create_and_resolve_arka_expense_v2';
const CACHE_PREFIX = 'tepiha_arka_daily_close_v2:';
const MONEY = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const MANAGER_ROLES = new Set([
  'DISPATCH', 'MASTER', 'MASTER USER', 'MASTER_USER', 'MASTERUSER',
  'ADMIN', 'ADMIN_MASTER', 'OWNER', 'PRONAR', 'SUPERADMIN',
]);

const REASONS = [
  ['SHPENZIM_PA_REGJISTRUAR', 'SHPENZIM I PAREGJISTRUAR'],
  ['AVANS_PA_REGJISTRUAR', 'AVANS I PAREGJISTRUAR'],
  ['PARA_TE_PUNTORI', 'PARA ENDE TE PUNËTORI'],
  ['GABIM_NUMERIMI', 'GABIM NË NUMËRIM'],
  ['HISTORICAL_RECONCILIATION', 'DIFERENCË HISTORIKE'],
  ['TJETER', 'ARSYE TJETËR'],
];

function n(value) {
  const parsed = Number(String(value ?? '').replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : 0;
}

function money(value) {
  return `€${MONEY.format(n(value))}`;
}

function m2(value) {
  return `${MONEY.format(n(value))} m²`;
}

function rows(value) {
  return Array.isArray(value) ? value : [];
}

function obj(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function upper(value) {
  return String(value || '').trim().toUpperCase();
}

function cleanExpenseNote(value) {
  return String(value || '')
    .replace(/\n?ARKA_EXPENSE_REQUEST_V\d+[^\n]*/gi, '')
    .replace(/\n?ARKA_EXPENSE_REQUEST_V1[^\n]*/gi, '')
    .trim() || 'PA PËRSHKRIM';
}

function randomKey(prefix = 'ARKA') {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return prefix + ':' + crypto.randomUUID();
    }
  } catch {}
  return prefix + ':' + Date.now() + ':' + Math.random().toString(36).slice(2);
}

function dayKey(value = new Date()) {
  try {
    const rawDate = value instanceof Date ? value : new Date(value || Date.now());
    const d = new Date(rawDate.getTime() - BUSINESS_DAY_CUTOFF_HOUR * 60 * 60 * 1000);
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(d);
    const get = (type) => parts.find((part) => part.type === type)?.value || '';
    return `${get('year')}-${get('month')}-${get('day')}`;
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

function stamp(value) {
  if (!value) return '—';
  try {
    return new Intl.DateTimeFormat('sq-AL', {
      timeZone: TIME_ZONE,
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(value));
  } catch {
    return String(value || '—');
  }
}

function formatDate(value) {
  try {
    const [year, month, day] = String(value || '').split('-').map(Number);
    return new Intl.DateTimeFormat('sq-AL', {
      timeZone: TIME_ZONE,
      weekday: 'long',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    }).format(new Date(Date.UTC(year, (month || 1) - 1, day || 1, 12, 0, 0)));
  } catch {
    return String(value || '—');
  }
}

function parseMoneyInput(value) {
  const clean = String(value ?? '').trim().replace(/\s+/g, '').replace(',', '.');
  const parsed = Number(clean);
  return Number.isFinite(parsed) && parsed >= 0 ? +parsed.toFixed(2) : null;
}

function cacheKey(pin, date) {
  return `${CACHE_PREFIX}${String(pin || '').trim()}:${String(date || '').trim()}`;
}

function readCache(pin, date) {
  try {
    const raw = window.localStorage.getItem(cacheKey(pin, date));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed?.preview && typeof parsed.preview === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function writeCache(pin, date, preview) {
  try {
    window.localStorage.setItem(cacheKey(pin, date), JSON.stringify({
      preview,
      cached_at: new Date().toISOString(),
    }));
  } catch {}
}

const palette = {
  panel: 'rgba(8,15,28,.92)',
  panelSoft: 'rgba(15,23,42,.68)',
  line: 'rgba(148,163,184,.22)',
  text: '#f8fafc',
  muted: 'rgba(203,213,225,.70)',
  info: '#bfdbfe',
  ok: '#bbf7d0',
  warn: '#fde68a',
  bad: '#fecaca',
};

function Card({ children, tone = 'neutral', style = {} }) {
  const border = tone === 'ok'
    ? 'rgba(34,197,94,.40)'
    : tone === 'warn'
      ? 'rgba(245,158,11,.42)'
      : tone === 'bad'
        ? 'rgba(239,68,68,.46)'
        : tone === 'info'
          ? 'rgba(59,130,246,.40)'
          : palette.line;
  return (
    <section style={{
      border: `1px solid ${border}`,
      borderRadius: 18,
      background: palette.panel,
      padding: 14,
      display: 'grid',
      gap: 11,
      boxShadow: '0 18px 45px rgba(0,0,0,.22)',
      ...style,
    }}>
      {children}
    </section>
  );
}

function Metric({ label, value, sub = '', tone = 'neutral' }) {
  const color = tone === 'ok'
    ? palette.ok
    : tone === 'warn'
      ? palette.warn
      : tone === 'bad'
        ? palette.bad
        : tone === 'info'
          ? palette.info
          : '#e2e8f0';
  return (
    <div style={{
      border: `1px solid ${palette.line}`,
      borderRadius: 14,
      background: palette.panelSoft,
      padding: 11,
      minWidth: 0,
    }}>
      <div style={{ fontSize: 10, fontWeight: 1000, letterSpacing: '.075em', color }}>{label}</div>
      <div style={{ marginTop: 7, fontSize: 23, lineHeight: 1, fontWeight: 1000, color: '#fff', overflowWrap: 'anywhere' }}>{value}</div>
      {sub ? <div style={{ marginTop: 6, fontSize: 10.5, lineHeight: 1.35, fontWeight: 750, color: palette.muted }}>{sub}</div> : null}
    </div>
  );
}

function Row({ title, meta = '', amount = '', tone = 'neutral', children = null }) {
  const color = tone === 'ok' ? palette.ok : tone === 'warn' ? palette.warn : tone === 'bad' ? palette.bad : '#fff';
  return (
    <div style={{
      border: `1px solid ${palette.line}`,
      borderRadius: 13,
      background: 'rgba(15,23,42,.48)',
      padding: 11,
      display: 'grid',
      gap: 9,
    }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto', gap: 10, alignItems: 'start' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 12.5, lineHeight: 1.25, fontWeight: 1000, color: '#f8fafc', overflowWrap: 'anywhere' }}>{title}</div>
          {meta ? <div style={{ marginTop: 4, fontSize: 10.5, lineHeight: 1.4, fontWeight: 750, color: palette.muted, overflowWrap: 'anywhere' }}>{meta}</div> : null}
        </div>
        {amount ? <strong style={{ fontSize: 15, color, whiteSpace: 'nowrap' }}>{amount}</strong> : null}
      </div>
      {children}
    </div>
  );
}

function StepPill({ index, title, current, done, onClick }) {
  const active = current === index;
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        border: `1px solid ${active ? 'rgba(96,165,250,.58)' : done ? 'rgba(34,197,94,.38)' : palette.line}`,
        borderRadius: 12,
        padding: '9px 8px',
        background: active ? 'rgba(37,99,235,.24)' : done ? 'rgba(21,128,61,.14)' : 'rgba(30,41,59,.52)',
        color: active ? '#dbeafe' : done ? '#bbf7d0' : '#cbd5e1',
        fontSize: 10,
        fontWeight: 1000,
        cursor: 'pointer',
      }}
    >
      {index}. {title}
    </button>
  );
}

function Alert({ children, tone = 'warn' }) {
  const border = tone === 'bad' ? 'rgba(239,68,68,.48)' : tone === 'ok' ? 'rgba(34,197,94,.42)' : 'rgba(245,158,11,.44)';
  const background = tone === 'bad' ? 'rgba(127,29,29,.24)' : tone === 'ok' ? 'rgba(20,83,45,.22)' : 'rgba(120,53,15,.22)';
  const color = tone === 'bad' ? palette.bad : tone === 'ok' ? palette.ok : palette.warn;
  return (
    <div style={{ border: `1px solid ${border}`, borderRadius: 12, background, color, padding: 10, fontSize: 11, lineHeight: 1.45, fontWeight: 850 }}>
      {children}
    </div>
  );
}

function Receipt({ cycle, items = [], onRefresh }) {
  const discrepancy = n(cycle?.discrepancy);
  const discrepancyTone = Math.abs(discrepancy) <= 0.01 ? 'ok' : 'warn';
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <Card tone="ok">
        <div style={{ fontSize: 11, color: palette.ok, fontWeight: 1000, letterSpacing: '.09em' }}>MBYLLJA ZYRTARE E ARKËS</div>
        <div style={{ fontSize: 27, lineHeight: 1, fontWeight: 1000 }}>DITA U MBYLL</div>
        <div style={{ color: palette.muted, fontSize: 12, fontWeight: 750 }}>
          {formatDate(cycle?.cycle_date)} • {upper(cycle?.closed_by_name || cycle?.closed_by_pin)} • {stamp(cycle?.closed_at || cycle?.updated_at)}
        </div>
      </Card>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(145px,1fr))', gap: 8 }}>
        <Metric label="HAPJA E DITËS" value={money(cycle?.opening_cash)} tone="info" />
        <Metric label="HYRJE" value={money(cycle?.total_in)} tone="ok" sub={`Dorëzime: ${money(cycle?.accepted_handoffs_total)}`} />
        <Metric label="DALJE" value={money(cycle?.total_out)} tone="bad" sub={`Shpenzime ${money(cycle?.posted_expenses_total)} • Avanse ${money(cycle?.posted_advances_total)}`} />
        <Metric label="PRITEJ NË BOX" value={money(cycle?.expected_cash)} tone="info" />
        <Metric label="U NUMËRUAN" value={money(cycle?.counted_cash)} tone="strong" />
        <Metric label="DIFERENCA" value={money(discrepancy)} tone={discrepancyTone} />
        <Metric label="BUXHETI FINAL" value={money(cycle?.budget_balance_after ?? cycle?.closing_cash)} tone="ok" sub="Duhet të jetë i barabartë me cash-in fizik" />
      </div>

      {Math.abs(discrepancy) > 0.01 ? (
        <Alert tone="warn">
          <b>{discrepancy < 0 ? 'MUNGESË' : 'TEPRICË'}: {money(Math.abs(discrepancy))}</b><br />
          Arsye: {upper(cycle?.discrepancy_reason || '—')}<br />
          Shënim: {cycle?.discrepancy_note || cycle?.notes || '—'}
        </Alert>
      ) : <Alert tone="ok">Cash-i fizik dhe buxheti përputhen plotësisht.</Alert>}

      <Card>
        <div style={{ fontSize: 13, fontWeight: 1000 }}>GJURMA E MBYLLJES</div>
        {rows(items).length ? rows(items).map((item) => (
          <Row
            key={`receipt_${item?.id}`}
            title={`${upper(item?.item_type)} • ${upper(item?.worker_name || item?.worker_pin || item?.source_table)}`}
            meta={`${upper(item?.direction)} • ${upper(item?.status_snapshot)}${item?.note ? ` • ${item.note}` : ''}`}
            amount={money(item?.amount)}
            tone={upper(item?.direction) === 'OUT' ? 'bad' : 'ok'}
          />
        )) : <div style={{ color: palette.muted, fontSize: 11 }}>Gjurmët janë ruajtur në databazë.</div>}
      </Card>

      <button type="button" onClick={onRefresh} style={primaryButtonStyle}>RIFRESKO FLETËN ZYRTARE</button>
    </div>
  );
}

const primaryButtonStyle = {
  border: '1px solid rgba(96,165,250,.56)',
  borderRadius: 13,
  padding: '13px 14px',
  background: 'linear-gradient(135deg,#1d4ed8,#2563eb)',
  color: '#fff',
  fontSize: 12,
  fontWeight: 1000,
  cursor: 'pointer',
};

const secondaryButtonStyle = {
  border: `1px solid ${palette.line}`,
  borderRadius: 13,
  padding: '12px 13px',
  background: 'rgba(51,65,85,.62)',
  color: '#fff',
  fontSize: 11,
  fontWeight: 1000,
  cursor: 'pointer',
};

export default function ArkaDailyCloseWizard() {
  useRouteAlive('arka_daily_close_v2');
  const date = useMemo(() => dayKey(new Date()), []);
  const [actor, setActor] = useState(null);
  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [offlineSnapshot, setOfflineSnapshot] = useState(false);
  const [step, setStep] = useState(1);
  const [selectedIds, setSelectedIds] = useState([]);
  const [confirmedIds, setConfirmedIds] = useState({});
  const [countedCash, setCountedCash] = useState('');
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [dryRun, setDryRun] = useState(null);
  const [finalConfirm, setFinalConfirm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [expenseActionBusy, setExpenseActionBusy] = useState('');
  const [expenseActionMessage, setExpenseActionMessage] = useState('');
  const [newExpenseOpen, setNewExpenseOpen] = useState(false);
  const [newExpenseAmount, setNewExpenseAmount] = useState('');
  const [newExpenseNote, setNewExpenseNote] = useState('');
  const [newExpenseBusy, setNewExpenseBusy] = useState(false);
  const [result, setResult] = useState(null);
  const initializedRef = useRef(false);
  const requestRef = useRef(0);
  const expenseMutationLockRef = useRef(false);
  const countedCashManualRef = useRef(false);

  useEffect(() => {
    const current = getActor() || null;
    setActor(current);
    try { bootMarkReady({ source: 'arka_daily_close_v2', page: 'arka_daily_close', path: '/arka/ditore' }); } catch {}
  }, []);

  const role = upper(actor?.role);
  const denied = !!actor && !MANAGER_ROLES.has(role);
  const pendingHandoffs = rows(preview?.pending_handoffs);
  const pendingExpenses = rows(preview?.pending_expenses);
  const receivedToday = rows(preview?.received_today);
  const ledgerRows = rows(preview?.today_ledger?.rows);
  const postedExpenseRows = ledgerRows.filter((row) => upper(row?.source_type) === 'ARKA_EXPENSE_DECISION' && upper(row?.direction) === 'OUT');
  const postedAdvanceRows = ledgerRows.filter((row) => upper(row?.source_type) === 'ARKA_ADVANCE' && upper(row?.direction) === 'OUT');
  const closedCycle = obj(preview?.closed_cycle);
  const closedItems = rows(preview?.closed_items);
  const isClosed = closedCycle?.is_closed === true || upper(closedCycle?.close_status) === 'CLOSED';

  const selectedSet = useMemo(() => new Set(selectedIds.map(Number)), [selectedIds]);
  const selectedHandoffs = pendingHandoffs.filter((row) => selectedSet.has(Number(row?.id)));
  const selectedTotal = +selectedHandoffs.reduce((sum, row) => sum + n(row?.amount), 0).toFixed(2);
  const currentBudget = n(preview?.current_budget);
  const expectedCash = +(currentBudget + selectedTotal).toFixed(2);
  const countedValue = parseMoneyInput(countedCash);
  const discrepancy = countedValue == null ? null : +(countedValue - expectedCash).toFixed(2);
  const hasDiscrepancy = discrepancy != null && Math.abs(discrepancy) > 0.01;
  const everySelectedConfirmed = selectedHandoffs.every((row) => confirmedIds[String(row?.id)] === true);
  const pendingExpenseCount = n(preview?.pending_expenses_count ?? pendingExpenses.length);
  // ARKA_REOPENABLE_DAILY_WIZARD_V1: a prior final report never hides later worker handoffs or cash movements.
  const openCashAtWorkers = rows(preview?.open_cash_at_workers);
  const receivedTodayTotal = +receivedToday.reduce((sum, row) => sum + n(row?.amount), 0).toFixed(2);
  const hasUnreflectedClosedTotals = isClosed && (
    Math.abs(receivedTodayTotal - n(closedCycle?.accepted_handoffs_total)) > 0.01
    || Math.abs(n(preview?.today_expenses?.total) - n(closedCycle?.posted_expenses_total)) > 0.01
    || Math.abs(n(preview?.today_advances?.total) - n(closedCycle?.posted_advances_total)) > 0.01
  );
  const hasLiveWizardWork = pendingHandoffs.length > 0
    || pendingExpenseCount > 0
    || openCashAtWorkers.length > 0
    || hasUnreflectedClosedTotals;
  const showClosedReceiptOnly = isClosed && !hasLiveWizardWork;
  const dailyOperations = obj(preview?.operations);
  const dailyIncoming = obj(dailyOperations?.incoming);
  const dailyOutgoing = obj(dailyOperations?.outgoing);
  const dailyCurrent = obj(dailyOperations?.current);
  const dailyIncomingM2 = n(dailyIncoming?.total?.m2);
  const dailyOutgoingM2 = n(dailyOutgoing?.total?.m2);
  const dailyNetM2 = n(dailyOperations?.net_m2);
  const dailyPastrimM2 = n(dailyCurrent?.pastrim?.m2);
  const dailyGatiM2 = n(dailyCurrent?.gati?.m2);

  useEffect(() => {
    if (!preview || showClosedReceiptOnly || countedCashManualRef.current) return;
    const automaticValue = expectedCash.toFixed(2);
    setCountedCash((current) => current === automaticValue ? current : automaticValue);
  }, [expectedCash, showClosedReceiptOnly, preview?.generated_at]);

  async function loadPreview({ force = false } = {}) {
    const pin = String(actor?.pin || '').trim();
    if (!pin) {
      setLoading(false);
      return;
    }
    const seq = requestRef.current + 1;
    requestRef.current = seq;
    const cached = readCache(pin, date);
    if (!force && cached?.preview && !preview) {
      setPreview(cached.preview);
      setOfflineSnapshot(true);
      setLoading(false);
    }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      if (cached?.preview) {
        setPreview(cached.preview);
        setOfflineSnapshot(true);
        setError('OFFLINE — MUND TA SHOHËSH SNAPSHOT-IN. MBYLLJA KËRKON INTERNET.');
      } else {
        setError('OFFLINE — NUK KA SNAPSHOT TË MBYLLJES DITORE.');
      }
      setLoading(false);
      return;
    }

    if (preview) setRefreshing(true);
    else setLoading(true);
    setError('');
    try {
      const { data, error: rpcError } = await supabase.rpc(PREVIEW_RPC, {
        p_actor_pin: pin,
        p_date: date,
      });
      if (rpcError) throw rpcError;
      if (seq !== requestRef.current) return;
      const next = obj(data);
      setPreview(next);
      setOfflineSnapshot(false);
      writeCache(pin, date, next);
      if (!initializedRef.current) {
        const ids = rows(next?.pending_handoffs).map((row) => Number(row?.id)).filter((id) => id > 0);
        setSelectedIds(ids);
        setConfirmedIds({});
        initializedRef.current = true;
      }
    } catch (err) {
      if (seq !== requestRef.current) return;
      const message = String(err?.message || err?.details || err || 'NUK U NGARKUA MBYLLJA DITORE.');
      if (cached?.preview) {
        setPreview(cached.preview);
        setOfflineSnapshot(true);
        setError(`LIVE NUK U NGARKUA — PO SHFAQET SNAPSHOT. ${message}`);
      } else {
        setError(message);
      }
    } finally {
      if (seq === requestRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }

  useEffect(() => {
    if (!actor?.pin) return;
    void loadPreview({ force: true });
  }, [actor?.pin]);

  function toggleSelected(id) {
    countedCashManualRef.current = false;
    setCountedCash('');
    const value = Number(id);
    if (!(value > 0)) return;
    setDryRun(null);
    setFinalConfirm(false);
    setSelectedIds((current) => current.includes(value) ? current.filter((x) => x !== value) : [...current, value]);
    setConfirmedIds((current) => ({ ...current, [String(value)]: false }));
  }

  function toggleConfirmed(id) {
    const key = String(id);
    setDryRun(null);
    setFinalConfirm(false);
    setConfirmedIds((current) => ({ ...current, [key]: !current[key] }));
  }

  function goNextFromHandoffs() {
    if (!everySelectedConfirmed) {
      setError('KONFIRMO “I MORA” PËR SECILIN DORËZIM QË PO E FUT NË BOX.');
      return;
    }
    setError('');
    setStep(2);
  }

  function goNextFromOutgoings() {
    if (pendingExpenseCount > 0) {
      setError(`KE ${pendingExpenseCount} SHPENZIME NË PRITJE. VENDOSI PARA MBYLLJES.`);
      return;
    }
    setError('');
    countedCashManualRef.current = false;
    setCountedCash(expectedCash.toFixed(2));
    setStep(3);
  }

  async function resolvePendingExpense(expense, resolution) {
    // ARKA_DAILY_EXPENSE_STEP_V1: every pending expense is visible and resolvable inside step 2.
    const expenseId = Number(expense?.id || 0);
    if (!(expenseId > 0) || expenseMutationLockRef.current) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      setError('VENDIMI PËR SHPENZIM KËRKON INTERNET.');
      return;
    }

    const amount = n(expense?.amount);
    const labels = {
      BUSINESS_EXPENSE: 'PRANOSH SI SHPENZIM BIZNESI',
      PERSONAL_ADVANCE: 'KTHESH NË AVANS TË PUNËTORIT',
      REJECTED_OPEN_CASH: 'REFUZOSH',
    };
    const prompt = `A JE I SIGURT QË DO TA ${labels[resolution] || 'VENDOSËSH'}?\n\n${money(amount)} • ${cleanExpenseNote(expense?.note)}`;
    try {
      if (typeof window !== 'undefined' && !window.confirm(prompt)) return;
    } catch {}

    expenseMutationLockRef.current = true;
    setExpenseActionBusy(String(expenseId));
    setExpenseActionMessage('');
    setError('');
    setDryRun(null);
    setFinalConfirm(false);
    countedCashManualRef.current = false;
    setCountedCash('');

    try {
      const { data, error: rpcError } = await supabase.rpc(EXPENSE_RESOLVE_RPC, {
        p_actor_pin: String(actor?.pin || '').trim(),
        p_actor_name: String(actor?.name || actor?.pin || '').trim(),
        p_expense_payment_id: expenseId,
        p_resolution: resolution,
        p_beneficiary_pin: resolution === 'PERSONAL_ADVANCE' ? String(expense?.created_by_pin || '').trim() : null,
        p_beneficiary_name: resolution === 'PERSONAL_ADVANCE' ? String(expense?.created_by_name || expense?.created_by_pin || '').trim() : null,
        p_note: 'VENDOSUR NGA DISPATCH NË MBYLLJEN DITORE',
      });
      if (rpcError) throw rpcError;
      if (data?.ok !== true) throw new Error(data?.message || 'VENDIMI NUK U RUAJT.');
      setExpenseActionMessage(
        resolution === 'BUSINESS_EXPENSE'
          ? `U POSTUA SHPENZIMI ${money(amount)} DHE U ZBRIT NGA BUXHETI.`
          : resolution === 'PERSONAL_ADVANCE'
            ? `U KTHYE NË AVANS ${money(amount)} DHE U ZBRIT NGA BUXHETI.`
            : `U REFUZUA KËRKESA ${money(amount)}.`,
      );
      await loadPreview({ force: true });
      try { window.dispatchEvent(new Event('arka:refresh')); } catch {}
    } catch (err) {
      setError(String(err?.message || err?.details || err || 'VENDIMI PËR SHPENZIM DËSHTOI.'));
      await loadPreview({ force: true });
    } finally {
      expenseMutationLockRef.current = false;
      setExpenseActionBusy('');
    }
  }

  function openNewExpenseForm() {
    setNewExpenseOpen(true);
    setExpenseActionMessage('');
    setError('');
  }

  async function createDailyExpense() {
    if (expenseMutationLockRef.current) return;
    const amount = parseMoneyInput(newExpenseAmount);
    const description = String(newExpenseNote || '').trim();
    if (amount == null || amount <= 0) {
      setError('SHKRUAJ SHUMËN E SHPENZIMIT MBI 0€.');
      return;
    }
    if (description.length < 2) {
      setError('SHKRUAJ PËRSHKRIMIN E SHPENZIMIT.');
      return;
    }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      setError('REGJISTRIMI I SHPENZIMIT KËRKON INTERNET.');
      return;
    }

    expenseMutationLockRef.current = true;
    setNewExpenseBusy(true);
    setExpenseActionMessage('');
    setError('');
    setDryRun(null);
    setFinalConfirm(false);
    countedCashManualRef.current = false;
    setCountedCash('');

    try {
      const { data, error: rpcError } = await supabase.rpc(EXPENSE_CREATE_RPC, {
        p_actor_pin: String(actor?.pin || '').trim(),
        p_actor_name: String(actor?.name || actor?.pin || '').trim(),
        p_amount: amount,
        p_note: description,
        p_resolution: 'BUSINESS_EXPENSE',
        p_beneficiary_pin: null,
        p_beneficiary_name: null,
        p_idempotency_key: randomKey(`ARKA_DAILY_EXPENSE_V2:${date}:${String(actor?.pin || '').trim()}`),
      });
      if (rpcError) throw rpcError;
      if (data?.ok !== true) throw new Error(data?.message || 'SHPENZIMI NUK U RUAJT.');
      setExpenseActionMessage(`U SHTUA SHPENZIMI ${money(amount)} DHE U ZBRIT NGA BUXHETI.`);
      setNewExpenseAmount('');
      setNewExpenseNote('');
      setNewExpenseOpen(false);
      await loadPreview({ force: true });
      try { window.dispatchEvent(new Event('arka:refresh')); } catch {}
    } catch (err) {
      setError(String(err?.message || err?.details || err || 'REGJISTRIMI I SHPENZIMIT DËSHTOI.'));
      await loadPreview({ force: true });
    } finally {
      expenseMutationLockRef.current = false;
      setNewExpenseBusy(false);
    }
  }

  async function runServerCheck() {
    const counted = parseMoneyInput(countedCash);
    if (counted == null) {
      setError('SHKRUAJ SHUMËN E SAKTË QË E NUMËROVE FIZIKISHT NË BOX.');
      return;
    }
    if (hasDiscrepancy && (!reason || String(note || '').trim().length < 4)) {
      setError('PËR DIFERENCËN ZGJIDH ARSYEN DHE SHKRUAJ NJË SHËNIM TË QARTË.');
      return;
    }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      setError('MBYLLJA DITORE KËRKON INTERNET.');
      return;
    }

    setSubmitting(true);
    setError('');
    try {
      const key = `ARKA_DAILY_CLOSE_V2:${date}:${selectedIds.slice().sort((a, b) => a - b).join('-')}:${counted.toFixed(2)}`;
      const { data, error: rpcError } = await supabase.rpc(CLOSE_RPC, {
        p_actor_pin: String(actor?.pin || '').trim(),
        p_actor_name: String(actor?.name || actor?.pin || '').trim(),
        p_date: date,
        p_handoff_ids: selectedIds,
        p_counted_cash: counted,
        p_discrepancy_reason: hasDiscrepancy ? reason : 'NO_DISCREPANCY',
        p_discrepancy_note: hasDiscrepancy ? String(note || '').trim() : 'PËRPUTHJE E PLOTË',
        p_idempotency_key: key,
        p_dry_run: true,
      });
      if (rpcError) throw rpcError;
      const check = obj(data);
      if (check?.ok !== true || check?.dry_run !== true) throw new Error(check?.message || 'KONTROLLI I SERVERIT DËSHTOI.');
      setDryRun(check);
      setFinalConfirm(false);
      setStep(4);
    } catch (err) {
      setError(String(err?.message || err?.details || err || 'KONTROLLI NUK U KRYE.'));
      await loadPreview({ force: true });
    } finally {
      setSubmitting(false);
    }
  }

  async function closeDay() {
    if (!dryRun || !finalConfirm) {
      setError('LEXO PËRMBLEDHJEN DHE SHËNO KONFIRMIMIN FINAL.');
      return;
    }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      setError('MBYLLJA DITORE KËRKON INTERNET.');
      return;
    }

    setSubmitting(true);
    setError('');
    try {
      const counted = n(dryRun?.counted_cash);
      const ids = rows(dryRun?.selected_handoff_ids).map(Number).filter((id) => id > 0);
      const key = `ARKA_DAILY_CLOSE_V2:${date}:${ids.slice().sort((a, b) => a - b).join('-')}:${counted.toFixed(2)}`;
      const { data, error: rpcError } = await supabase.rpc(CLOSE_RPC, {
        p_actor_pin: String(actor?.pin || '').trim(),
        p_actor_name: String(actor?.name || actor?.pin || '').trim(),
        p_date: date,
        p_handoff_ids: ids,
        p_counted_cash: counted,
        p_discrepancy_reason: Math.abs(n(dryRun?.discrepancy)) > 0.01 ? reason : 'NO_DISCREPANCY',
        p_discrepancy_note: Math.abs(n(dryRun?.discrepancy)) > 0.01 ? String(note || '').trim() : 'PËRPUTHJE E PLOTË',
        p_idempotency_key: key,
        p_dry_run: false,
      });
      if (rpcError) throw rpcError;
      const closed = obj(data);
      if (closed?.ok !== true) throw new Error(closed?.message || 'MBYLLJA NUK U RUAJT.');
      setResult(closed);
      setStep(4);
      await loadPreview({ force: true });
      try { window.dispatchEvent(new Event('arka:refresh')); } catch {}
    } catch (err) {
      setError(String(err?.message || err?.details || err || 'MBYLLJA E DITËS DËSHTOI.'));
      await loadPreview({ force: true });
    } finally {
      setSubmitting(false);
    }
  }

  if (denied) {
    return (
      <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: '#05070d', color: '#fff', padding: 18 }}>
        <Card tone="bad" style={{ width: 'min(520px,100%)' }}>
          <div style={{ color: palette.bad, fontSize: 11, fontWeight: 1000 }}>VETËM DISPATCH / ADMIN</div>
          <div style={{ fontSize: 26, fontWeight: 1000 }}>NUK KE QASJE</div>
          <Link to="/arka" style={{ ...primaryButtonStyle, textDecoration: 'none', textAlign: 'center' }}>KTHEHU NË ARKË</Link>
        </Card>
      </div>
    );
  }

  const receiptCycle = obj(result?.cycle);
  const receiptItems = rows(result?.items);
  const activeReceiptCycle = receiptCycle?.is_closed ? receiptCycle : closedCycle;
  const activeReceiptItems = receiptCycle?.is_closed ? receiptItems : closedItems;

  return (
    <div style={{ minHeight: '100vh', background: 'radial-gradient(circle at 50% -10%,rgba(37,99,235,.19),transparent 34%),#05070d', color: palette.text, padding: '12px 10px calc(28px + env(safe-area-inset-bottom,0px))', fontFamily: 'system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif' }}>
      <main style={{ width: 'min(900px,100%)', margin: '0 auto', display: 'grid', gap: 12 }}>
        <Card tone="info">
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <div>
              <div style={{ color: palette.info, fontSize: 10.5, fontWeight: 1000, letterSpacing: '.11em' }}>ARKA • ONE-WAY DAILY CLOSE V2</div>
              <h1 style={{ margin: '6px 0 0', fontSize: 28, lineHeight: 1, letterSpacing: '-.025em' }}>MBYLLJA DITORE</h1>
              <div style={{ marginTop: 7, color: palette.muted, fontSize: 12, fontWeight: 750 }}>{formatDate(date)} • DITA OPERATIVE 04:00–04:00 • {upper(actor?.name || actor?.pin || 'PA LOGIN')}</div>
            </div>
            <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
              <Link to="/arka" style={{ ...secondaryButtonStyle, textDecoration: 'none' }}>← ARKA</Link>
              <button type="button" disabled={refreshing || loading || submitting} onClick={() => void loadPreview({ force: true })} style={secondaryButtonStyle}>{refreshing ? 'DUKE FRESKUAR...' : 'REFRESH'}</button>
            </div>
          </div>
          <div style={{ color: palette.muted, fontSize: 11, lineHeight: 1.45, fontWeight: 760 }}>
            Dorëzimet hyjnë në buxhet vetëm këtu. Shpenzimet dhe avanset dalin nga buxheti me gjurmë. Numërimi fizik e mbyll ditën.
          </div>
          {offlineSnapshot ? <Alert>SNAPSHOT LOKAL — mbyllja është e çaktivizuar pa internet.</Alert> : null}
          {error ? <Alert tone="bad">{error}</Alert> : null}
        </Card>

        {loading && !preview ? <Card tone="info"><div style={{ textAlign: 'center', padding: 22, color: palette.info, fontWeight: 1000 }}>DUKE NGARKUAR KONTROLLIN E ARKËS...</div></Card> : null}

        {preview ? (
          <Card tone="info">
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'flex-start', flexWrap: 'wrap' }}>
              <div>
                <div style={{ color: palette.info, fontSize: 10.5, fontWeight: 1000, letterSpacing: '.10em' }}>PASQYRA E DITËS</div>
                <div style={{ marginTop: 5, fontSize: 15, fontWeight: 1000 }}>HYRJE / DALJE • 04:00–04:00</div>
              </div>
              <div style={{ color: palette.muted, fontSize: 10.5, fontWeight: 800 }}>{formatDate(date)}</div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(135px,1fr))', gap: 8 }}>
              <Metric label="m² HYRË SOT" value={m2(dailyIncomingM2)} tone="ok" sub={`BAZA ${m2(dailyIncoming?.base?.m2)} • TRANSPORT ${m2(dailyIncoming?.transport?.m2)}`} />
              <Metric label="m² DALË SOT" value={m2(dailyOutgoingM2)} tone="bad" sub={`BAZA ${m2(dailyOutgoing?.base?.m2)} • TRANSPORT ${m2(dailyOutgoing?.transport?.m2)}`} />
              <Metric label="NETO m²" value={m2(dailyNetM2)} tone={dailyNetM2 < 0 ? 'bad' : 'info'} sub="Hyrë minus dalë" />
              <Metric label="NË PASTRIM" value={m2(dailyPastrimM2)} tone="warn" sub={`${n(dailyCurrent?.pastrim?.count)} porosi`} />
              <Metric label="GATI" value={m2(dailyGatiM2)} tone="ok" sub={`${n(dailyCurrent?.gati?.count)} porosi`} />
            </div>
          </Card>
        ) : null}

        {showClosedReceiptOnly ? (
          <Receipt cycle={activeReceiptCycle} items={activeReceiptItems} onRefresh={() => void loadPreview({ force: true })} />
        ) : preview ? (
          <>
            {isClosed && hasLiveWizardWork ? (
              <Alert tone="warn">
                RAPORTI I DITËS ËSHTË FINALIZUAR MË HERËT, POR KA DORËZIME OSE DALJE TË REJA. WIZARD-I ËSHTË RIHAPUR; PRANOJI DHE FINALIZOJE RAPORTIN PËRSËRI.
              </Alert>
            ) : null}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,minmax(0,1fr))', gap: 6 }}>
              <StepPill index={1} title="DORËZIMET" current={step} done={step > 1} onClick={() => setStep(1)} />
              <StepPill index={2} title="DALJET" current={step} done={step > 2} onClick={() => step > 1 && setStep(2)} />
              <StepPill index={3} title="NUMËRIMI" current={step} done={step > 3} onClick={() => step > 2 && setStep(3)} />
              <StepPill index={4} title="MBYLLJA" current={step} done={false} onClick={() => dryRun && setStep(4)} />
            </div>

            {step === 1 ? (
              <div style={{ display: 'grid', gap: 12 }}>
                <Card tone="info">
                  <div style={{ fontSize: 15, fontWeight: 1000 }}>1. KONTROLLO DORËZIMET</div>
                  <div style={{ color: palette.muted, fontSize: 11, lineHeight: 1.45, fontWeight: 750 }}>Për secilin punëtor shëno “I MORA”. Vetëm dorëzimet e konfirmuara hyjnë në buxhet.</div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(145px,1fr))', gap: 8 }}>
                    <Metric label="BUXHETI PARA MBYLLJES" value={money(currentBudget)} tone="strong" />
                    <Metric label="DORËZIME TË ZGJEDHURA" value={money(selectedTotal)} tone="ok" sub={`${selectedHandoffs.length} dorëzime`} />
                    <Metric label="PRITET PAS PRANIMIT" value={money(expectedCash)} tone="info" />
                  </div>
                </Card>

                <Card>
                  <div style={{ fontSize: 13, fontWeight: 1000 }}>DORËZIME NË PRITJE</div>
                  {pendingHandoffs.length ? pendingHandoffs.map((row) => {
                    const id = Number(row?.id);
                    const selected = selectedSet.has(id);
                    const confirmed = confirmedIds[String(id)] === true;
                    return (
                      <Row
                        key={`pending_handoff_${id}`}
                        title={`${upper(row?.worker_name || row?.worker_pin)} • DORËZIM #${id}`}
                        meta={`${n(row?.item_count)} pagesa • dërguar ${stamp(row?.submitted_at)}${row?.note ? ` • ${row.note}` : ''}`}
                        amount={money(row?.amount)}
                        tone={selected && confirmed ? 'ok' : selected ? 'warn' : 'neutral'}
                      >
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                          <button type="button" onClick={() => toggleSelected(id)} style={{ ...secondaryButtonStyle, background: selected ? 'rgba(37,99,235,.24)' : 'rgba(51,65,85,.52)', color: selected ? '#dbeafe' : '#cbd5e1' }}>
                            {selected ? '✓ PËRFSHIJE' : 'MOS E PËRFSHI'}
                          </button>
                          <button type="button" disabled={!selected} onClick={() => toggleConfirmed(id)} style={{ ...secondaryButtonStyle, opacity: selected ? 1 : .45, background: confirmed ? 'rgba(21,128,61,.24)' : 'rgba(120,53,15,.24)', color: confirmed ? palette.ok : palette.warn }}>
                            {confirmed ? '✓ I MORA' : 'I MORA PARATË'}
                          </button>
                        </div>
                      </Row>
                    );
                  }) : <Alert tone="ok">S’KA DORËZIME TË REJA NË PRITJE. Mund ta mbyllësh ditën vetëm me numërimin fizik.</Alert>}
                </Card>

                {receivedToday.length ? (
                  <Card tone="ok">
                    <div style={{ fontSize: 13, fontWeight: 1000 }}>TASHMË TË PRANUARA SOT</div>
                    {receivedToday.map((row) => (
                      <Row key={`received_${row?.handoff_id || row?.id}`} title={upper(row?.worker_name || row?.worker_pin)} meta={`DORËZIM #${row?.handoff_id || row?.id} • ${stamp(row?.accepted_at || row?.created_at)}`} amount={money(row?.amount)} tone="ok" />
                    ))}
                  </Card>
                ) : null}

                <Card tone="warn">
                  <div style={{ fontSize: 13, fontWeight: 1000 }}>PARA ENDE TE PUNËTORËT</div>
                  {rows(preview?.open_cash_at_workers).length ? rows(preview?.open_cash_at_workers).map((row) => (
                    <Row key={`open_worker_${row?.worker_pin}`} title={upper(row?.worker_name || row?.worker_pin)} meta={`${n(row?.payment_count)} pagesa të hapura • nuk hyjnë në box sot`} amount={money(row?.amount)} tone="warn" />
                  )) : <div style={{ color: palette.muted, fontSize: 11 }}>S’KA CASH TË HAPUR TE PUNËTORËT.</div>}
                </Card>

                <button type="button" disabled={!everySelectedConfirmed} onClick={goNextFromHandoffs} style={{ ...primaryButtonStyle, opacity: everySelectedConfirmed ? 1 : .52 }}>
                  VAZHDO TE DALJET →
                </button>
              </div>
            ) : null}

            {step === 2 ? (
              <div style={{ display: 'grid', gap: 12 }}>
                {/* ARKA_DAILY_EXPENSE_STEP_V1: Step 2 is an operational expense console, not a dead-end warning. */}
                <Card tone={pendingExpenseCount ? 'bad' : 'info'}>
                  <div style={{ fontSize: 15, fontWeight: 1000 }}>2. KONTROLLO DALJET NGA BOXHI</div>
                  <div style={{ color: palette.muted, fontSize: 11, lineHeight: 1.45, fontWeight: 750 }}>
                    Shiko çdo kërkesë, pranoje si shpenzim biznesi, ktheje në avans ose refuzoje. Mund të shtosh edhe shpenzim të ri para numërimit.
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 8 }}>
                    <Metric label="SHPENZIME TË POSTUARA" value={money(preview?.today_expenses?.total)} tone="bad" sub={`${n(preview?.today_expenses?.count)} rreshta`} />
                    <Metric label="AVANSE TË POSTUARA" value={money(preview?.today_advances?.total)} tone="warn" sub={`${n(preview?.today_advances?.count)} rreshta`} />
                    <Metric label="SHPENZIME NË PRITJE" value={money(preview?.pending_expenses_total)} tone={pendingExpenseCount ? 'bad' : 'ok'} sub={`${pendingExpenseCount} kërkesa`} />
                  </div>
                  {pendingExpenseCount ? (
                    <Alert tone="bad">Vendosi kërkesat më poshtë. Sapo të mbesin 0 në pritje, hapet automatikisht “VAZHDO TE NUMËRIMI”.</Alert>
                  ) : <Alert tone="ok">Krejt daljet janë vendosur dhe janë reflektuar në buxhet. Mund të vazhdosh te numërimi.</Alert>}
                  {expenseActionMessage ? <Alert tone="ok">{expenseActionMessage}</Alert> : null}
                </Card>

                <Card tone={newExpenseOpen ? 'warn' : 'info'}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 1000 }}>SHTO SHPENZIM TË RI</div>
                      <div style={{ marginTop: 3, color: palette.muted, fontSize: 10.5, lineHeight: 1.35, fontWeight: 750 }}>Përdore kur paratë kanë dalë realisht nga boxhi.</div>
                    </div>
                    <button type="button" disabled={newExpenseBusy || !!expenseActionBusy} onClick={() => newExpenseOpen ? setNewExpenseOpen(false) : openNewExpenseForm()} style={secondaryButtonStyle}>
                      {newExpenseOpen ? 'MBYLLE' : '+ SHTO SHPENZIM'}
                    </button>
                  </div>

                  {newExpenseOpen ? (
                    <div style={{ display: 'grid', gap: 9, border: '1px solid rgba(245,158,11,.34)', borderRadius: 14, background: 'rgba(120,53,15,.14)', padding: 11 }}>
                      <label style={{ display: 'grid', gap: 6 }}>
                        <span style={{ fontSize: 10, fontWeight: 1000, color: palette.warn }}>SHUMA €</span>
                        <input
                          inputMode="decimal"
                          value={newExpenseAmount}
                          onChange={(event) => setNewExpenseAmount(event.target.value)}
                          placeholder="0.00"
                          style={{ width: '100%', boxSizing: 'border-box', border: '1px solid rgba(245,158,11,.42)', borderRadius: 12, padding: 12, background: '#0f172a', color: '#fff', fontSize: 18, fontWeight: 1000, outline: 'none' }}
                        />
                      </label>
                      <label style={{ display: 'grid', gap: 6 }}>
                        <span style={{ fontSize: 10, fontWeight: 1000, color: palette.warn }}>PËRSHKRIMI</span>
                        <textarea
                          rows={3}
                          value={newExpenseNote}
                          onChange={(event) => setNewExpenseNote(event.target.value)}
                          placeholder="P.sh. naftë, material, servis, kompensim klienti..."
                          style={{ width: '100%', boxSizing: 'border-box', border: '1px solid rgba(245,158,11,.32)', borderRadius: 12, padding: 12, background: '#0f172a', color: '#fff', fontSize: 12, lineHeight: 1.4, fontWeight: 750, resize: 'vertical' }}
                        />
                      </label>
                      <button type="button" disabled={newExpenseBusy || !!expenseActionBusy} onClick={() => void createDailyExpense()} style={{ ...primaryButtonStyle, opacity: newExpenseBusy || expenseActionBusy ? .55 : 1, background: 'linear-gradient(135deg,#9a3412,#ea580c)' }}>
                        {newExpenseBusy ? 'DUKE RUAJTUR...' : 'REGJISTRO DHE ZBRITE NGA BUXHETI'}
                      </button>
                    </div>
                  ) : null}
                </Card>

                <Card tone={pendingExpenseCount ? 'bad' : 'ok'}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <div style={{ fontSize: 13, fontWeight: 1000 }}>SHPENZIMET NË PRITJE</div>
                    <button type="button" disabled={refreshing || newExpenseBusy || !!expenseActionBusy} onClick={() => void loadPreview({ force: true })} style={secondaryButtonStyle}>RIFRESKO LISTËN</button>
                  </div>
                  {pendingExpenses.length ? pendingExpenses.map((expense) => {
                    const expenseId = Number(expense?.id || 0);
                    const busy = String(expenseActionBusy) === String(expenseId);
                    return (
                      <Row
                        key={`pending_expense_${expenseId}`}
                        title={cleanExpenseNote(expense?.note)}
                        meta={`${upper(expense?.created_by_name || expense?.created_by_pin || 'PA PUNËTOR')} • ${stamp(expense?.created_at)} • KËRKESA #${expenseId}`}
                        amount={money(expense?.amount)}
                        tone="bad"
                      >
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(125px,1fr))', gap: 7 }}>
                          <button type="button" disabled={busy || newExpenseBusy || (!!expenseActionBusy && !busy)} onClick={() => void resolvePendingExpense(expense, 'BUSINESS_EXPENSE')} style={{ ...secondaryButtonStyle, background: 'rgba(21,128,61,.24)', color: palette.ok, opacity: busy ? .6 : 1 }}>
                            {busy ? 'DUKE VENDOSUR...' : 'PRANO BIZNES'}
                          </button>
                          <button type="button" disabled={busy || newExpenseBusy || (!!expenseActionBusy && !busy)} onClick={() => void resolvePendingExpense(expense, 'PERSONAL_ADVANCE')} style={{ ...secondaryButtonStyle, background: 'rgba(120,53,15,.24)', color: palette.warn, opacity: busy ? .6 : 1 }}>
                            KTHE NË AVANS
                          </button>
                          <button type="button" disabled={busy || newExpenseBusy || (!!expenseActionBusy && !busy)} onClick={() => void resolvePendingExpense(expense, 'REJECTED_OPEN_CASH')} style={{ ...secondaryButtonStyle, background: 'rgba(127,29,29,.24)', color: palette.bad, opacity: busy ? .6 : 1 }}>
                            REFUZO
                          </button>
                        </div>
                      </Row>
                    );
                  }) : <Alert tone="ok">S’KA SHPENZIME NË PRITJE.</Alert>}
                </Card>

                <Card>
                  <div style={{ fontSize: 13, fontWeight: 1000 }}>SHPENZIMET E POSTUARA SOT</div>
                  {postedExpenseRows.length ? postedExpenseRows.map((row) => (
                    <Row key={`expense_${row?.id}`} title={upper(row?.description || row?.category)} meta={`${stamp(row?.created_at)} • LEDGER #${row?.id}`} amount={`-${money(row?.amount)}`} tone="bad" />
                  )) : <div style={{ color: palette.muted, fontSize: 11 }}>S’KA SHPENZIME TË POSTUARA SOT.</div>}
                </Card>

                <Card>
                  <div style={{ fontSize: 13, fontWeight: 1000 }}>AVANSET E POSTUARA SOT</div>
                  {postedAdvanceRows.length ? postedAdvanceRows.map((row) => (
                    <Row key={`advance_${row?.id}`} title={upper(row?.description || 'AVANS')} meta={`${stamp(row?.created_at)} • LEDGER #${row?.id}`} amount={`-${money(row?.amount)}`} tone="warn" />
                  )) : <div style={{ color: palette.muted, fontSize: 11 }}>S’KA AVANSE TË POSTUARA SOT.</div>}
                </Card>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  <button type="button" disabled={newExpenseBusy || !!expenseActionBusy} onClick={() => setStep(1)} style={secondaryButtonStyle}>← DORËZIMET</button>
                  <button type="button" disabled={pendingExpenseCount > 0 || newExpenseBusy || !!expenseActionBusy} onClick={goNextFromOutgoings} style={{ ...primaryButtonStyle, opacity: pendingExpenseCount > 0 || newExpenseBusy || expenseActionBusy ? .52 : 1 }}>
                    {pendingExpenseCount > 0 ? `VENDOS EDHE ${pendingExpenseCount} KËRKESA` : 'VAZHDO TE NUMËRIMI →'}
                  </button>
                </div>
              </div>
            ) : null}

            {step === 3 ? (
              <div style={{ display: 'grid', gap: 12 }}>
                <Card tone="info">
                  <div style={{ fontSize: 15, fontWeight: 1000 }}>3. NUMËRO PARATË FIZIKISHT</div>
                  <div style={{ color: palette.muted, fontSize: 11, lineHeight: 1.45, fontWeight: 750 }}>Numëro krejt paratë që janë realisht në box pasi i ke marrë dorëzimet e zgjedhura.</div>
                  <div style={{ display: 'grid', gap: 7 }}>
                    <Row title="BUXHETI PARA MBYLLJES" amount={money(currentBudget)} />
                    <Row title="+ DORËZIMET E KONFIRMUARA" amount={money(selectedTotal)} tone="ok" />
                    <Row title="= DUHET TË JENË NË BOX" amount={money(expectedCash)} tone="info" />
                  </div>
                  <label style={{ display: 'grid', gap: 7 }}>
                    <span style={{ fontSize: 11, fontWeight: 1000, color: palette.info }}>SHUMA U VENDOS AUTOMATIKISHT — NDRYSHOJE VETËM NËSE CASH-I FIZIK NUK PËRPUTHET</span>
                    <input
                      inputMode="decimal"
                      value={countedCash}
                      onChange={(event) => { countedCashManualRef.current = true; setCountedCash(event.target.value); setDryRun(null); setFinalConfirm(false); }}
                      placeholder={expectedCash.toFixed(2)}
                      style={{ width: '100%', boxSizing: 'border-box', border: '1px solid rgba(96,165,250,.48)', borderRadius: 14, padding: '15px 13px', background: '#0f172a', color: '#fff', fontSize: 24, fontWeight: 1000, outline: 'none' }}
                    />
                  </label>
                  {countedValue != null ? (
                    <Metric
                      label={Math.abs(discrepancy || 0) <= .01 ? 'PËRPUTHJE' : discrepancy < 0 ? 'MUNGESË' : 'TEPRICË'}
                      value={money(discrepancy || 0)}
                      tone={Math.abs(discrepancy || 0) <= .01 ? 'ok' : 'warn'}
                      sub={`Numëruar ${money(countedValue)} • Pritej ${money(expectedCash)}`}
                    />
                  ) : null}
                </Card>

                {hasDiscrepancy ? (
                  <Card tone="warn">
                    <div style={{ fontSize: 13, fontWeight: 1000 }}>SHPJEGO DIFERENCËN</div>
                    <select value={reason} onChange={(event) => { setReason(event.target.value); setDryRun(null); }} style={{ width: '100%', border: `1px solid ${palette.line}`, borderRadius: 12, padding: 12, background: '#0f172a', color: '#fff', fontWeight: 900, colorScheme: 'dark' }}>
                      <option value="">ZGJIDH ARSYEN</option>
                      {REASONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                    </select>
                    <textarea value={note} onChange={(event) => { setNote(event.target.value); setDryRun(null); }} rows={4} placeholder="Shkruaj çka ka ndodhur, kujt i janë dhënë paratë ose çka duhet hetuar..." style={{ width: '100%', boxSizing: 'border-box', border: `1px solid ${palette.line}`, borderRadius: 12, padding: 12, background: '#0f172a', color: '#fff', fontSize: 12, lineHeight: 1.45, fontWeight: 750, resize: 'vertical' }} />
                    <Alert>Diferenca ruhet në ledger dhe në raportin ditor. Buxheti final barazohet me shumën e numëruar fizikisht.</Alert>
                  </Card>
                ) : null}

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  <button type="button" onClick={() => setStep(2)} style={secondaryButtonStyle}>← DALJET</button>
                  <button type="button" disabled={submitting || countedValue == null} onClick={() => void runServerCheck()} style={{ ...primaryButtonStyle, opacity: submitting || countedValue == null ? .52 : 1 }}>{submitting ? 'DUKE KONTROLLUAR...' : 'KONTROLLO NË SERVER →'}</button>
                </div>
              </div>
            ) : null}

            {step === 4 && dryRun ? (
              <div style={{ display: 'grid', gap: 12 }}>
                <Card tone={Math.abs(n(dryRun?.discrepancy)) <= .01 ? 'ok' : 'warn'}>
                  <div style={{ fontSize: 15, fontWeight: 1000 }}>4. KONFIRMIMI FINAL</div>
                  <div style={{ color: palette.muted, fontSize: 11, lineHeight: 1.45, fontWeight: 750 }}>Serveri e ka verifikuar listën. Pas konfirmimit, dorëzimet hyjnë në buxhet dhe dita mbyllet.</div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(145px,1fr))', gap: 8 }}>
                    <Metric label="BUXHETI PARA" value={money(dryRun?.budget_before)} tone="strong" />
                    <Metric label="DORËZIMET QË HYJNË" value={money(dryRun?.selected_handoffs_total)} tone="ok" sub={`${rows(dryRun?.selected_handoff_ids).length} dorëzime`} />
                    <Metric label="PRITEJ" value={money(dryRun?.expected_cash)} tone="info" />
                    <Metric label="NUMËRUAR" value={money(dryRun?.counted_cash)} tone="strong" />
                    <Metric label="DIFERENCA" value={money(dryRun?.discrepancy)} tone={Math.abs(n(dryRun?.discrepancy)) <= .01 ? 'ok' : 'warn'} />
                    <Metric label="BUXHETI FINAL" value={money(dryRun?.counted_cash)} tone="ok" />
                  </div>
                  {Math.abs(n(dryRun?.discrepancy)) > .01 ? <Alert><b>{n(dryRun?.discrepancy) < 0 ? 'MUNGESË' : 'TEPRICË'} {money(Math.abs(n(dryRun?.discrepancy)))}</b><br />{upper(reason)} • {note}</Alert> : <Alert tone="ok">Përputhje e plotë. Diferenca është 0.00 €.</Alert>}
                </Card>

                <label style={{ border: '1px solid rgba(96,165,250,.35)', borderRadius: 14, background: 'rgba(30,64,175,.16)', padding: 13, display: 'grid', gridTemplateColumns: 'auto 1fr', gap: 10, alignItems: 'start', cursor: 'pointer' }}>
                  <input type="checkbox" checked={finalConfirm} onChange={(event) => setFinalConfirm(event.target.checked)} style={{ width: 22, height: 22 }} />
                  <span style={{ fontSize: 12, lineHeight: 1.45, fontWeight: 900, color: '#dbeafe' }}>I KAM NUMËRUAR PARATË, I KAM KONTROLLUAR DORËZIMET DHE E KONFIRMOJ MBYLLJEN E DITËS.</span>
                </label>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  <button type="button" disabled={submitting} onClick={() => { setStep(3); setDryRun(null); setFinalConfirm(false); }} style={secondaryButtonStyle}>← KORRIGJO</button>
                  <button type="button" disabled={submitting || !finalConfirm} onClick={() => void closeDay()} style={{ ...primaryButtonStyle, opacity: submitting || !finalConfirm ? .52 : 1, background: 'linear-gradient(135deg,#166534,#16a34a)' }}>{submitting ? 'DUKE MBYLLUR...' : 'MBYLL DITËN DHE BARAZO BUXHETIN'}</button>
                </div>
              </div>
            ) : null}
          </>
        ) : null}
      </main>
    </div>
  );
}
