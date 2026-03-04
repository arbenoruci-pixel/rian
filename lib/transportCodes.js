// FILE: rian-main/lib/transportCodes.js
// TRANSPORT T-CODES — pool-first, same logic as BASE, but with "T" prefix.
//
// Goals:
// - TRANSPORT code system is fully separate from BASE codes.
// - Offline consumes ONLY from local reserved pool.
// - Online refills the pool via RPC (batch reserve).
// - Stable draft code across refresh via OID cache key.

import { supabase } from '@/lib/supabaseClient';

const DEFAULT_POOL_SIZE = 20;
const DEFAULT_THRESHOLD = 5;

function safeJsonParse(s, fallback = null) {
  try {
    if (!s) return fallback;
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

function poolKey(actor) {
  return `transport_code_pool_v2__${String(actor || 'APP').trim() || 'APP'}`;
}

function usedQueueKey(actor) {
  return `transport_code_used_queue_v1__${String(actor || 'APP').trim() || 'APP'}`;
}

function orderCodeKey(oid) {
  return `transport_order_code_v1__${String(oid || '').trim()}`;
}

function normalizeT(code) {
  if (!code) return '';
  const s = String(code).trim();
  if (/^t\d+$/i.test(s)) return `T${s.replace(/\D+/g, '').replace(/^0+/, '') || '0'}`;
  const n = s.replace(/\D+/g, '').replace(/^0+/, '');
  return `T${n || '0'}`;
}

function loadPool(actor) {
  try {
    const arr = safeJsonParse(localStorage.getItem(poolKey(actor)), []);
    if (!Array.isArray(arr)) return [];
    return arr.map(normalizeT).filter(Boolean);
  } catch {
    return [];
  }
}

function savePool(actor, arr) {
  try {
    localStorage.setItem(poolKey(actor), JSON.stringify((arr || []).map(normalizeT).filter(Boolean)));
  } catch {
    // ignore
  }
}

function loadUsedQueue(actor) {
  try {
    const arr = safeJsonParse(localStorage.getItem(usedQueueKey(actor)), []);
    if (!Array.isArray(arr)) return [];
    return arr.map(normalizeT).filter(Boolean);
  } catch {
    return [];
  }
}

function saveUsedQueue(actor, arr) {
  try {
    localStorage.setItem(usedQueueKey(actor), JSON.stringify((arr || []).map(normalizeT).filter(Boolean)));
  } catch {
    // ignore
  }
}

function pushUsedQueue(actor, code) {
  const q = loadUsedQueue(actor);
  const c = normalizeT(code);
  if (!c) return;
  if (!q.includes(c)) q.push(c);
  saveUsedQueue(actor, q);
}

async function flushUsedQueue(actor) {
  if (typeof navigator !== 'undefined' && !navigator.onLine) return;
  const q = loadUsedQueue(actor);
  if (q.length === 0) return;
  const remaining = [];
  for (const c of q) {
    try {
      const { error } = await supabase.rpc('mark_transport_code_used_from_pool', { p_code: c, p_used_by: actor });
      if (error) throw error;
    } catch {
      remaining.push(c);
    }
  }
  saveUsedQueue(actor, remaining);
}

async function reserveBatchFromDb(actor, need, target = DEFAULT_POOL_SIZE) {
  // Support both deployments:
  // 1) reserve_transport_codes_batch_simple(p_n)
  // 2) reserve_transport_codes_batch_pool(p_reserved_by,p_count,p_target,p_days)
  let data = null;
  let error = null;
  try {
    const r1 = await supabase.rpc('reserve_transport_codes_batch_simple', { p_n: need });
    data = r1.data;
    error = r1.error;
  } catch (e) {
    error = { message: e?.message || String(e) };
  }
  if (error) {
    try {
      const r2 = await supabase.rpc('reserve_transport_codes_batch_pool', {
        p_reserved_by: actor,
        p_count: need,
        p_target: target,
        p_days: 7,
      });
      data = r2.data;
      error = r2.error;
    } catch (e) {
      error = { message: e?.message || String(e) };
    }
  }
  if (error) return [];
  if (!Array.isArray(data)) return [];
  return data.map((r) => normalizeT(r?.code ?? r)).filter(Boolean);
}

export async function refillPoolIfNeeded(reservedBy, opts = {}) {
  const actor = String(reservedBy || 'APP').trim() || 'APP';
  const threshold = Number(opts.threshold ?? DEFAULT_THRESHOLD);
  const poolSize = Number(opts.poolSize ?? DEFAULT_POOL_SIZE);

  const pool = loadPool(actor);
  if (pool.length >= threshold) {
    try { await flushUsedQueue(actor); } catch {}
    return pool;
  }

  if (typeof navigator !== 'undefined' && !navigator.onLine) return pool;

  const need = Math.max(0, poolSize - pool.length);
  if (need <= 0) return pool;

  const codes = await reserveBatchFromDb(actor, need, poolSize);
  if (codes.length > 0) {
    const merged = [...pool, ...codes];
    savePool(actor, merged);
    return merged;
  }
  return pool;
}

export function peekPoolCount(reservedBy) {
  const actor = String(reservedBy || 'APP').trim() || 'APP';
  return loadPool(actor).length;
}

export async function takeCodeFromPoolOrOnline(reservedBy) {
  const actor = String(reservedBy || 'APP').trim() || 'APP';

  // 1) consume from pool (offline-safe)
  const pool = loadPool(actor);
  if (pool.length > 0) {
    const code = pool[0];
    savePool(actor, pool.slice(1));
    try { void flushUsedQueue(actor); } catch {}
    try { void refillPoolIfNeeded(actor); } catch {}
    return String(code);
  }

  // 2) pool empty, try online refill then consume
  if (typeof navigator !== 'undefined' && navigator.onLine) {
    try {
      await refillPoolIfNeeded(actor, { threshold: 1, poolSize: DEFAULT_POOL_SIZE });
      const pool2 = loadPool(actor);
      if (pool2.length > 0) {
        const code = pool2[0];
        savePool(actor, pool2.slice(1));
        return String(code);
      }
    } catch {
      // ignore
    }
  }

  throw new Error("S'KA T-KOD NE POOL. LIDHU ONLINE QE ME REZERVU 20 T-KODA.");
}

export async function markCodeUsedOrQueue(reservedBy, code) {
  const actor = String(reservedBy || 'APP').trim() || 'APP';
  const c = normalizeT(code);
  if (!c) return;
  try {
    if (typeof navigator !== 'undefined' && !navigator.onLine) throw new Error('offline');
    const { error } = await supabase.rpc('mark_transport_code_used_from_pool', { p_code: c, p_used_by: actor });
    if (error) throw error;
  } catch {
    pushUsedQueue(actor, c);
  }
}

// --- Backwards-compatible exports (existing pages import these names) ---
export async function reserveTransportCode(reservedBy, opts = {}) {
  const actor = String(reservedBy || 'APP').trim() || 'APP';
  const oid = opts?.oid ? String(opts.oid) : '';

  // stable draft code per OID (like BASE)
  if (oid && typeof window !== 'undefined') {
    try {
      const cached = localStorage.getItem(orderCodeKey(oid));
      if (cached && String(cached).trim()) return String(cached).trim();
    } catch {}
  }

  try { await refillPoolIfNeeded(actor, opts); } catch {}

  const code = await takeCodeFromPoolOrOnline(actor);
  if (oid && typeof window !== 'undefined') {
    try { localStorage.setItem(orderCodeKey(oid), String(code)); } catch {}
  }
  return code;
}

export async function markTransportCodeUsed(codeStr, usedBy) {
  return markCodeUsedOrQueue(usedBy, codeStr);
}

export function getTransportCodePoolCount(reservedBy) {
  return peekPoolCount(reservedBy);
}
