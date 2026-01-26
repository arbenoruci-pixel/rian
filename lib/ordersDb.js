// lib/ordersDb.js
// Minimal DB helpers for TEPIHA (clients + orders)
// Keeps existing UI/flow; adds DB writes so FLETORJA backups are reliable.

import { supabase } from '@/lib/supabaseClient';

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
  return Number.isFinite(n) ? n : null;
}

export async function upsertClientFromOrder(order) {
  const code = normCode(order?.client?.code ?? order?.code ?? order?.client_code);
  const phone = normPhone(order?.client?.phone ?? order?.client_phone ?? order?.phone);
  const name = normName(order?.client?.name ?? order?.client_name ?? order?.name);

  if (!code) throw new Error('MISSING_CLIENT_CODE');
  if (!phone) throw new Error('MISSING_CLIENT_PHONE');

  // clients schema: id(uuid), first_name, last_name, phone, photo_url, created_at, updated_at
  // We store full name in first_name and keep last_name empty (minimal change).
  const row = {
    first_name: name || null,
    last_name: null,
    phone,
    updated_at: new Date().toISOString(),
  };

  // Upsert by phone first (phone is stable), then ensure code consistency.
  // If your DB enforces unique(code), it will still be safe as long as code is unique.
  const { data: existing, error: e0 } = await supabase
    .from('clients')
    .select('id, phone')
    .eq('phone', phone)
    .maybeSingle();

  if (e0) throw e0;

  if (existing?.id) {
    const { error: e1 } = await supabase.from('clients').update(row).eq('id', existing.id);
    if (e1) throw e1;
    return { id: existing.id, code, phone, name: name || null };
  }

  // Insert new client
  const { data: ins, error: e2 } = await supabase
    .from('clients')
    .insert({ ...row, created_at: new Date().toISOString() })
    .select('id')
    .single();

  if (e2) throw e2;
  return { id: ins?.id, code, phone, name: name || null };
}

export async function saveOrderToDb(order) {
  // orders schema in your DB (from your screenshot):
  // id(bigint), code(int), client_id(uuid), status(text), client_phone(text), total(numeric), paid(numeric), picked_up_at(timestamptz), client_photo_url(text), data(jsonb), created_at, updated_at
  const code = normCode(order?.client?.code ?? order?.code);
  if (!code) throw new Error('MISSING_ORDER_CODE');

  const clientPhone = normPhone(order?.client?.phone ?? order?.client_phone);
  const clientName = normName(order?.client?.name ?? order?.client_name);

  // STATUS CONTRACT
  // - Orders saved from PRANIMI must enter the workflow at 'pastrim'.
  // - When a code already exists (reactivation), we must NOT keep the old terminal status.
  const allowed = new Set(['pranim', 'pastrim', 'gati', 'dorzim']);
  const rawStatus = String(order?.status || '').toLowerCase();
  const status = allowed.has(rawStatus) ? rawStatus : 'pastrim';
  const total = Number(order?.pay?.euro ?? order?.total ?? 0) || 0;
  const paid = Number(order?.pay?.paid ?? order?.paid ?? 0) || 0;
  const clientPhotoUrl = order?.client?.photoUrl || order?.client?.photo || order?.client_photo_url || null;

  // Ensure client row exists
  let clientId = null;
  try {
    const c = await upsertClientFromOrder({
      client: { code: String(code), phone: clientPhone, name: clientName },
    });
    clientId = c?.id || null;
  } catch {
    // do not block order save if client upsert fails; backup will still include order
  }

  const payload = { ...order };

  const insertRow = {
    code,
    client_id: clientId,
    status,
    client_phone: clientPhone || null,
    total,
    paid,
    client_photo_url: clientPhotoUrl,
    data: payload,
  };

  // IMPORTANT:
  // If an order with the same numeric code already exists (reactivating an old client/order),
  // do NOT fail with duplicate key. Instead, update the existing row in-place so it shows up
  // again in PASTRIMI/GATI lists.
  const { data: existing, error: e0 } = await supabase
    .from('orders')
    .select('id')
    .eq('code', code)
    .maybeSingle();
  if (e0) throw e0;

  if (existing?.id) {
    const freshTs = Date.now();
    const freshData = {
      ...(payload || {}),
      status: 'pastrim',
      ts: freshTs,
      readyTs: null,
      pickedTs: null,
      deliveredAt: null,
      pickedUpAt: null,
      returnInfo: { active: false },
    };

    const { error: eUp } = await supabase
      .from('orders')
      .update({
        ...insertRow,
        status: 'pastrim',
        paid: 0,
        picked_up_at: null,
        ready_at: null,
        data: freshData,
        updated_at: new Date().toISOString(),
      })
      .eq('id', existing.id);
    if (eUp) throw eUp;
    return { order_id: existing.id, client_id: clientId };
  }

  const { data: ins, error: e1 } = await supabase
    .from('orders')
    .insert({
      ...insertRow,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .select('id')
    .single();

  if (e1) throw e1;
  return { order_id: ins?.id, client_id: clientId };
}

export async function updateOrderInDb(dbId, patch) {
  if (!dbId) return { ok: false, skipped: true };
  const idNum = Number(dbId);
  if (!Number.isFinite(idNum)) return { ok: false, skipped: true };

  const row = { ...patch };
  row.updated_at = new Date().toISOString();

  const { error } = await supabase.from('orders').update(row).eq('id', idNum);
  if (error) throw error;
  return { ok: true };
}

export async function fetchOrdersFromDb(limit = 5000) {
  const { data, error } = await supabase
    .from('orders')
    .select('id, code, status, client_phone, total, paid, picked_up_at, client_photo_url, data, created_at, updated_at')
    .order('id', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

export async function fetchClientsFromDb(limit = 5000) {
  const { data, error } = await supabase
    .from('clients')
    .select('id, code, first_name, last_name, phone, photo_url, created_at, updated_at')
    .order('updated_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return Array.isArray(data) ? data : [];
}
