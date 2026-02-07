// TRANSPORT CODES (T1, T2, ...)
//
// Goal:
// 1) Never duplicate codes across devices/users.
// 2) Work even when there is NO network.
//
// Strategy:
// - Online: reserve codes from Supabase via RPC `reserve_transport_code`.
// - Keep a small local POOL of already-reserved codes (per user/device).
// - Offline: take the next code from the local pool.
// - When a code is actually saved to DB, mark it USED via RPC `mark_transport_code_used`.
//
// NOTE: This mirrors the base `lib/codeLease.js` pattern, but adds offline pooling.

import { supabase } from '@/lib/supabaseClient';

const POOL_TARGET = 6;      // keep this many codes locally when online
const POOL_MIN_REFILL = 2;  // when pool < this, auto-refill

function safeNow() {
  return Date.now();
}

function poolKey(reservedBy) {
  const key = String(reservedBy || 'DEVICE').replace(/\s+/g, '_');
  return `transport_code_pool_v1_${key}`;
}

function normalizeTCode(code) {
  if (!code) return '';
  const s = String(code).trim();
  // Accept: "T60" | "t60" | "60" | "T060"
  const n = s.replace(/\D+/g, '').replace(/^0+/, '');
  if (!n) return '';
  return `T${n}`;
}

function readPool(reservedBy) {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(poolKey(reservedBy));
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function writePool(reservedBy, arr) {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(poolKey(reservedBy), JSON.stringify(arr || []));
  } catch {
    // ignore
  }
}

function poolCount(reservedBy) {
  return readPool(reservedBy).length;
}

async function rpcReserveOne(reservedBy) {
  // We only assume `p_reserved_by` exists (same as base `reserve_tepiha_code`).
  const { data, error } = await supabase.rpc('reserve_transport_code', {
    p_reserved_by: String(reservedBy || 'DEVICE'),
  });
  if (error) throw error;

  // Support multiple shapes: { new_code: 'T60' } OR 'T60'
  const code = typeof data === 'string' ? data : (data?.new_code ?? data?.code ?? data);
  const t = normalizeTCode(code);
  if (!t) throw new Error('reserve_transport_code returned empty code');
  return t;
}

async function isOnlineFast() {
  // cheap online check: quick RPC call with short timeout
  try {
    const p = supabase.from('transport_orders').select('id').limit(1);
    const t = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 1500));
    await Promise.race([p, t]);
    return true;
  } catch {
    return false;
  }
}

async function ensurePool(reservedBy) {
  // If offline, do nothing.
  const online = await isOnlineFast();
  if (!online) return;

  let pool = readPool(reservedBy);
  const need = POOL_TARGET - pool.length;
  if (need <= 0) return;

  // Reserve sequentially to avoid any race.
  for (let i = 0; i < need; i++) {
    try {
      const code = await rpcReserveOne(reservedBy);
      // Keep unique
      if (!pool.includes(code)) pool.push(code);
    } catch (e) {
      console.error('[transportCodes] ensurePool reserve failed:', e);
      break;
    }
  }

  writePool(reservedBy, pool);
}

export function getTransportCodePoolCount(reservedBy) {
  return poolCount(reservedBy);
}

export async function reserveTransportCode(reservedBy) {
  const by = String(reservedBy || 'DEVICE');

  // 1) Try local pool first (fast & offline-safe)
  let pool = readPool(by);
  if (pool.length > 0) {
    const code = normalizeTCode(pool.shift());
    writePool(by, pool);

    // background refill if low (do not block)
    if (pool.length < POOL_MIN_REFILL) {
      ensurePool(by).catch(() => {});
    }

    return code;
  }

  // 2) If pool is empty, try online reserve
  try {
    const code = await rpcReserveOne(by);

    // After taking 1, refill pool in background
    ensurePool(by).catch(() => {});

    return code;
  } catch (e) {
    console.error('[transportCodes] reserveTransportCode failed (offline & pool empty):', e);
    throw new Error('S’ka rrjet dhe pool i kodeve është bosh. Lidhu 1 minutë me rrjet që ta mbushim pool-in.');
  }
}

export async function markTransportCodeUsed(codeStr, usedBy) {
  const code = normalizeTCode(codeStr);
  if (!code) return;

  // Best-effort: if offline, ignore and it will be "USED" next time online
  try {
    const { error } = await supabase.rpc('mark_transport_code_used', {
      p_code: code,
      p_used_by: String(usedBy || 'DEVICE'),
      p_used_at: new Date(safeNow()).toISOString(),
    });
    if (error) throw error;
  } catch (e) {
    console.warn('[transportCodes] markTransportCodeUsed failed (ignored):', e);
  }
}

export function dropTransportCodeFromPool(reservedBy, codeStr) {
  // Utility: remove a code from local pool (if it was used/invalid)
  const by = String(reservedBy || 'DEVICE');
  const code = normalizeTCode(codeStr);
  if (!code) return;
  const pool = readPool(by).filter((c) => normalizeTCode(c) !== code);
  writePool(by, pool);
}
