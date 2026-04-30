import { supabase } from '@/lib/supabaseClient';
import { listUserRecords } from '@/lib/usersService';

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
    return users.filter((u) => ['PUNTOR', 'PUNETOR', 'WORKER', 'TRANSPORT'].includes(String(u?.role || '').toUpperCase()) && u?.is_active !== false);
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
        .select('created_at,type,status,created_by_pin,handed_by_pin,order_code,source_module,transport_code_str')
        .gte('created_at', `${isoDay(nowIso())}T00:00:00`)
        .order('created_at', { ascending: false })
        .limit(1500),
      supabase
        .from('cash_handoffs')
        .select('submitted_at,decided_at,worker_pin,status')
        .gte('submitted_at', `${isoDay(nowIso())}T00:00:00`)
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
      const handedPin = cleanText(row?.handed_by_pin);
      if (type === 'MEAL_COVERED' && handedPin && !['REJECTED', 'REFUZUAR'].includes(status)) {
        mealCoveredPins.add(handedPin);
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
  const actorName = cleanText(actor?.name, 'PËRDORUESI');
  const role = cleanText(actor?.role).toUpperCase();
  const targetPin = cleanText(workerPin, actorPin);
  const targetName = cleanText(workerName, actorName);
  const targetRole = cleanText(workerRole, role || 'WORKER');
  const payload = {
    order_id: null,
    cycle_id: null,
    applied_cycle_id: null,
    amount: amt,
    type: 'TIMA',
    status: 'ACCEPTED_BY_DISPATCH',
    note: cleanText(note, 'TIMA'),
    client_name: null,
    client_phone: null,
    order_code: null,
    created_by_pin: actorPin,
    created_by_name: actorName,
    approved_by_pin: actorPin,
    approved_by_name: actorName,
    handed_at: nowIso(),
    handed_by_pin: targetPin,
    handed_by_name: targetName,
    handed_by_role: targetRole,
    handoff_note: null,
  };
  const { data, error } = await supabase.from(EXTRA_TABLE).insert(payload).select('*').single();
  if (error) throwArkaDbError(error, `SUPABASE ${EXTRA_TABLE} INSERT TIMA`);
  return data || null;
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
  const actorName = cleanText(actor?.name, 'PËRDORUESI');
  const role = cleanText(actor?.role).toUpperCase();
  const targetPin = cleanText(workerPin, actorPin);
  const targetName = cleanText(workerName, actorName);
  const targetRole = cleanText(workerRole, role || 'WORKER');
  const autoApproved = amt <= 10;
  const payload = {
    order_id: null,
    cycle_id: null,
    applied_cycle_id: null,
    amount: amt,
    type: 'EXPENSE',
    status: autoApproved ? 'ACCEPTED_BY_DISPATCH' : 'PENDING_DISPATCH_APPROVAL',
    note: cleanText(note, 'SHPENZIM'),
    client_name: null,
    client_phone: null,
    order_code: null,
    created_by_pin: actorPin,
    created_by_name: actorName,
    approved_by_pin: autoApproved ? actorPin : null,
    approved_by_name: autoApproved ? actorName : null,
    handed_at: nowIso(),
    handed_by_pin: targetPin,
    handed_by_name: targetName,
    handed_by_role: targetRole,
    handoff_note: null,
  };
  const { data, error } = await supabase.from(EXTRA_TABLE).insert(payload).select('*').single();
  if (error) throwArkaDbError(error, `SUPABASE ${EXTRA_TABLE} INSERT EXPENSE`);
  return data || null;
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
  const per = cleanNum(amountPerPerson);
  if (per <= 0) throw new Error('SHUMA PËR PERSON DUHET MBI 0€');
  const sourcePin = cleanText(payerPin || actor?.pin);
  if (!sourcePin) throw new Error('MUNGON PIN-I I PAGUESIT');
  const sourceName = cleanText(payerName || actor?.name, 'PËRDORUESI');
  const sourceRole = cleanText(payerRole || actor?.role, 'WORKER').toUpperCase();
  const picked = (Array.isArray(coveredWorkers) ? coveredWorkers : [])
    .map((row) => ({
      pin: cleanText(row?.pin),
      name: cleanText(row?.name, row?.pin || 'PUNTOR'),
      role: cleanText(row?.role, 'WORKER').toUpperCase(),
    }))
    .filter((row) => row.pin && row.pin !== sourcePin);
  const includeSelf = !!includePayerMeal;
  const coveredTargets = [
    ...(includeSelf ? [{ pin: sourcePin, name: sourceName, role: sourceRole }] : []),
    ...picked,
  ];
  const coveredCount = coveredTargets.length;
  if (!coveredCount) throw new Error('ZGJIDH SË PAKU NJË PUNTOR');

  const targetPins = [...new Set(coveredTargets.map((row) => cleanText(row?.pin)).filter(Boolean))];
  if (targetPins.length) {
    const { data: existingMealRows, error: existingMealError } = await supabase
      .from(EXTRA_TABLE)
      .select('created_at,type,status,handed_by_pin,handed_by_name')
      .eq('type', 'MEAL_COVERED')
      .in('handed_by_pin', targetPins)
      .gte('created_at', `${isoDay(nowIso())}T00:00:00`)
      .limit(500);
    if (existingMealError) throwArkaDbError(existingMealError, `SUPABASE ${EXTRA_TABLE} CHECK MEAL DUPLICATE`);
    const duplicatePins = new Set();
    for (const row of Array.isArray(existingMealRows) ? existingMealRows : []) {
      const status = cleanText(row?.status).toUpperCase();
      const handedPin = cleanText(row?.handed_by_pin);
      if (!handedPin || !sameToday(row?.created_at) || ['REJECTED', 'REFUZUAR'].includes(status)) continue;
      duplicatePins.add(handedPin);
    }
    if (duplicatePins.size) {
      const duplicateLabels = coveredTargets
        .filter((row) => duplicatePins.has(cleanText(row?.pin)))
        .map((row) => `${cleanText(row?.name, row?.pin || 'PUNTOR')}(${cleanText(row?.pin)})`)
        .join(', ');
      throw new Error(`KY PUNTOR E KA TASHMË USHQIMIN E REGJISTRUAR SOT: ${duplicateLabels}`);
    }
  }

  const total = per * coveredCount;
  const now = nowIso();
  const trimmedNote = cleanText(note, 'USHQIM EKIPI');
  const coveredLabel = [
    includeSelf ? `${sourceName}(${sourcePin})` : '',
    ...picked.map((row) => `${row.name}(${row.pin})`),
  ].filter(Boolean).join(', ');
  const payload = [
    {
      order_id: null,
      cycle_id: null,
      applied_cycle_id: null,
      amount: total,
      type: 'MEAL_PAYMENT',
      status: 'ACCEPTED_BY_DISPATCH',
      note: `${trimmedNote} • ${per.toFixed(2)}€ × ${coveredCount}`,
      client_name: null,
      client_phone: null,
      order_code: null,
      created_by_pin: sourcePin,
      created_by_name: sourceName,
      approved_by_pin: cleanText(actor?.pin, sourcePin),
      approved_by_name: cleanText(actor?.name, sourceName),
      handed_at: now,
      handed_by_pin: sourcePin,
      handed_by_name: sourceName,
      handed_by_role: sourceRole,
      handoff_note: coveredLabel,
    },
    ...(includeSelf ? [{
      order_id: null,
      cycle_id: null,
      applied_cycle_id: null,
      amount: per,
      type: 'MEAL_COVERED',
      status: 'ACCEPTED_BY_DISPATCH',
      note: `${trimmedNote} • AUTO PËR ${sourceName}`,
      client_name: null,
      client_phone: null,
      order_code: null,
      created_by_pin: sourcePin,
      created_by_name: sourceName,
      approved_by_pin: cleanText(actor?.pin, sourcePin),
      approved_by_name: cleanText(actor?.name, sourceName),
      handed_at: now,
      handed_by_pin: sourcePin,
      handed_by_name: sourceName,
      handed_by_role: sourceRole,
      handoff_note: `MEAL_BY:${sourcePin}|SELF`,
    }] : []),
    ...picked.map((row) => ({
      order_id: null,
      cycle_id: null,
      applied_cycle_id: null,
      amount: per,
      type: 'MEAL_COVERED',
      status: 'ACCEPTED_BY_DISPATCH',
      note: `${trimmedNote} • PAGUAR NGA ${sourceName}`,
      client_name: null,
      client_phone: null,
      order_code: null,
      created_by_pin: sourcePin,
      created_by_name: sourceName,
      approved_by_pin: cleanText(actor?.pin, sourcePin),
      approved_by_name: cleanText(actor?.name, sourceName),
      handed_at: now,
      handed_by_pin: row.pin,
      handed_by_name: row.name,
      handed_by_role: row.role,
      handoff_note: `MEAL_BY:${sourcePin}`,
    })),
  ];

  const { data, error } = await supabase.from(EXTRA_TABLE).insert(payload).select('*');
  if (error) throwArkaDbError(error, `SUPABASE ${EXTRA_TABLE} INSERT MEAL`);
  return Array.isArray(data) ? data : [];
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
    return uniqById([...(createdRows || []), ...(targetedRows || [])]).sort((a, b) => String(b?.created_at || '').localeCompare(String(a?.created_at || '')));
  } catch (error) {
    throwArkaDbError(error, `ARKA EXTRAS për PIN ${cleanPin}`);
  }
}

