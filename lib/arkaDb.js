// lib/arkaDb.js
// NOTE: This file is intentionally self-contained and conflict-free.
// It provides ARKA cash cycle helpers + expenses + company budget syncing.

import { supabase } from "@/lib/supabaseClient";

/* =========================
   Helpers
========================= */
function dayKeyLocal(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function safeNum(n) {
  const x = Number(n ?? 0);
  return Number.isFinite(x) ? x : 0;
}

function normPaidFrom(v) {
  const s = String(v || "").toUpperCase();
  if (s === "CASH_TODAY" || s === "ARKA") return "CASH_TODAY";
  if (s === "COMPANY_BUDGET" || s === "BUXHET" || s === "BUDGET") return "COMPANY_BUDGET";
  if (s === "PERSONAL") return "PERSONAL";
  return s || "CASH_TODAY";
}

async function safeOrder(baseQuery, limit = 300) {
  // Some DBs do not have `at`. Some don't have `created_at`.
  let r = await baseQuery.order("at", { ascending: false }).limit(limit);
  if (r.error) r = await baseQuery.order("created_at", { ascending: false }).limit(limit);
  if (r.error) r = await baseQuery.limit(limit);
  if (r.error) throw r.error;
  return r.data || [];
}

async function safeInsert(table, row) {
  const ins = await supabase.from(table).insert(row).select("*").single();
  if (ins.error) throw ins.error;
  return ins.data;
}

/* =========================
   Days (context)
========================= */
export async function dbGetTodayDay() {
  const day_key = dayKeyLocal(new Date());

  const q1 = await supabase.from("arka_days").select("*").eq("day_key", day_key).maybeSingle();
  if (q1.error) throw q1.error;
  if (q1.data?.id) return q1.data;

  // Create minimal row (columns may differ; keep conservative)
  const ins = await supabase
    .from("arka_days")
    .insert({
      day_key,
      day_date: day_key,
      initial_cash: 0,
    })
    .select("*")
    .single();

  if (ins.error) throw ins.error;
  return ins.data;
}

/* =========================
   Cash cycles
   arka_cycles: id, day_key, cycle_no, handoff_status (OPEN|HANDED|RECEIVED),
              opening_cash, opening_source, opening_person_pin,
              expected_cash, cash_counted,
              keep_cash, keep_source, keep_person_pin,
              opened_at, opened_by, closed_at, closed_by, received_at, received_by

   arka_cycle_moves: id, cycle_id, type (IN|OUT), amount, note, source, person_pin, created_at
========================= */
export async function dbGetActiveCycle() {
  const q = await supabase
    .from("arka_cycles")
    .select("*")
    .eq("handoff_status", "OPEN")
    .order("opened_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (q.error) throw q.error;
  return q.data || null;
}

export async function dbHasPendingHandedToday() {
  const day_key = dayKeyLocal(new Date());
  const q = await supabase
    .from("arka_cycles")
    .select("id", { count: "exact", head: true })
    .eq("day_key", day_key)
    .eq("handoff_status", "HANDED");
  if (q.error) throw q.error;
  return Number(q.count || 0) > 0;
}

export async function dbListHandedForToday() {
  const day_key = dayKeyLocal(new Date());
  const q = await supabase
    .from("arka_cycles")
    .select("*")
    .eq("day_key", day_key)
    .eq("handoff_status", "HANDED")
    .order("closed_at", { ascending: false });
  if (q.error) throw q.error;
  return q.data || [];
}

// Backward-compat aliases used in some pages
// NOTE: some pages import dbHasPendingHanded / dbListPendingHanded.
// ES modules don't support `export const A as B = ...` syntax.
export const dbHasPendingHanded = dbHasPendingHandedToday;
export const dbListPendingHanded = dbListHandedForToday;

export async function dbGetCarryoverToday() {
  // Carryover is saved on arka_days (if cols exist). If not, return zeros.
  const day_key = dayKeyLocal(new Date());
  const q = await supabase.from("arka_days").select("*").eq("day_key", day_key).maybeSingle();
  if (q.error) throw q.error;
  const r = q.data || {};
  return {
    carry_cash: safeNum(r.carry_cash ?? r.keep_cash ?? 0),
    carry_source: r.carry_source ?? r.keep_source ?? null,
    carry_person_pin: r.carry_person_pin ?? r.keep_person_pin ?? null,
  };
}

export async function dbOpenCycle({ opening_cash, opening_source, opening_person_pin, opened_by } = {}) {
  const day = await dbGetTodayDay();
  const day_key = day?.day_key || dayKeyLocal(new Date());

  // Determine cycle_no by counting today cycles
  const cnt = await supabase
    .from("arka_cycles")
    .select("id", { count: "exact", head: true })
    .eq("day_key", day_key);
  if (cnt.error) throw cnt.error;
  const cycle_no = Number(cnt.count || 0) + 1;

  const row = {
    day_key,
    cycle_no,
    handoff_status: "OPEN",
    opening_cash: safeNum(opening_cash),
    opening_source: String(opening_source || "COMPANY").toUpperCase(),
    opening_person_pin: opening_person_pin ? String(opening_person_pin).trim() : null,
    opened_by: opened_by || "LOCAL",
    opened_at: new Date().toISOString(),
  };

  return await safeInsert("arka_cycles", row);
}

export async function dbListCycleMoves(cycle_id, limit = 500) {
  if (!cycle_id) return [];
  const base = supabase.from("arka_cycle_moves").select("*").eq("cycle_id", cycle_id);
  return await safeOrder(base, limit);
}

export async function dbAddCycleMove({ cycle_id, type, amount, note, source, created_by, person_pin } = {}) {
  if (!cycle_id) throw new Error("MISSING_CYCLE");
  const t = String(type || "OUT").toUpperCase();
  if (t !== "IN" && t !== "OUT") throw new Error("INVALID_TYPE");

  const row = {
    cycle_id,
    day_key: dayKeyLocal(new Date()),
    type: t,
    amount: safeNum(amount),
    note: String(note || "").trim(),
    source: String(source || "COMPANY").toUpperCase(),
    person_pin: person_pin ? String(person_pin).trim() : null,
    created_by: created_by || "LOCAL",
    created_at: new Date().toISOString(),
  };

  return await safeInsert("arka_cycle_moves", row);
}

export async function dbCloseCycle({
  cycle_id,
  expected_cash,
  cash_counted,
  closed_by,
  keep_cash,
  keep_source,
  keep_person_pin,
} = {}) {
  if (!cycle_id) throw new Error("MISSING_CYCLE");

  // Update cycle
  const upd = await supabase
    .from("arka_cycles")
    .update({
      expected_cash: safeNum(expected_cash),
      cash_counted: safeNum(cash_counted),
      keep_cash: safeNum(keep_cash),
      keep_source: keep_source ? String(keep_source).toUpperCase() : null,
      keep_person_pin: keep_person_pin ? String(keep_person_pin).trim() : null,
      closed_by: closed_by || "LOCAL",
      closed_at: new Date().toISOString(),
      handoff_status: "HANDED",
    })
    .eq("id", cycle_id)
    .select("*")
    .single();

  if (upd.error) throw upd.error;

  // Save carryover into today's day row (if those cols exist; if not, ignore)
  try {
    const day_key = upd.data?.day_key || dayKeyLocal(new Date());
    await supabase
      .from("arka_days")
      .update({
        carry_cash: safeNum(keep_cash),
        carry_source: keep_source ? String(keep_source).toUpperCase() : null,
        carry_person_pin: keep_person_pin ? String(keep_person_pin).trim() : null,
      })
      .eq("day_key", day_key);
  } catch {
    // ignore
  }

  return upd.data;
}

export async function dbReceiveCycle({ cycle_id, received_by } = {}) {
  if (!cycle_id) throw new Error("MISSING_CYCLE");

  const upd = await supabase
    .from("arka_cycles")
    .update({
      handoff_status: "RECEIVED",
      received_at: new Date().toISOString(),
      received_by: received_by || "DISPATCH",
    })
    .eq("id", cycle_id)
    .select("*")
    .single();

  if (upd.error) throw upd.error;

  // Mirror to arka_days received_* so CompanyBudget can show IN (DISPATCH)
  try {
    const day_key = upd.data?.day_key;
    if (day_key) {
      await supabase
        .from("arka_days")
        .update({
          received_amount: safeNum(upd.data?.cash_counted),
          received_at: upd.data?.received_at,
          received_by: upd.data?.received_by,
        })
        .eq("day_key", day_key);
    }
  } catch {
    // ignore
  }

  return upd.data;
}

/* =========================
   Expenses
   arka_expenses: id, day_key, amount, paid_from, category, note, personal_pin, created_by, created_at
   arka_company_moves: id, type, amount, note, external_id, created_by, created_at
========================= */
export async function dbAddExpense({ amount, paid_from, category, note, personal_pin, created_by } = {}) {
  const a = safeNum(amount);
  if (a <= 0) throw new Error("INVALID_AMOUNT");

  const pf = normPaidFrom(paid_from);

  const row = {
    day_key: dayKeyLocal(new Date()),
    amount: a,
    paid_from: pf,
    category: category || "TË TJERA",
    note: String(note || "").trim(),
    personal_pin: pf === "PERSONAL" ? (String(personal_pin || "").trim() || null) : null,
    created_by: created_by || "LOCAL",
    created_at: new Date().toISOString(),
  };

  const exp = await safeInsert("arka_expenses", row);

  // 1) If CASH_TODAY => also create OUT in active cash cycle (reduces expected cash)
  if (pf === "CASH_TODAY") {
    try {
      const c = await dbGetActiveCycle();
      if (c?.id) {
        await dbAddCycleMove({
          cycle_id: c.id,
          type: "OUT",
          amount: a,
          note: `SHPENZIM: ${(category || "").toUpperCase()}${row.note ? ` • ${row.note}` : ""}`,
          source: "COMPANY",
          created_by: created_by || "LOCAL",
        });
      }
    } catch {
      // ignore (some builds may not have cycles)
    }
  }

  // 2) If COMPANY_BUDGET => also create OUT move in arka_company_moves (reduces budget)
  if (pf === "COMPANY_BUDGET") {
    try {
      await safeInsert("arka_company_moves", {
        type: "OUT",
        amount: a,
        note: `SHPENZIM: ${(category || "").toUpperCase()}${row.note ? ` • ${row.note}` : ""}`,
        external_id: exp.id,
        created_by: created_by || "LOCAL",
        created_at: new Date().toISOString(),
      });
    } catch {
      // ignore if table doesn't exist
    }
  }

  return exp;
}

export async function dbListExpensesForDay(day_key, limit = 500) {
  const dk = day_key || dayKeyLocal(new Date());
  const base = supabase.from("arka_expenses").select("*").eq("day_key", dk);
  return await safeOrder(base, limit);
}

export async function dbListExpensesToday(limit = 300) {
  return await dbListExpensesForDay(dayKeyLocal(new Date()), limit);
}
