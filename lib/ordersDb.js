// lib/ordersDb.js
// DB helpers for TEPIHA (clients + orders)
// Fixed: Using .upsert() to prevent "unique constraint" errors on phone numbers.

import { supabase } from '@/lib/supabaseClient';
import { saveOrderLocal, getAllOrdersLocal, saveClientLocal, getAllClientsLocal, pushOp } from '@/lib/offlineStore';

// ---- CLIENT CACHE (PHONE -> CLIENT) ----
const LS_CLIENT_BY_PHONE = 'tepiha_clients_by_phone_v1';

function isOnline(){
  try { return typeof navigator === 'undefined' ? true : !!navigator.onLine; } catch { return true; }
}

function normPhone(p) {
  let s = String(p || '').trim().replace(/\s+/g, '');
  if (s.startsWith('00')) s = '+' + s.slice(2);
  s = s.replace(/[^0-9+]/g, '');
  if (s.includes('+')) {
    s = (s.startsWith('+') ? '+' : '') + s.replace(/\+/g, '');
  }
  if (s.startsWith('+3830')) s = '+383' + s.slice(5);
  return s;
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
    map[key] = { 
      id: client.id || null, 
      code: client.code || null, 
      phone: key, 
      full_name: client.full_name || null, 
      first_name: client.first_name || null, 
      last_name: client.last_name || null 
    };
    localStorage.setItem(LS_CLIENT_BY_PHONE, JSON.stringify(map));
  } catch {}
}

// ---- HELPER FUNCTIONS ----
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
  p._audit.created_by_name = p._audit.created_by_name || actor?.name || 'UNKNOWN';
  p._audit.source = source;
  p._audit.last_at = now;
  return p;
}

// ---- MAIN FUNCTIONS ----

export async function upsertClientFromOrder(order) {
  // OFFLINE FIRST:
  // If no network, save locally + queue op for sync, then return local client.
  if (!isOnline()) {
    const phone = normPhone(order?.phone ?? order?.client_phone ?? order?.client?.phone);
    const name = normName(order?.name ?? order?.client_name ?? order?.client?.name);
    const code = normCode(order?.code ?? order?.client?.code);
    const localId = phone ? `local_client_${phone}` : `local_client_${Date.now()}`;

    const localClient = {
      id: localId,
      phone: phone || null,
      full_name: name || null,
      code: code || null,
      updated_at: new Date().toISOString(),
      _local: true,
    };

    try { await saveClientLocal(localClient); } catch {}
    try {
      await pushOp({
        op_id: `op_${Date.now()}_${Math.random().toString(16).slice(2)}`,
        type: "upsert_client",
        payload: {
          phone: phone || null,
          full_name: name || null,
          code: code || null,
          updated_at: new Date().toISOString(),
        },
        created_at: Date.now(),
      });
    } catch {}

    return localClient;
  }


  const phone = normPhone(order?.client?.phone ?? order?.client_phone ?? order?.phone);
  const rawName = normName(order?.client?.name ?? order?.client_name ?? order?.name);
  const wantedCode = normCode(order?.client?.code ?? order?.code ?? order?.client_code);

  if (!phone) throw new Error('MISSING_CLIENT_PHONE');

  const nm = splitName(rawName);

  // Përgatitja e rreshtit për klientin
  const row = {
    phone,
    full_name: nm.full_name,
    first_name: nm.first_name,
    last_name: nm.last_name,
    photo_url: order?.client?.photoUrl || null,
    updated_at: new Date().toISOString(),
  };

  // Vetëm nese eshte i ri i japim kod, nese ekziston nuk e prekim kodin e vjeter
  if (wantedCode) {
    row.code = wantedCode;
  }

  /* ZGJIDHJA: Përdorim .upsert() me ignoreDuplicates: false.
     Kjo bën që nëse numri i telefonit ekziston, ai nuk jep Error, 
     por vetëm e përditëson emrin e klientit.
  */
  const { data, error } = await supabase
    .from('clients')
    .upsert(row, { onConflict: 'phone' })
    .select('id, code, phone, full_name, first_name, last_name')
    .single();

  if (error) {
    console.error("UPSERT_CLIENT_ERROR:", error);
    throw error;
  }

  if (typeof window !== 'undefined') writeClientByPhone(data);
  return data;
}

