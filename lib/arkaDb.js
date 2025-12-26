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
export async function dbGetOpenDay(day_key) {
  // If day_key is provided, we return the OPEN day for that key.
  // Otherwise we return the latest OPEN day (legacy behavior).
  if (day_key) {
    const { data, error } = await supabase
      .from("arka_days")
      .select("*")
      .eq("day_key", String(day_key))
      .is("closed_at", null)
      .limit(1);
    if (error) throw error;
    return data?.[0] || null;
  }

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
  const key = String(day_key || new Date().toISOString().slice(0, 10));

  // Try insert first (fast path)
  const { data: ins, error: insErr } = await supabase
    .from("arka_days")
    .insert([{ day_key: key, initial_cash, opened_by }])
    .select("*")
    .single();

  if (!insErr) return ins;

  // If unique constraint hit, load existing day and decide:
  const msg = String(insErr?.message || "").toLowerCase();
  if (msg.includes("duplicate") || msg.includes("unique")) {
    const { data: existing, error: selErr } = await supabase
      .from("arka_days")
      .select("*")
      .eq("day_key", key)
      .limit(1)
      .maybeSingle();
    if (selErr) throw selErr;

    // NOOP if already OPEN
    if (existing && !existing.closed_at) return existing;

    // REOPEN if CLOSED
    if (existing && existing.closed_at) {
      const { data: reopened, error: upErr } = await supabase
        .from("arka_days")
        .update({
          closed_at: null,
          closed_by: null,
          reopened_at: new Date().toISOString(),
          reopened_by: opened_by,
          // keep original initial_cash unless user explicitly typed new opening >0
          initial_cash: Number(initial_cash || 0) ? Number(initial_cash) : existing.initial_cash,
          handoff_status: "OPEN",
        })
        .eq("id", existing.id)
        .select("*")
        .single();
      if (upErr) throw upErr;
      return reopened;
    }
  }

  throw insErr;
}

export async function dbCloseDay({ day_id, closed_by, expected_cash, cash_counted, discrepancy, close_note }) {
  const payload = {
    closed_at: new Date().toISOString(),
    closed_by,
  };
  if (expected_cash != null) payload.expected_cash = Number(expected_cash);
  if (cash_counted != null) payload.cash_counted = Number(cash_counted);
  if (discrepancy != null) payload.discrepancy = Number(discrepancy);
  if (close_note != null) payload.close_note = String(close_note);

  // After close, day becomes pending handoff by default.
  payload.handoff_status = "PENDING";
  payload.handoff_ready_at = new Date().toISOString();

  const { data, error } = await supabase
    .from("arka_days")
    .update(payload)
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


export async function dbHandoffToDispatch({ day_id, handed_by }) {
  const { data, error } = await supabase
    .from("arka_days")
    .update({
      handoff_status: "HANDED",
      handed_by: handed_by || null,
      handed_at: new Date().toISOString(),
    })
    .eq("id", day_id)
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

export async function dbReceiveFromDispatch({ day_id, received_by, received_amount }) {
  const { data, error } = await supabase
    .from("arka_days")
    .update({
      handoff_status: "RECEIVED",
      received_by: received_by || null,
      received_at: new Date().toISOString(),
      received_amount: received_amount != null ? Number(received_amount) : null,
    })
    .eq("id", day_id)
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

export async function dbListClosedDays(limit = 60) {
  const { data, error } = await supabase
    .from("arka_days")
    .select("*")
    .not("closed_at", "is", null)
    .order("closed_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data || [];
}
