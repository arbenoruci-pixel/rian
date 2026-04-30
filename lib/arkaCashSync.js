import { supabase } from '@/lib/supabaseClient';
import { fetchOrderById, listOrderRecords, updateOrderData } from '@/lib/ordersService';

const LS_PENDING_KEY = 'arka_pending_payments_v1';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;


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
  const now = new Date().toISOString();
  const external_id = payload.externalId || payload.external_id || `pend_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const amount = Number(payload.amount || 0);

  let actorPin = payload.created_by_pin || payload.user_pin || payload.createdByPin || payload.userPin || payload?.user?.pin || null;
  let actorName = payload.created_by_name || payload.user_name || payload.createdByName || payload.user || payload?.user?.name || null;
  const currentUser = (!actorPin || !actorName) ? readCurrentUserData() : null;
  actorPin = actorPin || currentUser?.pin || null;
  actorName = actorName || currentUser?.name || null;

  const actor = { pin: actorPin || null, name: actorName || null };
  const dbRow = toDbPendingRow({ ...payload, amount }, actor, now);
  const rawOrderRef = payload.order_id || payload.orderId || null;
  const rowForLocal = {
    ...dbRow,
    external_id,
    created_by_role: payload.created_by_role || payload.user_role || payload.createdByRole || payload?.user?.role || null,
    source_order_ref: rawOrderRef != null ? String(rawOrderRef) : null,
  };

  let lastDbError = null;
  try {
    const ok = await pendingTableOk();
    if (ok) {
      const existingPending = await findExistingBasePendingCashPayment(dbRow);
      if (existingPending?.id) {
        return {
          ok: true,
          pending: true,
          duplicate: true,
          existing: true,
          row: { ...(existingPending || {}), external_id: existingPending.external_id || `existing_pending_${existingPending.id}` },
        };
      }

      const { data, error } = await supabase.from('arka_pending_payments').insert(dbRow).select('*').single();
      if (!error) {
        return { ok: true, pending: true, row: { ...(data || {}), external_id } };
      }

      lastDbError = {
        code: error.code,
        message: translateDbError(error),
        raw_message: error.message,
        details: error.details,
        hint: error.hint,
      };
    }
  } catch (e) {
    lastDbError = lastDbError || { message: translateDbError(e), raw_message: String(e?.message || e) };
  }

  await backupPendingIntoOrder({ ...payload, created_by_pin: actorPin || null, created_by_name: actorName || null }, external_id, rowForLocal);
  lsPush(rowForLocal);
  return { ok: true, pending: true, local: true, row: rowForLocal, db_error: lastDbError };
}


export async function recordCashMove(payload = {}) {
  const amt = Number(payload.amount || 0);
  if (amt <= 0) return { ok: false, skipped: true };

  const external_id = payload.external_id || payload.externalId || `cash_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const typeUpper = String(payload.type || '').toUpperCase();
  const explicitArkaType = String(payload.arka_type || payload.arkaType || '').toUpperCase();
  const isTransport = explicitArkaType === 'TRANSPORT' || typeUpper === 'TRANSPORT';

  let actor = {
    pin: payload.created_by_pin || payload.createdByPin || payload.user_pin || payload.userPin || payload?.user?.pin || null,
    name: payload.created_by_name || payload.createdByName || payload.created_by || payload.createdBy || payload.user_name || payload.user || payload?.user?.name || null,
    role: payload.created_by_role || payload.createdByRole || payload.user_role || payload.userRole || payload?.user?.role || null,
  };

  if (typeof window !== 'undefined' && (!actor.pin || !actor.name || !actor.role)) {
    try {
      const raw = localStorage.getItem('CURRENT_USER_DATA');
      const parsed = raw ? JSON.parse(raw) : null;
      actor = {
        pin: actor.pin || parsed?.pin || null,
        name: actor.name || parsed?.name || null,
        role: actor.role || parsed?.role || null,
      };
    } catch {}
  }

  const normalizedPayload = {
    ...payload,
    external_id,
    amount: amt,
    created_by_pin: actor.pin || null,
    created_by_name: actor.name || null,
    created_by_role: actor.role || null,
    createdByPin: actor.pin || null,
    createdByName: actor.name || null,
    createdByRole: actor.role || null,
    status: payload.status || (isTransport ? 'COLLECTED' : 'PENDING'),
  };

  try {
    const pendingRes = await createPendingCashPayment(normalizedPayload);

    try {
      if (isTransport && typeof window !== 'undefined' && typeof localStorage !== 'undefined') {
        const tid = String(actor.pin || payload.transport_id || payload.transportId || '').trim();
        const key = `arka_transport_wallet_v1_${tid || 'unknown'}`;
        const raw = localStorage.getItem(key);
        const st = raw ? JSON.parse(raw) : { items: [], expenses: [], transfers: [] };
        const next = {
          ...st,
          items: [
            {
              ts: Date.now(),
              external_id,
              order_code: payload.transport_code_str || payload.transportCodeStr || payload.order_code || payload.code || '',
              client_name: payload.client_name || payload.name || '',
              amount: amt,
              note: payload.note || '',
              status: String(normalizedPayload.status || 'COLLECTED').toUpperCase(),
              created_by_pin: actor.pin || null,
              created_by_name: actor.name || null,
            },
            ...(Array.isArray(st.items) ? st.items : []),
          ].slice(0, 500),
        };
        localStorage.setItem(key, JSON.stringify(next));
      }
    } catch {}

    return {
      ...(pendingRes || { ok: true }),
      pending: true,
      direct: false,
      external_id,
      mode: isTransport ? 'TRANSPORT_PENDING' : 'PENDING_ONLY',
    };
  } catch {
    return await createPendingCashPayment(normalizedPayload);
  }
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
  const rowId = pending?.id ?? null;
  const eid = pending?.external_id || pending?.externalId || null;
  if (!rowId && !eid) return { ok: false, error: 'MISSING_PENDING_ID' };
  const nowIso = new Date().toISOString();

  const payload = {
    status: 'ACCEPTED_BY_DISPATCH',
    approved_by_pin: approved_by_pin ?? null,
    approved_by_name: approved_by_name ?? null,
    handed_by_role: approved_by_role ?? null,
    updated_at: nowIso,
  };
  if (cycle_id != null && String(cycle_id).trim() !== '') payload.applied_cycle_id = Number(cycle_id) || cycle_id;

  try {
    let q = supabase.from('arka_pending_payments').update(payload);
    q = rowId ? q.eq('id', rowId) : q.eq('id', -1);
    q = q.in('status', ['PENDING', 'COLLECTED', 'HANDED', 'PENDING_DISPATCH_APPROVAL']);
    const { error } = await q;
    if (error) throw error;

    await markOrderPendingApplied(eid || rowId, pending?.order_id || pending?.orderId || null);
    try {
      const next = lsRead().map((x) => (String(x.external_id || x.externalId || '') === String(eid)
        ? { ...x, status: 'ACCEPTED_BY_DISPATCH', approved_by_pin: approved_by_pin ?? null, updated_at: nowIso }
        : x));
      lsWrite(next);
    } catch {}
    return { ok: true, accepted: true, id: rowId ?? null, external_id: eid };
  } catch (e) {
    return { ok: false, error: translateDbError(e), raw_error: String(e?.message || e) };
  }
}


