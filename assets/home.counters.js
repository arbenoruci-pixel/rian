// /assets/home.counters.v2.js — REST version wired to your Supabase schema
// Uses SUPABASE_URL / SUPABASE_ANON from /assets/supabase.js

import { SUPABASE_URL, SUPABASE_ANON } from '/assets/supabase.js';

/* ----------------------------- helpers ---------------------------------- */

function headersCount () {
  return {
    apikey: SUPABASE_ANON,
    Authorization: `Bearer ${SUPABASE_ANON}`,
    Accept: 'application/json',
    Prefer: 'count=exact' // ask server to include total in Content-Range
  };
}

function headersBase () {
  return {
    apikey: SUPABASE_ANON,
    Authorization: `Bearer ${SUPABASE_ANON}`,
    Accept: 'application/json'
  };
}

// Build a PostgREST URL: filters like { status:'eq.gati', ready_at:['gte.ISO','lt.ISO'] }
function buildUrl (table, select, filters) {
  const url = new URL(`${SUPABASE_URL}/rest/v1/${table}`);
  url.searchParams.set('select', select);
  if (filters) {
    for (const [k, v] of Object.entries(filters)) {
      if (Array.isArray(v)) v.forEach(val => url.searchParams.append(k, val));
      else url.searchParams.set(k, v);
    }
  }
  return url;
}

// Read count from Content-Range or fallback to data length
async function fetchCount (url) {
  const r = await fetch(url.toString(), { headers: headersCount() });
  const cr = r.headers.get('Content-Range'); // e.g. "0-9/27"
  if (cr && cr.includes('/')) {
    const total = Number(cr.split('/').pop());
    if (Number.isFinite(total)) return total;
  }
  const data = await r.json().catch(() => []);
  return Array.isArray(data) ? data.length : 0;
}

// UTC “today” window
function todayUtcWindowISO () {
  const now = new Date();
  const startUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
  const endUtc   = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0));
  return { start: startUtc.toISOString(), end: endUtc.toISOString() };
}

/* ----------------------------- public API -------------------------------- */

// Count by exact status (e.g. 'pastrim', 'gati', 'dorzim')
export async function countStatus (status) {
  const url = buildUrl('orders', 'id', {
    status: `eq.${status}`,
    archived: 'eq.false'
  });
  return fetchCount(url);
}

// DRAFTS ONLY for Paplotësuara.
// Logic:
// - not archived
// - not picked
// - and one of:
//    a) status is NULL
//    b) status = 'draft'
//    c) status = 'pranim' but order is clearly incomplete (no m2 or total or pieces)
export async function countDrafts () {
  const baseFilters = {
    archived: 'eq.false',
    picked_at: 'is.null',
  };

  // 1) status NULL or 'draft'
  const url1 = buildUrl('orders', 'id', {
    ...baseFilters,
    or: '(status.is.null,status.eq.draft)'
  });

  // 2) status = 'pranim' and looks incomplete
  const url2 = buildUrl('orders', 'id', {
    ...baseFilters,
    status: 'eq.pranim',
    or: '(m2.is.null,total.is.null,pieces.is.null)'
  });

  const [a, b] = await Promise.all([fetchCount(url1), fetchCount(url2)]);
  return a + b;
}

// MARRJE SOT
export async function countReadyToday () {
  const { start, end } = todayUtcWindowISO();

  // Prefer ready today by ready_at
  const primaryUrl = buildUrl('orders', 'id', {
    status: 'eq.gati',
    archived: 'eq.false',
    ready_at: [`gte.${start}`, `lt.${end}`]
  });
  const nPrimary = await fetchCount(primaryUrl);
  if (nPrimary > 0) return nPrimary;

  // Fallback: all ready but not yet picked
  const fallbackUrl = buildUrl('orders', 'id', {
    status: 'eq.gati',
    archived: 'eq.false',
    picked_at: 'is.null'
  });
  return fetchCount(fallbackUrl);
}

// € income from delivered today (status='dorzim' and picked_at today)
export async function incomeToday () {
  const { start, end } = todayUtcWindowISO();
  const url = buildUrl('orders', 'total,picked_at', {
    status: 'eq.dorzim',
    archived: 'eq.false',
    picked_at: [`gte.${start}`, `lt.${end}`]
  });

  let sum = 0, from = 0, size = 1000;
  while (true) {
    const pageUrl = new URL(url);
    pageUrl.searchParams.set('offset', String(from));
    pageUrl.searchParams.set('limit', String(size));
    const r = await fetch(pageUrl.toString(), { headers: headersBase() });
    if (!r.ok) break;
    const rows = await r.json();
    if (!Array.isArray(rows) || rows.length === 0) break;
    sum += rows.reduce((acc, row) => acc + Number(row.total || 0), 0);
    if (rows.length < size) break;
    from += size;
  }
  return sum;
}

// Lightweight refresh on tab visibility
export function subscribeOrders (onChange) {
  const handler = () => onChange?.();
  document.addEventListener('visibilitychange', handler);
  return { unsubscribe () { document.removeEventListener('visibilitychange', handler); } };
}