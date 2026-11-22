import { WORKER_BONUS_TIME_ZONE } from './workerBonusAccount.js';

const SOURCES = {
  BASE: 'Bonus bazë',
  TRANSPORT_CONTROL: 'Kontroll transporti',
};
const DAY_FORMAT = new Intl.DateTimeFormat('en-CA', {
  timeZone: WORKER_BONUS_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
});

export function workerBonusDayKey(value = new Date()) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const parts = DAY_FORMAT.formatToParts(date);
  const part = name => parts.find(item => item.type === name)?.value || '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function validWorkerBonusDay(value) {
  if (typeof value !== 'string' || !/^20\d{2}-(0[1-9]|1[0-2])-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function incomplete() {
  const error = new Error('Bonuset ditore nuk u ngarkuan plotësisht. Rifresko për regjistrimet e fundit.');
  error.code = 'WORKER_DAILY_BONUS_REPORT_INCOMPLETE';
  return error;
}

function cents(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw incomplete();
  return Math.round(value * 100);
}

// Presentation only: daily credits come from the approved report's posting date.
// Current balances remain the server's all-date values; this never creates credit.
export function buildWorkerDailyBonusView(report, date = workerBonusDayKey()) {
  if (!validWorkerBonusDay(date)) throw new Error('Zgjidhe një datë të vlefshme për bonuset.');
  if (report?.enabled !== true || !Array.isArray(report.dailyRows) || report.month !== date.slice(0, 7)) throw incomplete();
  const available = cents(report.totals?.available) / 100;
  const reserved = cents(report.totals?.reserved) / 100;
  const grouped = Object.fromEntries(Object.keys(SOURCES).map(source => [source, { cents: 0, count: 0 }]));
  const rows = [];
  const seen = new Set();
  for (const row of report.dailyRows) {
    if (!row || typeof row.eligible !== 'boolean') throw incomplete();
    if (!row.eligible) continue;
    const amount = cents(row.amount);
    if (amount === 0) continue;
    const creditedDay = row.creditedAt ? workerBonusDayKey(row.creditedAt) : '';
    const id = String(row.id ?? '').trim();
    if (!id || seen.has(id) || !SOURCES[row.source] || !creditedDay || creditedDay.slice(0, 7) !== report.month) throw incomplete();
    seen.add(id);
    if (creditedDay !== date) continue;
    grouped[row.source].cents += amount;
    grouped[row.source].count++;
    rows.push({ ...row, id, amount: amount / 100, label: SOURCES[row.source], creditedDay });
  }
  rows.sort((a, b) => String(b.creditedAt).localeCompare(String(a.creditedAt)) || b.id.localeCompare(a.id, undefined, { numeric: true }));
  const sources = Object.entries(grouped).map(([source, values]) => ({ source, label: SOURCES[source], earned: values.cents / 100, count: values.count }));
  return {
    date,
    rows,
    sources,
    earned: (grouped.BASE.cents + grouped.TRANSPORT_CONTROL.cents) / 100,
    earnedCount: rows.length,
    available,
    reserved,
    bookingWarnings: (Array.isArray(report.dailyWarnings) ? report.dailyWarnings : []).filter(warning => warning?.code === 'BOOKING_MISSING'),
  };
}
