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
  return String(process.env.BACKUP_PIN || process.env.BACKUP_COMPANY_PIN || "").trim();
}

async function detectBackupsTable(sb) {
  for (const t of ["app_backups", "backups"]) {
    const { error } = await sb.from(t).select("id").limit(1);
    if (!error) return t;
  }
  throw new Error("NO_BACKUPS_TABLE_ACCESS");
}

async function detectClientsTable(sb) {
  for (const t of ["clients", "app_clients"]) {
    const { error } = await sb.from(t).select("id").limit(1);
    if (!error) return t;
  }
  return null;
}

function pickPhone(obj) {
  return String(
    obj.telefoni ??
      obj.phone ??
      obj.tel ??
      obj.client_phone ??
      obj.clientPhone ??
      ""
  ).trim();
}
function pickName(obj) {
  return String(
    obj.emri ?? obj.name ?? obj.client_name ?? obj.clientName ?? ""
  ).trim();
}
function pickCode(obj) {
  const v =
    obj.kodi ??
    obj.code ??
    obj.client_code ??
    obj.clientCode ??
    obj.nr ??
    obj.id ??
    "";
  const s = String(v).trim();
  return s || "-";
}

function normStatus(s) {
  return String(s || "").toLowerCase().trim();
}
function isActiveStatus(s) {
  const st = normStatus(s);
  return !["dorzim", "dorezim", "delivered", "arkiv", "archived"].includes(st);
}

export async function POST(req) {
  try {
    const sb = admin();
    const backupsTable = await detectBackupsTable(sb);

    const url = new URL(req.url);
    const pinFromUi = String(url.searchParams.get("pin") || "").trim();
    const pin = companyPin() || pinFromUi || "654321";

    const device =
      req.headers.get("x-device") ||
      req.headers.get("user-agent")?.slice(0, 120) ||
      "unknown";

    // orders
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

    // aktive by phone
    const activeByPhone = new Map();
    for (const o of orders || []) {
      const phone = pickPhone(o);
      if (!phone) continue;
      if (!isActiveStatus(o.status)) continue;
      activeByPhone.set(phone, (activeByPhone.get(phone) || 0) + 1);
    }

    // clients (source of truth) ose fallback
    let rawClients = [];
    let clientsSource = "fallback_from_orders";

    const clientsTable = await detectClientsTable(sb);
    if (clientsTable) {
      const { data: cdata, error: ce } = await sb
        .from(clientsTable)
        .select("*")
        .order("created_at", { ascending: false })
        .limit(20000);

      if (!ce && Array.isArray(cdata)) {
        rawClients = cdata;
        clientsSource = clientsTable;
      }
    }

    if (!rawClients.length) {
      const seen = new Set();
      for (const o of orders || []) {
        const phone = pickPhone(o);
        if (!phone || seen.has(phone)) continue;
        seen.add(phone);
        rawClients.push(o);
      }
    }

    // normalize për FLETORJA UI
    const clients = rawClients.map((c) => {
      const telefoni = pickPhone(c) || "-";
      const emri = pickName(c) || "-";
      const kodi = pickCode(c);
      const aktive = activeByPhone.get(String(telefoni).trim()) || 0;
      return { kodi, emri, telefoni, aktive };
    });

    const payload = {
      generated_at: new Date().toISOString(),
      clients_source: clientsSource,
      clients,
      orders: orders || [],
      clients_count: clients.length,
      orders_count: (orders || []).length,
    };

    const { data: saved, error: e2 } = await sb
      .from(backupsTable)
      .insert({ pin, device, payload })
      .select("id, created_at, pin, device")
      .single();

    if (e2) {
      return NextResponse.json(
        { ok: false, error: "BACKUP_INSERT_FAILED", detail: e2.message, table: backupsTable },
        { status: 500 }
      );
    }

    return NextResponse.json({
      ok: true,
      table: backupsTable,
      saved,
      meta: { clientsSource, clients_count: clients.length },
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e?.message || String(e) },
      { status: 500 }
    );
  }
}