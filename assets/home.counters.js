// /assets/home.counters.v2.js — REST version wired to your Supabase schema
import { SUPABASE_URL, SUPABASE_ANON } from '/assets/supabase.js';

/* helpers */
function headersCount(){ return {
  apikey: SUPABASE_ANON,
  Authorization: `Bearer ${SUPABASE_ANON}`,
  Accept: 'application/json',
  Prefer: 'count=exact'
};}
function headersBase(){ return {
  apikey: SUPABASE_ANON,
  Authorization: `Bearer ${SUPABASE_ANON}`,
  Accept: 'application/json'
};}
function buildUrl(table, select, filters){
  const url = new URL(`${SUPABASE_URL}/rest/v1/${table}`);
  url.searchParams.set('select', select);
  if (filters){
    for (const [k,v] of Object.entries(filters)){
      if (Array.isArray(v)) v.forEach(val => url.searchParams.append(k, val));
      else url.searchParams.set(k, v);
    }
  }
  return url;
}
async function fetchCount(url){
  const r = await fetch(url.toString(), { headers: headersCount() });
  const cr = r.headers.get('Content-Range'); // e.g. "0-9/27"
  if (cr && cr.includes('/')) {
    const total = Number(cr.split('/').pop());
    if (Number.isFinite(total)) return total;
  }
  const data = await r.json().catch(()=>[]);
  return Array.isArray(data) ? data.length : 0;
}
function todayUtcWindowISO(){
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const end   = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()+1));
  return { start: start.toISOString(), end: end.toISOString() };
}

/* public API */
// exact status (pastrim, gati, dorzim, …)
export async function countStatus(status){
  const url = buildUrl('orders','id',{ status:`eq.${status}`, archived:'eq.false' });
  return fetchCount(url);
}

// DRAFTS ONLY (Paplotësuara): not picked, not archived, status 'draft' or NULL
export async function countDrafts(){
  const url = buildUrl('orders','id',{
    archived:'eq.false',
    picked_at:'is.null',
    or:'(status.eq.draft,status.is.null)'
  });
  return fetchCount(url);
}

// Ready today
export async function countReadyToday(){
  const { start, end } = todayUtcWindowISO();
  const primary = buildUrl('orders','id',{ status:'eq.gati', archived:'eq.false', ready_at:[`gte.${start}`,`lt.${end}`] });
  const n = await fetchCount(primary);
  if (n>0) return n;
  const fallback = buildUrl('orders','id',{ status:'eq.gati', archived:'eq.false', picked_at:'is.null' });
  return fetchCount(fallback);
}

// (optional) income today if you need it elsewhere
export async function incomeToday(){
  const { start, end } = todayUtcWindowISO();
  const url = buildUrl('orders','total,picked_at',{ status:'eq.dorzim', archived:'eq.false', picked_at:[`gte.${start}`,`lt.${end}`] });
  let sum = 0, from = 0, size = 1000;
  while(true){
    const page = new URL(url); page.searchParams.set('offset', String(from)); page.searchParams.set('limit', String(size));
    const r = await fetch(page.toString(), { headers: headersBase() });
    if (!r.ok) break;
    const rows = await r.json(); if (!Array.isArray(rows) || rows.length===0) break;
    sum += rows.reduce((a,row)=>a+Number(row.total||0),0);
    if (rows.length < size) break;
    from += size;
  }
  return sum;
}

// lightweight refresh
export function subscribeOrders(onChange){
  const h = () => onChange?.();
  document.addEventListener('visibilitychange', h);
  return { unsubscribe(){ document.removeEventListener('visibilitychange', h); } };
}