import { supabase } from "@/lib/supabaseClient";

/* =========================================================
   TEPIHA — ARKA (CASH ONLY) — SINGLE SOURCE OF TRUTH
   DB: cash_cycles + cash_ledger + payroll_events (Supabase SQL bundle)
   Flow: OPEN → HANDED → RECEIVED
   NOTE: This file keeps BACKWARD-COMPAT exports expected by UI:
   dbGetActiveCycle, dbOpenCycle, dbCloseCycle, dbReceiveCycle,
   dbAddCycleMove, dbListCycleMoves, dbHasPendingHandedToday,
   dbListHandedForToday/dbListPendingHanded, dbGetCarryoverToday,
   dbAddExpense, dbGetTodayDay, dbListHistoryDays, dbGetHistoryDay,
   dbAcceptPaymentFromOrder
========================================================= */

function dayKeyLocal(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function normBucket(ui) {
  const v = String(ui || "").toUpperCase().trim();
  if (v === "PERSONAL") return "PERSONAL";
  // UI uses COMPANY → DB uses COMPANY_SAFE
  return "COMPANY_SAFE";
}

async function verifyPinToWorkerId(pin) {
  const p = String(pin || "").trim();
  if (!p) return null;
  const { data, error } = await supabase.rpc("workers_v2_verify_pin", { p_pin: p });
  if (error) throw error;
  // rpc returns row {id, full_name, role}
  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.id) throw new Error("PIN_INVALID");
  return row.id;
}

async function rpcOne(fn, args) {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw error;
  return data;
}

/* =========================
   Core (v2)
========================= */

export async function getActiveCycle() {
  const data = await rpcOne("arka_v2_get_active_cycle", {});
  // function returns TABLE; supabase returns array
  if (Array.isArray(data)) return data[0] || null;
  return data || null;
}

export async function openCycle({
  openingCash = 0,
  openingSource = "COMPANY_SAFE",
  openingPersonWorkerId = null,
  openedByWorkerId = null,
  note = "",
} = {}) {
  const day_key = dayKeyLocal(new Date());
  return rpcOne("arka_v2_open_cycle", {
    p_day_key: day_key,
    p_opened_by: openedByWorkerId,
    p_opening_cash: Number(openingCash || 0),
    p_opening_source: openingSource,
    p_opening_person: openingPersonWorkerId,
    p_note: String(note || ""),
  });
}

export async function closeCycle({
  cycleId,
  closedByWorkerId = null,
  carryCash = 0,
  carrySource = null,
  carryPersonWorkerId = null,
  note = "",
} = {}) {
  return rpcOne("arka_v2_close_cycle", {
    p_cycle_id: cycleId,
    p_closed_by: closedByWorkerId,
    p_carry_cash: Number(carryCash || 0),
    p_carry_source: carrySource,
    p_carry_person: carryPersonWorkerId,
    p_note: String(note || ""),
  });
}

export async function receiveFromDispatch({
  cycleId,
  receivedByWorkerId = null,
  note = "",
  doTransfer = false,
  transferAmount = 0,
} = {}) {
  return rpcOne("arka_v2_receive_cycle", {
    p_cycle_id: cycleId,
    p_received_by: receivedByWorkerId,
    p_note: String(note || ""),
    p_do_transfer: !!doTransfer,
    p_transfer_amount: Number(transferAmount || 0),
  });
}

export async function addExpense({
  cycleId,
  amount,
  fromBucket = "REGISTER", // REGISTER | COMPANY_SAFE
  workerId = null,
  reason = "",
  note = "",
} = {}) {
  return rpcOne("arka_v2_add_expense", {
    p_cycle_id: cycleId,
    p_amount: Number(amount || 0),
    p_from_bucket: fromBucket,
    p_worker_id: workerId,
    p_reason: String(reason || ""),
    p_note: String(note || ""),
  });
}

