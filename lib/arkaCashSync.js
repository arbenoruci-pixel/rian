import { supabase } from '@/lib/supabaseClient';

const LS_PENDING_KEY = 'arka_pending_payments_v1';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

async function pendingTableOk() {
  return true;
}

async function backupPendingIntoOrder(payload = {}, external_id, rowLike = {}) {
  try {
    const order_id = payload.orderId || payload.order_id || null;
    if (!order_id || !external_id) return;

    const { data, error } = await supabase.from('orders').select('id,data').eq('id', order_id).maybeSingle();
    if (error || !data?.id) return;

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
    await supabase.from('orders').update({ data: { ...current, pay } }).eq('id', order_id);
  } catch {}
}

async function markOrderPendingApplied(external_id, order_id = null) {
  if (!external_id) return;
  try {
    if (order_id) {
      const { data } = await supabase.from('orders').select('id,data').eq('id', order_id).maybeSingle();
      if (data?.id) {
        const cur = data?.data || {};
        const pend = Array.isArray(cur?.pay?.pendingCash) ? [...cur.pay.pendingCash] : [];
        const idx = pend.findIndex((x) => String(x.external_id || x.externalId || '') === String(external_id));
        if (idx !== -1) {
          pend[idx] = { ...pend[idx], status: 'APPLIED', applied_at: new Date().toISOString() };
          await supabase.from('orders').update({ data: { ...cur, pay: { ...(cur.pay || {}), pendingCash: pend } } }).eq('id', order_id);
          return;
        }
      }
    }

    const { data } = await supabase.from('orders').select('id,data').order('created_at', { ascending: false }).limit(50);
    if (!data) return;
    for (const row of data) {
      const cur = row?.data || {};
      const pend = cur.pay?.pendingCash;
      if (!Array.isArray(pend)) continue;
      const idx = pend.findIndex((x) => String(x.external_id || x.externalId || '') === String(external_id));
      if (idx === -1) continue;
      pend[idx] = { ...pend[idx], status: 'APPLIED', applied_at: new Date().toISOString() };
      await supabase.from('orders').update({ data: { ...cur, pay: { ...(cur.pay || {}), pendingCash: pend } } }).eq('id', row.id);
      break;
    }
  } catch {}
}

