// /assets/home.counters.js — REST version (final, paginated + compatible with your project)
import { SUPABASE_URL, SUPABASE_ANON } from '/assets/supabase.js';

// ---------- headers ----------
function baseHeaders() {
  return {
    apikey: SUPABASE_ANON,
    Authorization: `Bearer ${SUPABASE_ANON}`,
    Accept: 'application/json'
  };
}

// ---------- generic count helper with pagination ----------
async function fullCount(filters) {
  const url = new URL(`${SUPABASE_URL}/rest/v1/orders`);
  url.searchParams.set('select', 'id');
  if (filters) {
    for (const [k, v] of Object.entries(filters)) {
      if (Array.isArray(v)) v.forEach(v2 => url.searchParams.append(k, v2));
      else url.searchParams.set(k, v);
    }
  }

  let total = 0;
  let from = 0, size = 1000; // fetch 1000 per page
  while (true) {
    const pageUrl = new URL(url);
    pageUrl.searchParams.set('offset', from);
    pageUrl.searchParams.set('limit', size);

    try {
      const r = await fetch(pageUrl.toString(), { headers: baseHeaders() });
      const data = await r.json();
      const batch = Array.isArray(data) ? data.length : 0;
      total += batch;
      if (batch < size) break;
      from += size;
    } catch (e) {
      console.warn('[fullCount error]', e);
      break;
    }
  }
  return total;
}

// ---------- public API ----------
export async function countStatus(status) {
  return fullCount({ status: `eq.${status}` });
}

export async function countUnfinished() {
  return fullCount({ completed_at: 'is.null' });
}

export async function countReadyToday() {
  const start = new Date(); start.setHours(0,0,0,0);
  const end = new Date(start); end.setDate(start.getDate() + 1);

  // primary: ready_at window
  const n1 = await fullCount({
    status: 'eq.gati',
    ready_at: [`gte.${start.toISOString()}`, `lt.${end.toISOString()}`],
  });
  if (n1 > 0) return n1;

  // fallback: gati_at or created_at window
  const n2 = await fullCount({
    status: 'eq.gati',
    gati_at: [`gte.${start.toISOString()}`, `lt.${end.toISOString()}`],
  });
  if (n2 > 0) return n2;

  return fullCount({
    status: 'eq.gati',
    created_at: [`gte.${start.toISOString()}`, `lt.${end.toISOString()}`],
  });
}

export async function incomeToday() {
  const start = new Date(); start.setHours(0,0,0,0);
  const end = new Date(start); end.setDate(start.getDate() + 1);

  const url = new URL(`${SUPABASE_URL}/rest/v1/orders`);
  url.searchParams.set('select', 'total,picked_at,status');
  url.searchParams.set('status', 'eq.dorzim');
  url.searchParams.append('picked_at', `gte.${start.toISOString()}`);
  url.searchParams.append('picked_at', `lt.${end.toISOString()}`);

  try {
    const r = await fetch(url.toString(), { headers: baseHeaders() });
    const data = await r.json();
    return (Array.isArray(data) ? data : []).reduce((s, r) => s + Number(r.total || 0), 0);
  } catch (e) {
    console.warn('[incomeToday error]', e);
    return 0;
  }
}

// simple “realtime” refresh on tab focus
export function subscribeOrders(onChange) {
  const handler = () => onChange?.();
  document.addEventListener('visibilitychange', handler);
  return { unsubscribe() { document.removeEventListener('visibilitychange', handler); } };
}