'use client';

import { useMemo } from 'react';
import '@/components/ArkaWorkerDailyStatus.css';

const TIME_ZONE = 'Europe/Belgrade';
const MONEY = new Intl.NumberFormat('de-DE', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const ACCEPTED_STATUSES = new Set(['ACCEPTED_BY_DISPATCH', 'APPROVED', 'ACCEPTED']);
const PENDING_STATUSES = new Set(['PENDING', 'COLLECTED', 'PENDING_DISPATCH_APPROVAL']);
const CLOSED_STATUSES = new Set(['REJECTED', 'REFUZUAR', 'VOIDED', 'CANCELLED', 'CANCELED']);

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
  const daily = useMemo(() => {
    const today = dateKey(new Date());

    const cashRows = uniqueRows([
      ...(Array.isArray(snapshot?.cashBreakdownRows) ? snapshot.cashBreakdownRows : []),
      ...(Array.isArray(snapshot?.acceptedCashBreakdownRows) ? snapshot.acceptedCashBreakdownRows : []),
    ]).filter((row) => isToday(row?.created_at || row?.raw?.created_at, today));

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

    return {
      today,
      cashRows,
      expenseRows,
      acceptedExpenses,
      pendingExpenses,
      cashGross: sum(cashRows, (row) => row?.gross ?? row?.raw?.amount),
      commission: sum(cashRows, (row) => row?.commission),
      cashForBase: sum(cashRows, (row) => row?.baseAmount),
      expenses: sum(expenseRows, (row) => row?.amount),
      acceptedExpensesTotal: sum(acceptedExpenses, (row) => row?.amount),
      pendingExpensesTotal: sum(pendingExpenses, (row) => row?.amount),
      delivered: sum(deliveredRows, (row) => row?.amount),
      pendingHandoff: sum(pendingHandoffRows, (row) => row?.amount),
      currentDue: number(snapshot?.baseCashForDispatchTotal ?? snapshot?.remainingToHandover ?? snapshot?.dueTotal),
    };
  }, [snapshot]);

  const movementCount = daily.cashRows.length + daily.expenseRows.length;
  const workerName = String(actor?.name || snapshot?.worker?.name || 'PUNTORI').trim().toUpperCase();

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
          <small>CASH QË DUHET ME DORËZU</small>
        </div>
      </div>

      <div className="arkaDailyMetricGrid">
        <Metric
          label="KLIENTËT PAGUAN SOT"
          value={euro(daily.cashGross)}
          sub={`${daily.cashRows.length} PAGESA`}
          tone="ok"
        />
        <Metric
          label="KOMISIONI IM SOT"
          value={euro(daily.commission)}
          sub={`PËR BAZË NGA PAGESAT: ${euro(daily.cashForBase)}`}
          tone="info"
        />
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

      {!movementCount ? (
        <div className="arkaDailyEmpty">SOT ENDE S’KA PAGESA OSE SHPENZIME TË REGJISTRUARA NË KËTË ARKË.</div>
      ) : null}
    </section>
  );
}
