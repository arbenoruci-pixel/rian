// lib/transportCodes.js
// Permanent T-codes for transport orders (T1, T2, ...). Never reset in DB.
// Source-of-truth: Supabase Storage bucket "tepiha-photos" folder "t_codes" (used markers).
// Local fallback: localStorage 'transport_code_counter'.

import { supabase } from '@/lib/supabaseClient';

const BUCKET = 'tepiha-photos';

function normalizeN(v) {
  if (v === null || v === undefined) return 0;
  const n = parseInt(String(v).replace(/\D+/g, ''), 10);
  return Number.isFinite(n) ? n : 0;
}

async function listUsedNums() {
  const { data } = await supabase.storage.from(BUCKET).list('t_codes', { limit: 1000 });
  const used = new Set();
  let maxUsed = 0;
  for (const it of data || []) {
    const m = String(it.name || '').match(/^(\d+)\.(used|lock)/);
    if (m) {
      const n = Number(m[1]);
      used.add(n);
      if (n > maxUsed) maxUsed = n;
    }
  }
  return { used, maxUsed };
}

export async function reserveTransportCode() {
  // Goal: always pick the next free number after the highest USED number.
  // This prevents jumps like T32 caused by stale localStorage counters.
  try {
    const { used, maxUsed } = await listUsedNums();
    const local = normalizeN(localStorage.getItem('transport_code_counter'));

    // Candidate is max(maxUsed, local) + 1, but if local is far ahead, prefer maxUsed+1.
    let candidate = Math.max(maxUsed, local) + 1;
    if (local > maxUsed + 5) candidate = maxUsed + 1; // pull back from stale counters
    if (!candidate) candidate = 1;

    while (used.has(candidate)) candidate++;

    // Try to create a lock file (best-effort). If fails, fallback to local counter.
    const lockName = `t_codes/${candidate}.${Date.now()}.lock`;
    const file = typeof File !== 'undefined' ? new File([String(Date.now())], 'lock.txt', { type: 'text/plain' }) : null;

    if (file) {
      const { error: upErr } = await supabase.storage.from(BUCKET).upload(lockName, file, { upsert: false });
      if (upErr) {
        const n = normalizeN(localStorage.getItem('transport_code_counter')) + 1;
        localStorage.setItem('transport_code_counter', String(n));
        return `T${n}`;
      }
    }

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
    const file = typeof File !== 'undefined' ? new File([blob], 'used.json', { type: 'application/json' }) : null;
    if (!file) return;
    await supabase.storage.from(BUCKET).upload(usedPath, file, { upsert: true });
  } catch {
    // ignore
  }
}
