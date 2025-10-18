// /assets/home.counters.js — REST version compatible with /assets/supabase.js
// Uses your SUPABASE_URL / SUPABASE_ANON; no supabase-js client required.

import { SUPABASE_URL, SUPABASE_ANON } from '/assets/supabase.js';

// ---------- headers ----------
function baseHeaders() {
  return {
    apikey: SUPABASE_ANON,
    Authorization: `Bearer ${SUPABASE_ANON}`,
  };
}

// For accurate counts, PostgREST must receive Prefer: count=exact and any Range header
function countHeaders() {
  return {
    ...baseHeaders(),
    Prefer: 'count=exact',
    Range: '0-0',               // tiny range; we only care about Content-Range */N
    Accept: 'application/json',
  };
}

// ---------- generic head-count helper ----------
async function headCount(filters) {
  const url = new URL(`${SUPABASE_URL}/rest/v1/orders`);
  url.searchParams.set('select', 'id');

  if (filters) {
    for (const [k, v] of Object.entries(filters)) {
      if (Array.isArray(v)) v.forEach(v2 => url.searchParams.append(k, v2));
      else url.searchParams.set(k, v);
    }
  }

  try {
    const r = await fetch(url.toString(), { method: 'GET', headers: countHeaders() });
    const cr = r.headers.get('Content-Range'); // e.g. "0-0/12"
    if (cr && cr.includes('/')) {
      const total = Number(cr.split('/').pop());
      return Number.isFinite(total) ? total : 0;
    }
    // fallback if server didn’t return header
    const data = await r.json().catch(() => []);
    return Array.isArray(data) ? data.length : 0;
  } catch (e) {
    console.warn('[headCount error]', e);
    return 0;
  }
}

// ---------- public API (used by index.html) ----------
export async function countStatus(status) {
  // expects your statuses: 'pranim', 'pastrim', 'gati', ...
  return headCount({ status: `eq.${status}` });
}

// unfinished = completed_at IS NULL  (change if your logic differs)
export async function countUnfinished() {
  return headCount({ 'completed_at': 'is.null' });
}

// "MARRJE SOT" = ready today (status='gati' AND ready_at ∈ today)
// If your schema has no ready_at, we fallback to created_at.
export async function countReadyToday() {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const end = new Date(start); end.setDate(start.getDate() + 1);

  // primary: ready_at between [start, end)
  const n1 = await headCount({
    status: 'eq.gati',
    ready_at: [`gte.${start.toISOString()}`, `lt.${end.toISOString()}`],
  });
  if (n1 > 0) return n1;

  // fallback: created_at window, in case you don't store ready_at
  const n2 = await headCount({
    status: 'eq.gati',
    created_at: [`gte.${start.toISOString()}`, `lt.${end.toISOString()}`],
  });
  return n2;
}

// € income from delivered orders today (status='dorzim' with picked_at today)
export async function incomeToday() {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const end = new Date(start); end.setDate(start.getDate() + 1);

  const url = new URL(`${SUPABASE_URL}/rest/v1/orders`);
  url.searchParams.set('select', 'total,picked_at,status');
  url.searchParams.set('status', 'eq.dorzim');
  url.searchParams.append('picked_at', `gte.${start.toISOString()}`);
  url.searchParams.append('picked_at', `lt.${end.toISOString()}`);

  try {
    const r = await fetch(url.toString(), { headers: baseHeaders() });
    const data = await r.json();
    return (Array.isArray(data) ? data : []).reduce((sum, row) => sum + Number(row.total || 0), 0);
  } catch (e) {
    console.warn('[incomeToday error]', e);
    return 0;
  }
}

// Lightweight "realtime": refresh counters when tab becomes visible again
export function subscribeOrders(onChange) {
  const handler = () => onChange?.();
  document.addEventListener('visibilitychange', handler);
  return { unsubscribe() { document.removeEventListener('visibilitychange', handler); } };
}