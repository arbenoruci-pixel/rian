import { NextResponse } from "next/server";
import { getServiceSupabase } from "../_lib/sbAdmin";

export const runtime = "nodejs";

function checkPin(reqUrl) {
  const required = String(process.env.BACKUP_PIN || "").trim();
  if (!required) return { ok: true };
  const pin = String(reqUrl.searchParams.get("pin") || "").trim();
  if (!pin) return { ok: false, error: "PIN_REQUIRED" };
  if (pin !== required) return { ok: false, error: "INVALID_PIN" };
  return { ok: true };
}

export async function GET(req) {
  try {
    const url = new URL(req.url);
    const pinCheck = checkPin(url);
    if (!pinCheck.ok) {
      return NextResponse.json({ ok: false, error: pinCheck.error }, { status: 401 });
    }

    const sb = getServiceSupabase();
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 30), 1), 365);

    const { data, error } = await sb
      .from("backups_daily")
      .select("backup_date, clients_cnt, orders_cnt, open_orders_cnt, created_at")
      .order("backup_date", { ascending: false })
      .limit(limit);

    if (error) {
      return NextResponse.json(
        { ok: false, error: "SUPABASE_BACKUPS_DAILY_QUERY_FAILED", detail: error.message },
        { status: 500 }
      );
    }

    return NextResponse.json({ ok: true, items: data || [] });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: "DATES_FAILED", detail: e?.message || String(e) },
      { status: 500 }
    );
  }
}
