import { supabase } from "@/lib/supabaseClient";

// Offline-safe transport codes: prefetch a pool of real T-codes from Supabase.
//
// PRO FIX:
// iOS Safari / HomeScreen can keep old localStorage pools even after DB reset.
// This file auto-heals the pool when online if server is "fresh" but local pool starts at big numbers (e.g. 700).

const DEFAULT_POOL_SIZE = 20;
const DEFAULT_REFILL_THRESHOLD = 5;

function safeJsonParse(s, fallback) {
  try { return JSON.parse(s) ?? fallback; } catch { return fallback; }
}

function poolKey(reservedBy) {
  const a = String(reservedBy || 'APP').trim() || 'APP';
  return `transport_code_pool_v1__${a}`;
}

function usedQueueKey(reservedBy) {
  const a = String(reservedBy || 'APP').trim() || 'APP';
  return `transport_code_used_queue_v1__${a}`;
}

function loadPool(reservedBy) {
  if (typeof window === 'undefined') return [];
  const raw = localStorage.getItem(poolKey(reservedBy));
  const v = safeJsonParse(raw, []);
  return Array.isArray(v) ? v : [];
}

function savePool(reservedBy, list) {
  if (typeof window === 'undefined') return;
  localStorage.setItem(poolKey(reservedBy), JSON.stringify(Array.isArray(list) ? list : []));
}

function nukeLocalPool(reservedBy) {
  if (typeof window === 'undefined') return;
  try {
    localStorage.removeItem(poolKey(reservedBy));
    localStorage.removeItem(usedQueueKey(reservedBy));
  } catch {}
}

function codeNum(code) {
  const n = Number(String(code || '').replace(/\D+/g, '') || '0');
  return Number.isFinite(n) ? n : 0;
}

function minPoolNum(pool) {
  let m = Infinity;
  for (const c of (Array.isArray(pool) ? pool : [])) {
    const n = codeNum(c);
    if (n > 0) m = Math.min(m, n);
  }
  return m === Infinity ? null : m;
}

function pushUsedQueue(reservedBy, code) {
  if (typeof window === 'undefined') return;
  const raw = localStorage.getItem(usedQueueKey(reservedBy));
  const q = safeJsonParse(raw, []);
  const next = Array.isArray(q) ? q : [];
  next.push({ code, used_by: reservedBy, ts: Date.now() });
  localStorage.setItem(usedQueueKey(reservedBy), JSON.stringify(next.slice(-200)));
}

async function flushUsedQueue(reservedBy) {
  if (typeof window === 'undefined') return;
  const raw = localStorage.getItem(usedQueueKey(reservedBy));
  const q = safeJsonParse(raw, []);
  if (!Array.isArray(q) || q.length === 0) return;

  const remain = [];
  for (const item of q) {
    const code = item?.code;
    if (!code) continue;
    try {
      const { error } = await supabase.rpc('mark_transport_code_used', { p_code: code, p_used_by: reservedBy });
      if (error) throw error;
    } catch {
      remain.push(item);
    }
  }
  localStorage.setItem(usedQueueKey(reservedBy), JSON.stringify(remain));
}

async function rpcWithTimeout(promise, ms = 3500) {
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), ms));
  return Promise.race([promise, timeout]);
}

async function getServerMaxTransportCode() {
  // Safe peek: read the biggest code already created in transport_orders.
  try {
    const { data, error } = await supabase
      .from('transport_orders')
      .select('code_n')
      .order('code_n', { ascending: false })
      .limit(1);
    if (error) return null;
    return Number(data?.[0]?.code_n ?? 0) || 0;
  } catch {
    return null;
  }
}

async function autoHealTransportPoolIfNeeded(reservedBy) {
  if (typeof window === 'undefined') return;
  if (!navigator.onLine) return;

  const pool = loadPool(reservedBy);
  const localMin = minPoolNum(pool);
  if (!localMin) return;
  if (localMin < 200) return;

  const serverMax = await getServerMaxTransportCode();
  if (serverMax === null) return;

  const freshSystem = serverMax <= 0 || serverMax < 50;
  if (!freshSystem) return;

  // local is clearly stale (e.g. 700) while server is fresh -> nuke & refill
  nukeLocalPool(reservedBy);
  try { await refillPoolIfNeeded(reservedBy, { force: true }); } catch {}
}

export async function refillPoolIfNeeded(reservedBy, opts = {}) {
  const poolSize = Number(opts.poolSize || DEFAULT_POOL_SIZE) || DEFAULT_POOL_SIZE;
  const threshold = Number(opts.threshold || DEFAULT_REFILL_THRESHOLD) || DEFAULT_REFILL_THRESHOLD;
  const force = Boolean(opts.force);

  const pool = loadPool(reservedBy);

  // Heal first (prevents stale local pools)
  try { await autoHealTransportPoolIfNeeded(reservedBy); } catch {}

  const pool2 = loadPool(reservedBy);
  if (!force && pool2.length >= threshold) {
    try { await flushUsedQueue(reservedBy); } catch {}
    return pool2;
  }

  try {
    const { data, error } = await rpcWithTimeout(
      supabase.rpc('reserve_transport_codes_batch', { p_reserved_by: String(reservedBy || 'APP'), p_count: poolSize }),
      4000
    );
    if (error) throw error;

    const codes = (data || []).map(r => r?.code).filter(Boolean);

    // If we just healed / or server is fresh, overwrite instead of merging
    const existing = loadPool(reservedBy);
    const existingMin = minPoolNum(existing);
    const newMin = minPoolNum(codes);

    const shouldOverwrite =
      (newMin && newMin < 50) && (existingMin && existingMin > 200);

    const next = shouldOverwrite ? codes : [...existing, ...codes];
    savePool(reservedBy, next);
    return next;
  } catch {
    return loadPool(reservedBy);
  }
}

export async function takeCodeFromPoolOrOnline(reservedBy) {
  const actor = String(reservedBy || 'APP').trim() || 'APP';

  // Online: heal stale pools before consuming
  if (typeof window !== 'undefined' && navigator.onLine) {
    try { await autoHealTransportPoolIfNeeded(actor); } catch {}
  }

  const pool = loadPool(actor);
  if (pool.length > 0) {
    const code = pool[0];
    savePool(actor, pool.slice(1));
    try { await flushUsedQueue(actor); } catch {}
    try { await refillPoolIfNeeded(actor); } catch {}
    return code;
  }

  try {
    const { data, error } = await rpcWithTimeout(
      supabase.rpc('reserve_transport_code', { p_reserved_by: actor }),
      3500
    );
    if (error) throw error;
    if (!data) throw new Error('No code');
    return data;
  } catch {
    throw new Error("S'KA RRJET DHE S'KA KODE NË REZERVË. LIDHU NË RRJET DHE BËJ REFILL (POOL).");
  }
}

export async function markCodeUsedOrQueue(reservedBy, code) {
  const actor = String(reservedBy || 'APP').trim() || 'APP';
  const c = String(code || '').trim();
  if (!c) return;

  try {
    const { error } = await rpcWithTimeout(
      supabase.rpc('mark_transport_code_used', { p_code: c, p_used_by: actor }),
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
