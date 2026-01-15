import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

function admin() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return createClient(url, key, { auth: { persistSession: false } });
}

export async function GET(req) {
  try {
    const sb = admin();
    const url = new URL(req.url);
    const pin = String(url.searchParams.get("pin") || "").trim();

    if (!pin) return NextResponse.json({ ok: false, error: "PIN_REQUIRED" }, { status: 400 });

    const { data, error } = await sb
      .from("app_backups")
      .select("*")
      .eq("pin", pin)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw error;
    if (!data) return NextResponse.json({ ok: false, error: "NO_BACKUP" }, { status: 404 });

    // Kthejmë backup-in me klientët e listuar saktë
    return NextResponse.json({ 
      ok: true, 
      backup: {
        ...data,
        clients: data.payload.clients || []
      } 
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}
