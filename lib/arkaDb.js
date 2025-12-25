// Client-side ARKA data access.
// Supabase is the source of truth when tables exist.
// If DB is not configured yet, we fallback to localStorage so UI still works.

import { supabase } from "@/lib/supabaseClient";

const LS_DAY = "ARKA_STATE";
const LS_MOVES = "ARKA_MOVES";

function safeJsonParse(s, fallback) {
  try {
    const v = JSON.parse(s);
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

export function getLocalDay() {
  return safeJsonParse(globalThis?.localStorage?.getItem(LS_DAY), { isOpen: false, initialCash: 0 }) || { isOpen: false, initialCash: 0 };
}

export function getLocalMoves() {
  return safeJsonParse(globalThis?.localStorage?.getItem(LS_MOVES), []) || [];
}

export function setLocalDay(day) {
  localStorage.setItem(LS_DAY, JSON.stringify(day));
}

export function setLocalMoves(moves) {
  localStorage.setItem(LS_MOVES, JSON.stringify(moves));
}

export async function dbCanWork() {
  // Quick probe: try selecting 1 row from arka_days.
  try {
    const { error } = await supabase.from("arka_days").select("id").limit(1);
    return !error;
  } catch {
    return false;
  }
}

// ---------------- DB API (preferred) ----------------
export async function dbGetOpenDay() {
  const { data, error } = await supabase
    .from("arka_days")
    .select("*")
    .is("closed_at", null)
    .order("opened_at", { ascending: false })
    .limit(1);
  if (error) throw error;
  return data?.[0] || null;
}

export async function dbOpenDay({ initial_cash, opened_by }) {
  const { data, error } = await supabase
    .from("arka_days")
    .insert([{ initial_cash, opened_by }])
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

export async function dbCloseDay({ day_id, closed_by }) {
  const { data, error } = await supabase
    .from("arka_days")
    .update({ closed_at: new Date().toISOString(), closed_by })
    .eq("id", day_id)
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

export async function dbListMoves(day_id) {
  const { data, error } = await supabase
    .from("arka_moves")
    .select("*")
    .eq("day_id", day_id)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function dbAddMove({ day_id, type, amount, note, source, created_by }) {
  const { data, error } = await supabase
    .from("arka_moves")
    .insert([
      {
        day_id,
        type,
        amount,
        note,
        source,
        created_by,
      },
    ])
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

// ---------------- helpers ----------------
export function calcTotals(initialCash, moves) {
  const ins = (moves || []).filter((m) => m.type === "IN").reduce((a, m) => a + Number(m.amount || 0), 0);
  const outs = (moves || []).filter((m) => m.type === "OUT").reduce((a, m) => a + Number(m.amount || 0), 0);
  return {
    initial: Number(initialCash || 0),
    in: ins,
    out: outs,
    total: Number(initialCash || 0) + ins - outs,
  };
}
