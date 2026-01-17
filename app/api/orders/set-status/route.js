import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabaseClient";

// TEPIHA — HAPI 3 (Plan B)
// Single endpoint to change an order status.
// Guarantees:
// - orders.status === orders.data.status (always)
// - ready_at is set ONLY when transitioning into 'gati'
// - picked_up_at is set ONLY when transitioning into 'dorzim'
// - No DB triggers.

const ALLOWED = new Set(["incomplete", "pastrim", "gati", "dorzim"]);

function isoNow() {
  return new Date().toISOString();
}

export async function POST(req) {
  try {
    const body = await req.json().catch(() => ({}));

    const orderId = body?.order_id ?? body?.id;
    const nextStatus = String(body?.status || "")
      .toLowerCase()
      .trim();

    if (!orderId) {
      return NextResponse.json(
        { ok: false, error: "MISSING_ORDER_ID" },
        { status: 400 }
      );
    }

    if (!ALLOWED.has(nextStatus)) {
      return NextResponse.json(
        { ok: false, error: "INVALID_STATUS" },
        { status: 400 }
      );
    }

    // Read current row so we can apply timestamp rules without overwriting.
    const { data: cur, error: readErr } = await supabase
      .from("orders")
      .select("id,status,ready_at,picked_up_at,data")
      .eq("id", orderId)
      .single();

    if (readErr || !cur) {
      return NextResponse.json(
        { ok: false, error: "ORDER_NOT_FOUND", detail: readErr?.message },
        { status: 404 }
      );
    }

    const prevStatus = String(cur.status || "").toLowerCase();
    const curData =
      cur.data && typeof cur.data === "object" && !Array.isArray(cur.data)
        ? cur.data
        : {};

    const patch = {
      status: nextStatus,
      data: { ...curData, status: nextStatus },
    };

    // ready_at: only when we ENTER 'gati'
    if (nextStatus === "gati" && prevStatus !== "gati") {
      if (!cur.ready_at) patch.ready_at = isoNow();
    }

    // picked_up_at: only when we ENTER 'dorzim'
    if (nextStatus === "dorzim" && prevStatus !== "dorzim") {
      if (!cur.picked_up_at) patch.picked_up_at = isoNow();
    }

    const { data: updated, error: updErr } = await supabase
      .from("orders")
      .update(patch)
      .eq("id", orderId)
      .select("id,status,ready_at,picked_up_at,data")
      .single();

    if (updErr) {
      return NextResponse.json(
        { ok: false, error: "UPDATE_FAILED", detail: updErr.message },
        { status: 500 }
      );
    }

    return NextResponse.json({ ok: true, order: updated });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: "UNHANDLED", detail: String(e?.message || e) },
      { status: 500 }
    );
  }
}
