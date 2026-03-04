/*
 SYNC ROUTE — ULTRA SMART VERSION (SLEEP PEACEFULLY)
 - Vret "Fantazmat" heshturazi (kthe ok:true pa e shti ne DB)
 - Shpëton klientët offline (i jep kod emergjence nese perplaset)
 - Nuk bllokon queue-n e pajisjes lokale!
*/

import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SERVICE_ROLE || process.env.SUPABASE_SERVICE_ROLE) ||
    process.env.SUPABASE_SERVICE_ROLE ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
);

const PG_DUPLICATE = "23505";

export async function POST(req) {
  try {
    const body = await req.json();
    const { type, data, id, localId, payload } = body || {};

    const stripNonSchemaCols = (row) => {
      if (!row || typeof row !== "object") return row;
      const out = { ...row };
      if ("code_n" in out) delete out.code_n;
      return out;
    };

    const isUuid = (v) =>
      typeof v === "string" &&
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(v);

    // ==========================================
    // 1. INSERT ORDER (Porositë e reja / Offline)
    // ==========================================
    if (type === "insert_order") {
      const raw = data || payload?.insertRow || payload?.data || payload;
      const row = { ...(raw || {}) };

      // Normalizimi i ID-ve
      if (row.id && !row.local_oid) row.local_oid = String(row.id);
      if (row.id) delete row.id;
      if (!row.local_oid && localId) row.local_oid = String(localId);

      const orderData = row.data || {};

      // 🔥 SHTRESA 1: VRASËSI I FANTAZMAVE
      // Nëse s'ka klient, s'ka artikuj dhe s'ka para -> Është mbeturinë (Ghost).
      const hasClient = (row.client_name?.trim() || orderData.client?.name?.trim() || row.client_phone?.trim() || orderData.client?.phone?.trim());
      const hasItems = (orderData.tepiha?.length > 0 || orderData.staza?.length > 0 || orderData.shkallore?.qty > 0);
      const hasMoney = ((row.total || 0) > 0 || (orderData.pay?.euro || 0) > 0);

      if (!hasClient && !hasItems && !hasMoney) {
         // I themi telefonit "U krye", qe ta fshije pergjithmone nga queue, por NUK e ruajme.
         return NextResponse.json({ ok: true, localId, ghost_killed: true }, { status: 200 });
      }

      // 🔥 SHTRESA 2: MBROJTJA E KODIT (Nga Offline)
      let finalCode = 0;
      if (row.code != null) {
        const parsed = Number(row.code);
        finalCode = isNaN(parsed) ? 0 : parsed;
      }
      if (row.code_n != null) {
        const parsedN = Number(row.code_n);
        if (!isNaN(parsedN)) finalCode = parsedN;
      }
      row.code = finalCode;

      // Sigurohemi qe fusha JSON 'data' te mos jete bosh
      if (!row.data) {
          row.data = {
              client: { name: row.client_name || 'Offline', phone: row.client_phone || '' },
              status: row.status || 'pastrim',
              pay: { euro: row.total || 0, paid: row.paid || 0, debt: Math.max(0, (row.total || 0) - (row.paid || 0)) }
          };
      }

      const insertRow = stripNonSchemaCols(row);

      // Funksion i vogel per ta tentu insertimin
      const tryInsert = async (r) => await supabase.from("orders").insert(r);

      let { error } = await tryInsert(insertRow);

      // 🔥 SHTRESA 3: ZGJIDHJA E KONFLIKTEVE (Duplicates)
      if (error) {
        if (error.code === PG_DUPLICATE || /duplicate key/i.test(error.message || "")) {
          // Kontrollojme a eshte fiks e njejta porosi (Dyfishim nga rrjeti i dobet)
          const oid = row.local_oid || null;
          if (oid) {
            const { data: existing } = await supabase.from('orders').select('id, local_oid').eq('local_oid', oid).limit(1);
            if (Array.isArray(existing) && existing.length) {
              return NextResponse.json({ ok: true, localId, existed: true }, { status: 200 });
            }
          }
          
          // NËSE VJEN KËTU: Kodi është zënë nga dikush tjetër! (Psh kodi 0 ose 105).
          // Për të mos humbur klientin e malit, i japim një kod emergjence te madh (psh 99000 + diçka)
          insertRow.code = 990000 + Math.floor(Math.random() * 9999);
          
          const retry = await tryInsert(insertRow);
          
          if (retry.error) {
             // Nese prap deshton (gabim i rralle DB), kthejme error qe mos ta fshije nga telefoni
             return NextResponse.json({ ok: false, error: retry.error.message }, { status: 200 });
          } else {
             // U ruajt me kod emergjence! Telefoni e fshin nga radha.
             return NextResponse.json({ ok: true, localId, code_changed: true }, { status: 200 });
          }
        }
        
        // Gabime te tjera te databazes (jo duplicate)
        return NextResponse.json({ ok: false, error: error.message }, { status: 200 });
      }

      // Sukses!
      return NextResponse.json({ ok: true, localId }, { status: 200 });
    }

    // ==========================================
    // 2. PATCH ORDER DATA (Ndryshime ekzistuese)
    // ==========================================
    if (type === "patch_order_data") {
      const patch = stripNonSchemaCols({
        ...(data || {}),
        updated_at: new Date().toISOString(),
      });

      const q = supabase.from("orders").update(patch);
      const { error } = await (isUuid(String(id || ""))
        ? q.eq("local_oid", String(id))
        : q.eq("id", id));

      if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 200 });
      return NextResponse.json({ ok: true }, { status: 200 });
    }

    // ==========================================
    // 3. SET STATUS (Ndryshim statusi)
    // ==========================================
    if (type === "set_status") {
      const q = supabase
        .from("orders")
        .update({ status: data?.status, updated_at: new Date().toISOString() });

      const { error } = await (isUuid(String(id || ""))
        ? q.eq("local_oid", String(id))
        : q.eq("id", id));

      if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 200 });
      return NextResponse.json({ ok: true }, { status: 200 });
    }

    return NextResponse.json({ ok: false, error: "UNKNOWN_OP_TYPE" }, { status: 200 });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 200 });
  }
}