export async function rejectPendingPayment({ pending, rejected_by_pin, rejected_by_name, rejected_by_role, reject_note } = {}) {
  const rowId = pending?.id ?? null;
  const eid = pending?.external_id || pending?.externalId || null;
  if (!rowId && !eid) return { ok: false, error: 'Missing pending id' };
  const now = new Date().toISOString();

  try {
    const payload = {
      status: 'REJECTED',
      type: 'WORKER_DEBT',
      note: reject_note ?? pending?.note ?? null,
      approved_by_pin: rejected_by_pin ?? null,
      approved_by_name: rejected_by_name ?? null,
      updated_at: now,
    };
    let q = supabase.from('arka_pending_payments').update(payload);
    q = rowId ? q.eq('id', rowId) : q.eq('id', -1);
    const { error } = await q;
    if (error) throw error;
  } catch (e1) {
    try {
      let q = supabase.from('arka_pending_payments').update({ status: 'REJECTED', type: 'WORKER_DEBT', updated_at: now });
      q = rowId ? q.eq('id', rowId) : q.eq('id', -1);
      await q;
    } catch {}
  }

  try {
    await markOrderPendingDebt(eid || rowId, reject_note, pending.order_id || pending.orderId || null);
  } catch {}

  try {
    const next = lsRead().map((x) => (String(x.external_id || x.externalId || '') === String(eid)
      ? {
          ...x,
          status: 'REJECTED',
          type: 'WORKER_DEBT',
          rejected_at: now,
          rejected_by_pin: rejected_by_pin ?? null,
          rejected_by_name: rejected_by_name ?? null,
          rejected_by_role: rejected_by_role ?? null,
          reject_note: reject_note ?? null,
        }
      : x));
    lsWrite(next);
  } catch {}

  return { ok: true, id: rowId ?? null, external_id: eid };
}


