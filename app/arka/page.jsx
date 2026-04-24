'use client';

import Link from 'next/link';
import LocalErrorBoundary from '@/components/LocalErrorBoundary';
import { useEffect, useMemo, useRef, useState } from 'react';
import { getActor } from '@/lib/actorSession';
import { fetchSessionUserByPin } from '@/lib/usersService';
import useRouteAlive from '@/lib/routeAlive';
import { bootLog, bootMarkReady } from '@/lib/bootLog';
import { getStartupIsolationLeftMs, isWithinStartupIsolationWindow } from '@/lib/startupIsolation';
import {
  approveExpenseEntry,
  createExpenseEntry,
  createMealDistributionEntry,
  isExtraSettled,
  listCashHandoffRecords,
  listMealStaffOptions,
  listPendingExpenseApprovals,
  listPendingPaymentRecords,
  listTodayWorkers,
  listWorkerArkaExtras,
  listWorkerHandoffs,
  listWorkerPendingPayments,
  rejectExpenseEntry,
} from '@/lib/arkaService';
import {
  acceptDispatchHandoff,
  listPendingDispatchHandoffs,
  rejectDispatchHandoff,
  submitWorkerCashToDispatch,
} from '@/lib/corporateFinance';

const MONEY = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const WORKER_PAYMENTS_LIMIT = 80;
const WORKER_EXTRAS_LIMIT = 80;
const WORKER_HANDOFFS_LIMIT = 80;
const MANAGER_SECONDARY_LIMIT = 40;
const RELOAD_MIN_GAP_MS = 1800;
const LIFECYCLE_RELOAD_GAP_MS = 2600;
const PRIMARY_STALE_MS = 45000;
const SECONDARY_STALE_MS = 12000;
const ERROR_COOLDOWN_MS = 8000;
const MUTATION_COOLDOWN_MS = 2600;
const MUTATION_PRIMARY_DELAY_MS = 1400;
const INITIAL_MANAGER_SECONDARY_DELAY_MS = 1400;
const FOOD_DEDUCTION = 3;
const EXTRA_TYPES = new Set(['TIMA', 'EXPENSE', 'MEAL_PAYMENT', 'MEAL_COVERED']);
const NON_PAYMENT_STATUSES = new Set(['OWED', 'REJECTED', 'WORKER_DEBT', 'ADVANCE', 'PENDING_DISPATCH_APPROVAL', 'ACCEPTED_BY_DISPATCH']);
const MANAGER_PAYMENT_SELECT = 'id,amount,type,status,created_at,updated_at,created_by_pin,handed_by_pin,handoff_note';
const MANAGER_HANDOFF_SELECT = 'id,amount,status,worker_pin,worker_name,submitted_at,decided_at,note';
const MANAGER_PENDING_HANDOFF_SELECT = 'id,amount,status,worker_pin,worker_name,submitted_at,note';
const MANAGER_PENDING_EXPENSE_SELECT = 'id,amount,type,status,note,created_at,created_by_pin,created_by_name';
const ARKA_MANAGER_CACHE_KEY = 'tepiha_arka_manager_cache_v1';
const ARKA_WORKER_CACHE_PREFIX = 'tepiha_arka_worker_cache_v1:';

