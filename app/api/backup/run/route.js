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

// Ndihmës për të gjetur vlerat pavarësisht emrit të kolonës
function pick(obj, keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (v !== undefined && v !== null && String(v).trim() !== "") return v;
  }
  return null;
}

export async function POST(req) {
  try {
    const sb = admin();
    const url = new URL(req.url);
    const pin = String(url.searchParams.get("pin") || "").trim() || "654321";
    const device = req.headers.get("x-device") || "server-backup";

    // 1. Merr porositë
    const { data: orders, error: oErr } = await sb
      .from("orders")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(20000);

    if (oErr) throw new Error("ORDERS_FETCH_FAILED: " + oErr.message);

    // 2. Provo të marrësh klientët (app_clients ose clients)
    let clientsRaw = [];
    let { data: cData } = await sb.from("app_clients").select("*").limit(10000);
    if (!cData) {
      let { data: cDataAlt } = await sb.from("clients").select("*").limit(10000);
      clientsRaw = cDataAlt || [];
    } else {
      clientsRaw = cData;
    }

    // 3. Logjika e Listimit (Map-imi i Emrave dhe Kodeve)
    // Kjo siguron që klientët të dalin me emra dhe koda
    const stats = new Map();
    const processedClients = clientsRaw.map(c => {
      const tel = pick(c, ["telefoni", "phone", "tel", "client_phone"]);
      return {
        kodi: pick(c, ["kodi", "code", "nr", "client_code"]) || "-",
        emri: pick(c, ["emri", "name", "full_name", "client_name"]) || "-",
        telefoni: tel || "-",
        aktive: 0, total: 0, cope: 0, e_fundit: c.created_at
      };
    });

    // RAW snapshot payload
    const payload = {
      backup_at: new Date().toISOString(),
      counts: { clients: processedClients.length, orders: orders.length },
      clients: processedClients,
      orders: orders // Ruajmë porositë RAW për siguri
    };

    // 4. Insert në app_backups
    const { data: saved, error: bErr } = await sb
      .from("app_backups")
      .insert({ pin, device, payload })
      .select("id, created_at")
      .single();

    if (bErr) throw new Error("INSERT_FAILED: " + bErr.message);

    return NextResponse.json({ ok: true, saved, counts: payload.counts });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}
