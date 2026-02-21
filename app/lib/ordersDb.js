// lib/ordersDb.js
// DB helpers for TEPIHA (clients + orders)
// Minimal, targeted: add audit + stop "reactivate on duplicate" behavior.

import { supabase } from '@/lib/supabaseClient';


// ---- CLIENT CACHE (PHONE -> CLIENT) ----
const LS_CLIENT_BY_PHONE = 'tepiha_clients_by_phone_v1';
function normPhone(p) {
  return String(p || '').replace(/\s+/g, '').replace(/[^0-9+]/g, '');
}
function readClientByPhone(phone) {
  try {
    const key = normPhone(phone);
    if (!key) return null;
    const map = JSON.parse(localStorage.getItem(LS_CLIENT_BY_PHONE) || '{}');
    return map && typeof map === 'object' ? (map[key] || null) : null;
  } catch {
    return null;
  }
}
function writeClientByPhone(client) {
  try {
    if (!client) return;
    const key = normPhone(client.phone);
    if (!key) return;
    const map = JSON.parse(localStorage.getItem(LS_CLIENT_BY_PHONE) || '{}');
    map[key] = { id: client.id || null, code: client.code || null, phone: key, full_name: client.full_name || null, first_name: client.first_name || null, last_name: client.last_name || null };
    localStorage.setItem(LS_CLIENT_BY_PHONE, JSON.stringify(map));
  } catch {}
}
// ---------------------------------------





function normName(n) {
  return String(n || '').trim();
}

const ALLOWED_STATUS = new Set(['pranim','pastrim','gati','dorzim','transport']);
function normalizeStatus(s) {
  const raw = String(s || '').trim().toLowerCase();
  const map = {
    pranimi: 'pranim',
    pastrimi: 'pastrim',
    dorzimi: 'dorzim',
    marrje: 'dorzim',
    pickup: 'dorzim',
  };
  const v = map[raw] || raw;
  return ALLOWED_STATUS.has(v) ? v : 'pastrim';
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
  if (!wantedCode) throw new Error('MISSING_CLIENT_CODE');

  const nm = splitName(rawName);

  // Always write BOTH name + full_name so UI never shows blank names.
  const row = {
    phone,
    code: wantedCode,
    name: nm.full_name || null,
    full_name: nm.full_name || null,
    first_name: nm.first_name || null,
    last_name: nm.last_name || null,
    photo_url: photoUrl || null,
    updated_at: new Date().toISOString(),
  };

  // ✅ Robust path: UPSERT by phone (avoids 23505 even when SELECT is blocked by RLS)
  // Try with RETURNING; if SELECT policy blocks returning, fall back to cache-only return.
  try {
    const { data, error } = await supabase
      .from('clients')
      .upsert(row, { onConflict: 'phone' })
      .select('id, code, phone, name, full_name, first_name, last_name')
      .maybeSingle();

    if (!error && data) {
      try { if (typeof window !== 'undefined') writeClientByPhone(data); } catch {}
      return data;
    }
  } catch {}

  // If RETURNING/select is blocked, still attempt an upsert without select.
  try {
    const { error } = await supabase
      .from('clients')
      .upsert(row, { onConflict: 'phone' });
    if (error) throw error;
  } catch (e) {
    // If SELECT is blocked we might still see dup errors in edge cases; do not fail hard.
    const cached = (typeof window !== 'undefined') ? readClientByPhone(phone) : null;
    if (cached?.code) return cached;
    return { id: null, code: wantedCode, phone, name: nm.full_name || null, full_name: nm.full_name || null, first_name: nm.first_name || null, last_name: nm.last_name || null };
  }

  // Try re-select (may still be blocked); else return cached/minimal.
  try {
    const { data: again } = await supabase
      .from('clients')
      .select('id, code, phone, name, full_name, first_name, last_name')
      .eq('phone', phone)
      .maybeSingle();
    if (again) {
      try { if (typeof window !== 'undefined') writeClientByPhone(again); } catch {}
      return again;
    }
  } catch {}

  const cached = (typeof window !== 'undefined') ? readClientByPhone(phone) : null;
  if (cached?.code) return cached;

  return { id: null, code: wantedCode, phone, name: nm.full_name || null, full_name: nm.full_name || null, first_name: nm.first_name || null, last_name: nm.last_name || null };
}

export async function saveOrderToDb(order, source = 'PRANIMI') {
  // orders: code, code_n, status, client_name, client_phone, data, total, paid

  const code = normCode(order?.client?.code ?? order?.code);
  if (!code) throw new Error('MISSING_ORDER_CODE');

  const clientPhone = normPhone(order?.client?.phone ?? order?.client_phone);
  const clientName = normName(order?.client?.name ?? order?.client_name);
  const status = normalizeStatus(order?.status || order?.data?.status || 'pastrim');

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
}
