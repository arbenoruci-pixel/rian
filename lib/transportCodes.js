import { supabase } from "@/lib/supabaseClient";

// Offline-safe transport codes: prefetch a pool of REAL T-codes from Supabase.
//
// STRATEGY
// - Keep a local POOL per actor (transport_id / PIN)
// - When online and POOL is low, reserve a batch via RPC: reserve_transport_codes_batch(p_reserved_by,p_count)
// - When offline, consume from POOL
// - If offline and POOL empty: throw a clear error (NO fake codes)

const DEFAULT_POOL_SIZE = 20;
const DEFAULT_REFILL_THRESHOLD = 5;

function safeJsonParse(s, fallback) {
  try {
    return JSON.parse(s) ?? fallback;
  } catch {
    return fallback;
  }
}

function poolKey(reservedBy) {
  const a = String(reservedBy || "APP").trim() || "APP";
  return `transport_code_pool_v1__${a}`;
}

function usedQueueKey(reservedBy) {
  const a = String(reservedBy || "APP").trim() || "APP";
  return `transport_code_used_queue_v1__${a}`;
}

// ---- AUTO-HEAL (SERVER IS SOURCE OF TRUTH) ----
// iOS PWA/Safari can keep stale pools locally. If DB was reset but a device
// still has an old pool, we wipe it automatically (no worker instructions).

function healStampKey(reservedBy) {
  const a = String(reservedBy || 'APP').trim() || 'APP';
  return `transport_code_pool_healed_v1__${a}`;
}

function parseTNum(code) {
  const m = String(code || '').match(/\d+/);
  return m ? Number(m[0]) : 0;
}

async function maybeAutoHealTransportPool(reservedBy) {
  if (typeof window === 'undefined') return;
  if (!navigator.onLine) return;

  const actor = String(reservedBy || 'APP').trim() || 'APP';

  const now = Date.now();
  const last = Number(localStorage.getItem(healStampKey(actor)) || '0') || 0;
  if (now - last < 60_000) return;
  localStorage.setItem(healStampKey(actor), String(now));

  const pool = loadPool(actor);
  if (!pool.length) return;

  const nums = pool.map(parseTNum).filter((n) => Number.isFinite(n) && n > 0);
  const localMin = nums.length ? Math.min(...nums) : 0;
  const localMax = nums.length ? Math.max(...nums) : 0;

  const wipeLocal = () => {
    try { localStorage.removeItem(poolKey(actor)); } catch {}
    try { localStorage.removeItem(usedQueueKey(actor)); } catch {}
  };

  try {
    const [{ count: tOrders, error: e1 }, { count: tPool, error: e2 }] = await Promise.all([
      supabase.from('transport_orders').select('id', { count: 'exact', head: true }),
      supabase.from('transport_code_pool').select('code', { count: 'exact', head: true }),
    ]);
    if (!e1 && !e2) {
      const oc = Number(tOrders || 0);
      const pc = Number(tPool || 0);
      const dbBrandNew = oc === 0 && pc === 0;
      if (dbBrandNew) return wipeLocal();
      if (oc <= 5 && localMin >= 200) return wipeLocal();
    }
  } catch {
    if (localMax >= 500) wipeLocal();
  }
}

function loadPool(reservedBy) {
  if (typeof window === "undefined") return [];
  const raw = localStorage.getItem(poolKey(reservedBy));
  const v = safeJsonParse(raw, []);
  return Array.isArray(v) ? v : [];
}

function savePool(reservedBy, list) {
  if (typeof window === "undefined") return;
  localStorage.setItem(poolKey(reservedBy), JSON.stringify(Array.isArray(list) ? list : []));
}

function pushUsedQueue(reservedBy, code) {
  if (typeof window === "undefined") return;
  const raw = localStorage.getItem(usedQueueKey(reservedBy));
  const q = safeJsonParse(raw, []);
  const next = Array.isArray(q) ? q : [];
  next.push({ code, used_by: reservedBy, ts: Date.now() });
  localStorage.setItem(usedQueueKey(reservedBy), JSON.stringify(next.slice(-200)));
}

