'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { getActor } from '@/lib/actorSession';
import { supabase } from '@/lib/supabaseClient';
import { fetchSessionUserByPin } from '@/lib/usersService';
import {
  createTimaEntry,
  createMealDistributionEntry,
  createExpenseEntry,
  deleteWorkerExtraEntry,
  listMealStaffOptions,
} from '@/lib/arkaService';
import { listWorkerDebtRows, submitWorkerCashToDispatch } from '@/lib/corporateFinance';
import {
  buildWorkerArkaSummary,
  mealCoveredByLabel,
  fetchWorkerOrdersFallbackRaw,
  buildWorkerOrderFallbackRows,
  readWorkerOrderAmount,
} from '@/lib/arkaWorkerSummary';
import useRouteAlive from '@/lib/routeAlive';
import { bootLog } from '@/lib/bootLog';

const MONEY = new Intl.NumberFormat('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function euro(v) {
  return `€${MONEY.format(Number(v || 0) || 0)}`;
}

function n(v) {
  const x = Number(v || 0);
  return Number.isFinite(x) ? x : 0;
}

function safeUpper(v) {
  return String(v || '').trim().toUpperCase();
}

function parseAmountInput(v) {
  const raw = String(v ?? '').trim().replace(/\s/g, '').replace(',', '.');
  return n(raw);
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

function isToday(v) {
  return String(v || '').slice(0, 10) === new Date().toISOString().slice(0, 10);
}

function Stat({ label, value, tone = 'neutral' }) {
  return (
    <div className={`arkaMiniStat ${tone}`}>
      <div className="arkaMiniStatLabel">{label}</div>
      <div className="arkaMiniStatValue">{value}</div>
    </div>
  );
}

function PaymentTitle(row) {
  const code = row?.order_code != null && row?.order_code !== '' ? `#${row.order_code}` : '';
  const client = String(row?.client_name || '').trim();
  const type = safeUpper(row?.type || 'PAGESË');
  if (client) return `${client.toUpperCase()}${code ? ` • ${code}` : ''}`;
  if (code) return `PAGESË ${code}`;
  return type || 'PAGESË';
}

function typeLabel(row) {
  const type = safeUpper(row?.type || 'ORDER');
  if (type === 'TRANSPORT') return 'T-KOD';
  return 'BAZË';
}

const EXTRA_TYPES = ['TIMA', 'EXPENSE', 'MEAL_PAYMENT', 'MEAL_COVERED'];
const OPEN_PAYMENT_STATUSES = new Set(['PENDING', 'COLLECTED']);

function buildEmptyWorkerSummary() {
  return {
    collectedTotal: 0, pendingTotal: 0, expenseTotal: 0, mealPaymentTotal: 0, mealFromExpensesTotal: 0, mealSelfTotal: 0, mealCoveredTotal: 0, timaTotal: 0, deliveredTodayTotal: 0, deliveredEarlierTotal: 0, deliveredTotal: 0, toHandoverToday: 0, toHandoverWithPending: 0, advancesTotal: 0, debtTotal: 0, activityBaseToday: false, collectedRows: [], pendingRows: [], baseCollectedRows: [], basePendingRows: [], transportCollectedRows: [], transportPendingRows: [], expenseRows: [], expenseOnlyRows: [], expenseMealRows: [], timaRows: [], mealPaymentRows: [], mealCoveredRows: [], deliveredRows: [], deliveredTodayRows: [], deliveredEarlierRows: [], transportCodeRows: [], isHybridTransport: false, commissionRateM2: 0.5, transportCollectedM2: 0, transportPendingM2: 0, hybridCommissionCollected: 0, hybridCommissionWithPending: 0, hybridBaseShareCollected: 0, hybridBaseShareWithPending: 0,
  };
}

function readOrderAmount(row) {
  return readWorkerOrderAmount(row);
}

function isOpenRealPaymentRow(row) {
  const type = safeUpper(row?.type);
  const status = safeUpper(row?.status);
  if (EXTRA_TYPES.includes(type)) return false;
  if (['OWED', 'REJECTED', 'WORKER_DEBT', 'ADVANCE'].includes(status)) return false;
  return OPEN_PAYMENT_STATUSES.has(status);
}

function uniqById(rows = []) {
  const map = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const key = String(row?.id || row?.external_id || row?.created_at || '').trim();
    if (!key) continue;
    map.set(key, row);
  }
  return [...map.values()];
}

function cleanErrorMessage(error, label) {
  const msg = String(error?.message || error?.details || error?.hint || error || '').trim();
  return label ? `${label}: ${msg || 'Gabim i panjohur'}` : (msg || 'Gabim i panjohur');
}

