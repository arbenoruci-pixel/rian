// lib/expensesDb.js
import { supabase } from "@/lib/supabaseClient";

function dayKeyLocal(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Add an expense row into arka_expenses.
 * paid_from: "ARKA" | "BUXHET" | "PERSONAL"
 */
export async function dbAddExpense({
  amount,
  paid_from,
  category,
  note,
  personal_pin,
  created_by,
} = {}) {
  const a = Number(amount || 0);
  if (!Number.isFinite(a) || a <= 0) throw new Error("INVALID_AMOUNT");

  const pf = String(paid_from || "ARKA").toUpperCase();

  const row = {
    day_key: dayKeyLocal(new Date()),
    amount: a,
    paid_from: pf,
    category: (category || "TË TJERA").trim(),
    note: (note || "").trim(),
    personal_pin: pf === "PERSONAL" ? (String(personal_pin || "").trim() || null) : null,
    created_by: (created_by || "LOCAL").trim() || "LOCAL",
  };

  const { data, error } = await supabase
    .from("arka_expenses")
    .insert(row)
    .select("*")
    .single();

  if (error) throw error;
  return data;
}

/** List today's expenses (latest first). */
export async function dbListExpensesToday(limit = 200) {
  const day_key = dayKeyLocal(new Date());
  const { data, error } = await supabase
    .from("arka_expenses")
    .select("*")
    .eq("day_key", day_key)
    .order("id", { ascending: false })
    .limit(limit);

  if (error) throw error;
  return data || [];
}

/* -------------------------
   Backward compat aliases
   (some pages/imports might expect different names)
-------------------------- */
export const dbListExpensesForToday = dbListExpensesToday;
