import { supabase } from './supabaseClient';

function formatDayKeyLocal(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// -----------------------------------------------------------------------------
// ARKA DB compatibility layer - Mapimi i kolonave reale
// -----------------------------------------------------------------------------

function mapCycle(row) {
  if (!row) return null;
  // Mbajmë emrat që pret UI duke u lidhur me kolonat që ekzistojnë vërtet në DB
  const opening_cash = row.opening_cash ?? 0;
  const opening_source = row.opening_source ?? 'COMPANY';
  const handoff_status = row.handoff_status ?? row.status ?? 'OPEN';
  const cash_counted = row.cash_counted ?? row.counted_cash ?? row.end_cash ?? null;
  // Mos refero kolona që PostgREST mund të mos i ketë në cache (p.sh. current_cash)
  const expected_cash = row.expected_cash ?? opening_cash;
  
  return {
    ...row,
    opening_cash,
    opening_source,
    handoff_status,
    cash_counted,
    expected_cash,
  };
}

// -------------------------
// Active cycle - Kontrolli i gjendjes OPEN
// -------------------------
export async function dbGetActiveCycle() {
  // QËLLIMI: kthe ciklin REAL "OPEN".
  // Në disa DB, kolona `handoff_status` mund të mbetet gabimisht "OPEN" edhe pasi statusi është mbyllur.
  // Prandaj: 1) kërko vetëm `status=OPEN` (prioritet), me renditje DESC,
  // 2) nëse s'ka, provo `handoff_status=OPEN`.

  // 1) Prioritet: status
  {
    const { data, error } = await supabase
      .from('arka_cycles')
      .select('*')
      .eq('status', 'OPEN')
      .order('opened_at', { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle();

    if (!error && data) return mapCycle(data);
  }

  // 2) Fallback: handoff_status
  {
    const { data, error } = await supabase
      .from('arka_cycles')
      .select('*')
      .eq('handoff_status', 'OPEN')
      .order('opened_at', { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      console.warn('Gabim gjatë marrjes së ciklit aktiv:', error);
      return null;
    }
    return data ? mapCycle(data) : null;
  }
}

// -------------------------
// Open cycle - Hapja me mbrojtje nga duplikimi
// -------------------------
export async function dbOpenCycle(payload = {}) {
  // Mbrojtja: Nëse ka cikël hapur, mos krijo të ri (parandalon errorin e unique constraint)
  const existing = await dbGetActiveCycle();
  if (existing?.id) return existing;

  const opening_cash = Number(payload.opening_cash ?? payload.amount ?? 0);
  if (!Number.isFinite(opening_cash) || opening_cash < 0) {
    throw new Error('OPENING CASH S’ËSHTË VALIDE.');
  }

  const day_key = String(payload.day_key || payload.dayKey || formatDayKeyLocal());

  let cycle_no = 1;
  try {
    const { data: last } = await supabase
      .from('arka_cycles')
      .select('cycle_no')
      .eq('day_key', day_key)
      .order('cycle_no', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (last) {
      cycle_no = Number(last.cycle_no || 0) + 1;
    }
  } catch (e) {
    cycle_no = 1;
  }

  // Dërgojmë vetëm kolonat që DB i njeh sipas fotove të errorave
  const insertRow = {
    day_key,
    cycle_no,
    handoff_status: 'OPEN',
    opening_cash,
    opening_source: payload.opening_source ?? 'COMPANY',
    opened_at: new Date().toISOString(),
  };

  const ins = await supabase.from('arka_cycles').insert(insertRow);
  
  if (ins.error) {
     console.error("Insert error, duke provuar fallback minimal:", ins.error);
     // Fallback në rast se edhe opening_source mungon
     const minimalRow = { day_key, cycle_no, opening_cash };
     const retry = await supabase.from('arka_cycles').insert(minimalRow);
     if (retry.error) throw retry.error;
  }

  const c = await dbGetActiveCycle();
  if (!c) throw new Error('Cikli nuk u gjet pas hapjes.');
  return c;
}

// -------------------------
// Moves - Lëvizjet brenda ciklit
// -------------------------
export async function dbGetCycleMoves(cycleId) {
  const { data, error } = await supabase
    .from('arka_cycle_moves')
    .select('*')
    .eq('cycle_id', cycleId)
  if (error) return [];
  return Array.isArray(data) ? data : [];
}

export const dbListCycleMoves = dbGetCycleMoves;

export async function dbAddCycleMove(payload) {
  const {
    cycle_id,
    type,
    amount,
    note,

    // OPTIONAL: në disa instalime këto kolona ekzistojnë në arka_cycle_moves
    external_id,
    source,
    order_id,
    order_code,
    order_name,
    created_by_pin,
    created_by_name,
    created_by_role,
  } = payload || {};
  if (!cycle_id) throw new Error('cycle_id mungon');
  const amt = Number(amount || 0);
  if (!Number.isFinite(amt) || amt <= 0) throw new Error('SHUMA S’ËSHTË VALIDE');

  // Përpiqu fillimisht me payload “të plotë” (nëse DB i ka kolonat)
  // dhe nëse PostgREST ankohet për kolona që mungojnë (“schema cache”),
  // i heqim ato kolona dhe e provojmë prapë.
  const rowFull = {
    cycle_id,
    type: String(type || 'OUT').toUpperCase(),
    amount: amt,
    note: String(note || ''),

    // optional
    external_id: external_id ?? null,
    source: source ?? null,
    order_id: order_id ?? null,
    order_code: order_code ?? null,
    order_name: order_name ?? null,
    created_by_pin: created_by_pin ?? null,
    created_by_name: created_by_name ?? null,
    created_by_role: created_by_role ?? null,
  };

  // fallback minimal (për DB që kanë vetëm kolonat bazë)
  const rowMin = {
    cycle_id,
    type: String(type || 'OUT').toUpperCase(),
    amount: amt,
    note: String(note || ''),
  };

  // Helper: heq një kolonë dhe vazhdon
  async function tryInsertWithStripping(startRow) {
    let row = { ...startRow };
    for (let i = 0; i < 10; i++) {
      const ins = await supabase.from('arka_cycle_moves').insert(row);
      if (!ins.error) return { ok: true };

      const msg = String(ins.error?.message || ins.error?.details || ins.error || '');

      // Duplicate external_id (e.g. retry after refresh) — treat as success
      if (/duplicate key value violates unique constraint/i.test(msg)) {
        return { ok: true, duplicate: true };
      }

      // Pattern: Could not find the 'created_by_pin' column of 'arka_cycle_moves' in the schema cache
      const m = msg.match(/Could not find the '([^']+)' column of 'arka_cycle_moves'/i);
      if (m && m[1]) {
        const col = m[1];
        if (Object.prototype.hasOwnProperty.call(row, col)) {
          delete row[col];
          continue;
        }
      }

      // Ndonjëherë mesazhi vjen si: column "xyz" of relation ... does not exist
      const m2 = msg.match(/column\s+\"([^\"]+)\"\s+of\s+relation\s+\"arka_cycle_moves\"\s+does\s+not\s+exist/i);
      if (m2 && m2[1]) {
        const col = m2[1];
        if (Object.prototype.hasOwnProperty.call(row, col)) {
          delete row[col];
          continue;
        }
      }

      // Nëse dështoi për arsye tjetër (RLS, not-null, etj.) — ktheje gabimin real
      throw ins.error;
    }
    throw new Error('Nuk u arrit insert në arka_cycle_moves (strip retries)');
  }

  try {
    return await tryInsertWithStripping(rowFull);
  } catch (e) {
    // Nëse dështoi me payload të plotë, provo minimal (për DB shumë të vjetër)
    const msg = String(e?.message || e?.details || e || '');
    // vetëm nëse gabimi lidhet me kolona të panjohura/scheme cache
    if (/schema cache|does not exist|Could not find the/i.test(msg)) {
      return await tryInsertWithStripping(rowMin);
    }
    throw e;
  }
}

// -------------------------
// Close cycle - Mbyllja dhe llogaritja e diferencës
// -------------------------
export async function dbCloseCycle(payload = {}) {
  const cycle_id = payload.cycle_id ?? payload.cycleId;
  if (!cycle_id) throw new Error('cycle_id mungon');

  const cycle = await dbGetCycleById(cycle_id);
  const moves = await dbGetCycleMoves(cycle_id);
  
  const ins = (moves || [])
    .filter((m) => String(m.type || '').toUpperCase() === 'IN')
    .reduce((a, m) => a + Number(m.amount || 0), 0);
  const outs = (moves || [])
    .filter((m) => String(m.type || '').toUpperCase() === 'OUT')
    .reduce((a, m) => a + Number(m.amount || 0), 0);
    
  const startAmt = Number(cycle?.opening_cash ?? 0);
  const expected = startAmt + ins - outs;

  const counted = Number(payload.cash_counted ?? payload.cashCounted ?? expected);

  // Update vetëm kolonat që ekzistojnë në skemën tuaj (arka_cycles)
  const now = new Date().toISOString();
  // Mbyllja nga DISPATCH = "HANDED" (dorëzuar).
  // (Nëse pastaj ADMIN e pranon, kalon në "RECEIVED".)
  const upd = {
    handoff_status: 'HANDED',
    status: 'HANDED',
    expected_cash: expected,
    cash_counted: counted,
    discrepancy: counted - expected,
    end_cash: counted,
    closed_at: now,
    closed_by_pin: payload.closed_by_pin ?? payload.closedByPin ?? null,
    closed_by_name: payload.closed_by_name ?? payload.closedByName ?? null,
    closed_by: payload.closed_by ?? payload.closedBy ?? null,
  };

  const up1 = await supabase.from('arka_cycles').update(upd).eq('id', cycle_id);
  if (up1.error) throw up1.error;
  return { ok: true };
}

async function dbGetCycleById(cycleId) {
  const { data, error } = await supabase.from('arka_cycles').select('*').eq('id', cycleId).single();
  if (error) throw error;
  return data;
}

// -------------------------
// Handoff Workflow - Ndreqja e "is not a function"
// -------------------------
export async function dbListPendingHanded() {
  const { data, error } = await supabase
    .from('arka_cycles')
    .select('*')
    // "HANDED" do të thotë: u mbyll nga dispatch dhe pret pranim/receiving
    .or('handoff_status.eq.HANDED,status.eq.HANDED')
    .limit(50);
  
  if (error) return [];
  return (Array.isArray(data) ? data : []).map(mapCycle);
}

export async function dbHasPendingHanded() {
  try {
    const list = await dbListPendingHanded();
    return list && list.length > 0;
  } catch (e) {
    return false;
  }
}

export async function dbReceiveCycle(payload = {}) {
  const cycle_id = payload.cycle_id ?? payload.cycleId;
  if (!cycle_id) throw new Error('cycle_id mungon');

  const now = new Date().toISOString();
  const upd = {
    status: 'RECEIVED',
    handoff_status: 'RECEIVED',
    received_at: now,
    received_by: payload.received_by ?? payload.receivedBy ?? null,
  };
  // nëse roli/emer/pin i marrësit ekziston në payload, ruaje në fushat "closed_by_*"? jo.
  const r = await supabase.from('arka_cycles').update(upd).eq('id', cycle_id);
  if (r.error) throw r.error;

  // Sinkronizo me BUXHETIN E KOMPANIS (best-effort).
  // Qëllimi: kur Arka ditore pranohet (handoff), me u regjistru një hyrje në company_budget_moves.
  try {
    const { data: cycle, error: cErr } = await supabase
      .from('arka_cycles')
      .select('id, day_key, closing_cash, total_cash_in, total_cash_out')
      .eq('id', cycle_id)
      .single();
    if (!cErr && cycle) {
      const amount =
        (typeof cycle.closing_cash === 'number' && !Number.isNaN(cycle.closing_cash))
          ? cycle.closing_cash
          : (Number(cycle.total_cash_in || 0) - Number(cycle.total_cash_out || 0));

      const row = {
        direction: 'IN',
        amount: Math.max(0, Number(amount || 0)),
        reason: 'ARKA HANDOFF',
        note: `DAY ${cycle.day_key || ''}`.trim(),
        source: 'ARKA',
        external_id: `arka_cycle_${cycle_id}_received`,
        ref_day_id: cycle_id,
        ref_type: 'ARKA_CYCLE',
        created_by: payload.received_by ?? payload.receivedBy ?? null,
        created_by_name: payload.received_by_name ?? payload.receivedByName ?? null,
        created_by_pin: payload.received_by_pin ?? payload.receivedByPin ?? null,
      };

      // Idempotent upsert (kërkon unique index te external_id; nese s'ka, s'prish flow-in).
      await supabase
        .from('company_budget_moves')
        .upsert(row, { onConflict: 'external_id', ignoreDuplicates: true });
    }
  } catch {
    // ignore
  }

  return { ok: true };
}

export async function dbReceiveCycleMove() { return { ok: true }; }
export async function dbGetCarryoverToday() { return { carry_cash: 0 }; }

// -------------------------
// History
// -------------------------
export async function dbListHistoryDays(limitDays = 30) {
  const { data, error } = await supabase
    .from('arka_cycles')
    .select('*')
    .limit(300);
  
  if (error) return [];
  const byDay = new Map();
  for (const c of (data || [])) {
    const day_key = c?.day_key;
    if (!day_key) continue;
    if (!byDay.has(day_key)) {
      byDay.set(day_key, { id: day_key, day_key, expected_cash: 0 });
    }
    const d = byDay.get(day_key);
    // Për histori ditore na duhet shuma që u mbyll në arkë atë ditë (jo vetëm opening).
    // Nëse closing_cash mungon (disa rreshta të vjetër), bie prapë te opening_cash.
    d.expected_cash += Number(c.closing_cash ?? c.opening_cash ?? 0);
  }
  return Array.from(byDay.values()).slice(0, limitDays);
}

export async function dbListCyclesByDay(dayId) {
  const { data, error } = await supabase
    .from('arka_cycles')
    .select('*')
    .eq('day_key', dayId)
  if (error) return [];
  return (data || []).map(mapCycle);
}