const number = value => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};
const cents = value => Math.round(number(value) * 100);

export function getHandoffReceiptTotals(row = {}) {
  const expected = cents(row.original_amount ?? row.expected_amount ?? row.amount);
  const tracked = row.receipt_tracking === true;
  const received = tracked ? cents(row.receipt_received_amount) : (String(row.status).toUpperCase() === 'ACCEPTED' ? expected : 0);
  const resolved = tracked ? cents(row.receipt_resolved_amount) : 0;
  const outstanding = tracked ? Math.max(0, expected - received - resolved) : (String(row.status).toUpperCase() === 'PENDING_DISPATCH_APPROVAL' ? expected : 0);
  return { expected: expected / 100, received: received / 100, resolved: resolved / 100, outstanding: outstanding / 100, tracked };
}

export function getHandoffOutstandingAmount(row = {}) {
  return getHandoffReceiptTotals(row).outstanding;
}

export function validateReceiptAmount(value, { allowZero = false } = {}) {
  if (!['number','string'].includes(typeof value) || (typeof value === 'string' && !/^\d+(?:\.\d{1,2})?$/.test(value.trim()))) return null;
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0 || (!allowZero && amount === 0) || amount > 10000000 || Math.abs(amount * 100 - Math.round(amount * 100)) > 0.00001) return null;
  return Math.round(amount * 100) / 100;
}

export function receiptStateLabel(row = {}) {
  const { expected, received, resolved, outstanding, tracked } = getHandoffReceiptTotals(row);
  if (!tracked) return String(row.status).toUpperCase() === 'ACCEPTED' ? 'Pranuar' : 'Pret pranimin';
  if (outstanding > 0) return received > 0 ? 'Pranuar pjesërisht' : 'Diferencë për sqarim';
  return resolved > 0 ? 'Mbyllur me diferencë të sqaruar' : (expected === received ? 'Pranuar plotësisht' : 'Mbyllur');
}
