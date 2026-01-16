import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabaseAdminClient";

export const runtime = "nodejs";

function normPin(pin) {
  const p = String(pin || "").trim();
  return p;
}

async function tableExists(sb, table) {
  if (!table) return false;
  const { error } = await sb.from(table).select("id").limit(1);
  return !error;
}

async function detectBackupsTable(sb) {
  const wanted = String(process.env.BACKUPS_TABLE || "").trim();
  const candidates = [wanted, "app_backups", "backups"].filter(Boolean);
  for (const t of candidates) {
    if (await tableExists(sb, t)) return t;
  }
  throw new Error("NO_BACKUPS_TABLE");
}

export async function GET(req) {
  try {
    const supabase = getSupabaseAdmin();
    const { searchParams } = new URL(req.url);

    // Default to env BACKUP_PIN if available, otherwise require pin in query
    const envPin = String(process.env.BACKUP_PIN || "").trim();
    const pin = normPin(searchParams.get("pin")) || envPin || "";
    if (!pin) {
      return NextResponse.json({ ok: false, error: "PIN_REQUIRED" }, { status: 400 });
    }

    const limit = Math.min(100, Math.max(1, Number(searchParams.get("limit") || 30)));
    const table = await detectBackupsTable(supabase);

    // NOTE: app_backups schema: id, created_at, device, pin, payload (jsonb)
    const { data, error } = await supabase
      .from(table)
      .select("id, created_at, device, pin")
      .eq("pin", pin)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) {
      return NextResponse.json({ ok: false, error: "SUPABASE_BACKUPS_QUERY_FAILED", detail: error.message }, { status: 500 });
    }

    const items = (data || []).map((r) => ({ ...r, has_payload: true }));
    return NextResponse.json({ ok: true, pin, table, items });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 500 });
  }
}