export async function addSaleIn({
  cycleId,
  amount,
  toBucket = "REGISTER",
  workerId = null,
  relatedOrderId = null,
  note = "",
} = {}) {
  return rpcOne("arka_v2_add_sale_in", {
    p_cycle_id: cycleId,
    p_amount: Number(amount || 0),
    p_to_bucket: toBucket,
    p_worker_id: workerId,
    p_related_order_id: relatedOrderId,
    p_note: String(note || ""),
  });
}

export async function payrollCashOut({
  workerId,
  amount,
  fromBucket = "REGISTER",
  createdByWorkerId = null,
  note = "",
} = {}) {
  return rpcOne("arka_v2_payroll_cash_out", {
    p_worker_id: workerId,
    p_amount: Number(amount || 0),
    p_from_bucket: fromBucket,
    p_created_by: createdByWorkerId,
    p_note: String(note || ""),
  });
}

export async function payrollAdjustment({
  workerId,
  kind = "ADJUSTMENT",
  amount,
  createdByWorkerId = null,
  note = "",
} = {}) {
  return rpcOne("arka_v2_payroll_adjustment", {
    p_worker_id: workerId,
    p_kind: kind,
    p_amount: Number(amount || 0),
    p_created_by: createdByWorkerId,
    p_note: String(note || ""),
  });
}

async function ledgerEffectRegister(cycleId) {
  const { data, error } = await supabase
    .from("cash_ledger")
    .select("amount,source_bucket,dest_bucket")
    .eq("cycle_id", cycleId);

  if (error) throw error;

  let eff = 0;
  for (const r of data || []) {
    const amt = Number(r.amount || 0);
    if (r.dest_bucket === "REGISTER") eff += amt;
    if (r.source_bucket === "REGISTER") eff -= amt;
  }
  return eff;
}

/* =========================
   UI COMPAT EXPORTS
========================= */

// Guards
export async function dbHasPendingHandedToday() {
  const { count, error } = await supabase
    .from("cash_cycles")
    .select("id", { count: "exact", head: true })
    .eq("status", "HANDED");
  if (error) throw error;
  return Number(count || 0) > 0;
}

export async function dbListHandedForToday() {
  const day_key = dayKeyLocal(new Date());
  const { data, error } = await supabase
    .from("cash_cycles")
    .select("*")
    .eq("day_key", day_key)
    .eq("status", "HANDED")
    .order("closed_at", { ascending: false });
  if (error) throw error;
  return data || [];
}

// alias used by app/arka/dispatch
export const dbListPendingHanded = dbListHandedForToday;
export const dbHasPendingHanded = dbHasPendingHandedToday;

// Active
export async function dbGetActiveCycle() {
  return getActiveCycle();
}

// OPEN (UI sends: opening_cash, opening_source, opening_person_pin)
export async function dbOpenCycle(params = {}) {
  const opening_cash = Number(params.opening_cash ?? params.openingCash ?? 0);
  const opening_source_ui = params.opening_source ?? params.openingSource ?? "COMPANY";
  const opening_source = normBucket(opening_source_ui);

  let opening_person = null;
  const pin = params.opening_person_pin ?? params.openingPersonPin ?? "";
  if (opening_source === "PERSONAL") {
    opening_person = await verifyPinToWorkerId(pin);
  }

  return openCycle({
    openingCash: opening_cash,
    openingSource: opening_source,
    openingPersonWorkerId: opening_person,
    openedByWorkerId: null,
    note: params.note || "",
  });
}

// CLOSE (UI sends: keep_cash, keep_source, keep_person_pin)
export async function dbCloseCycle(params = {}) {
  const cycle_id = params.cycle_id || params.cycleId;
  if (!cycle_id) throw new Error("CYCLE_ID_MISSING");

  const keep_cash = Number(params.keep_cash ?? params.carry_cash ?? 0);
  const keep_source_ui = params.keep_source ?? params.carry_source ?? null;
  const keep_source = keep_source_ui ? normBucket(keep_source_ui) : null;

  let keep_person = null;
  const kpin = params.keep_person_pin ?? params.carry_person_pin ?? "";
  if (keep_source === "PERSONAL") {
    keep_person = await verifyPinToWorkerId(kpin);
  }

  return closeCycle({
    cycleId: cycle_id,
    closedByWorkerId: null,
    carryCash: keep_cash,
    carrySource: keep_source,
    carryPersonWorkerId: keep_person,
    note: params.note || params.close_note || "",
  });
}

