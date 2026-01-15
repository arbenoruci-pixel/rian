// app/api/backup/run/route.js
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

function buildClientsFromOrders(orders) {
  const map = new Map();
  for (const o of orders || []) {
    const phone = String(o.client_phone || o.phone || "").trim();
    if (!phone) continue;
    const name = String(o.client_name || o.name || "").trim();
    const cur = map.get(phone) || {
      phone,
      name: name || "",
      orders_count: 0,
      total_sum: 0,
      last_order_at: null,
    };
    cur.orders_count += 1;
    cur.total_sum += Number(o.total || 0) || 0;

    const t = o.created_at ? new Date(o.created_at).getTime() : 0;
    const ct = cur.last_order_at ? new Date(cur.last_order_at).getTime() : 0;
    if (t > ct) cur.last_order_at = o.created_at;

    if (!cur.name && name) cur.name = name;
    map.set(phone, cur);
  }
  return Array.from(map.values());
}

export async function POST(req) {
  try {
    const sb = admin();
    const table = await detectTable(sb);

    const url = new URL(req.url);
    const pinFromUi = String(url.searchParams.get("pin") || "").trim();
    const pin = companyPin() || pinFromUi || "654321";

    const device =
      req.headers.get("x-device") ||
      req.headers.get("user-agent")?.slice(0, 120) ||
      "unknown";

    // snapshot direkt nga DB (pa buildSnapshot)
    const { data: orders, error: e1 } = await sb
      .from("orders")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(10000);

    if (e1) {
      return NextResponse.json(
        { ok: false, error: "ORDERS_FETCH_FAILED", detail: e1.message },
        { status: 500 }
      );
    }

    const clients = buildClientsFromOrders(orders || []);

    const payload = {
      generated_at: new Date().toISOString(),
      orders: orders || [],
      clients,
      orders_count: (orders || []).length,
      clients_count: clients.length,
    };

    const { data: saved, error: e2 } = await sb
      .from(table)
      .insert({ pin, device, payload })
      .select("id, created_at, pin, device")
      .single();

    if (e2) {
      return NextResponse.json(
        { ok: false, error: "BACKUP_INSERT_FAILED", detail: e2.message, table },
        { status: 500 }
      );
    }

    return NextResponse.json({ ok: true, table, saved });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e?.message || String(e) },
      { status: 500 }
    );
  }
}