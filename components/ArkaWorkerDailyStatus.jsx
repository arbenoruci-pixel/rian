'use client';

import { useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import '@/components/ArkaWorkerDailyStatus.css';

const TIME_ZONE = 'Europe/Belgrade';
const MONEY = new Intl.NumberFormat('de-DE', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const ACCEPTED_STATUSES = new Set(['ACCEPTED_BY_DISPATCH', 'APPROVED', 'ACCEPTED']);
const PENDING_STATUSES = new Set(['PENDING', 'COLLECTED', 'PENDING_DISPATCH_APPROVAL']);
const OPEN_CASH_STATUSES = new Set(['PENDING', 'COLLECTED']);
const CLOSED_STATUSES = new Set(['REJECTED', 'REFUZUAR', 'VOIDED', 'CANCELLED', 'CANCELED']);
const LIVE_PAYMENT_STATUSES = new Set(['PENDING', 'COLLECTED', 'PENDING_DISPATCH_APPROVAL', 'ACCEPTED_BY_DISPATCH', 'APPROVED', 'ACCEPTED']);
const NON_CASH_TYPES = new Set(['EXPENSE', 'TIMA', 'MEAL_PAYMENT', 'MEAL_COVERED', 'READY_48H_BONUS', 'ADVANCE']);
// ARKA_LIVE_WORKER_PAYMENTS_V1
// FIXED_ROUTE_CASH_CLARITY_V1

function number(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function euro(value) {
  return `€${MONEY.format(number(value))}`;
}

function upper(value) {
  return String(value || '').trim().toUpperCase();
}

function dateKey(value = new Date()) {
  try {
    const date = value instanceof Date ? value : new Date(value || Date.now());
    if (Number.isNaN(date.getTime())) return '';
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);
    const get = (type) => parts.find((part) => part.type === type)?.value || '';
    return `${get('year')}-${get('month')}-${get('day')}`;
  } catch {
    return '';
  }
}

function dateLabel(value = new Date()) {
  try {
    return new Intl.DateTimeFormat('sq-AL', {
      timeZone: TIME_ZONE,
      weekday: 'long',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    }).format(value instanceof Date ? value : new Date(value));
  } catch {
    return dateKey(value);
  }
}

function stamp(value) {
  if (!value) return '—';
  try {
    return new Intl.DateTimeFormat('sq-AL', {
      timeZone: TIME_ZONE,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(value));
  } catch {
    return '—';
  }
}

function isToday(value, today) {
  return !!value && dateKey(value) === today;
}

function uniqueRows(rows = []) {
  const output = [];
  const seen = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row) continue;
    const raw = row?.raw || row;
    const key = String(
      raw?.id ||
      row?.id ||
      `${raw?.created_at || row?.created_at || ''}|${raw?.amount || row?.amount || ''}|${raw?.type || row?.type || ''}`
    );
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(row);
  }
  return output;
}

function sum(rows, reader) {
  return Number((Array.isArray(rows) ? rows : []).reduce((total, row) => total + number(reader(row)), 0).toFixed(2));
}

function cleanExpenseNote(value) {
  const raw = String(value || '')
    .replace(/\n?ARKA_EXPENSE_REQUEST_V1[^\n]*/gi, '')
    .trim();
  return raw || 'SHPENZIM';
}

function statusLabel(status) {
  const clean = upper(status);
  if (ACCEPTED_STATUSES.has(clean)) return 'PRANUAR';
  if (clean === 'PENDING_DISPATCH_APPROVAL') return 'TE DISPATCH';
  if (clean === 'COLLECTED') return 'NË DORËZIM';
  if (clean === 'PENDING') return 'NË PRITJE';
  if (CLOSED_STATUSES.has(clean)) return 'MBYLLUR';
  return clean || '—';
}

function statusTone(status) {
  const clean = upper(status);
  if (ACCEPTED_STATUSES.has(clean)) return 'accepted';
  if (PENDING_STATUSES.has(clean)) return 'pending';
  if (CLOSED_STATUSES.has(clean)) return 'closed';
  return 'neutral';
}

function Metric({ label, value, sub = '', tone = 'neutral' }) {
  return (
    <div className={`arkaDailyMetric ${tone}`}>
      <span>{label}</span>
      <b>{value}</b>
      {sub ? <small>{sub}</small> : null}
    </div>
  );
}

export default function ArkaWorkerDailyStatus({ snapshot, actor }) {
  // ARKA_WORKER_DAILY_STATUS_V1:COMPONENT
  const [livePayments, setLivePayments] = useState([]);
  const [profile, setProfile] = useState(null);
  const [liveLoaded, setLiveLoaded] = useState(false);

  useEffect(() => {
    const pin = String(actor?.pin || snapshot?.worker?.pin || '').trim();
    if (!pin) {
      setLivePayments([]);
      setProfile(null);
      setLiveLoaded(false);
      return undefined;
    }

    let cancelled = false;
    let timer = null;

    const load = async () => {
      try {
        const [paymentRes, profileRes] = await Promise.all([
          supabase
            .from('arka_pending_payments')
            .select('id,amount,type,status,note,client_name,client_phone,order_code,transport_order_id,transport_code_str,transport_m2,source_module,created_by_pin,created_by_name,created_at,updated_at,handed_at')
            .eq('created_by_pin', pin)
            .order('created_at', { ascending: false })
            .limit(160),
          supabase
            .from('users')
            .select('pin,name,role,is_hybrid_transport,commission_rate_m2,bonus_transport,bonus_ushqim')
            .eq('pin', pin)
            .maybeSingle(),
        ]);

        if (paymentRes?.error) throw paymentRes.error;
        if (cancelled) return;
        setLivePayments(Array.isArray(paymentRes?.data) ? paymentRes.data : []);
        setLiveLoaded(true);
        if (!profileRes?.error) setProfile(profileRes?.data || null);
      } catch {
        // Keep the last valid snapshot visible if live refresh is temporarily unavailable.
      }
    };

    const onVisible = () => {
      if (document.visibilityState !== 'hidden') void load();
    };

    setLiveLoaded(false);
    void load();
    timer = window.setInterval(load, 15000);
    window.addEventListener('focus', load);
    window.addEventListener('pageshow', load);
    window.addEventListener('arka:refresh', load);
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      cancelled = true;
      if (timer) window.clearInterval(timer);
      window.removeEventListener('focus', load);
      window.removeEventListener('pageshow', load);
      window.removeEventListener('arka:refresh', load);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [actor?.pin, snapshot?.worker?.pin]);

  const profileRole = upper(profile?.role || snapshot?.worker?.role || actor?.role);
  const hybridFlag = profile?.is_hybrid_transport
    ?? snapshot?.worker?.is_hybrid_transport
    ?? actor?.is_hybrid_transport
    ?? false;
  const isFixedRouteTransport = profileRole === 'TRANSPORT' && hybridFlag !== true;

  const daily = useMemo(() => {
    const today = dateKey(new Date());

    const snapshotOpenRows = uniqueRows(snapshot?.cashBreakdownRows);
    const snapshotTodayCashRows = uniqueRows([
      ...snapshotOpenRows,
      ...(Array.isArray(snapshot?.acceptedCashBreakdownRows) ? snapshot.acceptedCashBreakdownRows : []),
    ]).filter((row) => isToday(row?.created_at || row?.raw?.created_at, today));

    const liveCashRows = uniqueRows(livePayments)
      .map((row) => row?.raw || row)
      .filter((row) => LIVE_PAYMENT_STATUSES.has(upper(row?.status)))
      .filter((row) => !NON_CASH_TYPES.has(upper(row?.type)));

    const paymentActivityRows = uniqueRows([
      ...snapshotTodayCashRows.map((row) => row?.raw || row),
      ...liveCashRows.filter((row) => isToday(row?.created_at, today)),
    ])
      .map((row) => row?.raw || row)
      .filter((row) => isToday(row?.created_at, today))
      .sort((a, b) => String(b?.created_at || '').localeCompare(String(a?.created_at || '')));

    const liveOpenRows = liveCashRows.filter((row) => OPEN_CASH_STATUSES.has(upper(row?.status)));
    const liveTodayOpenRows = liveOpenRows.filter((row) => isToday(row?.created_at, today));
    const liveCarryoverRows = liveOpenRows.filter((row) => !isToday(row?.created_at, today));

    const snapshotTodayOpenRows = snapshotOpenRows.filter((row) => isToday(row?.created_at || row?.raw?.created_at, today));
    const snapshotCarryoverRows = snapshotOpenRows.filter((row) => !isToday(row?.created_at || row?.raw?.created_at, today));

    const expenseRows = uniqueRows(snapshot?.allExtraRows)
      .map((row) => row?.raw || row)
      .filter((row) => upper(row?.type) === 'EXPENSE')
      .filter((row) => !CLOSED_STATUSES.has(upper(row?.status)))
      .filter((row) => isToday(row?.created_at, today))
      .sort((a, b) => String(b?.created_at || '').localeCompare(String(a?.created_at || '')));

    const acceptedExpenses = expenseRows.filter((row) => ACCEPTED_STATUSES.has(upper(row?.status)));
    const pendingExpenses = expenseRows.filter((row) => PENDING_STATUSES.has(upper(row?.status)));

    const deliveredRows = uniqueRows(snapshot?.deliveredRows)
      .map((row) => row?.raw || row)
      .filter((row) => isToday(row?.decided_at || row?.accepted_at || row?.submitted_at || row?.created_at, today));

    const pendingHandoffRows = uniqueRows(snapshot?.pendingHandoffRows)
      .map((row) => row?.raw || row)
      .filter((row) => isToday(row?.submitted_at || row?.created_at, today));

    const snapshotCurrentDue = number(snapshot?.baseCashForDispatchTotal ?? snapshot?.remainingToHandover ?? snapshot?.dueTotal);
    const fixedRouteCurrentDue = liveLoaded
      ? sum(liveOpenRows, (row) => row?.amount)
      : snapshotCurrentDue;
    const fixedRouteTodayOpen = liveLoaded
      ? sum(liveTodayOpenRows, (row) => row?.amount)
      : sum(snapshotTodayOpenRows, (row) => row?.gross ?? row?.raw?.amount ?? row?.baseAmount);
    const fixedRouteCarryover = liveLoaded
      ? sum(liveCarryoverRows, (row) => row?.amount)
      : Math.max(0, Number((snapshotCurrentDue - fixedRouteTodayOpen).toFixed(2)));

    const normalTodayBase = sum(snapshotTodayCashRows, (row) => row?.baseAmount ?? row?.raw?.amount ?? row?.gross);
    const normalCarryoverBase = sum(snapshotCarryoverRows, (row) => row?.baseAmount ?? row?.raw?.amount ?? row?.gross);

    return {
      today,
      cashRows: snapshotTodayCashRows,
      paymentActivityRows,
      expenseRows,
      acceptedExpenses,
      pendingExpenses,
      cashGross: sum(paymentActivityRows, (row) => row?.amount ?? row?.raw?.amount ?? row?.gross),
      commission: isFixedRouteTransport ? 0 : sum(snapshotTodayCashRows, (row) => row?.commission),
      cashForBase: isFixedRouteTransport ? fixedRouteTodayOpen : normalTodayBase,
      carryoverForBase: isFixedRouteTransport ? fixedRouteCarryover : normalCarryoverBase,
      carryoverCount: isFixedRouteTransport
        ? (liveLoaded ? liveCarryoverRows.length : snapshotCarryoverRows.length)
        : snapshotCarryoverRows.length,
      openCount: isFixedRouteTransport
        ? (liveLoaded ? liveOpenRows.length : snapshotOpenRows.length)
        : snapshotOpenRows.length,
      expenses: sum(expenseRows, (row) => row?.amount),
      acceptedExpensesTotal: sum(acceptedExpenses, (row) => row?.amount),
      pendingExpensesTotal: sum(pendingExpenses, (row) => row?.amount),
      delivered: sum(deliveredRows, (row) => row?.amount),
      pendingHandoff: sum(pendingHandoffRows, (row) => row?.amount),
      currentDue: isFixedRouteTransport ? fixedRouteCurrentDue : snapshotCurrentDue,
    };
  }, [snapshot, livePayments, liveLoaded, isFixedRouteTransport]);

  const movementCount = daily.paymentActivityRows.length + daily.expenseRows.length;
  const workerName = String(actor?.name || profile?.name || snapshot?.worker?.name || 'PUNTORI').trim().toUpperCase();

  return (
    <section className="arkaSectionCard arkaDailyStatusCard">
      <div className="arkaDailyStatusHeader">
        <div>
          <div className="arkaDailyEyebrow">ARKA • {workerName}</div>
          <div className="arkaDailyTitle">GJENDJA DITORE</div>
          <div className="arkaDailyDate">{dateLabel(new Date()).toUpperCase()}</div>
        </div>
        <div className="arkaDailyCurrent">
          <span>PËR BAZË TASH</span>
          <b>{euro(daily.currentDue)}</b>
          <small>KREJT CASH-I I PA DORËZUAR</small>
        </div>
      </div>

      <div className="arkaDailyMetricGrid">
        <Metric
          label="KLIENTËT PAGUAN SOT"
          value={euro(daily.cashGross)}
          sub={`${daily.paymentActivityRows.length} PAGESA`}
          tone="ok"
        />
        {isFixedRouteTransport ? (
          <Metric
            label="MBETUR NGA MË HERËT"
            value={euro(daily.carryoverForBase)}
            sub={`${daily.carryoverCount} PAGESA TË PA DORËZUARA`}
            tone="info"
          />
        ) : (
          <Metric
            label="KOMISIONI IM SOT"
            value={euro(daily.commission)}
            sub={`PËR BAZË NGA PAGESAT: ${euro(daily.cashForBase)}`}
            tone="info"
          />
        )}
        <Metric
          label="SHPENZIME SOT"
          value={euro(daily.expenses)}
          sub={`PRANUAR ${euro(daily.acceptedExpensesTotal)} • NË PRITJE ${euro(daily.pendingExpensesTotal)}`}
          tone="warn"
        />
        <Metric
          label="DORËZUAR SOT"
          value={euro(daily.delivered)}
          sub={daily.pendingHandoff > 0 ? `TE DISPATCH ${euro(daily.pendingHandoff)}` : 'S’KA DORËZIM NË PRITJE'}
          tone="strong"
        />
      </div>

      {isFixedRouteTransport ? (
        <div className="arkaDailyExpenseBox">
          <div className="arkaDailyExpenseHead">
            <span>RRUGË FIKSE • PA KOMISION • PA BONUS</span>
            <b>{euro(daily.currentDue)}</b>
          </div>
          <div className="arkaDailyExpenseList">
            <div className="arkaDailyExpenseRow">
              <div>
                <strong>TOTALI QË DUHET ME DORËZU</strong>
                <small>{euro(daily.cashForBase)} SOT + {euro(daily.carryoverForBase)} NGA MË HERËT</small>
              </div>
              <div className="arkaDailyExpenseRight">
                <b>{euro(daily.currentDue)}</b>
                <span className="arkaDailyStatusPill pending">{daily.openCount} PAGESA</span>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {daily.paymentActivityRows.length ? (
        <div className="arkaDailyExpenseBox">
          <div className="arkaDailyExpenseHead">
            <span>PAGESAT E SOTME</span>
            <b>{daily.paymentActivityRows.length}</b>
          </div>
          <div className="arkaDailyExpenseList">
            {daily.paymentActivityRows.slice(0, 12).map((row) => {
              const code = String(row?.transport_code_str || row?.order_code || '—').trim().toUpperCase();
              const client = String(row?.client_name || 'KLIENT').trim().toUpperCase();
              return (
                <div className="arkaDailyExpenseRow" key={`daily_payment_${row?.id || row?.created_at}`}>
                  <div>
                    <strong>{code} • {client}</strong>
                    <small>{stamp(row?.created_at)} • {statusLabel(row?.status)}</small>
                  </div>
                  <div className="arkaDailyExpenseRight">
                    <b>{euro(row?.amount)}</b>
                    <span className={`arkaDailyStatusPill ${statusTone(row?.status)}`}>{statusLabel(row?.status)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      {daily.expenseRows.length ? (
        <div className="arkaDailyExpenseBox">
          <div className="arkaDailyExpenseHead">
            <span>SHPENZIMET E SOTME</span>
            <b>{daily.expenseRows.length}</b>
          </div>
          <div className="arkaDailyExpenseList">
            {daily.expenseRows.slice(0, 8).map((row) => (
              <div className="arkaDailyExpenseRow" key={`daily_expense_${row?.id || row?.created_at}`}>
                <div>
                  <strong>{cleanExpenseNote(row?.note).toUpperCase()}</strong>
                  <small>{stamp(row?.created_at)} • {statusLabel(row?.status)}</small>
                </div>
                <div className="arkaDailyExpenseRight">
                  <b>{euro(row?.amount)}</b>
                  <span className={`arkaDailyStatusPill ${statusTone(row?.status)}`}>{statusLabel(row?.status)}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {!movementCount && daily.currentDue <= 0 ? (
        <div className="arkaDailyEmpty">SOT ENDE S’KA PAGESA OSE SHPENZIME TË REGJISTRUARA NË KËTË ARKË.</div>
      ) : null}
    </section>
  );
}
