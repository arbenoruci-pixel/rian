import { supabase } from './supabaseClient';

function formatDayKeyLocal(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// -----------------------------------------------------------------------------
// ARKA DB compatibility layer - Mapimi i kolonave reale
// -----------------------------------------------------------------------------

function mapCycle(row) {
  if (!row) return null;
  const opening_cash = row.opening_cash ?? 0;
  const opening_source = row.opening_source ?? 'COMPANY';
  const handoff_status = row.handoff_status ?? row.status ?? 'OPEN';
  const cash_counted = row.cash_counted ?? row.counted_cash ?? row.end_cash ?? null;
  const expected_cash = row.expected_cash ?? opening_cash;
  
  return {
    ...row,
    opening_cash,
    opening_source,
    handoff_status,
    cash_counted,
    expected_cash,
  };
}

// -------------------------
// Active cycle
// -------------------------
export async function dbGetActiveCycle() {
  const { data, error } = await supabase
    .from('arka_cycles')
    .select('*')
    .or('handoff_status.eq.OPEN,status.eq.OPEN')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.warn("Gabim gjatë marrjes së ciklit aktiv:", error);
    return null;
  }
  return mapCycle(data);
}

// -------------------------
// Open cycle
// -------------------------
export async function dbOpenCycle(payload = {}) {
  const existing = await dbGetActiveCycle();
  if (existing?.id) return existing;

  const opening_cash = Number(payload.opening_cash ?? payload.amount ?? 0);
  if (!Number.isFinite(opening_cash) || opening_cash < 0) {
    throw new Error('OPENING CASH S’ËSHTË VALIDE.');
  }

  const day_key = String(payload.day_key || payload.dayKey || formatDayKeyLocal());

  let cycle_no = 1;
  try {
    const { data: last } = await supabase
      .from('arka_cycles')
      .select('cycle_no')
      .eq('day_key', day_key)
      .order('cycle_no', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (last) {
      cycle_no = Number(last.cycle_no || 0) + 1;
    }
  } catch (e) {
    cycle_no = 1;
  }

  const insertRow = {
    day_key,
    cycle_no,
    handoff_status: 'OPEN',
    opening_cash,
    opening_source: payload.opening_source ?? 'COMPANY',
    opened_at: new Date().toISOString(),
    opened_by: payload.opened_by || null,
    opened_by_pin: payload.opened_by_pin || null
  };

  const ins = await supabase.from('arka_cycles').insert(insertRow);
  
  if (ins.error) {
     const minimalRow = { day_key, cycle_no, opening_cash };
     const retry = await supabase.from('arka_cycles').insert(minimalRow);
     if (retry.error) throw retry.error;
  }

  const c = await dbGetActiveCycle();
  if (!c) throw new Error('Cikli nuk u gjet pas hapjes.');
  return c;
}

// -------------------------
// Moves - KORRIGJIMI KRYESOR KËTU
// -------------------------
export async function dbGetCycleMoves(cycleId) {
  const { data, error } = await supabase
    .from('arka_cycle_moves')
    .select('*')
    .eq('cycle_id', cycleId)
    .order('created_at', { ascending: true });
  if (error) return [];
  return Array.isArray(data) ? data : [];
}

export const dbListCycleMoves = dbGetCycleMoves;

export async function dbAddCycleMove(payload) {
  // MARRIM GJITHA KOLONAT E NEVOJSHME NGA PAYLOAD
  const { 
    cycle_id, 
    type, 
    amount, 
    note, 
    external_id, 
    source, 
    created_by, 
    created_by_pin 
  } = payload || {};

  if (!cycle_id) throw new Error('cycle_id mungon');
  const amt = Number(amount || 0);
  if (!Number.isFinite(amt) || amt <= 0) throw new Error('SHUMA S’ËSHTË VALIDE');

  // NDËRTOJMË RRESHTIN E PLOTË PËR SUPABASE
  const row = {
    cycle_id,
    type: String(type || 'OUT').toUpperCase(),
    amount: amt,
    note: String(note || ''),
    external_id: external_id || null, // FIX: Tani ruhet external_id
    source: source || 'MANUAL',
    created_by: created_by || 'SYSTEM',
    created_by_pin: created_by_pin || null, // FIX: Tani ruhet PIN-i
    created_at: new Date().toISOString(),
  };

  const { error } = await supabase.from('arka_cycle_moves').insert(row);
  if (error) {
    console.error("Error te dbAddCycleMove:", error);
    // Fallback: Provojmë insert pa external_id nëse kolona mungon në DB (shumë e rëndësishme!)
    if (error.code === 'PGRST204' || error.message.includes('external_id')) {
        const { external_id, ...fallbackRow } = row;
        const retry = await supabase.from('arka_cycle_moves').insert(fallbackRow);
        if (retry.error) throw retry.error;
    } else {
        throw error;
    }
  }
  return { ok: true };
}

// -------------------------
// Close cycle
// -------------------------
export async function dbCloseCycle(payload = {}) {
  const cycle_id = payload.cycle_id ?? payload.cycleId;
  if (!cycle_id) throw new Error('cycle_id mungon');

  const cycle = await dbGetCycleById(cycle_id);
  const moves = await dbGetCycleMoves(cycle_id);
  
  const ins = (moves || [])
    .filter((m) => String(m.type || '').toUpperCase() === 'IN')
    .reduce((a, m) => a + Number(m.amount || 0), 0);
  const outs = (moves || [])
    .filter((m) => String(m.type || '').toUpperCase() === 'OUT')
    .reduce((a, m) => a + Number(m.amount || 0), 0);
    
  const startAmt = Number(cycle?.opening_cash ?? 0);
  const expected = startAmt + ins - outs;

  const counted = Number(payload.cash_counted ?? payload.cashCounted ?? expected);

  const now = new Date().toISOString();
  const upd = {
    handoff_status: 'CLOSED',
    status: 'CLOSED',
    expected_cash: expected,
    cash_counted: counted,
    discrepancy: counted - expected,
    end_cash: counted,
    closed_at: now,
    closed_by_pin: payload.closed_by_pin ?? payload.closedByPin ?? null,
    closed_by_name: payload.closed_by_name ?? payload.closedByName ?? null,
    closed_by: payload.closed_by ?? payload.closedBy ?? null,
  };

  const { error } = await supabase.from('arka_cycles').update(upd).eq('id', cycle_id);
  if (error) throw error;
  return { ok: true };
}

async function dbGetCycleById(cycleId) {
  const { data, error } = await supabase.from('arka_cycles').select('*').eq('id', cycleId).single();
  if (error) throw error;
  return data;
}

// -------------------------
// Handoff Workflow
// -------------------------
export async function dbListPendingHanded() {
  const { data, error } = await supabase
    .from('arka_cycles')
    .select('*')
    .or('handoff_status.eq.CLOSED,status.eq.CLOSED')
    .order('created_at', { ascending: false })
    .limit(50);
  
  if (error) return [];
  return (Array.isArray(data) ? data : []).map(mapCycle);
}

export async function dbHasPendingHanded() {
  try {
    const list = await dbListPendingHanded();
    return list && list.length > 0;
  } catch (e) {
    return false;
  }
}

export async function dbReceiveCycle(payload = {}) {
  const cycle_id = payload.cycle_id ?? payload.cycleId;
  if (!cycle_id) throw new Error('cycle_id mungon');

  const now = new Date().toISOString();
  const upd = {
    status: 'RECEIVED',
    handoff_status: 'RECEIVED',
    received_at: now,
    received_by: payload.received_by ?? payload.receivedBy ?? null,
    received_by_pin: payload.received_by_pin ?? payload.receivedByPin ?? null
  };
  const { error } = await supabase.from('arka_cycles').update(upd).eq('id', cycle_id);
  if (error) throw error;

  return { ok: true };
}

export async function dbReceiveCycleMove() { return { ok: true }; }
export async function dbGetCarryoverToday() { return { carry_cash: 0 }; }

// -------------------------
// History
// -------------------------
export async function dbListHistoryDays(limitDays = 30) {
  const { data, error } = await supabase
    .from('arka_cycles')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(300);
  
  if (error) return [];
  const byDay = new Map();
  for (const c of (data || [])) {
    const day_key = c.day_key || (c.created_at ? c.created_at.slice(0, 10) : null);
    if (!day_key) continue;
    if (!byDay.has(day_key)) {
      byDay.set(day_key, { id: day_key, day_key, expected_cash: 0 });
    }
    const d = byDay.get(day_key);
    d.expected_cash += Number(c.opening_cash ?? 0);
  }
  return Array.from(byDay.values()).slice(0, limitDays);
}

export async function dbListCyclesByDay(dayId) {
  const { data, error } = await supabase
    .from('arka_cycles')
    .select('*')
    .eq('day_key', dayId)
    .order('created_at', { ascending: true });
  if (error) return [];
  return (data || []).map(mapCycle);
}