async function fetchWorkerPendingPaymentsRaw(pin, limit = 300) {
  const cleanPin = String(pin || '').trim();
  if (!cleanPin) return [];
  const { data, error } = await supabase
    .from('arka_pending_payments')
    .select('*')
    .eq('created_by_pin', cleanPin)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

async function fetchWorkerExtrasRaw(pin, limit = 200) {
  const cleanPin = String(pin || '').trim();
  if (!cleanPin) return [];
  const [createdRes, targetedRes] = await Promise.all([
    supabase
      .from('arka_pending_payments')
      .select('*')
      .in('type', EXTRA_TYPES)
      .eq('created_by_pin', cleanPin)
      .order('created_at', { ascending: false })
      .limit(limit),
    supabase
      .from('arka_pending_payments')
      .select('*')
      .in('type', EXTRA_TYPES)
      .eq('handed_by_pin', cleanPin)
      .order('created_at', { ascending: false })
      .limit(limit),
  ]);
  if (createdRes.error) throw createdRes.error;
  if (targetedRes.error) throw targetedRes.error;
  return uniqById([...(Array.isArray(createdRes.data) ? createdRes.data : []), ...(Array.isArray(targetedRes.data) ? targetedRes.data : [])])
    .sort((a, b) => String(b?.created_at || '').localeCompare(String(a?.created_at || '')));
}

async function fetchWorkerHandoffsRaw(pin, limit = 100) {
  const cleanPin = String(pin || '').trim();
  if (!cleanPin) return [];
  const { data, error } = await supabase
    .from('cash_handoffs')
    .select('*')
    .eq('worker_pin', cleanPin)
    .order('submitted_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

async function fetchWorkerOrdersRaw(targetPin, limit = 180) {
  return fetchWorkerOrdersFallbackRaw(targetPin, limit);
}

function extractTransportCodeCandidate(row) {
  const direct = [
    row?.transport_code_str,
    row?.transportCodeStr,
    row?.transport_code,
    row?.t_code,
    row?.tcode,
    row?.client_tcode,
    row?.code_str,
    row?.order_code,
  ]
    .map((value) => String(value || '').trim().toUpperCase())
    .find((value) => /^T\d+$/.test(value));
  if (direct) return direct;
  const raw = `${String(row?.order_code || '')} ${String(row?.note || '')} ${String(row?.client_name || '')}`.toUpperCase();
  const match = raw.match(/\bT\d+\b/);
  return match?.[0] || '';
}

async function fetchTransportOrderMetaForPaymentsRaw(paymentRows = []) {
  const rows = Array.isArray(paymentRows) ? paymentRows : [];
  const ids = [...new Set(rows
    .map((row) => String(row?.transport_order_id || row?.transportOrderId || '').trim())
    .filter(Boolean))];
  const codes = [...new Set(rows
    .map((row) => extractTransportCodeCandidate(row))
    .filter(Boolean))];

  if (!ids.length && !codes.length) return {};

  const map = {};
  const chunkSize = 80;

  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    const { data, error } = await supabase
      .from('transport_orders')
      .select('*')
      .in('id', chunk);
    if (error) throw error;
    for (const row of Array.isArray(data) ? data : []) {
      const id = String(row?.id || '').trim();
      const codeStr = String(row?.code_str || '').trim().toUpperCase();
      const clientTcode = String(row?.client_tcode || row?.data?.client?.tcode || '').trim().toUpperCase();
      if (id) map[id] = row;
      if (codeStr) map[`CODE:${codeStr}`] = row;
      if (clientTcode) map[`TCODE:${clientTcode}`] = row;
    }
  }

  for (let i = 0; i < codes.length; i += chunkSize) {
    const chunk = codes.slice(i, i + chunkSize);
    const [byCodeStr, byClientTcode] = await Promise.all([
      supabase.from('transport_orders').select('*').in('code_str', chunk),
      supabase.from('transport_orders').select('*').in('client_tcode', chunk),
    ]);
    if (byCodeStr.error) throw byCodeStr.error;
    if (byClientTcode.error) throw byClientTcode.error;
    for (const res of [byCodeStr, byClientTcode]) {
      for (const row of Array.isArray(res.data) ? res.data : []) {
        const id = String(row?.id || '').trim();
        const codeStr = String(row?.code_str || '').trim().toUpperCase();
        const clientTcode = String(row?.client_tcode || row?.data?.client?.tcode || '').trim().toUpperCase();
        if (id) map[id] = row;
        if (codeStr) map[`CODE:${codeStr}`] = row;
        if (clientTcode) map[`TCODE:${clientTcode}`] = row;
      }
    }
  }

  return map;
}

export default function ArkaWorkerDetailPage() {
  useRouteAlive('arka_worker_detail_page');
  const params = useParams();
  const router = useRouter();
  let pin = '';
  try {
    pin = decodeURIComponent(String(params?.pin || '')).trim();
  } catch {
    pin = String(params?.pin || '').trim();
  }

  const [actor, setActor] = useState(null);
  const [worker, setWorker] = useState(null);
  const [payments, setPayments] = useState([]);
  const [extras, setExtras] = useState([]);
  const [handoffs, setHandoffs] = useState([]);
  const [orderFallbackRows, setOrderFallbackRows] = useState([]);
  const [xray, setXray] = useState({ pin: '', ordersRows: 0, matchedOrders: 0, matchedOrdersTotal: 0 });
  const [debtRows, setDebtRows] = useState([]);
  const [transportOrdersById, setTransportOrdersById] = useState({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState(false);
  const [timaAmount, setTimaAmount] = useState('');
  const [timaNote, setTimaNote] = useState('TIMA');
  const [expenseAmount, setExpenseAmount] = useState('');
  const [expenseNote, setExpenseNote] = useState('SHPENZIM');
  const [deletingId, setDeletingId] = useState('');
  const [staffOptions, setStaffOptions] = useState([]);
  const [mealAmount, setMealAmount] = useState('3');
  const [mealNote, setMealNote] = useState('USHQIM');
  const [mealTargets, setMealTargets] = useState([]);
  const [mealSearch, setMealSearch] = useState('');
  const [secondaryLoading, setSecondaryLoading] = useState(false);
  const reloadSeqRef = useRef(0);

  const canManage = ['DISPATCH', 'ADMIN', 'ADMIN_MASTER', 'OWNER', 'PRONAR', 'SUPERADMIN'].includes(safeUpper(actor?.role));
  const sameWorker = String(actor?.pin || '').trim() === pin;

  async function reload() {
    if (!pin) return;
    const seq = Date.now();
    reloadSeqRef.current = seq;
    setLoading(true);
    setSecondaryLoading(false);
    setLoadError('');
    setWorker((prev) => prev || { pin, name: pin, role: 'WORKER', is_hybrid_transport: false, commission_rate_m2: 0.5 });
    try {
      const results = await Promise.allSettled([
        fetchSessionUserByPin(pin),
        fetchWorkerPendingPaymentsRaw(pin),
        fetchWorkerExtrasRaw(pin),
        fetchWorkerHandoffsRaw(pin),
        typeof listWorkerDebtRows === 'function' ? listWorkerDebtRows(pin) : Promise.resolve([]),
      ]);

      if (reloadSeqRef.current !== seq) return;

      const [workerRes, paymentRes, extrasRes, handoffRes, debtRes] = results;
      const issues = [];

      if (workerRes.status === 'rejected') issues.push(cleanErrorMessage(workerRes.reason, 'USERS'));
      if (paymentRes.status === 'rejected') issues.push(cleanErrorMessage(paymentRes.reason, 'ARKA_PENDING_PAYMENTS'));
      if (extrasRes.status === 'rejected') issues.push(cleanErrorMessage(extrasRes.reason, 'ARKA_EXTRAS'));
      if (handoffRes.status === 'rejected') issues.push(cleanErrorMessage(handoffRes.reason, 'CASH_HANDOFFS'));
      if (debtRes.status === 'rejected') issues.push(cleanErrorMessage(debtRes.reason, 'WORKER_DEBTS'));

      const workerRow = workerRes.status === 'fulfilled' ? workerRes.value : null;
      const cleanPayments = paymentRes.status === 'fulfilled' && Array.isArray(paymentRes.value) ? paymentRes.value : [];
      const cleanExtras = extrasRes.status === 'fulfilled' && Array.isArray(extrasRes.value) ? extrasRes.value : [];
      const cleanHandoffs = handoffRes.status === 'fulfilled' && Array.isArray(handoffRes.value) ? handoffRes.value : [];
      const cleanDebtRows = debtRes.status === 'fulfilled' && Array.isArray(debtRes.value) ? debtRes.value : [];
      const pinStr = String(pin || '').trim();

      setWorker(workerRow || { pin, name: pin, role: 'WORKER', is_hybrid_transport: false, commission_rate_m2: 0.5 });
      setPayments(cleanPayments);
      setExtras(cleanExtras);
      setHandoffs(cleanHandoffs);
      setDebtRows(cleanDebtRows);
      setOrderFallbackRows([]);
      setTransportOrdersById({});
      setXray({ pin: pinStr, ordersRows: 0, matchedOrders: 0, matchedOrdersTotal: 0 });
      setLoadError(issues.join(' | '));
      setLoading(false);

      const needsOrdersFallback = !cleanPayments.some((row) => isOpenRealPaymentRow(row));
      const needsTransportMeta = cleanPayments.some((row) => typeLabel(row) === 'T-KOD' || safeUpper(row?.type) === 'TRANSPORT');
      if (!needsOrdersFallback && !needsTransportMeta) return;

      setSecondaryLoading(true);
      const secondaryIssues = [];
      let workerOrders = [];
      let transportMap = {};

      if (needsOrdersFallback) {
        try {
          workerOrders = await fetchWorkerOrdersRaw(pinStr);
        } catch (error) {
          secondaryIssues.push(cleanErrorMessage(error, 'ORDERS'));
        }
      }

      if (needsTransportMeta) {
        try {
          transportMap = await fetchTransportOrderMetaForPaymentsRaw(cleanPayments);
        } catch (error) {
          secondaryIssues.push(cleanErrorMessage(error, 'TRANSPORT_ORDERS'));
        }
      }

      if (reloadSeqRef.current !== seq) return;

      setOrderFallbackRows(buildWorkerOrderFallbackRows(workerOrders));
      setXray({
        pin: pinStr,
        ordersRows: workerOrders.length,
        matchedOrders: workerOrders.length,
        matchedOrdersTotal: workerOrders.reduce((sum, row) => sum + readOrderAmount(row), 0),
      });
      setTransportOrdersById(transportMap || {});
      setLoadError((prev) => [prev, ...secondaryIssues].filter(Boolean).join(' | '));
    } catch (error) {
      if (reloadSeqRef.current !== seq) return;
      setPayments([]);
      setExtras([]);
      setHandoffs([]);
      setOrderFallbackRows([]);
      setXray({ pin: String(pin || '').trim(), ordersRows: 0, matchedOrders: 0, matchedOrdersTotal: 0 });
      setDebtRows([]);
      setTransportOrdersById({});
      setLoadError(cleanErrorMessage(error, 'LOAD'));
      setLoading(false);
    } finally {
      if (reloadSeqRef.current === seq) {
        setLoading(false);
        setSecondaryLoading(false);
      }
    }
  }

  useEffect(() => {
    setActor(getActor() || null);
  }, []);

  useEffect(() => {
    if (!actor) return;
    if (!canManage && !sameWorker) {
      try { window.__tepihaBootDebug?.logEvent?.('arka_worker_detail_access_blocked', { actorPin: actor?.pin || '', actorRole: actor?.role || '', targetPin: pin }); } catch {}
      try { alert('NUK KE LEJE ME HAP KËTË LLOGARI.'); } catch {}
      router.replace('/arka');
    }
  }, [actor, canManage, sameWorker, pin, router]);

  useEffect(() => {
    void reload();
  }, [pin]);

  useEffect(() => {
    let alive = true;
    async function loadMealStaff() {
      try {
        const rows = await listMealStaffOptions({ excludePin: pin });
        if (!alive) return;
        const cleanRows = Array.isArray(rows)
          ? rows
              .filter((row) => String(row?.pin || '').trim())
              .reduce((acc, row) => {
                const targetPin = String(row?.pin || '').trim();
                if (!targetPin || acc.some((item) => String(item?.pin || '').trim() === targetPin)) return acc;
                acc.push({
                  ...row,
                  pin: targetPin,
                  active_today: row?.active_today === true,
                });
                return acc;
              }, [])
          : [];
        setStaffOptions(cleanRows);
      } catch {
        if (alive) setStaffOptions([]);
      }
    }
    void loadMealStaff();
    return () => {
      alive = false;
    };
  }, [pin]);

  const hasOpenRealPayments = useMemo(() => (payments || []).some((row) => isOpenRealPaymentRow(row)), [payments]);

  const summaryPayments = useMemo(() => (hasOpenRealPayments ? payments : orderFallbackRows), [hasOpenRealPayments, payments, orderFallbackRows]);

  const summary = useMemo(() => {
    try {
      return buildWorkerArkaSummary({
        payments: Array.isArray(summaryPayments) ? summaryPayments : [],
        extras: Array.isArray(extras) ? extras : [],
        handoffs: Array.isArray(handoffs) ? handoffs : [],
        debtRows: Array.isArray(debtRows) ? debtRows : [],
        pin,
        worker,
        transportOrdersById: transportOrdersById && typeof transportOrdersById === 'object' ? transportOrdersById : {},
      });
    } catch (error) {
      try {
        bootLog('arka_worker_detail_summary_error', {
          path: typeof window !== 'undefined' ? window.location?.pathname || '' : '',
          pin,
          message: String(error?.message || error || 'SUMMARY_ERROR'),
        });
      } catch {}
      return buildEmptyWorkerSummary();
    }
  }, [summaryPayments, extras, handoffs, debtRows, pin, worker, transportOrdersById]);

  const hasTodayActivity = summary.activityBaseToday;

  const mealSearchValue = String(mealSearch || '').trim().toUpperCase();
  const visibleMealOptions = useMemo(() => {
    const rows = Array.isArray(staffOptions) ? staffOptions : [];
    if (!mealSearchValue) return rows;
    return rows.filter((row) => {
      const hay = `${String(row?.name || '')} ${String(row?.pin || '')} ${String(row?.role || '')}`.toUpperCase();
      return hay.includes(mealSearchValue);
    });
  }, [staffOptions, mealSearchValue]);

  const mealTargetRows = useMemo(() => {
    const pins = new Set((mealTargets || []).map((row) => String(row || '').trim()).filter(Boolean));
    return (staffOptions || []).filter((row) => pins.has(String(row?.pin || '').trim()));
  }, [staffOptions, mealTargets]);

  const mealPreviewRows = useMemo(() => {
    const rows = [];
    if (hasTodayActivity) {
      rows.push({ pin, name: worker?.name || pin, role: worker?.role || 'WORKER', auto: true });
    }
    return rows.concat(mealTargetRows.map((row) => ({ ...row, auto: false })));
  }, [hasTodayActivity, pin, worker, mealTargetRows]);

  const mealPeopleCount = mealPreviewRows.length;
  const mealTotalAmount = parseAmountInput(mealAmount || '0') * mealPeopleCount;

  function notifyArkaHome() {
    if (typeof window === 'undefined') return;
    try {
      window.dispatchEvent(new Event('arka:refresh'));
    } catch {}
  }

  function toggleMealTarget(targetPin) {
    const cleanPin = String(targetPin || '').trim();
    if (!cleanPin) return;
    const row = (staffOptions || []).find((item) => String(item?.pin || '').trim() === cleanPin);
    if (!row?.active_today) return;
    setMealTargets((prev) => prev.includes(cleanPin) ? prev.filter((entry) => entry !== cleanPin) : [...prev, cleanPin]);
  }

  function selectAllVisibleMealTargets() {
    const nextPins = visibleMealOptions
      .filter((row) => row?.active_today)
      .map((row) => String(row?.pin || '').trim())
      .filter(Boolean);
    setMealTargets(nextPins);
  }

  function clearMealTargets() {
    setMealTargets([]);
  }

  async function payTeamMeal() {
    const amount = parseAmountInput(mealAmount || '3');
    if (amount <= 0) {
      alert('🔴 SHKRUAJ SHUMËN PËR PERSON.');
      return;
    }
    const picked = (staffOptions || []).filter((row) => row?.active_today && mealTargets.includes(String(row?.pin || '').trim()));
    const includeSelf = hasTodayActivity;
    const totalPeople = picked.length + (includeSelf ? 1 : 0);
    if (!totalPeople) {
      alert('🔴 NUK KA ASNJË PUNTOR AKTIV PËR USHQIM.');
      return;
    }
    try {
      setBusy(true);
      await createMealDistributionEntry({
        actor,
        payerPin: pin,
        payerName: worker?.name || pin,
        payerRole: worker?.role || 'WORKER',
        coveredWorkers: picked,
        amountPerPerson: amount,
        note: mealNote || 'USHQIM',
        includePayerMeal: includeSelf,
      });
      setMealTargets([]);
      setMealAmount('3');
      setMealNote('USHQIM');
      setMealSearch('');
      await reload();
      notifyArkaHome();
      alert(`✅ USHQIMI U REGJISTRUA PËR ${totalPeople} PUNTORË.`);
    } catch (e) {
      alert(`🔴 ${e?.message || 'NUK U REGJISTRUA USHQIMI.'}`);
    } finally {
      setBusy(false);
    }
  }

  async function giveTima() {
    const amount = parseAmountInput(timaAmount);
    if (amount <= 0) {
      alert('🔴 SHKRUAJ SHUMËN E TIMËS.');
      return;
    }
    try {
      setBusy(true);
      await createTimaEntry({
        actor,
        amount,
        note: timaNote || 'TIMA',
        workerPin: pin,
        workerName: worker?.name || pin,
        workerRole: worker?.role || 'WORKER',
      });
      setTimaAmount('');
      setTimaNote('TIMA');
      await reload();
      notifyArkaHome();
      alert('✅ TIMA U REGJISTRUA.');
    } catch (e) {
      alert(`🔴 ${e?.message || 'NUK U REGJISTRUA TIMA.'}`);
    } finally {
      setBusy(false);
    }
  }

  async function addExpense() {
    const amount = parseAmountInput(expenseAmount);
    if (amount <= 0) {
      alert('🔴 SHKRUAJ SHUMËN E SHPENZIMIT.');
      return;
    }
    try {
      setBusy(true);
      await createExpenseEntry({
        actor,
        amount,
        note: expenseNote || 'SHPENZIM',
        workerPin: pin,
        workerName: worker?.name || pin,
        workerRole: worker?.role || 'WORKER',
      });
      setExpenseAmount('');
      setExpenseNote('SHPENZIM');
      await reload();
      notifyArkaHome();
      alert('✅ SHPENZIMI U REGJISTRUA.');
    } catch (e) {
      alert(`🔴 ${e?.message || 'NUK U REGJISTRUA SHPENZIMI.'}`);
    } finally {
      setBusy(false);
    }
  }

  async function removeExpense(row) {
    if (!row?.id) return;
    const ok = window.confirm(`A DON ME E FSHI KËTË RRESHT ${euro(row?.amount)}?`);
    if (!ok) return;
    try {
      setDeletingId(String(row.id));
      await deleteWorkerExtraEntry({ rowId: row.id, actor, allowedTypes: ['EXPENSE', 'TIMA', 'MEAL_PAYMENT', 'MEAL_COVERED'] });
      await reload();
      notifyArkaHome();
      alert('✅ RRESHTI U FSHI.');
    } catch (e) {
      alert(`🔴 ${e?.message || 'NUK U FSHI RRESHTI.'}`);
    } finally {
      setDeletingId('');
    }
  }

  async function handoffMine() {
    if (!sameWorker || summary.toHandoverToday <= 0) return;
    const ok = window.confirm(`A DON ME I DORËZU ${summary.toHandoverToday.toFixed(2)}€?`);
    if (!ok) return;
    try {
      setBusy(true);
      await submitWorkerCashToDispatch({ actor, amountOverride: summary.toHandoverToday });
      await reload();
      notifyArkaHome();
      alert('✅ DORËZIMI U DËRGUA.');
    } catch (e) {
      alert(`🔴 ${e?.message || 'NUK U DËRGUA DORËZIMI.'}`);
    } finally {
      setBusy(false);
    }
  }

  const summaryFoot = summary.isHybridTransport
    ? `COLLECTED + TIMA - SHPENZIME - USHQIM - KOMISION HYBRID`
    : `COLLECTED + TIMA - SHPENZIME - USHQIM`;

  return (
    <div className="arkaSimplePage">
      <div className="arkaSimpleTop">
        <div>
          <div className="arkaSimpleEyebrow">DETajet E PUNTORIT</div>
          <h1 className="arkaSimpleTitle">{String(worker?.name || pin || 'PUNTOR').toUpperCase()}</h1>
          <div className="arkaSimpleSub">PIN {pin || '—'} • {String(worker?.role || 'WORKER').toUpperCase()}</div>
        </div>
        <div className="arkaSimpleNav">
          <Link prefetch={false} href="/arka" className="arkaTopBtn">← KTHEHU</Link>
          {canManage ? <Link prefetch={false} href="/arka/payroll" className="arkaTopBtn">PAYROLL</Link> : null}
        </div>
      </div>

      {loading ? <div className="arkaLoaderCard">PO NGARKOHEN DETAJET...</div> : null}
      {secondaryLoading ? <div className="arkaLoaderCard">PO PLOTËSOHEN TË DHËNAT ANËSORE...</div> : null}
      {loadError ? (
        <div
          className="arkaLoaderCard"
          style={{
            borderColor: 'rgba(239,68,68,.65)',
            background: 'rgba(127,29,29,.35)',
            color: '#fecaca',
          }}
        >
          GABIM NË NGARKIM: {loadError}
        </div>
      ) : null}

      {!loading && !hasOpenRealPayments && orderFallbackRows.length ? (
        <div className="arkaLoaderCard" style={{ borderColor: 'rgba(34,197,94,.45)', background: 'rgba(20,83,45,.24)', color: '#dcfce7' }}>
          FALLBACK AKTIV NGA ORDERS • PO PËRDOREN {orderFallbackRows.length} RRESHTA NGA `data.delivered_by` PËR KËTË PUNTOR.
        </div>
      ) : null}

      {!loading ? (
        <>
          <div className="arkaWorkerStats adminTopGrid">
            <Stat label="TOTAL COLLECTED" value={euro(summary.collectedTotal)} tone="ok" />
            <Stat label="TOTAL PENDING" value={euro(summary.pendingTotal)} tone="warn" />
            <Stat label="SHPENZIME" value={euro(summary.expenseTotal)} tone="warn" />
            <Stat label="USHQIM" value={euro(summary.mealSelfTotal)} tone="muted" />
            <Stat label="TIMA" value={euro(summary.timaTotal)} tone="info" />
            <Stat label="TOTAL DORËZUAR" value={euro(summary.deliveredTotal)} tone="strong" />
            <Stat label="ME DORËZU SOT" value={euro(summary.toHandoverToday)} tone="strong" />
            <Stat label="ME DORËZU + PENDING" value={euro(summary.toHandoverWithPending)} tone="info" />
          </div>

          <div className="arkaActionPanel">
            <div className="arkaActionHeader">X-RAY</div>
            <div className="arkaWorkerStats arkaSectionTopStats">
              <Stat label="PIN" value={xray.pin || '—'} tone="neutral" />
              <Stat label="ORDERS ROWS" value={String(xray.ordersRows || 0)} tone="neutral" />
              <Stat label="MATCHED ORDERS" value={String(xray.matchedOrders || 0)} tone="info" />
              <Stat label="MATCHED TOTAL" value={euro(xray.matchedOrdersTotal)} tone="ok" />
            </div>
            <div className="arkaWorkerFoot muted">
              <span>ORDERS FILTROHEN NË SERVER ME `data-&gt;&gt;delivered_by = PIN`.</span>
              <span>{hasOpenRealPayments ? 'ARKA_PENDING_PAYMENTS MBETET BURIMI PRIMAR.' : 'PO SHFAQET FALLBACK NGA ORDERS SEPSE NUK KA OPEN PAYMENT ROWS.'}</span>
            </div>
          </div>

          {canManage ? (
            <div className="arkaActionPanel">
              <div className="arkaActionHeader">JEP TIMA</div>
              <div className="arkaInlineForm">
                <input className="arkaField small" inputMode="decimal" value={timaAmount} onChange={(e) => setTimaAmount(e.target.value)} placeholder="20" />
                <input className="arkaField" value={timaNote} onChange={(e) => setTimaNote(e.target.value)} placeholder="TIMA" />
                <button type="button" className="arkaSolidBtn" disabled={busy} onClick={giveTima}>RUAJ TIMA</button>
              </div>
            </div>
          ) : null}

          {(canManage || sameWorker) ? (
            <div className="arkaActionPanel">
              <div className="arkaActionHeader">SHTO SHPENZIM</div>
              <div className="arkaInlineForm">
                <input className="arkaField small" inputMode="decimal" value={expenseAmount} onChange={(e) => setExpenseAmount(e.target.value)} placeholder="10" />
                <input className="arkaField" value={expenseNote} onChange={(e) => setExpenseNote(e.target.value)} placeholder="SHPENZIM" />
                <button type="button" className="arkaSolidBtn" disabled={busy} onClick={addExpense}>RUAJ SHPENZIM</button>
              </div>
              <div className="arkaWorkerFoot muted"><span>PUNTORI DHE ADMINI MUND TA SHTOJNË OSE FSHIJNË NËSE ËSHTË GABIM.</span></div>
            </div>
          ) : null}

          {(canManage || sameWorker) ? (
            <div className="arkaActionPanel">
              <div>
                <div className="arkaActionHeader">PAGUAJ USHQIM PËR EKIPIN</div>
                <div className="arkaSimpleSub">AUTO 3€ FUTET VETËM NËSE KY PUNTOR KA SË PAKU 1 PAGESË BAZE REALE SOT. TË TJERËT MUND T’I SHTOSH POSHTË.</div>
              </div>
              <div className="arkaInlineForm mealTopRow">
                <input className="arkaField small" inputMode="decimal" value={mealAmount} onChange={(e) => setMealAmount(e.target.value)} placeholder="3" />
                <input className="arkaField" value={mealNote} onChange={(e) => setMealNote(e.target.value)} placeholder="USHQIM" />
                <button type="button" className="arkaSolidBtn" disabled={busy || !mealPeopleCount} onClick={payTeamMeal}>RUAJ USHQIMIN • {mealPeopleCount}</button>
              </div>

              <div className="arkaMealAutoBox">
                <div className="arkaMealAutoTitle">AUTO NGA SISTEMI</div>
                <div className={`arkaMealAutoValue ${hasTodayActivity ? 'ok' : 'muted'}`}>
                  {hasTodayActivity
                    ? `${String(worker?.name || pin).toUpperCase()} • PIN ${pin} • ${euro(parseAmountInput(mealAmount || '0'))}`
                    : 'KY PUNTOR S’KA PAGESË BAZE REALE SOT — NUK FUTET AUTOMATIKISHT NË USHQIM.'}
                </div>
              </div>

              <div className="arkaMealTools">
                <input
                  className="arkaField"
                  value={mealSearch}
                  onChange={(e) => setMealSearch(e.target.value)}
                  placeholder="KËRKO PUNTOR..."
                />
                <div className="arkaMealToolbar">
                  <button type="button" className="arkaTinyBtn" onClick={selectAllVisibleMealTargets}>ZGJIDH AKTIVËT</button>
                  <button type="button" className="arkaTinyBtn" onClick={clearMealTargets}>PASTRO</button>
                </div>
              </div>

              <div className="arkaMealGrid">
                {visibleMealOptions.map((row) => {
                  const targetPin = String(row?.pin || '').trim();
                  const active = mealTargets.includes(targetPin);
                  const canPick = row?.active_today === true;
                  return (
                    <button
                      type="button"
                      key={targetPin}
                      className={`arkaMealChip ${active ? 'active' : ''} ${canPick ? 'eligible' : 'disabled'}`}
                      onClick={() => toggleMealTarget(targetPin)}
                      disabled={!canPick}
                    >
                      <span>{String(row?.name || targetPin).toUpperCase()}</span>
                      <small>{canPick ? `PIN ${targetPin} • AKTIV SOT` : `PIN ${targetPin} • JO AKTIV SOT`}</small>
                    </button>
                  );
                })}
              </div>

              {!visibleMealOptions.length ? <div className="arkaEmpty">S’U GJET ASNJË PUNTOR ME KËTË KËRKIM.</div> : null}

              <div className="arkaMealSelectedBox">
                <div className="arkaMealSelectedTitle">TË PËRFSHIRË NË USHQIM</div>
                <div className="arkaMealSelectedList">
                  {mealPreviewRows.length
                    ? mealPreviewRows.map((row) => (
                        <span key={`${row.pin}_${row.auto ? 'auto' : 'manual'}`} className={`arkaMealPill ${row.auto ? 'auto' : ''}`}>
                          {String(row?.name || row?.pin || '').toUpperCase()}
                          <small>{row.auto ? 'AUTO' : `PIN ${String(row?.pin || '').trim()}`}</small>
                        </span>
                      ))
                    : <span className="arkaMealSelectedEmpty">ASNJË PUNTOR I PËRZGJEDHUR.</span>}
                </div>
              </div>

              <div className="arkaWorkerFoot muted">
                <span>PAGUESI: {String(worker?.name || pin).toUpperCase()}</span>
                <span>{mealPeopleCount} NË TOTAL • {euro(mealTotalAmount)}</span>
              </div>
            </div>
          ) : null}

          {sameWorker ? (
            <div className="arkaActionPanel emphasis">
              <div>
                <div className="arkaActionHeader">DORËZIMI IM</div>
                <div className="arkaSimpleSub">SISTEMI E LLOGARIT ME DORËZU SOT PA PENDING DHE PA NGATËRRUAR USHQIMIN ME SHPENZIMET.</div>
              </div>
              <button type="button" className="arkaSolidBtn big" disabled={busy || summary.toHandoverToday <= 0} onClick={handoffMine}>DËRGO PËR DORËZIM • {euro(summary.toHandoverToday)}</button>
            </div>
          ) : null}

          <div className="arkaSplitGrid detailPage">
            <section className="arkaSectionCard">
              <div className="arkaSectionTitle">PAGESA TË HYRA</div>
              <div className="arkaSectionSub">COLLECTED DHE PENDING TREGOHEN NDAMAS.</div>
              <div className="arkaWorkerStats arkaSectionTopStats">
                <Stat label="TOTAL COLLECTED" value={euro(summary.collectedTotal)} tone="ok" />
                <Stat label="TOTAL PENDING" value={euro(summary.pendingTotal)} tone="warn" />
              </div>
              {summary.collectedRows.concat(summary.pendingRows).length ? summary.collectedRows.concat(summary.pendingRows).slice(0, 20).map((row) => (
                <div className="arkaHistoryRow" key={`pay_${row.id || row.external_id || row.created_at}`}>
                  <div>
                    <div className="arkaHistoryTitle">{PaymentTitle(row)}</div>
                    <div className="arkaHistoryMeta">{fmtDate(row?.created_at)} • {safeUpper(row?.status || '—')} • {typeLabel(row)}</div>
                  </div>
                  <div className="arkaPendingRight">
                    <div className="arkaHistoryAmount">{euro(row?.amount)}</div>
                  </div>
                </div>
              )) : <div className="arkaEmpty">S’KA PAGESA AKTIVE.</div>}
            </section>

            <section className="arkaSectionCard">
              <div className="arkaSectionTitle">SHPENZIME</div>
              <div className="arkaSectionSub">SHPENZIMET REALE JANË TË NDARA NGA USHQIMI.</div>
              <div className="arkaWorkerStats arkaSectionTopStats singleTwo">
                <Stat label="TOTAL SHPENZIME" value={euro(summary.expenseTotal)} tone="warn" />
              </div>
              {summary.expenseOnlyRows.length ? summary.expenseOnlyRows.slice(0, 15).map((row) => (
                <div className="arkaHistoryRow" key={`expense_${row.id}`}>
                  <div>
                    <div className="arkaHistoryTitle">{String(row?.note || 'SHPENZIM').toUpperCase()}</div>
                    <div className="arkaHistoryMeta">{fmtDate(row?.created_at)} • {safeUpper(row?.status || '—')}</div>
                  </div>
                  <div className="arkaPendingRight">
                    <div className="arkaHistoryAmount">{euro(row?.real_amount || row?.amount)}</div>
                    {(canManage || sameWorker) ? <button type="button" className="arkaTinyBtn bad" disabled={busy || deletingId === String(row.id)} onClick={() => removeExpense(row)}>{deletingId === String(row.id) ? '...' : 'FSHIJ'}</button> : null}
                  </div>
                </div>
              )) : <div className="arkaEmpty">S’KA SHPENZIME TË HAPURA.</div>}
            </section>
          </div>

          <div className="arkaSplitGrid detailPage">
            <section className="arkaSectionCard">
              <div className="arkaSectionTitle">USHQIM</div>
              <div className="arkaSectionSub">MEAL PAYMENT ZBRITET TE PAGUESI. MEAL COVERED ËSHTË VETËM EVIDENCË.</div>
              <div className="arkaWorkerStats arkaSectionTopStats">
                <Stat label="ZBRITJE USHQIM" value={euro(summary.mealSelfTotal)} tone="muted" />
                <Stat label="COVERED EVIDENCË" value={euro(summary.mealCoveredTotal)} tone="neutral" />
              </div>
              {summary.mealPaymentRows.length ? summary.mealPaymentRows.map((row) => (
                <div className="arkaHistoryRow" key={`mealpay_${row.id}`}>
                  <div>
                    <div className="arkaHistoryTitle">{String(row?.note || 'USHQIM').toUpperCase()}</div>
                    <div className="arkaHistoryMeta">{fmtDate(row?.created_at)} • PAGUAR NGA KY PUNTOR</div>
                  </div>
                  <div className="arkaPendingRight">
                    <div className="arkaHistoryAmount">{euro(row?.amount)}</div>
                    {canManage ? <button type="button" className="arkaTinyBtn bad" disabled={busy || deletingId === String(row.id)} onClick={() => removeExpense(row)}>{deletingId === String(row.id) ? '...' : 'FSHIJ'}</button> : null}
                  </div>
                </div>
              )) : null}
              {summary.expenseMealRows.length ? summary.expenseMealRows.map((row) => (
                <div className="arkaHistoryRow" key={`mealsplit_${row.id}`}>
                  <div>
                    <div className="arkaHistoryTitle">USHQIM NGA SHPENZIMI</div>
                    <div className="arkaHistoryMeta">{fmtDate(row?.created_at)} • {String(row?.note || 'USHQIM').toUpperCase()}</div>
                  </div>
                  <div className="arkaPendingRight">
                    <div className="arkaHistoryAmount">{euro(row?.meal_amount)}</div>
                  </div>
                </div>
              )) : null}
              {summary.mealCoveredRows.length ? summary.mealCoveredRows.map((row) => (
                <div className="arkaHistoryRow" key={`mealcovered_${row.id}`}>
                  <div>
                    <div className="arkaHistoryTitle">{mealCoveredByLabel(row)}</div>
                    <div className="arkaHistoryMeta">{fmtDate(row?.created_at)} • {String(row?.note || 'USHQIM').toUpperCase()}</div>
                  </div>
                  <div className="arkaPendingRight">
                    <div className="arkaHistoryAmount">{euro(row?.amount)}</div>
                  </div>
                </div>
              )) : null}
              {!summary.mealPaymentRows.length && !summary.expenseMealRows.length && !summary.mealCoveredRows.length ? <div className="arkaEmpty">S’KA LËVIZJE TË USHQIMIT.</div> : null}
            </section>

            <section className="arkaSectionCard">
              <div className="arkaSectionTitle">TIMA</div>
              <div className="arkaSectionSub">TIMA E PRANUAR NGA DISPATCH HYRT NË LLOGARITJE.</div>
              <div className="arkaWorkerStats arkaSectionTopStats singleTwo">
                <Stat label="TOTAL TIMA" value={euro(summary.timaTotal)} tone="info" />
              </div>
              {summary.timaRows.length ? summary.timaRows.slice(0, 15).map((row) => (
                <div className="arkaHistoryRow" key={`tima_${row.id}`}>
                  <div>
                    <div className="arkaHistoryTitle">{String(row?.note || 'TIMA').toUpperCase()}</div>
                    <div className="arkaHistoryMeta">{fmtDate(row?.created_at)} • {safeUpper(row?.status || '—')}</div>
                  </div>
                  <div className="arkaPendingRight">
                    <div className="arkaHistoryAmount">{euro(row?.amount)}</div>
                    {canManage ? <button type="button" className="arkaTinyBtn bad" disabled={busy || deletingId === String(row.id)} onClick={() => removeExpense(row)}>{deletingId === String(row.id) ? '...' : 'FSHIJ'}</button> : null}
                  </div>
                </div>
              )) : <div className="arkaEmpty">S’KA TIMA TË HAPURA.</div>}
            </section>
          </div>

          {summary.isHybridTransport ? (
            <div className="arkaSplitGrid detailPage">
              <section className="arkaSectionCard">
                <div className="arkaSectionTitle">HYBRID TRANSPORT</div>
                <div className="arkaSectionSub">T-KODET NDARË NGA BAZA. KOMISIONI LLOGARITET {summary.commissionRateM2.toFixed(2)}€/M².</div>
                <div className="arkaWorkerStats arkaSectionTopStats">
                  <Stat label="T-KODE TË PAGUARA" value={String(summary.transportCodeRows.length)} tone="info" />
                  <Stat label="TOTAL M²" value={`${summary.transportCollectedM2.toFixed(2)} m²`} tone="neutral" />
                  <Stat label={`KOMISION ${summary.commissionRateM2.toFixed(2)}€/M²`} value={euro(summary.hybridCommissionCollected)} tone="warn" />
                  <Stat label="PJESA NË BAZË" value={euro(summary.hybridBaseShareCollected)} tone="ok" />
                </div>
                {summary.transportCodeRows.length ? summary.transportCodeRows.slice(0, 12).map((row) => (
                  <div className="arkaHistoryRow" key={`transport_${row.id}`}>
                    <div>
                      <div className="arkaHistoryTitle">{String(row?.code || row?.client_name || 'T-KOD').toUpperCase()}</div>
                      <div className="arkaHistoryMeta">{fmtDate(row?.created_at)} • {String(row?.client_name || '').toUpperCase()} • {row.m2.toFixed(2)} M²</div>
                    </div>
                    <div className="arkaPendingRight">
                      <div className="arkaHistoryAmount">{euro(row?.amount)}</div>
                    </div>
                  </div>
                )) : <div className="arkaEmpty">S’KA T-KODE TË PAGUARA AKTIVISHT.</div>}
              </section>
            </div>
          ) : null}

          <div className="arkaSplitGrid detailPage">
            <section className="arkaSectionCard">
              <div className="arkaSectionTitle">DORËZIME</div>
              <div className="arkaSectionSub">DORËZUAR SOT, MË HERËT DHE TOTALI JANË TË NDARË.</div>
              <div className="arkaWorkerStats arkaSectionTopStats">
                <Stat label="DORËZUAR SOT" value={euro(summary.deliveredTodayTotal)} tone="ok" />
                <Stat label="DORËZUAR MË HERËT" value={euro(summary.deliveredEarlierTotal)} tone="neutral" />
                <Stat label="TOTAL DORËZUAR" value={euro(summary.deliveredTotal)} tone="strong" />
              </div>
              {summary.deliveredRows.length ? summary.deliveredRows.slice(0, 15).map((row) => (
                <div className="arkaHistoryRow" key={`handoff_${row.id}`}>
                  <div>
                    <div className="arkaHistoryTitle">{safeUpper(row?.status || 'DORËZIM')}</div>
                    <div className="arkaHistoryMeta">{fmtDate(row?.submitted_at || row?.decided_at)} • {isToday(row?.submitted_at || row?.decided_at) ? 'SOT' : 'MË HERËT'}</div>
                  </div>
                  <div className="arkaPendingRight">
                    <div className="arkaHistoryAmount">{euro(row?.amount)}</div>
                  </div>
                </div>
              )) : <div className="arkaEmpty">S’KA DORËZIME AKOMA.</div>}
            </section>

            <section className="arkaSectionCard">
              <div className="arkaSectionTitle">PËRMBLEDHJE</div>
              <div className="arkaSectionSub">{summaryFoot}</div>
              <div className="arkaWorkerStats arkaSectionTopStats">
                <Stat label="ME DORËZU SOT" value={euro(summary.toHandoverToday)} tone="strong" />
                <Stat label="ME DORËZU ME PENDING" value={euro(summary.toHandoverWithPending)} tone="info" />
              </div>
              <div className="arkaHistoryRow">
                <div>
                  <div className="arkaHistoryTitle">FORMULA SOT</div>
                  <div className="arkaHistoryMeta">COLLECTED + TIMA - SHPENZIME - USHQIM - KOMISION HYBRID</div>
                </div>
                <div className="arkaPendingRight"><div className="arkaHistoryAmount">{euro(summary.toHandoverToday)}</div></div>
              </div>
              <div className="arkaHistoryRow">
                <div>
                  <div className="arkaHistoryTitle">FORMULA ME PENDING</div>
                  <div className="arkaHistoryMeta">COLLECTED + PENDING + TIMA - SHPENZIME - USHQIM - KOMISION HYBRID</div>
                </div>
                <div className="arkaPendingRight"><div className="arkaHistoryAmount">{euro(summary.toHandoverWithPending)}</div></div>
              </div>
            </section>
          </div>

          <div className="arkaSplitGrid detailPage">
            <section className="arkaSectionCard">
              <div className="arkaSectionTitle">BORXHE / AVANSE</div>
              <div className="arkaWorkerStats arkaSectionTopStats">
                <Stat label="AVANSE" value={euro(summary.advancesTotal)} tone="muted" />
                <Stat label="BORXH" value={euro(summary.debtTotal)} tone="warn" />
              </div>
              {(debtRows || []).length ? debtRows.slice(0, 15).map((row) => (
                <div className="arkaHistoryRow" key={row.id}>
                  <div>
                    <div className="arkaHistoryTitle">{safeUpper(row?.status || 'BORXH')}</div>
                    <div className="arkaHistoryMeta">{String(row?.note || '—').toUpperCase()}</div>
                  </div>
                  <div className="arkaPendingRight">
                    <div className="arkaHistoryAmount">{euro(row?.amount)}</div>
                  </div>
                </div>
              )) : <div className="arkaEmpty">S’KA BORXHE OSE AVANSE.</div>}
            </section>
          </div>
        </>
      ) : null}
    </div>
  );
}
