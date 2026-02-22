import { NextResponse } from "next/server";

// Server-side offline sync endpoint.
// Uses service role key if present; falls back to anon key (so your RLS must allow it).
import { createAdminClientOrNull } from "@/lib/supabaseAdminClient";

function getLocalIdFromData(data) {
  try {
    if (!data || typeof data !== "object") return null;
    const v = data.id;
    if (!v) return null;
    return String(v);
  } catch {
    return null;
  }
}

function normPhone(p){
  return String(p||"").replace(/\s+/g,"").replace(/[^0-9+]/g,"");
}
function normName(n){
  return String(n||"").trim();
}
function normCode(raw){
  const s = String(raw ?? "").trim();
  const digits = s.replace(/\D+/g,"").replace(/^0+/,"");
  const n = Number(digits || 0);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function extractOrder(o){
  const order = (o && typeof o === "object") ? o : {};
  const client = (order.client && typeof order.client === "object") ? order.client : {};

  const code = normCode(client.code ?? order.code ?? order.code_n);
  const phone = normPhone(client.phone ?? order.client_phone);
  const name = normName(client.name ?? order.client_name);

  const status = String(order.status || "pastrim").toLowerCase();
  const data = order; // keep full payload for now (already has _audit in client)

  const total = Number(order?.pay?.euro ?? order?.total ?? 0) || 0;
  const paid = Number(order?.pay?.paid ?? order?.paid ?? 0) || 0;

  return { code, phone, name, status, data, total, paid, client_photo_url: client.photoUrl || null };
}

function extractTransportOrder(o){
  const order = (o && typeof o === "object") ? o : {};
  // Transport code can appear as: tcode, code, client_tcode, code_str
  const tcodeRaw = String(order.tcode ?? order.code ?? order.client_tcode ?? order.code_str ?? "").trim();
  const tcode = tcodeRaw.toUpperCase();
  const visit_nr = order.visit_nr ?? order.visitNr ?? order.visit ?? null;
  const status = String(order.status || "pastrim").toLowerCase();

  // Phone/name best-effort
  const phone = normPhone(order.phone ?? order.client_phone ?? order.client?.phone);
  const name = normName(order.name ?? order.client_name ?? order.client?.name);

  const total = Number(order?.pay?.euro ?? order?.total ?? 0) || 0;
  const paid = Number(order?.pay?.paid ?? order?.paid ?? 0) || 0;

  return {
    tcode: tcode || null,
    visit_nr: (visit_nr === undefined ? null : visit_nr),
    status,
    phone,
    name,
    total,
    paid,
    data: order,
  };
}

async function upsertClientByPhone(sb, { code, phone, name, photo_url }){
  // If no phone, we cannot safely match; just return null.
  if(!phone){
    return { id: null, code: code ?? null };
  }

  // Try find existing by phone
  const { data: found, error: fErr } = await sb
    .from("clients")
    .select("id, code")
    .eq("phone", phone)
    .maybeSingle();

  if(!fErr && found?.id){
    // Best-effort update name/photo
    try{
      await sb.from("clients").update({
        full_name: name || null,
        first_name: (name || "").split(/\s+/)[0] || null,
        last_name: (name || "").split(/\s+/).slice(1).join(" ") || null,
        photo_url: photo_url || null,
        updated_at: new Date().toISOString()
      }).eq("id", found.id);
    }catch(_e){}
    return { id: found.id, code: found.code ?? code ?? null };
  }

  // Insert new client
  const insertRow = {
    code: code ?? null,
    phone,
    full_name: name || null,
    first_name: (name || "").split(/\s+/)[0] || null,
    last_name: (name || "").split(/\s+/).slice(1).join(" ") || null,
    photo_url: photo_url || null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const { data: ins, error: iErr } = await sb
    .from("clients")
    .insert(insertRow)
    .select("id, code")
    .single();

  if(iErr){
    // If concurrent insert happened, retry fetch by phone
    const { data: found2 } = await sb
      .from("clients")
      .select("id, code")
      .eq("phone", phone)
      .maybeSingle();
    return { id: found2?.id || null, code: found2?.code ?? code ?? null };
  }

  return { id: ins?.id || null, code: ins?.code ?? code ?? null };
}

export async function POST(req){
  try{
    const sb = createAdminClientOrNull();
    if(!sb){
      return NextResponse.json({ ok:false, error:"SUPABASE_ADMIN_NOT_AVAILABLE" }, { status: 200 });
    }

    const body = await req.json();

    // Accept BOTH shapes:
    // 1) Single op: { type, payload, op_id, ... }
    // 2) Batch: { ops: [{ type, payload, op_id }, ...] }
    const ops = Array.isArray(body?.ops) ? body.ops : [body];

    const results = [];
    const localIds = [];

    const looksLikeTransport = (p) => {
      const s = String(p?.tcode ?? p?.client_tcode ?? p?.code_str ?? p?.code ?? "").trim().toUpperCase();
      return s.startsWith("T");
    };

    const handleOp = async (op) => {
      const rawType = op?.type;
      const payload = op?.payload || {};
      const type = (rawType === "UPSERT_ORDER" || rawType === "upsert_order") ? "insert_order" : rawType;

      if(type === "save_order"){
        const row = { ...(payload || {}) };
        // Strip invalid ids (best-effort)
        if (typeof row.id === 'string' && row.id && !row.id.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)) {
          delete row.id;
        }
        // Prefer idempotency by code when available
        const hasCode = row.code != null;
        const r = hasCode
          ? await sb.from("orders").upsert(row, { onConflict: "code" })
          : await sb.from("orders").insert(row);
        if(r.error) return { ok:false, error: r.error.message };
        return { ok:true };
      }

      if(type === "upsert_client"){
        const phone = normPhone(payload.phone);
        const name = normName(payload.full_name || payload.name);
        const code = normCode(payload.code);
        const photo_url = payload.photo_url || null;
        const c = await upsertClientByPhone(sb, { code, phone, name, photo_url });
        return { ok:true, client_id: c?.id || null, code: c?.code ?? code ?? null };
      }

      if(type === "insert_order"){
        // UNIFIKIM + RREGULLA E IDENTITETIT:
        // - KODI (code) është identiteti permanent dhe NUK ndryshohet nga serveri.
        // - Offline merr kode nga LOCAL POOL (të rezervuara më herët nga DB për PIN).
        // - Këtu bëjmë UPSERT idempotent me onConflict: code.
        const row = { ...(payload || {}) };

        // If id is not a UUID, strip it so DB can generate one.
        if (typeof row.id === 'string' && row.id && !row.id.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)) {
          delete row.id;
        }

        // If we have a local client id inside data.id and it already exists in DB, acknowledge.
        const localId = getLocalIdFromData(row.data);
        if (localId) {
          const { data: existing, error: exErr } = await sb
            .from("orders")
            .select("id, code, code_n")
            .eq("data->>id", localId)
            .limit(1);
          if (!exErr && existing && existing.length) {
            return { ok:true, localId, code: existing[0].code ?? existing[0].code_n, existed: true };
          }
        }

        // Enforce numeric code and mirror into code_n for compatibility
        const codeNum = normCode(row.code ?? row.code_n);
        if(!codeNum) return { ok:false, error:"MISSING_CODE" };
        row.code = codeNum;
        row.code_n = codeNum;

        // Ensure updated_at
        if(!row.updated_at) row.updated_at = new Date().toISOString();
        if(!row.created_at) row.created_at = row.updated_at;

        // Idempotent upsert by code
        const { error } = await sb
          .from("orders")
          .upsert(row, { onConflict: "code" });

        if(error) return { ok:false, error: error.message };
        return { ok:true, localId: localId || null, code: codeNum };
      }

      if(type === "set_status"){
        const { id, status, ...rest } = payload || {};
        if(!id) return { ok:false, error:"MISSING_ID" };

        const isT = looksLikeTransport(payload);
        if (isT) {
          const tcode = String(payload.tcode ?? payload.client_tcode ?? payload.code_str ?? payload.code ?? id).trim().toUpperCase();
          const visit_nr = payload.visit_nr ?? payload.visitNr ?? null;
          let q = sb.from("transport_orders").update({ status, updated_at: new Date().toISOString(), ...rest }).eq("client_tcode", tcode);
          if (visit_nr !== null && visit_nr !== undefined) q = q.eq("visit_nr", visit_nr);
          const { error } = await q;
          if(error) return { ok:false, error: error.message };
          return { ok:true };
        }

        const { error } = await sb.from("orders").update({ status, updated_at: new Date().toISOString(), ...rest }).eq("id", id);
        if(error) return { ok:false, error: error.message };
        return { ok:true };
      }

      if(type === "offline_pranimi"){
        const { code, phone, name, status, data, total, paid, client_photo_url } = extractOrder(payload?.order || payload);
        if(!code) return { ok:false, error:"MISSING_CODE" };

        const c = await upsertClientByPhone(sb, { code, phone, name, photo_url: client_photo_url });
        const now = new Date().toISOString();

        const orderRow = {
          code,
          code_n: code,
          status,
          client_name: name || null,
          client_phone: phone || null,
          client_id: c?.id || null,
          client_code: c?.code ?? code,
          data,
          total,
          paid,
          created_at: now,
          updated_at: now,
        };

        const { data: ins, error: oErr } = await sb
          .from("orders")
          .upsert(orderRow, { onConflict: "code" })
          .select("id, code")
          .single();

        if(oErr) return { ok:false, error: oErr.message };
        return { ok:true, order_id: ins?.id || null, code: ins?.code || code };
      }

      if(type === "offline_transport_pranimi"){
        const p = payload?.order || payload;
        const ex = extractTransportOrder(p);
        if(!ex.tcode) return { ok:false, error:"MISSING_TCODE" };

        const now = new Date().toISOString();
        const row = {
          client_tcode: ex.tcode,
          visit_nr: ex.visit_nr,
          status: ex.status,
          data: ex.data,
          total: ex.total,
          paid: ex.paid,
          client_name: ex.name || null,
          client_phone: ex.phone || null,
          updated_at: now,
          created_at: now,
        };

        const { error } = await sb
          .from("transport_orders")
          .upsert(row, { onConflict: "client_tcode,visit_nr" });
        if(error) return { ok:false, error: error.message };
        return { ok:true };
      }

      if(type === "add_payment"){
        const { error } = await sb.from("payments").insert(payload);
        if(error) return { ok:false, error: error.message };
        return { ok:true };
      }

      if(type === "patch_order_data"){
        const { id, patch } = payload || {};
        if(!id || !patch || typeof patch !== "object"){
          return { ok:false, error:"MISSING_ID_OR_PATCH" };
        }

        const { data: row, error: rErr } = await sb
          .from("orders")
          .select("id,data")
          .eq("id", id)
          .maybeSingle();

        if(rErr) return { ok:false, error: rErr.message };

        const current = (row && row.data && typeof row.data === "object") ? row.data : {};
        const merged = { ...current, ...patch };

        const { error: uErr } = await sb
          .from("orders")
          .update({ data: merged, updated_at: new Date().toISOString() })
          .eq("id", id);

        if(uErr) return { ok:false, error: uErr.message };
        return { ok:true };
      }

      // IMPORTANT: Mos e blloko queue në UNKNOWN_OP_TYPE.
      // Kthejmë ok:false, por client-at tanë e fshijnë këtë op dhe vazhdojnë.
      return { ok:false, error:"UNKNOWN_OP_TYPE", type: String(rawType || "") };
    };

    for (const op of ops) {
      const r = await handleOp(op);
      results.push(r);
      if (r?.localId) localIds.push(r.localId);
    }

    const nonBlocking = (r) => !r || r.ok || r.error === "UNKNOWN_OP_TYPE";
    const allOk = results.every(nonBlocking);
    return NextResponse.json({ ok: allOk, results, localIds }, { status: 200 });
  }catch(e){
    return NextResponse.json({ ok:false, error: String(e?.message || e) }, { status: 200 });
  }
}
