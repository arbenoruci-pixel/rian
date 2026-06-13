import { supabase } from '@/lib/supabaseClient';
import { listUserRecords } from '@/lib/usersService';
import { ARKA_ACTION, ARKA_PAYMENT_STATUS, ARKA_PAYMENT_TYPE, ARKA_SOURCE_MODULE } from '@/lib/arka/arkaConstants';
import { arkaTransaction, buildArkaIdempotencyKey } from '@/lib/arka/arkaClient';

const EXTRA_TABLE = 'arka_pending_payments';
const SETTLED_TAG = 'SETTLED_IN_HANDOFF:';

function cleanNum(v) {
  const x = Number(v || 0);
  return Number.isFinite(x) ? x : 0;
}

function cleanText(v, fallback = '') {
  const s = String(v || '').trim();
  return s || fallback;
}

function nowIso() {
  return new Date().toISOString();
}

export function describeArkaDbError(error, label = 'ARKA DB') {
  if (!error) return label;
  const parts = [];
  if (label) parts.push(label);
  const name = cleanText(error?.name);
  const code = cleanText(error?.code);
  const message = cleanText(error?.message || error?.error_description || error?.msg || String(error));
  const details = cleanText(error?.details);
  const hint = cleanText(error?.hint);
  const status = cleanText(error?.status);
  if (name && name !== 'Error' && !message.includes(name)) parts.push(name);
  if (code) parts.push(`CODE ${code}`);
  if (status) parts.push(`STATUS ${status}`);
  if (message) parts.push(message);
  if (details) parts.push(`DETAILS: ${details}`);
  if (hint) parts.push(`HINT: ${hint}`);
  return parts.filter(Boolean).join(' | ');
}

function throwArkaDbError(error, label = 'ARKA DB') {
  throw new Error(describeArkaDbError(error, label));
}

function byDateDesc(a, b) {
  return String(b?.created_at || b?.submitted_at || b?.updated_at || '').localeCompare(
    String(a?.created_at || a?.submitted_at || a?.updated_at || '')
  );
}

export function isExtraSettled(row) {
  const note = cleanText(row?.handoff_note);
  return note.includes(SETTLED_TAG);
}

function appendSettledTag(note, handoffId) {
  const base = cleanText(note);
  const tag = `${SETTLED_TAG}${handoffId}`;
  if (base.includes(tag)) return base;
  return base ? `${base} | ${tag}` : tag;
}

export async function listPendingPaymentRecords(options = {}) {
  const select = options?.select || '*';
  let q = supabase.from(EXTRA_TABLE).select(select);
  const eq = options?.eq || {};
  for (const [key, value] of Object.entries(eq)) q = q.eq(key, value);
  const inFilters = options?.in || {};
  for (const [key, values] of Object.entries(inFilters)) q = q.in(key, Array.isArray(values) ? values : [values]);
  if (options?.orderBy) q = q.order(options.orderBy, { ascending: !!options?.ascending });
  if (options?.limit) q = q.limit(options.limit);
  const { data, error } = await q;
  if (error) throwArkaDbError(error, `SUPABASE ${EXTRA_TABLE} SELECT`);
  return Array.isArray(data) ? data : [];
}

export async function listCashHandoffRecords(options = {}) {
  const select = options?.select || '*';
  let q = supabase.from('cash_handoffs').select(select);
  const eq = options?.eq || {};
  for (const [key, value] of Object.entries(eq)) q = q.eq(key, value);
  const inFilters = options?.in || {};
  for (const [key, values] of Object.entries(inFilters)) q = q.in(key, Array.isArray(values) ? values : [values]);
  if (options?.orderBy) q = q.order(options.orderBy, { ascending: !!options?.ascending });
  if (options?.limit) q = q.limit(options.limit);
  const { data, error } = await q;
  if (error) throwArkaDbError(error, 'SUPABASE cash_handoffs SELECT');
  return Array.isArray(data) ? data : [];
}

export async function listWorkerPendingPayments(pin, limit = 300) {
  const cleanPin = String(pin || '').trim();
  if (!cleanPin) return [];
  return listPendingPaymentRecords({
    eq: { created_by_pin: cleanPin },
    orderBy: 'created_at',
    ascending: false,
    limit,
  });
}

export async function listWorkerHandoffs(pin, limit = 100) {
  const cleanPin = String(pin || '').trim();
  if (!cleanPin) return [];
  return listCashHandoffRecords({
    eq: { worker_pin: cleanPin },
    orderBy: 'submitted_at',
    ascending: false,
    limit,
  });
}

