// lib/transportCodes.js
// Permanent T-codes for transport orders (T1, T2, ...). Never reset.

import { supabase } from '@/lib/supabaseClient';

const BUCKET = 'tepiha-photos';

function normalizeN(v) {
  if (v === null || v === undefined) return 0;
  const n = parseInt(String(v).replace(/\D+/g, ''), 10);
  return Number.isFinite(n) ? n : 0;
}

export async function reserveTransportCode() {
  // Try shared lock in bucket first, fallback to local counter.
  try {
    const { data: existing } = await supabase.storage.from(BUCKET).list('t_codes', { limit: 1000 });
    const used = new Set();
    for (const it of existing || []) {
      const m = String(it.name || '').match(/^(\d+)\.(used|lock)/);
      if (m) used.add(Number(m[1]));
    }

    let candidate = normalizeN(localStorage.getItem('transport_code_counter')) + 1;
    if (!candidate) candidate = 1;

    // move up to next free
    while (used.has(candidate)) candidate++;

    const lockName = `t_codes/${candidate}.${Date.now()}.lock`;
    const file =
      typeof File !== 'undefined'
        ? new File([String(Date.now())], 'lock.txt', { type: 'text/plain' })
        : null;

    if (file) {
      const { error: upErr } = await supabase.storage.from(BUCKET).upload(lockName, file, { upsert: false });
      if (upErr) {
        // fallback local
        const n = normalizeN(localStorage.getItem('transport_code_counter')) + 1;
        localStorage.setItem('transport_code_counter', String(n));
        return `T${n}`;
      }
    }

    // lock ok, bump local hint counter
    localStorage.setItem('transport_code_counter', String(candidate));
    return `T${candidate}`;
  } catch {
    const n = normalizeN(localStorage.getItem('transport_code_counter')) + 1;
    localStorage.setItem('transport_code_counter', String(n));
    return `T${n}`;
  }
}

export async function markTransportCodeUsed(tCode) {
  try {
    const n = normalizeN(tCode);
    if (!n) return;
    const usedPath = `t_codes/${n}.used`;
    const blob = new Blob([JSON.stringify({ at: new Date().toISOString(), code: `T${n}` })], { type: 'application/json' });
    const file =
      typeof File !== 'undefined' ? new File([blob], 'used.json', { type: 'application/json' }) : null;
    if (!file) return;
    await supabase.storage.from(BUCKET).upload(usedPath, file, { upsert: true });
  } catch {
    // ignore
  }
}
