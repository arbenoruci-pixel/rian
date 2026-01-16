import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

function admin() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url) throw new Error("MISSING_SUPABASE_URL");
  if (!key) throw new Error("MISSING_SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, key, { auth: { persistSession: false } });
}

async function detectBackupsTable(sb) {
  for (const t of ["app_backups", "backups"]) {
    const { error } = await sb.from(t).select("id").limit(1);
    if (!error) return t;
  }
  throw new Error("NO_BACKUPS_TABLE_ACCESS");
}

export async function GET(req) {
  try {
    const sb = admin();
    const backupsTable = await detectBackupsTable(sb);

    const has = {
      NEXT_PUBLIC_SUPABASE_URL: !!process.env.NEXT_PUBLIC_SUPABASE_URL,
      SUPABASE_URL: !!process.env.SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      BACKUP_PIN: !!process.env.BACKUP_PIN,
    };

    return NextResponse.json({
      ok: true,
      diag: {
        node: process.version,
        backups_table: backupsTable,
        has,
        url_preview: String(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "")
          .replace(/^https?:\/\//, "")
          .slice(0, 18),
        table_probe_ok: true,
        table_probe_error: null,
      },
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: "PING_FAILED", detail: e?.message || String(e) },
      { status: 500 }
    );
  }
}
