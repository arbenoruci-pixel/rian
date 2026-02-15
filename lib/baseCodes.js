import { supabase } from "@/lib/supabaseClient";

// --- DB EPOCH (AUTO FACTORY RESET) ---
// Requirement: app must NOT reuse old local codes after DB reset.
// We keep a server-side epoch in public.app_meta (key='db_epoch') and bake it
// into ALL localStorage keys + the shared lease cookie name.
// When epoch changes, old local data becomes unreachable automatically.

const DB_EPOCH_LS_KEY = "tepiha_db_epoch_v1";
let __epochCache = null;
let __epochFetchedAt = 0;

function getLocalEpoch() {
  try {
    const v = String(localStorage.getItem(DB_EPOCH_LS_KEY) || "1").trim();
    return v && v.length < 40 ? v : "1";
  } catch {
    return "1";
  }
}

async function ensureDbEpoch() {
  try {
    if (typeof window === "undefined") return getLocalEpoch();

    // If we fetched recently, reuse cache (avoid spamming DB)
    if (__epochCache && (Date.now() - __epochFetchedAt) < 30_000) return __epochCache;

    // Start from local (works offline)
    let epoch = getLocalEpoch();

    // If online, fetch server epoch
    if (navigator.onLine) {
      const { data, error } = await supabase
        .from("app_meta")
        .select("value")
        .eq("key", "db_epoch")
        .maybeSingle();
      if (!error && data?.value != null) {
        const serverEpoch = String(data.value).trim();
        if (serverEpoch && serverEpoch !== epoch) {
          try { localStorage.setItem(DB_EPOCH_LS_KEY, serverEpoch); } catch {}
          epoch = serverEpoch;
        }
      }
    }

    __epochCache = epoch;
    __epochFetchedAt = Date.now();
    return epoch;
  } catch {
    const e = getLocalEpoch();
    __epochCache = e;
    __epochFetchedAt = Date.now();
    return e;
  }
}

function epochSuffix() {
  const e = __epochCache || getLocalEpoch();
  return `e${e}`;
}

// NOTE (iOS PWA): Safari tab storage and "Add to Home Screen" (standalone) storage
// can be separated. That makes the "leased code" look different depending on how
// you opened the app.
// Fix: keep the CURRENT LEASE in a cookie as the shared cross-context store.
// (localStorage is still used as a secondary mirror + for the pool).

