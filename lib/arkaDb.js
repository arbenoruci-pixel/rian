import { supabase } from './supabaseClient';

function formatDayKeyLocal(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function mapCycle(row) {
  if (!row) return null;
  const opening_cash = row.opening_cash ?? 0;
  const opening_source = row.opening_source ?? 'COMPANY';
  const handoff_status = row.handoff_status ?? row.status ?? 'OPEN';
  const cash_counted = row.cash_counted ?? row.counted_cash ?? row.end_cash ?? null;
  const expected_cash = row.expected_cash ?? opening_cash;
  return { ...row, opening_cash, opening_source, handoff_status, cash_counted, expected_cash };
}

export async function dbGetActiveCycle() {
  const { data, error } = await supabase.from('arka_cycles').select('*').or('handoff_status.eq.OPEN,status.eq.OPEN').order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (error) return null;
  return mapCycle(data);
}

export async function dbOpenCycle(payload = {}) {
  const existing = await dbGetActiveCycle();
  if (existing?.id) return existing;
  const opening_cash = Number(payload.opening_cash ?? 0);
  const day_key = String(payload.day_key || formatDayKeyLocal());
  let cycle_no = 1;
  const { data: last } = await supabase.from('arka_cycles').select('cycle_no').eq('day_key', day_key).order('cycle_no', { ascending: false }).limit(1).maybeSingle();
  if (last) cycle_no = Number(last.cycle_no || 0) + 1;
  
  // HOQA 'opened_by_pin' dhe 'opened_by' qe te mos kete konflikt me DB
  const insertRow = { 
    day_key, 
    cycle_no, 
    handoff_status: 'OPEN', 
    opening_cash, 
    opening_source: payload.opening_source ?? 'COMPANY', 
    opened_at: new Date().toISOString()
  };
  
  const ins = await supabase.from('arka_cycles').insert(insertRow);
  if (ins.error) throw ins.error;
  return await dbGetActiveCycle();
}

export async function dbGetCycleMoves(cycleId) {
  const { data, error } = await supabase.from('arka_cycle_moves').select('*').eq('cycle_id', cycleId).order('created_at', { ascending: true });
  return Array.isArray(data) ? data : [];
}

export const dbListCycleMoves = dbGetCycleMoves;

export async function dbAddCycleMove(payload) {
  const { cycle_id, type, amount, note, external_id } = payload || {};
  if (!cycle_id) throw new Error('Mungon cycle_id');
  
  const row = {
    cycle_id,
    type: String(type || 'OUT').toUpperCase(),
    amount: Number(amount || 0),
    note: String(note || ''),
    external_id: external_id || null,
    created_at: new Date().toISOString(),
  };

  const { error } = await supabase.from('arka_cycle_moves').insert(row);
  if (error) {
    // Nese deshton per shkak te external_id, provo pa te (fallback)
    const { external_id, ...fallback } = row;
    const res2 = await supabase.from('arka_cycle_moves').insert(fallback);
    if (res2.error) throw res2.error;
  }
  return { ok: true };
}

export async function dbCloseCycle(payload = {}) {
  const cycle_id = payload.cycle_id;
  const cycle = await dbGetCycleById(cycle_id);
  const moves = await dbGetCycleMoves(cycle_id);
  const ins = moves.filter(m => m.type === 'IN').reduce((a, m) => a + Number(m.amount), 0);
  const outs = moves.filter(m => m.type === 'OUT').reduce((a, m) => a + Number(m.amount), 0);
  const expected = Number(cycle.opening_cash) + ins - outs;
  const counted = Number(payload.cash_counted ?? expected);
  
  const upd = { 
    handoff_status: 'CLOSED', 
    status: 'CLOSED', 
    expected_cash: expected, 
    cash_counted: counted, 
    discrepancy: counted - expected, 
    end_cash: counted, 
    closed_at: new Date().toISOString() 
  };
  
  const { error } = await supabase.from('arka_cycles').update(upd).eq('id', cycle_id);
  if (error) throw error;
  return { ok: true };
}

async function dbGetCycleById(id) {
  const { data, error } = await supabase.from('arka_cycles').select('*').eq('id', id).single();
  if (error) throw error;
  return data;
}

export async function dbListPendingHanded() {
  const { data, error } = await supabase.from('arka_cycles').select('*').or('handoff_status.eq.CLOSED,status.eq.CLOSED').order('created_at', { ascending: false });
  return (data || []).map(mapCycle);
}

export async function dbHasPendingHanded() {
  const list = await dbListPendingHanded();
  return list.length > 0;
}

export async function dbReceiveCycle(payload = {}) {
  // KETU ISHTE GABIMI I FOTOS - HOQA 'received_by_pin'
  const upd = { 
    status: 'RECEIVED', 
    handoff_status: 'RECEIVED', 
    received_at: new Date().toISOString(), 
    received_by: payload.received_by || null 
  };
  const { error } = await supabase.from('arka_cycles').update(upd).eq('id', payload.cycle_id);
  if (error) throw error;
  return { ok: true };
}

export async function dbReceiveCycleMove() { return { ok: true }; }
export async function dbGetCarryoverToday() { return { carry_cash: 0 }; }

export async function dbListHistoryDays(limit = 30) {
  const { data } = await supabase.from('arka_cycles').select('*').order('created_at', { ascending: false }).limit(200);
  const byDay = new Map();
  (data || []).forEach(c => {
    if (!byDay.has(c.day_key)) byDay.set(c.day_key, { id: c.day_key, day_key: c.day_key, expected_cash: 0 });
    byDay.get(c.day_key).expected_cash += Number(c.opening_cash);
  });
  return Array.from(byDay.values()).slice(0, limit);
}

export async function dbListCyclesByDay(dayId) {
  const { data } = await supabase.from('arka_cycles').select('*').eq('day_key', dayId).order('created_at', { ascending: true });
  return (data || []).map(mapCycle);
}
