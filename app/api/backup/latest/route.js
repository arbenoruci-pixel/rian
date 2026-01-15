// app/api/backup/latest/route.js
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

function companyPin() {
  return String(process.env.BACKUP_PIN || process.env.BACKUP_COMPANY_PIN || "")
    .trim();
}

async function detectTable(sb) {
  for (const t of ["app_backups", "backups"]) {
    const { error } = await sb.from(t).select("id").limit(1);
    if (!error) return t;
  }
  throw new Error("NO_BACKUPS_TABLE_ACCESS");
}

export async function GET(req) {
  try {
    const sb = admin();
    const table = await detectTable(sb);

    const url = new URL(req.url);
    const pin = companyPin() || String(url.searchParams.get("pin") || "").trim() || "654321";

    const { data, error } = await sb
      .from(table)
      .select("id, created_at, pin, device, payload")
      .eq("pin", pin)
      .order("created_at", { ascending: false })
      .limit(1);

    if (error) {
      return NextResponse.json(
        { ok: false, error: "SUPABASE_BACKUPS_QUERY_FAILED", detail: error.message, table },
        { status: 500 }
      );
    }

    if (!data || data.length === 0) {
      return NextResponse.json(
        { ok: false, error: "NO_BACKUP_FOUND", table, pin },
        { status: 404 }
      );
    }

    return NextResponse.json({ ok: true, table, item: data[0] });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e?.message || String(e) },
      { status: 500 }
    );
  }
}