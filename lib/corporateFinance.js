import { supabase } from '@/lib/supabaseClient';
import { listPendingCashForActor } from '@/lib/arkaCashSync';
import { settleWorkerExtrasForHandoff } from '@/lib/arkaService';

const SUMMARY_ID = 1;
const PENDING_CASH_TABLE = 'arka_pending_payments';
const HANDOFFS_TABLE = 'cash_handoffs';
const HANDOFF_ITEMS_TABLE = 'cash_handoff_items';
const LEDGER_TABLE = 'company_budget_ledger';
const SUMMARY_TABLE = 'company_budget_summary';

const n = (v) => Number(v || 0) || 0;
const clean = (v, fallback = '') => {
  const x = String(v || '').trim();
  return x || fallback;
};
const upper = (v) => clean(v).toUpperCase();
const nowIso = () => new Date().toISOString();

function safeDecodeURIComponent(value = '') {
  try {
    return decodeURIComponent(String(value || ''));
  } catch {
    return String(value || '');
  }
}

function parseWorkerRefFromLedgerText(text = '') {
  const raw = String(text || '');
  if (!raw) return { pin: '', name: '' };

  const kv = {};
  for (const part of raw.split('|')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const key = String(part.slice(0, idx) || '').trim().toLowerCase();
    const value = safeDecodeURIComponent(part.slice(idx + 1));
    if (key) kv[key] = value;
  }

  const pinFromKv = clean(kv.worker_pin || kv.pin || '', '');
  const nameFromKv = clean(kv.worker_name || kv.name || '', '');
  if (pinFromKv || nameFromKv) return { pin: pinFromKv, name: nameFromKv };

  const pinMatch = raw.match(/(?:\bPIN\b|\bPUNTORI\b|\bPUNETORI\b|\bWORKER\b)[^0-9]{0,8}(\d{3,8})/i) || raw.match(/\((\d{3,8})\)/);
  const pin = clean(pinMatch?.[1] || '', '');

  const nameMatch = raw.match(/(?:PËR|PER|FOR)\s+([A-ZÇË][A-ZÇË\s.-]{2,})/i) || raw.match(/(?:PUNTORI|PUNETORI|WORKER)\s*[:\-]?\s*([A-ZÇË][A-ZÇË\s.-]{2,})/i);
  const name = clean(nameMatch?.[1] || '', '');

  return { pin, name };
}

function isMissingColumnError(err) {
  const msg = String(err?.message || '').toLowerCase();
  return msg.includes('does not exist') || msg.includes('schema cache') || msg.includes('could not find the');
}

function normalizeArkaOrderId(value) {
  if (value == null || value === '') return null;
  const raw = String(value).trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) {
    const num = Number(raw);
    return Number.isSafeInteger(num) ? num : null;
  }
  return null;
}

