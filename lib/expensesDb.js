// lib/expensesDb.js
import { supabase } from "@/lib/supabaseClient";

function dayKeyLocal(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function normPaidFrom(v) {
  const s = String(v || "").toUpperCase();
  // prano edhe formatet e reja
  if (s === "COMPANY_BUDGET") return "BUXHET";
  if (s === "CASH_TODAY") return "ARKA";
  return s || "ARKA";
}

export async function dbAddExpense({
  amount,
  paid_from,       // "ARKA" | "BUXHET" | "PERSONAL"  (ose CASH_TODAY / COMPANY_BUDGET)
  category,
  note,
  personal_pin,
  created_by,
} = {}) {
  const a = Number(amount || 0);
  if (a <= 0) throw new Error("INVALID_AMOUNT");

  const pf = normPaidFrom(paid_from);

  const row = {
    day_key: dayKeyLocal(new Date()),
    amount: a,
    paid_from: pf,
    category: category || "TË TJERA",
    note: (note || "").trim(),
    personal_pin: (pf === "PERSONAL")
      ? (String(personal_pin || "").trim() || null)
      : null,
    created_by: created_by || "LOCAL",
  };

  // 1) RUJ SHPENZIMIN
  const { data: expense, error: e1 } = await supabase
    .from("arka_expenses")
    .insert(row)
    .select("*")
    .single();

  if (e1) throw e1;

  // 2) NËSE ËSHTË BUXHET → KRIJO OUT te arka_company_moves (me dedupe)
  if (pf === "BUXHET") {
    const payload = {
      type: "OUT",
      amount: a,
      note: `${String(row.category || "").toUpperCase()} · ${row.note || "—"}`,
      created_by: row.created_by || "LOCAL",
      external_id: expense.id, // dedupe key
    };

    // nëse ekziston (p.sh. refresh/duplikim), mos e shto prap
    const { data: existing, error: exErr } = await supabase
      .from("arka_company_moves")
      .select("id")
      .eq("external_id", expense.id)
      .maybeSingle();

    if (!exErr && existing?.id) return expense;

    const { error: mvErr } = await supabase
      .from("arka_company_moves")
      .insert(payload);

    // nëse tabela s’ka external_id akoma, mos e nal krejt shpenzimin
    // (ti e shton më vonë; shpenzimi prap ruhet)
    if (mvErr) {
      // mos throw këtu – shpenzimi është ruajtur; vetëm s’u ul buxheti automatik
      console.warn("budget move insert failed:", mvErr?.message || mvErr);
    }
  }

  return expense;
}