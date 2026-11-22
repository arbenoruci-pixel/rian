import { BUJAR_USER_ID } from './baseBonusEvidence.js';

export const WORKER_BONUS_TIME_ZONE = 'Europe/Belgrade';
const SOURCE_LABELS = { BASE: 'Baza', TRANSPORT_CONTROL: 'Kontrolli i Transportit' };
const PENDING_HANDOFFS = new Set(['PENDING', 'PENDING_DISPATCH_APPROVAL']);
const cents = value => Math.round((Number(value) || 0) * 100);
const money = value => Math.round(value) / 100;
const key = value => String(value ?? '');
const upper = value => key(value).trim().toUpperCase();
const allocationConfirmed = (allocation, handoff) => upper(allocation.status) === 'RETAINED'
  && (upper(handoff.status) === 'ACCEPTED' || (handoff.receipt_tracking === true && PENDING_HANDOFFS.has(upper(handoff.status))));
const allocationRetentionDate = (allocation, handoff) => handoff.receipt_tracking === true
  ? allocation.updated_at || null : handoff.decided_at || null;

export function workerBonusMonthKey(value = new Date()) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: WORKER_BONUS_TIME_ZONE, year: 'numeric', month: '2-digit',
  }).formatToParts(date);
  return `${parts.find(p => p.type === 'year').value}-${parts.find(p => p.type === 'month').value}`;
}

export function validWorkerBonusMonth(month) {
  return typeof month === 'string' && /^(20\d{2})-(0[1-9]|1[0-2])$/.test(month);
}

function sourceOf(bonus) {
  return bonus.transport_control_id ? 'TRANSPORT_CONTROL' : 'BASE';
}

function codeOf(bonus) {
  return key(bonus.transport_control_id
    ? bonus.metadata?.transport_code || bonus.transport_code || 'Transport'
    : bonus.order_code || (bonus.order_id ? `Porosia ${bonus.order_id}` : 'Baza'));
}

function freshTotals() {
  return { earned: 0, earnedCount: 0, retained: 0, retainedCount: 0, available: 0, reserved: 0, retainedAllTime: 0, ledgerRetainedAllTime: 0 };
}

function publicTotals(value) {
  return Object.fromEntries(Object.entries(value).map(([name, amount]) => [name, name.endsWith('Count') ? amount : money(amount)]));
}

