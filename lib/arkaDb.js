// lib/arkaDb.js
import { supabase } from "@/lib/supabaseClient";

/**
 * ARKA (CASH ONLY) — NON-V2 BACKEND
 *
 * Keep UI function names the same:
 * - dbGetActiveCycle, dbOpenCycle, dbCloseCycle, dbReceiveCycle
 * - dbHasPendingHandedToday, dbGetHistoryDays
 *
 * Uses:
 * - tables: arka_days, arka_moves
 * - RPC: arka_open_day_strict, arka_close_day, arka_receive_day, arka_get_history_days
 */

function dayKeyLocal(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

async function qActiveDay() {
  const { data, error } = await supabase
    .from("arka_days")
    .select("*")
    .is("closed_at", null)
    .order("opened_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

export async function dbHasPendingHandedToday() {
  const { data, error } = await supabase
    .from("arka_days")
    .select("id")
    .eq("handoff_status", "HANDED")
    .is("received_at", null)
    .limit(1);

  if (error) {
    console.error("dbHasPendingHandedToday:", error);
    return false;
  }
  return Array.isArray(data) && data.length > 0;
}

export async function dbListHandedForToday() {
  const { data, error } = await supabase
    .from("arka_days")
    .select("*")
    .eq("handoff_status", "HANDED")
    .is("received_at", null)
    .order("closed_at", { ascending: false })
    .limit(50);

  if (error) throw error;
  return data || [];
}

export async function dbGetActiveCycle() {
  const day = await qActiveDay();
  if (!day) return null;
  return {
    ...day,
    status: day.handoff_status || "OPEN",
    day_key: day.day_key || dayKeyLocal(new Date()),
  };
}

export async function dbGetCarryoverToday() {
  const { data, error } = await supabase
    .from("arka_days")
    .select("id,day_key,carryover_cash,carryover_source,carryover_person_pin,closed_at")
    .gt("carryover_cash", 0)
    .order("closed_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) return { carry_cash: 0, carry_source: null, carry_person_pin: null };
  return {
    carry_cash: Number(data.carryover_cash || 0),
    carry_source: data.carryover_source || null,
    carry_person_pin: data.carryover_person_pin || null,
  };
}

export async function dbOpenCycle(params = {}) {
  const day_key = dayKeyLocal(new Date());
  const opening_cash = Number(params.opening_cash ?? 0);
  const opening_source = params.opening_source || "COMPANY";
  const opening_person_pin = params.opening_person_pin || null;
  const opened_by = params.opened_by || "LOCAL";

  const { data, error } = await supabase.rpc("arka_open_day_strict", {
    p_day_key: day_key,
    p_initial_cash: opening_cash,
    p_opened_by: opened_by,
    p_open_source: opening_source,
    p_open_person_pin: opening_source === "PERSONAL" ? (opening_person_pin || null) : null,
  });

  if (error) throw error;

  const { data: full, error: e2 } = await supabase
    .from("arka_days")
    .select("*")
    .eq("day_key", day_key)
    .order("opened_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (e2) throw e2;

  const row = Array.isArray(data) ? data[0] : data;
  return {
    ...(full || row),
    status: full?.handoff_status || "OPEN",
    day_key,
  };
}

export async function dbCloseCycle(params = {}) {
  const cycle_id = Number(params.cycle_id);
  const expected_cash = params.expected_cash == null ? null : Number(params.expected_cash);
  const cash_counted = Number(params.cash_counted ?? 0);
  const closed_by = params.closed_by || "LOCAL";

  const keep_cash = Number(params.keep_cash ?? 0);
  const keep_source = params.keep_source || null;
  const keep_person_pin = params.keep_person_pin || null;

  const { data, error } = await supabase.rpc("arka_close_day", {
    p_day_id: cycle_id,
    p_cash_counted: cash_counted,
    p_closed_by: closed_by,
    p_expected_cash: expected_cash,
    p_close_note: params.close_note || null,
    p_carryover_cash: keep_cash,
    p_carryover_source: keep_source,
    p_carryover_person_pin: keep_source === "PERSONAL" ? (keep_person_pin || null) : null,
  });

  if (error) throw error;
  return data;
}

export async function dbReceiveCycle(params = {}) {
  const cycle_id = Number(params.cycle_id);
  const received_by = params.received_by || "DISPATCH";

  const { data, error } = await supabase.rpc("arka_receive_day", {
    p_day_id: cycle_id,
    p_received_by: received_by,
  });

  if (error) throw error;
  return data;
}

export async function dbAddCycleMove(params = {}) {
  let day_id = Number(params.cycle_id || params.day_id);

  // FIX: if NaN/empty, fetch active day (OPEN cycle)
  if (!day_id || Number.isNaN(day_id)) {
    const active = await qActiveDay();
    if (!active?.id) {
      throw new Error("NO_ACTIVE_CYCLE");
    }
    day_id = Number(active.id);
  }

  const type = params.type || "OUT";
  const amount = Number(params.amount ?? 0);
  const note = params.note || "";
  const created_by = params.created_by || "LOCAL";
  const external_id = params.external_id || null;

  if (amount <= 0) {
    throw new Error("INVALID_AMOUNT");
  }

  // Idempotent insert when external_id exists
  if (external_id) {
    const { data: existing, error: e0 } = await supabase
      .from("arka_moves")
      .select("*")
      .eq("external_id", external_id)
      .limit(1)
      .maybeSingle();
    if (e0) throw e0;
    if (existing?.id) return existing;
  }

  const { data, error } = await supabase
    .from("arka_moves")
    .insert({
      day_id,
      type,
      amount,
      note,
      source: "CASH",
      created_by,
      external_id,
    })
    .select("*")
    .single();

  if (error) throw error;
  return data;
}

export async function dbListCycleMoves(cycle_id, limit = 200) {
  const { data, error } = await supabase
    .from("arka_moves")
    .select("*")
    .eq("day_id", Number(cycle_id))
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw error;
  return data || [];
}

export async function dbGetHistoryDays(days = 30) {
  const { data, error } = await supabase.rpc("arka_get_history_days", { p_days: Number(days) });
  if (error) throw error;
  return data || [];
}

// Backward/compat aliases
export async function getActiveCycle() { return dbGetActiveCycle(); }
export async function openCycle(p) { return dbOpenCycle(p); }
export async function closeCycle(p) { return dbCloseCycle(p); }
export async function receiveFromDispatch(p) { return dbReceiveCycle(p); }

export async function dbGetActiveDay() { return dbGetActiveCycle(); }
export async function dbOpenDay(p) { return dbOpenCycle(p); }
export async function dbCloseDay(p) { return dbCloseCycle(p); }

const ArkaDb = {
  dbGetActiveCycle,
  dbOpenCycle,
  dbCloseCycle,
  dbReceiveCycle,
  dbAddCycleMove,
  dbListCycleMoves,
  dbHasPendingHandedToday,
  dbListHandedForToday,
  dbGetCarryoverToday,
  dbGetHistoryDays,
};
export default ArkaDb;