function normalizeBaseOrderCode(value) {
  if (value == null || value === '') return null;
  const raw = String(value).replace(/#/g, '').trim().toUpperCase();
  if (!raw || raw === '0' || raw.startsWith('T')) return null;
  if (!/^\d+$/.test(raw)) return null;
  const num = Number(raw);
  return Number.isSafeInteger(num) && num > 0 ? num : null;
}

function normalizePendingPaymentId(value) {
  return normalizeArkaOrderId(value);
}

function normalizeTransportUuid(value) {
  const raw = String(value || '').trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(raw) ? raw : null;
}

function normalizeTransportCode(value) {
  const raw = String(value || '').replace(/#/g, '').trim().toUpperCase();
  return /^T\d+$/.test(raw) ? raw : null;
}

function detectSourceModule(row = {}) {
  const explicit = String(row?.source_module || row?.sourceModule || '').trim().toUpperCase();
  if (explicit === 'TRANSPORT' || explicit === 'BASE') return explicit;
  if (String(row?.type || '').trim().toUpperCase() === 'TRANSPORT') return 'TRANSPORT';
  if (normalizeTransportUuid(row?.transport_order_id || row?.transportOrderId || row?.order_id || row?.orderId)) return 'TRANSPORT';
  if (normalizeTransportCode(row?.transport_code_str || row?.transportCodeStr || row?.transport_code || row?.t_code || row?.tcode || row?.order_code)) return 'TRANSPORT';
  return 'BASE';
}

function normalizeTransportM2(row = {}) {
  const candidates = [
    row?.transport_m2,
    row?.transportM2,
    row?.m2,
    row?.m2_total,
    row?.pay?.m2,
    row?.data?.pay?.m2,
    row?.data?.m2_total,
  ];
  for (const value of candidates) {
    const parsed = Number(value || 0);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 0;
}

async function getWorkerFinanceProfile(pin) {
  const cleanPin = String(pin || '').trim();
  if (!cleanPin) return { isHybridTransport: false, commissionRateM2: 0 };
  try {
    const { data, error } = await supabase
      .from('users')
      .select('is_hybrid_transport, commission_rate_m2')
      .eq('pin', cleanPin)
      .maybeSingle();
    if (error) throw error;
    return {
      isHybridTransport: Boolean(data?.is_hybrid_transport),
      commissionRateM2: Math.max(0, n(data?.commission_rate_m2 || 0)),
    };
  } catch {
    return { isHybridTransport: false, commissionRateM2: 0 };
  }
}

function computeHybridAmounts(row = {}, commissionRateM2 = 0, isHybridTransport = false) {
  const sourceModule = detectSourceModule(row);
  const rawAmount = n(row?.amount_num ?? row?.amount);
  const transportM2 = sourceModule === 'TRANSPORT' ? normalizeTransportM2(row) : 0;
  const commission = sourceModule === 'TRANSPORT' && isHybridTransport
    ? Math.max(0, +(transportM2 * commissionRateM2).toFixed(2))
    : 0;
  const deliverAmount = Math.max(0, +(rawAmount - commission).toFixed(2));
  return { sourceModule, rawAmount, transportM2, commission, deliverAmount };
}

function toHandoffItem(row = {}, handoffId, financeProfile = { isHybridTransport: false, commissionRateM2: 0 }) {
  const calc = computeHybridAmounts(row, financeProfile.commissionRateM2, financeProfile.isHybridTransport);
  const isTransport = calc.sourceModule === 'TRANSPORT';
  const transportOrderId = isTransport
    ? normalizeTransportUuid(row?.transport_order_id || row?.transportOrderId || row?.order_id || row?.orderId || row?.source_order_ref)
    : null;
  const transportCodeStr = isTransport
    ? normalizeTransportCode(row?.transport_code_str || row?.transportCodeStr || row?.transport_code || row?.t_code || row?.tcode || row?.client_tcode || row?.order_code)
    : null;

  return {
    handoff_id: handoffId,
    pending_payment_id: normalizePendingPaymentId(row?.pending_payment_id || row?.pendingPaymentId || row?.id || null),
    order_id: isTransport ? null : normalizeArkaOrderId(row?.order_id || row?.orderId || row?.source_order_ref || null),
    order_code: isTransport ? null : normalizeBaseOrderCode(row?.order_code || row?.code || null),
    source_module: calc.sourceModule,
    transport_order_id: transportOrderId,
    transport_code_str: transportCodeStr,
    transport_m2: isTransport ? calc.transportM2 : 0,
    amount: calc.deliverAmount,
  };
}

async function getSummary() {
  let { data, error } = await supabase
    .from(SUMMARY_TABLE)
    .select('*')
    .eq('id', SUMMARY_ID)
    .maybeSingle();
  if (error) throw error;
  if (data) return data;

  const seed = { id: SUMMARY_ID, current_balance: 0, total_in: 0, total_out: 0 };
  const { error: seedErr } = await supabase.from(SUMMARY_TABLE).upsert(seed, { onConflict: 'id' });
  if (seedErr) throw seedErr;
  const retry = await supabase.from(SUMMARY_TABLE).select('*').eq('id', SUMMARY_ID).maybeSingle();
  if (retry.error) throw retry.error;
  return retry.data || seed;
}

async function updateSummaryDelta({ deltaBalance = 0, deltaIn = 0, deltaOut = 0 }) {
  const summary = await getSummary();
  const next = {
    current_balance: +(n(summary.current_balance) + n(deltaBalance)).toFixed(2),
    total_in: +(n(summary.total_in) + n(deltaIn)).toFixed(2),
    total_out: +(n(summary.total_out) + n(deltaOut)).toFixed(2),
  };
  const { error } = await supabase.from(SUMMARY_TABLE).update(next).eq('id', SUMMARY_ID);
  if (error) throw error;
  return { ...summary, ...next };
}

async function insertLedgerEntry(payload = {}) {
  const base = {
    direction: upper(payload.direction || 'OUT') || 'OUT',
    amount: +n(payload.amount).toFixed(2),
    category: clean(payload.category || 'SHPENZIM', 'SHPENZIM'),
    description: clean(payload.description || payload.category || 'LËVIZJE BUXHETI', 'LËVIZJE BUXHETI'),
    source_type: clean(payload.source_type || payload.sourceType || 'manual', 'manual'),
    source_id: payload.source_id || payload.sourceId || null,
    created_by_pin: clean(payload.created_by_pin || payload.createdByPin || '', '') || null,
    created_by_name: clean(payload.created_by_name || payload.createdByName || '', '') || null,
    approved_by_pin: clean(payload.approved_by_pin || payload.approvedByPin || '', '') || null,
    approved_by_name: clean(payload.approved_by_name || payload.approvedByName || '', '') || null,
    // company_budget_ledger in this project is not guaranteed to have worker_pin / worker_name.
    // Worker identity should be carried inside `description` when needed.
  };

  const candidates = [
    base,
    ((x) => { const y = { ...x }; delete y.created_by_name; delete y.approved_by_name; return y; })(base),
    ((x) => { const y = { ...x }; delete y.source_id; return y; })(base),
    ((x) => { const y = { ...x }; delete y.source_type; return y; })(base),
    { direction: base.direction, amount: base.amount, category: base.category, description: base.description },
  ];

  let lastErr = null;
  for (const candidate of candidates) {
    const { data, error } = await supabase.from(LEDGER_TABLE).insert(candidate).select('*').maybeSingle();
    if (!error) return data || candidate;
    lastErr = error;
    if (!isMissingColumnError(error)) throw error;
  }
  throw lastErr || new Error('NUK U RUAJT LEDGER ENTRY');
}

async function updateCashHandoffWithFallback(handoffId, payload = {}) {
  const variants = [
    payload,
    ((x) => { const y = { ...x }; delete y.dispatch_note; return y; })(payload),
    ((x) => { const y = { ...x }; delete y.note; return y; })(payload),
  ];

  let lastErr = null;
  for (const variant of variants) {
    const { data, error } = await supabase.from(HANDOFFS_TABLE).update(variant).eq('id', handoffId).select('*').maybeSingle();
    if (!error) return data || null;
    lastErr = error;
    if (!isMissingColumnError(error)) throw error;
  }
  throw lastErr || new Error('NUK U PËRDITËSUA DORËZIMI');
}

async function updatePendingCashRows(items, patch) {
  const rows = Array.isArray(items) ? items : [];
  if (!rows.length) return;

  const ids = rows
    .map((x) => normalizePendingPaymentId(x?.pending_payment_id || x?.pendingPaymentId || x?.id || null))
    .filter(Boolean);
  const externalIds = rows.map((x) => x?.external_id || x?.externalId).filter(Boolean);

  if (ids.length) {
    try { await supabase.from(PENDING_CASH_TABLE).update(patch).in('id', ids); } catch {}
  }
  if (externalIds.length) {
    try { await supabase.from(PENDING_CASH_TABLE).update(patch).in('external_id', externalIds); } catch {}
  }

  if (typeof window !== 'undefined' && typeof localStorage !== 'undefined') {
    try {
      const raw = localStorage.getItem('arka_pending_payments_v1');
      if (raw) {
        let lsItems = JSON.parse(raw);
        let changed = false;
        lsItems = lsItems.map((ls) => {
          const normalizedId = normalizePendingPaymentId(ls?.id || ls?.pending_payment_id || null);
          const eId = ls.external_id || ls.externalId;
          if ((normalizedId && ids.includes(normalizedId)) || (eId && externalIds.includes(eId))) {
            changed = true;
            return { ...ls, ...patch };
          }
          return ls;
        });
        if (changed) localStorage.setItem('arka_pending_payments_v1', JSON.stringify(lsItems));
      }
    } catch {}
  }
}

export async function listWorkerReadyCash(actorPin) {
  const pin = String(actorPin || '').trim();
  if (!pin) return [];
  const res = await listPendingCashForActor(pin, 200);
  return Array.isArray(res?.items) ? res.items : [];
}

export async function listPendingDispatchHandoffs(limit = 100, select = '*, cash_handoff_items(*)') {
  const { data, error } = await supabase
    .from(HANDOFFS_TABLE)
    .select(select)
    .eq('status', 'PENDING_DISPATCH_APPROVAL')
    .order('submitted_at', { ascending: false })
    .limit(limit);

  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

export async function submitWorkerCashToDispatch({ actor, note = '', amountOverride = null }) {
  const pin = String(actor?.pin || '').trim();
  const workerName = String(actor?.name || '').trim() || null;

  if (!pin) throw new Error('MUNGON PIN-I I PUNËTORIT.');

  const financeProfile = await getWorkerFinanceProfile(pin);
  const res = await listPendingCashForActor(pin, 200);
  const items = Array.isArray(res?.items) ? res.items : [];

  if (!items.length) throw new Error('NUK KA LEKË PËR DORËZIM.');

  const normalizedItems = items
    .map((x) => ({
      ...x,
      amount_num: n(x.amount),
      status_norm: String(x?.status || '').toUpperCase(),
    }))
    .filter((x) => x.amount_num > 0 && ['PENDING', 'COLLECTED'].includes(x.status_norm));

  if (!normalizedItems.length) throw new Error('NUK U GJET ASNJË PAGESË E VLEFSHME PËR DORËZIM.');

  const handoffItems = normalizedItems.map((row) => {
    const calc = computeHybridAmounts(row, financeProfile.commissionRateM2, financeProfile.isHybridTransport);
    return { row, calc };
  });

  const baseAmount = handoffItems.reduce((sum, entry) => sum + entry.calc.deliverAmount, 0);
  const totalCommission = handoffItems.reduce((sum, entry) => sum + entry.calc.commission, 0);
  const requestedAmount = n(amountOverride);
  const amount = requestedAmount > 0 ? requestedAmount : +baseAmount.toFixed(2);

  let hybridNote = note || '';
  if (totalCommission > 0) {
    hybridNote = [hybridNote, `HYBRID KOMISION: €${totalCommission.toFixed(2)}`].filter(Boolean).join(' | ');
  }

  let handoff = null;
  try {
    const { data, error: handoffErr } = await supabase
      .from(HANDOFFS_TABLE)
      .insert({
        worker_pin: pin,
        worker_name: workerName,
        amount,
        status: 'PENDING_DISPATCH_APPROVAL',
        note: hybridNote || null,
      })
      .select('*')
      .single();
    if (handoffErr) throw handoffErr;
    handoff = data;

    const payload = normalizedItems.map((x) => toHandoffItem(x, handoff.id, financeProfile));
    const { error: itemsErr } = await supabase.from(HANDOFF_ITEMS_TABLE).insert(payload);
    if (itemsErr) throw itemsErr;

    await updatePendingCashRows(normalizedItems, {
      status: 'PENDING_DISPATCH_APPROVAL',
      handoff_note: `Handoff #${handoff.id}${totalCommission > 0 ? ` • HYBRID €${totalCommission.toFixed(2)}` : ''}`,
    });

    return {
      ok: true,
      handoff,
      count: normalizedItems.length,
      total: amount,
      hybrid_commission: +totalCommission.toFixed(2),
    };
  } catch (err) {
    if (handoff?.id) {
      try { await supabase.from(HANDOFF_ITEMS_TABLE).delete().eq('handoff_id', handoff.id); } catch {}
      try { await supabase.from(HANDOFFS_TABLE).delete().eq('id', handoff.id); } catch {}
    }
    throw err;
  }
}

export async function acceptDispatchHandoff({ handoffId, actor }) {
  const { data: handoff, error: handoffErr } = await supabase
    .from(HANDOFFS_TABLE)
    .select('*, cash_handoff_items(*)')
    .eq('id', handoffId)
    .single();
  if (handoffErr) throw handoffErr;
  if (!handoff) throw new Error('DORËZIMI NUK U GJET.');

  let recoveredWorkerPin = String(handoff?.worker_pin || '').trim() || null;
  let recoveredWorkerName = String(handoff?.worker_name || '').trim() || null;
  const itemPaymentIds = (Array.isArray(handoff?.cash_handoff_items) ? handoff.cash_handoff_items : [])
    .map((x) => normalizePendingPaymentId(x?.pending_payment_id || x?.pendingPaymentId || null))
    .filter(Boolean);
  if ((!recoveredWorkerPin || !recoveredWorkerName) && itemPaymentIds.length) {
    const { data: relatedPayments } = await supabase
      .from(PENDING_CASH_TABLE)
      .select('id,created_by_pin,created_by_name,handed_by_pin,handed_by_name')
      .in('id', itemPaymentIds);
    const payRows = Array.isArray(relatedPayments) ? relatedPayments : [];
    if (!recoveredWorkerPin) {
      recoveredWorkerPin = String(
        payRows.find((row) => String(row?.created_by_pin || '').trim())?.created_by_pin ||
        payRows.find((row) => String(row?.handed_by_pin || '').trim())?.handed_by_pin ||
        ''
      ).trim() || null;
    }
    if (!recoveredWorkerName) {
      recoveredWorkerName = String(
        payRows.find((row) => String(row?.created_by_name || '').trim())?.created_by_name ||
        payRows.find((row) => String(row?.handed_by_name || '').trim())?.handed_by_name ||
        ''
      ).trim() || null;
    }
  }

  const ledger = await insertLedgerEntry({
    direction: 'IN',
    amount: n(handoff.amount),
    category: 'WORKER_TO_DISPATCH',
    description: `PRANIM NGA DISPATCH — ${handoff.worker_name || handoff.worker_pin}`,
    source_type: 'cash_handoff',
    source_id: handoff.id,
    created_by_pin: actor?.pin || null,
    created_by_name: actor?.name || null,
    approved_by_pin: actor?.pin || null,
    approved_by_name: actor?.name || null,
    worker_pin: recoveredWorkerPin || handoff.worker_pin || null,
    worker_name: recoveredWorkerName || handoff.worker_name || null,
  });

  await updateSummaryDelta({
    deltaBalance: n(handoff.amount),
    deltaIn: n(handoff.amount),
    deltaOut: 0,
  });

  await updateCashHandoffWithFallback(handoff.id, {
    status: 'ACCEPTED',
    decided_at: nowIso(),
    dispatch_pin: actor?.pin || null,
    company_ledger_entry_id: ledger?.id || null,
    worker_pin: recoveredWorkerPin || handoff.worker_pin || null,
    worker_name: recoveredWorkerName || handoff.worker_name || null,
  });

  const payRows = (handoff.cash_handoff_items || []).filter((x) => normalizePendingPaymentId(x.pending_payment_id));
  if (payRows.length) {
    await updatePendingCashRows(payRows, {
      status: 'ACCEPTED_BY_DISPATCH',
      handed_at: nowIso(),
      handed_by_pin: actor?.pin || null,
      handed_by_role: 'DISPATCH',
    });
  }
  try {
    await settleWorkerExtrasForHandoff({ workerPin: recoveredWorkerPin || handoff.worker_pin, handoffId: handoff.id, actor });
  } catch {}
  return { ok: true, ledger };
}

export async function rejectDispatchHandoff({ handoffId, actor, note = '' }) {
  const id = Number(handoffId || 0);
  if (!id) throw new Error('MUNGON ID E DORËZIMIT.');

  const { data: handoff, error } = await supabase
    .from(HANDOFFS_TABLE)
    .select('*, cash_handoff_items(*)')
    .eq('id', id)
    .single();
  if (error) throw error;
  if (!handoff) throw new Error('DORËZIMI NUK U GJET.');
  if (upper(handoff?.status) === 'ACCEPTED') throw new Error('DORËZIMI I PRANUAR NUK MUND TË REFUZOHET NGA KËTU.');

  const rejectNote = clean(note || 'KTHYER TE PUNTORI', 'KTHYER TE PUNTORI');
  await updateCashHandoffWithFallback(id, {
    status: 'REJECTED',
    decided_at: nowIso(),
    dispatch_pin: actor?.pin || null,
    note: rejectNote,
    dispatch_note: rejectNote,
  });

  const payRows = (handoff?.cash_handoff_items || []).filter((x) => normalizePendingPaymentId(x?.pending_payment_id || x?.pendingPaymentId || null));
  if (payRows.length) {
    await updatePendingCashRows(payRows, {
      status: 'COLLECTED',
      handoff_note: `REFUZUAR #${id} • ${rejectNote}`,
      handed_at: null,
      handed_by_pin: null,
      handed_by_role: null,
    });
  }

  return { ok: true, handoffId: id };
}

export async function spendFromCompanyBudget({
  actor,
  amount,
  category = 'SHPENZIM',
  description = '',
  workerPin = null,
  workerName = null,
  sourceType = 'manual',
  sourceId = null,
} = {}) {
  const amt = +n(amount).toFixed(2);
  if (!(amt > 0)) throw new Error('SHUMA DUHET MBI 0€.');

  const summary = await getSummary();
  const balance = n(summary?.current_balance);
  if (balance < amt) {
    throw new Error(`NUK KA MJAFT BUXHET. GJENDJA AKTUALE ËSHTË €${balance.toFixed(2)}.`);
  }

  const ledger = await insertLedgerEntry({
    direction: 'OUT',
    amount: amt,
    category: clean(category || 'SHPENZIM', 'SHPENZIM'),
    description: clean(description || category || 'SHPENZIM NGA BUXHETI', 'SHPENZIM NGA BUXHETI'),
    source_type: clean(sourceType || 'manual', 'manual'),
    source_id: sourceId || null,
    created_by_pin: actor?.pin || null,
    created_by_name: actor?.name || null,
    approved_by_pin: actor?.pin || null,
    approved_by_name: actor?.name || null,
    worker_pin: clean(workerPin || '', '') || null,
    worker_name: clean(workerName || '', '') || null,
  });

  const nextSummary = await updateSummaryDelta({
    deltaBalance: -amt,
    deltaIn: 0,
    deltaOut: amt,
  });

  return { ok: true, ledger, summary: nextSummary };
}

export async function deleteCompanyBudgetEntry({ entryId } = {}) {
  const id = entryId;
  if (!id) throw new Error('MUNGON ID E HYRJES.');

  const { data: row, error } = await supabase.from(LEDGER_TABLE).select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  if (!row) throw new Error('HYRJA NUK U GJET.');

  const direction = upper(row?.direction);
  const category = upper(row?.category);
  const sourceType = upper(row?.source_type || row?.sourceType);
  const amt = +n(row?.amount).toFixed(2);

  if (direction === 'IN' || category === 'WORKER_TO_DISPATCH' || sourceType === 'CASH_HANDOFF') {
    throw new Error('KY RRESHT NUK FSHIHET NGA KËTU.');
  }

  const { error: delErr } = await supabase.from(LEDGER_TABLE).delete().eq('id', id);
  if (delErr) throw delErr;

  await updateSummaryDelta({
    deltaBalance: amt,
    deltaIn: 0,
    deltaOut: -amt,
  });

  return { ok: true };
}

function uniqueById(rows = []) {
  const map = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row) continue;
    const key = String(row?.id || `${row?.created_at || ''}_${row?.amount || ''}_${row?.status || ''}_${row?.note || ''}`);
    if (!map.has(key)) map.set(key, row);
  }
  return [...map.values()];
}

function ledgerMatchesWorkerAdvance(row, pin) {
  const cleanPin = clean(pin);
  if (!cleanPin) return false;
  const parsed = parseWorkerRefFromLedgerText(row?.description || row?.note || '');
  if (clean(parsed?.pin) === cleanPin) return true;
  const text = `${clean(row?.description)} ${clean(row?.note)} ${clean(parsed?.name)}`.toUpperCase();
  return text.includes(`(${cleanPin.toUpperCase()})`) || text.includes(`PIN ${cleanPin.toUpperCase()}`) || text.includes(cleanPin.toUpperCase());
}

export async function listWorkerDebtRows(pin, limit = 200) {
  const cleanPin = clean(pin);
  if (!cleanPin) return [];

  const [createdRes, handedRes, advanceLedgerRes] = await Promise.allSettled([
    supabase
      .from(PENDING_CASH_TABLE)
      .select('*')
      .eq('created_by_pin', cleanPin)
      .in('status', ['OWED', 'REJECTED', 'WORKER_DEBT', 'ADVANCE'])
      .order('created_at', { ascending: false })
      .limit(limit),
    supabase
      .from(PENDING_CASH_TABLE)
      .select('*')
      .eq('handed_by_pin', cleanPin)
      .in('status', ['OWED', 'REJECTED', 'WORKER_DEBT', 'ADVANCE'])
      .order('created_at', { ascending: false })
      .limit(limit),
    supabase
      .from(LEDGER_TABLE)
      // Worker metadata is not guaranteed as top-level columns in this DB.
      // Read only stable columns and recover worker identity from description when needed.
      .select('id,amount,category,description,created_at,direction')
      .eq('direction', 'OUT')
      .eq('category', 'WORKER_ADVANCE')
      .order('created_at', { ascending: false })
      .limit(limit),
  ]);

  const debtRows = [
    ...(createdRes.status === 'fulfilled' && Array.isArray(createdRes.value?.data) ? createdRes.value.data : []),
    ...(handedRes.status === 'fulfilled' && Array.isArray(handedRes.value?.data) ? handedRes.value.data : []),
  ];

  const advanceLedgerRows = (advanceLedgerRes.status === 'fulfilled' && Array.isArray(advanceLedgerRes.value?.data)
    ? advanceLedgerRes.value.data
    : [])
    .filter((row) => ledgerMatchesWorkerAdvance(row, cleanPin))
    .map((row) => {
      const parsedWorker = parseWorkerRefFromLedgerText(row?.description || '');
      return {
        id: `ledger_${row.id}`,
        amount: n(row?.amount),
        status: 'ADVANCE',
        type: 'ADVANCE',
        note: row?.description || 'AVANS NGA BUXHETI',
        handoff_note: row?.description || null,
        created_at: row?.created_at || null,
        updated_at: row?.created_at || null,
        category: row?.category || 'WORKER_ADVANCE',
        worker_pin: parsedWorker?.pin || cleanPin,
        worker_name: parsedWorker?.name || null,
        source_table: LEDGER_TABLE,
        source_id: row?.id || null,
      };
    });

  return uniqueById([...debtRows, ...advanceLedgerRows])
    .sort((a, b) => String(b?.created_at || b?.updated_at || '').localeCompare(String(a?.created_at || a?.updated_at || '')))
    .slice(0, limit);
}
