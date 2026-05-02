function n(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function clean(value) {
  return String(value || '').trim();
}

function up(value) {
  return clean(value).toUpperCase();
}

function monthKey(value) {
  return clean(value).slice(0, 7);
}

const EXCLUDED_PAYROLL_ROLES = new Set([
  'ADMIN',
  'ADMIN_MASTER',
  'SUPERADMIN',
  'OWNER',
  'PRONAR',
  'MASTER',
  'SYSTEM',
]);

const EXCLUDED_PAYROLL_PINS = new Set(['2380']);

export function isPayrollEligibleWorker(worker = {}) {
  const role = up(worker?.role);
  const pin = clean(worker?.pin);
  const name = up(worker?.name);

  if (worker?.is_active === false) return false;
  if (EXCLUDED_PAYROLL_PINS.has(pin)) return false;
  if (EXCLUDED_PAYROLL_ROLES.has(role)) return false;
  if (name.includes('MASTER USER')) return false;
  if (name === 'MASTER') return false;

  return true;
}

function isWithinMonth(row, month) {
  const created = row?.created_at || row?.updated_at || row?.approved_at || row?.handed_at || '';
  return monthKey(created) === month;
}

function matchesWorker(row, worker) {
  const pin = clean(worker?.pin);
  const name = up(worker?.name);
  const rowPins = [
    row?.created_by_pin,
    row?.worker_pin,
    row?.handed_by_pin,
    row?.approved_by_pin,
    row?.driver_pin,
    row?.transport_pin,
  ].map(clean).filter(Boolean);

  if (pin && rowPins.includes(pin)) return true;

  const rowNames = [
    row?.created_by_name,
    row?.worker_name,
    row?.handed_by_name,
    row?.approved_by_name,
    row?.driver_name,
    row?.transport_name,
  ].map(up).filter(Boolean);

  return Boolean(name && rowNames.includes(name));
}

function isTransportRow(row) {
  const type = up(row?.type);
  const source = up(row?.source_module);
  if (type === 'TRANSPORT' || source === 'TRANSPORT') return true;
  if (clean(row?.transport_order_id) || clean(row?.transport_code_str)) return true;
  return /\bT\d+\b/i.test(`${clean(row?.order_code)} ${clean(row?.note)} ${clean(row?.client_name)}`);
}

function rowM2(row) {
  const direct = [
    row?.transport_m2,
    row?.m2,
    row?.m2_total,
    row?.data?.m2,
    row?.data?.m2_total,
    row?.data?.pay?.m2,
  ];
  for (const item of direct) {
    const val = n(item);
    if (val > 0) return val;
  }

  const text = `${clean(row?.note)} ${clean(row?.client_name)}`;
  const match = text.match(/(\d+(?:[.,]\d+)?)\s*(?:m²|m2)/i);
  if (match?.[1]) return n(String(match[1]).replace(',', '.'));
  return 0;
}

function amountOf(rows) {
  return rows.reduce((sum, row) => sum + n(row?.amount), 0);
}

export function getCurrentPayrollMonth(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

export function getMonthWindow(month) {
  const safeMonth = /^\d{4}-\d{2}$/.test(String(month || '')) ? String(month) : getCurrentPayrollMonth();
  const [year, monthNumber] = safeMonth.split('-').map(Number);
  const start = new Date(Date.UTC(year, monthNumber - 1, 1, 0, 0, 0));
  const end = new Date(Date.UTC(year, monthNumber, 1, 0, 0, 0));
  return {
    month: safeMonth,
    startIso: start.toISOString(),
    endIso: end.toISOString(),
  };
}

export function buildMonthlyPayrollPreview({ workers = [], paymentRows = [], month = getCurrentPayrollMonth() } = {}) {
  const safeMonth = String(month || getCurrentPayrollMonth()).slice(0, 7);
  const rows = Array.isArray(paymentRows) ? paymentRows.filter((row) => isWithinMonth(row, safeMonth)) : [];
  const eligibleWorkers = (Array.isArray(workers) ? workers : []).filter(isPayrollEligibleWorker);

  return eligibleWorkers.map((worker, index) => {
    const workerRows = rows.filter((row) => matchesWorker(row, worker));
    const baseSalary = n(worker?.salary ?? worker?.baseSalary);
    const bonusTransport = n(worker?.bonus_transport);
    const bonusUshqim = n(worker?.bonus_ushqim);
    const manualAdvance = n(worker?.avans_manual ?? worker?.manualAdvance);
    const longTermDebt = n(worker?.borxh_afatgjat ?? worker?.longTermDebt);
    const commissionRateM2 = n(worker?.commission_rate_m2) > 0 ? n(worker?.commission_rate_m2) : 0.5;
    const isHybridTransport = worker?.is_hybrid_transport === true;

    const advanceRows = workerRows.filter((row) => up(row?.status) === 'ADVANCE' || up(row?.type) === 'ADVANCE');
    const mealRows = workerRows.filter((row) => ['MEAL_PAYMENT', 'MEAL_COVERED'].includes(up(row?.type)) || /\b(USHQIM|MEAL)\b/i.test(clean(row?.note)));
    const debtRows = workerRows.filter((row) => ['OWED', 'REJECTED', 'WORKER_DEBT'].includes(up(row?.status)));
    const openCashRows = workerRows.filter((row) => {
      const type = up(row?.type);
      const status = up(row?.status);
      if (['ADVANCE', 'MEAL_PAYMENT', 'MEAL_COVERED', 'EXPENSE', 'TIMA'].includes(type)) return false;
      return ['PENDING', 'COLLECTED'].includes(status);
    });
    const pendingHandoffRows = workerRows.filter((row) => up(row?.status) === 'PENDING_DISPATCH_APPROVAL');

    const transportRows = workerRows.filter((row) => {
      const status = up(row?.status);
      return isTransportRow(row) && ['ACCEPTED_BY_DISPATCH', 'APPROVED', 'ACCEPTED', 'DONE', 'DELIVERED', 'COLLECTED'].includes(status);
    });
    const transportM2 = transportRows.reduce((sum, row) => sum + rowM2(row), 0);
    const transportCommission = isHybridTransport ? transportM2 * commissionRateM2 : 0;

    const advancesTotal = amountOf(advanceRows) + manualAdvance;
    const mealTotal = amountOf(mealRows);
    const debtTotal = amountOf(debtRows) + longTermDebt;
    const openCash = amountOf(openCashRows);
    const pendingHandoff = amountOf(pendingHandoffRows);

    // Payroll monthly salary rule:
    // Monthly salary is affected only by personal advances.
    // Transport commission, meals, company expenses, and client cash are informational/control fields.
    const gross = baseSalary;
    const deductions = advancesTotal;
    const net = Math.max(0, gross - deductions);
    const carryOver = Math.max(0, deductions - gross);

    const warnings = [];
    if (openCash > 0) warnings.push(`Ka cash të hapur: €${openCash.toFixed(2)}`);
    if (pendingHandoff > 0) warnings.push(`Ka dorëzim në pritje: €${pendingHandoff.toFixed(2)}`);
    if (carryOver > 0) warnings.push(`Avansi kalon rrogën, bartet: €${carryOver.toFixed(2)}`);
    if (baseSalary <= 0) warnings.push('Mungon rroga bazë');

    let statusKind = 'ok';
    let statusLabel = 'OK PËR PAGESË';
    if (openCash > 0 || pendingHandoff > 0) {
      statusKind = 'blocked';
      statusLabel = 'BLLOKUAR';
    } else if (warnings.length > 0) {
      statusKind = 'review';
      statusLabel = 'KONTROLLO';
    }

    return {
      key: clean(worker?.id) || clean(worker?.pin) || `${index}`,
      id: worker?.id || null,
      pin: clean(worker?.pin),
      role: clean(worker?.role),
      name: clean(worker?.name) || 'PA EMËR',
      baseSalary,
      bonusTransport,
      bonusUshqim,
      transportM2,
      transportCommission,
      advancesTotal,
      mealTotal,
      debtTotal,
      openCash,
      pendingHandoff,
      gross,
      deductions,
      net,
      carryOver,
      warnings,
      statusKind,
      statusLabel,
      blocked: statusKind === 'blocked',
    };
  });
}
