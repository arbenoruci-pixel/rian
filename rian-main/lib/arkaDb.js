// Client-side ARKA data access.
// Supabase is the source of truth when tables exist.
// If DB is not configured yet, we fallback to localStorage so UI still works.

import { supabase } from "@/lib/supabaseClient";

const LS_DAY = "ARKA_STATE";
const LS_MOVES = "ARKA_MOVES";
// Backward-compat: older builds stored cash moves here
const LS_MOVES_LEGACY = "arka_list_v1";

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
  const primary = safeJsonParse(globalThis?.localStorage?.getItem(LS_MOVES), []) || [];
  const legacy = safeJsonParse(globalThis?.localStorage?.getItem(LS_MOVES_LEGACY), []) || [];

  // Merge by externalId/id to avoid duplicates.
  const map = new Map();
  for (const m of [...legacy, ...primary]) {
    if (!m) continue;
    const key = m.externalId || m.external_id || m.id || `${m.ts || ''}-${m.amount || ''}-${m.note || ''}`;
    if (!map.has(key)) map.set(key, m);
  }
  const merged = Array.from(map.values());
  merged.sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0));

  // If legacy has data but primary is empty, keep them in the new key too.
  try {
    if (legacy.length && !primary.length) {
      globalThis?.localStorage?.setItem(LS_MOVES, JSON.stringify(merged));
    }
  } catch {
    // ignore
  }

  return merged;
}

export function setLocalDay(day) {
  localStorage.setItem(LS_DAY, JSON.stringify(day));
}

export function setLocalMoves(moves) {
  localStorage.setItem(LS_MOVES, JSON.stringify(moves));
  // Keep legacy key in sync so older pages still show the same data.
  try {
    localStorage.setItem(LS_MOVES_LEGACY, JSON.stringify(moves));
  } catch {
    // ignore
  }
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
