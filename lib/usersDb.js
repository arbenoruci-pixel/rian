// lib/usersDb.js
import { supabase } from "@/lib/supabaseClient";

/**
 * BACKWARD-COMPAT WRAPPER
 * Keeps old filename to avoid duplicating libs.
 *
 * New ARKA v2 PIN verify (bcrypt/pgcrypto):
 * - RPC: workers_v2_verify_pin(p_pin text)
 *
 * Exports:
 * - verifyPin(pin)        -> { id, full_name, role }
 * - findUserByPin(pin)    -> alias for verifyPin (many older pages used this name)
 */

export async function verifyPin(pin) {
  const clean = String(pin || "").trim();
  if (!clean) throw new Error("PIN_REQUIRED");

  const { data, error } = await supabase.rpc("workers_v2_verify_pin", { p_pin: clean });

  if (error) {
    const msg = (error.message || "").includes("PIN_INVALID") ? "PIN_INVALID" : (error.message || "PIN_VERIFY_FAILED");
    throw new Error(msg);
  }

  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.id) throw new Error("PIN_INVALID");

  return { id: row.id, full_name: row.full_name, role: row.role };
}

export async function findUserByPin(pin) {
  return verifyPin(pin);
}
