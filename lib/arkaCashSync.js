import { supabase } from "@/lib/supabaseClient";
import { dbGetActiveCycle } from "@/lib/arkaDb";

/** LOCAL dayKey (NO UTC) */
function dayKeyLocal(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// NOTE: This repo historically had an older ARKA model (arka_days/arka_moves).
// The current ARKA Cash flow (used by /arka/cash) is cycle-based
// (arka_cycles + arka_cycle_moves). Other pages (PRANIMI/PASTRIMI/GATI)
// call recordCashMove(...) to register order payments. If this function writes
// to the old tables, ARKA/CASH won't see the money.
//
// This file is the bridge: it MUST write to arka_cycle_moves under the ACTIVE
// OPEN cycle (cash only). If there's no OPEN cycle, we queue locally and flush
// when ARKA opens a cycle.
const QUEUE_KEY = "arka_cash_queue_v2";
const LEGACY_QUEUE_KEY = "arka_cash_queue_v1";

function readJsonArray(key) {
  try {
    const raw = localStorage.getItem(key);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function qRead() {
  // ✅ migrate any legacy queue items (v1 -> v2)
  const legacy = readJsonArray(LEGACY_QUEUE_KEY);
  const cur = readJsonArray(QUEUE_KEY);

  const merged = [...legacy, ...cur].filter(Boolean);

  if (legacy.length) {
    try {
      localStorage.removeItem(LEGACY_QUEUE_KEY);
    } catch {}
  }

  // de-dupe by externalId if present
  const seen = new Set();
  const out = [];
  for (const it of merged) {
    const id = it?.externalId || it?.external_id || null;
    if (id) {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    out.push(it);
  }
  return out;
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

// ---------------------------------------------------------------------------
// Legacy (arka_days/arka_moves)
// ---------------------------------------------------------------------------
// Kept only for backward compatibility in case some older deployments still
// rely on these tables. The current app's ARKA Cash is cycle-based, so we
// don't write to these tables anymore.

async function getOpenCycle() {
  // returns arka_cycles row or null
  return await dbGetActiveCycle();
}

function buildDedupeTag(externalId) {
  return `PAY#${String(externalId || "").trim()}`;
}

async function cycleMoveExists({ cycle_id, dedupeTag }) {
  if (!cycle_id || !dedupeTag) return false;
  // We dedupe by prefix inside note, so it works even if table doesn't have external_id column.
  const { data, error } = await supabase
    .from("arka_cycle_moves")
    .select("id")
    .eq("cycle_id", cycle_id)
    .ilike("note", `${dedupeTag}%`)
    .limit(1);
  if (error) return false;
  return (data || []).length > 0;
}

async function insertCycleMoveOnce({
  cycle_id,
  type,
  amount,
  note,
  source,
  created_by,
  external_id,
}) {
  const t = String(type || "IN").toUpperCase();
  if (t !== "IN" && t !== "OUT") throw new Error("Tipi duhet IN ose OUT");

  const dedupeTag = buildDedupeTag(external_id);
  const finalNote = [dedupeTag, String(note || "")].filter(Boolean).join(" ");

  const exists = await cycleMoveExists({ cycle_id, dedupeTag });
  if (exists) return { ok: true, skipped: true };

  const rowWithAt = {
    cycle_id,
    type: t,
    amount: Number(amount || 0),
    note: finalNote,
    source: String(source || "ORDER"),
    created_by: String(created_by || "LOCAL"),
    at: new Date().toISOString(),
  };

  // Try with `at` (preferred)
  const ins1 = await supabase.from("arka_cycle_moves").insert(rowWithAt).select("*").single();
  if (!ins1.error) return { ok: true, row: ins1.data };

  // Fallback: table might not have `at`
  const rowNoAt = { ...rowWithAt };
  delete rowNoAt.at;
  const ins2 = await supabase.from("arka_cycle_moves").insert(rowNoAt).select("*").single();
  if (ins2.error) throw ins2.error;
  return { ok: true, row: ins2.data };
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

  const t = String(payload.type || "IN").toUpperCase();

  // Build a clean note for ARKA list:
  //   #98 • EMRI KLIENTIT • GATI
  // Keep it short and consistent (no extra text spam).
  const parts = [];
  if (payload.code != null && String(payload.code).trim() !== "") parts.push(`#${String(payload.code).trim()}`);

  const clientName = payload.client_name || payload.clientName || payload.name || null;
  if (clientName) parts.push(String(clientName).trim());

  if (payload.stage) parts.push(String(payload.stage).toUpperCase());

  const note = parts.length ? parts.join(" • ") : "PAGESË";

  try {
    const cycle = await getOpenCycle();

    // ✅ STRICT: never auto-open. If no OPEN cycle, queue.
    if (!cycle?.id) {
      qPush({
        ...payload,
        amount: amt,
        type: t,
        createdBy,
        note,
        at: new Date().toISOString(),
        err: "NO_OPEN_CYCLE",
      });
      return { ok: false, queued: true, blocked: true, error: "NO_OPEN_CYCLE" };
    }

    const ins = await insertCycleMoveOnce({
      cycle_id: cycle.id,
      type: t,
      amount: amt,
      note,
      source: payload.source || "ORDER",
      created_by: createdBy,
      external_id: payload.externalId,
    });

    // After a successful insert, try flushing queued items too.
    try {
      await flushArkaQueue(createdBy);
    } catch {}

    return { ok: true, cycle_id: cycle.id, row: ins.row, skipped: !!ins.skipped };
  } catch (e) {
    // ✅ fallback: ruaje lokalisht (mos e humb pagesën)
    qPush({
      ...payload,
      amount: amt,
      type: t,
      createdBy,
      note,
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

  const cycle = await getOpenCycle();
  if (!cycle?.id) {
    // s'ka cikël OPEN → mos e fshi queue
    return { ok: false, flushed: 0, blocked: true, error: "NO_OPEN_CYCLE" };
  }

  let okCount = 0;
  const rest = [];

  for (const item of q) {
    try {
      await insertCycleMoveOnce({
        cycle_id: cycle.id,
        type: item.type || "IN",
        amount: Number(item.amount || 0),
        note: item.note || "",
        source: item.source || "ORDER",
        created_by: item.createdBy || item.created_by || openedBy || "LOCAL",
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