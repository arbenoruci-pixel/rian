import { supabase } from "@/lib/supabaseClient";
// ✅ NEW ARKA (cycles): payments must land in arka_cycle_moves under the active OPEN cycle
import { dbAcceptPaymentFromOrder, dbGetActiveCycle } from "@/lib/arkaDb";

/** LOCAL dayKey (NO UTC) */
function dayKeyLocal(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

const QUEUE_KEY = "arka_cash_queue_v1";
const DONE_KEY = "arka_cash_done_v1";

function doneRead() {
  try {
    const raw = localStorage.getItem(DONE_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function doneWrite(arr) {
  try {
    localStorage.setItem(DONE_KEY, JSON.stringify(arr.slice(0, 1200)));
  } catch {}
}

function doneHas(extId) {
  if (!extId) return false;
  const set = new Set(doneRead());
  return set.has(String(extId));
}

function doneAdd(extId) {
  if (!extId) return;
  const arr = doneRead();
  const s = String(extId);
  if (arr.includes(s)) return;
  arr.unshift(s);
  doneWrite(arr);
}

function qRead() {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function qWrite(arr) {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(arr));
  } catch {}
}

function qPush(item) {
  const arr = qRead();
  arr.unshift(item);
  qWrite(arr.slice(0, 300));
}

async function getOpenDay() {
  const { data, error } = await supabase
    .from("arka_days")
    .select("*")
    .eq("handoff_status", "OPEN")
    .is("closed_at", null)
    .order("opened_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function ensureOpenDay() {
  // STRICT FLOW:
  // Only ARKA/CASH page is allowed to OPEN a day.
  // Other pages must NEVER auto-open (they must queue moves instead).
  const day = await getOpenDay();
  return day?.id ? day : null;
}

async function insertMoveOnce({
  day_id,
  type,
  amount,
  note,
  source,
  created_by,
  external_id,
}) {
  if (external_id) {
    const { data: ex, error: e0 } = await supabase
      .from("arka_moves")
      .select("*")
      .eq("external_id", external_id)
      .maybeSingle();
    if (e0) throw e0;
    if (ex) return ex; // ✅ already recorded
  }

  const { data, error } = await supabase
    .from("arka_moves")
    .insert([
      {
        day_id,
        type: String(type || "IN").toUpperCase(),
        amount: Number(amount || 0),
        note: note || "",
        source: source || "ORDER_PAY",
        created_by: created_by || "LOCAL",
        external_id: external_id || null,
      },
    ])
    .select("*")
    .single();

  if (error) throw error;
  return data;
}

/**
 * recordCashMove(payload)
 * payload fields (minimal):
 * - externalId (unique)  ✅ required to prevent duplicates
 * - amount (number)
 * - note (string)
 * - type ('IN' | 'OUT') default IN
 * - createdBy (string) optional
 * - source (string) optional
 *
 * Extra fields are OK (orderId, code, name, method, etc.)
 */
export async function recordCashMove(payload = {}) {
  const amt = Number(payload.amount || 0);
  if (!isFinite(amt) || amt <= 0) return { ok: false, skipped: true };

  const externalId = payload.externalId || payload.external_id;
  if (!externalId) {
    // pa external id rrezikon duplikim → e gjenerojmë
    payload.externalId = `cash_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  }

  const createdBy =
    payload.createdBy || payload.created_by || payload.user || payload.openedBy || "LOCAL";

  const stage = String(payload.stage || payload.source || "ORDER");
  const order_code = payload.code ?? payload.order_code ?? null;
  const client_name = payload.name ?? payload.client_name ?? null;
  const note = String(payload.note || "");

  // 1) Prefer NEW cycles-based ARKA (arka_cycles + arka_cycle_moves)
  try {
    const cyc = await dbGetActiveCycle();
    if (!cyc?.id) {
      qPush({
        ...payload,
        amount: amt,
        type: payload.type || "IN",
        createdBy,
        at: new Date().toISOString(),
        err: "NO_OPEN_CYCLE",
      });
      return { ok: false, queued: true, blocked: true, error: "NO_OPEN_CYCLE" };
    }

    if (!doneHas(payload.externalId)) {
      await dbAcceptPaymentFromOrder({
        amount: amt,
        order_id: payload.orderId || payload.order_id || null,
        order_code,
        client_name,
        stage,
        note,
        received_by: createdBy,
      });
      doneAdd(payload.externalId);
    }

    // pasi u regjistru, provo me flush queue
    try {
      await flushArkaQueue(createdBy);
    } catch {}

    return { ok: true, cycle_id: cyc.id };
  } catch (e) {
    // 2) Fallback OLD day-based ARKA (arka_days + arka_moves) nese ciklet s'jan te instaluara
    try {
      const day = await ensureOpenDay(createdBy);
      if (!day?.id) {
        qPush({
          ...payload,
          amount: amt,
          type: payload.type || "IN",
          createdBy,
          at: new Date().toISOString(),
          err: "NO_OPEN_DAY",
        });
        return { ok: false, queued: true, blocked: true, error: "NO_OPEN_DAY" };
      }

      const row = await insertMoveOnce({
        day_id: day.id,
        type: payload.type || "IN",
        amount: amt,
        note: note,
        source: payload.source || "ORDER_PAY",
        created_by: createdBy,
        external_id: payload.externalId,
      });

      try {
        await flushArkaQueue(createdBy);
      } catch {}

      return { ok: true, row };
    } catch (e2) {
      qPush({
        ...payload,
        amount: amt,
        type: payload.type || "IN",
        createdBy,
        at: new Date().toISOString(),
        err: String(e2?.message || e2 || e?.message || e || "ERR"),
      });
      return { ok: false, queued: true, error: e2?.message || e?.message || String(e2 || e) };
    }
  }
}

/**
 * flush queue (manual call ok)
 * - për moment kur kthehet interneti / kur hapet ARKA
 */
export async function flushArkaQueue(openedBy = "LOCAL") {
  const q = qRead();
  if (!q.length) return { ok: true, flushed: 0 };

  // 1) Prefer cycles-based ARKA
  try {
    const cyc = await dbGetActiveCycle();
    if (!cyc?.id) {
      return { ok: false, flushed: 0, blocked: true, error: "NO_OPEN_CYCLE" };
    }

    let okCount = 0;
    const rest = [];

    for (const item of q) {
      try {
        const eid = item.externalId || item.external_id || null;
        if (eid && doneHas(eid)) {
          okCount++;
          continue;
        }

        const stage = String(item.stage || item.source || "ORDER");
        const order_code = item.code ?? item.order_code ?? null;
        const client_name = item.name ?? item.client_name ?? null;
        const note = String(item.note || "");

        await dbAcceptPaymentFromOrder({
          amount: Number(item.amount || 0),
          order_id: item.orderId || item.order_id || null,
          order_code,
          client_name,
          stage,
          note,
          received_by: item.createdBy || openedBy || "LOCAL",
        });

        if (eid) doneAdd(eid);
        okCount++;
      } catch {
        rest.push(item);
      }
    }

    qWrite(rest);
    return { ok: true, flushed: okCount, remaining: rest.length };
  } catch {
    // 2) Fallback old day-based ARKA
  }

  const day = await ensureOpenDay(openedBy);
  if (!day?.id) return { ok: false, flushed: 0, blocked: true, error: "NO_OPEN_DAY" };

  let okCount = 0;
  const rest = [];

  for (const item of q) {
    try {
      await insertMoveOnce({
        day_id: day.id,
        type: item.type || "IN",
        amount: Number(item.amount || 0),
        note: item.note || "",
        source: item.source || "ORDER_PAY",
        created_by: item.createdBy || openedBy || "LOCAL",
        external_id: item.externalId || item.external_id || null,
      });
      okCount++;
    } catch {
      rest.push(item);
    }
  }

  qWrite(rest);
  return { ok: true, flushed: okCount, remaining: rest.length };
}