async function flushUsedQueue(reservedBy) {
  if (typeof window === "undefined") return;
  const raw = localStorage.getItem(usedQueueKey(reservedBy));
  const q = safeJsonParse(raw, []);
  if (!Array.isArray(q) || q.length === 0) return;

  const remain = [];
  for (const item of q) {
    const code = item?.code;
    if (!code) continue;
    try {
      const { error } = await supabase.rpc("mark_transport_code_used", {
        p_code: code,
        p_used_by: String(reservedBy || "APP"),
      });
      if (error) throw error;
    } catch {
      remain.push(item);
    }
  }
  localStorage.setItem(usedQueueKey(reservedBy), JSON.stringify(remain));
}

async function rpcWithTimeout(promise, ms = 3500) {
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), ms));
  return Promise.race([promise, timeout]);
}

export async function refillPoolIfNeeded(reservedBy, opts = {}) {
  const poolSize = Number(opts.poolSize || DEFAULT_POOL_SIZE) || DEFAULT_POOL_SIZE;
  const threshold = Number(opts.threshold || DEFAULT_REFILL_THRESHOLD) || DEFAULT_REFILL_THRESHOLD;

  const actor = String(reservedBy || "APP").trim() || "APP";
  await maybeAutoHealTransportPool(actor);
  const pool = loadPool(actor);
  if (pool.length >= threshold) {
    // also try to flush used queue
    try {
      await flushUsedQueue(actor);
    } catch {}
    return pool;
  }

  // Try to reserve a new batch from DB
  try {
    const { data, error } = await rpcWithTimeout(
      supabase.rpc("reserve_transport_codes_batch", {
        p_reserved_by: actor,
        p_count: poolSize,
      }),
      4000
    );
    if (error) throw error;

    const codes = (data || []).map((r) => r?.code).filter(Boolean);
    const merged = [...pool, ...codes];
    savePool(actor, merged);
    return merged;
  } catch {
    // offline or DB not reachable => keep current pool
    return pool;
  }
}

export async function takeCodeFromPoolOrOnline(reservedBy) {
  const actor = String(reservedBy || "APP").trim() || "APP";
  await maybeAutoHealTransportPool(actor);

  // First, consume from pool
  const pool = loadPool(actor);
  if (pool.length > 0) {
    const code = pool[0];
    savePool(actor, pool.slice(1));

    // best-effort reconcile
    try {
      await flushUsedQueue(actor);
    } catch {}
    try {
      await refillPoolIfNeeded(actor);
    } catch {}

    return String(code);
  }

  // Pool empty: try online single reserve
  try {
    const { data, error } = await rpcWithTimeout(
      supabase.rpc("reserve_transport_code", { p_reserved_by: actor }),
      3500
    );
    if (error) throw error;
    if (!data) throw new Error("No code");

    // supports {new_code:'T68'} or 'T68'
    const code = typeof data === "string" ? data : data?.new_code;
    if (!code) throw new Error("No code");
    return String(code);
  } catch {
    // No network AND no pool => hard stop (no fake codes)
    throw new Error("S'KA RRJET DHE S'KA KODE NË REZERVË. LIDHU NË RRJET DHE BËJ REFILL (POOL)." );
  }
}

export async function markCodeUsedOrQueue(reservedBy, code) {
  const actor = String(reservedBy || "APP").trim() || "APP";
  const c = String(code || "").trim();
  if (!c) return;

  // Try online mark used; if fails, queue for later
  try {
    const { error } = await rpcWithTimeout(
      supabase.rpc("mark_transport_code_used", { p_code: c, p_used_by: actor }),
      3500
    );
    if (error) throw error;
  } catch {
    pushUsedQueue(actor, c);
  }
}

export function peekPoolCount(reservedBy) {
  return loadPool(reservedBy).length;
}

// --- Backwards compatible exports (existing pages import these names) ---
export async function reserveTransportCode(reservedBy, opts) {
  // auto-heal stale pools (no worker instructions)
  try {
    await maybeAutoHealTransportPool(reservedBy);
  } catch {}
  // Best effort: top up if needed (won't throw)
  try {
    await refillPoolIfNeeded(reservedBy, opts);
  } catch {}
  return takeCodeFromPoolOrOnline(reservedBy);
}

export async function markTransportCodeUsed(codeStr, usedBy) {
  return markCodeUsedOrQueue(usedBy, codeStr);
}

export function getTransportCodePoolCount(reservedBy) {
  return peekPoolCount(reservedBy);
}