export async function processPendingPayments({ approved_by_name, approved_by_pin, approved_by_role } = {}) {
  const { items } = await listPendingCashPayments();
  let applied = 0;
  for (const p of (items || [])) {
    const res = await applyPendingPaymentToCycle({ pending: p, cycle_id: null, approved_by_name, approved_by_pin, approved_by_role });
    if (res?.ok) applied += 1;
  }
  return { ok: true, applied, mode: 'NO_CYCLE' };
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
  const rowId = pending?.id ?? null;
  const eid = pending?.external_id || pending?.externalId;
  if (!rowId && !eid) return { ok: false, error: 'Missing pending id' };
  const now = new Date().toISOString();

  try {
    const payload = {
      status: 'PENDING',
      handed_at: now,
      handed_by_name: actor?.name ?? null,
      handed_by_role: actor?.role ?? null,
      handed_by_pin: actor?.pin ?? null,
      updated_at: now,
    };
    let q = supabase.from('arka_pending_payments').update(payload);
    q = rowId ? q.eq('id', rowId) : q.eq('id', -1);
    const { error } = await q;
    if (error) throw error;
    return { ok: true };
  } catch {}

  try {
    let q = supabase.from('arka_pending_payments').update({ status: 'PENDING', updated_at: now });
    q = rowId ? q.eq('id', rowId) : q.eq('id', -1);
    const { error } = await q;
    if (error) throw error;
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}


export async function markOwedAsAdvance({ pending, actor, note } = {}) {
  const rowId = pending?.id ?? null;
  const eid = pending?.external_id || pending?.externalId;
  if (!rowId && !eid) return { ok: false, error: 'Missing pending id' };
  const now = new Date().toISOString();

  try {
    const payload = {
      status: 'ADVANCE',
      note: note ?? pending?.note ?? null,
      approved_by_name: actor?.name ?? null,
      approved_by_pin: actor?.pin ?? null,
      updated_at: now,
    };
    let q = supabase.from('arka_pending_payments').update(payload);
    q = rowId ? q.eq('id', rowId) : q.eq('id', -1);
    const { error } = await q;
    if (error) throw error;
    return { ok: true };
  } catch {}

  try {
    let q = supabase.from('arka_pending_payments').update({ status: 'ADVANCE', updated_at: now });
    q = rowId ? q.eq('id', rowId) : q.eq('id', -1);
    const { error } = await q;
    if (error) throw error;
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}


export async function confirmHandoffByDispatch(actorPin) {
  return {
    ok: false,
    error: 'LEGACY_CONFIRM_DISABLED_USE_CORPORATE_FINANCE',
    actorPin: String(actorPin || '').trim() || null,
  };
}

export async function listPendingCashForActor(actorPin, limit = 200) {
  const pin = String(actorPin || '').trim();
  if (!pin) return { ok: true, items: [] };
  const res = await listPendingCashPayments(limit);
  const items = Array.isArray(res?.items)
    ? res.items.filter((x) => String(x?.created_by_pin || x?.pin || '').trim() === pin)
    : [];
  return { ok: true, items };
}

export async function handoffActorPendingCash({ actor, note = '' } = {}) {
  const pin = String(actor?.pin || '').trim();
  if (!pin) return { ok: false, error: 'MISSING_PIN' };
  const itemsRes = await listPendingCashForActor(pin, 500);
  const items = Array.isArray(itemsRes?.items)
    ? itemsRes.items.filter((x) => ['PENDING', 'COLLECTED'].includes(String(x?.status || '').toUpperCase()))
    : [];
  const total = items.reduce((sum, x) => sum + (Number(x?.amount || 0) || 0), 0);
  if (!items.length || total <= 0) return { ok: true, total: 0, count: 0 };

  const now = new Date().toISOString();
  for (const item of items) {
    const rowId = item?.id ?? null;
    if (!rowId) continue;
    try {
      await supabase
        .from('arka_pending_payments')
        .update({
          status: 'HANDED',
          handed_at: now,
          handed_by_pin: pin,
          handed_by_name: actor?.name || null,
          handed_by_role: actor?.role || null,
          handoff_note: note || null,
          updated_at: now,
        })
        .eq('id', rowId)
        .in('status', ['PENDING', 'COLLECTED']);
    } catch {}
  }

  try {
    const next = lsRead().map((x) => {
      const p = String(x?.created_by_pin || x?.pin || '').trim();
      const st = String(x?.status || '').toUpperCase();
      if (p === pin && (st === 'PENDING' || st === 'COLLECTED')) {
        return {
          ...x,
          status: 'HANDED',
          handed_at: now,
          handed_by_pin: pin,
          handed_by_name: actor?.name || null,
          handed_by_role: actor?.role || null,
          handoff_note: note || null,
        };
      }
      return x;
    });
    lsWrite(next);
  } catch {}

  return { ok: true, total: Number(total.toFixed(2)), count: items.length, items };
}