function cookieKey(pin) {
  return `tepiha_base_lease_v1__${epochSuffix()}__${pin || "APP"}`;
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

function jparse(s, fallback) {
  try {
    const v = JSON.parse(s);
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

function poolKey(pin) {
  return `base_code_pool_v1__${epochSuffix()}__${pin || "APP"}`;
}
function usedKey(pin) {
  return `base_code_used_queue_v1__${epochSuffix()}__${pin || "APP"}`;
}
function leaseKey(pin) {
  return `base_code_lease_v1__${epochSuffix()}__${pin || "APP"}`;
}

function getLease(pin) {
  // 1) cookie (shared between Safari + installed PWA)
  const ck = getCookie(cookieKey(pin));
  if (ck) {
    const parts = String(ck).split(".");
    const code = Number(parts[0]);
    const exp = Number(parts[1]);
    if (Number.isFinite(code) && code > 0 && Number.isFinite(exp) && exp > 0) {
      return { code, expires_at: exp };
    }
  }

  // 2) localStorage (fallback)
  const v = jparse(localStorage.getItem(leaseKey(pin)), null);
  if (!v || typeof v !== "object") return null;
  const code = Number(v.code);
  const exp = Number(v.expires_at || 0);
  if (!Number.isFinite(code) || code <= 0) return null;
  if (!Number.isFinite(exp) || exp <= 0) return null;
  return { code, expires_at: exp };
}

function setLease(pin, code, expiresAtMs) {
  // cookie stores: "<code>.<expiresAtMs>" for max 2h
  setCookie(cookieKey(pin), `${Number(code)}.${Number(expiresAtMs)}`, 2 * 60 * 60);

  localStorage.setItem(
    leaseKey(pin),
    JSON.stringify({
      code: Number(code),
      expires_at: Number(expiresAtMs),
      reserved_by: String(pin),
      reserved_at: Date.now(),
    })
  );
}

function clearLease(pin, codeOpt) {
  try {
    if (codeOpt != null) {
      const cur = getLease(pin);
      if (cur && Number(cur.code) !== Number(codeOpt)) return;
    }
  } catch {}
  try {
    localStorage.removeItem(leaseKey(pin));
  } catch {}

  // clear cookie too
  try {
    setCookie(cookieKey(pin), "", 0);
  } catch {}
}

// Try hard to find the current actor PIN (same idea as transport).
export function getActorPin() {
  const a = jparse(localStorage.getItem("CURRENT_USER_DATA"), null);
  if (a?.pin) return String(a.pin);
  if (a?.PIN) return String(a.PIN);

  const s1 = jparse(localStorage.getItem("tepiha_session_v1"), null);
  if (s1?.pin) return String(s1.pin);
  if (s1?.PIN) return String(s1.PIN);

  const s2 = jparse(localStorage.getItem("tepiha_transport_session_v1"), null);
  if (s2?.transport_id) return String(s2.transport_id);

  // fallback: last known pin
  const last = localStorage.getItem("last_pin") || localStorage.getItem("admin_pin");
  if (last) return String(last);

  return "APP";
}

export function getBasePool(pin) {
  const arr = jparse(localStorage.getItem(poolKey(pin)), []);
  return Array.isArray(arr) ? arr : [];
}

export function setBasePool(pin, arr) {
  localStorage.setItem(poolKey(pin), JSON.stringify(Array.isArray(arr) ? arr : []));
}

export function poolCount(pin) {
  return getBasePool(pin).length;
}

// Settings:
// User requirement: keep a SMALL per-user pool that is always topped up.
// Target: user always has ~20 reserved codes available.
const TARGET_POOL = 20;

// AUTO-HEAL: if device has stale local pool (Safari/HomeScreen) after DB reset,
// discard huge local codes when server appears "fresh".
async function autoHealStalePool(pin) {
  try {
    if (typeof window === "undefined") return;
    await ensureDbEpoch();
    if (!navigator.onLine) return;
    const pool = getBasePool(pin);
    if (!pool.length) return;

    // If the server has NO reserved codes for this actor, but the device has a pool,
    // it's almost always stale Safari/PWA storage after a DB reset or environment swap.
    // (Fixes cases like local showing 151/50999 even after DB reset to 1.)
    const { count: serverReserved, error: e1 } = await supabase
      .from("base_code_pool")
      .select("code", { count: "exact", head: true })
      .eq("reserved_by", String(pin))
      .eq("status", "reserved");
    if (e1) return;

    if ((serverReserved ?? 0) === 0) {
      // Check server freshness (cheap HEAD+count)
      const { count, error } = await supabase
        .from("orders")
        .select("id", { count: "exact", head: true });
      if (error) return;

      if ((count ?? 0) < 5) {
        // Nuke local pool + leases for this actor
        try { resetBasePoolLocal(pin); } catch {}
        try { clearLease(pin); } catch {}

        // Also remove legacy/global keys that used to affect codes
        const legacyKeys = [
          "base_code_pool",
          "base_code_pool_v1",
          "code_counter",
          "client_code_counter",
          "tepiha_code_counter",
          "base_code_pool_v0",
        ];
        for (const k of legacyKeys) {
          try { localStorage.removeItem(k); } catch {}
        }
      }
    }
  } catch {
    // ignore
  }
}

// If pool drops below this, top up back to TARGET_POOL.
const REFILL_THRESHOLD = 19;

export async function ensureBasePool(pin, target = TARGET_POOL) {
  await ensureDbEpoch();
  await autoHealStalePool(pin);
  if (!navigator.onLine) return;
  const cur = getBasePool(pin);
  if (cur.length >= Number(target || TARGET_POOL)) return;

  const need = Math.max(0, Number(target || TARGET_POOL) - cur.length);
  if (need <= 0) return;

  // Reserve a batch on the server.
  // NOTE: If Supabase side has a stale sequence, it can throw 23505 (duplicate key).
  // In that case we surface the real error so you can run the one-shot SQL fix.
  const { data, error } = await supabase.rpc("reserve_base_codes_batch", {
    p_reserved_by: String(pin),
    p_count: need,
  });
  if (error) {
    // Preserve full error details for UI/debug.
    throw error;
  }

  const codes = (data || [])
    .map((r) => Number(r?.code))
    .filter((n) => Number.isFinite(n) && n > 0);

  // Merge + de-dup
  const merged = [...cur, ...codes];
  const uniq = Array.from(new Set(merged));
  uniq.sort((a, b) => a - b);
  setBasePool(pin, uniq);
}

// Backwards compat name used by some pages
export async function refillBasePoolIfNeeded(pin) {
  const cur = getBasePool(pin);
  if (!navigator.onLine) return;
  if (cur.length > REFILL_THRESHOLD) return;
  return ensureBasePool(pin, TARGET_POOL);
}

export async function takeBaseCode(pin) {
  await ensureDbEpoch();
  await autoHealStalePool(pin);

  // IMPORTANT: prevent "new code every refresh".
  // If we already leased a code for this actor and it hasn't expired,
  // reuse it until the order is saved (then mark used & clear lease).
  try {
    const lease = getLease(pin);
    if (lease && lease.expires_at - Date.now() > 30_000) {
      return Number(lease.code);
    }
    if (lease) clearLease(pin);
  } catch {
    // ignore
  }
  // Try local pool first
  const cur = getBasePool(pin);
  if (cur.length > 0) {
    const code = cur.shift();
    setBasePool(pin, cur);
    // Local lease: align with DB 2h lease, but keep a conservative client expiry.
    setLease(pin, Number(code), Date.now() + 110 * 60 * 1000);
    return Number(code);
  }

  // If offline and pool empty => can't safely create a new global code
  if (!navigator.onLine) {
    throw new Error("NO_POOL_OFFLINE");
  }

  // Online: refill then take
  await refillBasePoolIfNeeded(pin);
  const again = getBasePool(pin);
  if (again.length > 0) {
    const code = again.shift();
    setBasePool(pin, again);
    setLease(pin, Number(code), Date.now() + 110 * 60 * 1000);
    return Number(code);
  }

  // Last resort: reserve one (should be rare)
  const { data, error } = await supabase.rpc("reserve_base_code", {
    p_reserved_by: String(pin),
  });
  if (error) throw error;
  setLease(pin, Number(data), Date.now() + 110 * 60 * 1000);
  return Number(data);
}

async function rpcMarkUsed(code, usedBy) {
  // DB naming drift: some deployments use mark_tepiha_code_used.
  // Try new name first, then legacy.
  {
    const { error } = await supabase.rpc("mark_tepiha_code_used", {
      p_code: Number(code),
      p_used_by: String(usedBy),
    });
    if (!error) return;
  }
  {
    const { error } = await supabase.rpc("mark_base_code_used", {
      p_code: Number(code),
      p_used_by: String(usedBy),
    });
    if (error) throw error;
  }
}

export async function markBaseCodeUsedOrQueue(pin, code) {
  const n = Number(code);
  if (!Number.isFinite(n) || n <= 0) return;

  // Offline => queue
  if (!navigator.onLine) {
    const q = jparse(localStorage.getItem(usedKey(pin)), []);
    q.push({ code: n, used_by: String(pin), t: Date.now() });
    localStorage.setItem(usedKey(pin), JSON.stringify(q));
    clearLease(pin, n);
    return;
  }

  await rpcMarkUsed(n, pin);
  clearLease(pin, n);
}

export async function flushBaseUsedQueue(pin) {
  if (!navigator.onLine) return;
  const key = usedKey(pin);
  const q = jparse(localStorage.getItem(key), []);
  if (!Array.isArray(q) || q.length === 0) return;

  const keep = [];
  for (const it of q) {
    try {
      await rpcMarkUsed(Number(it.code), String(it.used_by || pin));
    } catch {
      keep.push(it);
    }
  }
  localStorage.setItem(key, JSON.stringify(keep));
}

// Optional helper for manual resets (local only)
export function resetBasePoolLocal(pin) {
  // remove for this pin only
  localStorage.removeItem(poolKey(pin));
  localStorage.removeItem(usedKey(pin));
  localStorage.removeItem(leaseKey(pin));
}
