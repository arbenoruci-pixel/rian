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

async function getNextOrderCode(maxRetries = 6) {
  // Next order code (unique numeric). Client code is stored separately.
  // We compute MAX(code)+1 and retry on conflict.
  let attempt = 0;
  while (attempt < maxRetries) {
    attempt += 1;
    const { data: rows, error: e0 } = await supabase
      .from('orders')
      .select('code')
      .order('code', { ascending: false })
      .limit(1);
    if (e0) throw e0;
    const maxCode = Array.isArray(rows) && rows.length ? normCode(rows[0]?.code) : 0;
    const next = (maxCode || 0) + 1;
    if (next > 0) return next;
  }
  throw new Error('NEXT_ORDER_CODE_FAILED');
}

export async function upsertClientFromOrder(order) {
  // Client has a permanent numeric code (client_code). Do NOT change it.
  const code = normCode(order?.client?.code ?? order?.client_code);
  const phone = normPhone(order?.client?.phone ?? order?.client_phone ?? order?.phone);
  const name = normName(order?.client?.name ?? order?.client_name ?? order?.name);

  if (!code) throw new Error('MISSING_CLIENT_CODE');
  if (!phone) throw new Error('MISSING_CLIENT_PHONE');

  // clients schema: id(uuid), first_name, last_name, phone, photo_url, created_at, updated_at
  // We store full name in first_name and keep last_name empty (minimal change).
  const row = {
    code,
    first_name: name || null,
    last_name: null,
    phone,
    updated_at: new Date().toISOString(),
  };

  // Prefer upsert by code (this is the permanent key).
  const { data: byCode, error: e0 } = await supabase
    .from('clients')
    .select('id, code, phone')
    .eq('code', code)
    .maybeSingle();

  if (e0) throw e0;

  if (byCode?.id) {
    const { error: e1 } = await supabase.from('clients').update(row).eq('id', byCode.id);
    if (e1) throw e1;
    return { id: byCode.id, code, phone, name: name || null };
  }

  // Fallback: if same phone exists, update it and attach code.
  const { data: byPhone, error: ePhone } = await supabase
    .from('clients')
    .select('id, code, phone')
    .eq('phone', phone)
    .maybeSingle();
  if (ePhone) throw ePhone;

  if (byPhone?.id) {
    const { error: e1 } = await supabase.from('clients').update(row).eq('id', byPhone.id);
    if (e1) throw e1;
    return { id: byPhone.id, code, phone, name: name || null };
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
  // IMPORTANT
  // - order.client.code (or order.client_code) = PERMANENT CLIENT CODE
  // - orders.code = ORDER CODE (NEW for every visit)
  const clientCode = normCode(order?.client?.code ?? order?.client_code);
  if (!clientCode) throw new Error('MISSING_CLIENT_CODE');

  const clientCode = normCode(order?.client?.code ?? order?.client_code);
  if (!clientCode) throw new Error('MISSING_CLIENT_CODE');

  const clientPhone = normPhone(order?.client?.phone ?? order?.client_phone);
  const clientName = normName(order?.client?.name ?? order?.client_name);

  // Status contract: every new order (including a returning client) starts at PASTRIM.
  const status = 'pastrim';
  const total = Number(order?.pay?.euro ?? order?.total ?? 0) || 0;
  const paid = 0;
  const clientPhotoUrl = order?.client?.photoUrl || order?.client?.photo || order?.client_photo_url || null;

  // Ensure client row exists
  let clientId = null;
  try {
    const c = await upsertClientFromOrder({
      client: { code: String(clientCode), phone: clientPhone, name: clientName },
    });
    clientId = c?.id || null;
  } catch {
    // do not block order save if client upsert fails; backup will still include order
  }

  // Always create a NEW order row (even when the client returns).
  // This is what makes the order show in PASTRIMI again without overwriting old history.
  const orderCode = await getNextOrderCode();

  const freshTs = Date.now();
  const payload = {
    ...(order || {}),
    status: 'pastrim',
    ts: freshTs,
    readyTs: null,
    pickedTs: null,
    deliveredAt: null,
    pickedUpAt: null,
    returnInfo: { active: false },
    client: {
      ...(order?.client || {}),
      code: String(clientCode),
      phone: clientPhone || (order?.client?.phone ?? null),
      name: clientName || (order?.client?.name ?? null),
    },
    // Helpful explicit fields
    client_code: clientCode,
    code: orderCode,
  };

  const insertRow = {
    code: orderCode,
    client_code: clientCode,
    client_id: clientId,
    status,
    client_phone: clientPhone || null,
    total,
    paid,
    picked_up_at: null,
    ready_at: null,
    client_photo_url: clientPhotoUrl,
    data: payload,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const { data: ins, error: e1 } = await supabase.from('orders').insert(insertRow).select('id').single();

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
