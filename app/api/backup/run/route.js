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

// ✅ detect clients table (source of truth)
async function detectClientsTable(sb) {
  for (const t of ["clients", "app_clients"]) {
    const { error } = await sb.from(t).select("id").limit(1);
    if (!error) return t;
  }
  return null; // fallback later
}

// fallback only
function buildClientsFromOrders(orders) {
  const map = new Map();
  for (const o of orders || []) {
    const phone = String(o.client_phone || o.phone || "").trim();
    if (!phone) continue;
    const name = String(o.client_name || o.name || "").trim();

    const cur = map.get(phone) || {
      phone,
      name: name || "",
    };

    if (!cur.name && name) cur.name = name;
    map.set(phone, cur);
  }
  return Array.from(map.values());
}

function normStatus(s) {
  return String(s || "").toLowerCase().trim();
}

function isActiveStatus(s) {
  const st = normStatus(s);
  // ndrysho këtu vetëm nëse ti përdor emra tjerë
  // active = gjithçka që s’është e dorëzuar/arkivuar
  return !["dorzim", "dorezim", "delivered", "arkiv", "archived"].includes(st);
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

    // 1) fetch orders
    const { data: orders, error: e1 } = await sb
      .from("orders")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(20000);

    if (e1) {
      return NextResponse.json(
        { ok: false, error: "ORDERS_FETCH_FAILED", detail: e1.message },
        { status: 500 }
      );
    }

    // 2) fetch clients from clients table if exists
    const clientsTable = await detectClientsTable(sb);

    let clients = [];
    let clients_source = "fallback_from_orders";

    if (clientsTable) {
      const { data: cdata, error: e2 } = await sb
        .from(clientsTable)
        .select("*")
        .order("created_at", { ascending: false })
        .limit(20000);

      if (!e2 && Array.isArray(cdata)) {
        clients = cdata;
        clients_source = clientsTable;
      } else {
        // fallback if clients table read fails
        clients = buildClientsFromOrders(orders || []);
      }
    } else {
      clients = buildClientsFromOrders(orders || []);
    }

    // 3) build ACTIVE COUNTS by phone
    const activeByPhone = new Map();
    for (const o of orders || []) {
      const phone = String(o.client_phone || o.phone || "").trim();
      if (!phone) continue;
      if (!isActiveStatus(o.status)) continue;
      activeByPhone.set(phone, (activeByPhone.get(phone) || 0) + 1);
    }

    // 4) normalize client rows minimally for FLETORJA (without UI changes)
    // keep original fields too, but add computed active_count
    const clients_normalized = (clients || []).map((c) => {
      const phone =
        String(c.phone || c.telefon || c.tel || c.client_phone || "").trim();
      const name =
        String(c.name || c.emri || c.client_name || "").trim() || "-";
      const active_count = activeByPhone.get(phone) || 0;
      return { ...c, phone, name, active_count };
    });

    const payload = {
      generated_at: new Date().toISOString(),
      clients_source,
      orders: orders || [],
      clients: clients_normalized,
      orders_count: (orders || []).length,
      clients_count: clients_normalized.length,
    };

    const { data: saved, error: e3 } = await sb
      .from(table)
      .insert({ pin, device, payload })
      .select("id, created_at, pin, device")
      .single();

    if (e3) {
      return NextResponse.json(
        { ok: false, error: "BACKUP_INSERT_FAILED", detail: e3.message, table },
        { status: 500 }
      );
    }

    return NextResponse.json({
      ok: true,
      table,
      saved,
      meta: { clients_source, clients_count: clients_normalized.length },
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e?.message || String(e) },
      { status: 500 }
    );
  }
}