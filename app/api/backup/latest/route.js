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

function requirePin(pin) {
  const required = String(process.env.BACKUP_PIN || "").trim();
  if (!required) return { ok: true };
  if (!pin) return { ok: false, error: "PIN_REQUIRED" };
  if (String(pin).trim() !== required) return { ok: false, error: "INVALID_PIN" };
  return { ok: true };
}

export async function GET(req) {
  try {
    const sb = admin();
    const backupsTable = await detectBackupsTable(sb);

    const url = new URL(req.url);
    const pin = String(url.searchParams.get("pin") || "").trim();

    const pinCheck = requirePin(pin);
    if (!pinCheck.ok) {
      return NextResponse.json({ ok: false, error: pinCheck.error }, { status: 401 });
    }

    const { data, error } = await sb
      .from(backupsTable)
      .select("id, created_at, pin, device, payload")
      .eq("pin", pin)
      .order("created_at", { ascending: false })
      .limit(1)
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

    return NextResponse.json({ ok: true, backup: data, table: backupsTable });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: "LATEST_FAILED", detail: e?.message || String(e) },
      { status: 500 }
    );
  }
}