// Read model only. Earning dates and cash-retention dates are different events.
// A bonus approval/payment record is never treated as proof of cash retention.
export function buildWorkerBonusAccount({ worker = {}, bonuses = [], allocations = [], handoffs = [], bonusPayments = [], pendingControls = [], month, now = new Date() } = {}) {
  const generatedAt = new Date(now).toISOString();
  const selectedMonth = month || workerBonusMonthKey(now);
  if (!validWorkerBonusMonth(selectedMonth)) throw new Error('WORKER_BONUS_MONTH_INVALID');
  const bySource = Object.fromEntries(Object.keys(SOURCE_LABELS).map(source => [source, freshTotals()]));
  const bonusMap = new Map(bonuses.map(b => [key(b.id), b]));
  const handoffMap = new Map(handoffs.map(h => [key(h.id), h]));
  const bookingMap = new Map(bonusPayments.filter(p => upper(p.type) === 'READY_48H_BONUS').map(p => [key(p.id), p]));
  const allocationsByBonus = new Map();
  const allocationsByHandoff = new Map();
  const warnings = [];
  for (const allocation of allocations) {
    const bonus = bonusMap.get(key(allocation.bonus_id));
    if (!bonus) continue;
    const list = allocationsByBonus.get(key(bonus.id)) || [];
    list.push(allocation);
    allocationsByBonus.set(key(bonus.id), list);
    const items = allocationsByHandoff.get(key(allocation.handoff_id)) || [];
    items.push(allocation);
    allocationsByHandoff.set(key(allocation.handoff_id), items);
  }

  const rows = [], dailyRows = [], dailyWarnings = [];
  for (const bonus of bonuses) {
    const source = sourceOf(bonus), totals = bySource[source];
    const earnedAt = bonus.qualification_at || bonus.activated_at || bonus.ready_at || null;
    const earnedThisMonth = earnedAt && workerBonusMonthKey(earnedAt) === selectedMonth;
    const amount = cents(bonus.amount), available = cents(bonus.remaining_amount), reserved = cents(bonus.reserved_amount);
    const ledgerRetained = cents(bonus.retained_amount);
    const eligible = bonus.eligible === true && !['VOIDED', 'REVIEW_REQUIRED', 'INELIGIBLE'].includes(upper(bonus.status));
    if (eligible && earnedThisMonth) { totals.earned += amount; totals.earnedCount++; }
    if (eligible) totals.available += available;
    totals.reserved += reserved;
    totals.ledgerRetainedAllTime += ledgerRetained;
    let retained = 0, retainedInMonth = 0, reservedInHandoffs = 0;
    const links = [];
    for (const allocation of allocationsByBonus.get(key(bonus.id)) || []) {
      const handoff = handoffMap.get(key(allocation.handoff_id));
      const allocationStatus = upper(allocation.status);
      const allocationAmount = cents(allocation.amount);
      if (!handoff) {
        warnings.push({ code: 'HANDOFF_MISSING', bonusId: key(bonus.id), orderCode: codeOf(bonus), difference: money(allocationAmount) });
        continue;
      }
      const handoffStatus = upper(handoff.status);
      const retainedAt = allocationConfirmed(allocation, handoff) ? allocationRetentionDate(allocation, handoff) : null;
      if (allocationConfirmed(allocation, handoff)) {
        retained += allocationAmount;
        if (retainedAt && workerBonusMonthKey(retainedAt)) {
          if (workerBonusMonthKey(retainedAt) === selectedMonth) retainedInMonth += allocationAmount;
        } else {
          warnings.push({ code: 'RETENTION_DATE_MISSING', bonusId: key(bonus.id), orderCode: codeOf(bonus), difference: money(allocationAmount) });
        }
      }
      if (allocationStatus === 'RESERVED' && PENDING_HANDOFFS.has(handoffStatus)) reservedInHandoffs += allocationAmount;
      links.push({ id: key(handoff.id), status: handoffStatus, receiptTracking: handoff.receipt_tracking === true, allocationStatus, retainedAt, amount: money(allocationAmount), submittedAt: handoff.submitted_at || null, decidedAt: handoff.decided_at || null });
    }
    totals.retainedAllTime += retained;
    totals.retained += retainedInMonth;
    if (retainedInMonth > 0) totals.retainedCount++;
    const reconciliationDifference = retained - ledgerRetained;
    if (reconciliationDifference !== 0) warnings.push({ code: 'RETAINED_MISMATCH', bonusId: key(bonus.id), orderCode: codeOf(bonus), difference: money(reconciliationDifference) });
    if (reservedInHandoffs !== reserved) warnings.push({ code: 'RESERVED_MISMATCH', bonusId: key(bonus.id), orderCode: codeOf(bonus), difference: money(reservedInHandoffs - reserved) });
    if (eligible && amount !== available + reserved + ledgerRetained) warnings.push({ code: 'BALANCE_MISMATCH', bonusId: key(bonus.id), orderCode: codeOf(bonus), difference: money(available + reserved + ledgerRetained - amount) });
    // Daily Arka follows the linked bonus booking, including intentionally
    // backdated evidence and delayed offline payment activation. Never use the
    // originating customer payment or invent a booking date from qualification.
    const booking = bookingMap.get(key(bonus.arka_payment_id));
    const creditedAt = booking?.created_at && Number.isFinite(new Date(booking.created_at).getTime()) ? booking.created_at : null;
    const row = { id: key(bonus.id), source, code: codeOf(bonus), earnedAt, creditedAt, eligible, m2: Number(bonus.m2) || 0, amount: money(amount), status: upper(bonus.status), available: eligible ? money(available) : 0, reserved: money(reserved), retained: money(retained), ledgerRetained: money(ledgerRetained), handoffs: links, reconciliationDifference: money(reconciliationDifference) };
    if (amount > 0 && creditedAt && workerBonusMonthKey(creditedAt) === selectedMonth) dailyRows.push(row);
    if (eligible && amount > 0 && !creditedAt) dailyWarnings.push({ code: 'BOOKING_MISSING', bonusId: key(bonus.id), orderCode: codeOf(bonus) });
    if ((amount > 0 || retained > 0 || available > 0 || reserved > 0) && (earnedThisMonth || retainedInMonth > 0 || available > 0 || reserved > 0)) rows.push(row);
  }
  rows.sort((a, b) => key(b.earnedAt).localeCompare(key(a.earnedAt)) || key(b.id).localeCompare(key(a.id), undefined, { numeric: true }));
  dailyRows.sort((a, b) => key(b.creditedAt).localeCompare(key(a.creditedAt)) || key(b.id).localeCompare(key(a.id), undefined, { numeric: true }));

  const visibleHandoffs = [];
  for (const handoff of handoffs) {
    const status = upper(handoff.status);
    const linkedAllocations = allocationsByHandoff.get(key(handoff.id)) || [];
    const retentionDates = linkedAllocations.filter(a => allocationConfirmed(a, handoff)).map(a => allocationRetentionDate(a, handoff)).filter(Boolean);
    const inPeriod = [handoff.submitted_at, handoff.decided_at, ...retentionDates].some(date => date && workerBonusMonthKey(date) === selectedMonth);
    if (!inPeriod && !PENDING_HANDOFFS.has(status)) continue;
    const entries = (allocationsByHandoff.get(key(handoff.id)) || []).map(a => {
      const bonus = bonusMap.get(key(a.bonus_id));
      return { bonusId: key(bonus.id), source: sourceOf(bonus), code: codeOf(bonus), amount: money(cents(a.amount)), status: upper(a.status) };
    });
    if (!entries.length) continue;
    const sumFor = source => entries.filter(a => a.source === source).reduce((sum, a) => sum + cents(a.amount), 0);
    const base = sumFor('BASE'), transport = sumFor('TRANSPORT_CONTROL');
    visibleHandoffs.push({ id: key(handoff.id), status, receiptTracking: handoff.receipt_tracking === true, retainedAt: retentionDates.sort()[0] || null, submittedAt: handoff.submitted_at || null, decidedAt: handoff.decided_at || null, base: money(base), transport: money(transport), total: money(base + transport), allocations: entries });
  }
  visibleHandoffs.sort((a, b) => key(b.submittedAt).localeCompare(key(a.submittedAt)));
  const total = freshTotals();
  for (const values of Object.values(bySource)) for (const field of Object.keys(total)) total[field] += values[field];
  const pending = pendingControls.filter(c => upper(c.status) === 'PENDING').map(control => ({
    id: key(control.id), code: key(control.order?.code_str || control.code_str || 'Transport'), status: 'PENDING',
    orderStatus: key(control.order?.status || control.order_status || ''), submittedAt: control.submitted_at || control.created_at || null,
    potentialAmount: 0.5, blocked: !['pastrim', 'gati'].includes(control.order?.status || control.order_status),
  }));
  return {
    version: 'worker-bonus-account-v1', enabled: worker.id === BUJAR_USER_ID || bonuses.some(b => b.eligible || cents(b.amount) > 0),
    worker: { id: key(worker.id), name: key(worker.name) }, month: selectedMonth, timezone: WORKER_BONUS_TIME_ZONE, generatedAt,
    totals: publicTotals(total), sources: Object.entries(bySource).map(([source, values]) => ({ source, label: SOURCE_LABELS[source], ...publicTotals(values) })),
    rows, dailyRows, dailyWarnings, handoffs: visibleHandoffs, pendingControls: pending, warnings,
  };
}