async function markOrderPendingDebt(external_id, note = '', order_id = null) {
  if (!external_id) return;
  try {
    if (order_id) {
      const { data } = await supabase.from('orders').select('id,data').eq('id', order_id).maybeSingle();
      if (data?.id) {
        const cur = data?.data || {};
        const pend = Array.isArray(cur?.pay?.pendingCash) ? [...cur.pay.pendingCash] : [];
        const idx = pend.findIndex((x) => String(x.external_id || x.externalId || '') === String(external_id));
        if (idx !== -1) {
          pend[idx] = {
            ...pend[idx],
            status: 'REJECTED',
            rejected_at: new Date().toISOString(),
            reject_note: note || pend[idx]?.reject_note || '',
          };
          await supabase.from('orders').update({ data: { ...cur, pay: { ...(cur.pay || {}), pendingCash: pend } } }).eq('id', order_id);
          return;
        }
      }
    }

    const { data } = await supabase.from('orders').select('id,data').order('created_at', { ascending: false }).limit(50);
    if (!data) return;
    for (const row of data) {
      const cur = row?.data || {};
      const pend = cur.pay?.pendingCash;
      if (!Array.isArray(pend)) continue;
      const idx = pend.findIndex((x) => String(x.external_id || x.externalId || '') === String(external_id));
      if (idx === -1) continue;
      pend[idx] = {
        ...pend[idx],
        status: 'REJECTED',
        rejected_at: new Date().toISOString(),
        reject_note: note || pend[idx]?.reject_note || '',
      };
      await supabase.from('orders').update({ data: { ...cur, pay: { ...(cur.pay || {}), pendingCash: pend } } }).eq('id', row.id);
      break;
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

  const row = {
    external_id,
    status: String((String(payload.type || '').toUpperCase() === 'TRANSPORT' && !payload.status) ? 'COLLECTED' : (payload.status || 'PENDING')).toUpperCase(),
    amount,
    type: String(payload.type || 'IN').toUpperCase(),
    method: 'CASH',
    order_id: payload.order_id || payload.orderId || null,
    order_code: payload.order_code || payload.code || null,
    client_name: payload.client_name || payload.name || null,
    note: payload.note || '',
    created_by_pin: actorPin || null,
    created_at: now,
  };

  const rowForLocal = {
    ...row,
    created_by_name: actorName || null,
    created_by_role: payload.created_by_role || payload.user_role || payload.createdByRole || payload?.user?.role || null,
  };

  let lastDbError = null;
  try {
    const ok = await pendingTableOk();
    if (ok) {
      const { data, error } = await supabase.from('arka_pending_payments').insert(row).select('*').single();
      if (!error) {
        let rowData = data;
        try {
          if (String(row.type || '').toUpperCase() === 'TRANSPORT' && String(rowData?.status || '').toUpperCase() !== 'COLLECTED') {
            const { data: fixedData } = await supabase
              .from('arka_pending_payments')
              .update({ status: 'COLLECTED' })
              .eq('external_id', row.external_id)
              .select('*')
              .single();
            rowData = fixedData || { ...(rowData || {}), status: 'COLLECTED' };
          }
        } catch {}
        return { ok: true, pending: true, row: rowData };
      }

      lastDbError = {
        code: error.code,
        message: translateDbError(error),
        raw_message: error.message,
        details: error.details,
        hint: error.hint,
      };
      if (error.code === '23505') {
        const { data: ex } = await supabase.from('arka_pending_payments').select('*').eq('external_id', external_id).maybeSingle();
        return { ok: true, pending: true, row: ex };
      }
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
              order_code: payload.order_code || payload.code || '',
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
      .eq('method', 'CASH')
      .order('created_at', { ascending: true })
      .limit(hardLimit);
    if (data) {
      data.forEach((r) => {
        if (!seen.has(r.external_id)) {
          items.push(r);
          seen.add(r.external_id);
        }
      });
    }
  } catch {}

  if (items.length < hardLimit) {
    try {
      const { data } = await supabase.from('orders').select('id,data').order('created_at', { ascending: false }).limit(40);
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
      const { data } = await supabase.from('orders').select('id,data').order('created_at', { ascending: false }).limit(200);
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
  const eid = pending?.external_id || pending?.externalId;
  if (!eid) return { ok: false, error: 'MISSING_PENDING_ID' };
  const nowIso = new Date().toISOString();

  const payload = {
    status: 'ACCEPTED_BY_DISPATCH',
    applied_at: nowIso,
    approved_by_pin: approved_by_pin ?? null,
    approved_by_name: approved_by_name ?? null,
    approved_by_role: approved_by_role ?? null,
  };

  try {
    const applyUpdate = normalizeUuid(cycle_id) ? { ...payload, applied_cycle_id: normalizeUuid(cycle_id) } : payload;
    const { error } = await supabase
      .from('arka_pending_payments')
      .update(applyUpdate)
      .eq('external_id', eid)
      .in('status', ['PENDING', 'COLLECTED', 'HANDED', 'PENDING_DISPATCH_APPROVAL']);
    if (error) throw error;

    await markOrderPendingApplied(eid, pending?.order_id || pending?.orderId || null);
    try {
      const next = lsRead().map((x) => (String(x.external_id || x.externalId || '') === String(eid)
        ? { ...x, status: 'ACCEPTED_BY_DISPATCH', applied_at: nowIso, approved_by_pin: approved_by_pin ?? null }
        : x));
      lsWrite(next);
    } catch {}
    return { ok: true, accepted: true, external_id: eid };
  } catch (e) {
    return { ok: false, error: translateDbError(e), raw_error: String(e?.message || e) };
  }
}

export async function rejectPendingPayment({ pending, rejected_by_pin, rejected_by_name, rejected_by_role, reject_note } = {}) {
  const eid = pending?.external_id || pending?.externalId;
  if (!eid) return { ok: false, error: 'Missing pending.external_id' };
  const now = new Date().toISOString();

  try {
    const payload = {
      status: 'REJECTED',
      type: 'WORKER_DEBT',
      rejected_at: now,
      rejected_by_pin: rejected_by_pin ?? null,
      rejected_by_name: rejected_by_name ?? null,
      rejected_by_role: rejected_by_role ?? null,
      reject_note: reject_note ?? null,
    };
    const { error } = await supabase.from('arka_pending_payments').update(payload).eq('external_id', eid);
    if (error) throw error;
  } catch (e1) {
    try {
      await supabase.from('arka_pending_payments').update({ status: 'REJECTED', type: 'WORKER_DEBT', rejected_at: now }).eq('external_id', eid);
    } catch {}
  }

  try {
    await markOrderPendingDebt(eid, reject_note, pending.order_id || pending.orderId || null);
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

  return { ok: true, external_id: eid };
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
      .eq('method', 'CASH')
      .eq('created_by_pin', pin)
      .order('created_at', { ascending: true })
      .limit(limit);
    if (Array.isArray(data) && data.length) return { ok: true, rows: data };
  } catch {}

  try {
    const { data } = await supabase.from('orders').select('id,data').order('created_at', { ascending: false }).limit(200);
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
  const eid = pending?.external_id || pending?.externalId;
  if (!eid) return { ok: false, error: 'Missing external_id' };
  const now = new Date().toISOString();

  try {
    const payload = {
      status: 'PENDING',
      delivered_at: now,
      delivered_by_name: actor?.name ?? null,
      delivered_by_role: actor?.role ?? null,
      delivered_by_pin: actor?.pin ?? null,
    };
    const { error } = await supabase.from('arka_pending_payments').update(payload).eq('external_id', eid);
    if (error) throw error;
    return { ok: true };
  } catch {}

  try {
    const { error } = await supabase.from('arka_pending_payments').update({ status: 'PENDING' }).eq('external_id', eid);
    if (error) throw error;
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

export async function markOwedAsAdvance({ pending, actor, note } = {}) {
  const eid = pending?.external_id || pending?.externalId;
  if (!eid) return { ok: false, error: 'Missing external_id' };
  const now = new Date().toISOString();

  try {
    const payload = {
      status: 'ADVANCE',
      advance_at: now,
      advance_by_name: actor?.name ?? null,
      advance_by_role: actor?.role ?? null,
      advance_by_pin: actor?.pin ?? null,
      advance_note: note ?? null,
    };
    const { error } = await supabase.from('arka_pending_payments').update(payload).eq('external_id', eid);
    if (error) throw error;
    return { ok: true };
  } catch {}

  try {
    const { error } = await supabase.from('arka_pending_payments').update({ status: 'ADVANCE' }).eq('external_id', eid);
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
    const eid = item.external_id || item.externalId;
    if (!eid) continue;
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
        })
        .eq('external_id', eid)
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
