
// lib/arkaDb.js
import { supabase } from "@/lib/supabaseClient";
import { dbAddExpense as _dbAddExpense, dbListExpensesToday as _dbListExpensesToday } from "@/lib/expensesDb";

/*
  ARKA DB — minimal, build-safe implementation.
  Goal: provide the exports that pages expect, without breaking deploy.
  Tables assumed (Supabase):
   - arka_cycles: id, day_key, day_date, cycle_no, handoff_status, opening_cash, opening_source, opening_person_pin,
                 expected_cash, cash_counted, keep_cash, keep_source, keep_person_pin, opened_at, closed_at, opened_by, closed_by, received_by, received_at
   - arka_cycle_moves: id, cycle_id, type (IN/OUT), amount, note, source (COMPANY/PERSONAL/OTHER), person_pin, created_at, created_by
   - arka_days (optional): day_key, carry_cash, carry_source, carry_person_pin
   - arka_pending_cash_moves (optional): status (PENDING/DONE), type, amount, note, source, person_pin, created_at
*/

function dayKeyLocal(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function todayKey() {
  return dayKeyLocal(new Date());
}

function normSrc(v) {
  const s = String(v || "").toUpperCase();
  if (s === "PERSONAL" || s === "COMPANY" || s === "OTHER") return s;
  return "COMPANY";
}

function mapCycle(row) {
  return row || null;
}

/* =========================
   Core cycle operations
========================= */

export async function dbGetActiveCycle() {
  const day_key = todayKey();
  const { data, error } = await supabase
    .from("arka_cycles")
    .select("*")
    .eq("day_key", day_key)
    .in("handoff_status", ["OPEN"])
    .order("cycle_no", { ascending: false })
    .limit(1);

  if (error) throw error;
  return mapCycle(Array.isArray(data) ? data[0] : data);
}

export async function dbHasPendingHandedToday() {
  const day_key = todayKey();
  const { data, error } = await supabase
    .from("arka_cycles")
    .select("id", { count: "exact", head: true })
    .eq("day_key", day_key)
    .eq("handoff_status", "HANDED");

  if (error) throw error;
  return Number(data?.length || 0) > 0; // head:true usually returns null data; rely on count
}

export async function dbListHandedForToday(limit = 50) {
  const day_key = todayKey();
  const { data, error } = await supabase
    .from("arka_cycles")
    .select("*")
    .eq("day_key", day_key)
    .eq("handoff_status", "HANDED")
    .order("cycle_no", { ascending: false })
    .limit(limit);

  if (error) throw error;
  return data || [];
}

export async function dbOpenCycle({
  opening_cash = 0,
  opening_source = "COMPANY",
  opening_person_pin = "",
  opened_by = "LOCAL",
} = {}) {
  const day_key = todayKey();
  const day_date = day_key;

  // Guard: cannot open if there is any HANDED not RECEIVED today
  const pending = await dbHasPendingHandedToday();
  if (pending) throw new Error("PENDING_HANDED_EXISTS");

  // Find next cycle_no
  const { data: last, error: eLast } = await supabase
    .from("arka_cycles")
    .select("cycle_no")
    .eq("day_key", day_key)
    .order("cycle_no", { ascending: false })
    .limit(1);

  if (eLast) throw eLast;
  const lastNo = (Array.isArray(last) && last[0]?.cycle_no) ? Number(last[0].cycle_no) : 0;
  const cycle_no = lastNo + 1;

  const row = {
    day_key,
    day_date,
    cycle_no,
    handoff_status: "OPEN",
    opening_cash: Number(opening_cash || 0),
    opening_source: normSrc(opening_source),
    opening_person_pin: normSrc(opening_source) === "PERSONAL" ? (String(opening_person_pin || "").trim() || null) : null,
    opened_by: String(opened_by || "LOCAL"),
    opened_at: new Date().toISOString(),
  };

  const { data, error } = await supabase.from("arka_cycles").insert(row).select("*").single();
  if (error) throw error;
  return mapCycle(data);
}

export async function dbListCycleMoves(cycle_id, limit = 500) {
  if (!cycle_id) return [];
  const { data, error } = await supabase
    .from("arka_cycle_moves")
    .select("*")
    .eq("cycle_id", cycle_id)
    .order("id", { ascending: true })
    .limit(limit);

  if (error) throw error;
  return data || [];
}

export async function dbAddCycleMove({
  cycle_id,
  type = "OUT",
  amount = 0,
  note = "",
  source = "COMPANY",
  created_by = "LOCAL",
  person_pin = "",
} = {}) {
  if (!cycle_id) throw new Error("MISSING_CYCLE_ID");
  const amt = Number(amount || 0);
  if (!(amt > 0)) throw new Error("INVALID_AMOUNT");

  const row = {
    cycle_id,
    type: String(type || "OUT").toUpperCase(),
    amount: amt,
    note: String(note || "").trim(),
    source: normSrc(source),
    person_pin: normSrc(source) === "PERSONAL" ? (String(person_pin || "").trim() || null) : null,
    created_by: String(created_by || "LOCAL"),
    created_at: new Date().toISOString(),
  };

  const { data, error } = await supabase.from("arka_cycle_moves").insert(row).select("*").single();
  if (error) throw error;
  return data;
}

export async function dbCloseCycle({
  cycle_id,
  expected_cash = 0,
  cash_counted = 0,
  closed_by = "LOCAL",
  keep_cash = 0,
  keep_source = "COMPANY",
  keep_person_pin = "",
} = {}) {
  if (!cycle_id) throw new Error("MISSING_CYCLE_ID");

  const patch = {
    expected_cash: Number(expected_cash || 0),
    cash_counted: Number(cash_counted || 0),
    keep_cash: Number(keep_cash || 0),
    keep_source: normSrc(keep_source),
    keep_person_pin: normSrc(keep_source) === "PERSONAL" ? (String(keep_person_pin || "").trim() || null) : null,
    closed_by: String(closed_by || "LOCAL"),
    closed_at: new Date().toISOString(),
    handoff_status: "HANDED",
  };

  const { data, error } = await supabase
    .from("arka_cycles")
    .update(patch)
    .eq("id", cycle_id)
    .select("*")
    .single();

  if (error) throw error;

  // Save carryover context on arka_days if the table/cols exist (best effort)
  try {
    const day_key = todayKey();
    const carryRow = {
      day_key,
      day_date: day_key,
      carry_cash: patch.keep_cash,
      carry_source: patch.keep_source,
      carry_person_pin: patch.keep_person_pin,
      updated_at: new Date().toISOString(),
    };
    await supabase.from("arka_days").upsert(carryRow, { onConflict: "day_key" });
  } catch {
    // ignore if arka_days missing
  }

  return mapCycle(data);
}

export async function dbReceiveCycle({ cycle_id, received_by = "DISPATCH" } = {}) {
  if (!cycle_id) throw new Error("MISSING_CYCLE_ID");

  const patch = {
    handoff_status: "RECEIVED",
    received_by: String(received_by || "DISPATCH"),
    received_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from("arka_cycles")
    .update(patch)
    .eq("id", cycle_id)
    .select("*")
    .single();

  if (error) throw error;
  return mapCycle(data);
}

/* =========================
   Carryover + History (minimal)
========================= */

export async function dbGetCarryoverToday() {
  const day_key = todayKey();
  // Carryover is saved on arka_days (if cols exist). If not, return zeros.
  try {
    const { data, error } = await supabase
      .from("arka_days")
      .select("carry_cash, carry_source, carry_person_pin")
      .eq("day_key", day_key)
      .maybeSingle();

    if (error) throw error;
    return {
      carry_cash: Number(data?.carry_cash || 0),
      carry_source: data?.carry_source || "COMPANY",
      carry_person_pin: data?.carry_person_pin || null,
    };
  } catch {
    return { carry_cash: 0, carry_source: null, carry_person_pin: null };
  }
}

export async function dbListHistoryDays(p_days = 30) {
  // list last N days from arka_cycles grouped by day_key (best effort)
  try {
    const { data, error } = await supabase
      .from("arka_cycles")
      .select("*")
      .order("day_key", { ascending: false })
      .order("cycle_no", { ascending: false })
      .limit(500);

    if (error) throw error;

    // naive group
    const map = new Map();
    (data || []).forEach((c) => {
      const k = c.day_key;
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(c);
    });

    const keys = Array.from(map.keys()).slice(0, Number(p_days || 30));
    return keys.map((k) => ({ day_key: k, cycles: map.get(k) || [] }));
  } catch {
    return [];
  }
}

export async function dbGetHistoryDay(day_key) {
  if (!day_key) return null;
  try {
    const { data, error } = await supabase
      .from("arka_cycles")
      .select("*")
      .eq("day_key", day_key)
      .order("cycle_no", { ascending: false });

    if (error) throw error;
    return { day_key, cycles: data || [] };
  } catch {
    return null;
  }
}

/* =========================
   Payments hook (for arkaCashSync)
========================= */

// Accept payment from order into the currently OPEN cycle.
// Expected order fields are flexible; we just need amount + source/pin/note.
export async function dbAcceptPaymentFromOrder({
  amount,
  source = "COMPANY",
  person_pin = "",
  note = "",
} = {}) {
  const cycle = await dbGetActiveCycle();
  if (!cycle?.id) {
    // no open cycle -> caller should queue
    throw new Error("NO_ACTIVE_CYCLE");
  }
  return dbAddCycleMove({
    cycle_id: cycle.id,
    type: "IN",
    amount: Number(amount || 0),
    note: String(note || "PAGESA"),
    source,
    person_pin,
    created_by: "ORDER",
  });
}

/* =========================
   Backward-compat aliases
========================= */

// Some pages import these under different names:
export const dbHasPendingHanded = dbHasPendingHandedToday;
export const dbListPendingHanded = dbListHandedForToday;

// =========================
// Compat exports for pages
// =========================

export async function dbGetTodayDay() {
  // Minimal helper for older pages: ensure arka_days row for today exists.
  const day_key = dayKeyLocal(new Date());
  const day_date = day_key;

  // Try create or fetch (won't break if table/cols differ; caller mostly needs day_key/id)
  try {
    const { data: existing, error: e1 } = await supabase
      .from("arka_days")
      .select("*")
      .eq("day_key", day_key)
      .maybeSingle();
    if (e1) throw e1;
    if (existing?.id) return existing;

    const { data: created, error: e2 } = await supabase
      .from("arka_days")
      .insert({ day_key, day_date })
      .select("*")
      .single();
    if (e2) throw e2;
    return created;
  } catch {
    // Fallback if arka_days table doesn't exist in this build
    return { id: null, day_key, day_date };
  }
}

// Re-export expenses helpers via arkaDb to keep old imports working
export const dbAddExpense = _dbAddExpense;
export const dbListExpensesToday = _dbListExpensesToday;
