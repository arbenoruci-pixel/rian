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
  const status = String(order?.status || '').toLowerCase() || null;
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
  // Normalize timestamps in JSON when status is set back to PASTRIM (re-activation/return).
  if (status === 'pastrim') {
    payload.status = 'pastrim';
    payload.ready_at = null;
    payload.picked_up_at = null;
    payload.delivered_at = null;
    payload.readyTs = null;
    payload.pickedTs = null;
    payload.pickedUpAt = null;
    payload.deliveredAt = null;
    payload.deliveredTs = null;
    payload.pickedUpTs = null;
  }


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
  // In this app, the numeric CODE is treated as the stable client/order identifier.
  // When a client returns and you "RI-AKTIVIZON" the same code, the DB may already
  // have an order row with that same code (unique constraint).
  // In that case, we UPDATE the existing row instead of failing silently.
  const { data: ins, error: e1 } = await supabase
    .from('orders')
    .insert(insertRow)
    .select('id')
    .single();

  if (!e1) {
    const dbId = ins?.id;
    return { order_id: dbId, client_id: clientId };
  }

  // Duplicate code -> re-activate existing order
  const isDup = String(e1?.code || '') === '23505' || /duplicate key/i.test(String(e1?.message || ''));
  if (isDup) {
    const { data: existing, error: eFind } = await supabase
      .from('orders')
      .select('id')
      .eq('code', code)
      .order('id', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (eFind) throw eFind;
    const id = existing?.id;
    if (!id) throw e1;

    const patch = {
      client_id: clientId,
      status,
      client_phone: clientPhone || null,
      total,
      paid,
      client_photo_url: clientPhotoUrl,
      ready_at: null,
      picked_up_at: null,
      updated_at: new Date().toISOString(),
      data: payload,
    };

    const { error: eUp } = await supabase.from('orders').update(patch).eq('id', id);
    if (eUp) throw eUp;
    return { order_id: id, client_id: clientId, reactivated: true };
  }

  throw e1;
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

// ✅ Status-filtered fetch used by stage pages (PASTRIMI / GATI / MARRJE-SOT)
// Keeps the column list minimal and consistent across the app.
export async function fetchOrdersByStatus(status, limit = 1000) {
  const st = String(status || '').trim().toLowerCase();
  if (!st) return [];

  const { data, error } = await supabase
    .from('orders')
    .select('id, code, status, client_phone, total, paid, picked_up_at, ready_at, client_photo_url, data, created_at, updated_at')
    .eq('status', st)
    .order('updated_at', { ascending: false })
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