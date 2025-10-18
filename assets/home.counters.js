// /assets/home.counters.js — stable counters + proper "drafts" counter
import { SUPABASE_URL, SUPABASE_ANON } from '/assets/supabase.js';

/* ---------------- helpers ---------------- */
function headersCount() {
  return {
    apikey: SUPABASE_ANON,
    Authorization: `Bearer ${SUPABASE_ANON}`,
    Accept: 'application/json',
    Prefer: 'count=exact'
  };
}
function headersBase() {
  return {
    apikey: SUPABASE_ANON,
    Authorization: `Bearer ${SUPABASE_ANON}`,
    Accept: 'application/json'
  };
}
function buildUrl(table, select, filters) {
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
// read count from Content-Range; fall back to array length
async function fetchCount(url) {
  // ask for just 1 row; we only need the header (faster & avoids large payloads)
  url.searchParams.set('limit', '1');
  const r = await fetch(url.toString(), { headers: headersCount() });
  const cr = r.headers.get('Content-Range'); // e.g. "0-0/27"
  if (cr && cr.includes('/')) {
    const total = Number(cr.split('/').pop());
    if (Number.isFinite(total)) return total;
  }
  const data = await r.json().catch(() => []);
  return Array.isArray(data) ? data.length : 0;
}
function todayUtcWindowISO() {
  const now = new Date();
  const startUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
  const endUtc   = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0));
  return { start: startUtc.toISOString(), end: endUtc.toISOString() };
}

/* ---------------- public API ---------------- */

// exact status (pastrim, gati, dorzim, …)
export async function countStatus(status) {
  const url = buildUrl('orders', 'id', {
    status: `eq.${status}`,
    archived: 'eq.false'
  });
  return fetchCount(url);
}

// DRAFTS = “unfinished from Pranimi”
// definition: not picked, not archived, and (status IS NULL OR status='draft')
export async function countDrafts() {
  const url = buildUrl('orders', 'id', {
    picked_at: 'is.null',
    archived: 'eq.false',
    // IMPORTANT: only ONE or= group; PostgREST ANDs multiple or= groups
    or: '(status.is.null,status.eq.draft)'
  });
  return fetchCount(url);
}

// “Marrje sot”
export async function countReadyToday() {
  const { start, end } = todayUtcWindowISO();

  // Prefer ready_at today
  const primaryUrl = buildUrl('orders', 'id', {
    status: 'eq.gati',
    archived: 'eq.false',
    ready_at: [`gte.${start}`, `lt.${end}`]
  });
  const n1 = await fetchCount(primaryUrl);
  if (n1 > 0) return n1;

  // Fallback: ready & not yet picked
  const fallbackUrl = buildUrl('orders', 'id', {
    status: 'eq.gati',
    archived: 'eq.false',
    picked_at: 'is.null'
  });
  return fetchCount(fallbackUrl);
}

// optional: € income today (left intact)
export async function incomeToday() {
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

// simple auto-refresh when tab becomes active
export function subscribeOrders(onChange) {
  const handler = () => onChange?.();
  document.addEventListener('visibilitychange', handler);
  return { unsubscribe(){ document.removeEventListener('visibilitychange', handler); } };
}