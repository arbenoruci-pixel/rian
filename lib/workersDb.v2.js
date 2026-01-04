// lib/workersDb.v2.js
import { supabase } from "@/lib/supabaseClient";

/**
 * Verify a worker PIN using server-side bcrypt hash (pgcrypto).
 * Throws Error('PIN_INVALID') if not found.
 */
export async function v2_verifyPin(pin) {
  const clean = String(pin || "").trim();
  if (!clean) throw new Error("PIN_REQUIRED");

  const { data, error } = await supabase.rpc("workers_v2_verify_pin", { p_pin: clean });

  if (error) {
    const msg = (error.message || "").includes("PIN_INVALID") ? "PIN_INVALID" : (error.message || "PIN_VERIFY_FAILED");
    throw new Error(msg);
  }

  // RPC returns a rowset; supabase returns array
  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.id) throw new Error("PIN_INVALID");

  return {
    id: row.id,
    full_name: row.full_name,
    role: row.role,
  };
}
