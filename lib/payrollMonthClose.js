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

  return (Array.isArray(workers) ? workers : []).map((worker, index) => {
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
    const openCashRows = workerRows.filter((row) => !['ADVANCE', 'MEAL_PAYMENT', 'MEAL_COVERED', 'EXPENSE', 'TIMA'].includes(up(row?.type)) && ['PENDING', 'COLLECTED'].includes(up(row?.status)));
    const pendingHandoffRows = workerRows.filter((row) => up(row?.status) === 'PENDING_DISPATCH_APPROVAL');

    const transportRows = workerRows.filter((row) => isTransportRow(row) && ['ACCEPTED_BY_DISPATCH', 'APPROVED', 'ACCEPTED', 'DONE', 'DELIVERED', 'COLLECTED'].includes(up(row?.status)));
    const transportM2 = transportRows.reduce((sum, row) => sum + rowM2(row), 0);
    const transportCommission = isHybridTransport ? transportM2 * commissionRateM2 : 0;

    const advancesTotal = advanceRows.reduce((sum, row) => sum + n(row?.amount), 0) + manualAdvance;
    const mealTotal = mealRows.reduce((sum, row) => sum + n(row?.amount), 0);
    const debtTotal = debtRows.reduce((sum, row) => sum + n(row?.amount), 0) + longTermDebt;
    const openCash = openCashRows.reduce((sum, row) => sum + n(row?.amount), 0);
    const pendingHandoff = pendingHandoffRows.reduce((sum, row) => sum + n(row?.amount), 0);

    const gross = baseSalary + bonusTransport + bonusUshqim + transportCommission;
    const deductions = advancesTotal + mealTotal + debtTotal;
    const net = Math.max(0, gross - deductions);
    const carryOver = Math.max(0, deductions - gross);

    const warnings = [];
    if (openCash > 0) warnings.push(`Ka cash të hapur: €${openCash.toFixed(2)}`);
    if (pendingHandoff > 0) warnings.push(`Ka dorëzim në pritje: €${pendingHandoff.toFixed(2)}`);
    if (carryOver > 0) warnings.push(`Bartet borxh: €${carryOver.toFixed(2)}`);
    if (baseSalary <= 0) warnings.push('Mungon rroga bazë');

    return {
      key: clean(worker?.id) || clean(worker?.pin) || `${index}`,
      id: worker?.id || null,
      pin: clean(worker?.pin),
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
      blocked: openCash > 0 || pendingHandoff > 0,
    };
  });
}
