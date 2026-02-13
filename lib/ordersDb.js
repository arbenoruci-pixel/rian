// lib/ordersDb.js
// TEPIHA — DB helpers (clients + orders) with OFFLINE-FIRST local fallback.
// Goal: never block UI when offline; store locally + queue ops; sync layer can flush later.

import { supabase } from '@/lib/supabaseClient';

const LS_ORDERS_CACHE = 'tepiha_orders_cache_v1';
const LS_CLIENTS_CACHE = 'tepiha_clients_cache_v1';

// Local offline store (per device). Keep it simple + stable for iOS.
const LS_ORDERS_LOCAL = 'tepiha_orders_local_v1';
const LS_CLIENTS_LOCAL = 'tepiha_clients_local_v1';
const LS_SYNC_QUEUE = 'tepiha_sync_queue_v1';

function nowISO() {
  return new Date().toISOString();
}

function safeJsonParse(v, fallback) {
  try { return JSON.parse(v); } catch { return fallback; }
}

function getLocalArray(key) {
  return safeJsonParse(localStorage.getItem(key) || '[]', []);
}

function setLocalArray(key, arr) {
  try { localStorage.setItem(key, JSON.stringify(Array.isArray(arr) ? arr : [])); } catch {}
}

function upsertById(list, item) {
  const id = String(item?.id ?? '');
  if (!id) return list;
  const idx = list.findIndex((x) => String(x?.id ?? '') === id);
  if (idx >= 0) {
    const copy = list.slice();
    copy[idx] = { ...copy[idx], ...item };
    return copy;
  }
  return [item, ...list];
}

function enqueueOp(op) {
  const queue = getLocalArray(LS_SYNC_QUEUE);
  queue.push({ ...op, _queued_at: nowISO() });
  setLocalArray(LS_SYNC_QUEUE, queue);
}

function normPhone(p) {
  return String(p || '').trim().replace(/\s+/g, '');
}

function normName(n) {
  return String(n || '').trim();
}

function normCode(code) {
  const s = String(code ?? '').trim();
  const m = s.match(/(\d+)/);
  return m ? Number(m[1]) : null;
}

/**
 * OFFLINE-FIRST: Upsert client
 * - ONLINE: upsert in Supabase
 * - OFFLINE: store locally + enqueue
 */
export async function upsertClientFromOrder(order) {
  const phone = normPhone(order?.client_phone || order?.client?.phone);
  const name = normName(order?.client_name || order?.client?.name);
  const code = order?.client_code ?? null;

  const client = {
    id: order?.client_id || order?.client?.id || crypto.randomUUID(),
    code: code,
    full_name: name || null,
    phone: phone || null,
    updated_at: nowISO(),
    created_at: order?.client_created_at || nowISO(),
    _local: true,
  };

  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    const local = getLocalArray(LS_CLIENTS_LOCAL);
    const next = upsertById(local, client);
    setLocalArray(LS_CLIENTS_LOCAL, next);
    enqueueOp({ type: 'UPSERT_CLIENT', entity: 'client', entity_id: client.id, payload: client });
    return { ok: true, local: true, client };
  }

  // ONLINE
  const { data, error } = await supabase
    .from('clients')
    .upsert(
      {
        id: client.id,
        code: client.code,
        full_name: client.full_name,
        phone: client.phone,
        updated_at: client.updated_at,
      },
      { onConflict: 'id' }
    )
    .select('id, code, full_name, phone')
    .single();

  if (error) throw error;

  // update cache
  try {
    const cached = getLocalArray(LS_CLIENTS_CACHE);
    setLocalArray(LS_CLIENTS_CACHE, upsertById(cached, data));
  } catch {}

  return { ok: true, client: data };
}

/**
 * OFFLINE-FIRST: Save NEW order
 */
