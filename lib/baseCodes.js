// lib/baseCodes.js
// SINGLE SOURCE OF TRUTH for BASE numeric codes (DB pool -> local mirror)
//
// ✅ MUST export (sepse build-i i projektit po i lyp):
// - warmBasePool
// - refillBasePoolIfNeeded
// - reserveSharedCode
// - markCodeUsed
// - flushBaseUsedQueue
// - releaseLocksForCode
// - takeBaseCode
// - normalizeCode
// - computeM2FromRows
// - ensureBasePool   (opsional, por e kemi)
//
// STRICT RULES:
// - ONLINE: ALWAYS reserve from DB via reserve_base_codes_batch(pin, 20, leaseMinutes). Never generate locally.
// - OFFLINE: ONLY use localStorage pool. If empty => STOP (no emergency codes).
// - Pool per PIN max 20 codes. Always smallest codes first.
// - markCodeUsed() queues when offline and flushes when back online.
//
// DEBUG / “DOC”:
// - Krejt eventet kryesore shkruhen në localStorage: tepiha_debug_log_v1 (max ~200 rreshta)
// - Mundesh me i pa te /doctor (nëse doctor i lexon localStorage), ose me i kopju prej localStorage manualisht.

import { supabase } from '@/lib/supabaseClient';
import { getActor } from '@/lib/actorSession';

const POOL_TARGET = 20;
const POOL_REFILL_WHEN_BELOW = 5;
const DEFAULT_LEASE_MINUTES = 180;

const LS_POOL_PREFIX = 'base_code_pool:'; // base_code_pool:<PIN>
const LS_USED_QUEUE_PREFIX = 'base_code_used_queue:'; // base_code_used_queue:<PIN>
const LS_ORDER_CODE_PREFIX = 'base_order_code:'; // base_order_code:<OID>

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

async function isOnlineDb() {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;
  try {
    const { error } = await supabase.from('orders').select('id').limit(1);
    const ok = !error;
    dbg('isOnlineDb', { ok, error: error?.message || null });
    return ok;
  } catch (e) {
    dbg('isOnlineDb', { ok: false, error: e?.message || String(e) });
    return false;
  }
}

// --- DB RPCs ---
// Supports BOTH DB layouts:
// (A) SIMPLE base_code_pool(code int, used bool)  => reserve_base_codes_batch_simple(p_n)
// (B) PIN/lease pool with claimed_by fields       => reserve_base_codes_batch(p_pin,p_n,p_lease_minutes)
// We try *_simple first and fall back.
async function reservePoolFromDb(pin, leaseMinutes = DEFAULT_LEASE_MINUTES) {
  const p = String(pin || '').trim();
  if (!p) return [];

  dbg('reservePoolFromDb:start', { pin: p, n: POOL_TARGET, leaseMinutes });

  let data = null;
  let error = null;

  // 1) SIMPLE (no pin)
  try {
    const r1 = await supabase.rpc('reserve_base_codes_batch_simple', { p_n: POOL_TARGET });
    data = r1.data;
    error = r1.error;
  } catch (e) {
    error = { message: e?.message || String(e) };
  }

  // 2) FALLBACK (pin/lease)
  if (error) {
    try {
      const r2 = await supabase.rpc('reserve_base_codes_batch', {
        p_pin: p,
        p_n: POOL_TARGET,
        p_lease_minutes: leaseMinutes,
      });
      data = r2.data;
      error = r2.error;
    } catch (e) {
      error = { message: e?.message || String(e) };
    }
  }

  if (error) {
    dbg('reservePoolFromDb:error', { message: error.message, code: error.code || null, details: error.details || null });
    return [];
  }
  if (!Array.isArray(data)) {
    dbg('reservePoolFromDb:bad_data', { type: typeof data });
    return [];
  }

  const codes = data.map((d) => normalizeCode(d?.code ?? d)).filter((x) => x != null);
  codes.sort((a, b) => a - b);

  dbg('reservePoolFromDb:ok', { got: codes.length, first: codes[0] || null, last: codes[codes.length - 1] || null });
  return codes.slice(0, POOL_TARGET);
}

async function markUsedInDb(pin, code) {
  const p = String(pin || '').trim();
  const c = normalizeCode(code);
  if (!p || c == null) return false;

  dbg('markUsedInDb:start', { pin: p, code: c });

  // In SIMPLE layout the code was already flipped to used=true when reserved to the pool,
  // so "mark used" is best-effort / idempotent.
  // Try SIMPLE RPC first, then fall back.
  let error = null;
  try {
    const r1 = await supabase.rpc('mark_base_code_used_simple', { p_code: c });
    error = r1.error;
  } catch (e) {
    error = { message: e?.message || String(e) };
  }
  if (error) {
    try {
      const r2 = await supabase.rpc('mark_base_code_used', { p_pin: p, p_code: c });
      error = r2.error;
    } catch (e) {
      error = { message: e?.message || String(e) };
    }
  }

  if (error) {
    dbg('markUsedInDb:error', { message: error.message, code: error.code || null, details: error.details || null, codeNum: c });
    return false;
  }

  dbg('markUsedInDb:ok', { code: c });
  return true;
}

