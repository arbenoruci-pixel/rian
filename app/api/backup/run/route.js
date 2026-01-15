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

async function detectTable(sb, candidates) {
  for (const t of candidates) {
    const { error } = await sb.from(t).select("id").limit(1);
    if (!error) return t;
  }
  return null;
}

function pick(obj, keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (v !== undefined && v !== null && String(v).trim() !== "") return v;
  }
  return null;
}

function asText(v, fallback = "-") {
  const s = String(v ?? "").trim();
  return s ? s : fallback;
}

function asNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function normStatus(s) {
  return String(s || "").toLowerCase().trim();
}

function isActiveOrderStatus(s) {
  const st = normStatus(s);
  return !["dorzim", "dorezim", "delivered", "arkiv", "archived"].includes(st);
}

export async function POST(req) {
  try {
    const sb = admin();

    // PIN check (company pin wins)
    let body = {};
    try { body = await req.json(); } catch {}
    const pinFromUi = asText(body?.pin || "", "");
    const mustPin = companyPin();
    const pin = mustPin || pinFromUi || "654321";
    if (mustPin && pinFromUi && pinFromUi !== mustPin) {
      return NextResponse.json({ ok: false, error: "PIN_REQUIRED" }, { status: 401 });
    }

    const backupsTable = await detectTable(sb, ["app_backups", "backups"]);
    if (!backupsTable) throw new Error("NO_BACKUPS_TABLE_ACCESS");

    const clientsTable = await detectTable(sb, ["clients", "app_clients"]);
    // orders table is fixed in your app
    const ordersTable = "orders";

    // fetch orders (for counts, totals, last date)
    const { data: orders, error: oErr } = await sb
      .from(ordersTable)
      .select("*")
      .order("created_at", { ascending: false })
      .limit(50000);

    if (oErr) {
      return NextResponse.json(
        { ok: false, error: "ORDERS_FETCH_FAILED", detail: oErr.message },
        { status: 500 }
      );
    }

    // build stats by phone (aktive count + total sum + last date + pieces)
    const stats = new Map(); // phone -> { aktive, total, cope, last }
    for (const o of orders || []) {
      const phone = asText(
        pick(o, ["telefoni", "phone", "tel", "client_phone", "clientPhone"]),
        ""
      );
      if (!phone) continue;

      const cur = stats.get(phone) || { aktive: 0, total: 0, cope: 0, last: null };
      if (isActiveOrderStatus(o.status)) cur.aktive += 1;

      // totals / pieces (try many keys)
      cur.total += asNum(pick(o, ["total", "shuma", "amount", "sum_total", "grand_total"]));
      cur.cope += asNum(pick(o, ["cope", "pieces", "pieces_count", "qty", "sasi"]));

      const dt = pick(o, ["updated_at", "created_at", "ready_at", "picked_up_at"]);
      if (dt && !cur.last) cur.last = dt; // orders are desc sorted, first hit is latest
      stats.set(phone, cur);
    }

    // fetch clients (ALL)
    let rawClients = [];
    let clientsSource = "fallback_from_orders";
    if (clientsTable) {
      const { data: cdata, error: cErr } = await sb
        .from(clientsTable)
        .select("*")
        .order("created_at", { ascending: false })
        .limit(50000);
      if (!cErr && Array.isArray(cdata)) {
        rawClients = cdata;
        clientsSource = clientsTable;
      }
    }

    // fallback (unique phones from orders) ONLY if no clients table
    if (!rawClients.length) {
      const seen = new Set();
      for (const o of orders || []) {
        const phone = asText(
          pick(o, ["telefoni", "phone", "tel", "client_phone", "clientPhone"]),
          ""
        );
        if (!phone || seen.has(phone)) continue;
        seen.add(phone);
        rawClients.push(o);
      }
    }

    // normalize clients for FLETORJA (KEYS MUST MATCH UI)
    const clients = rawClients.map((c) => {
      const telefoni = asText(pick(c, ["telefoni", "phone", "tel", "client_phone", "clientPhone"]), "-");
      const emri = asText(pick(c, ["emri", "name", "client_name", "clientName", "full_name"]), "-");
      const kodi = asText(pick(c, ["kodi", "code", "nr", "client_code", "clientCode", "client_nr"]), "-");

      const st = stats.get(telefoni) || { aktive: 0, total: 0, cope: 0, last: null };

      return {
        kodi,
        emri,
        telefoni,
        aktive: st.aktive || 0,
        cope: st.cope || 0,
        total: Number((st.total || 0).toFixed(2)),
        e_fundit: st.last || null,
      };
    });

    const payload = {
      generated_at: new Date().toISOString(),
      clients_source: clientsSource,
      clients_count: clients.length,
      orders_count: (orders || []).length,
      clients,
      // keep orders too (for emergency)
      orders: orders || [],
    };

    const device =
      req.headers.get("x-device") ||
      req.headers.get("user-agent")?.slice(0, 120) ||
      "unknown";

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
      meta: { pin, clients_count: clients.length, orders_count: (orders || []).length, clientsSource },
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}