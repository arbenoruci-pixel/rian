// app/api/backup/run/route.js
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

function getAdminClient() {
  const url =
    process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "";
  const service =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_KEY ||
    "";
  if (!url) throw new Error("MISSING_SUPABASE_URL");
  if (!service) throw new Error("MISSING_SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url, service, { auth: { persistSession: false } });
}

function safePin(p) {
  if (p == null) return null;
  const s = String(p).trim();
  if (!s) return null;
  // lejo 1-20 chars (num/tekst) – mos e bo tepër strict
  if (s.length > 20) return s.slice(0, 20);
  return s;
}

function pickFirst(obj, keys) {
  for (const k of keys) {
    if (obj && obj[k] != null && String(obj[k]).trim() !== "") return obj[k];
  }
  return null;
}

function toNum(v) {
  const n = Number(String(v ?? "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

function getPhoneFromRow(row) {
  const v = pickFirst(row, ["client_phone", "phone", "tel", "telefon", "client_tel"]);
  if (!v) return null;
  return String(v).trim();
}

function getClientNameFromRow(row) {
  const name = pickFirst(row, ["client_name", "name"]);
  if (name) return String(name).trim();
  const first = pickFirst(row, ["first_name", "firstname"]);
  const last = pickFirst(row, ["last_name", "lastname"]);
  const s = `${first || ""} ${last || ""}`.trim();
  return s || null;
}

function getClientCodeFromRow(row) {
  const v = pickFirst(row, ["code", "client_code", "nr", "kodi"]);
  return v == null ? null : String(v).trim();
}

function getOrderPieces(row) {
  return toNum(pickFirst(row, ["pieces", "cope", "qty", "quantity"])) || 0;
}

function getOrderTotal(row) {
  return toNum(pickFirst(row, ["total", "total_eur", "amount", "shuma"])) || 0;
}

function getOrderStatus(row) {
  const v = pickFirst(row, ["status", "stage"]);
  return v ? String(v).trim().toLowerCase() : "";
}

function getOrderTime(row) {
  const v = pickFirst(row, ["updated_at", "created_at", "date"]);
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

async function detectBackupsTable(supabase) {
  const candidates = ["app_backups", "backups"];
  for (const t of candidates) {
    const { error } = await supabase.from(t).select("id").limit(1);
    if (!error) return t;
  }
  throw new Error("NO_BACKUPS_TABLE");
}

export async function GET(req) {
  // lejo GET për “one click”
  const { searchParams } = new URL(req.url);
  const pin = safePin(searchParams.get("pin"));
  return runBackup({ pin, req });
}

export async function POST(req) {
  // lejo POST prej UI (me body)
  let body = {};
  try {
    body = await req.json();
  } catch {}
  const pin = safePin(body?.pin);
  return runBackup({ pin, req });
}

async function runBackup({ pin, req }) {
  try {
    const supabase = getAdminClient();
    const table = await detectBackupsTable(supabase);

    const device =
      req.headers.get("x-device") ||
      req.headers.get("user-agent")?.slice(0, 120) ||
      "unknown";

    // ✅ Server snapshot nga Supabase: orders + clients
    const [{ data: orders, error: e1 }, { data: clients, error: e2 }] =
      await Promise.all([
        supabase
          .from("orders")
          .select("*")
          .order("created_at", { ascending: false })
          .limit(50000),
        supabase
          .from("clients")
          .select("*")
          .order("created_at", { ascending: false })
          .limit(50000),
      ]);

    if (e1) {
      return NextResponse.json(
        { ok: false, error: "ORDERS_FETCH_FAILED", detail: e1.message },
        { status: 500 }
      );
    }
    if (e2) {
      // nëse clients nuk ekziston / s'ka access, mos e blloko backup-in
      // (për prapë, emergjenca kryesore janë porositë)
      // prap e ruajmë snapshot-in me orders.
      // eslint-disable-next-line no-console
      console.warn("CLIENTS_FETCH_FAILED", e2.message);
    }

    const ordersArr = Array.isArray(orders) ? orders : [];
    const clientsArr = Array.isArray(clients) ? clients : [];

    // ✅ Ndërto listë klientash për FLETORJA (nga clients + nga orders)
    const byPhone = new Map();

    // fillimisht klientat nga tabela clients
    for (const c of clientsArr) {
      const phone = getPhoneFromRow(c);
      if (!phone) continue;
      const key = phone;
      const prev = byPhone.get(key) || {
        phone: key,
        code: null,
        name: null,
        active: 0,
        pieces: 0,
        total: 0,
        last_seen: null,
      };
      prev.code = prev.code || getClientCodeFromRow(c);
      prev.name = prev.name || getClientNameFromRow(c);
      // active flag nëse ekziston në DB
      const activeVal = pickFirst(c, ["active", "is_active", "enabled"]);
      if (activeVal != null) prev.active = toNum(activeVal) ? 1 : 0;
      // time
      const t = getOrderTime(c);
      if (t && (!prev.last_seen || t > prev.last_seen)) prev.last_seen = t;
      byPhone.set(key, prev);
    }

    // pastaj agrego nga orders (edhe nëse clients s'ka)
    for (const o of ordersArr) {
      const phone = getPhoneFromRow(o);
      if (!phone) continue;
      const key = phone;
      const prev = byPhone.get(key) || {
        phone: key,
        code: null,
        name: null,
        active: 0,
        pieces: 0,
        total: 0,
        last_seen: null,
      };

      prev.code = prev.code || getClientCodeFromRow(o);
      prev.name = prev.name || getClientNameFromRow(o);

      const st = getOrderStatus(o);
      if (st && st !== "dorzim" && st !== "done" && st !== "completed") {
        prev.active = 1;
      }
      prev.pieces += getOrderPieces(o);
      prev.total += getOrderTotal(o);

      const t = getOrderTime(o);
      if (t && (!prev.last_seen || t > prev.last_seen)) prev.last_seen = t;
      byPhone.set(key, prev);
    }

    const clientsIndex = Array.from(byPhone.values()).sort((a, b) => {
      const ta = a.last_seen || "";
      const tb = b.last_seen || "";
      return tb.localeCompare(ta);
    });

    // ✅ Orders për emergjencë (subset, por me të gjitha fushat kryesore)
    const ordersIndex = ordersArr.map((o) => ({
      id: o.id ?? null,
      code: getClientCodeFromRow(o),
      client_code: getClientCodeFromRow(o),
      phone: getPhoneFromRow(o),
      client_phone: getPhoneFromRow(o),
      name: getClientNameFromRow(o),
      client_name: getClientNameFromRow(o),
      pieces: getOrderPieces(o),
      total: getOrderTotal(o),
      status: getOrderStatus(o) || null,
      created_at: pickFirst(o, ["created_at"]) || null,
      updated_at: pickFirst(o, ["updated_at"]) || null,
      raw: o,
    }));

    const payload = {
      version: "fletore_snapshot_v2",
      generated_at: new Date().toISOString(),
      source: "server_snapshot_orders_clients",
      counts: {
        clients_table: clientsArr.length,
        orders_table: ordersArr.length,
        clients_index: clientsIndex.length,
      },
      clients: clientsIndex,
      orders: ordersIndex,
    };

    const row = {
      device,
      pin: pin || String(process.env.BACKUP_PIN || "0000").trim() || "0000",
      payload,
    };

    const { data: ins, error: e3 } = await supabase
      .from(table)
      .insert(row)
      .select("id, created_at, device, pin")
      .single();

    if (e3) {
      return NextResponse.json(
        { ok: false, error: "SUPABASE_INSERT_FAILED", detail: e3.message },
        { status: 500 }
      );
    }

    return NextResponse.json({ ok: true, saved: ins });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: "BACKUP_RUN_FAILED", detail: e?.message || String(e) },
      { status: 500 }
    );
  }
}