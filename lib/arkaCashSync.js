import { supabase } from "@/lib/supabaseClient";

/** LOCAL dayKey (NO UTC) */
function dayKeyLocal(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

const QUEUE_KEY = "arka_cash_queue_v1";

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
    payload.createdBy ||
    payload.created_by ||
    payload.user ||
    payload.openedBy ||
    "LOCAL";

  try {
    const day = await ensureOpenDay(createdBy);

    // ✅ STRICT: mos e hap ditën automatikisht.
    // Nëse s'ka ditë OPEN, ruaje pagesën në queue dhe prit ARKA/CASH me e hap.
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
      note: payload.note || "",
      source: payload.source || "ORDER_PAY",
      created_by: createdBy,
      external_id: payload.externalId,
    });

    // ✅ pasi u regjistru n’Supabase, provo me “flush” queued moves
    try {
      await flushArkaQueue(createdBy);
    } catch {}

    return { ok: true, row };
  } catch (e) {
    // ✅ fallback: ruaje lokalisht (mos e humb pagesën)
    qPush({
      ...payload,
      amount: amt,
      type: payload.type || "IN",
      createdBy,
      at: new Date().toISOString(),
      err: String(e?.message || e || "ERR"),
    });

    return { ok: false, queued: true, error: e?.message || String(e) };
  }
}

/**
 * flush queue (manual call ok)
 * - për moment kur kthehet interneti / kur hapet ARKA
 */
export async function flushArkaQueue(openedBy = "LOCAL") {
  const q = qRead();
  if (!q.length) return { ok: true, flushed: 0 };

  const day = await ensureOpenDay(openedBy);
  if (!day?.id) {
    // s'ka ditë OPEN → mos e fshi queue
    return { ok: false, flushed: 0, blocked: true, error: "NO_OPEN_DAY" };
  }

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