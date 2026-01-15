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

// Funksion për të pastruar numrin e telefonit (shumë i rëndësishëm për listim)
function cleanPhone(p) {
  const s = String(p || "").replace(/[^0-9]/g, "");
  return s.length > 8 ? s.slice(-9) : s; // Merr 9 shifrat e fundit
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

export async function POST(req) {
  try {
    const sb = admin();
    let body = {};
    try { body = await req.json(); } catch {}

    const pinFromUi = asText(body?.pin || "", "");
    const device = req.headers.get("x-device") || "unknown";

    // 1. Tabela e porosive (Kujdes: Nëse quhet ndryshe, ndërroje këtu)
    const ordersTable = "orders"; 

    // Marrim porositë
    const { data: orders, error: oErr } = await sb
      .from(ordersTable)
      .select("*")
      .order("created_at", { ascending: false })
      .limit(10000); // Limiti i sigurt për Supabase

    if (oErr) throw new Error(`ORDERS_FETCH_FAILED: ${oErr.message}`);

    // 2. Procesimi i Klientëve direkt nga Porositë (pasi tabela 'clients' mungon)
    const stats = new Map();
    const uniqueClients = new Map();

    for (const o of orders || []) {
      const rawPhone = pick(o, ["telefoni", "phone", "tel", "client_phone"]);
      const phoneKey = cleanPhone(rawPhone);
      
      if (!phoneKey) continue;

      // Ruajmë të dhënat e klientit të fundit (emrin dhe kodin)
      if (!uniqueClients.has(phoneKey)) {
        uniqueClients.set(phoneKey, {
          telefoni: rawPhone,
          emri: pick(o, ["emri", "name", "client_name"]) || "-",
          kodi: pick(o, ["kodi", "code", "client_code"]) || "-"
        });
      }

      // Llogarisim statistikat
      const cur = stats.get(phoneKey) || { aktive: 0, total: 0, cope: 0, last: null };
      
      const status = String(o.status || "").toLowerCase();
      const isAktive = !["dorzim", "dorezim", "delivered", "arkiv"].includes(status);
      
      if (isAktive) cur.aktive += 1;
      cur.total += asNum(pick(o, ["total", "shuma", "amount"]));
      cur.cope += asNum(pick(o, ["cope", "pieces", "qty"]));
      
      const dt = o.created_at;
      if (dt && !cur.last) cur.last = dt;

      stats.set(phoneKey, cur);
    }

    // Formatojmë listën përfundimtare për UI
    const finalClients = Array.from(uniqueClients.keys()).map(phoneKey => {
      const info = uniqueClients.get(phoneKey);
      const st = stats.get(phoneKey);
      return {
        kodi: info.kodi,
        emri: info.emri,
        telefoni: info.telefoni,
        aktive: st.aktive,
        cope: st.cope,
        total: Number(st.total.toFixed(2)),
        e_fundit: st.last
      };
    });

    // 3. Ruajtja në tabelën 'app_backups' (Sipas SQL tuaj)
    const payload = {
      generated_at: new Date().toISOString(),
      clients_count: finalClients.length,
      orders_count: orders.length,
      clients: finalClients
    };

    const { data: saved, error: bErr } = await sb
      .from("app_backups")
      .insert({ 
        pin: pinFromUi || "654321", 
        device, 
        payload 
      })
      .select("id, created_at")
      .single();

    if (bErr) throw new Error(`BACKUP_INSERT_FAILED: ${bErr.message}`);

    return NextResponse.json({
      ok: true,
      saved,
      count: finalClients.length
    });

  } catch (e) {
    console.error("Backup Error:", e);
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}
