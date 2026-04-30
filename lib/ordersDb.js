// lib/ordersDb.js
// VERSIONI I HARMONIZUAR: Mirroring i Plotë (Pastrimi + Gati + Dorzimi) me Auto-Blacklist

import { supabase } from '@/lib/supabaseClient';
import {
  saveOrderLocal,
  getAllOrdersLocal,
  saveClientLocal,
  getAllClientsLocal,
  pushOp,
} from '@/lib/offlineStore';
import { patchBaseMasterRow, patchBaseMasterRows } from '@/lib/baseMasterCache';
import { sanitizeTransportOrderPayload } from '@/lib/transport/sanitize';

function isOnline(){
  try { return typeof navigator === 'undefined' ? true : !!navigator.onLine; } catch { return true; }
}

// 🔥 AUTO-BLACKLIST HELPERS (Varrosja e Fantazmave)
export function getGhostBlacklist() {
  if (typeof window === 'undefined') return [];
  try {
    return JSON.parse(window.localStorage.getItem('tepiha_ghost_blacklist') || '[]');
  } catch {
    return [];
  }
}

export function banishGhost(localId) {
  if (typeof window === 'undefined' || !localId) return;
  if (String(localId).match(/^[0-9]+$/)) return; // Mos blloko ID-të e vërteta nga Supabase
  try {
    const bl = getGhostBlacklist();
    if (!bl.includes(String(localId))) {
      bl.push(String(localId));
      window.localStorage.setItem('tepiha_ghost_blacklist', JSON.stringify(bl));
    }
  } catch(e) {}
}

