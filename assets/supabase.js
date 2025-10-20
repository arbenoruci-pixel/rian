// /assets/supabase.js — hard-wired connection + simple helpers
export const SUPABASE_URL  = 'https://vnidjrxidvusulinozbn.supabase.co';
export const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZuaWRqcnhpZHZ1c3VsaW5vemJuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTc1MTk0NjAsImV4cCI6MjA3MzA5NTQ2MH0.hzGSFKU3sKuUKBUBsTE0rKIerj2uhG9pGS8_K9N7tpA';

export function nowISO(){ return new Date().toISOString(); }

function hJSON(){ return { apikey: SUPABASE_ANON, Authorization: `Bearer ${SUPABASE_ANON}`, 'Content-Type':'application/json', Prefer:'return=representation' }; }
function hGET(){  return { apikey: SUPABASE_ANON, Authorization: `Bearer ${SUPABASE_ANON}`, Accept:'application/json' }; }

export async function rpc(fn, args={}){
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, { method:'POST', headers:hJSON(), body:JSON.stringify(args) });
  const t = await r.text(); if (!r.ok) throw new Error(t||r.status);
  try { return JSON.parse(t); } catch { return t; }
}

export async function insert(table, row){
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, { method:'POST', headers:hJSON(), body:JSON.stringify(row) });
  const t = await r.text(); if (!r.ok) throw new Error(t||r.status);
  try { return JSON.parse(t); } catch { return t; }
}

export async function select(table, query={}){
  const url = new URL(`${SUPABASE_URL}/rest/v1/${table}`);
  Object.entries(query).forEach(([k,v])=>url.searchParams.set(k,v));
  const r = await fetch(url, { headers:hGET() });
  const t = await r.text(); if (!r.ok) throw new Error(t||r.status);
  try { return JSON.parse(t); } catch { return t; }
}

export async function update(table, patch, match){
  const url = new URL(`${SUPABASE_URL}/rest/v1/${table}`);
  Object.entries(match||{}).forEach(([k,v])=>url.searchParams.set(k,`eq.${v}`));
  const r = await fetch(url, { method:'PATCH', headers:hJSON(), body:JSON.stringify(patch) });
  const t = await r.text(); if (!r.ok) throw new Error(t||r.status);
  try { return JSON.parse(t); } catch { return t; }
}

// expose on window
try {
  if (typeof window!=='undefined' && !window.__SUPABASE_SHIM__){
    window.__SUPABASE_SHIM__ = true;
    const api = { SUPABASE_URL, SUPABASE_ANON, nowISO, rpc, insert, select, update };
    for (const [k,v] of Object.entries(api)){ if (!(k in window)) window[k]=v; }
    console.log('[supabase.js] ready');
  }
}catch(e){}