// RECEIVE (DISPATCH)
export async function dbReceiveCycle(params = {}) {
  const cycle_id = params.cycle_id || params.cycleId;
  if (!cycle_id) throw new Error("CYCLE_ID_MISSING");

  const do_transfer = !!(params.do_transfer ?? params.transfer_to_company_safe ?? false);
  const transfer_amount = Number(params.transfer_amount ?? params.transfer_amount_eur ?? 0);

  return receiveFromDispatch({
    cycleId: cycle_id,
    receivedByWorkerId: null,
    note: params.note || params.receive_note || "",
    doTransfer: do_transfer,
    transferAmount: transfer_amount,
  });
}

// Manual moves during cycle (PERSONAL ↔ REGISTER, COMPANY_SAFE ↔ REGISTER)
export async function dbAddCycleMove(payload = {}) {
  const cycle_id = payload.cycle_id || payload.cycleId;
  if (!cycle_id) throw new Error("CYCLE_ID_MISSING");

  const t = String(payload.type || "").toUpperCase().trim(); // IN | OUT
  const amt = Number(payload.amount || 0);
  if (!(amt > 0)) throw new Error("AMOUNT_INVALID");

  const srcUi = String(payload.source || "COMPANY").toUpperCase().trim(); // COMPANY | PERSONAL
  const srcBucket = normBucket(srcUi);

  const direction = t === "OUT" ? "OUT" : "IN";
  const source_bucket = direction === "IN" ? srcBucket : "REGISTER";
  const dest_bucket = direction === "IN" ? "REGISTER" : srcBucket;

  // Optional pin when PERSONAL
  let worker_id = null;
  let pin_verified = false;
  const ppin = String(payload.person_pin || "").trim();
  if (srcBucket === "PERSONAL" && ppin) {
    worker_id = await verifyPinToWorkerId(ppin);
    pin_verified = true;
  }

  return rpcOne("arka_v2_insert_ledger", {
    p_cycle_id: cycle_id,
    p_type: "TRANSFER",
    p_amount: amt,
    p_direction: direction,
    p_source: source_bucket,
    p_dest: dest_bucket,
    p_worker_id: worker_id,
    p_pin_verified: pin_verified,
    p_related_order_id: null,
    p_related_worker_id: null,
    p_reason: "MOVE",
    p_note: String(payload.note || ""),
  });
}

export async function dbListCycleMoves(cycle_id) {
  if (!cycle_id) return [];
  const { data, error } = await supabase
    .from("cash_ledger")
    .select("id,created_at,type,amount,direction,source_bucket,dest_bucket,reason,note")
    .eq("cycle_id", cycle_id)
    .eq("type", "TRANSFER")
    .eq("reason", "MOVE")
    .order("created_at", { ascending: false });

  if (error) throw error;

  return (data || []).map((r) => ({
    id: r.id,
    type: r.direction, // IN | OUT
    amount: Number(r.amount || 0),
    note: r.note || "",
  }));
}

// Carryover info (used to prefill close form)
export async function dbGetCarryoverToday() {
  const day_key = dayKeyLocal(new Date());
  const { data, error } = await supabase
    .from("cash_cycles")
    .select("id,carry_cash,carry_source,carry_person_worker_id,closed_at,status")
    .eq("day_key", day_key)
    .order("closed_at", { ascending: false })
    .limit(1);

  if (error) throw error;
  const row = (data || [])[0];
  if (!row) return null;

  return {
    cycle_id: row.id,
    carry_cash: Number(row.carry_cash || 0),
    carry_source: row.carry_source === "COMPANY_SAFE" ? "COMPANY" : row.carry_source,
    carry_person_pin: null, // never return pins
    closed_at: row.closed_at,
    status: row.status,
  };
}

