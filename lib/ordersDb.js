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

  const row = {
    first_name: name || null,
    last_name: null,
    phone,
    updated_at: new Date().toISOString(),
  };

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

  const { data: ins, error: e2 } = await supabase
    .from('clients')
    .insert({ ...row, created_at: new Date().toISOString() })
    .select('id')
    .single();

  if (e2) throw e2;
  return { id: ins?.id, code, phone, name: name || null };
}

export async function saveOrderToDb(order) {
  const code = normCode(order?.client?.code ?? order?.code);
  if (!code) throw new Error('MISSING_ORDER_CODE');

  const clientPhone = normPhone(order?.client?.phone ?? order?.client_phone);
  const clientName = normName(order?.client?.name ?? order?.client_name);

  // Statusi fillestar per cdo porosi te re ose te reaktivizuar
  const status = 'pastrim'; 
  const total = Number(order?.pay?.euro ?? order?.total ?? 0) || 0;
  const clientPhotoUrl = order?.client?.photoUrl || order?.client?.photo || order?.client_photo_url || null;

  let clientId = null;
  try {
    const c = await upsertClientFromOrder({
      client: { code: String(code), phone: clientPhone, name: clientName },
    });
    clientId = c?.id || null;
  } catch (err) {
    console.error("Client upsert failed:", err);
  }

  const payload = { ...order };

  // --- REAKTIVIZIMI (NESE KODI EKZISTON) ---
  const { data: existing, error: e0 } = await supabase
    .from('orders')
    .select('id')
    .eq('code', code)
    .maybeSingle();
  
  if (e0) throw e0;

  if (existing?.id) {
    const freshTs = Date.now();
    
    // Pastrojmë objektin JSON që të mos ketë mbetje nga hera e kaluar
    const freshData = {
      ...(payload || {}),
      status: 'pastrim',
      ts: freshTs,
      readyTs: null,
      pickedTs: null,
      deliveredAt: null,
      pickedUpAt: null,
      returnInfo: { active: false },
      pay: { euro: total, paid: 0 } // Resetojmë pagesën brenda JSON
    };

    const { error: eUp } = await supabase
      .from('orders')
      .update({
        client_id: clientId,
        status: 'pastrim',
        client_phone: clientPhone || null,
        total: total,
        paid: 0,             // E bëjmë pagesën 0 që të dalë si borxh i ri
        picked_up_at: null,  // Fshijmë datën e dorëzimit të vjetër
        ready_at: null,      // Fshijmë datën kur ka qenë gati herën e kaluar
        client_photo_url: clientPhotoUrl,
        data: freshData,
        updated_at: new Date().toISOString(),
      })
      .eq('id', existing.id);

    if (eUp) throw eUp;
    return { order_id: existing.id, client_id: clientId };
  }

  // --- POROSI E RE (NESE KODI NUK EKZISTON) ---
  const insertRow = {
    code,
    client_id: clientId,
    status: 'pastrim',
    client_phone: clientPhone || null,
    total,
    paid: 0,
    client_photo_url: clientPhotoUrl,
    data: { ...payload, status: 'pastrim' },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const { data: ins, error: e1 } = await supabase
    .from('orders')
    .insert(insertRow)
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
