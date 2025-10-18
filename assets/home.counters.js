// /assets/home.counters.js — v3 (adds countReadyToday and keeps existing exports)
import { supabase } from '/assets/supabase.js';

export async function countStatus(status){
  const { count, error } = await supabase
    .from('orders')
    .select('id', { count: 'exact', head: true })
    .eq('status', status);
  if(error){ console.warn('[countStatus]', status, error); return 0; }
  return Number(count||0);
}

// Unfinished = anything not delivered. Adjust if you prefer a narrower definition.
export async function countUnfinished(){
  const { count, error } = await supabase
    .from('orders')
    .select('id', { count: 'exact', head: true })
    .is('completed_at', null);
  if(error){ console.warn('[countUnfinished]', error); return 0; }
  return Number(count||0);
}

// New: orders with status 'gati' and ready_at is today (local day window)
export async function countReadyToday(){
  const s = new Date(); s.setHours(0,0,0,0);
  const e = new Date(s); e.setDate(s.getDate()+1);

  const { count, error } = await supabase
    .from('orders')
    .select('id', { count: 'exact', head: true })
    .eq('status','gati')
    .gte('ready_at', s.toISOString())
    .lt('ready_at', e.toISOString());
  if(error){ console.warn('[countReadyToday]', error); return 0; }
  return Number(count||0);
}

// Income from delivered orders today
export async function incomeToday(){
  const s = new Date(); s.setHours(0,0,0,0);
  const e = new Date(s); e.setDate(s.getDate()+1);

  const { data, error } = await supabase
    .from('orders')
    .select('total,picked_at,status')
    .eq('status', 'dorzim')
    .gte('picked_at', s.toISOString())
    .lt('picked_at', e.toISOString());
  if(error){ console.warn('[incomeToday]', error); return 0; }
  return (data||[]).reduce((acc, r)=>acc + Number(r.total||0), 0);
}

// Live updates from 'orders' table
export function subscribeOrders(onChange){
  return supabase
    .channel('home-counters')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, onChange)
    .subscribe();
}