export async function listTodayWorkers() {
  try {
    const users = await listUserRecords({
      select: 'id,name,pin,role,is_active,is_hybrid_transport,commission_rate_m2',
      orderBy: 'name',
      ascending: true,
    });
    const arkaVisibleRoles = new Set(['PUNTOR', 'PUNETOR', 'WORKER', 'TRANSPORT', 'DISPATCH']);
    return users.filter((u) => arkaVisibleRoles.has(String(u?.role || '').toUpperCase()) && u?.is_active !== false);
  } catch (error) {
    throwArkaDbError(error, 'SUPABASE users SELECT për listTodayWorkers');
  }
}

function uniqWorkerRows(rows = []) {
  const map = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const pin = cleanText(row?.pin);
    if (!pin) continue;
    const prev = map.get(pin) || {};
    map.set(pin, { ...prev, ...row, pin });
  }
  return [...map.values()];
}

function isoDay(v) {
  return String(v || '').slice(0, 10);
}

function sameToday(v) {
  return isoDay(v) === isoDay(nowIso());
}

const ARKA_TIME_ZONE = 'Europe/Belgrade';
const ACTIVE_MEAL_STATUSES = new Set([
  ARKA_PAYMENT_STATUS.PENDING,
  ARKA_PAYMENT_STATUS.COLLECTED,
  ARKA_PAYMENT_STATUS.PENDING_DISPATCH_APPROVAL,
  ARKA_PAYMENT_STATUS.ACCEPTED_BY_DISPATCH,
  'APPROVED',
  'ACCEPTED',
]);
const CLOSED_MEAL_STATUSES = new Set(['REJECTED', 'REFUZUAR', 'VOIDED', 'CANCELLED', 'CANCELED']);
const ARKA_DAILY_MEAL_AMOUNT = 3;

function normalizeDailyMealAmount(value = ARKA_DAILY_MEAL_AMOUNT) {
  const raw = cleanNum(value || ARKA_DAILY_MEAL_AMOUNT);
  if (raw > 0 && Math.abs(raw - ARKA_DAILY_MEAL_AMOUNT) > 0.005) {
    throw new Error('USHQIMI DITOR ËSHTË FIKS 3.00€ PËR PUNTOR.');
  }
  return ARKA_DAILY_MEAL_AMOUNT;
}

function formatTzDateKey(value = new Date(), timeZone = ARKA_TIME_ZONE) {
  const d = value instanceof Date ? value : new Date(value || Date.now());
  if (Number.isNaN(d.getTime())) return new Date().toISOString().slice(0, 10);
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
    const get = (type) => parts.find((part) => part.type === type)?.value || '';
    return `${get('year')}-${get('month')}-${get('day')}`;
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

function tzOffsetMs(timeZone, utcMs) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(new Date(utcMs));
    const get = (type) => Number(parts.find((part) => part.type === type)?.value || 0);
    const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
    return asUtc - utcMs;
  } catch {
    return 0;
  }
}

function zonedLocalToUtcMs(timeZone, y, m, d, h = 0, min = 0, sec = 0) {
  const guess = Date.UTC(y, m - 1, d, h, min, sec);
  const offset = tzOffsetMs(timeZone, guess);
  return Date.UTC(y, m - 1, d, h, min, sec) - offset;
}

function arkaTodayBoundsIso(refDate = new Date()) {
  try {
    const key = formatTzDateKey(refDate, ARKA_TIME_ZONE);
    const [y, m, d] = key.split('-').map((x) => Number(x));
    const startIso = new Date(zonedLocalToUtcMs(ARKA_TIME_ZONE, y, m, d, 0, 0, 0)).toISOString();
    const endIso = new Date(zonedLocalToUtcMs(ARKA_TIME_ZONE, y, m, d + 1, 0, 0, 0)).toISOString();
    return { dateKey: key, startIso, endIso };
  } catch {
    const key = new Date().toISOString().slice(0, 10);
    return { dateKey: key, startIso: `${key}T00:00:00.000Z`, endIso: new Date(Date.parse(`${key}T00:00:00.000Z`) + 86400000).toISOString() };
  }
}

function isActiveMealStatus(status) {
  const s = cleanText(status).toUpperCase();
  if (!s) return true;
  if (CLOSED_MEAL_STATUSES.has(s)) return false;
  return ACTIVE_MEAL_STATUSES.has(s) || !CLOSED_MEAL_STATUSES.has(s);
}

function mealNote(value = {}) {
  return String(value?.handoff_note || value?.handoffNote || value?.note || '');
}

