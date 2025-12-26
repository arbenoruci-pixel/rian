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

export async function dbOpenDay({ initial_cash, opened_by, day_key }) {
  const key = (day_key || new Date().toISOString().slice(0, 10)).toString();

  // Preferred: RPC (OPEN / NOOP / REOPEN)
  try {
    const { data, error } = await supabase.rpc("arka_open_day", {
      p_day_key: key,
      p_initial_cash: Number(initial_cash || 0),
      p_user: opened_by || null,
    });
    if (!error && data) return data;
  } catch {}

  // Fallback: legacy insert (may fail if day_key UNIQUE). Keep for older DBs.
  const { data, error } = await supabase
    .from("arka_days")
    .insert([{ initial_cash, opened_by, day_key: key }])
    .select("*")
    .single();
  if (error) throw error;
  return data || null;
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

export async function dbAddMove({ day_id, type, amount, note, source, created_by, external_id }) {
  // external_id is optional but recommended for idempotency.
  // If a unique constraint exists in DB, we can safely retry without double-charging.

  const payload = {
    day_id,
    type,
    amount,
    note,
    source,
    created_by,
    ...(external_id ? { external_id } : {}),
  };

  const { data, error } = await supabase.from('arka_moves').insert([payload]).select('*').single();
  if (!error) return data;

  // Duplicate? If external_id is present, try to read existing row.
  if (external_id && (error.code === '23505' || error.message?.toLowerCase?.().includes('duplicate'))) {
    const { data: rows, error: e2 } = await supabase.from('arka_moves').select('*').eq('external_id', external_id).limit(1);
    if (!e2 && rows?.length) return rows[0];
  }
  throw error;
}


export async function dbGetLastClosedDayTotals(before_day_key) {
  const key = (before_day_key || new Date().toISOString().slice(0, 10)).toString();

  const { data: days, error } = await supabase
    .from("arka_days")
    .select("*")
    .not("closed_at", "is", null)
    .lt("day_key", key)
    .order("day_key", { ascending: false })
    .limit(1);

  if (error) throw error;
  const day = days?.[0];
  if (!day?.id) return null;

  const { data: moves, error: e2 } = await supabase
    .from("arka_moves")
    .select("type, amount")
    .eq("day_id", day.id);

  if (e2) throw e2;

  const totals = calcTotals(day.initial_cash || 0, moves || []);
  return { day, totals };
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
