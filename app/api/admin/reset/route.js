import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs"; // shumë e RËNDËSISHME

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

export async function POST(req) {
  try {
    if (!SUPABASE_URL || !SERVICE_KEY) {
      return Response.json(
        { ok: false, error: "MISSING_ENV" },
        { status: 500 }
      );
    }

    const body = await req.json().catch(() => ({}));
    const { confirm } = body || {};

    if (confirm !== "RESET") {
      return Response.json(
        { ok: false, error: "CONFIRM_REQUIRED" },
        { status: 400 }
      );
    }

    const supabase = createClient(
      SUPABASE_URL,
      SERVICE_KEY,
      { auth: { persistSession: false } }
    );

    // FSHI TABLET
    // NOTE: Project ka pasur disa versione të ARKËS.
    // Mbajmë edhe tabelat e vjetra (arka_days/arka_moves) edhe të rejat (arka_cycles/arka_cycle_moves + pending + budget)
    // që reset-i të funksionojë pavarësisht se cilin schema e ke live.
    const tables = [
      "orders",
      "clients",
      "payments",
      "expenses",
      "pending",
      "backups",

      // ARKA (old)
      "arka_days",
      "arka_moves",

      // ARKA (new)
      "arka_pending_payments",
      "arka_cycle_moves",
      "arka_cycles",

      // Company budget ledger
      "company_budget_moves",
    ];

    for (const t of tables) {
      await supabase.from(t).delete().neq("id", 0);
    }

    return Response.json({ ok: true });
  } catch (err) {
    return Response.json(
      { ok: false, error: "UNEXPECTED", detail: String(err?.message || err) },
      { status: 500 }
    );
  }
}