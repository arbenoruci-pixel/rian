import { NextResponse } from "next/server";

// Server-side offline sync endpoint.
import { createAdminClientOrNull } from "@/lib/supabaseAdminClient";

const BASE_CODE_FLOOR = 1;

function isUuid(v) {
  return (
    typeof v === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v)
  );
}

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
  const order = o && typeof o === "object" ? o : {};
  const client = order.client && typeof order.client === "object" ? order.client : {};

  const code = normCode(client.code ?? order.code ?? order.code_n);
  const phone = normPhone(client.phone ?? order.client_phone);
  const name = normName(client.name ?? order.client_name);

  const status = String(order.status || "pastrim").toLowerCase();
  const data = order;

  const total = Number(order?.pay?.euro ?? order?.total ?? 0) || 0;
  const paid = Number(order?.pay?.paid ?? order?.paid ?? 0) || 0;

  return { code, phone, name, status, data, total, paid, client_photo_url: client.photoUrl || null };
}

function extractTransportOrder(o) {
  const order = o && typeof o === "object" ? o : {};
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

async function upsertClientByPhone(sb, { code, phone, name, photo_url }) {
  if (!phone) {
    return { id: null, code: code ?? null };
  }

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
    } catch {}
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
    const { data: found2 } = await sb.from("clients").select("id, code").eq("phone", phone).maybeSingle();
    return { id: found2?.id || null, code: found2?.code ?? code ?? null };
  }

  return { id: ins?.id || null, code: ins?.code ?? code ?? null };
}

function normalizeType(t) {
  const s = String(t || "").trim();
  if (!s) return "";
  return s.toLowerCase();
}

function looksLikeTransport(p) {
  const s = String(p?.tcode ?? p?.client_tcode ?? p?.code_str ?? p?.code ?? "").trim().toUpperCase();
  return s.startsWith("T");
}

// ✅ Accept: single op, array, or {ops:[...]}
function normalizeIncomingOps(body) {
  if (Array.isArray(body)) return body;
  if (body && typeof body === "object" && Array.isArray(body.ops)) return body.ops;
  if (body && typeof body === "object") return [body];
  return [];
}

