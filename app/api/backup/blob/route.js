import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabaseAdminClient";

export const runtime = "nodejs";

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
  throw new Error("NO_BACKUPS_TABLE_ACCESS");
}

export async function GET(req) {
  try {
    const url = new URL(req.url);
    const id = String(url.searchParams.get("id") || "").trim();
    if (!id) {
      return NextResponse.json({ ok: false, error: "MISSING_ID" }, { status: 400 });
    }

    const sb = getSupabaseAdmin();
    const table = await detectBackupsTable(sb);

    const { data, error } = await sb
      .from(table)
      .select("id,created_at,device,pin,payload")
      .eq("id", id)
      .maybeSingle();

    if (error) {
      return NextResponse.json(
        { ok: false, error: "SUPABASE_BACKUPS_QUERY_FAILED", detail: error.message },
        { status: 500 }
      );
    }
    if (!data) {
      return NextResponse.json({ ok: false, error: "NO_BACKUP_FOUND" }, { status: 404 });
    }

    return NextResponse.json({ ok: true, item: data, backups_table: table });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e.message || e) }, { status: 500 });
  }
}
