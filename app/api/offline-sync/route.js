import { NextResponse } from "next/server";
import { createAdminClientOrNull } from "@/lib/supabaseAdminClient";

// Any incoming code below this floor is treated as a local placeholder and can be reassigned.
const BASE_CODE_FLOOR = 1;

// ----------------- utils -----------------
function safeObj(v) {
  return v && typeof v === "object" ? v : {};
}

function isUuid(v) {
  if (typeof v !== "string") return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

function getLocalIdFromData(data) {
  try {
    const o = safeObj(data);
    const v = o.id;
    if (!v) return null;
    return String(v);
  } catch {
    return null;
  }
}

function normPhone(p) {
  return String(p || "")
    .replace(/\s+/g, "")
    .replace(/[^0-9+]/g, "");
}
function normName(n) {
  return String(n || "").trim();
}
function normCode(raw) {
  const s = String(raw ?? "").trim();
  const digits = s.replace(/\D+/g, "").replace(/^0+/, "");
  const n = Number(digits || 0);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function extractOrder(o) {
  const order = safeObj(o);
  const client = safeObj(order.client);

  const code = normCode(client.code ?? order.code ?? order.code_n);
  const phone = normPhone(client.phone ?? order.client_phone);
  const name = normName(client.name ?? order.client_name);

  const status = String(order.status || "pastrim").toLowerCase();
  const data = order;

  const total = Number(order?.pay?.euro ?? order?.total ?? 0) || 0;
  const paid = Number(order?.pay?.paid ?? order?.paid ?? 0) || 0;

  return {
    code,
    phone,
    name,
    status,
    data,
    total,
    paid,
    client_photo_url: client.photoUrl || null,
  };
}

function extractTransportOrder(o) {
  const order = safeObj(o);
  const tcodeRaw = String(order.tcode ?? order.code ?? order.client_tcode ?? order.code_str ?? "").trim();
  const tcode = tcodeRaw.toUpperCase();

  const visit_nr = order.visit_nr ?? order.visitNr ?? order.visit ?? null;
  const status = String(order.status || "pastrim").toLowerCase();

  const phone = normPhone(order.phone ?? order.client_phone ?? order.client?.phone);
  const name = normName(order.name ?? order.client_name ?? order.client?.name);

  const total = Number(order?.pay?.euro ?? order?.total ?? 0) || 0;
  const paid = Number(order?.pay?.paid ?? order?.paid ?? 0) || 0;

  return {
    tcode: tcode || null,
    visit_nr: visit_nr === undefined ? null : visit_nr,
    status,
    phone,
    name,
    total,
    paid,
    data: order,
  };
}

function looksLikeTransport(p) {
  const s = String(p?.tcode ?? p?.client_tcode ?? p?.code_str ?? p?.code ?? "").trim().toUpperCase();
  return s.startsWith("T");
}

async function upsertClientByPhone(sb, { code, phone, name, photo_url }) {
  if (!phone) return { id: null, code: code ?? null };

  const { data: found, error: fErr } = await sb
    .from("clients")
    .select("id, code")
    .eq("phone", phone)
    .maybeSingle();

  if (!fErr && found?.id) {
    try {
      await sb
        .from("clients")
        .update({
          full_name: name || null,
          first_name: (name || "").split(/\s+/)[0] || null,
          last_name: (name || "").split(/\s+/).slice(1).join(" ") || null,
          photo_url: photo_url || null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", found.id);
    } catch (_e) {}
    return { id: found.id, code: found.code ?? code ?? null };
  }

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

  const { data: ins, error: iErr } = await sb.from("clients").insert(insertRow).select("id, code").single();

  if (iErr) {
    const { data: found2 } = await sb
      .from("clients")
      .select("id, code")
      .eq("phone", phone)
      .maybeSingle();
    return { id: found2?.id || null, code: found2?.code ?? code ?? null };
  }

  return { id: ins?.id || null, code: ins?.code ?? code ?? null };
}

// ----------------- core handler per op -----------------
async function handleOneOp(sb, opRaw) {
  const op = safeObj(opRaw);

  const typeRaw =
    op?.type ||
    op?.op_type ||
    op?.opType ||
    op?.meta?.op_type ||
    op?.meta?.type ||
    op?.meta?.opType;

  const type = String(typeRaw || "").trim().toLowerCase();
  const payload = op?.payload || op?.data || op?.body || {};

  if (!type) {
    return { ok: false, error: "MISSING_OP_TYPE" };
  }

  // --- Legacy compatibility ---
  if (type === "save_order") {
    const row = { ...(payload || {}) };
    const hasCode = row.code != null;

    if (typeof row.id === "string" && row.id && !isUuid(row.id)) {
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

    if (error) return { ok: false, error: error.message };
    return { ok: true };
  }

  // --- Unified types from offline ops queue ---
  if (type === "upsert_client") {
    const phone = normPhone(payload.phone);
    const name = normName(payload.full_name || payload.name);
    const code = normCode(payload.code);
    const photo_url = payload.photo_url || null;

    const c = await upsertClientByPhone(sb, { code, phone, name, photo_url });
    return { ok: true, client_id: c?.id || null, code: c?.code ?? code ?? null };
  }

  if (type === "insert_order") {
    const row = { ...(payload || {}) };

    // idempotency by local data.id if present
    const localId = getLocalIdFromData(row.data);
    if (localId) {
      const { data: existing, error: exErr } = await sb
        .from("orders")
        .select("id, code, code_n")
        .eq("data->>id", localId)
        .limit(1);
      if (!exErr && existing && existing.length) {
        return {
          ok: true,
          localId,
          code: existing[0].code ?? existing[0].code_n,
          existed: true,
        };
      }
    }

    // never trust client code_n
    if (row.code_n != null) delete row.code_n;

    // strip non-uuid id
    if (typeof row.id === "string" && row.id && !isUuid(row.id)) {
      delete row.id;
    }

    const hasCode = row.code != null;
    const incomingCode = hasCode ? Number(row.code) : null;
    const legacyLocalCode = Number.isFinite(incomingCode) && incomingCode > 0 && incomingCode < BASE_CODE_FLOOR;

    // legacy local code => temporary negative + then promote to db-assigned code_n
    if (legacyLocalCode) {
      row.code = -Date.now();

      const { data: ins, error: insErr } = await sb
        .from("orders")
        .insert(row)
        .select("id, code, code_n, data")
        .single();

      if (insErr) return { ok: false, error: insErr.message };

      const newCode = ins.code_n;
      const newData =
        ins?.data && typeof ins.data === "object"
          ? { ...ins.data }
          : row?.data && typeof row.data === "object"
            ? { ...row.data }
            : {};

      newData.code = newCode;
      newData.code_n = newCode;

      const { error: updErr } = await sb
        .from("orders")
        .update({ code: newCode, code_n: newCode, data: newData, updated_at: new Date().toISOString() })
        .eq("id", ins.id);

      if (updErr) return { ok: false, error: updErr.message };

      return { ok: true, localId: localId || null, code: newCode, reassigned: true };
    }

    // normal insert/upsert
    let error = null;

    if (hasCode) {
      const r1 = await sb.from("orders").upsert(row, { onConflict: "code_n" });
      error = r1.error;

      // fallback to insert if conflict config / constraint mismatch
      if (error) {
        const r2 = await sb.from("orders").insert(row);
        error = r2.error;
      }
    } else {
      const r3 = await sb.from("orders").insert(row);
      error = r3.error;
    }

    if (error) return { ok: false, error: error.message };
    return { ok: true, localId: localId || null, code: row.code ?? null };
  }

  if (type === "set_status") {
    const { id, status, ...rest } = payload || {};
    if (!id) return { ok: false, error: "MISSING_ID" };

    const isT = looksLikeTransport(payload);
    if (isT) {
      const tcode = String(payload.tcode ?? payload.client_tcode ?? payload.code_str ?? payload.code ?? id)
        .trim()
        .toUpperCase();
      const visit_nr = payload.visit_nr ?? payload.visitNr ?? null;

      let q = sb
        .from("transport_orders")
        .update({ status, updated_at: new Date().toISOString(), ...rest })
        .eq("client_tcode", tcode);

      if (visit_nr !== null && visit_nr !== undefined) q = q.eq("visit_nr", visit_nr);

      const { error } = await q;
      if (error) return { ok: false, error: error.message };
      return { ok: true };
    }

    const { error } = await sb
      .from("orders")
      .update({ status, updated_at: new Date().toISOString(), ...rest })
      .eq("id", id);

    if (error) return { ok: false, error: error.message };
    return { ok: true };
  }

  if (type === "offline_pranimi") {
    const { code, phone, name, status, data, total, paid, client_photo_url } = extractOrder(payload?.order || payload);
    if (!code) return { ok: false, error: "MISSING_CODE" };

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
      .select("id, code, code_n")
      .single();

    if (oErr) return { ok: false, error: oErr.message };
    return { ok: true, order_id: ins?.id || null, code: ins?.code ?? ins?.code_n ?? code };
  }

  if (type === "offline_transport_pranimi") {
    const p = payload?.order || payload;
    const ex = extractTransportOrder(p);
    if (!ex.tcode) return { ok: false, error: "MISSING_TCODE" };

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
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  }

  // accept both UPSERT_ORDER / upsert_order / upsertOrder
  if (type === "upsert_order") {
    const p = payload?.order || payload;

    if (looksLikeTransport(p)) {
      const ex = extractTransportOrder(p);
      if (!ex.tcode) return { ok: false, error: "MISSING_TCODE" };

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
      if (error) return { ok: false, error: error.message };
      return { ok: true };
    }

    const { code, phone, name, status, data, total, paid, client_photo_url } = extractOrder(p);
    if (!code) return { ok: false, error: "MISSING_CODE" };

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
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  }

  if (type === "add_payment") {
    const { error } = await sb.from("payments").insert(payload);
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  }

  if (type === "patch_order_data") {
    const id = payload?.id;
    const patch = payload?.patch || payload?.data_patch;

    if (!id || !patch || typeof patch !== "object") {
      return { ok: false, error: "MISSING_ID_OR_PATCH" };
    }

    const { data: row, error: rErr } = await sb.from("orders").select("id,data").eq("id", id).maybeSingle();
    if (rErr) return { ok: false, error: rErr.message };

    const current = row?.data && typeof row.data === "object" ? row.data : {};
    const merged = { ...current, ...patch };

    const { error: uErr } = await sb
      .from("orders")
      .update({ data: merged, updated_at: new Date().toISOString() })
      .eq("id", id);

    if (uErr) return { ok: false, error: uErr.message };
    return { ok: true };
  }

  return { ok: false, error: "UNKNOWN_OP_TYPE", meta: { received_type: typeRaw ?? null, normalized: type } };
}

// ----------------- route -----------------
export async function POST(req) {
  try {
    const sb = createAdminClientOrNull();
    if (!sb) {
      return NextResponse.json({ ok: false, error: "SUPABASE_ADMIN_NOT_AVAILABLE" }, { status: 200 });
    }

    const body = await req.json();

    // Accept:
    // 1) single op: {type, payload}
    // 2) array of ops: [{...},{...}]
    // 3) wrapped: { ops: [...] }
    const ops = Array.isArray(body) ? body : Array.isArray(body?.ops) ? body.ops : [body];

    const results = [];
    for (const op of ops) {
      // If a client sends {op:{...}} or {item:{...}}, unwrap best-effort
      const candidate = op?.op ? op.op : op?.item ? op.item : op;
      const r = await handleOneOp(sb, candidate);
      results.push(r);
    }

    const ok = results.every((r) => r && r.ok === true);

    // Keep backward compatibility: if it was a single op, return single shape.
    if (ops.length === 1) {
      return NextResponse.json(results[0], { status: 200 });
    }

    return NextResponse.json({ ok, results }, { status: 200 });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 200 });
  }
}