// ---- HELPERS ----
function normCode(code) {
  const s = String(code ?? '').trim();
  const digits = s.replace(/\D+/g, '').replace(/^0+/, '');
  const n = Number(digits || 0);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function normPhone(p) {
  let s = String(p || '').trim().replace(/\s+/g, '');
  if (s.startsWith('00')) s = '+' + s.slice(2);
  s = s.replace(/[^0-9+]/g, '');
  if (s.startsWith('+3830')) s = '+383' + s.slice(5);
  return s;
}

// ---- MAIN FUNCTIONS ----

// ---------------------------------------------------------------------------
// UNIVERSAL SAVE ADAPTER
// - Base: table "orders" (default)
// - Transport: table "transport_orders" (when payload.table or opts.table)
//
// Backwards-compat:
//   saveOrderToDb(order, 'PRANIMI')  // old signature
//   saveOrderToDb(order, { table: 'transport_orders' })
//   saveOrderToDb(order, { table: 'orders', onConflict: 'local_oid' })
// ---------------------------------------------------------------------------
function parseSaveOpts(optsOrSource) {
  if (!optsOrSource) return { source: 'PRANIMI' };
  if (typeof optsOrSource === 'string') return { source: optsOrSource };
  if (typeof optsOrSource === 'object') return { ...optsOrSource };
  return { source: 'PRANIMI' };
}

function pickTableFrom(order, opts) {
  const t = String(opts?.table || order?.table || '').trim();
  if (t === 'transport_orders') return 'transport_orders';
  return 'orders';
}

function sanitizeRow(obj, table = '') {
  if (!obj || typeof obj !== 'object') return obj;
  const tableName = String(table || obj?.table || obj?._table || '').trim();
  if (tableName === 'transport_orders') {
    return sanitizeTransportOrderPayload(obj);
  }
  const out = { ...obj };
  // remove known non-schema fields that can break PostgREST schema cache
  if ('client' in out) delete out.client;
  if ('code_n' in out) delete out.code_n;
  if ('table' in out) delete out.table;
  if ('_table' in out) delete out._table;
  Object.keys(out).forEach((key) => {
    if (String(key || '').startsWith('_')) delete out[key];
  });
  return out;
}

export async function saveOrderToDb(order, optsOrSource = 'PRANIMI') {
  const opts = parseSaveOpts(optsOrSource);
  const table = pickTableFrom(order, opts);

  // -------------------------
  // BASE ORDERS (orders)
  // -------------------------
  if (table === 'orders') {
  const orderCode = normCode(order?.code || order?.client?.code);
  const localOrderId = String(order?.id || order?.oid || order?.local_id || '').trim() || `order_${Date.now()}`;
  
  const insertRowRaw = {
    code: orderCode,
    local_oid: localOrderId,
    status: order?.status || 'pastrim',
    client_name: order?.client_name || order?.client?.name || null,
    client_phone: normPhone(order?.client_phone || order?.client?.phone),
    total: Number(order?.total || order?.pay?.euro || 0),
    paid: Number(order?.paid || order?.pay?.paid || 0),
    data: order,
    updated_at: new Date().toISOString()
  };

  const insertRow = sanitizeRow(insertRowRaw, 'orders');

  // OFFLINE FIRST
  if (!isOnline()) {
    await saveOrderLocal({ ...insertRow, id: localOrderId, _local: true, _synced: false, _syncPending: true, _syncing: false, _syncFailed: false, _table: 'orders' });
    await pushOp({ op_id: `op_${Date.now()}`, type: "insert_order", payload: { ...insertRow, table: 'orders' } });
    return { order_id: localOrderId, _offline: true };
  }

  try {
    const { data, error } = await supabase
      .from('orders')
      .upsert(insertRow, { onConflict: 'local_oid' })
      .select('id')
      .single();
    if (error) throw error;
    
    // Mirror si i sinkronizuar
    await saveOrderLocal({ ...insertRow, id: data.id, _local: false, _synced: true, _syncPending: false, _syncing: false, _syncFailed: false, _table: 'orders' });
    try { patchBaseMasterRow({ ...insertRow, id: data.id, _local: false, _synced: true, table: 'orders' }); } catch {}
    
    // 🔥 SAPO U RUAJT ONLINE ME SUKSES, VARROSE FANTAZMËN LOKALE!
    banishGhost(localOrderId);
    
    return { order_id: data.id };
  } catch (e) {
    // Fallback nese deshton online
    await saveOrderLocal({ ...insertRow, id: localOrderId, _local: true, _synced: false, _syncPending: true, _syncing: false, _syncFailed: false, _table: 'orders' });
    try { patchBaseMasterRow({ ...insertRow, id: localOrderId, _local: true, _synced: false, table: 'orders' }); } catch {}
    return { order_id: localOrderId, _offline: true };
  }
  }

  // -------------------------
  // TRANSPORT ORDERS (transport_orders)
  // Expect caller to pass a DB-ready row for transport_orders.
  // We only guarantee:
  //  - id/local_oid exists
  //  - data exists
  //  - status exists
  //  - table routing
  // -------------------------
  const oid = String(order?.id || order?.local_oid || order?.oid || '').trim() || `t_${Date.now()}`;
  const rowRaw = {
    ...(order || {}),
    id: oid,
    // keep local_oid mirrored for tooling; transport table may ignore it
    local_oid: String(order?.local_oid || oid),
    status: order?.status || 'pickup',
    data: order?.data || order,
  };
  const row = sanitizeRow(rowRaw, 'transport_orders');

  if (!isOnline()) {
    // Save in local mirror too (so UI can show it immediately)
    await saveOrderLocal({ ...row, id: oid, _local: true, _synced: false, _syncPending: true, _syncing: false, _syncFailed: false, table: 'transport_orders' });
    await pushOp({ op_id: `op_${Date.now()}`, type: 'insert_order', payload: { ...row, table: 'transport_orders' } });
    return { order_id: oid, _offline: true };
  }

  try {
    const onConflict = String(opts?.onConflict || 'id');
    const { data, error } = await supabase
      .from('transport_orders')
.upsert(row, { onConflict })
      .select('id')
      .maybeSingle();
    if (error) throw error;
    const savedId = data?.id || oid;
    await saveOrderLocal({ ...row, id: savedId, _local: false, _synced: true, _syncPending: false, _syncing: false, _syncFailed: false, table: 'transport_orders' });
    banishGhost(oid);
    return { order_id: savedId };
  } catch (e) {
    await saveOrderLocal({ ...row, id: oid, _local: true, _synced: false, _syncPending: true, _syncing: false, _syncFailed: false, table: 'transport_orders' });
    await pushOp({ op_id: `op_${Date.now()}`, type: 'insert_order', payload: { ...row, table: 'transport_orders' } });
    return { order_id: oid, _offline: true };
  }
}

// ---------------------------------------------------------------------------
// EXTRA EXPORTS (Some pages expect these names)
// ---------------------------------------------------------------------------

export async function updateOrderInDb(id, patch = {}, opts = {}) {
  const table = String(opts?.table || patch?.table || 'orders');
  const cleanPatch = sanitizeRow({ ...(patch || {}), updated_at: new Date().toISOString(), table }, table);
  const oid = String(id || cleanPatch?.id || cleanPatch?.local_oid || '').trim();
  if (!oid) throw new Error('MISSING_ID');

  if (!isOnline()) {
    await pushOp({
      op_id: `op_${Date.now()}`,
      type: 'patch_order_data',
      id: oid,
      data: { ...cleanPatch, table },
      payload: { ...cleanPatch, table },
    });
    return { ok: true, offline: true };
  }

  if (table === 'transport_orders') {
    const { error } = await supabase.from('transport_orders').update(cleanPatch).eq('id', oid);
    if (error) throw error;
    return { ok: true };
  }

  const { error } = await supabase.from('orders').update(cleanPatch).eq('id', oid);
  if (error) throw error;
  return { ok: true };
}

export async function fetchClientsFromDb(q = '', { table = 'orders' } = {}) {
  const qq = String(q || '').trim();
  if (!qq) return [];

  if (table === 'transport_orders') {
    const { data, error } = await supabase
      .from('transport_clients')
      .select('id, tcode, name, phone, phone_digits, address, updated_at')
      .or(`name.ilike.%${qq}%,phone_digits.ilike.%${qq.replace(/\\D+/g, '')}%`)
      .order('updated_at', { ascending: false })
      .limit(10);
    if (error) throw error;
    return data || [];
  }

  const digits = qq.replace(/\\D+/g, '');
  const orParts = [`client_name.ilike.%${qq}%`];
  if (digits.length >= 3) orParts.push(`client_phone.ilike.%${digits}%`);
  const { data, error } = await supabase
    .from('orders')
    .select('client_name, client_phone, client_code, updated_at')
    .or(orParts.join(','))
    .order('updated_at', { ascending: false })
    .limit(10);
  if (error) throw error;
  return (data || []).map((r) => ({
    name: r.client_name,
    phone: r.client_phone,
    code: r.client_code || null,
  }));
}

// ✅ FUNKSIONI I FIXUAR PER MIRROR TE PLOTE (PA FANTAZMA)
export async function fetchOrdersFromDb(limit = 1000) {
  const mergeLocal = async (remoteRows = []) => {
    const map = new Map();
    const syncedLocalOids = new Set();
    const blacklist = getGhostBlacklist(); // 🔥 Marrim Listën e Zezë
    
    // 1. Mbushim me ato qe vijne nga Cloud (Remote)
    (remoteRows || []).forEach(r => {
      if (r && r.id) {
        map.set(String(r.id), { ...r, _synced: true });
      }
      // Shënojmë cilat ID lokale kanë ardhur nga serveri
      if (r && r.local_oid) {
        syncedLocalOids.add(String(r.local_oid));
      }
    });

    // 2. Shtojme ato qe jane ne IndexedDB (Local Mirror + New Offline)
    try {
      const local = await getAllOrdersLocal();
      (local || []).forEach(o => {
        const key = String(o.id || '');
        if (!key) return;
        
        // 🛑 VRASËSI I FANTAZMAVE 1: Injoro nëse është në Listën e Zezë (Auto-Blacklist)
        if (blacklist.includes(key) || (o.local_oid && blacklist.includes(String(o.local_oid)))) {
          return;
        }

        // 🛑 VRASËSI I FANTAZMAVE 2: Nëse kjo porosi ekziston në server (bazuar në ID ose local_oid), injoroje!
        if (syncedLocalOids.has(key) || (o.local_oid && syncedLocalOids.has(String(o.local_oid)))) {
          return; 
        }

        const existing = map.get(key);
        
        // I mbajmë lokalet nëse mungojnë në Cloud ose janë bërë offline (_synced: false)
        if (!existing || o._synced === false) {
          map.set(key, {
            ...o,
            // Sigurohemi qe fushat te jene te harmonizuara per UI
            code: String(o.code || ''),
            client_name: o.client_name || "Pa Emër",
            total: Number(o.total || 0),
            paid: Number(o.paid || 0)
          });
        }
      });
    } catch {}

    const out = Array.from(map.values());
    // Renditja: Te rejat lart
    return out.sort((a, b) => String(b.created_at || b.updated_at || '').localeCompare(String(a.created_at || a.updated_at || '')));
  };

  try {
    // Shkarkojmë listën e plotë (të gjitha statuset)
    const { data, error } = await supabase
      .from('orders')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) throw error;

    // ✅ MIRRORING AKTIV: Ruajmë snapshot-in në telefon për çdo rresht që erdhi
    if (data && data.length > 0) {
      // Përdorim një premtim që nuk bllokon kthimin e të dhënave (Background task)
      setTimeout(async () => {
        for (const row of data) {
          try {
            await saveOrderLocal({ ...row, _local: false, _synced: true }, true);
          } catch {}
        }
        try { patchBaseMasterRows((data || []).map((row) => ({ ...row, _local: false, _synced: true, table: 'orders' }))); } catch {}
      }, 10);
    }

    return await mergeLocal(data || []);
  } catch (e) {
    console.warn("[OrdersDb] Offline Fallback: Duke lexuar vetëm Mirror-in lokal");
    return await mergeLocal([]);
  }
}