export async function settleWorkerExtrasForHandoff({ workerPin, handoffId, actor }) {
  const cleanPin = cleanText(workerPin);
  const cleanHandoffId = Number(handoffId || 0);
  if (!cleanPin || !cleanHandoffId) return { ok: true, count: 0 };
  const actorPin = cleanText(actor?.pin);
  const actorName = cleanText(actor?.name, 'DISPATCH');
  const rows = await listWorkerArkaExtras(cleanPin, 400);
  const openRows = (Array.isArray(rows) ? rows : []).filter((row) => {
    const type = cleanText(row?.type).toUpperCase();
    const status = cleanText(row?.status).toUpperCase();
    if (!['TIMA', 'EXPENSE', 'MEAL_PAYMENT', 'MEAL_COVERED'].includes(type)) return false;
    if (!['ACCEPTED_BY_DISPATCH', 'PENDING_DISPATCH_APPROVAL'].includes(status)) return false;
    return !isExtraSettled(row);
  });
  const ids = openRows.map((row) => row?.id).filter(Boolean);
  if (!ids.length) return { ok: true, count: 0 };
  const patch = {
    handoff_note: appendSettledTag(openRows[0]?.handoff_note, cleanHandoffId),
    approved_by_pin: actorPin || null,
    approved_by_name: actorName || null,
    updated_at: nowIso(),
  };
  // update row by row to preserve each note
  for (const row of openRows) {
    const perRowPatch = {
      handoff_note: appendSettledTag(row?.handoff_note, cleanHandoffId),
      approved_by_pin: actorPin || row?.approved_by_pin || null,
      approved_by_name: actorName || row?.approved_by_name || null,
      updated_at: nowIso(),
    };
    const { error } = await supabase.from(EXTRA_TABLE).update(perRowPatch).eq('id', row.id);
    if (error) throwArkaDbError(error, `SUPABASE ${EXTRA_TABLE} UPDATE settle extras`);
  }
  return { ok: true, count: ids.length };
}

