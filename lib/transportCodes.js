// TRANSPORT CODE LEASES + OFFLINE POOL
// Goal: generate unique T-codes online via DB leases, and still work offline by
// consuming a pre-fetched local pool per transport user.

import { supabase } from '@/lib/supabaseClient';

const POOL_PREFIX = 'transport_code_pool_v1_';

function poolKey(reservedBy) {
  return `${POOL_PREFIX}${String(reservedBy || 'TRANSPORT').trim()}`;
}

function jparse(s, fallback) {
  try {
    const v = JSON.parse(s);
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

function readPool(reservedBy) {
  if (typeof localStorage === 'undefined') return [];
  return jparse(localStorage.getItem(poolKey(reservedBy)) || '[]', []) || [];
}

function writePool(reservedBy, list) {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(poolKey(reservedBy), JSON.stringify(Array.isArray(list) ? list : []));
}

export function getTransportCodePoolCount(reservedBy) {
  try {
    return readPool(reservedBy).length;
  } catch {
    return 0;
  }
}

function normalizeT(code) {
  if (!code) return '';
  const s = String(code).trim();
  if (/^t\d+$/i.test(s)) return `T${String(s).replace(/\D+/g, '')}`;
  const n = s.replace(/\D+/g, '');
  return n ? `T${n}` : '';
}

function takeFromPool(reservedBy) {
  const pool = readPool(reservedBy);
  if (!pool.length) return '';
  const next = pool.shift();
  writePool(reservedBy, pool);
  return normalizeT(next);
}

// ONLINE: reserves next code in DB (status=RESERVED, expires_at ~ 30min)
// OFFLINE: pops from local pool
export async function reserveTransportCode(reservedBy) {
  const who = String(reservedBy || 'TRANSPORT').trim();

  // 1) Try DB first
  try {
    // Prefer named param if RPC expects it; fallback to no-arg.
    let r = await supabase.rpc('reserve_transport_code', { reserved_by: who });
    if (r?.error) r = await supabase.rpc('reserve_transport_code');
    if (r?.error) throw r.error;

    // Expected: { new_code: 'T60' } or just 'T60'
    const v = r?.data;
    const code = normalizeT(v?.new_code ?? v);
    if (code) return code;
  } catch {
    // ignore; go offline
  }

  // 2) Offline: local pool
  const local = takeFromPool(who);
  if (local) return local;

  // 3) Last resort: deterministic local fallback (not ideal, but prevents blocking)
  // NOTE: This should be avoided by keeping a small pool.
  try {
    const k = `${POOL_PREFIX}fallback_counter_${who}`;
    const cur = typeof localStorage !== 'undefined' ? Number(localStorage.getItem(k) || '0') : 0;
    const next = Number.isFinite(cur) ? cur + 1 : 1;
    if (typeof localStorage !== 'undefined') localStorage.setItem(k, String(next));
    return `T${next}`;
  } catch {
    return 'T0';
  }
}

// Marks a RESERVED code as USED in DB.
// If offline, it silently no-ops (will be reconciled later when online).
export async function markTransportCodeUsed(codeStr, usedBy) {
  const code = normalizeT(codeStr);
  if (!code) return { ok: true };
  const who = String(usedBy || 'TRANSPORT').trim();

  try {
    let r = await supabase.rpc('mark_transport_code_used', { code_str: code, used_by: who });
    if (r?.error) r = await supabase.rpc('mark_transport_code_used', { code_str: code });
    if (r?.error) throw r.error;
    return { ok: true, data: r.data };
  } catch {
    return { ok: true, offline: true };
  }
}
