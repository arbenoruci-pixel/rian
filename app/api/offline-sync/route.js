import { NextResponse } from "next/server";

// Server-side offline sync endpoint.
// Uses service role key if present; falls back to anon key (so your RLS must allow it).
import { createAdminClientOrNull } from "@/lib/supabaseAdminClient";

// Base numeric codes were migrated to a high range to avoid collisions with
// legacy/local counters (e.g., 1..999999). Any incoming code below this floor
// is treated as a *local* placeholder and will be reassigned server-side.
const BASE_CODE_FLOOR = 1;

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

    const op = await req.json();
    const type = op?.type;
    const payload = op?.payload || {};

    // Helpers: some older pages used UPSERT_ORDER without op_id.
    // Here we accept and route it safely.
    const looksLikeTransport = (p) => {
      const s = String(p?.tcode ?? p?.client_tcode ?? p?.code_str ?? p?.code ?? "").trim().toUpperCase();
      return s.startsWith("T");
    };

    // Legacy types kept for compatibility
    if(type === "save_order"){
      // Older builds sometimes sent non-UUID ids (e.g. "order_...") which fails when `orders.id` is UUID.
      // Prefer idempotency by `code` when available; otherwise strip `id` and insert.
      const row = { ...(payload || {}) };
      const hasCode = row.code != null;
      // Strip invalid ids (best-effort)
      if (typeof row.id === 'string' && row.id && !row.id.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)) {
        delete row.id;
      }

      let error = null;
      if (hasCode) {
        const r1 = await sb.from("orders").upsert(row, { onConflict: "code_n" });
        error = r1.error;
      } else {
        const r2 = await sb.from("orders").insert(row);
        error = r2.error;
      }
      if(error) return NextResponse.json({ ok:false, error: error.message }, { status: 200 });
      return NextResponse.json({ ok:true });
    }

    // --- Unified types from IndexedDB ops queue ---
    if(type === "upsert_client"){
      const phone = normPhone(payload.phone);
      const name = normName(payload.full_name || payload.name);
      const code = normCode(payload.code);
      const photo_url = payload.photo_url || null;
      const c = await upsertClientByPhone(sb, { code, phone, name, photo_url });
      return NextResponse.json({ ok:true, client_id: c?.id || null, code: c?.code ?? code ?? null });
    }

    if(type === "insert_order"){
      // Some builds queued ops with non-UUID ids. Use `code` as idempotency key when possible.
      const row = { ...(payload || {}) };

      // Idempotency for offline replays: if we have a local client id inside data.id,
      // and it already exists in DB, acknowledge (client can delete op safely).
      const localId = getLocalIdFromData(row.data);
      if (localId) {
        const { data: existing, error: exErr } = await sb
          .from("orders")
          .select("id, code, code_n")
          .eq("data->>id", localId)
          .limit(1);
        if (!exErr && existing && existing.length) {
          return NextResponse.json({ ok: true, localId, code: existing[0].code ?? existing[0].code_n, existed: true });
        }
      }

      // Critical: NEVER trust client-provided code_n (it may collide with existing rows).
      // Let the DB trigger assign a safe code_n.
      if (row.code_n != null) delete row.code_n;

      // If id is not a UUID, strip it so DB can generate one.
      if (typeof row.id === 'string' && row.id && !row.id.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)) {
        delete row.id;
      }

      const hasCode = row.code != null;
      const incomingCode = hasCode ? Number(row.code) : null;
      const legacyLocalCode = Number.isFinite(incomingCode) && incomingCode < BASE_CODE_FLOOR;

      // If legacy local code, insert with a temporary unique negative code,
      // then promote code/code_n to DB-assigned code_n.
      if (legacyLocalCode) {
        row.code = -Date.now();
        const { data: ins, error: insErr } = await sb
          .from("orders")
          .insert(row)
          .select("id, code, code_n, data")
          .single();
        if (insErr) return NextResponse.json({ ok:false, error: insErr.message }, { status: 200 });

        const newCode = ins.code_n;
        const newData = (ins.data && typeof ins.data === 'object') ? { ...ins.data } : (row.data && typeof row.data === 'object' ? { ...row.data } : {});
        newData.code = newCode;
        newData.code_n = newCode;

        const { error: updErr } = await sb
          .from("orders")
          .update({ code: newCode, code_n: newCode, data: newData })
          .eq("id", ins.id);
        if (updErr) return NextResponse.json({ ok:false, error: updErr.message }, { status: 200 });

        return NextResponse.json({ ok:true, localId: localId || null, code: newCode, reassigned: true });
      }

      let error = null;
      if (hasCode) {
        const r1 = await sb.from("orders").upsert(row, { onConflict: "code_n" });
        error = r1.error;
        // If there's no unique constraint on `code`, fallback to insert.
        if (error) {
          const r2 = await sb.from("orders").insert(row);
          error = r2.error;
        }
      } else {
        const r3 = await sb.from("orders").insert(row);
        error = r3.error;
      }

      if(error) return NextResponse.json({ ok:false, error: error.message }, { status: 200 });
      return NextResponse.json({ ok:true, localId: localId || null, code: row.code ?? null });
    }

    if(type === "set_status"){
      const { id, status, ...rest } = payload || {};
      if(!id) return NextResponse.json({ ok:false, error:"MISSING_ID" }, { status: 200 });

      // If this is a transport order (id is tcode or payload has tcode), update transport_orders.
      const isT = looksLikeTransport(payload);
      if (isT) {
        const tcode = String(payload.tcode ?? payload.client_tcode ?? payload.code_str ?? payload.code ?? id).trim().toUpperCase();
        const visit_nr = payload.visit_nr ?? payload.visitNr ?? null;
        // Best-effort match by (client_tcode, visit_nr) else by client_tcode only.
        let q = sb.from("transport_orders").update({ status, updated_at: new Date().toISOString(), ...rest }).eq("client_tcode", tcode);
        if (visit_nr !== null && visit_nr !== undefined) q = q.eq("visit_nr", visit_nr);
        const { error } = await q;
        if(error) return NextResponse.json({ ok:false, error: error.message }, { status: 200 });
        return NextResponse.json({ ok:true });
      }

      // Base orders table
      const { error } = await sb.from("orders").update({ status, updated_at: new Date().toISOString(), ...rest }).eq("id", id);
      if(error) return NextResponse.json({ ok:false, error: error.message }, { status: 200 });
      return NextResponse.json({ ok:true });
    }

    if(type === "offline_pranimi"){
      const { code, phone, name, status, data, total, paid, client_photo_url } = extractOrder(payload?.order || payload);
      if(!code){
        return NextResponse.json({ ok:false, error:"MISSING_CODE" }, { status: 200 });
      }

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
        .upsert(orderRow, { onConflict: "code_n" })
        .select("id, code")
        .single();

      if(oErr){
        return NextResponse.json({ ok:false, error: oErr.message }, { status: 200 });
      }

      return NextResponse.json({ ok:true, order_id: ins?.id || null, code: ins?.code || code });
    }

    if(type === "offline_transport_pranimi"){
      const p = payload?.order || payload;
      const ex = extractTransportOrder(p);
      if(!ex.tcode){
        return NextResponse.json({ ok:false, error:"MISSING_TCODE" }, { status: 200 });
      }

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
      if(error) return NextResponse.json({ ok:false, error: error.message }, { status: 200 });
      return NextResponse.json({ ok:true });
    }

    // Older builds: a raw UPSERT_ORDER op. Route by code prefix.
    if(type === "UPSERT_ORDER"){
      const p = payload?.order || payload;
      if (looksLikeTransport(p)) {
        // Treat as transport order
        const ex = extractTransportOrder(p);
        if(!ex.tcode) return NextResponse.json({ ok:false, error:"MISSING_TCODE" }, { status: 200 });
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
        const { error } = await sb.from("transport_orders").upsert(row, { onConflict: "client_tcode,visit_nr" });
        if(error) return NextResponse.json({ ok:false, error: error.message }, { status: 200 });
        return NextResponse.json({ ok:true });
      }

      // Treat as base
      const { code, phone, name, status, data, total, paid, client_photo_url } = extractOrder(p);
      if(!code) return NextResponse.json({ ok:false, error:"MISSING_CODE" }, { status: 200 });
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
        updated_at: now,
        created_at: now,
      };
      const { error } = await sb.from("orders").upsert(orderRow, { onConflict: "code_n" });
      if(error) return NextResponse.json({ ok:false, error: error.message }, { status: 200 });
      return NextResponse.json({ ok:true });
    }

    if(type === "add_payment"){
      const { error } = await sb.from("payments").insert(payload);
      if(error) return NextResponse.json({ ok:false, error: error.message }, { status: 200 });
      return NextResponse.json({ ok:true });
    }


    if(type === "patch_order_data"){
      const { id, patch } = payload || {};
      if(!id || !patch || typeof patch !== "object"){
        return NextResponse.json({ ok:false, error:"MISSING_ID_OR_PATCH" }, { status: 200 });
      }

      // Merge patch into orders.data (JSONB)
      const { data: row, error: rErr } = await sb
        .from("orders")
        .select("id,data")
        // RREGULLIMI KRYESOR: Heqim Number() për ID që janë UUID
        .eq("id", id)
        .maybeSingle();

      if(rErr){
        return NextResponse.json({ ok:false, error: rErr.message }, { status: 200 });
      }

      const current = (row && row.data && typeof row.data === "object") ? row.data : {};
      const merged = { ...current, ...patch };

      const { error: uErr } = await sb
        .from("orders")
        .update({ data: merged, updated_at: new Date().toISOString() })
        // RREGULLIMI KRYESOR: Heqim Number() për ID që janë UUID
        .eq("id", id);

      if(uErr){
        return NextResponse.json({ ok:false, error: uErr.message }, { status: 200 });
      }
      return NextResponse.json({ ok:true });
    }

    return NextResponse.json({ ok:false, error:"UNKNOWN_OP_TYPE" }, { status: 200 });
  }catch(e){
    return NextResponse.json({ ok:false, error: String(e?.message || e) }, { status: 200 });
  }
}
