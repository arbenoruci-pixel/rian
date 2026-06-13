import { supabase } from '@/lib/supabaseClient';
import { fetchOrderById, listOrderRecords, updateOrderData } from '@/lib/ordersService';
import { ARKA_ACTION, ARKA_PAYMENT_TYPE, ARKA_SOURCE_MODULE } from '@/lib/arka/arkaConstants';
import { arkaTransaction, buildArkaIdempotencyKey } from '@/lib/arka/arkaClient';

const LS_PENDING_KEY = 'arka_pending_payments_v1';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const ARKA_CASH_IN_FLIGHT = new Map();

function arkaCashAmountKey(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n.toFixed(2) : '0.00';
}

function buildPendingCashInFlightKey(action, requestPayload = {}, amount = 0, actorPin = '') {
  if (action !== ARKA_ACTION.TRANSPORT_ORDER_PAYMENT) return '';
  const transportId = String(requestPayload.transportOrderId || requestPayload.transport_order_id || requestPayload.orderId || '').trim();
  const pin = String(actorPin || requestPayload.actorPin || requestPayload.workerPin || '').trim();
  if (!transportId || !pin) return '';
  return `transport_cash:${transportId}:${arkaCashAmountKey(amount)}:${pin}`;
}


function normalizeBaseOrderId(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function fetchBaseOrderRow(orderId) {
  const id = normalizeBaseOrderId(orderId);
  if (!id) return null;
  try {
    return await fetchOrderById('orders', id, 'id,data,created_at');
  } catch {
    return null;
  }
}

async function listRecentBaseOrderRows(limit = 50) {
  try {
    return await listOrderRecords('orders', {
      select: 'id,data,created_at',
      orderBy: 'created_at',
      ascending: false,
      limit,
    });
  } catch {
    return [];
  }
}

async function patchBaseOrderPendingCash(orderId, mutatePendingCash) {
  const id = normalizeBaseOrderId(orderId);
  if (!id || typeof mutatePendingCash !== 'function') return false;
  try {
    await updateOrderData('orders', id, (currentData = {}) => {
      const cur = currentData && typeof currentData === 'object' ? currentData : {};
      const pay = cur.pay && typeof cur.pay === 'object' ? cur.pay : {};
      const pendingCash = Array.isArray(pay.pendingCash) ? [...pay.pendingCash] : [];
      const nextPendingCash = mutatePendingCash(pendingCash, cur);
      if (!Array.isArray(nextPendingCash)) return cur;
      return { ...cur, pay: { ...pay, pendingCash: nextPendingCash } };
    });
    return true;
  } catch {
    return false;
  }
}

export function detectArkaTypeFromCode(code) {
  try {
    const c = String(code || '').trim().toUpperCase();
    return c.startsWith('T') ? 'TRANSPORT' : 'BASE';
  } catch {
    return 'BASE';
  }
}

function isBrowser() {
  return typeof window !== 'undefined' && typeof localStorage !== 'undefined';
}

function isUuid(v) {
  return UUID_RE.test(String(v || '').trim());
}

function normalizeUuid(v) {
  const s = String(v || '').trim();
  return isUuid(s) ? s : null;
}

function readCurrentUserData() {
  if (!isBrowser()) return null;
  try {
    const raw = localStorage.getItem('CURRENT_USER_DATA');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function translateDbError(errLike) {
  const msg = String(errLike?.message || errLike?.details || errLike?.hint || errLike || '').toLowerCase();
  if (!msg) return 'Gabim i panjohur gjatë komunikimit me databazën.';
  if (msg.includes('nuk ekziston ose perdoruesi nuk eshte aktiv') || msg.includes('nuk ekziston ose përdoruesi nuk është aktiv')) {
    return 'GABIM: PIN-i nuk ekziston ose llogaria nuk është aktive!';
  }
  if (msg.includes('schema cache') || msg.includes('could not find')) {
    return 'GABIM: Databaza po përditësohet. Provo përsëri pas pak.';
  }
  return String(errLike?.message || errLike?.details || errLike || 'Gabim i panjohur');
}

function lsRead() {
  if (!isBrowser()) return [];
  try {
    const raw = localStorage.getItem(LS_PENDING_KEY);
    const items = raw ? JSON.parse(raw) : [];
    return Array.isArray(items) ? items : [];
  } catch {
    return [];
  }
}

function lsWrite(items) {
  if (!isBrowser()) return;
  try {
    localStorage.setItem(LS_PENDING_KEY, JSON.stringify(Array.isArray(items) ? items : []));
  } catch {}
}

function lsPush(item) {
  const items = lsRead();
  items.unshift(item);
  lsWrite(items.slice(0, 500));
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

function normalizeTransportCode(value) {
  const raw = String(value || '').replace(/#/g, '').trim().toUpperCase();
  return /^T\d+$/.test(raw) ? raw : null;
}

function pickTransportOrderId(payload = {}) {
  const candidates = [
    payload.transport_order_id,
    payload.transportOrderId,
    payload.transport_id,
    payload.transportId,
    payload.source_transport_order_id,
  ];
  if (String(payload.type || '').toUpperCase() === 'TRANSPORT' || String(payload.arka_type || payload.arkaType || '').toUpperCase() === 'TRANSPORT') {
    candidates.push(payload.order_id, payload.orderId, payload.source_order_ref);
  }
  for (const value of candidates) {
    const normalized = normalizeUuid(value);
    if (normalized) return normalized;
  }
  return null;
}

function pickTransportCode(payload = {}) {
  const candidates = [
    payload.transport_code_str,
    payload.transportCodeStr,
    payload.transport_code,
    payload.transportCode,
    payload.t_code,
    payload.tcode,
    payload.client_tcode,
    payload.clientTcode,
  ];
  if (String(payload.type || '').toUpperCase() === 'TRANSPORT' || String(payload.arka_type || payload.arkaType || '').toUpperCase() === 'TRANSPORT') {
    candidates.push(payload.order_code, payload.code);
  }
  for (const value of candidates) {
    const normalized = normalizeTransportCode(value);
    if (normalized) return normalized;
  }
  return null;
}

function pickTransportM2(payload = {}) {
  const candidates = [
    payload.transport_m2,
    payload.transportM2,
    payload.m2,
    payload.m2_total,
    payload.pay?.m2,
    payload.data?.pay?.m2,
    payload.data?.m2_total,
    payload.meta?.m2,
  ];
  for (const value of candidates) {
    const parsed = Number(value || 0);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 0;
}

function transportPaymentResponseMatches(row = {}, { transportOrderId, amount, actorPin } = {}) {
  if (!row?.id) return false;
  const rowTransportId = normalizeUuid(row.transport_order_id || row.transportOrderId);
  const expectedTransportId = normalizeUuid(transportOrderId);
  if (!expectedTransportId || rowTransportId !== expectedTransportId) return false;

  const rowAmount = Number(Number(row.amount || 0).toFixed(2));
  const expectedAmount = Number(Number(amount || 0).toFixed(2));
  if (!Number.isFinite(rowAmount) || !Number.isFinite(expectedAmount) || Math.abs(rowAmount - expectedAmount) > 0.005) return false;

  const rowType = String(row.type || '').trim().toUpperCase();
  const rowSource = String(row.source_module || row.sourceModule || '').trim().toUpperCase();
  if (rowType && rowType !== ARKA_PAYMENT_TYPE.TRANSPORT) return false;
  if (rowSource && rowSource !== ARKA_SOURCE_MODULE.TRANSPORT) return false;

  const pin = String(actorPin || '').trim();
  const rowPin = String(row.created_by_pin || row.actor_pin || row.worker_pin || row.handed_by_pin || '').trim();
  return !pin || !rowPin || rowPin === pin;
}


function detectPendingSourceModule(payload = {}) {
  const explicit = String(payload.source_module || payload.sourceModule || '').trim().toUpperCase();
  if (explicit === 'TRANSPORT' || explicit === 'BASE') return explicit;
  if (String(payload.type || '').toUpperCase() === 'TRANSPORT') return 'TRANSPORT';
  if (String(payload.arka_type || payload.arkaType || '').toUpperCase() === 'TRANSPORT') return 'TRANSPORT';
  if (pickTransportOrderId(payload)) return 'TRANSPORT';
  if (pickTransportCode(payload)) return 'TRANSPORT';
  return 'BASE';
}

function toDbPendingRow(payload = {}, actor = {}, now = new Date().toISOString()) {
  const sourceModule = detectPendingSourceModule(payload);
  const isTransport = sourceModule === 'TRANSPORT';
  const transportOrderId = isTransport ? pickTransportOrderId(payload) : null;
  const transportCodeStr = isTransport ? pickTransportCode(payload) : null;
  const transportM2 = isTransport ? pickTransportM2(payload) : 0;
  const baseOrderId = !isTransport ? normalizeArkaOrderId(payload.order_id || payload.orderId || null) : null;
  const baseOrderCode = !isTransport ? normalizeBaseOrderCode(payload.order_code || payload.code || null) : null;
  return {
    status: String((isTransport && !payload.status) ? 'COLLECTED' : (payload.status || 'PENDING')).toUpperCase(),
    amount: Number(payload.amount || 0) || 0,
    type: String(isTransport ? 'TRANSPORT' : (payload.type || 'ORDER')).toUpperCase(),
    source_module: sourceModule,
    order_id: baseOrderId,
    order_code: baseOrderCode,
    transport_order_id: transportOrderId,
    transport_code_str: transportCodeStr,
    transport_m2: transportM2,
    client_name: payload.client_name || payload.name || null,
    client_phone: payload.client_phone || payload.phone || null,
    note: payload.note || '',
    created_by_pin: actor.pin || payload.created_by_pin || payload.user_pin || payload.createdByPin || payload.userPin || null,
    created_by_name: actor.name || payload.created_by_name || payload.user_name || payload.createdByName || payload.user || payload?.user?.name || null,

    // Transport COLLECTED cash must be owned by the driver/worker who collected it.
    // Keep handed_at empty here; handed_at is set later when the worker submits the handoff.
    handed_by_pin: isTransport ? (actor.pin || payload.handed_by_pin || payload.workerPin || payload.worker_pin || payload.created_by_pin || payload.user_pin || payload.createdByPin || payload.userPin || null) : (payload.handed_by_pin || null),
    handed_by_name: isTransport ? (actor.name || payload.handed_by_name || payload.workerName || payload.worker_name || payload.created_by_name || payload.user_name || payload.createdByName || payload.user || payload?.user?.name || null) : (payload.handed_by_name || null),
    handed_by_role: isTransport ? (actor.role || payload.handed_by_role || payload.workerRole || payload.worker_role || payload.created_by_role || payload.user_role || null) : (payload.handed_by_role || null),

    created_at: now,
    updated_at: now,
  };
}

function getPendingKey(row) {
  return row?.id ?? row?.external_id ?? row?.externalId ?? null;
}

function isPendingStatusForDispatch(status) {
  const s = String(status || '').toUpperCase();
  return ['PENDING', 'COLLECTED', 'HANDED', 'PENDING_DISPATCH_APPROVAL'].includes(s);
}

async function pendingTableOk() {
  return true;
}

function isDuplicateBasePendingStatus(status) {
  return ['PENDING', 'PENDING_DISPATCH_APPROVAL'].includes(String(status || '').toUpperCase());
}

async function findExistingBasePendingCashPayment(dbRow = {}) {
  const sourceModule = String(dbRow?.source_module || '').toUpperCase();
  const type = String(dbRow?.type || '').toUpperCase();
  const orderId = normalizeArkaOrderId(dbRow?.order_id || null);
  const amount = Number(Number(dbRow?.amount || 0).toFixed(2));

  if (sourceModule !== 'BASE' || type !== 'IN' || !orderId || !Number.isFinite(amount) || amount <= 0) return null;

  try {
    const { data, error } = await supabase
      .from('arka_pending_payments')
      .select('id,status,handoff_note,amount,type,source_module,order_id,order_code,created_by_pin,created_at')
      .eq('order_id', orderId)
      .eq('type', 'IN')
      .eq('source_module', 'BASE')
      .in('status', ['PENDING', 'PENDING_DISPATCH_APPROVAL'])
      .order('created_at', { ascending: false })
      .limit(20);

    if (error) throw error;

    const rows = Array.isArray(data) ? data : [];
    const matches = rows.filter((row) => {
      if (!isDuplicateBasePendingStatus(row?.status)) return false;
      const rowAmount = Number(Number(row?.amount || 0).toFixed(2));
      return Math.abs(rowAmount - amount) < 0.005;
    });

    if (!matches.length) return null;
    return (
      matches.find((row) => String(row?.status || '').toUpperCase() === 'PENDING_DISPATCH_APPROVAL') ||
      matches[0]
    );
  } catch {
    return null;
  }
}

async function backupPendingIntoOrder(payload = {}, external_id, rowLike = {}) {
  try {
    const order_id = payload.orderId || payload.order_id || null;
    if (!order_id || !external_id) return;

    const data = await fetchBaseOrderRow(order_id);
    if (!data?.id) return;

    const current = { ...(data.data || {}) };
    const pay = { ...(current.pay || {}) };
    const pend = Array.isArray(pay.pendingCash) ? [...pay.pendingCash] : [];
    const exists = pend.some((x) => String(x.external_id || x.externalId || '') === String(external_id));
    if (exists) return;

    pend.unshift({
      external_id,
      status: String(rowLike.status || payload.status || 'PENDING').toUpperCase(),
      amount: Number(rowLike.amount || payload.amount || 0),
      type: String(rowLike.type || payload.type || 'IN').toUpperCase(),
      method: 'CASH',
      order_id,
      order_code: payload.code || payload.order_code || null,
      client_name: payload.name || payload.client_name || null,
      created_by_pin: payload.createdByPin || payload.created_by_pin || null,
      created_by_name: payload.createdBy || payload.created_by_name || null,
      created_by_role: payload.created_by_role || payload.user_role || payload.createdByRole || null,
      source: payload.source || rowLike.source || null,
      note: rowLike.note || payload.note || '',
      created_at: rowLike.created_at || new Date().toISOString(),
    });

    pay.pendingCash = pend.slice(0, 100);
    await updateOrderData('orders', order_id, () => ({ ...current, pay }));
  } catch {}
}

async function markOrderPendingApplied(external_id, order_id = null) {
  if (!external_id) return;
  try {
    if (order_id) {
      const applied = await patchBaseOrderPendingCash(order_id, (pend) => {
        const idx = pend.findIndex((x) => String(x.external_id || x.externalId || '') === String(external_id));
        if (idx === -1) return null;
        const next = [...pend];
        next[idx] = { ...next[idx], status: 'APPLIED', applied_at: new Date().toISOString() };
        return next;
      });
      if (applied) return;
    }

    const data = await listRecentBaseOrderRows(50);
    if (!data) return;
    for (const row of data) {
      const applied = await patchBaseOrderPendingCash(row.id, (pend) => {
        const idx = pend.findIndex((x) => String(x.external_id || x.externalId || '') === String(external_id));
        if (idx === -1) return null;
        const next = [...pend];
        next[idx] = { ...next[idx], status: 'APPLIED', applied_at: new Date().toISOString() };
        return next;
      });
      if (applied) break;
    }
  } catch {}
}

async function markOrderPendingDebt(external_id, note = '', order_id = null) {
  if (!external_id) return;
  try {
    if (order_id) {
      const rejected = await patchBaseOrderPendingCash(order_id, (pend) => {
        const idx = pend.findIndex((x) => String(x.external_id || x.externalId || '') === String(external_id));
        if (idx === -1) return null;
        const next = [...pend];
        next[idx] = {
          ...next[idx],
          status: 'REJECTED',
          rejected_at: new Date().toISOString(),
          reject_note: note || next[idx]?.reject_note || '',
        };
        return next;
      });
      if (rejected) return;
    }

    const data = await listRecentBaseOrderRows(50);
    if (!data) return;
    for (const row of data) {
      const rejected = await patchBaseOrderPendingCash(row.id, (pend) => {
        const idx = pend.findIndex((x) => String(x.external_id || x.externalId || '') === String(external_id));
        if (idx === -1) return null;
        const next = [...pend];
        next[idx] = {
          ...next[idx],
          status: 'REJECTED',
          rejected_at: new Date().toISOString(),
          reject_note: note || next[idx]?.reject_note || '',
        };
        return next;
      });
      if (rejected) break;
    }
  } catch {}
}

export async function createPendingCashPayment(payload = {}) {
  const amount = Number(payload.amount || 0);
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: 'AMOUNT_INVALID' };

  const currentUser = readCurrentUserData() || {};
  const actor = {
    pin: payload.created_by_pin || payload.user_pin || payload.createdByPin || payload.userPin || payload?.user?.pin || currentUser?.pin || null,
    name: payload.created_by_name || payload.user_name || payload.createdByName || payload.user || payload?.user?.name || currentUser?.name || null,
    role: payload.created_by_role || payload.user_role || payload.createdByRole || payload?.user?.role || currentUser?.role || null,
  };
  if (!actor.pin) return { ok: false, error: 'ACTOR_PIN_REQUIRED' };

  const sourceModule = detectPendingSourceModule(payload);
  const type = String(payload.type || payload.paymentType || '').toUpperCase();
  const isTransport = sourceModule === ARKA_SOURCE_MODULE.TRANSPORT || type === ARKA_PAYMENT_TYPE.TRANSPORT;
  const isExtra = [ARKA_PAYMENT_TYPE.EXPENSE, ARKA_PAYMENT_TYPE.TIMA, ARKA_PAYMENT_TYPE.MEAL_PAYMENT, ARKA_PAYMENT_TYPE.MEAL_COVERED, 'ADVANCE'].includes(type);
  const action = isTransport
    ? ARKA_ACTION.TRANSPORT_ORDER_PAYMENT
    : (isExtra ? ARKA_ACTION.EXPENSE_REQUEST : ARKA_ACTION.BASE_ORDER_PAYMENT);

  const requestPayload = {
    action,
    actorPin: actor.pin,
    actorName: actor.name,
    actorRole: actor.role,
    orderId: payload.orderId || payload.order_id || null,
    orderCode: payload.code || payload.order_code || payload.orderCode || null,
    transportOrderId: payload.transportOrderId || payload.transport_order_id || payload.source_transport_order_id || null,
    transportCode: payload.transportCode || payload.transport_code_str || payload.order_code || payload.code || null,
    transportM2: payload.transportM2 || payload.transport_m2 || payload.m2 || null,
    workerPin: payload.workerPin || payload.worker_pin || payload.created_by_pin || actor.pin,
    workerName: payload.workerName || payload.worker_name || payload.created_by_name || actor.name,
    workerRole: payload.workerRole || payload.worker_role || actor.role,
    paymentType: isExtra ? (type || ARKA_PAYMENT_TYPE.EXPENSE) : undefined,
    sourceModule,
    amount,
    method: String(payload.method || 'CASH').toUpperCase(),
    note: payload.note || '',
    clientName: payload.clientName || payload.client_name || payload.name || null,
    clientPhone: payload.clientPhone || payload.client_phone || payload.phone || null,
    status: payload.status,
    idempotencyKey:
      payload.idempotencyKey ||
      payload.idempotency_key ||
      payload.externalId ||
      payload.external_id ||
      buildArkaIdempotencyKey(action, [payload.orderId || payload.order_id || payload.transportOrderId || payload.transport_order_id || actor.pin, amount, actor.pin]),
  };

  const inFlightKey = buildPendingCashInFlightKey(action, requestPayload, amount, actor.pin);
  let resultPromise = inFlightKey ? ARKA_CASH_IN_FLIGHT.get(inFlightKey) : null;
  if (!resultPromise) {
    resultPromise = arkaTransaction(requestPayload);
    if (inFlightKey) ARKA_CASH_IN_FLIGHT.set(inFlightKey, resultPromise);
  }

  let result;
  try {
    result = await resultPromise;
  } finally {
    if (inFlightKey && ARKA_CASH_IN_FLIGHT.get(inFlightKey) === resultPromise) ARKA_CASH_IN_FLIGHT.delete(inFlightKey);
  }

  const verifiedTransportPayment = isTransport ? (result?.verifiedPayment || result?.payment || result?.row || null) : null;
  if (isTransport && !transportPaymentResponseMatches(verifiedTransportPayment, {
    transportOrderId: requestPayload.transportOrderId,
    amount,
    actorPin: actor.pin,
  })) {
    return {
      ok: false,
      error: 'TRANSPORT_ARKA_PAYMENT_NOT_VERIFIED_IN_DB',
      pending: false,
      direct: false,
      row: verifiedTransportPayment,
      raw: result || null,
      mode: `ARKA_ENGINE_${action}`,
    };
  }

  const responseRow = verifiedTransportPayment || result?.payment || result?.row || null;
  return {
    ok: true,
    ...(result || {}),
    pending: true,
    direct: false,
    payment: responseRow,
    row: responseRow,
    verifiedPayment: isTransport ? responseRow : (result?.verifiedPayment || null),
    mode: `ARKA_ENGINE_${action}`,
  };
}



export async function recordCashMove(payload = {}) {
  const amt = Number(payload.amount || 0);
  if (!Number.isFinite(amt) || amt <= 0) return { ok: false, skipped: true, error: 'AMOUNT_INVALID' };
  return createPendingCashPayment({ ...payload, amount: amt });
}


export async function listPendingCashPayments(limit = 100) {
  const hardLimit = Math.max(1, Math.min(Number(limit || 100), 200));
  const items = [];
  const seen = new Set();

  try {
    const { data } = await supabase
      .from('arka_pending_payments')
      .select('*')
      .or("status.eq.PENDING,and(type.eq.TRANSPORT,status.eq.COLLECTED)")
      .order('created_at', { ascending: true })
      .limit(hardLimit);
    if (data) {
      data.forEach((r) => {
        const key = getPendingKey(r);
        if (key != null && !seen.has(key)) {
          items.push(r);
          seen.add(key);
        }
      });
    }
  } catch {}

  if (items.length < hardLimit) {
    try {
      const data = await listRecentBaseOrderRows(40);
      if (data) {
        data.forEach((row) => {
          const pends = row.data?.pay?.pendingCash || [];
          pends.forEach((p) => {
            const eid = p.external_id || p.externalId;
            if ((p.status === 'PENDING' || p.status === 'COLLECTED') && eid && !seen.has(eid)) {
              items.push({ ...p, external_id: eid, order_id: row.id });
              seen.add(eid);
            }
          });
        });
      }
    } catch {}
  }

  if (items.length < hardLimit) {
    lsRead().forEach((l) => {
      const status = String(l?.status || '').toUpperCase();
      if ((status === 'PENDING' || status === 'COLLECTED') && l.external_id && !seen.has(l.external_id)) {
        items.push(l);
        seen.add(l.external_id);
      }
    });
  }

  return { ok: true, items: items.slice(0, hardLimit) };
}

export async function listOwedCashPaymentsByPin(limit = 500) {
  let rows = [];
  try {
    const { data } = await supabase
      .from('arka_pending_payments')
      .select('*')
      .in('status', ['OWED', 'REJECTED', 'WORKER_DEBT', 'ADVANCE'])
      .order('created_at', { ascending: true })
      .limit(limit);
    if (Array.isArray(data)) rows = data;
  } catch {}

  if (!rows.length) {
    try {
      const data = await listRecentBaseOrderRows(200);
      if (Array.isArray(data)) {
        const tmp = [];
        data.forEach((row) => {
          const pends = row.data?.pay?.pendingCash || [];
          pends.forEach((p) => {
            if (['OWED', 'REJECTED', 'WORKER_DEBT', 'ADVANCE'].includes(String(p?.status || '').toUpperCase())) {
              tmp.push({ ...p, order_id: row.id });
            }
          });
        });
        rows = tmp;
      }
    } catch {}
  }

  const byPin = new Map();
  for (const r of rows) {
    const pin = r.created_by_pin || r.pin || 'PA_PIN';
    const name = r.created_by_name || r.name || '';
    if (!byPin.has(pin)) byPin.set(pin, { pin, name, total: 0, count: 0, items: [] });
    const g = byPin.get(pin);
    const amt = Number(r.amount ?? r.sum ?? 0) || 0;
    g.total += amt;
    g.count += 1;
    g.items.push(r);
  }

  const groups = Array.from(byPin.values()).sort((a, b) => (b.total - a.total) || (b.count - a.count) || String(a.pin).localeCompare(String(b.pin)));
  return { ok: true, items: groups };
}

export async function applyPendingPaymentToCycle({ pending, cycle_id, approved_by_name, approved_by_pin, approved_by_role }) {
  const handoffId = pending?.handoff_id || pending?.handoffId || cycle_id || null;
  if (!handoffId) {
    return { ok: false, error: 'LEGACY_DIRECT_ACCEPT_DISABLED_USE_HANDOFF_FLOW' };
  }
  try {
    return await arkaTransaction({
      action: ARKA_ACTION.ACCEPT_HANDOFF,
      handoffId,
      actorPin: approved_by_pin,
      actorName: approved_by_name,
      actorRole: approved_by_role,
      idempotencyKey: buildArkaIdempotencyKey(ARKA_ACTION.ACCEPT_HANDOFF, [handoffId]),
    });
  } catch (error) {
    return { ok: false, error: translateDbError(error), raw_error: String(error?.message || error) };
  }
}



export async function rejectPendingPayment({ pending, rejected_by_pin, rejected_by_name, rejected_by_role, reject_note } = {}) {
  if (!pending?.id) return { ok: false, error: 'MISSING_PENDING_ID' };
  try {
    return await arkaTransaction({
      action: ARKA_ACTION.VOID_OR_REVERSE_PAYMENT,
      paymentId: pending.id,
      actorPin: rejected_by_pin,
      actorName: rejected_by_name,
      actorRole: rejected_by_role,
      note: reject_note || pending?.note || 'REJECT_PENDING_PAYMENT',
      idempotencyKey: buildArkaIdempotencyKey(ARKA_ACTION.VOID_OR_REVERSE_PAYMENT, [pending.id, rejected_by_pin || '']),
    });
  } catch (error) {
    return { ok: false, error: translateDbError(error), raw_error: String(error?.message || error) };
  }
}



export async function processPendingPayments({ approved_by_name, approved_by_pin, approved_by_role } = {}) {
  return {
    ok: false,
    applied: 0,
    error: 'LEGACY_BATCH_ACCEPT_DISABLED_USE_SUBMIT_AND_ACCEPT_HANDOFF',
    approved_by_name,
    approved_by_pin,
    approved_by_role,
  };
}


export async function listWorkerOwedPayments(workerPin, limit = 200) {
  const pin = String(workerPin || '').trim();
  if (!pin) return { ok: true, rows: [] };

  try {
    const { data } = await supabase
      .from('arka_pending_payments')
      .select('*')
      .in('status', ['OWED', 'REJECTED', 'WORKER_DEBT', 'ADVANCE'])
      .eq('created_by_pin', pin)
      .order('created_at', { ascending: true })
      .limit(limit);
    if (Array.isArray(data) && data.length) return { ok: true, rows: data };
  } catch {}

  try {
    const data = await listRecentBaseOrderRows(200);
    const rows = [];
    if (Array.isArray(data)) {
      data.forEach((row) => {
        const pends = row.data?.pay?.pendingCash || [];
        pends.forEach((p) => {
          if (
            ['OWED', 'REJECTED', 'WORKER_DEBT', 'ADVANCE'].includes(String(p?.status || '').toUpperCase()) &&
            String(p.created_by_pin || p.pin || '').trim() === pin
          ) {
            rows.push({ ...p, order_id: row.id });
          }
        });
      });
    }
    return { ok: true, rows: rows.slice(0, limit) };
  } catch {}

  return { ok: true, rows: [] };
}

export async function markOwedAsPending({ pending, actor } = {}) {
  if (!pending?.id) return { ok: false, error: 'MISSING_PENDING_ID' };
  return {
    ok: false,
    error: 'LEGACY_OWED_STATUS_WRITE_DISABLED_USE_EXPENSE_REQUEST_OR_AUDIT_VOID',
    id: pending.id,
    actorPin: actor?.pin || null,
  };
}



export async function markOwedAsAdvance({ pending, actor, note } = {}) {
  if (!pending?.id) return { ok: false, error: 'MISSING_PENDING_ID' };
  return createPendingCashPayment({
    amount: Math.abs(Number(pending.amount || 0) || 0),
    type: 'ADVANCE',
    paymentType: 'ADVANCE',
    status: 'ADVANCE',
    note: note || pending?.note || 'AVANS',
    workerPin: pending.created_by_pin || pending.worker_pin || actor?.pin || null,
    workerName: pending.created_by_name || pending.worker_name || actor?.name || null,
    created_by_pin: pending.created_by_pin || actor?.pin || null,
    created_by_name: pending.created_by_name || actor?.name || null,
    user: actor || null,
    sourceModule: ARKA_SOURCE_MODULE.ARKA,
  });
}



export async function confirmHandoffByDispatch(actorPin) {
  return {
    ok: false,
    error: 'LEGACY_CONFIRM_DISABLED_USE_CORPORATE_FINANCE',
    actorPin: String(actorPin || '').trim() || null,
  };
}

function pendingCashRowBelongsToActor(row, actorPin) {
  const pin = String(actorPin || '').trim();
  if (!pin) return true;
  const data = row?.data && typeof row.data === 'object' ? row.data : {};
  const candidates = [
    row?.created_by_pin,
    row?.handed_by_pin,
    row?.worker_pin,
    row?.pin,
    row?.driver_pin,
    row?.transport_pin,
    data?.created_by_pin,
    data?.handed_by_pin,
    data?.worker_pin,
    data?.pin,
    data?.driver_pin,
    data?.transport_pin,
  ]
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  if (!candidates.length) return false;
  return candidates.includes(pin);
}

export async function listPendingCashForActor(actorPin, limit = 200) {
  const pin = String(actorPin || '').trim();
  if (!pin) return { ok: true, items: [] };

  const hardLimit = Math.max(1, Math.min(Number(limit || 200), 500));
  const items = [];
  const seen = new Set();

  const addRow = (row) => {
    if (!row || !pendingCashRowBelongsToActor(row, pin)) return;
    const status = String(row?.status || '').trim().toUpperCase();
    if (!['PENDING', 'COLLECTED'].includes(status)) return;
    const amount = Number(row?.amount || 0) || 0;
    if (amount <= 0) return;
    const key = String(row?.id || row?.external_id || row?.externalId || `${row?.created_at || ''}_${row?.amount || ''}_${row?.order_code || ''}_${row?.transport_code_str || ''}`);
    if (!key || seen.has(key)) return;
    seen.add(key);
    items.push(row);
  };

  // Direct per-worker DB lookup first. The old global lookup is capped and can miss
  // a worker's newer cash rows when many other pending rows exist.
  try {
    const { data } = await supabase
      .from('arka_pending_payments')
      .select('*')
      .eq('created_by_pin', pin)
      .in('status', ['PENDING', 'COLLECTED'])
      .order('created_at', { ascending: false })
      .limit(hardLimit);
    (Array.isArray(data) ? data : []).forEach(addRow);
  } catch {}

  if (items.length < hardLimit) {
    try {
      const { data } = await supabase
        .from('arka_pending_payments')
        .select('*')
        .eq('handed_by_pin', pin)
        .in('status', ['PENDING', 'COLLECTED'])
        .order('created_at', { ascending: false })
        .limit(hardLimit);
      (Array.isArray(data) ? data : []).forEach(addRow);
    } catch {}
  }

  // Keep the legacy/global fallback for local rows and older embedded pending cash.
  if (items.length < hardLimit) {
    try {
      const res = await listPendingCashPayments(Math.max(limit, hardLimit));
      (Array.isArray(res?.items) ? res.items : []).forEach(addRow);
    } catch {}
  }

  const sorted = items
    .slice()
    .sort((a, b) => String(b?.created_at || b?.updated_at || '').localeCompare(String(a?.created_at || a?.updated_at || '')));

  return { ok: true, items: sorted.slice(0, hardLimit) };
}

export async function handoffActorPendingCash({ actor, note = '' } = {}) {
  const pin = String(actor?.pin || '').trim();
  if (!pin) return { ok: false, error: 'MISSING_PIN' };
  const itemsRes = await listPendingCashForActor(pin, 500);
  const paymentIds = Array.isArray(itemsRes?.items)
    ? itemsRes.items
        .filter((x) => ['PENDING', 'COLLECTED'].includes(String(x?.status || '').toUpperCase()))
        .map((x) => x?.id)
        .filter(Boolean)
    : [];
  if (!paymentIds.length) return { ok: true, total: 0, count: 0 };

  const result = await arkaTransaction({
    action: ARKA_ACTION.SUBMIT_HANDOFF,
    actorPin: pin,
    actorName: actor?.name || null,
    actorRole: actor?.role || null,
    paymentIds,
    note,
    idempotencyKey: buildArkaIdempotencyKey(ARKA_ACTION.SUBMIT_HANDOFF, [pin, paymentIds.slice().sort().join('-')]),
  });

  return {
    ok: true,
    ...(result || {}),
    total: Number(result?.total || result?.handoff?.amount || 0),
    count: Number(result?.count || paymentIds.length),
    items: result?.handoff?.cash_handoff_items || [],
    mode: 'ARKA_ENGINE_SUBMIT_HANDOFF',
  };
}

