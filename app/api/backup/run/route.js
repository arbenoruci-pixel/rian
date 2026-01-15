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

async function detectClientsTable(sb) {
  for (const t of ["clients", "app_clients"]) {
    const { error } = await sb.from(t).select("id").limit(1);
    if (!error) return t;
  }
  return null;
}

function requirePin(pin) {
  const required = String(process.env.BACKUP_PIN || "").trim();
  if (!required) return { ok: true }; // no pin enforcement if env not set
  if (!pin) return { ok: false, error: "PIN_REQUIRED" };
  if (String(pin).trim() !== required) return { ok: false, error: "INVALID_PIN" };
  return { ok: true };
}

export async function POST(req) {
  try {
    const sb = admin();
    const backupsTable = await detectBackupsTable(sb);

    const url = new URL(req.url);
    const pin = String(url.searchParams.get("pin") || "").trim();

    const pinCheck = requirePin(pin);
    if (!pinCheck.ok) {
      return NextResponse.json({ ok: false, error: pinCheck.error }, { status: 401 });
    }

    const device =
      req.headers.get("x-device") ||
      req.headers.get("user-agent")?.slice(0, 120) ||
      "unknown";

    // ✅ 1) fetch ALL orders (RAW)
    const { data: orders, error: oErr } = await sb
      .from("orders")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(20000);

    if (oErr) {
      return NextResponse.json(
        { ok: false, error: "ORDERS_FETCH_FAILED", detail: oErr.message },
        { status: 500 }
      );
    }

    // ✅ 2) fetch ALL clients from clients/app_clients if exists (RAW)
    const clientsTable = await detectClientsTable(sb);
    let clients = [];
    let clients_source = "none";

    if (clientsTable) {
      const { data: cdata, error: cErr } = await sb
        .from(clientsTable)
        .select("*")
        .order("created_at", { ascending: false })
        .limit(20000);

      if (cErr) {
        return NextResponse.json(
          { ok: false, error: "CLIENTS_FETCH_FAILED", detail: cErr.message, table: clientsTable },
          { status: 500 }
        );
      }

      clients = cdata || [];
      clients_source = clientsTable;
    }

    // ✅ RAW snapshot payload (no summaries that destroy data)
    const payload = {
      backup_at: new Date().toISOString(),
      pin,
      clients_source,
      counts: {
        clients: clients.length,
        orders: (orders || []).length,
      },
      clients,
      orders: orders || [],
    };

    // ✅ insert backup
    const { data: saved, error: bErr } = await sb
      .from(backupsTable)
      .insert({ pin, device, payload })
      .select("id, created_at, pin, device")
      .single();

    if (bErr) {
      return NextResponse.json(
        { ok: false, error: "BACKUP_INSERT_FAILED", detail: bErr.message, table: backupsTable },
        { status: 500 }
      );
    }

    return NextResponse.json({
      ok: true,
      table: backupsTable,
      saved,
      counts: payload.counts,
      clients_source,
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: "BACKUP_RUN_FAILED", detail: e?.message || String(e) },
      { status: 500 }
    );
  }
}
