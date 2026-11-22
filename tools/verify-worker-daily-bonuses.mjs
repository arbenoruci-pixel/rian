import assert from 'node:assert/strict';
import { buildWorkerDailyBonusView, validWorkerBonusDay, workerBonusDayKey } from '../lib/workerDailyBonusView.js';

const copy = value => JSON.parse(JSON.stringify(value));
const posted = (id, source, amount, creditedAt, extra = {}) => ({
  id, source, amount, creditedAt, eligible: true, code: `TEST-${id}`,
  earnedAt: '2026-10-15T10:00:00Z', status: 'EARNED', available: amount, reserved: 0, retained: 0,
  ...extra,
});
const report = {
  enabled: true, month: '2026-11', totals: { available: 18.25, reserved: 4.5 },
  dailyRows: [
    posted('base-day', 'BASE', 3.25, '2026-11-22T10:00:00Z'),
    posted('transport-day', 'TRANSPORT_CONTROL', .5, '2026-11-22T12:00:00Z', { status: 'RETAINED', available: 0, retained: .5 }),
    posted('midnight', 'BASE', .1, '2026-11-21T23:05:00Z'),
    posted('rounding', 'BASE', .2, '2026-11-22T13:00:00Z'),
    posted('prior-day', 'TRANSPORT_CONTROL', .5, '2026-11-21T10:00:00Z', { earnedAt: '2026-11-22T10:00:00Z' }),
    posted('void', 'BASE', 40, '2026-11-22T10:00:00Z', { eligible: false, status: 'VOIDED' }),
    posted('review', 'TRANSPORT_CONTROL', .5, '2026-11-22T10:00:00Z', { eligible: false, status: 'REVIEW_REQUIRED' }),
  ],
  // Monthly qualifications and pending controls cannot create a daily credit.
  rows: [posted('qualified-only', 'BASE', 77, null, { earnedAt: '2026-11-22T10:00:00Z' })],
  pendingControls: [{ id: 'pending-control', potentialAmount: .5, submittedAt: '2026-11-22T10:00:00Z' }],
  dailyWarnings: [{ code: 'BOOKING_MISSING', bonusId: 'qualified-only', orderCode: 'TEST-MISSING' }],
  warnings: [{ code: 'RETAINED_MISMATCH', bonusId: 'legacy', difference: 1 }, { code: 'BOOKING_MISSING', bonusId: 'wrong-location' }],
};
const originalReport = copy(report);

assert.equal(workerBonusDayKey('2026-11-21T22:59:59Z'), '2026-11-21');
assert.equal(workerBonusDayKey('2026-11-21T23:00:00Z'), '2026-11-22');
assert.equal(workerBonusDayKey('2026-07-21T22:00:00Z'), '2026-07-22', 'Business-day date observes summer time');
assert.equal(workerBonusDayKey('invalid'), '');
assert(validWorkerBonusDay('2028-02-29'));
for (const value of ['', '2026-02-29', '2026-04-31', '2026-11-00', '2026-13-01', '22/11/2026', null]) assert(!validWorkerBonusDay(value));

const day = buildWorkerDailyBonusView(report, '2026-11-22');
assert.equal(day.earned, 4.05);
assert.equal(day.earnedCount, 4);
assert.deepEqual(day.sources.map(source => [source.source, source.earned, source.count]), [['BASE', 3.55, 3], ['TRANSPORT_CONTROL', .5, 1]]);
assert.deepEqual(day.rows.map(row => row.id), ['rounding', 'transport-day', 'base-day', 'midnight']);
assert.equal(day.available, 18.25, 'All-date available balance must not be replaced with selected-day earnings');
assert.equal(day.reserved, 4.5);
assert.deepEqual(day.bookingWarnings, report.dailyWarnings, 'Daily booking warnings stay separate from monthly reconciliation warnings');
assert.equal(buildWorkerDailyBonusView(report, '2026-11-21').earned, .5, 'Use Arka posting date even when qualification is another day');
assert.equal(buildWorkerDailyBonusView(report, '2026-11-15').earned, 0);
assert.equal(buildWorkerDailyBonusView(report, '2026-11-15').available, 18.25);
console.log('PASS daily bonus view: Kosovo date boundaries, actual posting dates, source totals, eligibility and all-date current balances');

// A posted November credit remains visible even if it is absent from monthly
// qualification/retention rows. The booking may intentionally carry an old date.
const carry = { ...copy(report), rows: [], dailyRows: [posted('carry', 'BASE', 2, '2026-11-01T00:00:00Z', { earnedAt: '2026-10-20T10:00:00Z', status: 'RETAINED', available: 0, retained: 2 })] };
assert.equal(buildWorkerDailyBonusView(carry, '2026-11-01').earned, 2);
assert.equal(buildWorkerDailyBonusView(carry, '2026-11-22').earned, 0);
assert.deepEqual(report, originalReport, 'The presentation helper must not mutate ledger inputs');

const incomplete = mutation => {
  const value = copy(report);
  mutation(value);
  assert.throws(() => buildWorkerDailyBonusView(value, '2026-11-22'), error => error.code === 'WORKER_DAILY_BONUS_REPORT_INCOMPLETE');
};
incomplete(value => { delete value.dailyRows; });
incomplete(value => { value.enabled = false; });
incomplete(value => { value.month = '2026-10'; });
incomplete(value => { delete value.dailyRows[0].eligible; });
incomplete(value => { value.dailyRows[0].creditedAt = null; });
incomplete(value => { value.dailyRows[0].creditedAt = 'invalid'; });
incomplete(value => { value.dailyRows[0].creditedAt = '2026-10-20T10:00:00Z'; });
incomplete(value => { value.dailyRows[0].source = 'PENDING_CONTROL'; });
incomplete(value => { value.dailyRows[0].amount = '3.25'; });
incomplete(value => { value.dailyRows[0].amount = -3.25; });
incomplete(value => { value.dailyRows.push(copy(value.dailyRows[0])); });
incomplete(value => { delete value.totals.available; });
incomplete(value => { value.totals.reserved = -1; });
assert.throws(() => buildWorkerDailyBonusView(report, '2026-02-29'), /datë të vlefshme/);
console.log('PASS incomplete, duplicate or invalid daily credit contracts fail explicitly; missing bookings never inherit qualification dates');
console.log('Worker daily bonus view checks passed.');
