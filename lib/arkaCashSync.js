
// lib/arkaCashSync.js
import { supabase } from "@/lib/supabaseClient";
import { dbGetActiveCycle, dbAddCycleMove } from "@/lib/arkaDb";

/*
  Moves cash events created while no cycle was OPEN into the current OPEN cycle.
  Table (optional): arka_pending_cash_moves
   - id, status (PENDING/DONE), type (IN/OUT), amount, note, source, person_pin, created_at
*/

function normSrc(v) {
  const s = String(v || "").toUpperCase();
  if (s === "PERSONAL" || s === "COMPANY" || s === "OTHER") return s;
  return "COMPANY";
}

export async function processPendingPayments(limit = 200) {
  // If the pending table doesn't exist, just no-op.
  let pending = [];
  try {
    const { data, error } = await supabase
      .from("arka_pending_cash_moves")
      .select("*")
      .eq("status", "PENDING")
      .order("id", { ascending: true })
      .limit(limit);

    if (error) throw error;
    pending = data || [];
  } catch {
    return { ok: true, processed: 0, skipped: 0, reason: "NO_PENDING_TABLE" };
  }

  if (!pending.length) return { ok: true, processed: 0, skipped: 0 };

  const cycle = await dbGetActiveCycle();
  if (!cycle?.id) {
    // can't process now; keep pending
    return { ok: false, processed: 0, skipped: pending.length, reason: "NO_ACTIVE_CYCLE" };
  }

  let processed = 0;
  for (const p of pending) {
    try {
      await dbAddCycleMove({
        cycle_id: cycle.id,
        type: String(p.type || "IN").toUpperCase(),
        amount: Number(p.amount || 0),
        note: String(p.note || "PAGESA (PENDING)"),
        source: normSrc(p.source),
        person_pin: p.person_pin || p.pin || "",
        created_by: "SYNC",
      });

      // mark done
      await supabase
        .from("arka_pending_cash_moves")
        .update({ status: "DONE", processed_at: new Date().toISOString() })
        .eq("id", p.id);

      processed += 1;
    } catch {
      // leave it pending if something fails for that row
    }
  }

  return { ok: true, processed, skipped: pending.length - processed };
}