export async function updateOrderStatus(id, status, extraPatch = {}) {
  const statusClean = String(status).toLowerCase();
  const cleanExtra = { ...(extraPatch || {}) };
  delete cleanExtra.id;
  delete cleanExtra.table;
  const up = { ...cleanExtra, status: statusClean, updated_at: new Date().toISOString() };

  // ✅ PËRDITËSIM LOKAL MENJËHERË: Kjo ndalon vonesën (ghosting) edhe kur je Online
  try {
    const current = await getAllOrdersLocal();
    const target = current.find(x => String(x.id) === String(id) || String(x.local_oid || '') === String(id));
    if (target) {
      const patched = { ...target, ...cleanExtra, status: statusClean, updated_at: up.updated_at, table: 'orders' };
      await saveOrderLocal(patched);
      try { patchBaseMasterRow(patched); } catch {}
    } else {
      try { patchBaseMasterRow({ id, ...cleanExtra, status: statusClean, updated_at: up.updated_at, table: 'orders' }); } catch {}
    }
  } catch {}

  if (!isOnline()) {
    await pushOp({
      op_id: `op_${Date.now()}`,
      type: "set_status",
      id,
      data: up,
      payload: { ...up, table: 'orders' },
    });
    return { ok: true, offline: true };
  }

  const q = supabase.from('orders').update(up);
  const { error } = String(id).startsWith('order_')
    ? await q.eq('local_oid', id)
    : await q.eq('id', id);
  if (error) throw error;
  return { ok: true };
}

// ✅ SHTESË: Funksion për të detyruar rifreskimin e Mirror-it (Manual Sync)
export async function refreshLocalMirror() {
  if (!isOnline()) return { ok: false, reason: "OFFLINE" };
  try {
    const data = await fetchOrdersFromDb(2000);
    return { ok: true, count: data.length };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
