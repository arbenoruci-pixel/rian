// Read-only classification for the daily Arka history. Bonus approval records
// are separate from customer receipts and from accepted cash-handoff payouts.
const upper = (value) => String(value || '').trim().toUpperCase();
const cancelled = new Set(['VOIDED', 'CANCELLED', 'REJECTED', 'REFUZUAR', 'INELIGIBLE']);

export function isArkaHistoryBonus(row = {}) {
  return upper(row?.type) === 'READY_48H_BONUS'
    || upper(row?.source_module) === 'TRANSPORT_CONTROL';
}

export function arkaHistoryBonusSource(row = {}) {
  return upper(row?.source_module) === 'TRANSPORT_CONTROL' ? 'TRANSPORT_CONTROL' : 'BASE';
}

export function arkaHistoryBonusStatusLabel(row = {}) {
  const status = upper(row?.status);
  if (status === 'VOIDED' || status === 'CANCELLED') return 'BONUS I ANULUAR';
  if (status === 'REJECTED' || status === 'REFUZUAR') return 'BONUS I REFUZUAR';
  if (status === 'INELIGIBLE') return 'PA TË DREJTË BONUSI';
  if (status === 'PENDING') return 'BONUS NË PRITJE';
  if (status === 'ACCEPTED' || status === 'ACCEPTED_BY_DISPATCH') return 'BONUS I APROVUAR';
  return 'BONUS I REGJISTRUAR';
}

export function groupArkaHistoryBonuses(rows = []) {
  const bonuses = (Array.isArray(rows) ? rows : []).filter(isArkaHistoryBonus);
  return [
    { source: 'BASE', label: 'BONUS BAZE' },
    { source: 'TRANSPORT_CONTROL', label: 'BONUS KONTROLLI TRANSPORTI' },
  ].map((group) => {
    const sourceRows = bonuses.filter((row) => arkaHistoryBonusSource(row) === group.source);
    const cents = sourceRows.reduce((total, row) => {
      const amount = Number(row?.amount ?? row?.value ?? row?.total_amount ?? row?.sum ?? 0);
      return total + (Number.isFinite(amount) && amount > 0 && !cancelled.has(upper(row?.status))
        ? Math.round(amount * 100) : 0);
    }, 0);
    return { ...group, amount: cents / 100, rows: sourceRows };
  }).filter((group) => group.rows.length);
}
