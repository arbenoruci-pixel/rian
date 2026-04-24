import { NextResponse } from "next/server";
import { getServiceSupabase } from "../_lib/sbAdmin";
import { backupUnauthorized, requireBackupPin } from "../_lib/auth";
export const dynamic = 'force-dynamic';

export const runtime = "nodejs";

export async function GET(req) {
  try {
    const auth = requireBackupPin(req);
    if (!auth.ok) return backupUnauthorized(auth);

    const url = new URL(req.url);
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