function euro(v) {
  return `€${MONEY.format(Number(v || 0) || 0)}`;
}
function n(v) {
  const x = Number(v || 0);
  return Number.isFinite(x) ? x : 0;
}
function parseAmountInput(v) {
  const raw = String(v ?? '').trim().replace(/\s/g, '').replace(',', '.');
  return n(raw);
}
function safeUpper(v) {
  return String(v || '').trim().toUpperCase();
}
function fmtDate(v) {
  if (!v) return '—';
  try {
    return new Date(v).toLocaleString('sq-AL', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '—';
  }
}
function byDateDesc(a, b) {
  return String(b?.created_at || b?.submitted_at || b?.decided_at || b?.updated_at || '').localeCompare(
    String(a?.created_at || a?.submitted_at || a?.decided_at || a?.updated_at || '')
  );
}
function roleIsWorker(role) {
  return ['PUNTOR', 'PUNETOR', 'WORKER', 'TRANSPORT'].includes(safeUpper(role));
}
function roleCanManage(role) {
  return ['DISPATCH', 'ADMIN', 'ADMIN_MASTER', 'OWNER', 'PRONAR', 'SUPERADMIN'].includes(safeUpper(role));
}
function isArkaRouteActive() {
  try {
    if (typeof window === 'undefined') return true;
    const path = String(window.location?.pathname || '');
    return path === '/arka' || path.startsWith('/arka/');
  } catch {
    return true;
  }
}

function isOfflineBrowser() {
  try {
    return typeof navigator !== 'undefined' && navigator.onLine === false;
  } catch {
    return false;
  }
}

function readStoredJson(key) {
  try {
    if (typeof window === 'undefined') return null;
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function writeStoredJson(key, value) {
  try {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}
function getWorkerArkaCacheKey(pin) {
  return `${ARKA_WORKER_CACHE_PREFIX}${String(pin || '').trim()}`;
}
function mergeStoredJson(key, patch) {
  const prev = readStoredJson(key);
  const next = {
    ...(prev && typeof prev === 'object' ? prev : {}),
    ...(patch && typeof patch === 'object' ? patch : {}),
    ts: Date.now(),
  };
  writeStoredJson(key, next);
  return next;
}
function scheduleIdleTask(task, delayMs = 0, timeoutMs = 1600) {
  try {
    if (typeof window === 'undefined' || typeof task !== 'function') return () => {};
    let cancelled = false;
    let timerId = 0;
    let idleId = 0;
    const run = () => {
      if (cancelled) return;
      if (typeof window.requestIdleCallback === 'function') {
        idleId = window.requestIdleCallback(() => {
          idleId = 0;
          if (cancelled) return;
          task();
        }, { timeout: timeoutMs });
        return;
      }
      idleId = window.setTimeout(() => {
        idleId = 0;
        if (cancelled) return;
        task();
      }, 0);
    };
    timerId = window.setTimeout(() => {
      timerId = 0;
      run();
    }, Math.max(0, Number(delayMs || 0) || 0));
    return () => {
      cancelled = true;
      try { if (timerId) window.clearTimeout(timerId); } catch {}
      try {
        if (idleId && typeof window.cancelIdleCallback === 'function') window.cancelIdleCallback(idleId);
        else if (idleId) window.clearTimeout(idleId);
      } catch {}
    };
  } catch {
    return () => {};
  }
}
function mergeStoredJsonDeferred(key, patch, delayMs = 140) {
  return scheduleIdleTask(() => {
    try { mergeStoredJson(key, patch); } catch {}
  }, delayMs);
}
function reconcileActorWithUser(actor, userRow) {
  if (!actor) return actor;
  if (!userRow || typeof userRow !== 'object') return actor;
  const next = {
    ...actor,
    pin: String(userRow?.pin || actor?.pin || '').trim(),
    name: String(userRow?.name || actor?.name || '').trim(),
    role: String(userRow?.role || actor?.role || '').trim(),
    user_id: userRow?.id || actor?.user_id || actor?.id || null,
    id: userRow?.id || actor?.id || actor?.user_id || null,
    is_hybrid_transport: userRow?.is_hybrid_transport === true,
    transport_id: userRow?.transport_id || actor?.transport_id || null,
  };
  return next;
}
function persistActorRepair(nextActor) {
  try {
    if (typeof window === 'undefined' || !nextActor?.pin) return;
    writeStoredJson('CURRENT_USER_DATA', nextActor);
    const session = readStoredJson('tepiha_session_v1');
    if (session && typeof session === 'object') {
      writeStoredJson('tepiha_session_v1', { ...session, actor: nextActor, user: nextActor });
    }
  } catch {}
}
function isoDay(v) {
  try {
    return new Date(v || Date.now()).toISOString().slice(0, 10);
  } catch {
    return '';
  }
}
function isToday(v) {
  const now = isoDay(new Date());
  return !!now && isoDay(v) === now;
}
function amountOf(row) {
  return n(row?.amount ?? row?.value ?? row?.total_amount ?? row?.sum);
}
function statusOf(row) {
  return safeUpper(row?.status);
}
function typeOf(row) {
  return safeUpper(row?.type);
}
function mapUniqueById(rows = []) {
  const out = [];
  const seen = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row) continue;
    const key = String(row?.id || `${row?.created_at || ''}_${row?.submitted_at || ''}_${row?.worker_pin || ''}_${row?.created_by_pin || ''}_${row?.amount || ''}_${row?.type || ''}_${row?.status || ''}`);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function pushRowToGroup(map, key, row) {
  const cleanKey = String(key || '').trim();
  if (!cleanKey || !row) return;
  const current = map.get(cleanKey) || [];
  current.push(row);
  map.set(cleanKey, current);
}

function calcBulkLimit(pinCount, perPin, floor = 120, ceiling = 1600) {
  const total = Math.max(floor, (Number(pinCount || 0) || 0) * (Number(perPin || 0) || 0));
  return Math.min(ceiling, total);
}

async function loadManagerBulkSnapshots(workerRows = []) {
  const workers = Array.isArray(workerRows) ? workerRows : [];
  const pins = workers
    .map((row) => String(row?.pin || '').trim())
    .filter(Boolean);

  const uniquePins = [...new Set(pins)];
  const paymentsByPin = new Map();
  const extrasByPin = new Map();
  const handoffsByPin = new Map();
  let hadErrors = false;

  if (!uniquePins.length) {
    return { paymentsByPin, extrasByPin, handoffsByPin, hadErrors };
  }

  const paymentsLimit = calcBulkLimit(uniquePins.length, 48, 180, 960);
  const extrasLimit = calcBulkLimit(uniquePins.length, 24, 120, 480);
  const handoffsLimit = calcBulkLimit(uniquePins.length, 12, 80, 320);

  const swallowToEmpty = (label, err) => {
    hadErrors = true;
    try { console.error(`[ARKA] ${label} failed, switching to local cache if available:`, err); } catch {}
    return [];
  };

  const [paymentRows, extraCreatedRows, extraTargetedRows, handoffRows] = await Promise.all([
    listPendingPaymentRecords({
      select: MANAGER_PAYMENT_SELECT,
      in: { created_by_pin: uniquePins },
      orderBy: 'created_at',
      ascending: false,
      limit: paymentsLimit,
    }).catch((err) => swallowToEmpty('payments', err)),
    listPendingPaymentRecords({
      select: MANAGER_PAYMENT_SELECT,
      in: { type: ['TIMA', 'EXPENSE', 'MEAL_PAYMENT', 'MEAL_COVERED'], created_by_pin: uniquePins },
      orderBy: 'created_at',
      ascending: false,
      limit: extrasLimit,
    }).catch((err) => swallowToEmpty('extras_created', err)),
    listPendingPaymentRecords({
      select: MANAGER_PAYMENT_SELECT,
      in: { type: ['TIMA', 'EXPENSE', 'MEAL_PAYMENT', 'MEAL_COVERED'], handed_by_pin: uniquePins },
      orderBy: 'created_at',
      ascending: false,
      limit: extrasLimit,
    }).catch((err) => swallowToEmpty('extras_targeted', err)),
    listCashHandoffRecords({
      select: MANAGER_HANDOFF_SELECT,
      in: { worker_pin: uniquePins },
      orderBy: 'submitted_at',
      ascending: false,
      limit: handoffsLimit,
    }).catch((err) => swallowToEmpty('handoffs', err)),
  ]);

  for (const row of Array.isArray(paymentRows) ? paymentRows : []) {
    pushRowToGroup(paymentsByPin, row?.created_by_pin, row);
  }
  for (const row of Array.isArray(extraCreatedRows) ? extraCreatedRows : []) {
    pushRowToGroup(extrasByPin, row?.created_by_pin, row);
  }
  for (const row of Array.isArray(extraTargetedRows) ? extraTargetedRows : []) {
    pushRowToGroup(extrasByPin, row?.handed_by_pin, row);
  }
  for (const row of Array.isArray(handoffRows) ? handoffRows : []) {
    pushRowToGroup(handoffsByPin, row?.worker_pin, row);
  }

  return { paymentsByPin, extrasByPin, handoffsByPin, hadErrors };
}
function isRealPaymentRow(row) {
  const type = typeOf(row);
  const status = statusOf(row);
  if (EXTRA_TYPES.has(type)) return false;
  if (NON_PAYMENT_STATUSES.has(status)) return false;
  return ['PENDING', 'COLLECTED'].includes(status);
}
function isOpenExtraRow(row) {
  const type = typeOf(row);
  const status = statusOf(row);
  if (!EXTRA_TYPES.has(type)) return false;
  if (['REJECTED', 'REFUZUAR'].includes(status)) return false;
  if (isExtraSettled(row)) return false;
  return true;
}
function getHybridCommission(worker) {
  return n(worker?.hybrid_commission_today ?? worker?.hybrid_commission ?? worker?.commission_amount ?? 0);
}
function summarizeArkaCore({ worker, paymentRows = [], extraRows = [], handoffRows = [] }) {
  const payments = mapUniqueById(paymentRows).filter(isRealPaymentRow).sort(byDateDesc);
  const pendingRows = payments.filter((row) => statusOf(row) === 'PENDING');
  const collectedRows = payments.filter((row) => statusOf(row) === 'COLLECTED');
  const paymentTotal = payments.reduce((sum, row) => sum + amountOf(row), 0);
  const pendingTotal = pendingRows.reduce((sum, row) => sum + amountOf(row), 0);
  const collectedTotal = collectedRows.reduce((sum, row) => sum + amountOf(row), 0);

  const extras = mapUniqueById(extraRows).filter(isOpenExtraRow).sort(byDateDesc);
  const timaRows = extras.filter((row) => typeOf(row) === 'TIMA' && statusOf(row) === 'ACCEPTED_BY_DISPATCH');
  const expenseRows = extras.filter((row) => typeOf(row) === 'EXPENSE');
  const mealPaymentRows = extras.filter((row) => typeOf(row) === 'MEAL_PAYMENT');
  const mealCoveredRows = extras.filter((row) => typeOf(row) === 'MEAL_COVERED');

  const timaTotal = timaRows.reduce((sum, row) => sum + amountOf(row), 0);
  const expenseTotal = expenseRows.reduce((sum, row) => sum + amountOf(row), 0);
  const mealTotal = mealPaymentRows.reduce((sum, row) => sum + amountOf(row), 0);
  const hybridCommission = getHybridCommission(worker);

  const handoffs = mapUniqueById(handoffRows).sort(byDateDesc);
  const deliveredRows = handoffs.filter((row) => statusOf(row) === 'ACCEPTED');
  const pendingHandoffRows = handoffs.filter((row) => statusOf(row) === 'PENDING_DISPATCH_APPROVAL');
  const deliveredTotal = deliveredRows.reduce((sum, row) => sum + amountOf(row), 0);

  const dueTotal = Math.max(0, paymentTotal + timaTotal - expenseTotal - mealTotal - hybridCommission);
  const hasTodayBasePayment = payments.some((row) => isToday(row?.created_at));

  let status = 'PA LËVIZJE';
  let tone = 'idle';
  if (pendingHandoffRows.length) {
    status = 'NË PRITJE';
    tone = 'warn';
  } else if (dueTotal > 0) {
    status = 'PËR DORËZIM';
    tone = 'info';
  } else if (deliveredTotal > 0) {
    status = 'DORËZUAR';
    tone = 'ok';
  }

  return {
    worker,
    paymentRows: payments,
    pendingRows,
    collectedRows,
    extraRows: extras,
    timaRows,
    expenseRows,
    mealPaymentRows,
    mealCoveredRows,
    handoffRows: handoffs,
    deliveredRows,
    pendingHandoffRows,
    paymentTotal,
    pendingTotal,
    collectedTotal,
    timaTotal,
    expenseTotal,
    mealTotal,
    deliveredTotal,
    hybridCommission,
    dueTotal,
    hasTodayBasePayment,
    status,
    tone,
  };
}

function ArkaPanelBoundary({ name, children }) {
  return (
    <LocalErrorBoundary
      boundaryKind="panel"
      routePath="/arka"
      routeName="ARKA"
      moduleName={name}
      componentName={name}
      sourceLayer="arka_panel"
      showHome={false}
    >
      {children}
    </LocalErrorBoundary>
  );
}

function Stat({ label, value, tone = 'neutral', small = false, sub = '' }) {
  return (
    <div className={`arkaMiniStat ${tone} ${small ? 'small' : ''}`}>
      <div className="arkaMiniStatLabel">{label}</div>
      <div className="arkaMiniStatValue">{value}</div>
      {sub ? <div className="arkaMiniStatSub">{sub}</div> : null}
    </div>
  );
}

function HistoryRow({ title, meta, amount, tone = 'neutral', rightText = '' }) {
  return (
    <div className="arkaHistoryRow">
      <div>
        <div className="arkaHistoryTitle">{title}</div>
        <div className="arkaHistoryMeta">{meta}</div>
      </div>
      <div style={{ textAlign: 'right' }}>
        <div className="arkaHistoryAmount">{amount}</div>
        {rightText ? <div className={`arkaHistoryMeta ${tone}`}>{rightText}</div> : null}
      </div>
    </div>
  );
}

function PendingHandoffRow({ row, actor, onDone }) {
  const [busy, setBusy] = useState('');

  async function handleAccept() {
    try {
      setBusy('accept');
      await acceptDispatchHandoff({ handoffId: row.id, actor });
      await onDone?.(row?.id);
      alert('✅ DORËZIMI U PRANUA.');
    } catch (e) {
      alert(`🔴 ${e?.message || 'NUK U PRANUA DORËZIMI.'}`);
    } finally {
      setBusy('');
    }
  }

  async function handleReject() {
    const note = window.prompt('SHËNIMI I REFUZIMIT', 'KTHEJE DHE KONTROLLO PARATË') || '';
    try {
      setBusy('reject');
      await rejectDispatchHandoff({ handoffId: row.id, actor, note });
      await onDone?.(row?.id);
      alert('✅ DORËZIMI U REFUZUA.');
    } catch (e) {
      alert(`🔴 ${e?.message || 'NUK U REFUZUA DORËZIMI.'}`);
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="arkaPendingRow">
      <div>
        <div className="arkaPendingName">{String(row?.worker_name || row?.worker_pin || 'PUNTOR').toUpperCase()}</div>
        <div className="arkaPendingMeta">{fmtDate(row?.submitted_at)} • {safeUpper(row?.status || 'PENDING')}</div>
      </div>
      <div className="arkaPendingRight">
        <div className="arkaPendingAmount">{euro(row?.amount)}</div>
        <div className="arkaPendingActions">
          <button type="button" className="arkaTinyBtn ok" disabled={!!busy} onClick={handleAccept}>{busy === 'accept' ? '...' : 'PRANO'}</button>
          <button type="button" className="arkaTinyBtn bad" disabled={!!busy} onClick={handleReject}>{busy === 'reject' ? '...' : 'REFUZO'}</button>
        </div>
      </div>
    </div>
  );
}

function PendingExpenseRow({ row, actor, onDone }) {
  const [busy, setBusy] = useState('');

  async function handleApprove() {
    try {
      setBusy('approve');
      await approveExpenseEntry({ requestId: row.id, actor });
      await onDone?.(row?.id);
      alert('✅ SHPENZIMI U PRANUA.');
    } catch (e) {
      alert(`🔴 ${e?.message || 'NUK U PRANUA SHPENZIMI.'}`);
    } finally {
      setBusy('');
    }
  }

  async function handleReject() {
    try {
      setBusy('reject');
      await rejectExpenseEntry({ requestId: row.id, actor });
      await onDone?.(row?.id);
      alert('✅ SHPENZIMI U REFUZUA.');
    } catch (e) {
      alert(`🔴 ${e?.message || 'NUK U REFUZUA SHPENZIMI.'}`);
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="arkaPendingRow">
      <div>
        <div className="arkaPendingName">{String(row?.created_by_name || row?.created_by_pin || 'PUNTOR').toUpperCase()}</div>
        <div className="arkaPendingMeta">{String(row?.note || 'SHPENZIM').toUpperCase()} • {fmtDate(row?.created_at)}</div>
      </div>
      <div className="arkaPendingRight">
        <div className="arkaPendingAmount">{euro(row?.amount)}</div>
        <div className="arkaPendingActions">
          <button type="button" className="arkaTinyBtn ok" disabled={!!busy} onClick={handleApprove}>{busy === 'approve' ? '...' : 'PRANO'}</button>
          <button type="button" className="arkaTinyBtn bad" disabled={!!busy} onClick={handleReject}>{busy === 'reject' ? '...' : 'REFUZO'}</button>
        </div>
      </div>
    </div>
  );
}

function WorkerSummaryCard({ item }) {
  return (
    <div className="arkaWorkerCard">
      <div className="arkaWorkerTop">
        <div>
          <div className="arkaWorkerName">{String(item?.worker?.name || 'PUNTOR').toUpperCase()}</div>
          <div className="arkaWorkerMeta">PIN {item?.worker?.pin || '—'} • {String(item?.worker?.role || 'WORKER').toUpperCase()}</div>
        </div>
        <div className={`arkaWorkerBadge ${item?.tone || 'idle'}`}>{item?.status || 'PA LËVIZJE'}</div>
      </div>
      <div className="arkaWorkerStats">
        <Stat label="PAGESA" value={euro(item?.paymentTotal)} tone="ok" small />
        <Stat label="SHPENZIME" value={euro(item?.expenseTotal)} tone="warn" small />
        <Stat label="TIMA" value={euro(item?.timaTotal)} tone="info" small />
        <Stat label="USHQIM" value={euro(item?.mealTotal)} tone="muted" small />
        <Stat label="DORËZUAR" value={euro(item?.deliveredTotal)} tone="muted" small />
        <Stat label="ME DORËZU" value={euro(item?.dueTotal)} tone="strong" small />
      </div>
      <div className="arkaWorkerFoot">
        <span>PENDING {euro(item?.pendingTotal)}</span>
        <span>COLLECTED {euro(item?.collectedTotal)}</span>
        <Link prefetch={false} href={`/arka/puntor/${encodeURIComponent(item?.worker?.pin || '')}`} className="arkaTopBtn">DETAJET</Link>
      </div>
    </div>
  );
}

export default function ArkaPageV3() {
  useRouteAlive('arka_page');
  const [actor, setActor] = useState(null);
  const [loading, setLoading] = useState(true);
  const [secondaryLoading, setSecondaryLoading] = useState(false);
  const [error, setError] = useState('');
  const [workerSnapshot, setWorkerSnapshot] = useState(null);
  const [workerCards, setWorkerCards] = useState([]);
  const [pendingHandoffs, setPendingHandoffs] = useState([]);
  const [pendingExpenseApprovals, setPendingExpenseApprovals] = useState([]);
  const [mealOptions, setMealOptions] = useState([]);
  const [selectedMealPins, setSelectedMealPins] = useState([]);
  const [expenseTitle, setExpenseTitle] = useState('');
  const [expenseAmount, setExpenseAmount] = useState('');
  const [busy, setBusy] = useState('');

  const reloadInFlightRef = useRef(false);
  const lastReloadAtRef = useRef(0);
  const lifecycleTimerRef = useRef(null);
  const postMutationPrimaryTimerRef = useRef(null);
  const primaryLoadedAtRef = useRef(0);
  const secondaryLoadedAtRef = useRef(0);
  const errorCooldownUntilRef = useRef(0);
  const mutationCooldownUntilRef = useRef(0);
  const busyRef = useRef('');
  const uiReadyMarkedRef = useRef(false);
  const [sessionChecked, setSessionChecked] = useState(false);

  const role = safeUpper(actor?.role);
  const isWorker = roleIsWorker(role);
  const canManage = roleCanManage(role);


  function applyCachedBootState(currentActor = null) {
    const act = currentActor || actor || getActor();
    if (!act?.pin) return false;
    if (roleIsWorker(act?.role) && !roleCanManage(act?.role)) {
      const cached = readStoredJson(getWorkerArkaCacheKey(act.pin));
      if (!cached || typeof cached !== 'object') return false;
      if (cached?.workerSnapshot) setWorkerSnapshot(cached.workerSnapshot || null);
      setMealOptions(Array.isArray(cached?.mealOptions) ? cached.mealOptions : []);
      setPendingHandoffs(Array.isArray(cached?.pendingHandoffs) ? cached.pendingHandoffs : []);
      setPendingExpenseApprovals(Array.isArray(cached?.pendingExpenseApprovals) ? cached.pendingExpenseApprovals : []);
      setLoading(false);
      return true;
    }
    const cached = readStoredJson(ARKA_MANAGER_CACHE_KEY);
    if (!cached || typeof cached !== 'object') return false;
    setWorkerCards(Array.isArray(cached?.workerCards) ? cached.workerCards : []);
    setPendingHandoffs(Array.isArray(cached?.pendingHandoffs) ? cached.pendingHandoffs : []);
    setPendingExpenseApprovals(Array.isArray(cached?.pendingExpenseApprovals) ? cached.pendingExpenseApprovals : []);
    setLoading(false);
    return true;
  }

  useEffect(() => {
    busyRef.current = String(busy || '').trim();
  }, [busy]);

  function clearPostMutationPrimaryTimer() {
    if (postMutationPrimaryTimerRef.current) {
      clearTimeout(postMutationPrimaryTimerRef.current);
      postMutationPrimaryTimerRef.current = null;
    }
  }

  async function scheduleManagerMutationRefresh(currentActor = null) {
    const act = currentActor || actor || getActor();
    mutationCooldownUntilRef.current = Date.now() + MUTATION_COOLDOWN_MS;
    clearPostMutationPrimaryTimer();

    if (roleIsWorker(act?.role) && !roleCanManage(act?.role)) {
      await reloadAll(act, { force: true, source: 'mutation_worker', target: 'all' });
      return;
    }

    await reloadAll(act, { force: true, source: 'mutation_secondary', target: 'secondary' });

    postMutationPrimaryTimerRef.current = setTimeout(() => {
      if (!isArkaRouteActive()) return;
      void reloadAll(act, { force: true, source: 'mutation_followup', target: 'primary' });
    }, MUTATION_PRIMARY_DELAY_MS);
  }

  async function handlePendingHandoffDone(handoffId) {
    const cleanId = String(handoffId || '').trim();
    if (cleanId) {
      setPendingHandoffs((current) => current.filter((row) => String(row?.id || '').trim() !== cleanId));
    }
    await scheduleManagerMutationRefresh(actor);
  }

  async function handlePendingExpenseDone(requestId) {
    const cleanId = String(requestId || '').trim();
    if (cleanId) {
      setPendingExpenseApprovals((current) => current.filter((row) => String(row?.id || '').trim() !== cleanId));
    }
    await scheduleManagerMutationRefresh(actor);
  }

  const totals = useMemo(() => ({
    paymentTotal: workerCards.reduce((sum, item) => sum + n(item?.paymentTotal), 0),
    expenseTotal: workerCards.reduce((sum, item) => sum + n(item?.expenseTotal), 0),
    timaTotal: workerCards.reduce((sum, item) => sum + n(item?.timaTotal), 0),
    mealTotal: workerCards.reduce((sum, item) => sum + n(item?.mealTotal), 0),
    deliveredTotal: workerCards.reduce((sum, item) => sum + n(item?.deliveredTotal), 0),
    dueTotal: workerCards.reduce((sum, item) => sum + n(item?.dueTotal), 0),
  }), [workerCards]);

  async function loadWorkerView(currentActor) {
    setWorkerCards([]);
    setPendingHandoffs([]);
    setPendingExpenseApprovals([]);
    const pin = String(currentActor?.pin || '').trim();
    if (!pin) {
      setWorkerSnapshot(null);
      setMealOptions([]);
      return;
    }

    let hadErrors = false;
    const swallowToEmpty = (label, err) => {
      hadErrors = true;
      try { console.error(`[ARKA][WORKER] ${label} failed, switching to local cache if available:`, err); } catch {}
      return [];
    };

    const [payments, extras, handoffs, mealStaff] = await Promise.all([
      listWorkerPendingPayments(pin, WORKER_PAYMENTS_LIMIT).catch((err) => swallowToEmpty('payments', err)),
      listWorkerArkaExtras(pin, WORKER_EXTRAS_LIMIT).catch((err) => swallowToEmpty('extras', err)),
      listWorkerHandoffs(pin, WORKER_HANDOFFS_LIMIT).catch((err) => swallowToEmpty('handoffs', err)),
      listMealStaffOptions({ excludePin: pin }).catch((err) => swallowToEmpty('meal_staff', err)),
    ]);

    if (hadErrors) {
      const cached = readStoredJson(getWorkerArkaCacheKey(pin));
      if (cached && typeof cached === 'object') {
        setWorkerSnapshot(cached?.workerSnapshot || null);
        setMealOptions(Array.isArray(cached?.mealOptions) ? cached.mealOptions : []);
        setPendingHandoffs(Array.isArray(cached?.pendingHandoffs) ? cached.pendingHandoffs : []);
        setPendingExpenseApprovals(Array.isArray(cached?.pendingExpenseApprovals) ? cached.pendingExpenseApprovals : []);
        const now = Date.now();
        primaryLoadedAtRef.current = now;
        secondaryLoadedAtRef.current = now;
        return;
      }
      throw new Error('Load failed');
    }

    const snapshot = summarizeArkaCore({ worker: currentActor, paymentRows: payments, extraRows: extras, handoffRows: handoffs });
    setWorkerSnapshot(snapshot);
    setMealOptions(Array.isArray(mealStaff) ? mealStaff : []);
    mergeStoredJsonDeferred(getWorkerArkaCacheKey(pin), {
      workerSnapshot: snapshot,
      mealOptions: Array.isArray(mealStaff) ? mealStaff : [],
      pendingHandoffs: Array.isArray(handoffs) ? handoffs : [],
      pendingExpenseApprovals: [],
    });
    const now = Date.now();
    primaryLoadedAtRef.current = now;
    secondaryLoadedAtRef.current = now;
  }

  async function loadManagerPrimary() {
    setWorkerSnapshot(null);
    setMealOptions([]);
    try {
      const staff = await listTodayWorkers();
      const workerRows = (Array.isArray(staff) ? staff : []).filter((row) => roleIsWorker(row?.role));
      const { paymentsByPin, extrasByPin, handoffsByPin, hadErrors } = await loadManagerBulkSnapshots(workerRows);
      if (hadErrors) throw new Error('Load failed');
      const cards = workerRows.map((worker) => {
        const pin = String(worker?.pin || '').trim();
        return summarizeArkaCore({
          worker,
          paymentRows: paymentsByPin.get(pin) || [],
          extraRows: extrasByPin.get(pin) || [],
          handoffRows: handoffsByPin.get(pin) || [],
        });
      });
      cards.sort((a, b) => {
        const priority = { warn: 0, info: 1, ok: 2, idle: 3 };
        return (priority[a?.tone] ?? 9) - (priority[b?.tone] ?? 9)
          || n(b?.dueTotal) - n(a?.dueTotal)
          || String(a?.worker?.name || '').localeCompare(String(b?.worker?.name || ''));
      });
      setWorkerCards(cards);
      mergeStoredJsonDeferred(ARKA_MANAGER_CACHE_KEY, { workerCards: cards });
      primaryLoadedAtRef.current = Date.now();
    } catch (e) {
      const cached = readStoredJson(ARKA_MANAGER_CACHE_KEY);
      if (cached && Array.isArray(cached?.workerCards)) {
        setWorkerCards(cached.workerCards);
        primaryLoadedAtRef.current = Date.now();
        return;
      }
      throw e;
    }
  }

  async function loadManagerSecondary() {
    setSecondaryLoading(true);
    try {
      let hadErrors = false;
      const swallowToEmpty = (label, err) => {
        hadErrors = true;
        try { console.error(`[ARKA][MANAGER] ${label} failed, switching to local cache if available:`, err); } catch {}
        return [];
      };
      const [handoffs, expenses] = await Promise.all([
        listPendingDispatchHandoffs(MANAGER_SECONDARY_LIMIT, MANAGER_PENDING_HANDOFF_SELECT).catch((err) => swallowToEmpty('handoffs', err)),
        listPendingExpenseApprovals(MANAGER_SECONDARY_LIMIT, MANAGER_PENDING_EXPENSE_SELECT).catch((err) => swallowToEmpty('expenses', err)),
      ]);
      if (hadErrors) {
        const cached = readStoredJson(ARKA_MANAGER_CACHE_KEY);
        if (cached && typeof cached === 'object') {
          setPendingHandoffs(Array.isArray(cached?.pendingHandoffs) ? cached.pendingHandoffs : []);
          setPendingExpenseApprovals(Array.isArray(cached?.pendingExpenseApprovals) ? cached.pendingExpenseApprovals : []);
          secondaryLoadedAtRef.current = Date.now();
          return;
        }
        throw new Error('Load failed');
      }
      setPendingHandoffs(Array.isArray(handoffs) ? handoffs : []);
      setPendingExpenseApprovals(Array.isArray(expenses) ? expenses : []);
      mergeStoredJsonDeferred(ARKA_MANAGER_CACHE_KEY, {
        pendingHandoffs: Array.isArray(handoffs) ? handoffs : [],
        pendingExpenseApprovals: Array.isArray(expenses) ? expenses : [],
      });
      secondaryLoadedAtRef.current = Date.now();
    } finally {
      setSecondaryLoading(false);
    }
  }

  async function reloadAll(currentActor = null, { force = false, source = 'direct', target = 'auto' } = {}) {
    const act = currentActor || getActor();
    const now = Date.now();
    const inMutationCooldown = now < mutationCooldownUntilRef.current;
    const isLifecycleSource = ['focus', 'visibility', 'pageshow', 'pageshow_fresh'].includes(String(source || ''));
    if (!isArkaRouteActive()) return;
    if (isOfflineBrowser()) {
      const restored = applyCachedBootState(act);
      setLoading(false);
      if (!restored) {
        setError((prev) => prev || 'OFFLINE. HAPE NJËHERË ONLINE QË TË RUAHET SNAPSHOT-I I ARKËS.');
      } else {
        setError('');
      }
      return;
    }
    const hidden = typeof document !== 'undefined' && document.visibilityState !== 'visible';
    const allowHiddenBoot = force || String(source || '').startsWith('initial') || primaryLoadedAtRef.current === 0 || secondaryLoadedAtRef.current === 0;
    if (hidden && !allowHiddenBoot) return;
    if (!force && now < errorCooldownUntilRef.current) return;
    if (!force && inMutationCooldown && isLifecycleSource) return;
    if (!force && now - lastReloadAtRef.current < RELOAD_MIN_GAP_MS) return;
    if (reloadInFlightRef.current) return;

    let runPrimary = false;
    let runSecondary = false;

    if (roleIsWorker(act?.role) && !roleCanManage(act?.role)) {
      runPrimary = true;
      runSecondary = true;
    } else {
      const primaryAge = now - primaryLoadedAtRef.current;
      const secondaryAge = now - secondaryLoadedAtRef.current;
      if (force || target === 'all' || source === 'manual' || source === 'mutation' || source === 'arka_refresh') {
        runPrimary = true;
        runSecondary = true;
      } else if (target === 'primary') {
        runPrimary = true;
      } else if (target === 'secondary') {
        runSecondary = true;
      } else {
        runPrimary = primaryLoadedAtRef.current === 0 || primaryAge >= PRIMARY_STALE_MS;
        runSecondary = secondaryLoadedAtRef.current === 0 || secondaryAge >= SECONDARY_STALE_MS;
      }
    }

    if (!runPrimary && !runSecondary) return;

    const isWorkerView = roleIsWorker(act?.role) && !roleCanManage(act?.role);
    const cachedPrimary = isWorkerView
      ? !!readStoredJson(getWorkerArkaCacheKey(act?.pin))?.workerSnapshot
      : !!(readStoredJson(ARKA_MANAGER_CACHE_KEY)?.workerCards || []).length;
    const livePrimaryReady = isWorkerView
      ? !!workerSnapshot
      : Array.isArray(workerCards) && workerCards.length > 0;
    const showBlockingLoading = runPrimary && !(livePrimaryReady || cachedPrimary);

    reloadInFlightRef.current = true;
    lastReloadAtRef.current = now;
    if (showBlockingLoading) setLoading(true);
    setError('');
    try {
      if (isWorkerView) {
        await loadWorkerView(act);
      } else {
        const tasks = [];
        if (runPrimary) tasks.push(loadManagerPrimary());
        if (runSecondary) tasks.push(loadManagerSecondary());
        await Promise.all(tasks);
      }
      errorCooldownUntilRef.current = 0;
    } catch (e) {
      errorCooldownUntilRef.current = Date.now() + ERROR_COOLDOWN_MS;
      setError(e?.message || 'NUK U NGARKUA ARKA.');
    } finally {
      if (showBlockingLoading) setLoading(false);
      reloadInFlightRef.current = false;
    }
  }

  useEffect(() => {
    let alive = true;
    const localActor = getActor() || null;
    setActor(localActor);
    setSessionChecked(true);
    if (!localActor?.pin) {
      setLoading(false);
      return () => { alive = false; };
    }

    applyCachedBootState(localActor);

    const actorLooksComplete = !!(
      localActor?.pin
      && localActor?.role
      && (localActor?.user_id || localActor?.id)
    );

    if (actorLooksComplete) {
      return () => { alive = false; };
    }

    (async () => {
      try {
        const userRow = await fetchSessionUserByPin(localActor.pin);
        if (!alive || !userRow) return;
        const repaired = reconcileActorWithUser(localActor, userRow);
        const changed = JSON.stringify({ pin: localActor?.pin, role: localActor?.role, name: localActor?.name, user_id: localActor?.user_id, is_hybrid_transport: localActor?.is_hybrid_transport, transport_id: localActor?.transport_id }) !== JSON.stringify({ pin: repaired?.pin, role: repaired?.role, name: repaired?.name, user_id: repaired?.user_id, is_hybrid_transport: repaired?.is_hybrid_transport, transport_id: repaired?.transport_id });
        if (changed) {
          persistActorRepair(repaired);
          try { window.__tepihaBootDebug?.logEvent?.('arka_actor_reconciled', { pin: repaired?.pin, role: repaired?.role, isHybrid: repaired?.is_hybrid_transport === true }); } catch {}
        }
        setActor(repaired);
        applyCachedBootState(repaired);
      } catch {}
    })();
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!sessionChecked) return undefined;
    const timer = setTimeout(() => {
      try {
        bootLog('ui_ready', {
          page: 'arka',
          path: typeof window !== 'undefined' ? (window.location.pathname || '/arka') : '/arka',
          source: uiReadyMarkedRef.current ? 'safe_shell_repeat' : 'safe_shell_first',
          loading: !!loading,
          actorPin: actor?.pin || '',
          isWorker: !!isWorker,
          canManage: !!canManage,
          workerCards: Array.isArray(workerCards) ? workerCards.length : 0,
          pendingHandoffs: Array.isArray(pendingHandoffs) ? pendingHandoffs.length : 0,
        });
      } catch {}
      if (uiReadyMarkedRef.current) return;
      uiReadyMarkedRef.current = true;
      try {
        bootMarkReady({
          source: 'arka_page',
          page: 'arka',
          path: typeof window !== 'undefined' ? (window.location.pathname || '/arka') : '/arka',
          loading: !!loading,
          actorPin: actor?.pin || '',
          isWorker: !!isWorker,
          canManage: !!canManage,
        });
      } catch {}
    }, 0);
    return () => clearTimeout(timer);
  }, [sessionChecked, loading, actor?.pin, isWorker, canManage, workerCards.length, pendingHandoffs.length, pendingExpenseApprovals.length, !!workerSnapshot]);

  useEffect(() => {
    if (!sessionChecked || !loading) return undefined;
    const timer = setTimeout(() => {
      setLoading(false);
      setError((prev) => prev || 'PO PRITET RRJETI. PO SHFAQET GJENDJA E SIGURT.');
    }, 2400);
    return () => clearTimeout(timer);
  }, [sessionChecked, loading]);

  useEffect(() => {
    if (!actor?.pin) return;
    const isManagerActor = roleCanManage(actor?.role) && !roleIsWorker(actor?.role);
    const cancelPrimary = scheduleIdleTask(() => {
      if (!isArkaRouteActive()) return;
      void reloadAll(actor, { force: true, source: 'initial', target: isManagerActor ? 'primary' : 'all' });
    }, 120, 1400);

    let cancelSecondary = null;
    if (isManagerActor) {
      cancelSecondary = scheduleIdleTask(() => {
        if (!isArkaRouteActive()) return;
        void reloadAll(actor, { force: true, source: 'initial_secondary', target: 'secondary' });
      }, INITIAL_MANAGER_SECONDARY_DELAY_MS, 2200);
    }

    return () => {
      try { cancelPrimary?.(); } catch {}
      try { cancelSecondary?.(); } catch {}
    };
  }, [actor?.pin, actor?.role]);

  useEffect(() => {
    if (!actor?.pin) return;
    if (isWithinStartupIsolationWindow()) {
      bootLog('arka_lifecycle_startup_isolation_skip', {
        path: typeof window !== 'undefined' ? (window.location.pathname || '/arka') : '/arka',
        leftMs: getStartupIsolationLeftMs(),
      });
      return undefined;
    }

    function scheduleLifecycleReload(reason) {
      const needsBootData = primaryLoadedAtRef.current === 0 || secondaryLoadedAtRef.current === 0;
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible' && !needsBootData) return;
      if (!isArkaRouteActive()) return;
      if (busyRef.current) return;
      const now = Date.now();
      if (now < mutationCooldownUntilRef.current) return;
      if (now - lastReloadAtRef.current < LIFECYCLE_RELOAD_GAP_MS) return;
      const target = needsBootData ? 'all' : 'secondary';
      if (lifecycleTimerRef.current) clearTimeout(lifecycleTimerRef.current);
      lifecycleTimerRef.current = setTimeout(() => {
        void reloadAll(actor, { source: reason, target });
      }, reason === 'pageshow' ? 180 : 260);
    }

    function onFocus() {
      scheduleLifecycleReload('focus');
    }
    function onVisibility() {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        scheduleLifecycleReload('visibility');
      }
    }
    function onPageShow(event) {
      scheduleLifecycleReload(event?.persisted ? 'pageshow' : 'pageshow_fresh');
    }
    function onArkaRefresh() {
      void reloadAll(actor, { force: true, source: 'arka_refresh', target: 'all' });
    }

    if (typeof window !== 'undefined') {
      window.addEventListener('focus', onFocus);
      window.addEventListener('pageshow', onPageShow);
      window.addEventListener('arka:refresh', onArkaRefresh);
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibility);
    }

    return () => {
      if (lifecycleTimerRef.current) clearTimeout(lifecycleTimerRef.current);
      clearPostMutationPrimaryTimer();
      if (typeof window !== 'undefined') {
        window.removeEventListener('focus', onFocus);
        window.removeEventListener('pageshow', onPageShow);
        window.removeEventListener('arka:refresh', onArkaRefresh);
      }
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibility);
      }
    };
  }, [actor?.pin, actor?.role]);

  async function submitExpense() {
    const title = String(expenseTitle || '').trim() || 'SHPENZIM';
    const amount = parseAmountInput(expenseAmount);
    if (amount <= 0) return alert('🔴 SHKRUAJ SHUMËN E SHPENZIMIT.');
    try {
      setBusy('expense');
      await createExpenseEntry({
        actor,
        amount,
        note: title,
        workerPin: actor?.pin,
        workerName: actor?.name,
        workerRole: actor?.role,
      });
      setExpenseTitle('');
      setExpenseAmount('');
      await scheduleManagerMutationRefresh(actor);
      alert('✅ SHPENZIMI U REGJISTRUA.');
    } catch (e) {
      alert(`🔴 ${e?.message || 'NUK U REGJISTRUA SHPENZIMI.'}`);
    } finally {
      setBusy('');
    }
  }

  async function submitMeal() {
    if (!selectedMealPins.length) return alert('🔴 ZGJIDH SË PAKU NJË KOLEG.');
    try {
      setBusy('meal');
      const selectedWorkers = mealOptions.filter((row) => selectedMealPins.includes(String(row?.pin || '')));
      await createMealDistributionEntry({
        actor,
        payerPin: actor?.pin,
        payerName: actor?.name,
        payerRole: actor?.role,
        coveredWorkers: selectedWorkers,
        amountPerPerson: FOOD_DEDUCTION,
        includePayerMeal: !!workerSnapshot?.hasTodayBasePayment,
        note: 'USHQIM EKIPI',
      });
      setSelectedMealPins([]);
      await scheduleManagerMutationRefresh(actor);
      alert('✅ USHQIMI U REGJISTRUA.');
    } catch (e) {
      alert(`🔴 ${e?.message || 'NUK U REGJISTRUA USHQIMI.'}`);
    } finally {
      setBusy('');
    }
  }

  async function submitHandoff() {
    if (!workerSnapshot || workerSnapshot.dueTotal <= 0) return alert('🔴 NUK KE SHUMË PËR DORËZIM.');
    const ok = window.confirm(
      `A DON ME I DORËZU ${workerSnapshot.dueTotal.toFixed(2)}€?\n\n` +
      `PAGESA: ${workerSnapshot.paymentTotal.toFixed(2)}€\n` +
      `TIMA: ${workerSnapshot.timaTotal.toFixed(2)}€\n` +
      `SHPENZIME: ${workerSnapshot.expenseTotal.toFixed(2)}€\n` +
      `USHQIM: ${workerSnapshot.mealTotal.toFixed(2)}€\n` +
      `KOMISION: ${workerSnapshot.hybridCommission.toFixed(2)}€`
    );
    if (!ok) return;
    try {
      setBusy('handoff');
      await submitWorkerCashToDispatch({ actor, amountOverride: workerSnapshot.dueTotal });
      await scheduleManagerMutationRefresh(actor);
      alert('✅ DORËZIMI U DËRGUA PËR PRANIM.');
    } catch (e) {
      alert(`🔴 ${e?.message || 'NUK U DËRGUA DORËZIMI.'}`);
    } finally {
      setBusy('');
    }
  }

  function toggleMealPin(pin) {
    const cleanPin = String(pin || '').trim();
    if (!cleanPin) return;
    setSelectedMealPins((current) => current.includes(cleanPin)
      ? current.filter((item) => item !== cleanPin)
      : [...current, cleanPin]);
  }

  return (
    <div className="arkaSimplePage">
      <div className="arkaSimpleTop">
        <div>
          <div className="arkaSimpleEyebrow">ARKA V3</div>
          <h1 className="arkaSimpleTitle">{canManage ? 'ADMIN / DISPATCH ARKA' : 'ARKA IME E DITËS'}</h1>
          <div className="arkaSimpleSub">
            {canManage
              ? 'I NJËJTI CORE MATEMATIKOR SI TE PUNTORI. ORDERS JANË JASHTË FORMULËS ZYRTARE.'
              : 'VETËM 6 KARTELA: PAGESA, SHPENZIME, TIMA, USHQIM, DORËZUAR, ME DORËZU.'}
          </div>
        </div>
        <div className="arkaSimpleNav">
          <Link href="/" prefetch={false} className="arkaTopBtn">HOME</Link>
          {canManage ? <Link href="/arka/payroll" prefetch={false} className="arkaTopBtn">PAYROLL</Link> : null}
          {canManage ? <Link href="/arka/stafi" prefetch={false} className="arkaTopBtn">STAFI</Link> : null}
          {canManage ? <Link href="/arka/obligimet" prefetch={false} className="arkaTopBtn">OBLIGIMET</Link> : null}
        </div>
      </div>

      {error ? <div className="arkaLoaderCard">🔴 {error}</div> : null}
      {loading ? <div className="arkaLoaderCard">PO NGARKOHET ARKA...</div> : null}
      {!actor?.pin && !loading ? <div className="arkaLoaderCard">MUNGON SESIONI I PËRDORUESIT.</div> : null}

      {!loading && actor?.pin && isWorker && !canManage && workerSnapshot ? (
        <>
          <div className="arkaHeroSingle">
            <div>
              <div className="arkaWorkerName">{String(actor?.name || 'PUNTOR').toUpperCase()}</div>
              <div className="arkaWorkerMeta">PIN {actor?.pin || '—'} • {String(actor?.role || 'WORKER').toUpperCase()}</div>
            </div>
            <div className="arkaHeroDue">{euro(workerSnapshot.dueTotal)}</div>
          </div>

          <div className="arkaWorkerStats workerOnlyGrid">
            <Stat label="PAGESA" value={euro(workerSnapshot.paymentTotal)} tone="ok" />
            <Stat label="SHPENZIME" value={euro(workerSnapshot.expenseTotal)} tone="warn" />
            <Stat label="TIMA" value={euro(workerSnapshot.timaTotal)} tone="info" />
            <Stat label="USHQIM" value={euro(workerSnapshot.mealTotal)} tone="muted" />
            <Stat label="DORËZUAR" value={euro(workerSnapshot.deliveredTotal)} tone="muted" />
            <Stat label="ME DORËZU" value={euro(workerSnapshot.dueTotal)} tone="strong" />
          </div>

          <div className="arkaActionPanel">
            <div className="arkaActionHeader">SHTO SHPENZIM</div>
            <div className="arkaInlineForm">
              <input className="arkaField" value={expenseTitle} onChange={(e) => setExpenseTitle(e.target.value)} placeholder="P.SH. NAFTË / PARKING" />
              <input className="arkaField small" inputMode="decimal" value={expenseAmount} onChange={(e) => setExpenseAmount(e.target.value)} placeholder="20" />
              <button type="button" className="arkaSolidBtn" disabled={!!busy} onClick={submitExpense}>{busy === 'expense' ? '...' : '+ SHTO'}</button>
            </div>
          </div>

          <div className="arkaActionPanel">
            <div className="arkaActionHeader">PAGUAJ USHQIM PËR NJË KOLEG</div>
            <div className="arkaSimpleSub">
              3€ PËR PERSON. `MEAL PAYMENT` ZBRITET NGA TI. `MEAL COVERED` U DEL KOLEGËVE VETËM SI EVIDENCË.
            </div>
            <div className="arkaWorkerFoot muted" style={{ marginTop: 8 }}>
              <span>AUTO PËR TY: {workerSnapshot.hasTodayBasePayment ? 'PO, KE SË PAKU 1 PAGESË BAZË SOT' : 'JO, S’KE PAGESË BAZË SOT'}</span>
              <span>ZGJIDH KOLEGËT POSHTË</span>
            </div>
            <div style={{ display: 'grid', gap: 8, marginTop: 12 }}>
              {mealOptions.length ? mealOptions.map((row) => {
                const pin = String(row?.pin || '').trim();
                const checked = selectedMealPins.includes(pin);
                return (
                  <label key={pin} className="arkaPendingRow" style={{ cursor: 'pointer' }}>
                    <div>
                      <div className="arkaPendingName">{String(row?.name || pin).toUpperCase()}</div>
                      <div className="arkaPendingMeta">PIN {pin} • {row?.active_today ? 'AKTIV SOT' : 'JO AKTIV SOT'}</div>
                    </div>
                    <div className="arkaPendingRight">
                      <input type="checkbox" checked={checked} onChange={() => toggleMealPin(pin)} />
                    </div>
                  </label>
                );
              }) : <div className="arkaEmpty">S’KA KOLEGË PËR T’U PËRFSHIRË.</div>}
            </div>
            <div className="arkaWorkerFoot" style={{ marginTop: 12 }}>
              <span>TË ZGJEDHUR: {selectedMealPins.length}</span>
              <button type="button" className="arkaSolidBtn" disabled={!!busy || !selectedMealPins.length} onClick={submitMeal}>{busy === 'meal' ? '...' : `RUAJ USHQIMIN • ${euro((selectedMealPins.length + (workerSnapshot.hasTodayBasePayment ? 1 : 0)) * FOOD_DEDUCTION)}`}</button>
            </div>
          </div>

          <div className="arkaActionPanel emphasis">
            <div>
              <div className="arkaActionHeader">DORËZIMI</div>
              <div className="arkaSimpleSub">ME DORËZU = PAGESA + TIMA - SHPENZIME - USHQIM - KOMISION HYBRID</div>
            </div>
            <button type="button" className="arkaSolidBtn big" disabled={!!busy || workerSnapshot.dueTotal <= 0} onClick={submitHandoff}>{busy === 'handoff' ? '...' : `DËRGO PËR DORËZIM • ${euro(workerSnapshot.dueTotal)}`}</button>
          </div>

          <div className="arkaSectionCard">
            <div className="arkaSectionTitle">PAGESA</div>
            <div className="arkaSectionSub">HISTORIKU POSHTË MUND TA TREGOJË STATUSIN PENDING OSE COLLECTED, POR KARTELA KRYESORE I MBLEDH BASHKË.</div>
            {workerSnapshot.paymentRows.length ? workerSnapshot.paymentRows.map((row) => (
              <HistoryRow
                key={row.id}
                title={String(row?.client_name || row?.order_code || row?.note || 'PAGESË').toUpperCase()}
                meta={`${fmtDate(row?.created_at)} • ${safeUpper(row?.status || 'PENDING')}`}
                amount={euro(row?.amount)}
                rightText={safeUpper(row?.status || 'PENDING')}
                tone={statusOf(row) === 'COLLECTED' ? 'ok' : 'warn'}
              />
            )) : <div className="arkaEmpty">S’KA PAGESA TË HAPURA.</div>}
          </div>

          <div className="arkaSplitGrid">
            <section className="arkaSectionCard">
              <div className="arkaSectionTitle">SHPENZIME & USHQIM</div>
              {[...workerSnapshot.expenseRows, ...workerSnapshot.mealPaymentRows].sort(byDateDesc).length ? [...workerSnapshot.expenseRows, ...workerSnapshot.mealPaymentRows].sort(byDateDesc).map((row) => (
                <HistoryRow
                  key={row.id}
                  title={typeOf(row) === 'MEAL_PAYMENT' ? 'USHQIM' : 'SHPENZIM'}
                  meta={`${fmtDate(row?.created_at)} • ${String(row?.note || '').toUpperCase()}`}
                  amount={euro(row?.amount)}
                  rightText={typeOf(row)}
                  tone="warn"
                />
              )) : <div className="arkaEmpty">S’KA SHPENZIME OSE USHQIM.</div>}
            </section>

            <section className="arkaSectionCard">
              <div className="arkaSectionTitle">TIMA & DORËZIME</div>
              {([...workerSnapshot.timaRows, ...workerSnapshot.handoffRows].sort(byDateDesc)).length ? ([...workerSnapshot.timaRows, ...workerSnapshot.handoffRows].sort(byDateDesc)).map((row) => {
                const isHandoff = row?.worker_pin != null && row?.status != null && row?.submitted_at != null;
                return (
                  <HistoryRow
                    key={`${isHandoff ? 'handoff' : 'tima'}_${row.id}`}
                    title={isHandoff ? 'DORËZIM' : 'TIMA'}
                    meta={`${fmtDate(row?.submitted_at || row?.decided_at || row?.created_at)} • ${safeUpper(row?.status || '')}`}
                    amount={euro(row?.amount)}
                    rightText={isHandoff ? safeUpper(row?.status || '') : 'TIMA'}
                    tone={isHandoff && statusOf(row) === 'ACCEPTED' ? 'ok' : 'info'}
                  />
                );
              }) : <div className="arkaEmpty">S’KA TIMA OSE DORËZIME.</div>}
            </section>
          </div>

          <div className="arkaSectionCard" style={{ borderColor: 'rgba(245,158,11,.28)', background: 'rgba(245,158,11,.06)' }}>
            <div className="arkaSectionTitle">X-RAY / DEBUG</div>
            <div className="arkaSectionSub">ORDERS JANË JASHTË FORMULËS ZYRTARE TË ARKËS. KJO FAQE LEXON VETËM `arka_pending_payments` DHE `cash_handoffs`.</div>
          </div>
        </>
      ) : null}

      {!loading && actor?.pin && canManage ? (
        <>
          <div className="arkaWorkerStats adminTopGrid">
            <Stat label="PAGESA" value={euro(totals.paymentTotal)} tone="ok" />
            <Stat label="SHPENZIME" value={euro(totals.expenseTotal)} tone="warn" />
            <Stat label="TIMA" value={euro(totals.timaTotal)} tone="info" />
            <Stat label="USHQIM" value={euro(totals.mealTotal)} tone="muted" />
            <Stat label="DORËZUAR" value={euro(totals.deliveredTotal)} tone="muted" />
            <Stat label="ME DORËZU" value={euro(totals.dueTotal)} tone="strong" />
          </div>

          <div className="arkaSplitGrid">
            <section className="arkaSectionCard">
              <div className="arkaSectionHeadCompact">
                <div>
                  <div className="arkaSectionTitle">STAFI</div>
                  <div className="arkaSectionSub">KONTROLL ABSOLUT, POR ME TË NJËJTIN CORE SI PUNTORI.</div>
                </div>
                <button type="button" className="arkaTopBtn" onClick={() => reloadAll(actor, { force: true, source: 'manual', target: 'all' })}>REFRESH</button>
              </div>
              <div className="arkaWorkerList">
                {workerCards.length ? workerCards.map((item) => (
                  <ArkaPanelBoundary key={item?.worker?.pin || item?.worker?.id} name="ArkaWorkerSummaryCard">
                    <WorkerSummaryCard item={item} />
                  </ArkaPanelBoundary>
                )) : <div className="arkaEmpty">S’KA PUNTORË AKTIVË.</div>}
              </div>
            </section>

            <section className="arkaSectionCard sideRail">
              <div className="arkaSectionTitle">DORËZIME NË PRITJE</div>
              <div className="arkaSectionSub">ACCEPTED HYN TE DORËZUAR. PENDING NUK HYJNË DERI SA TË PRANOHEN.</div>
              {secondaryLoading ? <div className="arkaEmpty">PO NGARKOHET PANELI ANËSOR...</div> : null}
              {!secondaryLoading && pendingHandoffs.length ? pendingHandoffs.map((row) => (
                <ArkaPanelBoundary key={row.id} name="ArkaPendingHandoffRow">
                  <PendingHandoffRow row={row} actor={actor} onDone={handlePendingHandoffDone} />
                </ArkaPanelBoundary>
              )) : null}
              {!secondaryLoading && !pendingHandoffs.length ? <div className="arkaEmpty">S’KA DORËZIME NË PRITJE.</div> : null}

              <div className="arkaSectionDivider" />

              <div className="arkaSectionTitle">SHPENZIME NË PRITJE</div>
              {!secondaryLoading && pendingExpenseApprovals.length ? pendingExpenseApprovals.map((row) => (
                <ArkaPanelBoundary key={row.id} name="ArkaPendingExpenseRow">
                  <PendingExpenseRow row={row} actor={actor} onDone={handlePendingExpenseDone} />
                </ArkaPanelBoundary>
              )) : null}
              {!secondaryLoading && !pendingExpenseApprovals.length ? <div className="arkaEmpty">S’KA SHPENZIME NË PRITJE.</div> : null}
            </section>
          </div>

          <div className="arkaSectionCard" style={{ borderColor: 'rgba(245,158,11,.28)', background: 'rgba(245,158,11,.06)' }}>
            <div className="arkaSectionTitle">X-RAY / DEBUG</div>
            <div className="arkaSectionSub">ORDERS JANË HEQUR NGA FORMULA ZYRTARE. PO PËRDOREN VETËM `arka_pending_payments` PËR PAGESA DHE `cash_handoffs` ACCEPTED PËR DORËZUAR.</div>
          </div>
        </>
      ) : null}
    </div>
  );
}
