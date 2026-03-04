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

// Debug
const LS_DEBUG = 'tepiha_debug_log_v1';
const DEBUG_MAX = 200;

function isBrowser() {
  return typeof window !== 'undefined';
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
    const { error } = await supabase.auth.getSession();
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
      dbg('reserveSharedCode:cached', { oid, code: cached });
      return cached;
    }
  }

  let code = takeFromPool(pin);

  // OFFLINE-FIRST: if pool empty and offline -> hard stop
  if (code == null) {
    const online = await isOnlineDb();
    if (!online) {
      dbg('reserveSharedCode:empty_offline', { pin });
      throw new Error("S'KA KOD NE POOL (OFFLINE). LIDHU ONLINE QE ME MARR 20 KODA.");
    }

    await refillBasePoolIfNeeded(pin, { min: 1 });
    code = takeFromPool(pin);
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
