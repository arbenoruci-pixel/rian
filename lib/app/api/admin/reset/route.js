import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs"; // shumë e RËNDËSISHME

export async function POST(req) {
  try {
    // Read env at request-time (safer on Vercel redeploys)
    const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
    const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

    if (!SUPABASE_URL || !SERVICE_KEY) {
      return Response.json(
        {
          ok: false,
          error: "MISSING_ENV",
          detail: "Set SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY in Vercel env.",
        },
        { status: 500 }
      );
    }

    const body = await req.json().catch(() => ({}));
    const { confirm, pin, password } = body || {};

    if (confirm !== "RESET") {
      return Response.json(
        { ok: false, error: "CONFIRM_REQUIRED" },
        { status: 400 }
      );
    }

    // Optional protection: env-based password OR pin. If env not set, allow PIN 2380.
    const ENV_PASSWORD = process.env.TEPIHA_RESET_PASSWORD || process.env.TEPIHA_ADMIN_PASSWORD;
    const ENV_PIN = process.env.TEPIHA_RESET_PIN;

    if (ENV_PASSWORD) {
      if (String(password || "") !== String(ENV_PASSWORD)) {
        return Response.json({ ok: false, error: "BAD_PASSWORD" }, { status: 401 });
      }
    } else if (ENV_PIN) {
      if (String(pin || "") !== String(ENV_PIN)) {
        return Response.json({ ok: false, error: "BAD_PIN" }, { status: 401 });
      }
    } else {
      // No env set: fallback to the known pin to avoid bricking reset.
      if (String(pin || "") !== "2380") {
        return Response.json(
          {
            ok: false,
            error: "MISSING_ENV_VARS",
            detail: "Set TEPIHA_RESET_PASSWORD (recommended) or TEPIHA_RESET_PIN in Vercel env. For now, PIN must be 2380.",
          },
          { status: 500 }
        );
      }
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
      // Ignore missing tables (some deployments may not have all yet)
      const { error } = await supabase.from(t).delete().neq("id", 0);
      if (error && !String(error.message || "").toLowerCase().includes("does not exist")) {
        // keep going but report the first real error
        return Response.json(
          { ok: false, error: "TABLE_DELETE_FAILED", table: t, detail: error.message },
          { status: 500 }
        );
      }
    }

    return Response.json({ ok: true });
  } catch (err) {
    return Response.json(
      { ok: false, error: "UNEXPECTED", detail: String(err?.message || err) },
      { status: 500 }
    );
  }
}