// Expenses page compat
export async function dbAddExpense(payload = {}) {
  const active = await getActiveCycle();
  if (!active?.id) throw new Error("NUK_KA_CIKEL_AKTIV");

  const amt = Number(payload.amount || 0);
  const fromUi = String(payload.from || payload.from_bucket || "ARKA").toUpperCase().trim();
  // UI: ARKA | BUXHETI → DB buckets
  const fromBucket = fromUi.includes("BUXH") ? "COMPANY_SAFE" : "REGISTER";

  const reason = payload.reason || payload.category || "";
  const note = payload.note || payload.desc || "";

  return addExpense({
    cycleId: active.id,
    amount: amt,
    fromBucket,
    workerId: null,
    reason,
    note,
  });
}

// "Day" helpers for legacy UI expectations
export async function dbGetTodayDay() {
  const day_key = dayKeyLocal(new Date());
  return { day_key };
}

// History
export async function dbListHistoryDays(days = 30) {
  const { data, error } = await supabase
    .from("cash_cycles")
    .select("day_key")
    .order("day_key", { ascending: false })
    .limit(Number(days || 30));

  if (error) throw error;

  // unique by day_key
  const seen = new Set();
  const out = [];
  for (const r of data || []) {
    const k = String(r.day_key);
    if (!seen.has(k)) {
      seen.add(k);
      out.push({ id: k, day_key: k });
    }
  }
  return out;
}

export async function dbGetHistoryDay(day_key) {
  const k = String(day_key || "").trim();
  if (!k) return { day: null, cycles: [] };

  const { data: cycles, error } = await supabase
    .from("cash_cycles")
    .select("*")
    .eq("day_key", k)
    .order("opened_at", { ascending: true });

  if (error) throw error;

  const outCycles = [];
  let no = 0;
  for (const c of cycles || []) {
    no += 1;
    const eff = await ledgerEffectRegister(c.id);
    const expected = Number(c.opening_cash || 0) + Number(eff || 0);
    const moves = await dbListCycleMoves(c.id);

    outCycles.push({
      id: c.id,
      cycle_no: no,
      opening_cash: Number(c.opening_cash || 0),
      _expected: expected,
      _moves: moves,
    });
  }

  return { day: { day_key: k }, cycles: outCycles };
}

// Payments sync (orders → ledger)
export async function dbAcceptPaymentFromOrder(payload = {}) {
  const amt = Number(payload.amount || 0);
  if (!(amt > 0)) return null;

  const active = await getActiveCycle();
  if (!active?.id) throw new Error("NUK_KA_CIKEL_AKTIV");

  const order_id = payload.order_id || payload.orderId || null;
  const order_code = payload.order_code || payload.orderCode || "";
  const client_name = payload.client_name || payload.clientName || "";
  const stage = payload.stage || "";
  const note = payload.note || "";

  const fullNote = [order_code && `#${order_code}`, client_name, stage, note]
    .filter(Boolean)
    .join(" · ");

  return addSaleIn({
    cycleId: active.id,
    amount: amt,
    toBucket: "REGISTER",
    workerId: null,
    relatedOrderId: order_id,
    note: fullNote,
  });
}

/* =========================
   Default export for any default-import code paths
========================= */
const ArkaDb = {
  // core
  getActiveCycle,
  openCycle,
  closeCycle,
  receiveFromDispatch,
  addExpense,
  addSaleIn,
  payrollCashOut,
  payrollAdjustment,

  // compat
  dbHasPendingHandedToday,
  dbListHandedForToday,
  dbListPendingHanded,
  dbGetActiveCycle,
  dbOpenCycle,
  dbCloseCycle,
  dbReceiveCycle,
  dbAddCycleMove,
  dbListCycleMoves,
  dbGetCarryoverToday,
  dbAddExpense,
  dbGetTodayDay,
  dbListHistoryDays,
  dbGetHistoryDay,
  dbAcceptPaymentFromOrder,
};

export default ArkaDb;