export async function saveOrderToDb(order, source = 'PRANIMI') {
  const orderCode = normCode(order?.client?.code ?? order?.code);
  if (!orderCode) throw new Error('MISSING_ORDER_CODE');

  const clientPhone = normPhone(order?.client?.phone ?? order?.client_phone);
  const clientName = normName(order?.client?.name ?? order?.client_name);
  const status = normalizeStatus(order?.status || order?.data?.status || 'pastrim');

  // Ensure we always have a deterministic id for offline upsert
  const localOrderId = String(order?.id || order?.oid || order?.local_id || '').trim() || `order_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  order = { ...(order||{}), id: localOrderId };

  let clientId = null;
  let clientCodeFinal = null;

  // 1) Client upsert (offline-safe)
  try {
    const c = await upsertClientFromOrder({
      phone: clientPhone,
      name: clientName,
      code: orderCode,
    });
    clientId = c?.id || null;
    clientCodeFinal = c?.code || null;
  } catch (e) {
    console.warn("[ordersDb] Client link failed, continuing with order only", e?.message || e);
  }

  const payload = attachAudit({ ...(order || {}) }, source);

  const insertRow = {
    code: orderCode,
    code_n: orderCode,
    status,
    client_name: clientName || null,
    client_phone: clientPhone || null,
    data: payload,
    total: (() => {
      const p = payload || {};
      const o = (p.data && p.data.data && p.data.data.data) || (p.data && p.data.data) || p.data || p;
      const oData = o?.data || {};
      const pay = o?.pay || oData?.pay || {};
      return Number(o?.total ?? oData?.total ?? pay?.euro ?? pay?.total ?? 0) || 0;
    })(),
    paid: (() => {
      const p = payload || {};
      const o = (p.data && p.data.data && p.data.data.data) || (p.data && p.data.data) || p.data || p;
      const oData = o?.data || {};
      const pay = o?.pay || oData?.pay || {};
      return Number(o?.paid ?? oData?.paid ?? pay?.paid ?? 0) || 0;
    })(),
    client_id: clientId,
    client_code: clientCodeFinal,
    updated_at: new Date().toISOString()
  };

  // OFFLINE-FIRST:
  // If offline, save locally + queue op, return immediately so UI doesn't "lose" the order.
  if (!isOnline()) {
    try { await saveOrderLocal({ ...insertRow, _local:true, _synced:false, created_at: insertRow.updated_at }); } catch {}
    try {
      // IMPORTANT: syncEngine understands UPSERT_ORDER ops.
      // Older builds used "insert_order" which never synced.
      await pushOp({
        op_id: `op_${Date.now()}_${Math.random().toString(16).slice(2)}`,
        type: "insert_order",
        payload: insertRow,
        created_at: Date.now(),
      });
    } catch {}
    return { order_id: localOrderId, client_id: clientId, _offline: true };
  }

  // ONLINE PATH (with safe fallback to offline queue if it fails)
  try {
    // Use UPSERT for idempotency (retries / Safari double-submit / flaky mobile networks)
    const { data: ins, error: e1 } = await supabase
      .from('orders')
      .upsert(insertRow, { onConflict: 'code' })
      .select('id, code')
      .single();

    if (e1) throw e1;

    // mirror as synced locally so lists are stable even during transient network issues
    try { await saveOrderLocal({ ...insertRow, id: ins?.id || localOrderId, _local:false, _synced:true, created_at: insertRow.updated_at }); } catch {}

    return { order_id: ins?.id, client_id: clientId };
  } catch (e) {
    // Fallback: treat as offline, queue for sync
    console.warn("[ordersDb] insert failed, queueing offline op", e?.message || e);
    try {
      localStorage.setItem(
        'tepiha_last_db_error',
        JSON.stringify({ ts: Date.now(), where: 'saveOrderToDb', message: String(e?.message || e) })
      );
    } catch {}
    try { await saveOrderLocal({ ...insertRow, _local:true, _synced:false, created_at: insertRow.updated_at }); } catch {}
    try {
      // IMPORTANT: syncEngine understands UPSERT_ORDER ops.
      // Older builds used "insert_order" which never synced.
      await pushOp({
        op_id: `op_${Date.now()}_${Math.random().toString(16).slice(2)}`,
        type: "insert_order",
        payload: insertRow,
        created_at: Date.now(),
      });
    } catch {}
    return { order_id: localOrderId, client_id: clientId, _offline: true };
  }
}

export async function updateOrderInDb(dbId, patch) {
  if (!dbId) return { ok: false };
  const { error } = await supabase
    .from('orders')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', dbId);
  if (error) throw error;
  return { ok: true };
}

export async function fetchOrdersFromDb(limit = 5000) {
  // Always merge local unsynced orders so they don't "disappear" when the device comes online.
  const mergeLocal = async (remoteRows = []) => {
    const map = new Map();
    (remoteRows || []).forEach(r => {
      if (!r) return;
      const key = String(r.code ?? r.code_n ?? r.id ?? '');
      if (key) map.set(key, r);
    });

    // IndexedDB orders
    try {
      const local = await getAllOrdersLocal();
      (local || []).forEach((o) => {
        if (!o) return;
        const key = String(o.code ?? o.code_n ?? o.id ?? '');
        if (!key) return;
        const already = map.get(key);
        // keep local if missing remotely OR not yet synced
        if (!already || o._synced === false || o._local) {
          map.set(key, {
            id: o.id,
            code: o.code,
            code_n: o.code_n ?? o.code,
            status: o.status || 'pastrim',
            client_name: o.client_name || o.data?.client?.name || null,
            client_phone: o.client_phone || o.data?.client?.phone || null,
            total: Number(o.total ?? o.data?.total ?? o.data?.pay?.euro ?? 0) || 0,
            paid: Number(o.paid ?? o.data?.pay?.paid ?? 0) || 0,
            data: o.data || null,
            created_at: o.created_at || o.updated_at || null,
            updated_at: o.updated_at || null,
            _local: true,
            _synced: !!o._synced,
          });
        }
      });
    } catch {}

    // Legacy localStorage offline queue (in case older builds used it)
    try {
      const raw = localStorage.getItem("tepiha_offline_queue_v1");
      const arr = raw ? JSON.parse(raw) : [];
      if (Array.isArray(arr)) {
        arr.forEach((it) => {
          const p = it?.payload || it;
          const key = String(p?.id || p?.oid || p?.code || '');
          if (!key) return;
          if (!map.has(key)) {
            map.set(key, {
              id: p?.id || p?.oid || key,
              code: p?.code,
              code_n: p?.code_n ?? p?.code,
              status: p?.status || 'pastrim',
              client_name: p?.client_name || p?.data?.client?.name || p?.client_name || null,
              client_phone: p?.client_phone || p?.data?.client?.phone || null,
              total: Number(p?.total ?? p?.data?.total ?? p?.pay?.euro ?? 0) || 0,
              paid: Number(p?.paid ?? p?.pay?.paid ?? 0) || 0,
              data: p?.data || null,
              created_at: p?.created_at || p?.updated_at || null,
              updated_at: p?.updated_at || null,
              _local: true,
              _synced: false,
            });
          }
        });
      }
    } catch {}

    const out = Array.from(map.values());
    out.sort((a,b)=> String(b.created_at||b.updated_at||'').localeCompare(String(a.created_at||a.updated_at||'')));
    return out;
  };

  try {
    const { data, error } = await supabase
      .from('orders')
      .select('id, code, code_n, status, client_name, client_phone, total, paid, data, created_at, updated_at')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    return await mergeLocal(data || []);
  } catch (e) {
    // OFFLINE fallback (only local)
    return await mergeLocal([]);
  }
}

export async function fetchClientsFromDb(limit = 5000) {
  try {
    const { data, error } = await supabase
      .from('clients')
      .select('*')
      .order('updated_at', { ascending: false })
      .limit(limit);
    if (error) throw error;

    // mirror to offline store
    try {
      for (const c of data || []) {
        await saveClientLocal({ ...c, _local: false });
      }
    } catch {}

    return data || [];
  } catch (e) {
    // OFFLINE fallback (IndexedDB)
    try {
      const local = await getAllClientsLocal();
      const rows = (local || [])
        .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
      return rows.slice(0, limit);
    } catch {
      return [];
    }
  }
}
