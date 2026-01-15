// app/api/backup/list/route.js
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
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") || 50)));

    // ✅ pa has_payload
    const { data, error } = await sb
      .from(table)
      .select("id, created_at, pin, device") 
      .eq("pin", pin)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) {
      return NextResponse.json(
        { ok: false, error: "SUPABASE_BACKUPS_QUERY_FAILED", detail: error.message, table },
        { status: 500 }
      );
    }

    return NextResponse.json({ ok: true, table, pin, items: data || [] });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e?.message || String(e) },
      { status: 500 }
    );
  }
}