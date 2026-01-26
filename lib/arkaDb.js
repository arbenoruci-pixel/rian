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
  // Mbajmë emrat që pret UI duke u lidhur me kolonat që ekzistojnë vërtet në DB
  const opening_cash = row.opening_cash ?? 0;
  const opening_source = row.opening_source ?? 'COMPANY';
  const handoff_status = row.handoff_status ?? row.status ?? 'OPEN';
  const cash_counted = row.cash_counted ?? row.counted_cash ?? row.end_cash ?? null;
  // Mos refero kolona që PostgREST mund të mos i ketë në cache (p.sh. current_cash)
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
// Active cycle - Kontrolli i gjendjes OPEN
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
// Open cycle - Hapja me mbrojtje nga duplikimi
// -------------------------
export async function dbOpenCycle(payload = {}) {
  // Mbrojtja: Nëse ka cikël hapur, mos krijo të ri (parandalon errorin e unique constraint)
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

  // Dërgojmë vetëm kolonat që DB i njeh sipas fotove të errorave
  const insertRow = {
    day_key,
    cycle_no,
    handoff_status: 'OPEN',
    opening_cash,
    opening_source: payload.opening_source ?? 'COMPANY',
    opened_at: new Date().toISOString(),
  };

  const ins = await supabase.from('arka_cycles').insert(insertRow);
  
  if (ins.error) {
     console.error("Insert error, duke provuar fallback minimal:", ins.error);
     // Fallback në rast se edhe opening_source mungon
     const minimalRow = { day_key, cycle_no, opening_cash };
     const retry = await supabase.from('arka_cycles').insert(minimalRow);
     if (retry.error) throw retry.error;
  }

  const c = await dbGetActiveCycle();
  if (!c) throw new Error('Cikli nuk u gjet pas hapjes.');
  return c;
}

// -------------------------
// Moves - Lëvizjet brenda ciklit
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
  const {
    cycle_id,
    type,
    amount,
    note,
    created_by,
    created_by_pin,
    source,
    external_id,
  } = payload || {};

  if (!cycle_id) throw new Error("cycle_id mungon");

  const amt = Number(amount || 0);
  if (!Number.isFinite(amt) || amt <= 0) throw new Error("SHUMA S’ËSHTË VALIDE");

  const row = {
    cycle_id,
    type: String(type || "OUT").toUpperCase(),
    amount: amt,
    note: String(note || ""),
    created_at: new Date().toISOString(),
    // optional (may not exist in your schema)
    created_by: created_by || "SYSTEM",
    created_by_pin: created_by_pin ? String(created_by_pin) : null,
    source: source || "ORDER_PAY",
    external_id: external_id || null,
  };

  async function tryInsert(r) {
    const ins = await supabase.from("arka_cycle_moves").insert(r);
    if (ins.error) throw ins.error;
    return { ok: true };
  }

  let cur = { ...row };
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      return await tryInsert(cur);
    } catch (e) {
      const msg = String(e?.message || "");
      const m = msg.match(/Could not find the '([^']+)' column/i);
      if (m && m[1] && Object.prototype.hasOwnProperty.call(cur, m[1])) {
        delete cur[m[1]];
        continue;
      }
      const m2 = msg.match(/column\s+\"([^\"]+)\"\s+does\s+not\s+exist/i);
      if (m2 && m2[1] && Object.prototype.hasOwnProperty.call(cur, m2[1])) {
        delete cur[m2[1]];
        continue;
      }
      throw e;
    }
  }
  return { ok: false };
}

// -------------------------
// Close cycle - Mbyllja dhe llogaritja e diferencës
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

  // Update vetëm kolonat që ekzistojnë në skemën tuaj (arka_cycles)
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

  const up1 = await supabase.from('arka_cycles').update(upd).eq('id', cycle_id);
  if (up1.error) throw up1.error;
  return { ok: true };
}

async function dbGetCycleById(cycleId) {
  const { data, error } = await supabase.from('arka_cycles').select('*').eq('id', cycleId).single();
  if (error) throw error;
  return data;
}

// -------------------------
// Handoff Workflow - Ndreqja e "is not a function"
// -------------------------
export async function dbListPendingHanded() {
  const { data, error } = await supabase
    .from('arka_cycles')
    .select('*')
    // "CLOSED" do të thotë: u mbyll nga dispatch dhe pret pranim/receiving
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
  };
  // nëse roli/emer/pin i marrësit ekziston në payload, ruaje në fushat "closed_by_*"? jo.
  const r = await supabase.from('arka_cycles').update(upd).eq('id', cycle_id);
  if (r.error) throw r.error;

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