// --- PUBLIC API ---
// ✅ Alias që login/page.jsx po e pret:
export async function warmBasePool({ pin, target = POOL_TARGET, leaseMinutes = DEFAULT_LEASE_MINUTES } = {}) {
  const p = String(pin || getActorPin() || '').trim();
  if (!p) return { ok: false, reason: 'NO_PIN' };

  const online = await isOnlineDb();
  if (!online) return { ok: false, reason: 'OFFLINE', have: getPool(p).length };

  // “target” nuk e ndryshon RPC (RPC merr 20), por e respektojmë si “min have”
  const have = getPool(p).length;
  if (have >= target) {
    dbg('warmBasePool:skip', { have, target });
    await flushBaseUsedQueue(p);
    return { ok: true, skipped: true, have };
  }

  const codes = await reservePoolFromDb(p, leaseMinutes);
  if (!codes.length) return { ok: false, reason: 'RPC_FAILED', have: getPool(p).length };

  replacePool(p, codes);
  await flushBaseUsedQueue(p);

  return { ok: true, reserved: codes.length, have: getPool(p).length };
}

// ✅ “single call” që e mban pool-in fresh kur zbret poshtë pragut
export async function refillBasePoolIfNeeded(pinArg, opts = {}) {
  const p = String(pinArg || getActorPin() || '').trim();
  if (!p) return { ok: false, reason: 'NO_PIN' };

  const min = Number(opts?.min ?? POOL_REFILL_WHEN_BELOW);
  const target = Number(opts?.target ?? POOL_TARGET);
  const have = getPool(p).length;

  if (have >= min) {
    dbg('refillBasePoolIfNeeded:skip', { have, min });
    // prap flush queue nese jemi online (se mundet me pas ngel)
    await flushBaseUsedQueue(p).catch(() => {});
    return { ok: true, skipped: true, have };
  }

  const online = await isOnlineDb();
  if (!online) return { ok: false, reason: 'OFFLINE', have };

  // RPC kthen 20, ne e vendosim si pool komplet (strict)
  const codes = await reservePoolFromDb(p, opts?.leaseMinutes ?? DEFAULT_LEASE_MINUTES);
  if (!codes.length) return { ok: false, reason: 'RPC_FAILED', have: getPool(p).length };

  replacePool(p, codes);
  await flushBaseUsedQueue(p);

  const after = getPool(p).length;
  dbg('refillBasePoolIfNeeded:ok', { before: have, after, min, target });
  return { ok: true, added: Math.max(0, after - have), have: after };
}

// ✅ e përdorim në disa vende (opsional)
export async function ensureBasePool(pinArg) {
  return warmBasePool({ pin: pinArg, target: POOL_TARGET, leaseMinutes: DEFAULT_LEASE_MINUTES });
}

// PRANIMI uses this to get the next code.
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
  if (code == null) {
    const online = await isOnlineDb();
    if (!online) {
      dbg('reserveSharedCode:empty_offline', { pin });
      docPush('base:reserve:fail_offline_empty', { pin });
      throw new Error("S'KA KOD NE POOL (OFFLINE). LIDHU ONLINE QE ME MARR 20 KODA.");
    }
    await refillBasePoolIfNeeded(pin, { min: 1, target: POOL_TARGET });
    code = takeFromPool(pin);
  }

  if (code == null) {
    dbg('reserveSharedCode:empty_after_refill', { pin });
    throw new Error("S'KA KOD NE POOL. LIDHU ONLINE QE ME MARR 20 KODA.");
  }

  if (oid) lsSet(orderCodeKey(oid), String(code));
  dbg('reserveSharedCode:ok', { oid: oid || null, code, poolLeft: getPool(pin).length });

  // refill in background when low (mos e blloko UI)
  refillBasePoolIfNeeded(pin).catch(() => {});
  return code;
}

// Call after SAVE ORDER.
export async function markCodeUsed(codeNum, oid) {
  docPush('base:mark_used', { codeNum, oid });
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

  await flushBaseUsedQueue(pin);
  return true;
}

// Flush queued "used" marks (run on login + when coming online)
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
    // eslint-disable-next-line no-await-in-loop
    const ok = await markUsedInDb(pin, c);
    if (!ok) still.push(c);
  }

  if (still.length) lsJsonSet(usedQueueKey(pin), still);
  dbg('flushBaseUsedQueue:done', { pin, flushed: queued.length - still.length, remaining: still.length });

  return { ok: still.length === 0, flushed: queued.length - still.length, remaining: still.length };
}

// Sync helper: flush queued USED marks + refill pool when we are online.
// Safe to call frequently (on login, on 'online' event, every N seconds).
export async function syncBasePool(pinArg, opts = {}) {
  const pin = String(pinArg || getActorPin() || '').trim();
  if (!pin) return { ok: false, reason: 'NO_PIN' };

  const online = await isOnlineDb();
  if (!online) return { ok: false, reason: 'OFFLINE' };

  // 1) push any queued "used" updates
  await flushBaseUsedQueue(pin);

  // 2) refill pool if low
  const min = Number.isFinite(opts.min) ? opts.min : 1;
  const target = Number.isFinite(opts.target) ? opts.target : POOL_TARGET;
  await refillBasePoolIfNeeded(pin, { min, target });

  return { ok: true };
}

// ✅ Build-i yt po e lyp këtë export nga /app/pranimi/page.jsx
export async function releaseLocksForCode(codeNum) {
  const pin = String(getActorPin() || '').trim();
  const code = normalizeCode(codeNum);
  if (!pin || code == null) return true;

  // s’kemi RPC “release” (strict rules), kështu që vetëm e kthejmë lokalisht në pool
  addBackToPool(pin, code);
  dbg('releaseLocksForCode:local_only', { pin, code, poolNow: getPool(pin).length });
  return true;
}

// Compatibility helper
export function takeBaseCode(pin) {
  const p = String(pin || '').trim();
  return takeFromPool(p);
}