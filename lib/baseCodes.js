// lib/baseCodes.js
// OFFLINE-FIRST BASE numeric codes (DB pool per-owner(PIN) -> local mirror)
// Permanent model (Option 1):
// - One RPC only: reserve_base_codes_batch(p_owner_id, p_n)
// - DB auto-mints if needed and returns JSON array of codes
// - Mirror cache per PIN in localStorage
// - Offline consumes mirror (pop)

import { supabase } from '@/lib/supabaseClient';
import { getActor } from '@/lib/actorSession';

const POOL_TARGET = 20;
const POOL_REFILL_WHEN_BELOW = 5;

// Mirror cache keys
const LS_POOL_PREFIX = 'base_code_pool:'; // base_code_pool:<PIN>
const LS_USED_QUEUE_PREFIX = 'base_code_used_queue:'; // base_code_used_queue:<PIN>
const LS_ORDER_CODE_PREFIX = 'base_order_code:'; // base_order_code:<OID>
const LS_EPOCH_KEY = 'base_code_epoch_v1';

// Debug
const LS_DEBUG = 'tepiha_debug_log_v1';
const DEBUG_MAX = 200;

function isBrowser() {
  return typeof window !== 'undefined';
}

const RPC_TIMEOUT_MS = 7000;
const AUTH_PING_TIMEOUT_MS = 2500;

function bootFetch(label, input, init) {
  try {
    if (typeof window !== 'undefined' && typeof window.__bootFetch === 'function') {
      const startedAt = Number(window.BOOT_STARTED_AT || 0);
      if (startedAt > 0 && Date.now() - startedAt <= 15000) {
        return window.__bootFetch(label, input, init);
      }
    }
  } catch {}
  return fetch(input, init);
}

function withTimeout(promise, ms, label = 'TIMEOUT') {
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(label)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    try { clearTimeout(t); } catch {}
  });
}

async function fetchRpcJson(fnName, payload, ms = RPC_TIMEOUT_MS) {
  // REST fallback for Mobile Safari where supabase-js fetch may hang / "Load failed".
  if (!isBrowser()) throw new Error('NO_BROWSER');
  const { SUPABASE_URL, SUPABASE_ANON_KEY } = await import('@/lib/supabaseClient');
  const url = `${SUPABASE_URL}/rest/v1/rpc/${fnName}`;
  const controller = new AbortController();
  const t = setTimeout(() => {
    try { controller.abort(); } catch {}
  }, ms);

  try {
    const res = await bootFetch(`base_codes_rpc:${fnName}`, url, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload || {}),
      signal: controller.signal,
    });

    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch {}

    if (!res.ok) {
      const msg = (data && (data.message || data.error_description || data.error)) || text || `HTTP_${res.status}`;
      const err = new Error(String(msg));
      err.status = res.status;
      err.payload = payload;
      throw err;
    }

    return data;
  } finally {
    try { clearTimeout(t); } catch {}
  }
}

function dbg(event, details = {}) {
  try {
    if (!isBrowser()) return;
    const now = new Date().toISOString();
    const item = {
      ts: now,
      module: 'baseCodes',
      event,
      details: details && typeof details === 'object' ? details : { value: String(details) },
    };
    const raw = window.localStorage.getItem(LS_DEBUG);
    const arr = raw ? JSON.parse(raw) : [];
    const next = Array.isArray(arr) ? arr : [];
    next.push(item);
    while (next.length > DEBUG_MAX) next.shift();
    window.localStorage.setItem(LS_DEBUG, JSON.stringify(next));
  } catch {}
}

