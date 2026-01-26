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
    const tables = [
      "orders",
      "clients",
      "payments",
      "arka_days",
      "arka_moves",
      "expenses",
      "pending",
      "backups"
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