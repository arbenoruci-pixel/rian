// lib/ordersDb.js
// DB helpers for TEPIHA (clients + orders)
// Minimal, targeted: add audit + stop "reactivate on duplicate" behavior.

import { supabase } from '@/lib/supabaseClient';
import { saveOrderLocal, pushOp, getAllOrdersLocal } from '@/lib/offlineStore';


function uuidv4(){
  try { return crypto.randomUUID(); } catch { return String(Date.now()) + '_' + Math.random().toString(16).slice(2); }
}

function normPhone(p) {
  return String(p || '').trim().replace(/\s+/g, '');
}

function normName(n) {
  return String(n || '').trim();
}

function normCode(code) {
  const s = String(code ?? '').trim();
  const digits = s.replace(/\D+/g, '').replace(/^0+/, '');
  const n = Number(digits || 0);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function splitName(full) {
  const name = normName(full);
  if (!name) return { full_name: 'PA EMER', first_name: 'PA', last_name: '' };
  const parts = name.split(/\s+/).filter(Boolean);
  const first = parts[0] || 'PA';
  const last = parts.slice(1).join(' ');
  return { full_name: name, first_name: first, last_name: last };
}

const LS_CLIENTS_CACHE = 'clients_cache_v1';
const LS_ORDERS_CACHE = 'orders_cache_v1';

function readActor() {
  try {
    const raw = localStorage.getItem('CURRENT_USER_DATA');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function attachAudit(payload = {}, source = 'UNKNOWN') {
  const actor = readActor();
  const now = new Date().toISOString();

  const p = payload && typeof payload === 'object' ? payload : {};
  if (!p._audit) p._audit = {};
  if (!p._audit.created_at) p._audit.created_at = now;

  // ruaje kush e krijoi (për përgjegjësi)
  p._audit.created_by_name =
    p._audit.created_by_name ||
    actor?.name ||
    actor?.username ||
    actor?.full_name ||
    'UNKNOWN';

  p._audit.created_by_role = p._audit.created_by_role || actor?.role || null;
  p._audit.created_by_pin = p._audit.created_by_pin || actor?.pin || null;
  p._audit.source = p._audit.source || source;

  // last touched
  p._audit.last_at = now;
  p._audit.last_by_name = actor?.name || actor?.username || 'UNKNOWN';

  return p;
}

export async function upsertClientFromOrder(order) {
  const wantedCode = normCode(order?.client?.code ?? order?.code ?? order?.client_code);
  const phone = normPhone(order?.client?.phone ?? order?.client_phone ?? order?.phone);
  const rawName = normName(order?.client?.name ?? order?.client_name ?? order?.name);
  const photoUrl =
    order?.client?.photoUrl ||
    order?.client?.photo_url ||
    order?.photo_url ||
    order?.client_photo_url ||
    null;

  if (!phone) throw new Error('MISSING_CLIENT_PHONE');

  // OFFLINE: ruaje në cache + queue, mos e blloko userin
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    const nm = splitName(rawName);
    const localRow = {
      phone,
      code: wantedCode || null,
      full_name: nm.full_name,
      first_name: nm.first_name,
      last_name: nm.last_name,
      photo_url: photoUrl || null,
      updated_at: new Date().toISOString(),
    };

    // update local clients cache (by phone)
    try {
      const cur = JSON.parse(localStorage.getItem(LS_CLIENTS_CACHE) || '[]');
      const arr = Array.isArray(cur) ? cur : [];
      const i = arr.findIndex((c) => String(c.phone||'') === phone);
      if (i >= 0) arr[i] = { ...arr[i], ...localRow };
      else arr.unshift({ id: 'local:' + phone, ...localRow });
      localStorage.setItem(LS_CLIENTS_CACHE, JSON.stringify(arr));
    } catch {}

    // queue op for later sync (only if we have a wantedCode when inserting new)
    await pushOp({
      op_id: uuidv4(),
      type: "upsert_client",
      entity: "client",
      entity_id: phone,
      payload: localRow,
      created_at: Date.now(),
    });

    return { id: 'local:' + phone, code: wantedCode || null, phone, full_name: nm.full_name, first_name: nm.first_name, last_name: nm.last_name };
  }


  // IMPORTANT: never change an existing client's code just because we upsert by phone.
  // If the phone exists, we keep the existing code and only refresh name/photo.
  const { data: existing, error: selErr } = await supabase
    .from('clients')
    .select('id, code, phone')
    .eq('phone', phone)
    .maybeSingle();
  if (selErr) throw selErr;

  const nm = splitName(rawName);

  if (existing?.id) {
    const patch = {
      updated_at: new Date().toISOString(),
      full_name: nm.full_name || null,
      first_name: nm.first_name || null,
      last_name: nm.last_name || null,
      photo_url: photoUrl || null,
    };
    const { data, error } = await supabase
      .from('clients')
      .update(patch)
      .eq('id', existing.id)
      .select('id, code, phone, full_name, first_name, last_name')
      .single();
    if (error) throw error;
    return data;
  }

  if (!wantedCode) throw new Error('MISSING_CLIENT_CODE');

  const row = {
    phone,
    code: wantedCode,
    full_name: nm.full_name,
    first_name: nm.first_name,
    last_name: nm.last_name,
    photo_url: photoUrl || null,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from('clients')
    .insert(row)
    .select('id, code, phone, full_name, first_name, last_name')
    .single();
  if (error) throw error;
  return data;
}

export async function saveOrderToDb(order, source = 'PRANIMI') {
  // orders: code, code_n, status, client_name, client_phone, data, total, paid

  const code = normCode(order?.client?.code ?? order?.code);
  if (!code) throw new Error('MISSING_ORDER_CODE');

  // OFFLINE: create locally + queue ops, mos prit rrjetin
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    const clientPhone = normPhone(order?.client?.phone ?? order?.client_phone);
    const clientName = normName(order?.client?.name ?? order?.client_name);
    const status = String(order?.status || 'pastrim').toLowerCase();

    // best-effort local client cache + queue
    try {
      await upsertClientFromOrder({ client: { code: String(code), phone: clientPhone, name: clientName, photoUrl: order?.client?.photoUrl || null } });
    } catch {}

    const payload = attachAudit({ ...(order || {}) }, source);
    const insertRow = {
      code,
      code_n: code,
      status,
      client_name: clientName || null,
      client_phone: clientPhone || null,
      data: payload,
      total: payload?.pay?.euro ?? 0,
      paid: payload?.pay?.paid ?? 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    // local order id
    const localId = 'local:' + uuidv4();

    // store locally for lists
    await saveOrderLocal({ id: localId, ...insertRow });

    // update orders cache
    try {
      const cur = JSON.parse(localStorage.getItem(LS_ORDERS_CACHE) || '[]');
      const arr = Array.isArray(cur) ? cur : [];
      arr.unshift({ id: localId, code, code_n: code, status, client_name: clientName || null, client_phone: clientPhone || null, created_at: insertRow.created_at, updated_at: insertRow.updated_at, _local: true });
      localStorage.setItem(LS_ORDERS_CACHE, JSON.stringify(arr));
    } catch {}

    // queue op: insert order later
    await pushOp({
      op_id: uuidv4(),
      type: "insert_order",
      entity: "order",
      entity_id: localId,
      payload: insertRow,
      created_at: Date.now(),
    });

    return { order_id: localId, client_id: clientPhone ? ('local:' + clientPhone) : null, offline: true };
  }


  const clientPhone = normPhone(order?.client?.phone ?? order?.client_phone);
  const clientName = normName(order?.client?.name ?? order?.client_name);
  const status = String(order?.status || 'pastrim').toLowerCase();

  // ensure client exists (best effort)
  let clientId = null;
  try {
    const c = await upsertClientFromOrder({
      client: { code: String(code), phone: clientPhone, name: clientName, photoUrl: order?.client?.photoUrl || null },
    });
    clientId = c?.id || null;
  } catch (e) {
    // ignore
  }

  // ✅ Always keep full payload + audit
  const payload = attachAudit({ ...(order || {}) }, source);

  const insertRow = {
    code,
    code_n: code,
    status,
    client_name: clientName || null,
    client_phone: clientPhone || null,
    data: payload,
    total: payload?.pay?.euro ?? 0,
    paid: payload?.pay?.paid ?? 0,
  };

  const { data: ins, error: e1 } = await supabase
    .from('orders')
    .insert(insertRow)
    .select('id, code, status, created_at')
    .single();

  if (e1) {
    // ❌ IMPORTANT: do NOT "reactivate/update" on duplicate.
    // We want a NEW ORDER every time. If DB has UNIQUE(code), user must remove that unique constraint.
    throw e1;
  }

  return { order_id: ins?.id, client_id: clientId };
}

export async function updateOrderInDb(dbId, patch) {
  if (!dbId) return { ok: false, skipped: true };
  const idNum = Number(dbId);
  if (!Number.isFinite(idNum)) return { ok: false, skipped: true };

  const row = { ...patch, updated_at: new Date().toISOString() };
  const { error } = await supabase.from('orders').update(row).eq('id', idNum);
  if (error) throw error;
  return { ok: true };
}

export async function fetchOrdersFromDb(limit = 5000) {
  const { data, error } = await supabase
    .from('orders')
    .select('id, code, code_n, status, client_name, client_phone, created_at, updated_at')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

export async function fetchClientsFromDb(limit = 5000) {
  const { data, error } = await supabase
    .from('clients')
    .select('id, code, full_name, first_name, last_name, phone, photo_url, created_at, updated_at')
    .order('updated_at', { ascending: false })
    .limit(limit);

  if (error) throw error;
  return Array.isArray(data) ? data : [];
}export async function fetchOrdersFromDb(limit = 5000) {
  // OFFLINE: return cached + local unsynced
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    let cached = [];
    try { cached = JSON.parse(localStorage.getItem(LS_ORDERS_CACHE) || '[]'); } catch {}
    let local = [];
    try {
      const all = await getAllOrdersLocal();
      local = (all || []).map((o) => ({
        id: o.id,
        code: o.code,
        code_n: o.code_n,
        status: o.status,
        client_name: o.client_name || o?.data?.client?.name || null,
        client_phone: o.client_phone || o?.data?.client?.phone || null,
        created_at: o.created_at || null,
        updated_at: o.updated_at || null,
        _local: true,
      }));
    } catch {}
    // merge by id
    const map = new Map();
    for (const r of (cached || [])) map.set(String(r.id), r);
    for (const r of (local || [])) map.set(String(r.id), r);
    return Array.from(map.values()).slice(0, limit);
  }

  const { data, error } = await supabase
    .from('orders')
    .select('id, code, code_n, status, client_name, client_phone, created_at, updated_at')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw error;

  // update cache
  try { localStorage.setItem(LS_ORDERS_CACHE, JSON.stringify(Array.isArray(data) ? data : [])); } catch {}
  return Array.isArray(data) ? data : [];
}

export async function fetchClientsFromDb(limit = 5000) {
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    try {
      const cached = JSON.parse(localStorage.getItem(LS_CLIENTS_CACHE) || '[]');
      return Array.isArray(cached) ? cached.slice(0, limit) : [];
    } catch {
      return [];
    }
  }

  const { data, error } = await supabase
    .from('clients')
    .select('id, code, full_name, first_name, last_name, phone, photo_url, created_at, updated_at')
    .order('updated_at', { ascending: false })
    .limit(limit);

  if (error) throw error;
  try { localStorage.setItem(LS_CLIENTS_CACHE, JSON.stringify(Array.isArray(data) ? data : [])); } catch {}
  return Array.isArray(data) ? data : [];
}
