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

// iOS note: Safari and PWA storage can be isolated. To avoid "new code every refresh"
// AND to unify Safari/PWA when online, we use a 2-layer lease:
// 1) SERVER LEASE (Supabase) when online: get_or_reserve_transport_code_lease()
// 2) LOCAL LEASE (cookie + localStorage) as offline/fast cache fallback.

function cookieKey(reservedBy) {
  const a = String(reservedBy || "APP").trim() || "APP";
  return `tepiha_transport_lease_v1__${a}`;
}

function getCookie(name) {
  try {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m = document.cookie.match(new RegExp(`(?:^|; )${esc}=([^;]*)`));
    return m ? decodeURIComponent(m[1]) : null;
  } catch {
    return null;
  }
}

function setCookie(name, value, maxAgeSeconds) {
  try {
    const v = encodeURIComponent(String(value));
    const maxAge = Math.max(0, Number(maxAgeSeconds) || 0);
    document.cookie = `${name}=${v}; Max-Age=${maxAge}; Path=/; SameSite=Lax`;
  } catch {
    // ignore
  }
}

function leaseKey(reservedBy) {
  const a = String(reservedBy || "APP").trim() || "APP";
  return `transport_code_lease_v1__${a}`;
}

function getLocalLease(reservedBy) {
  try {
    if (typeof window === "undefined") return null;
    const actor = String(reservedBy || "APP").trim() || "APP";

    // 1) cookie: "T123.1700000000000"
    const ck = getCookie(cookieKey(actor));
    if (ck) {
      const parts = String(ck).split(".");
      const code = String(parts[0] || "").trim();
      const exp = Number(parts[1] || 0);
      if (code && Number.isFinite(exp) && exp > Date.now() - 60_000) {
        return { code, expires_at: exp };
      }
    }

    // 2) localStorage mirror
    const raw = localStorage.getItem(leaseKey(actor));
    const v = safeJsonParse(raw, null);
    if (!v || typeof v !== "object") return null;
    const code = String(v.code || "").trim();
    const exp = Number(v.expires_at || 0);
    if (!code) return null;
    if (!Number.isFinite(exp) || exp <= 0) return null;
    return { code, expires_at: exp };
  } catch {
    return null;
  }
}

function setLocalLease(reservedBy, code, expiresAtMs) {
  try {
    if (typeof window === "undefined") return;
    const actor = String(reservedBy || "APP").trim() || "APP";
    setCookie(cookieKey(actor), `${String(code)}.${Number(expiresAtMs)}`, 2 * 60 * 60);
    localStorage.setItem(
      leaseKey(actor),
      JSON.stringify({ code: String(code), expires_at: Number(expiresAtMs), reserved_by: actor, t: Date.now() })
    );
  } catch {
    // ignore
  }
}

function clearLocalLease(reservedBy, codeOpt) {
  try {
    const actor = String(reservedBy || "APP").trim() || "APP";
    if (codeOpt != null) {
      const cur = getLocalLease(actor);
      if (cur && String(cur.code) !== String(codeOpt)) return;
    }
    try { localStorage.removeItem(leaseKey(actor)); } catch {}
    try { setCookie(cookieKey(actor), "", 0); } catch {}
  } catch {
    // ignore
  }
}

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