function lsGet(key, fallback = null) {
  try {
    if (!isBrowser()) return fallback;
    const v = window.localStorage.getItem(key);
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
}

function lsSet(key, value) {
  try {
    if (!isBrowser()) return;
    window.localStorage.setItem(key, value);
  } catch {}
}

function lsJsonGet(key, fallback) {
  const raw = lsGet(key, null);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function lsJsonSet(key, obj) {
  try {
    lsSet(key, JSON.stringify(obj));
  } catch {}
}

export function normalizeCode(v) {
  if (v == null) return null;
  const s = String(v).trim();
  const m = s.match(/(\d+)/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function computeM2FromRows(rows = []) {
  let total = 0;
  for (const r of rows || []) {
    const m2 = Number(r?.m2 ?? r?.m ?? r?.area ?? 0);
    if (Number.isFinite(m2)) total += m2;
  }
  return Math.round(total * 100) / 100;
}


function normalizePhoneLoose(v) {
  const digits = String(v ?? '').replace(/\D+/g, '');
  if (!digits) return '';
  return digits.startsWith('383') ? digits.slice(3) : digits;
}

function normalizeNameLoose(v) {
  return String(v ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function clearOrderCodeCache(oid) {
  try {
    if (!oid) return;
    if (!isBrowser()) return;
    window.localStorage.removeItem(orderCodeKey(oid));
  } catch {}
}

async function fetchOrdersByCode(codeNum) {
  const code = normalizeCode(codeNum);
  if (code == null) return [];
  try {
    const { data, error } = await supabase
      .from('orders')
      .select('id,local_oid,code,client_name,client_phone,status')
      .eq('code', code)
      .limit(20);
    if (error) {
      dbg('fetchOrdersByCode:error', { code, message: error.message, details: error.details || null, dbcode: error.code || null });
      return [];
    }
    return Array.isArray(data) ? data : [];
  } catch (e) {
    dbg('fetchOrdersByCode:throw', { code, error: e?.message || String(e) });
    return [];
  }
}

async function fetchClientOwnerByCode(codeNum) {
  const code = normalizeCode(codeNum);
  if (code == null) return null;
  try {
    const { data, error } = await supabase
      .from('clients')
      .select('id,code,full_name,first_name,last_name,phone')
      .eq('code', code)
      .maybeSingle();
    if (error) {
      dbg('fetchClientOwnerByCode:error', { code, message: error.message, details: error.details || null, dbcode: error.code || null });
      return null;
    }
    return data || null;
  } catch (e) {
    dbg('fetchClientOwnerByCode:throw', { code, error: e?.message || String(e) });
    return null;
  }
}

function hasForeignCodeConflict(rows, opts = {}) {
  const oid = String(opts?.oid || '').trim();
  const editOrderId = String(opts?.editOrderId || '').trim();
  const phone = normalizePhoneLoose(opts?.clientPhone || '');
  const selectedClientId = String(opts?.selectedClientId || opts?.lockedClientId || '').trim();
  const selectedClientCode = String(normalizeCode(opts?.selectedClientCode ?? opts?.lockedClientCode ?? null) || '').trim();
  const ignore = new Set([oid, editOrderId].filter(Boolean));

  const relevant = (Array.isArray(rows) ? rows : []).filter((row) => {
    const rowId = String(row?.local_oid || row?.id || '').trim();
    if (rowId && ignore.has(rowId)) return false;

    const rowCode = String(normalizeCode(row?.code ?? row?.client_code ?? row?.data?.client_code ?? row?.data?.client?.code ?? null) || '').trim();
    if (selectedClientCode && rowCode && rowCode === selectedClientCode) return false;

    const rowClientId = String(row?.client_id || row?.client_master_id || row?.data?.client_master_id || row?.data?.client?.id || '').trim();
    if (selectedClientId && rowClientId && rowClientId === selectedClientId) return false;

    return true;
  });

  if (!relevant.length) return false;
  if (!phone) return true;

  return relevant.some((row) => {
    const rowPhone = normalizePhoneLoose(row?.client_phone || row?.data?.client_phone || row?.data?.client?.phone || '');
    if (!rowPhone) return true;
    return rowPhone !== phone;
  });
}

let LOCAL_CODE_SIGNAL_CACHE = { ts: 0, data: new Map() };

function readLocalStorageKeys() {
  try {
    if (!isBrowser() || !window.localStorage) return [];
    const out = [];
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const k = window.localStorage.key(i);
      if (k) out.push(k);
    }
    return out;
  } catch {
    return [];
  }
}

function addLocalCodeEntry(map, codeNum, entry = {}) {
  const code = normalizeCode(codeNum);
  if (code == null) return;
  const key = String(code);
  const list = map.get(key) || [];
  list.push({
    code,
    oid: String(entry?.oid || entry?.local_oid || entry?.id || '').trim(),
    clientId: String(entry?.clientId || entry?.client_id || entry?.client_master_id || '').trim(),
    name: String(entry?.name || entry?.client_name || '').trim(),
    phone: String(entry?.phone || entry?.client_phone || '').trim(),
    source: String(entry?.source || '').trim(),
  });
  map.set(key, list);
}

function ingestLocalRowCode(map, row, meta = {}) {
  if (!row || typeof row !== 'object') return;
  const data = row?.data && typeof row.data === 'object' ? row.data : {};
  const client = data?.client && typeof data.client === 'object' ? data.client : (row?.client && typeof row.client === 'object' ? row.client : {});
  addLocalCodeEntry(map, row?.code ?? row?.code_n ?? data?.code ?? client?.code ?? row?.client_code ?? null, {
    oid: row?.local_oid || row?.oid || row?.id || data?.local_oid || data?.oid || null,
    clientId: client?.id || data?.client_master_id || row?.client_master_id || null,
    name: row?.client_name || data?.client_name || client?.name || null,
    phone: row?.client_phone || data?.client_phone || client?.phone || null,
    source: meta?.source || row?._table || row?.table || 'row',
  });
}

function sameLocalCodeOwner(entry = {}, opts = {}, codeNum = null) {
  const code = normalizeCode(codeNum ?? entry?.code);
  const selectedClientCode = normalizeCode(opts?.selectedClientCode ?? opts?.lockedClientCode ?? null);
  const selectedClientId = String(opts?.selectedClientId || opts?.lockedClientId || '').trim();
  const oid = String(opts?.oid || '').trim();
  const editOrderId = String(opts?.editOrderId || '').trim();
  const entryOid = String(entry?.oid || '').trim();

  if (entryOid && (entryOid === oid || entryOid === editOrderId)) return true;
  if (selectedClientCode != null && code != null && selectedClientCode === code) return true;
  if (selectedClientId && String(entry?.clientId || '').trim() === selectedClientId) return true;

  const phone = normalizePhoneLoose(opts?.clientPhone || '');
  const entryPhone = normalizePhoneLoose(entry?.phone || '');
  if (phone && entryPhone && phone === entryPhone) return true;

  return false;
}

async function collectLocalCodeSignals(force = false) {
  const now = Date.now();
  if (!force && LOCAL_CODE_SIGNAL_CACHE?.ts && (now - LOCAL_CODE_SIGNAL_CACHE.ts) < 1500) {
    return LOCAL_CODE_SIGNAL_CACHE.data;
  }

  const map = new Map();

  try {
    for (const key of readLocalStorageKeys()) {
      if (!key) continue;

      if (key.startsWith(LS_ORDER_CODE_PREFIX)) {
        addLocalCodeEntry(map, lsGet(key, null), { oid: key.slice(LS_ORDER_CODE_PREFIX.length), source: 'order_code_cache' });
        continue;
      }

      if (key.startsWith('order_') || key.startsWith('draft_order_')) {
        const parsed = lsJsonGet(key, null);
        if (parsed && typeof parsed === 'object') ingestLocalRowCode(map, parsed, { source: key.startsWith('draft_order_') ? 'draft_local' : 'order_shadow' });
        continue;
      }
    }
  } catch {}

  try {
    const cache = lsJsonGet('tepiha_clients_index_v1', null);
    const items = Array.isArray(cache?.items) ? cache.items : [];
    for (const item of items) {
      addLocalCodeEntry(map, item?.code, {
        clientId: item?.id || null,
        name: item?.name || null,
        phone: item?.phone || null,
        source: 'clients_index',
      });
    }
  } catch {}

  try {
    const mod = await import('@/lib/offlineStore');
    const rows = await mod.getAllOrdersLocal().catch(() => []);
    for (const row of Array.isArray(rows) ? rows : []) ingestLocalRowCode(map, row, { source: 'offline_orders' });

    const ops = await mod.getPendingOps().catch(() => []);
    for (const op of Array.isArray(ops) ? ops : []) {
      const payload = op?.payload && typeof op.payload === 'object' ? op.payload : {};
      const row = payload?.insertRow && typeof payload.insertRow === 'object' ? payload.insertRow : payload;
      if (String(op?.type || op?.op || '').trim() !== 'insert_order') continue;
      const table = String(row?.table || payload?.table || 'orders').trim();
      if (table !== 'orders') continue;
      ingestLocalRowCode(map, row, { source: 'pending_insert' });
    }
  } catch {}

  LOCAL_CODE_SIGNAL_CACHE = { ts: now, data: map };
  return map;
}

async function hasLocalForeignCodeConflict(codeNum, opts = {}) {
  const code = normalizeCode(codeNum);
  if (code == null) return false;
  const map = await collectLocalCodeSignals();
  const entries = map.get(String(code)) || [];
  if (!entries.length) return false;
  return entries.some((entry) => !sameLocalCodeOwner(entry, opts, code));
}

async function getHighestKnownLocalCode(pin = '') {
  let maxCode = 0;
  try {
    const map = await collectLocalCodeSignals();
    for (const key of map.keys()) {
      const code = normalizeCode(key);
      if (code != null && code > maxCode) maxCode = code;
    }
  } catch {}

  try {
    const pool = getPool(pin);
    for (const code of pool) {
      if (code != null && code > maxCode) maxCode = code;
    }
  } catch {}

  try {
    const queued = lsJsonGet(usedQueueKey(pin), []);
    for (const code of Array.isArray(queued) ? queued : []) {
      const n = normalizeCode(code);
      if (n != null && n > maxCode) maxCode = n;
    }
  } catch {}

  return maxCode;
}

async function takeSafeLocalCode(pin, opts = {}) {
  const tried = new Set();
  for (let i = 0; i < 64; i += 1) {
    const code = takeFromPool(pin);
    if (code == null) break;
    if (tried.has(code)) continue;
    tried.add(code);

    const localConflict = await hasLocalForeignCodeConflict(code, opts);
    if (localConflict) {
      queueUsed(pin, code);
      dbg('takeSafeLocalCode:skip_local_conflict', { pin, code, oid: opts?.oid || null });
      continue;
    }

    return code;
  }

  if (opts?.allowFallback === false) return null;

  const highest = await getHighestKnownLocalCode(pin);
  const fallback = Math.max(1, Number(highest || 0) + 1);
  dbg('takeSafeLocalCode:fallback', { pin, fallback, oid: opts?.oid || null, highest });
  return fallback;
}

export function getActorPin() {
  try {
    const a = getActor();
    return a?.pin || a?.id || null;
  } catch {
    return null;
  }
}

function poolKey(pin) {
  return `${LS_POOL_PREFIX}${pin}`;
}
function usedQueueKey(pin) {
  return `${LS_USED_QUEUE_PREFIX}${pin}`;
}
function orderCodeKey(oid) {
  return `${LS_ORDER_CODE_PREFIX}${oid}`;
}


async function ensureFreshBaseEpoch(pin) {
  try {
    if (!isBrowser() || !pin) return true;
    const { data, error } = await withTimeout(
      supabase
        .from('app_meta')
        .select('db_epoch')
        .eq('key', 'global')
        .maybeSingle(),
      2500,
      'BASE_EPOCH_TIMEOUT'
    );

    if (error) return false;

    const remoteEpoch = Number(data?.db_epoch || 0);
    const localEpoch = Number(lsGet(LS_EPOCH_KEY, '0') || 0);

    if (remoteEpoch > 0 && remoteEpoch !== localEpoch) {
      try { window.localStorage.removeItem(poolKey(pin)); } catch {}
      lsSet(LS_EPOCH_KEY, String(remoteEpoch));
      dbg('ensureFreshBaseEpoch:reset', { pin, localEpoch, remoteEpoch });
    }

    return true;
  } catch (e) {
    dbg('ensureFreshBaseEpoch:error', { pin, error: e?.message || String(e) });
    return false;
  }
}

function getPool(pin) {
  const arr = lsJsonGet(poolKey(pin), []);
  const out = Array.isArray(arr) ? arr.map(normalizeCode).filter((x) => x != null) : [];
  out.sort((a, b) => a - b);
  return out.slice(0, POOL_TARGET);
}

function setPool(pin, arr) {
  const clean = Array.from(new Set((arr || []).map(normalizeCode).filter((x) => x != null)));
  clean.sort((a, b) => a - b);
  const sliced = clean.slice(0, POOL_TARGET);
  lsJsonSet(poolKey(pin), sliced);
  return sliced;
}

function replacePool(pin, codes) {
  return setPool(pin, codes || []);
}

function takeFromPool(pin) {
  const current = getPool(pin);
  if (!current.length) return null;
  const code = current.shift();
  setPool(pin, current);
  return code;
}

function addBackToPool(pin, code) {
  const c = normalizeCode(code);
  if (c == null) return getPool(pin);
  const current = getPool(pin);
  current.push(c);
  return setPool(pin, current);
}

function queueUsed(pin, code) {
  const c = normalizeCode(code);
  if (c == null) return;
  const q = lsJsonGet(usedQueueKey(pin), []);
  const next = Array.isArray(q) ? q : [];
  if (!next.includes(c)) next.push(c);
  lsJsonSet(usedQueueKey(pin), next);
}

function drainUsedQueue(pin) {
  const q = lsJsonGet(usedQueueKey(pin), []);
  lsJsonSet(usedQueueKey(pin), []);
  return Array.isArray(q) ? q.map(normalizeCode).filter((x) => x != null) : [];
}

// Online check (cheap, safe)
async function isOnlineDb() {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;
  try {
    const { error } = await withTimeout(supabase.auth.getSession(), AUTH_PING_TIMEOUT_MS, 'AUTH_PING_TIMEOUT');
    const ok = !error;
    dbg('isOnlineDb', { ok, error: error?.message || null });
    return ok;
  } catch (e) {
    dbg('isOnlineDb', { ok: false, error: e?.message || String(e) });
    return false;
  }
}

// --- DB RPC (single source of truth) ---
async function reservePoolFromDb(pin) {
  const p = String(pin || '').trim();
  if (!p) return [];

  dbg('reservePoolFromDb:start', { pin: p, n: POOL_TARGET });

  try {
    // Permanent RPC (Option 1): reserve_base_codes_batch(p_owner_id text, p_n integer) -> json/jsonb array
    const { data, error } = await supabase.rpc('reserve_base_codes_batch', { p_owner_id: p, p_n: POOL_TARGET });
    if (error) {
      dbg('reservePoolFromDb:error', { message: error.message, code: error.code || null, details: error.details || null });
      return [];
    }

    // Expect JSON array like [1000,1001] or ["1000","1001"]
    const arr = Array.isArray(data) ? data : Array.isArray(data?.codes) ? data.codes : null;
    if (!Array.isArray(arr)) {
      dbg('reservePoolFromDb:bad_data', { type: typeof data });
      return [];
    }

    const codes = arr.map(normalizeCode).filter((x) => x != null);
    codes.sort((a, b) => a - b);

    dbg('reservePoolFromDb:ok', { got: codes.length, first: codes[0] || null, last: codes[codes.length - 1] || null });
    return codes.slice(0, POOL_TARGET);
  } catch (e) {
    dbg('reservePoolFromDb:throw', { error: e?.message || String(e) });
    return [];
  }
}

// Mark used in DB (best-effort). If you have a DB trigger on orders, this is harmless.
async function markUsedInDb(pin, code) {
  const p = String(pin || '').trim();
  const c = normalizeCode(code);
  if (!p || c == null) return false;

  dbg('markUsedInDb:start', { pin: p, code: c });

  try {
    // Preferred: update base_code_pool (Option 1 style). If your table name differs, adjust.
    const r = await supabase.from('base_code_pool').update({ status: 'used' }).eq('code', c);
    if (r.error) {
      dbg('markUsedInDb:error', { message: r.error.message, code: r.error.code || null, details: r.error.details || null, codeNum: c });
      return false;
    }
    dbg('markUsedInDb:ok', { code: c });
    return true;
  } catch (e) {
    dbg('markUsedInDb:throw', { error: e?.message || String(e), codeNum: c });
    return false;
  }
}


export async function reserveVerifiedSharedCode(oid, opts = {}) {
  const pin = String(getActorPin() || '').trim();
  if (!pin) throw new Error('NUK KA PIN');

  const online = await isOnlineDb();
  if (!online) return reserveSharedCode(oid);

  await ensureFreshBaseEpoch(pin);
  const warmed = await ensureBasePool(pin).catch(() => ({ ok: false, reason: 'WARM_FAILED' }));
  if (!warmed || warmed.ok !== true) {
    dbg('reserveVerifiedSharedCode:warm_failed', { pin, reason: warmed?.reason || 'UNKNOWN' });
    throw new Error('NUK U FRESKUA POOL-I NGA SERVERI');
  }

  clearOrderCodeCache(oid);

  const tried = new Set();
  for (let i = 0; i < 12; i += 1) {
    let code = takeFromPool(pin);
    if (code == null) {
      await refillBasePoolIfNeeded(pin, { min: 1 }).catch(() => {});
      code = takeFromPool(pin);
    }
    if (code == null) break;
    if (tried.has(code)) continue;
    tried.add(code);

    const localConflict = await hasLocalForeignCodeConflict(code, { ...opts, oid });
    if (localConflict) {
      queueUsed(pin, code);
      dbg('reserveVerifiedSharedCode:local_conflict', {
        oid: oid || null,
        code,
        clientPhone: opts?.clientPhone || null,
        clientName: opts?.clientName || null,
      });
      continue;
    }

    const rows = await fetchOrdersByCode(code);
    const conflict = hasForeignCodeConflict(rows, { ...opts, oid });
    if (conflict) {
      queueUsed(pin, code);
      dbg('reserveVerifiedSharedCode:conflict', {
        oid: oid || null,
        code,
        rows: rows.length,
        clientPhone: opts?.clientPhone || null,
        clientName: opts?.clientName || null,
      });
      continue;
    }

    if (oid) lsSet(orderCodeKey(oid), String(code));
    dbg('reserveVerifiedSharedCode:ok', { oid: oid || null, code, poolLeft: getPool(pin).length });
    refillBasePoolIfNeeded(pin).catch(() => {});
    return code;
  }

  throw new Error('NUK U GJET KOD I SIGURT NGA POOL-I');
}

export async function ensureUniqueBaseCodeForSave(opts = {}) {
  const pin = String(getActorPin() || '').trim();
  if (!pin) throw new Error('NUK KA PIN');

  const current = normalizeCode(opts?.code);
  const selectedClientId = String(opts?.selectedClientId || opts?.lockedClientId || '').trim();
  const selectedClientCode = String(normalizeCode(opts?.selectedClientCode ?? opts?.lockedClientCode ?? null) || '').trim();

  if (selectedClientCode) {
    if (opts?.oid) lsSet(orderCodeKey(opts.oid), String(selectedClientCode));
    dbg('ensureUniqueBaseCodeForSave:locked_selected_client_code', {
      oid: opts?.oid || null,
      selectedClientId: selectedClientId || null,
      selectedClientCode,
      current: current ?? null,
    });
    return { ok: true, code: normalizeCode(selectedClientCode), verified: true, changed: normalizeCode(selectedClientCode) !== current, lockedClient: true };
  }

  const online = await isOnlineDb();
  if (!online) {
    if (current != null) {
      const localConflict = await hasLocalForeignCodeConflict(current, { ...opts, selectedClientId, selectedClientCode });
      if (!localConflict || (selectedClientCode && selectedClientCode === String(current))) {
        return { ok: true, code: current, verified: false, changed: false, offline: true };
      }
    }

    const nextLocal = await takeSafeLocalCode(pin, { ...opts, oid: opts?.oid, selectedClientId, selectedClientCode });
    if (opts?.oid) lsSet(orderCodeKey(opts.oid), String(nextLocal));
    return { ok: true, code: nextLocal, verified: false, changed: nextLocal !== current, offline: true, localResolved: true };
  }

  if (current != null) {
    const owner = await fetchClientOwnerByCode(current);
    const ownerId = String(owner?.id || '').trim();
    const ownerPhone = normalizePhoneLoose(owner?.phone || '');
    const inputPhone = normalizePhoneLoose(opts?.clientPhone || '');
    const sameOwnerPhone = !!ownerPhone && !!inputPhone && ownerPhone === inputPhone;
    if (ownerId && ((selectedClientId && ownerId === selectedClientId) || (selectedClientCode && selectedClientCode === String(current)) || sameOwnerPhone)) {
      dbg('ensureUniqueBaseCodeForSave:ok_owner_match', {
        oid: opts?.oid || null,
        code: current,
        ownerId,
        selectedClientId: selectedClientId || null,
        selectedClientCode: selectedClientCode || null,
        sameOwnerPhone,
      });
      return { ok: true, code: current, verified: true, changed: false, ownerMatched: true, ownerPhoneMatched: sameOwnerPhone, owner: owner || null };
    }

    const localConflict = await hasLocalForeignCodeConflict(current, { ...opts, selectedClientId, selectedClientCode });
    const rows = await fetchOrdersByCode(current);
    const conflict = hasForeignCodeConflict(rows, { ...opts, selectedClientId, selectedClientCode });
    if (!localConflict && !conflict) {
      dbg('ensureUniqueBaseCodeForSave:ok_current', { oid: opts?.oid || null, code: current, rows: rows.length });
      return { ok: true, code: current, verified: true, changed: false, owner: owner || null };
    }

    dbg('ensureUniqueBaseCodeForSave:need_new', {
      oid: opts?.oid || null,
      code: current,
      rows: rows.length,
      localConflict,
      clientPhone: opts?.clientPhone || null,
      clientName: opts?.clientName || null,
      selectedClientId: selectedClientId || null,
      selectedClientCode: selectedClientCode || null,
      ownerId: ownerId || null,
    });
  }

  const next = await reserveVerifiedSharedCode(opts?.oid, { ...opts, selectedClientId, selectedClientCode });
  return { ok: true, code: next, verified: true, changed: next !== current };
}

// --- PUBLIC API ---
export async function warmBasePool({ pin } = {}) {
  const p = String(pin || getActorPin() || '').trim();
  if (!p) return { ok: false, reason: 'NO_PIN' };

  const online = await isOnlineDb();
  if (!online) return { ok: false, reason: 'OFFLINE', have: getPool(p).length };

  const have = getPool(p).length;
  if (have >= POOL_TARGET) {
    dbg('warmBasePool:skip', { have, target: POOL_TARGET });
    await flushBaseUsedQueue(p).catch(() => {});
    return { ok: true, skipped: true, have };
  }

  const codes = await reservePoolFromDb(p);
  if (!codes.length) return { ok: false, reason: 'RPC_FAILED', have: getPool(p).length };

  replacePool(p, codes);
  await flushBaseUsedQueue(p).catch(() => {});

  return { ok: true, reserved: codes.length, have: getPool(p).length };
}

export async function refillBasePoolIfNeeded(pinArg, opts = {}) {
  const p = String(pinArg || getActorPin() || '').trim();
  if (!p) return { ok: false, reason: 'NO_PIN' };

  const min = Number(opts?.min ?? POOL_REFILL_WHEN_BELOW);
  const have = getPool(p).length;

  if (have >= min) {
    dbg('refillBasePoolIfNeeded:skip', { have, min });
    await flushBaseUsedQueue(p).catch(() => {});
    return { ok: true, skipped: true, have };
  }

  const online = await isOnlineDb();
  if (!online) return { ok: false, reason: 'OFFLINE', have };

  const codes = await reservePoolFromDb(p);
  if (!codes.length) return { ok: false, reason: 'RPC_FAILED', have: getPool(p).length };

  replacePool(p, codes);
  await flushBaseUsedQueue(p).catch(() => {});

  const after = getPool(p).length;
  dbg('refillBasePoolIfNeeded:ok', { before: have, after, min });
  return { ok: true, added: Math.max(0, after - have), have: after };
}

export async function ensureBasePool(pinArg) {
  return warmBasePool({ pin: pinArg });
}

// Main function used by Pranimi to get a code (cached per OID)
export async function reserveSharedCode(oid) {
  const pin = String(getActorPin() || '').trim();
  if (!pin) throw new Error('NUK KA PIN');

  if (oid) {
    const cached = normalizeCode(lsGet(orderCodeKey(oid), null));
    if (cached != null) {
      const cachedConflict = await hasLocalForeignCodeConflict(cached, { oid });
      if (!cachedConflict) {
        dbg('reserveSharedCode:cached', { oid, code: cached });
        return cached;
      }
      try { clearOrderCodeCache(oid); } catch {}
      dbg('reserveSharedCode:cached_conflict_cleared', { oid, code: cached });
    }
  }

  await ensureFreshBaseEpoch(pin);

  let code = await takeSafeLocalCode(pin, { oid, allowFallback: false });

  // OFFLINE-FIRST: if pool empty and offline -> local safe fallback is already used by takeSafeLocalCode.
  if (code == null) {
    const online = await isOnlineDb();
    if (!online) {
      dbg('reserveSharedCode:empty_offline', { pin });
      throw new Error("S'KA KOD NE POOL (OFFLINE). LIDHU ONLINE QE ME MARR 20 KODA.");
    }

    await refillBasePoolIfNeeded(pin, { min: 1 });
    code = await takeSafeLocalCode(pin, { oid, allowFallback: false });
  }

  if (code == null) {
    dbg('reserveSharedCode:empty_after_refill', { pin });
    throw new Error("S'KA KOD NE POOL. LIDHU ONLINE QE ME MARR 20 KODA.");
  }

  if (oid) lsSet(orderCodeKey(oid), String(code));
  dbg('reserveSharedCode:ok', { oid: oid || null, code, poolLeft: getPool(pin).length });

  // Background refill
  refillBasePoolIfNeeded(pin).catch(() => {});
  return code;
}

export async function markCodeUsed(codeNum, oid) {
  const pin = String(getActorPin() || '').trim();
  const code = normalizeCode(codeNum);
  if (!pin || code == null) return false;

  if (oid) lsSet(orderCodeKey(oid), String(code));

  const online = await isOnlineDb();
  if (!online) {
    queueUsed(pin, code);
    dbg('markCodeUsed:queued_offline', { code, oid: oid || null });
    return true;
  }

  const ok = await markUsedInDb(pin, code);
  if (!ok) {
    queueUsed(pin, code);
    dbg('markCodeUsed:queued_after_fail', { code, oid: oid || null });
  }

  await flushBaseUsedQueue(pin).catch(() => {});
  return true;
}

export async function flushBaseUsedQueue(pinArg) {
  const pin = String(pinArg || getActorPin() || '').trim();
  if (!pin) return { ok: false, reason: 'NO_PIN' };

  const online = await isOnlineDb();
  if (!online) return { ok: false, reason: 'OFFLINE' };

  const queued = drainUsedQueue(pin);
  if (!queued.length) {
    dbg('flushBaseUsedQueue:empty', { pin });
    return { ok: true, flushed: 0 };
  }

  dbg('flushBaseUsedQueue:start', { pin, queued: queued.length });

  const still = [];
  for (const c of queued) {
    const ok = await markUsedInDb(pin, c);
    if (!ok) still.push(c);
  }

  if (still.length) lsJsonSet(usedQueueKey(pin), still);
  dbg('flushBaseUsedQueue:done', { pin, flushed: queued.length - still.length, remaining: still.length });

  return { ok: still.length === 0, flushed: queued.length - still.length, remaining: still.length };
}

export async function syncBasePool(pinArg, opts = {}) {
  const pin = String(pinArg || getActorPin() || '').trim();
  if (!pin) return { ok: false, reason: 'NO_PIN' };

  const online = await isOnlineDb();
  if (!online) return { ok: false, reason: 'OFFLINE' };

  await flushBaseUsedQueue(pin).catch(() => {});
  const min = Number.isFinite(opts.min) ? opts.min : 1;
  await refillBasePoolIfNeeded(pin, { min });

  return { ok: true };
}

// Legacy name kept for compatibility with existing Pranimi flows.
// In Option 1 (no leases), releasing a code is LOCAL ONLY (adds back to mirror pool).
export async function releaseLocksForCode(codeNum) {
  const pin = String(getActorPin() || '').trim();
  const code = normalizeCode(codeNum);
  if (!pin || code == null) return true;

  addBackToPool(pin, code);
  dbg('releaseLocksForCode:local_only', { pin, code, poolNow: getPool(pin).length });
  return true;
}

export function takeBaseCode(pin) {
  const p = String(pin || '').trim();
  return takeFromPool(p);
}
