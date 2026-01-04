// lib/expensesDb.js
import { supabase } from "@/lib/supabaseClient";

function dayKeyLocal(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export async function dbAddExpense({
  amount,
  paid_from,       // "ARKA" | "BUXHET" | "PERSONAL"
  category,        // "KARBURANT" | "MATERIALE" | ...
  note,
  personal_pin,
  created_by,
} = {}) {
  const a = Number(amount || 0);
  if (a <= 0) throw new Error("INVALID_AMOUNT");

  const row = {
    day_key: dayKeyLocal(new Date()),
    amount: a,
    paid_from: paid_from || "ARKA",
    category: category || "TË TJERA",
    note: (note || "").trim(),
    personal_pin: (paid_from === "PERSONAL") ? (String(personal_pin || "").trim() || null) : null,
    created_by: created_by || "LOCAL",
  };

  const { data, error } = await supabase
    .from("arka_expenses")
    .insert(row)
    .select("*")
    .single();

  if (error) throw error;
  return data;
}

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