async function handleOneOp(sb, rawOp) {
  // Accept many shapes
  const typeRaw = rawOp?.type ?? rawOp?.op_type ?? rawOp?.opType ?? rawOp?.meta?.op_type ?? rawOp?.meta?.type;
  const type = normalizeType(typeRaw);

  const payload = rawOp?.payload ?? rawOp?.data ?? rawOp?.body ?? rawOp?.op ?? {};

  // --- Legacy ---
  if (type === "save_order") {
    const row = { ...(payload || {}) };
    const hasCode = row.code != null;

    if (typeof row.id === "string" && row.id && !isUuid(row.id)) delete row.id;

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

  // --- Unified ---
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

    const localId = getLocalIdFromData(row.data);
    if (localId) {
      const { data: existing, error: exErr } = await sb
        .from("orders")
        .select("id, code, code_n")
        .eq("data->>id", localId)
        .limit(1);
      if (!exErr && existing && existing.length) {
        return { ok: true, localId, code: existing[0].code ?? existing[0].code_n, existed: true };
      }
    }

    // If id is not UUID, strip it
    if (typeof row.id === "string" && row.id && !isUuid(row.id)) delete row.id;

    // If client sent code_n, we don't trust it (may collide)
    if (row.code_n != null) delete row.code_n;

    // ✅ If we have code numeric, restore code_n = code so upsert is idempotent
    const codeNum = normCode(row.code ?? row.code_n ?? row.client_code ?? row?.data?.code ?? row?.data?.code_n);
    if (codeNum != null) {
      row.code = codeNum;
      row.code_n = codeNum;
    }

    const incomingCode = Number(row.code);
    const legacyLocalCode = Number.isFinite(incomingCode) && incomingCode < BASE_CODE_FLOOR;

    if (legacyLocalCode) {
      row.code = -Date.now();
      row.code_n = row.code;

      const { data: ins, error: insErr } = await sb.from("orders").insert(row).select("id, code_n, data").single();
      if (insErr) return { ok: false, error: insErr.message };

      const newCode = ins.code_n;
      const newData =
        ins.data && typeof ins.data === "object"
          ? { ...ins.data, code: newCode, code_n: newCode }
          : { ...(row.data && typeof row.data === "object" ? row.data : {}), code: newCode, code_n: newCode };

      const { error: updErr } = await sb.from("orders").update({ code: newCode, code_n: newCode, data: newData }).eq("id", ins.id);
      if (updErr) return { ok: false, error: updErr.message };

      return { ok: true, localId: localId || null, code: newCode, reassigned: true };
    }

    // Normal upsert by code_n if available, else insert
    if (row.code_n != null) {
      const r1 = await sb.from("orders").upsert(row, { onConflict: "code_n" });
      if (!r1.error) return { ok: true, localId: localId || null, code: row.code ?? null };

      // fallback insert
      const r2 = await sb.from("orders").insert(row);
      if (r2.error) return { ok: false, error: r2.error.message };
      return { ok: true, localId: localId || null, code: row.code ?? null };
    } else {
      const r3 = await sb.from("orders").insert(row);
      if (r3.error) return { ok: false, error: r3.error.message };
      return { ok: true, localId: localId || null, code: row.code ?? null };
    }
  }

  if (type === "set_status") {
    const { id, status, ...rest } = payload || {};
    if (!id) return { ok: false, error: "MISSING_ID" };

    if (looksLikeTransport(payload)) {
      const tcode = String(payload.tcode ?? payload.client_tcode ?? payload.code_str ?? payload.code ?? id).trim().toUpperCase();
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

    const { data: ins, error: oErr } = await sb.from("orders").upsert(orderRow, { onConflict: "code_n" }).select("id, code").single();
    if (oErr) return { ok: false, error: oErr.message };
    return { ok: true, order_id: ins?.id || null, code: ins?.code || code };
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

  // Older builds: UPSERT_ORDER
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
    // ✅ accept both payload.patch and payload.data_patch
    const id = payload?.id;
    const patch = payload?.patch ?? payload?.data_patch;

    if (!id || !patch || typeof patch !== "object") {
      return { ok: false, error: "MISSING_ID_OR_PATCH" };
    }

    const { data: row, error: rErr } = await sb.from("orders").select("id,data").eq("id", id).maybeSingle();
    if (rErr) return { ok: false, error: rErr.message };

    const current = row && row.data && typeof row.data === "object" ? row.data : {};
    const merged = { ...current, ...patch };

    const { error: uErr } = await sb
      .from("orders")
      .update({ data: merged, updated_at: new Date().toISOString() })
      .eq("id", id);

    if (uErr) return { ok: false, error: uErr.message };
    return { ok: true };
  }

  return { ok: false, error: "UNKNOWN_OP_TYPE", type: typeRaw };
}

export async function POST(req) {
  try {
    const sb = createAdminClientOrNull();
    if (!sb) {
      return NextResponse.json({ ok: false, error: "SUPABASE_ADMIN_NOT_AVAILABLE" }, { status: 200 });
    }

    const body = await req.json().catch(() => null);
    const ops = normalizeIncomingOps(body);
    if (!ops.length) return NextResponse.json({ ok: false, error: "NO_OPS" }, { status: 200 });

    const results = [];
    for (const op of ops) {
      try {
        const r = await handleOneOp(sb, op);
        results.push(r);
      } catch (e) {
        results.push({ ok: false, error: String(e?.message || e) });
      }
    }

    // ✅ Return ok=true only if all ok
    const allOk = results.every((r) => r && r.ok === true);
    return NextResponse.json({ ok: allOk, results }, { status: 200 });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 200 });
  }
}