export async function saveOrderToDb(order) {
  const id = order?.id || crypto.randomUUID();
  const code_n = order?.code_n ?? normCode(order?.code) ?? null;
  const row = {
    id,
    code: order?.code ?? (code_n != null ? String(code_n) : null),
    code_n: code_n,
    status: order?.status || 'pastrim',
    client_name: order?.client_name || order?.client?.name || null,
    client_phone: order?.client_phone || order?.client?.phone || null,
    created_at: order?.created_at || nowISO(),
    updated_at: nowISO(),
    _local: true,
  };

  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    const local = getLocalArray(LS_ORDERS_LOCAL);
    const next = upsertById(local, row);
    setLocalArray(LS_ORDERS_LOCAL, next);
    enqueueOp({ type: 'UPSERT_ORDER', entity: 'order', entity_id: id, payload: row });
    return { ok: true, local: true, id };
  }

  const { error } = await supabase.from('orders').insert({
    id: row.id,
    code: row.code,
    code_n: row.code_n,
    status: row.status,
    client_name: row.client_name,
    client_phone: row.client_phone,
    created_at: row.created_at,
    updated_at: row.updated_at,
  });

  if (error) throw error;

  // update cache snapshot so lists (PASTRIMI) see it immediately
  try {
    const cached = getLocalArray(LS_ORDERS_CACHE);
    setLocalArray(LS_ORDERS_CACHE, upsertById(cached, { ...row, _local: false }));
  } catch {}

  return { ok: true, id };
}

/**
 * OFFLINE-FIRST: Update existing order (patch)
 */
export async function updateOrderInDb(id, patch) {
  const pid = String(id || '').trim();
  if (!pid) return { ok: false, error: 'Missing id' };

  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    const local = getLocalArray(LS_ORDERS_LOCAL);
    const next = upsertById(local, { id: pid, ...patch, updated_at: nowISO(), _local: true });
    setLocalArray(LS_ORDERS_LOCAL, next);
    enqueueOp({ type: 'PATCH_ORDER', entity: 'order', entity_id: pid, payload: patch });
    return { ok: true, local: true };
  }

  const { error } = await supabase
    .from('orders')
    .update({ ...patch, updated_at: nowISO() })
    .eq('id', pid);

  if (error) throw error;
  return { ok: true };
}

/**
 * Back-compat alias (some pages might call save+update separately)
 */
export async function updateOrderInDbCompat(id, patch) {
  return updateOrderInDb(id, patch);
}

/**
 * OFFLINE-FIRST: Fetch orders list
 * - OFFLINE: merge cached server snapshot + local unsynced
 * - ONLINE: fetch from DB and cache snapshot
 */
export async function fetchOrdersFromDb(limit = 5000) {
  // OFFLINE
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    const cached = getLocalArray(LS_ORDERS_CACHE);
    const local = getLocalArray(LS_ORDERS_LOCAL);
    const map = new Map();
    for (const r of cached) map.set(String(r.id), r);
    for (const r of local) map.set(String(r.id), r);
    return Array.from(map.values()).slice(0, limit);
  }

  const { data, error } = await supabase
    .from('orders')
    .select('id, code, code_n, status, client_name, client_phone, created_at, updated_at')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw error;

  // cache snapshot
  setLocalArray(LS_ORDERS_CACHE, Array.isArray(data) ? data : []);
  return Array.isArray(data) ? data : [];
}

/**
 * OFFLINE-FIRST: Fetch clients list
 */
export async function fetchClientsFromDb(limit = 5000) {
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    const cached = getLocalArray(LS_CLIENTS_CACHE);
    const local = getLocalArray(LS_CLIENTS_LOCAL);
    const map = new Map();
    for (const r of cached) map.set(String(r.id), r);
    for (const r of local) map.set(String(r.id), r);
    return Array.from(map.values()).slice(0, limit);
  }

  const { data, error } = await supabase
    .from('clients')
    .select('id, code, full_name, phone, created_at, updated_at')
    .order('updated_at', { ascending: false })
    .limit(limit);

  if (error) throw error;

  setLocalArray(LS_CLIENTS_CACHE, Array.isArray(data) ? data : []);
  return Array.isArray(data) ? data : [];
}

// Note: Sync flush should read LS_SYNC_QUEUE and apply ops when online.
// That engine lives elsewhere (transport/base) to avoid coupling. Queue is ready here.
