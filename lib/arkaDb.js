// lib/arkaDb.js
import { supabase } from "@/lib/supabaseClient";

/* =========================
   Helpers
========================= */
function dayKeyLocal(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

async function ensureTodayDayRow() {
  const day_key = dayKeyLocal(new Date());

  const q1 = await supabase
    .from("arka_days")
    .select("*")
    .eq("day_key", day_key)
    .maybeSingle();

  if (q1.error) throw q1.error;
  if (q1.data?.id) return q1.data;

  /**
   * IMPORTANT:
   * Schema i `arka_days` NUK ka `day_date`.
   * Kolonat minimum REQUIRED janë: day_key, opened_at, initial_cash.
   * Prandaj insert-i duhet me qenë minimal dhe kompatibil.
   */
  const ins = await supabase
    .from("arka_days")
    .insert({
      day_key,
      opened_at: new Date().toISOString(),
      opened_by: "SYSTEM",
      initial_cash: 0,
      handoff_status: "OPEN",
    })
    .select("*")
    .single();

  if (!ins.error) return ins.data || null;

  // u kriju paralelisht -> lexo prap
  const q2 = await supabase
    .from("arka_days")
    .select("*")
    .eq("day_key", day_key)
    .maybeSingle();

  if (q2.error) throw q2.error;
  return q2.data || null;
}

/* =========================
   DAY
========================= */
export async function dbGetTodayDay() {
  return await ensureTodayDayRow();
}

/* =========================
   CARRYOVER (opsional)
   - Këtu e mbajmë kompatibilitetin me dy emra:
     • carryover_*  (schema aktual)
     • carry_*      (legacy/UI i vjetër)
========================= */
export async function dbGetCarryoverToday() {
  const day = await ensureTodayDayRow();
  if (!day?.id) {
    return {
      carryover_cash: 0,
      carryover_source: null,
      carryover_person_pin: null,
      // legacy aliases
      carry_cash: 0,
      carry_source: null,
      carry_person_pin: null,
    };
  }

  const cash = Number(day.carryover_cash ?? 0);
  const source = day.carryover_source ?? null;
  const pin = day.carryover_person_pin ?? null;

  return {
    carryover_cash: cash,
    carryover_source: source,
    carryover_person_pin: pin,
    // legacy aliases
    carry_cash: cash,
    carry_source: source,
    carry_person_pin: pin,
  };
}

export async function dbSetCarryoverToday(opts = {}) {
  const day = await ensureTodayDayRow();
  if (!day?.id) throw new Error("Nuk u gjet dita.");

  // Accept both naming conventions
  const carryover_cash = Number(
    (opts.carryover_cash ?? opts.carry_cash ?? 0) || 0
  );
  const carryover_source =
    (opts.carryover_source ?? opts.carry_source) != null
      ? String(opts.carryover_source ?? opts.carry_source)
      : null;
  const carryover_person_pin =
    (opts.carryover_person_pin ?? opts.carry_person_pin) != null
      ? String(opts.carryover_person_pin ?? opts.carry_person_pin)
      : null;

  const payload = {
    carryover_cash,
    carryover_source,
    carryover_person_pin,
  };

  const { data, error } = await supabase
    .from("arka_days")
    .update(payload)
    .eq("id", day.id)
    .select("*")
    .single();

  if (error) throw error;
  return data || null;
}

/* =========================
   GUARD: a ka HANDED pa RECEIVED?
========================= */
export async function dbHasPendingHanded(dayKey = null) {
  const dk = dayKey || dayKeyLocal(new Date());

  const { data, error } = await supabase
    .from("arka_cycles")
    .select("id")
    .eq("day_key", dk)
    .eq("handoff_status", "HANDED")
    .limit(1);

  if (error) throw error;
  return (data || []).length > 0;
}

export async function dbListPendingHanded(dayKey = null) {
  const dk = dayKey || dayKeyLocal(new Date());

  const { data, error } = await supabase
    .from("arka_cycles")
    .select("*")
    .eq("day_key", dk)
    .eq("handoff_status", "HANDED")
    .order("closed_at", { ascending: false });

  if (error) throw error;
  return data || [];
}

/* =========================
   CYCLES
========================= */
export async function dbGetActiveCycle() {
  const day = await ensureTodayDayRow();
  if (!day?.id) return null;

  const { data, error } = await supabase
    .from("arka_cycles")
    .select("*")
    .eq("day_id", day.id)
    .eq("handoff_status", "OPEN")
    .is("closed_at", null)
    .order("opened_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  if (data?.id) return data;

  // Fallback: disa skema e kanë UNIQUE "only one OPEN cycle" globalisht (jo vetëm për ditën).
  // Në atë rast, nëse ka cikël OPEN nga dita e kaluar, duhet me e gjet këtu.
  const q2 = await supabase
    .from("arka_cycles")
    .select("*")
    .eq("handoff_status", "OPEN")
    .is("closed_at", null)
    .order("opened_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (q2.error) throw q2.error;
  return q2.data || null;
}

export async function dbOpenCycle({
  opening_cash = 0,
  opening_source = "COMPANY", // COMPANY | PERSONAL | OTHER
  opening_person_pin = "",
  opened_by = "LOCAL",
}) {
  const day = await ensureTodayDayRow();
  if (!day?.id) throw new Error("Nuk u gjet dita.");

  const day_key = day.day_key || dayKeyLocal(new Date());

  // GUARD: nëse ekziston cikël OPEN për këtë ditë, mos provo me hap tjetër.
  // Kjo shmang error-in e unique constraint: "arka_only_one_open_cycle"
  // (p.sh. double tap / refresh / race).
  try {
    const existing = await dbGetActiveCycle();
    if (existing?.id) return existing;
  } catch {
    // ignore
  }

  const hasPending = await dbHasPendingHanded(day_key);
  if (hasPending) {
    throw new Error(
      "DISPATCH duhet me PRANU dorëzimin e fundit (HANDED) para se me u hap cikël i ri."
    );
  }

  const mx = await supabase
    .from("arka_cycles")
    .select("cycle_no")
    .eq("day_id", day.id)
    .order("cycle_no", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (mx.error) throw mx.error;
  const nextNo = Number(mx.data?.cycle_no || 0) + 1;

  const row = {
    day_id: day.id,
    day_key,
    cycle_no: nextNo,
    opening_cash: Number(opening_cash || 0),
    opening_source: String(opening_source || "COMPANY"),
    opening_person_pin: String(opening_person_pin || ""),
    opened_by: String(opened_by || "LOCAL"),
    handoff_status: "OPEN",
    opened_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from("arka_cycles")
    .insert(row)
    .select("*")
    .single();

  if (error) {
    const msg = String(error?.message || "");
    const code = String(error?.code || "");
    if (msg.includes("arka_only_one_open_cycle") || code === "23505") {
      // Dikush (ose i njëjti user) e hapi ciklin paralelisht.
      const existing = await dbGetActiveCycle();
      if (existing?.id) return existing;
    }
    throw error;
  }

  // carryover = 0 kur hapet cikli (opsionale)
  try {
    await dbSetCarryoverToday({
      carryover_cash: 0,
      carryover_source: null,
      carryover_person_pin: null,
    });
  } catch {}

  return data || null;
}

export async function dbCloseCycle({
  cycle_id,
  expected_cash,
  cash_counted,
  closed_by,
  keep_cash = 0,
  keep_source = null,
  keep_person_pin = null,
}) {
  if (!cycle_id) throw new Error("cycle_id mungon");

  const counted = Number(cash_counted || 0);
  const keep = Number(keep_cash || 0);

  if (Number.isNaN(counted) || counted < 0) throw new Error("CASH COUNTED s’është valide.");
  if (Number.isNaN(keep) || keep < 0) throw new Error("KEEP CASH s’mund të jetë negativ.");
  if (keep > counted) throw new Error("KEEP CASH s’mund të jetë më i madh se CASH COUNTED.");

  const discrepancy = counted - Number(expected_cash || 0);

  const payload = {
    expected_cash: Number(expected_cash || 0),
    cash_counted: counted,
    discrepancy,
    closed_at: new Date().toISOString(),
    closed_by: String(closed_by || "LOCAL"),
    handoff_status: "HANDED",
  };

  const { data, error } = await supabase
    .from("arka_cycles")
    .update(payload)
    .eq("id", cycle_id)
    .eq("handoff_status", "OPEN")
    .select("*")
    .single();

  if (error) throw error;

  // save carryover për ciklin tjetër (opsionale)
  try {
    await dbSetCarryoverToday({
      carryover_cash: keep,
      carryover_source: keep_source ? String(keep_source) : null,
      carryover_person_pin: keep_person_pin ? String(keep_person_pin) : null,
    });
  } catch {}

  return data || null;
}

export async function dbReceiveCycle({ cycle_id, received_by }) {
  if (!cycle_id) throw new Error("cycle_id mungon");

  const payload = {
    handoff_status: "RECEIVED",
    received_at: new Date().toISOString(),
    received_by: String(received_by || "DISPATCH"),
  };

  const { data, error } = await supabase
    .from("arka_cycles")
    .update(payload)
    .eq("id", cycle_id)
    .eq("handoff_status", "HANDED")
    .select("*")
    .single();

  if (error) throw error;

  // Mirror received cash into company budget ledger (IN)
  // (Best-effort; ignore if table missing/RLS blocks.)
  try {
    const { budgetAddOutMove } = await import("@/lib/companyBudgetDb");
    const amt = Number(data?.cash_counted || 0);
    if (Number.isFinite(amt) && amt > 0) {
      await budgetAddOutMove({
        type: "IN",
        amount: amt,
        note: `ARKA RECEIVED • ${String(data?.day_key || "")} • CIKLI ${String(
          data?.cycle_no || ""
        )}`,
        created_by: String(received_by || "DISPATCH"),
        external_id: `arka_cycle_received:${cycle_id}`,
      });
    }
  } catch {}

  return data || null;
}

/* =========================
   MOVES
========================= */
export async function dbAddCycleMove({
  cycle_id,
  type,
  amount,
  note,
  source,
  created_by,
  external_id,
}) {
  if (!cycle_id) throw new Error("cycle_id mungon");

  const t = String(type || "").toUpperCase();
  if (t !== "IN" && t !== "OUT") throw new Error("Tipi duhet IN ose OUT");

  const rowWithAt = {
    cycle_id,
    type: t,
    amount: Number(amount || 0),
    note: String(note || ""),
    source: String(source || "MANUAL"),
    created_by: String(created_by || "LOCAL"),
    ...(external_id ? { external_id: String(external_id) } : {}),
    at: new Date().toISOString(),
  };

  const try1 = await supabase.from("arka_cycle_moves").insert(rowWithAt).select("*").single();
  if (!try1.error) return try1.data || null;

  const rowNoAt = {
    cycle_id,
    type: t,
    amount: Number(amount || 0),
    note: String(note || ""),
    source: String(source || "MANUAL"),
    created_by: String(created_by || "LOCAL"),
    ...(external_id ? { external_id: String(external_id) } : {}),
  };

  const try2 = await supabase.from("arka_cycle_moves").insert(rowNoAt).select("*").single();
  if (!try2.error) return try2.data || null;

  // If schema doesn't have external_id, retry without it.
  if (external_id) {
    const clean1 = { ...rowWithAt };
    delete clean1.external_id;
    const retry1 = await supabase.from("arka_cycle_moves").insert(clean1).select("*").single();
    if (!retry1.error) return retry1.data || null;

    const clean2 = { ...rowNoAt };
    delete clean2.external_id;
    const retry2 = await supabase.from("arka_cycle_moves").insert(clean2).select("*").single();
    if (retry2.error) throw retry2.error;
    return retry2.data || null;
  }

  throw try2.error;
}

export async function dbListCycleMoves(cycle_id) {
  if (!cycle_id) return [];

  const q1 = await supabase
    .from("arka_cycle_moves")
    .select("*")
    .eq("cycle_id", cycle_id)
    .order("at", { ascending: false });
  if (!q1.error) return q1.data || [];

  const q2 = await supabase
    .from("arka_cycle_moves")
    .select("*")
    .eq("cycle_id", cycle_id)
    .order("created_at", { ascending: false });
  if (!q2.error) return q2.data || [];

  const q3 = await supabase
    .from("arka_cycle_moves")
    .select("*")
    .eq("cycle_id", cycle_id)
    .order("id", { ascending: false });

  if (q3.error) throw q3.error;
  return q3.data || [];
}

/* =========================
   HISTORI
========================= */
export async function dbListHistoryDays(days = 14) {
  const n = Math.max(1, Math.min(Number(days || 14), 60));

  const { data, error } = await supabase
    .from("arka_days")
    .select(
      "id, day_key, opened_at, opened_by, closed_at, closed_by, expected_cash, cash_counted, discrepancy, handoff_status"
    )
    .order("day_key", { ascending: false })
    .limit(n);

  if (error) throw error;
  return data || [];
}

// needed by History UI (avoids "Can't find variable: dbListCyclesByDay")
export async function dbListCyclesByDay(day_key) {
  if (!day_key) return [];
  const { data, error } = await supabase
    .from("arka_cycles")
    .select(
      "id, day_id, day_key, cycle_no, status, opened_at, closed_at, expected_cash, cash_counted, discrepancy, handoff_status, opened_by, closed_by, received_at, received_by"
    )
    .eq("day_key", String(day_key))
    .order("cycle_no", { ascending: true })
    .order("opened_at", { ascending: true });

  if (error) throw error;
  return data || [];
}

export async function dbGetHistoryDay(day_key) {
  if (!day_key) throw new Error("day_key mungon");

  const dayQ = await supabase.from("arka_days").select("*").eq("day_key", day_key).maybeSingle();
  if (dayQ.error) throw dayQ.error;
  const day = dayQ.data || null;

  const cycles = await dbListCyclesByDay(day_key);

  const cyclesWithTotals = await Promise.all(
    (cycles || []).map(async (c) => {
      const mv = await dbListCycleMoves(c.id);

      const ins = (mv || [])
        .filter((m) => String(m.type || "").toUpperCase() === "IN")
        .reduce((a, m) => a + Number(m.amount || 0), 0);

      const outs = (mv || [])
        .filter((m) => String(m.type || "").toUpperCase() === "OUT")
        .reduce((a, m) => a + Number(m.amount || 0), 0);

      const opening = Number(c.opening_cash || 0);
      const expected = opening + ins - outs;

      return { ...c, _moves: mv || [], _ins: ins, _outs: outs, _expected: expected };
    })
  );

  const totals = cyclesWithTotals.reduce(
    (acc, c) => {
      acc.cycles += 1;
      acc.ins += Number(c._ins || 0);
      acc.outs += Number(c._outs || 0);
      acc.expected += Number(c._expected || 0);
      acc.counted += Number(c.cash_counted || 0);
      acc.discrepancy += Number(c.discrepancy || 0);
      return acc;
    },
    { cycles: 0, ins: 0, outs: 0, expected: 0, counted: 0, discrepancy: 0 }
  );

  return { day, cycles: cyclesWithTotals, totals };
}

/* =========================
   PAGESA NGA PRANIMI/PASTRIMI/GATI -> ARKA
========================= */
export async function dbAcceptPaymentFromOrder({
  amount,
  order_id = null,
  order_code = null,
  client_name = null,
  stage = null,
  note = "",
  received_by = "LOCAL",
}) {
  const amt = Number(amount || 0);
  if (!Number.isFinite(amt) || amt <= 0) throw new Error("SHUMA DUHET > 0.");

  const c = await dbGetActiveCycle();
  if (!c?.id) throw new Error("S’KA CIKËL OPEN NË ARKË. HAP CIKLIN PARA PAGESAVE.");

  const tagParts = [];
  if (stage) tagParts.push(String(stage).toUpperCase());
  if (order_code != null && String(order_code).trim() !== "") tagParts.push(`#${String(order_code).trim()}`);
  if (client_name) tagParts.push(String(client_name).trim());

  const baseTag = tagParts.length ? tagParts.join(" · ") : "PAGESË";
  const fullNote = [baseTag, note].filter(Boolean).join(" — ");

  const mv = await dbAddCycleMove({
    cycle_id: c.id,
    type: "IN",
    amount: amt,
    note: fullNote,
    source: "ORDER",
    created_by: String(received_by || "LOCAL"),
  });

  return { ok: true, cycle_id: c.id, move: mv };
}

/* =========================
   COMPAT EXPORTS (MOS I HEK)
========================= */
export const dbHasPendingHandedToday = dbHasPendingHanded;
export const dbListHandedForToday = dbListPendingHanded;