async function autoHealStaleTransportPool(reservedBy) {
  try {
    if (typeof window === "undefined") return;
    if (!navigator.onLine) return;

    // Preferred: DB_EPOCH based reset (same as base)
    try {
      const actor = String(reservedBy || "APP").trim() || "APP";
      const localEpochKey = `db_epoch_transport_v1__${actor}`;
      const localEpoch = Number(localStorage.getItem(localEpochKey) || "0");
      const { data: epochRow } = await supabase
        .from("app_meta")
        .select("value")
        .eq("key", "db_epoch")
        .maybeSingle();
      const serverEpoch = Number(epochRow?.value || "0");
      if (Number.isFinite(serverEpoch) && serverEpoch > 0) {
        if (!Number.isFinite(localEpoch) || localEpoch !== serverEpoch) {
          localStorage.removeItem(poolKey(actor));
          localStorage.removeItem(usedQueueKey(actor));
          localStorage.removeItem(leaseKey(actor));
          clearLocalLease(actor);
          try { localStorage.setItem(localEpochKey, String(serverEpoch)); } catch {}
          return;
        }
      }
    } catch {
      // ignore epoch errors; fall back to heuristic
    }

    const actor = String(reservedBy || "APP").trim() || "APP";
    const pool = loadPool(actor);
    if (!pool.length) return;

    // pool items can be "T123" or numbers/strings
    const nums = pool
      .map((c) => String(c).replace(/^T/i, ""))
      .map((s) => Number(s))
      .filter((n) => Number.isFinite(n));
    const maxLocal = nums.length ? Math.max(...nums) : NaN;
    if (!Number.isFinite(maxLocal) || maxLocal < 500) return;

    const { count, error } = await supabase
      .from("orders")
      .select("id", { count: "exact", head: true });
    if (error) return;

    if ((count ?? 0) < 5) {
      // nuke transport pool + legacy keys
      localStorage.removeItem(poolKey(actor));
      localStorage.removeItem(usedQueueKey(actor));
      const legacyKeys = ["transport_code_pool", "transport_code_pool_v1", "transport_code_pool_v0"];
      for (const k of legacyKeys) {
        try { localStorage.removeItem(k); } catch {}
      }
    }
  } catch {}
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
      const { error } = await supabase.rpc("mark_transport_code_used_from_pool", {
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
  await autoHealStaleTransportPool(reservedBy);
  const poolSize = Number(opts.poolSize || DEFAULT_POOL_SIZE) || DEFAULT_POOL_SIZE;
  const threshold = Number(opts.threshold || DEFAULT_REFILL_THRESHOLD) || DEFAULT_REFILL_THRESHOLD;

  const actor = String(reservedBy || "APP").trim() || "APP";
  const pool = loadPool(actor);
  if (pool.length >= threshold) {
    // also try to flush used queue
    try {
      await flushUsedQueue(actor);
    } catch {}
    return pool;
  }

  // how many do we actually need to reach poolSize
  const need = Math.max(0, poolSize - pool.length);
  if (need <= 0) return pool;

  // Try to reserve a new batch from DB
  try {
    const { data, error } = await rpcWithTimeout(
      supabase.rpc("reserve_transport_codes_batch_pool", {
        p_reserved_by: actor,
        p_count: need,
        p_target: poolSize,
        p_days: 7,
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
  await autoHealStaleTransportPool(reservedBy);
  const actor = String(reservedBy || "APP").trim() || "APP";

  // 0) Prevent "new code every refresh": reuse LOCAL lease if valid
  try {
    const lease = getLocalLease(actor);
    if (lease && lease.expires_at - Date.now() > 30_000) {
      return String(lease.code);
    }
    if (lease) clearLocalLease(actor, lease.code);
  } catch {
    // ignore
  }

  // 1) When online, prefer SERVER get_or_reserve (unifies Safari/PWA)
  if (typeof navigator !== "undefined" && navigator.onLine) {
    try {
      const { data, error } = await rpcWithTimeout(
        supabase.rpc("get_or_reserve_transport_code", { p_reserved_by: actor }),
        3500
      );
      if (error) throw error;

      // RPC returns a plain TEXT code (e.g., "T123")
      const code = typeof data === "string"
        ? data
        : (Array.isArray(data) ? (data[0]?.code ?? data[0]) : (data?.code ?? data));

      if (code) {
        // local lease: prevents burning codes on refresh and helps Safari/PWA stay stable
        setLocalLease(actor, String(code), Date.now() + 30 * 60 * 1000);
        return String(code);
      }
    } catch {
      // fall through to local pool
    }
  }

// First, consume from pool
  const pool = loadPool(actor);
  if (pool.length > 0) {
    const code = pool[0];
    savePool(actor, pool.slice(1));

    // set local lease so refresh does not burn codes
    try {
      setLocalLease(actor, String(code), Date.now() + 110 * 60 * 1000);
    } catch {}

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
      supabase.rpc("get_or_reserve_transport_code", { p_reserved_by: actor }),
      3500
    );
    if (error) throw error;
    if (!data) throw new Error("No code");

    // RPC returns a plain TEXT code
    const code = typeof data === "string" ? data : (data?.code ?? data);
    if (!code) throw new Error("No code");

    // local lease
    try {
      setLocalLease(actor, String(code), Date.now() + 110 * 60 * 1000);
    } catch {}
    return String(code);
  } catch {
    // No network AND no pool => hard stop (no fake codes)
    throw new Error("S'MUND TË MERRET KODI (TRANSPORT). LIDHU NË RRJET DHE PROVO PRAP." );
  }
}

export async function markCodeUsedOrQueue(reservedBy, code) {
  const actor = String(reservedBy || "APP").trim() || "APP";
  const c = String(code || "").trim();
  if (!c) return;

  // Try online mark used; if fails, queue for later
  try {
    const { error } = await rpcWithTimeout(
      supabase.rpc("mark_transport_code_used_from_pool", { p_code: c, p_used_by: actor }),
      3500
    );
    if (error) throw error;

    clearLocalLease(actor, c);
  } catch {
    pushUsedQueue(actor, c);
    clearLocalLease(actor, c);
  }
}

export function peekPoolCount(reservedBy) {
  return loadPool(reservedBy).length;
}

// --- Backwards compatible exports (existing pages import these names) ---
export async function reserveTransportCode(reservedBy, opts) {
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