function mealMarkerValue(note = '', marker = '') {
  const name = String(marker || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = String(note || '').match(new RegExp(`(?:^|[\\s|;])${name}:([^|;\\s]+)`, 'i'));
  return m ? String(m[1] || '').trim() : '';
}

function mealDayKeyFromRow(row = {}) {
  const note = mealNote(row);
  const marked = mealMarkerValue(note, 'MEAL_DAY')
    || mealMarkerValue(note, 'MEAL_OPEN')
    || mealMarkerValue(note, 'MEAL_CARRY')
    || mealMarkerValue(note, 'MEAL_DEBT');
  if (/^\d{4}-\d{2}-\d{2}$/.test(marked)) return marked;
  const raw = row?.created_at || row?.createdAt || row?.handed_at || row?.handedAt || '';
  return raw ? formatTzDateKey(new Date(raw), ARKA_TIME_ZONE) : '';
}

function mealRowMatchesDay(row = {}, dayKey = arkaTodayBoundsIso(new Date()).dateKey) {
  return mealDayKeyFromRow(row) === dayKey;
}

function mealHasGuardedMarker(row = {}) {
  const note = mealNote(row);
  return /(?:^|[\s|;])MEAL_(?:DAY|OPEN|CARRY|DEBT):\d{4}-\d{2}-\d{2}\b/i.test(note);
}

function mealTargetListFromRow(row = {}) {
  const note = mealNote(row);
  const single = mealMarkerValue(note, 'MEAL_FOR');
  const many = mealMarkerValue(note, 'MEAL_TARGETS');
  return [...new Set([single, ...String(many || '').split(',')].map((x) => cleanText(x)).filter(Boolean))];
}

function mealHandoffNoteCoversPin(row = {}, pin = '') {
  const cleanPin = cleanText(pin);
  if (!cleanPin) return false;
  const explicitTargets = mealTargetListFromRow(row);
  if (explicitTargets.length) return explicitTargets.includes(cleanPin);
  const note = mealNote(row);
  const escaped = cleanPin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\(${escaped}\\)|PIN\\s*${escaped}|:${escaped}\\b|\\b${escaped}\\b`, 'i').test(note);
}

function mealRowCoversWorker(row = {}, pin = '') {
  const cleanPin = cleanText(pin);
  if (!cleanPin) return false;
  const type = cleanText(row?.type).toUpperCase();
  const createdPin = cleanText(row?.created_by_pin);
  if (type === ARKA_PAYMENT_TYPE.MEAL_COVERED) {
    const explicitTargets = mealTargetListFromRow(row);
    if (explicitTargets.length) return explicitTargets.includes(cleanPin);
    return createdPin === cleanPin;
  }
  if (type === ARKA_PAYMENT_TYPE.MEAL_PAYMENT) {
    if (mealHandoffNoteCoversPin(row, cleanPin)) return true;
    // Legacy self-meal rows sometimes only have created_by_pin without a matching MEAL_COVERED row.
    return createdPin === cleanPin && !cleanText(row?.handoff_note);
  }
  return false;
}

function mealPaymentIsUnsettled(row = {}) {
  const type = cleanText(row?.type).toUpperCase();
  if (type !== ARKA_PAYMENT_TYPE.MEAL_PAYMENT) return false;
  if (!isActiveMealStatus(row?.status)) return false;
  if (isExtraSettled(row)) return false;
  return cleanNum(row?.amount) > 0;
}

function mealPaymentEligibleForHandoff(row = {}) {
  if (!mealPaymentIsUnsettled(row)) return false;
  // V4 safety: only rows created by the guarded meal flow can be deducted.
  // Plain/legacy MEAL_PAYMENT rows are ignored so old or manual rows cannot be swept into a handoff.
  return mealHasGuardedMarker(row);
}

function describeMealRow(row = {}) {
  const type = cleanText(row?.type).toUpperCase();
  const note = cleanText(row?.note || row?.handoff_note, 'USHQIM');
  const amount = cleanNum(row?.amount);
  const payer = cleanText(row?.created_by_name || row?.created_by_pin, 'PUNTOR');
  if (type === ARKA_PAYMENT_TYPE.MEAL_COVERED) return `${payer} • ${note} • ${amount.toFixed(2)}€`;
  return `${payer} • ${note} • ${amount.toFixed(2)}€`;
}

export async function listMealCoverageRowsTodayForPins(pins = [], { limit = 1000 } = {}) {
  const cleanPins = [...new Set((Array.isArray(pins) ? pins : [pins]).map((pin) => cleanText(pin)).filter(Boolean))];
  if (!cleanPins.length) return [];
  const bounds = arkaTodayBoundsIso(new Date());
  const { data, error } = await supabase
    .from(EXTRA_TABLE)
    .select('*')
    .in('type', [ARKA_PAYMENT_TYPE.MEAL_PAYMENT, ARKA_PAYMENT_TYPE.MEAL_COVERED])
    .gte('created_at', bounds.startIso)
    .lt('created_at', bounds.endIso)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throwArkaDbError(error, `SUPABASE ${EXTRA_TABLE} MEAL COVERAGE SELECT`);
  return (Array.isArray(data) ? data : [])
    .filter((row) => isActiveMealStatus(row?.status))
    .filter((row) => mealRowMatchesDay(row, bounds.dateKey))
    .filter((row) => cleanPins.some((pin) => mealRowCoversWorker(row, pin)))
    .sort(byDateDesc);
}

export async function listWorkerMealRowsToday(pin, { limit = 200 } = {}) {
  const cleanPin = cleanText(pin);
  if (!cleanPin) return [];
  return listMealCoverageRowsTodayForPins([cleanPin], { limit });
}

export async function listWorkerUnsettledMealPayments(pin, { limit = 100 } = {}) {
  const cleanPin = cleanText(pin);
  if (!cleanPin) return [];
  const queryLimit = Math.max(Number(limit || 100) * 4, 250);
  const { data, error } = await supabase
    .from(EXTRA_TABLE)
    .select('*')
    .eq('created_by_pin', cleanPin)
    .eq('type', ARKA_PAYMENT_TYPE.MEAL_PAYMENT)
    .in('status', Array.from(ACTIVE_MEAL_STATUSES))
    .order('created_at', { ascending: false })
    .limit(queryLimit);
  if (error) throwArkaDbError(error, `SUPABASE ${EXTRA_TABLE} UNSETTLED MEAL SELECT`);
  return (Array.isArray(data) ? data : [])
    .filter(mealPaymentEligibleForHandoff)
    .sort(byDateDesc)
    .slice(0, limit);
}

async function assertMealTargetsAreOpenToday(targets = []) {
  const pins = [...new Set((Array.isArray(targets) ? targets : []).map((row) => cleanText(row?.pin)).filter(Boolean))];
  if (!pins.length) return [];
  const existing = await listMealCoverageRowsTodayForPins(pins);
  if (existing.length) {
    const first = existing[0];
    const coveredPin = pins.find((pin) => mealRowCoversWorker(first, pin)) || pins[0];
    throw new Error(`USHQIMI PËR PIN ${coveredPin} ËSHTË REGJISTRUAR TASHMË SOT: ${describeMealRow(first)}`);
  }
  return [];
}

function mealPaymentChargedToPin(row = {}, pin = '') {
  const cleanPin = cleanText(pin);
  if (!cleanPin || !mealPaymentEligibleForHandoff(row)) return false;
  return cleanText(row?.created_by_pin) === cleanPin;
}

function sumMealPaymentsForPin(rows = [], pin = '') {
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => mealPaymentChargedToPin(row, pin))
    .reduce((sum, row) => sum + cleanNum(row?.amount), 0);
}

function mealDecisionAlreadyRegisteredSummary(rows = [], pin = '', ownPaymentRows = []) {
  const allRows = [
    ...(Array.isArray(rows) ? rows : []),
    ...(Array.isArray(ownPaymentRows) ? ownPaymentRows : []),
  ];
  const first = allRows.find(Boolean);
  if (!first) return '';
  const deduct = sumMealPaymentsForPin(allRows, pin);
  if (deduct > 0) return `USHQIMI / MBULIMI EKZISTON DHE DO TË ZBRITET NGA TY: -${deduct.toFixed(2)}€`;
  return `USHQIMI EKZISTON: ${describeMealRow(first)}`;
}

function findMealStaffByPin(staffOptions = [], pin = '') {
  const cleanPin = cleanText(pin);
  if (!cleanPin) return null;
  return (Array.isArray(staffOptions) ? staffOptions : []).find((row) => cleanText(row?.pin) === cleanPin) || null;
}

export async function ensureMealDecisionBeforeHandoff({
  actor,
  workerPin = '',
  workerName = '',
  workerRole = '',
  staffOptions = [],
  amountPerPerson = 3,
} = {}) {
  const pin = cleanText(workerPin || actor?.pin);
  const name = cleanText(workerName || actor?.name || pin, pin || 'PUNTOR');
  const role = cleanText(workerRole || actor?.role, 'WORKER').toUpperCase();
  const per = normalizeDailyMealAmount(amountPerPerson);
  if (!pin) throw new Error('MUNGON PIN-I PËR KONTROLLIN E USHQIMIT.');

  const [currentRows, ownPaymentRows] = await Promise.all([
    listWorkerMealRowsToday(pin).catch(() => []),
    listWorkerUnsettledMealPayments(pin).catch(() => []),
  ]);
  const ownDeductTotal = sumMealPaymentsForPin(ownPaymentRows, pin);
  const currentWorkerAlreadyCovered = currentRows.length > 0;
  if (currentWorkerAlreadyCovered) {
    return {
      ok: true,
      alreadyRegistered: true,
      rows: currentRows,
      ownPaymentRows,
      deductAmount: ownDeductTotal,
      confirmLine: mealDecisionAlreadyRegisteredSummary(currentRows, pin, ownPaymentRows),
    };
  }

  if (typeof window === 'undefined' || typeof window.prompt !== 'function') {
    return { ok: true, skipped: true, confirmLine: 'USHQIMI NUK U KONFIRMUA NË UI.' };
  }

  const existingChargeLine = ownDeductTotal > 0
    ? `KE PAGESË USHQIMI PËR TË TJERËT: -${ownDeductTotal.toFixed(2)}€ DO TË ZBRITET NGA TY.`
    : '';
  const choice = String(window.prompt([
    'USHQIMI PARA DORËZIMIT',
    existingChargeLine,
    '',
    '1 - E kam pagu vet (zbritet prej dorëzimit tim)',
    '2 - Ma ka pagu punëtor tjetër',
    '3 - Nuk kam marrë / s’ka ushqim',
    '',
    'Shkruaj 1, 2 ose 3:'
  ].filter(Boolean).join('\n')) || '').trim().toLowerCase();

  if (!choice) throw new Error('DORËZIMI U NDALUA: KONFIRMO USHQIMIN PARA SE ME DORËZU.');

  if (['3', 'jo', 'j', 'nuk', 'ska', 's', 'pa'].includes(choice)) {
    const ok = typeof window.confirm === 'function'
      ? window.confirm('Po vazhdon pa ushqim të regjistruar për sot. A është saktë?')
      : true;
    if (!ok) throw new Error('DORËZIMI U NDALUA: USHQIMI NUK U KONFIRMUA.');
    return {
      ok: true,
      skipped: true,
      deductAmount: ownDeductTotal,
      confirmLine: ownDeductTotal > 0
        ? `USHQIMI PËR TY: PA USHQIM. MBULIMI QË KE PAGUAR PËR TË TJERËT ZBRITET: -${ownDeductTotal.toFixed(2)}€.`
        : 'USHQIMI: PA USHQIM / PA ZBRITJE.',
    };
  }

  if (['1', 'vet', 'vete', 'vetë', 'self'].includes(choice)) {
    await createMealDistributionEntry({
      actor,
      payerPin: pin,
      payerName: name,
      payerRole: role,
      coveredWorkers: [],
      amountPerPerson: per,
      includePayerMeal: true,
      note: 'USHQIM PARA DORËZIMIT',
    });
    const afterRows = await listWorkerUnsettledMealPayments(pin).catch(() => []);
    const deduct = sumMealPaymentsForPin(afterRows, pin);
    return { ok: true, created: true, paidBySelf: true, deductAmount: deduct, confirmLine: `USHQIMI: E PAGOVE VET • ZBRITET -${deduct.toFixed(2)}€.` };
  }

  if (['2', 'tjeter', 'tjetër', 'other'].includes(choice)) {
    const activeRows = (Array.isArray(staffOptions) ? staffOptions : []).filter((row) => cleanText(row?.pin) && cleanText(row?.pin) !== pin);
    const list = activeRows.slice(0, 25).map((row) => `${cleanText(row?.pin)} - ${cleanText(row?.name || row?.pin)}`).join('\n');
    const payerPin = cleanText(window.prompt([
      'KUSH TA KA PAGU USHQIMIN?',
      '',
      list || 'Shkruaj PIN-in e paguesit.',
      '',
      'PIN i paguesit:'
    ].join('\n')));
    if (!payerPin) throw new Error('DORËZIMI U NDALUA: MUNGON PIN-I I PUNËTORIT QË E PAGOI USHQIMIN.');
    if (payerPin === pin) {
      await createMealDistributionEntry({ actor, payerPin: pin, payerName: name, payerRole: role, coveredWorkers: [], amountPerPerson: per, includePayerMeal: true, note: 'USHQIM PARA DORËZIMIT' });
      const afterRows = await listWorkerUnsettledMealPayments(pin).catch(() => []);
      const deduct = sumMealPaymentsForPin(afterRows, pin);
      return { ok: true, created: true, paidBySelf: true, deductAmount: deduct, confirmLine: `USHQIMI: E PAGOVE VET • ZBRITET -${deduct.toFixed(2)}€.` };
    }

    const payer = findMealStaffByPin(activeRows, payerPin) || { pin: payerPin, name: payerPin, role: 'WORKER' };
    await createMealDistributionEntry({
      actor,
      payerPin: payerPin,
      payerName: cleanText(payer?.name || payerPin, payerPin),
      payerRole: cleanText(payer?.role || 'WORKER', 'WORKER'),
      coveredWorkers: [{ pin, name, role }],
      amountPerPerson: per,
      includePayerMeal: false,
      note: 'USHQIM PARA DORËZIMIT',
    });
    return {
      ok: true,
      created: true,
      paidByOther: true,
      payerPin,
      payerName: cleanText(payer?.name || payerPin, payerPin),
      deductAmount: ownDeductTotal,
      confirmLine: ownDeductTotal > 0
        ? `USHQIMI YT: PAGUAR NGA ${cleanText(payer?.name || payerPin, payerPin).toUpperCase()}. MBULIMI QË KE PAGUAR PËR TË TJERËT ZBRITET: -${ownDeductTotal.toFixed(2)}€.`
        : `USHQIMI: PAGUAR NGA ${cleanText(payer?.name || payerPin, payerPin).toUpperCase()} • NUK ZBRITET NGA TY.`,
    };
  }

  throw new Error('ZGJEDHJE E PAVLEFSHME PËR USHQIMIN. SHKRUAJ 1, 2 OSE 3.');
}

export async function listMealStaffOptions({ excludePin = '' } = {}) {
  const cleanExcludePin = cleanText(excludePin);
  const users = uniqWorkerRows(await listTodayWorkers());
  if (!users.length) return [];

  const activityPins = new Set();
  const mealCoveredPins = new Set();

  try {
    const [rowsRes, handoffsRes] = await Promise.all([
      supabase
        .from(EXTRA_TABLE)
        .select('created_at,type,status,created_by_pin,created_by_name,handed_by_pin,order_code,source_module,transport_code_str,amount,note,handoff_note')
        .gte('created_at', arkaTodayBoundsIso(new Date()).startIso)
        .order('created_at', { ascending: false })
        .limit(1500),
      supabase
        .from('cash_handoffs')
        .select('submitted_at,decided_at,worker_pin,status')
        .gte('submitted_at', arkaTodayBoundsIso(new Date()).startIso)
        .order('submitted_at', { ascending: false })
        .limit(400),
    ]);

    const rows = Array.isArray(rowsRes?.data) ? rowsRes.data : [];
    const handoffs = Array.isArray(handoffsRes?.data) ? handoffsRes.data : [];

    for (const row of rows) {
      if (!sameToday(row?.created_at)) continue;
      const type = cleanText(row?.type).toUpperCase();
      const status = cleanText(row?.status).toUpperCase();
      const creatorPin = cleanText(row?.created_by_pin);
      if ([ARKA_PAYMENT_TYPE.MEAL_PAYMENT, ARKA_PAYMENT_TYPE.MEAL_COVERED].includes(type) && isActiveMealStatus(status)) {
        for (const user of users) {
          const userPin = cleanText(user?.pin);
          if (userPin && mealRowCoversWorker(row, userPin)) mealCoveredPins.add(userPin);
        }
      }
      const isTransport = cleanText(row?.source_module).toUpperCase() === 'TRANSPORT' || type === 'TRANSPORT' || cleanText(row?.transport_code_str).toUpperCase().startsWith('T') || cleanText(row?.order_code).toUpperCase().startsWith('T');
      const isBaseCashPayment = !['TIMA', 'EXPENSE', 'MEAL_PAYMENT', 'MEAL_COVERED'].includes(type) && !isTransport;

      if (creatorPin && isBaseCashPayment && ['PENDING', 'COLLECTED', 'ACCEPTED_BY_DISPATCH', 'APPROVED'].includes(status)) {
        activityPins.add(creatorPin);
      }
    }
  } catch {
    // best-effort only
  }

  return users
    .filter((row) => row.pin !== cleanExcludePin)
    .map((row) => ({
      ...row,
      active_today: activityPins.size ? activityPins.has(cleanText(row?.pin)) : false,
      meal_covered_today: mealCoveredPins.has(cleanText(row?.pin)),
    }));
}

export async function createTimaEntry({
  actor,
  amount,
  note = 'TIMA',
  workerPin = '',
  workerName = '',
  workerRole = '',
}) {
  const amt = cleanNum(amount);
  if (amt <= 0) throw new Error('SHUMA E TIMËS DUHET MBI 0€');
  const actorPin = cleanText(actor?.pin);
  if (!actorPin) throw new Error('MUNGON PIN-I I PËRDORUESIT');
  const res = await arkaTransaction({
    action: ARKA_ACTION.EXPENSE_REQUEST,
    actorPin,
    actorName: cleanText(actor?.name, 'PËRDORUESI'),
    actorRole: cleanText(actor?.role).toUpperCase(),
    workerPin: cleanText(workerPin, actorPin),
    workerName: cleanText(workerName, actor?.name || actorPin),
    workerRole: cleanText(workerRole, actor?.role || 'WORKER'),
    paymentType: ARKA_PAYMENT_TYPE.TIMA,
    sourceModule: ARKA_SOURCE_MODULE.ARKA,
    status: ARKA_PAYMENT_STATUS.ACCEPTED_BY_DISPATCH,
    amount: amt,
    note: cleanText(note, 'TIMA'),
    idempotencyKey: buildArkaIdempotencyKey(ARKA_ACTION.EXPENSE_REQUEST, [actorPin, 'TIMA', amt]),
  });
  return res?.payment || res?.row || null;
}


export async function createExpenseEntry({
  actor,
  amount,
  note = '',
  workerPin = '',
  workerName = '',
  workerRole = '',
}) {
  const amt = cleanNum(amount);
  if (amt <= 0) throw new Error('SHUMA E SHPENZIMIT DUHET MBI 0€');
  const actorPin = cleanText(actor?.pin);
  if (!actorPin) throw new Error('MUNGON PIN-I I PËRDORUESIT');
  const res = await arkaTransaction({
    action: ARKA_ACTION.EXPENSE_REQUEST,
    actorPin,
    actorName: cleanText(actor?.name, 'PËRDORUESI'),
    actorRole: cleanText(actor?.role).toUpperCase(),
    workerPin: cleanText(workerPin, actorPin),
    workerName: cleanText(workerName, actor?.name || actorPin),
    workerRole: cleanText(workerRole, actor?.role || 'WORKER'),
    paymentType: ARKA_PAYMENT_TYPE.EXPENSE,
    sourceModule: ARKA_SOURCE_MODULE.BASE,
    status: ARKA_PAYMENT_STATUS.PENDING,
    amount: amt,
    note: cleanText(note, 'SHPENZIM'),
    idempotencyKey: buildArkaIdempotencyKey(ARKA_ACTION.EXPENSE_REQUEST, [actorPin, 'EXPENSE', amt]),
  });
  return res?.payment || res?.row || null;
}



export async function createMealDistributionEntry({
  actor,
  payerPin = '',
  payerName = '',
  payerRole = '',
  coveredWorkers = [],
  amountPerPerson = 3,
  note = '',
  includePayerMeal = false,
}) {
  const per = normalizeDailyMealAmount(amountPerPerson);
  const sourcePin = cleanText(payerPin || actor?.pin);
  if (!sourcePin) throw new Error('MUNGON PIN-I I PAGUESIT');
  const sourceName = cleanText(payerName || actor?.name, 'PËRDORUESI');
  const sourceRole = cleanText(payerRole || actor?.role, 'WORKER').toUpperCase();
  const picked = (Array.isArray(coveredWorkers) ? coveredWorkers : [])
    .map((row) => ({ pin: cleanText(row?.pin), name: cleanText(row?.name, row?.pin || 'PUNTOR'), role: cleanText(row?.role, 'WORKER').toUpperCase() }))
    .filter((row) => row.pin && row.pin !== sourcePin);
  const targetMap = new Map();
  for (const row of [
    ...(includePayerMeal ? [{ pin: sourcePin, name: sourceName, role: sourceRole }] : []),
    ...picked,
  ]) {
    if (row?.pin && !targetMap.has(row.pin)) targetMap.set(row.pin, row);
  }
  const coveredTargets = [...targetMap.values()];
  if (!coveredTargets.length) throw new Error('ZGJIDH SË PAKU NJË PUNTOR');

  // Keep the client-side guard for fast UX, but the server/RPC is the source of truth.
  await assertMealTargetsAreOpenToday(coveredTargets);

  const mealDayKey = arkaTodayBoundsIso(new Date()).dateKey;
  const targetPinKey = coveredTargets.map((row) => row.pin).sort().join('-');
  const total = per * coveredTargets.length;
  const trimmedNote = cleanText(note, 'USHQIM EKIPI');

  const result = await arkaTransaction({
    action: ARKA_ACTION.CREATE_MEAL_DISTRIBUTION,
    actorPin: cleanText(actor?.pin, sourcePin),
    actorName: cleanText(actor?.name, sourceName),
    actorRole: cleanText(actor?.role, sourceRole),
    payerPin: sourcePin,
    payerName: sourceName,
    payerRole: sourceRole,
    mealDay: mealDayKey,
    amountPerPerson: per,
    note: trimmedNote,
    coveredWorkers: coveredTargets,
    idempotencyKey: buildArkaIdempotencyKey(ARKA_ACTION.CREATE_MEAL_DISTRIBUTION, [mealDayKey, sourcePin, targetPinKey, total]),
  });

  const rows = [];
  if (Array.isArray(result?.rows)) rows.push(...result.rows);
  if (result?.payment) rows.push(result.payment);
  if (Array.isArray(result?.covered)) rows.push(...result.covered);
  return rows;
}


function uniqById(rows = []) {
  const map = new Map();
  for (const row of rows) {
    if (!row?.id) continue;
    map.set(String(row.id), row);
  }
  return [...map.values()];
}

export async function listWorkerArkaExtras(pin, limit = 200) {
  const cleanPin = cleanText(pin);
  if (!cleanPin) return [];
  try {
    const [createdRows, targetedRows] = await Promise.all([
      listPendingPaymentRecords({
        in: { type: ['TIMA', 'EXPENSE', 'MEAL_PAYMENT', 'MEAL_COVERED'] },
        eq: { created_by_pin: cleanPin },
        orderBy: 'created_at',
        ascending: false,
        limit,
      }),
      listPendingPaymentRecords({
        in: { type: ['TIMA', 'EXPENSE', 'MEAL_PAYMENT', 'MEAL_COVERED'] },
        eq: { handed_by_pin: cleanPin },
        orderBy: 'created_at',
        ascending: false,
        limit,
      }),
    ]);
    const targetedSafe = (targetedRows || []).filter((row) => ![ARKA_PAYMENT_TYPE.MEAL_PAYMENT, ARKA_PAYMENT_TYPE.MEAL_COVERED].includes(cleanText(row?.type).toUpperCase()));
    return uniqById([...(createdRows || []), ...targetedSafe]).sort((a, b) => String(b?.created_at || '').localeCompare(String(a?.created_at || '')));
  } catch (error) {
    throwArkaDbError(error, `ARKA EXTRAS për PIN ${cleanPin}`);
  }
}

export async function settleWorkerExtrasForHandoff({ workerPin, handoffId, actor }) {
  return {
    ok: true,
    count: 0,
    skipped: true,
    reason: 'EXTRA_SETTLEMENT_DIRECT_WRITE_DISABLED_USE_ARKA_ENGINE',
    workerPin: cleanText(workerPin),
    handoffId: Number(handoffId || 0) || null,
    actorPin: cleanText(actor?.pin),
  };
}


export async function listPendingExpenseApprovals(limit = 200, select = '*') {
  return listPendingPaymentRecords({
    select,
    eq: { type: 'EXPENSE' },
    in: { status: ['PENDING', 'PENDING_DISPATCH_APPROVAL'] },
    orderBy: 'created_at',
    ascending: false,
    limit,
  });
}

export async function approveExpenseEntry({ requestId, actor }) {
  throw new Error('EXPENSE_APPROVAL_DIRECT_WRITE_DISABLED_USE_HANDOFF_ACCEPT_FLOW');
}


export async function rejectExpenseEntry({ requestId, actor }) {
  const id = Number(requestId || 0);
  if (!id) throw new Error('MUNGON ID E SHPENZIMIT');
  const actorPin = cleanText(actor?.pin);
  if (!actorPin) throw new Error('MUNGON PIN-I I APROVUESIT');
  const res = await arkaTransaction({
    action: ARKA_ACTION.VOID_OR_REVERSE_PAYMENT,
    paymentId: id,
    actorPin,
    actorName: cleanText(actor?.name, 'DISPATCH'),
    actorRole: cleanText(actor?.role, 'DISPATCH'),
    note: 'REFUZUAR SHPENZIM',
    idempotencyKey: buildArkaIdempotencyKey(ARKA_ACTION.VOID_OR_REVERSE_PAYMENT, [id, actorPin]),
  });
  return res?.payment || res?.row || res;
}


export async function deleteWorkerExtraEntry({ rowId, actor, allowedTypes = ['EXPENSE', 'TIMA', 'MEAL_PAYMENT', 'MEAL_COVERED'] }) {
  const id = Number(rowId || 0);
  if (!id) throw new Error('MUNGON ID E RRESHTIT');
  const actorPin = cleanText(actor?.pin);
  if (!actorPin) throw new Error('MUNGON PIN-I I PËRDORUESIT');
  const types = (Array.isArray(allowedTypes) ? allowedTypes : [allowedTypes]).map((x) => cleanText(x).toUpperCase()).filter(Boolean);
  const { data: row, error } = await supabase.from(EXTRA_TABLE).select('id,type,status,amount,note').eq('id', id).maybeSingle();
  if (error) throwArkaDbError(error, `SUPABASE ${EXTRA_TABLE} SELECT DELETE SAFETY`);
  if (!row?.id) throw new Error('RRESHTI NUK U GJET');
  if (types.length && !types.includes(cleanText(row?.type).toUpperCase())) throw new Error('KY LLOJ RRESHTI NUK FSHIHET NGA KËTU');
  return arkaTransaction({
    action: ARKA_ACTION.VOID_OR_REVERSE_PAYMENT,
    paymentId: id,
    actorPin,
    actorName: cleanText(actor?.name, 'PËRDORUESI'),
    actorRole: cleanText(actor?.role, ''),
    note: `DELETE/AUDIT_VOID ${cleanText(row?.type)} #${id}`,
    idempotencyKey: buildArkaIdempotencyKey(ARKA_ACTION.VOID_OR_REVERSE_PAYMENT, [id, actorPin]),
  });
}


export async function deleteExpenseEntry({ rowId, actor, allowMeal = false }) {
  return deleteWorkerExtraEntry({
    rowId,
    actor,
    allowedTypes: allowMeal ? ['EXPENSE', 'MEAL_PAYMENT', 'MEAL_COVERED'] : ['EXPENSE'],
  });
}
