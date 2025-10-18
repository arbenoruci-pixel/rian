// /assets/home.counters.js — REST version wired to your schema
// Uses SUPABASE_URL / SUPABASE_ANON from /assets/supabase.js

import { SUPABASE_URL, SUPABASE_ANON } from '/assets/supabase.js';

// ---- helpers --------------------------------------------------------------

function baseHeaders() {
  return {
    apikey: SUPABASE_ANON,
    Authorization: `Bearer ${SUPABASE_ANON}`,
    Accept: 'application/json'
  };
}

// generic SELECT with filters and pagination; returns full count
async function selectCount(table, filters) {
  const url = new URL(`${SUPABASE_URL}/rest/v1/${table}`);
  url.searchParams.set('select', 'id'); // only need id for counting

  if (filters) {
    for (const [k, v] of Object.entries(filters)) {
      if (Array.isArray(v)) v.forEach(v2 => url.searchParams.append(k, v2));
      else url.searchParams.set(k, v);
    }
  }

  let total = 0;
  let offset = 0;
  const limit = 1000; // fetch in chunks to be safe on large tables

  while (true) {
    const pageUrl = new URL(url);
    pageUrl.searchParams.set('offset', String(offset));
    pageUrl.searchParams.set('limit', String(limit));

    const resp = await fetch(pageUrl.toString(), { headers: baseHeaders() });
    if (!resp.ok) {
      console.warn('[selectCount]', resp.status, await resp.text());
      break;
    }
    const rows = await resp.json();
    const n = Array.isArray(rows) ? rows.length : 0;
    total += n;
    if (n < limit) break;
    offset += limit;
  }
  return total;
}

// time window for "today" (local time on client)
function todayWindowISO() {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const end = new Date(start); end.setDate(start.getDate() + 1);
  return { start: start.toISOString(), end: end.toISOString() };
}

// ---- public API used by index.html ---------------------------------------

// Map your pipeline statuses here.
// If your real values differ, change them below.
const STATUSES = {
  PRANIMI: 'pranim',
  PASTRIMI: 'pastrim',
  GATI: 'gati',
  DORZIM: 'dorzim'
};

// Count by exact status
export async function countStatus(status) {
  return selectCount('orders', { status: `eq.${status}` });
}

// Unfinished = not picked yet AND not archived
export async function countUnfinished() {
  return selectCount('orders', {
    picked_at: 'is.null',
    archived: 'eq.false'
  });
}

// MARRJE SOT = orders with status 'gati' and ready_at within today
export async function countReadyToday() {
  const { start, end } = todayWindowISO();
  return selectCount('orders', {
    status: `eq.${STATUSES.GATI}`,
    ready_at: [`gte.${start}`, `lt.${end}`]
  });
}

// € income from delivered orders today (status='dorzim' and picked_at today)
// Sums "total" field for those rows.
export async function incomeToday() {
  const { start, end } = todayWindowISO();
  const url = new URL(`${SUPABASE_URL}/rest/v1/orders`);
  url.searchParams.set('select', 'total,picked_at,status');
  url.searchParams.set('status', `eq.${STATUSES.DORZIM}`);
  url.searchParams.append('picked_at', `gte.${start}`);
  url.searchParams.append('picked_at', `lt.${end}`);

  try {
    let sum = 0, offset = 0, limit = 1000;
    while (true) {
      const pageUrl = new URL(url);
      pageUrl.searchParams.set('offset', String(offset));
      pageUrl.searchParams.set('limit', String(limit));

      const resp = await fetch(pageUrl.toString(), { headers: baseHeaders() });
      if (!resp.ok) {
        console.warn('[incomeToday]', resp.status, await resp.text());
        break;
      }
      const rows = await resp.json();
      if (!Array.isArray(rows) || rows.length === 0) break;
      sum += rows.reduce((acc, r) => acc + Number(r.total || 0), 0);
      if (rows.length < limit) break;
      offset += limit;
    }
    return sum;
  } catch (e) {
    console.warn('[incomeToday error]', e);
    return 0;
  }
}

// Lightweight refresh: reload counters when tab becomes visible
export function subscribeOrders(onChange) {
  const handler = () => onChange?.();
  document.addEventListener('visibilitychange', handler);
  return { unsubscribe() { document.removeEventListener('visibilitychange', handler); } };
}