export async function listPendingExpenseApprovals(limit = 200, select = '*') {
  return listPendingPaymentRecords({
    select,
    eq: { type: 'EXPENSE', status: 'PENDING_DISPATCH_APPROVAL' },
    orderBy: 'created_at',
    ascending: false,
    limit,
  });
}

export async function approveExpenseEntry({ requestId, actor }) {
  const id = Number(requestId || 0);
  if (!id) throw new Error('MUNGON ID E SHPENZIMIT');
  const actorPin = cleanText(actor?.pin);
  if (!actorPin) throw new Error('MUNGON PIN-I I APROVUESIT');
  const actorName = cleanText(actor?.name, 'DISPATCH');
  const payload = {
    status: 'ACCEPTED_BY_DISPATCH',
    approved_by_pin: actorPin,
    approved_by_name: actorName,
    updated_at: nowIso(),
  };
  const { data, error } = await supabase.from(EXTRA_TABLE).update(payload).eq('id', id).eq('type', 'EXPENSE').select('*').single();
  if (error) throwArkaDbError(error, `SUPABASE ${EXTRA_TABLE} APPROVE EXPENSE`);
  return data || null;
}

export async function rejectExpenseEntry({ requestId, actor }) {
  const id = Number(requestId || 0);
  if (!id) throw new Error('MUNGON ID E SHPENZIMIT');
  const actorPin = cleanText(actor?.pin);
  if (!actorPin) throw new Error('MUNGON PIN-I I APROVUESIT');
  const actorName = cleanText(actor?.name, 'DISPATCH');
  const payload = {
    status: 'REJECTED',
    approved_by_pin: actorPin,
    approved_by_name: actorName,
    updated_at: nowIso(),
  };
  const { data, error } = await supabase.from(EXTRA_TABLE).update(payload).eq('id', id).eq('type', 'EXPENSE').select('*').single();
  if (error) throwArkaDbError(error, `SUPABASE ${EXTRA_TABLE} REJECT EXPENSE`);
  return data || null;
}

export async function deleteWorkerExtraEntry({ rowId, actor, allowedTypes = ['EXPENSE', 'TIMA', 'MEAL_PAYMENT', 'MEAL_COVERED'] }) {
  const id = Number(rowId || 0);
  if (!id) throw new Error('MUNGON ID E RRESHTIT');
  const actorPin = cleanText(actor?.pin);
  if (!actorPin) throw new Error('MUNGON PIN-I I PËRDORUESIT');
  const types = (Array.isArray(allowedTypes) ? allowedTypes : [allowedTypes]).map((x) => cleanText(x).toUpperCase()).filter(Boolean);
  let q = supabase.from(EXTRA_TABLE).delete().eq('id', id);
  if (types.length) q = q.in('type', types);
  const { error } = await q;
  if (error) throwArkaDbError(error, `SUPABASE ${EXTRA_TABLE} DELETE EXTRA`);
  return { ok: true };
}

export async function deleteExpenseEntry({ rowId, actor, allowMeal = false }) {
  return deleteWorkerExtraEntry({
    rowId,
    actor,
    allowedTypes: allowMeal ? ['EXPENSE', 'MEAL_PAYMENT', 'MEAL_COVERED'] : ['EXPENSE'],
  });
}
