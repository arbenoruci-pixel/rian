import { supabase } from '@/lib/supabaseClient';

// NOTE: This module is intentionally defensive.
// Your Supabase schema has evolved (tables vs views, different column names).
// We try the "best" payload first, and if Supabase returns "column does not exist",
// we retry with a reduced payload so the app keeps working.

function toNum(v) {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function isMissingColumnError(err) {
  const msg = String(err?.message || '').toLowerCase();
  return msg.includes('does not exist') || msg.includes('could not find the') || msg.includes('schema cache');
}

async function insertOrUpsertWithFallback(table, payload, conflictTarget, fallbacks) {
  // 1) Try full payload
  let q = supabase.from(table).upsert(payload, { onConflict: conflictTarget });
  let r = await q.select().maybeSingle();
  if (!r.error) return r.data;

  // 2) If missing column, retry with progressively smaller payloads
  if (isMissingColumnError(r.error)) {
    for (const p of fallbacks) {
      const r2 = await supabase.from(table).upsert(p, { onConflict: conflictTarget }).select().maybeSingle();
      if (!r2.error) return r2.data;
      if (!isMissingColumnError(r2.error)) throw r2.error;
    }
  }

  throw r.error;
}

export async function upsertPayrollProfile(profile) {
  // Most common columns we've seen:
  // - user_id (required)
  // - worker_name (sometimes required / NOT NULL)
  // - role (optional)
  // - pay_amount (numeric)
  // - pay_cycle (weekly/biweekly/monthly)
  // - next_pay_date (date)
  // - note (text)

  const base = {
    user_id: profile.user_id,
    worker_name: profile.worker_name || profile.name || null,
    role: profile.role || null,
    pay_amount: toNum(profile.pay_amount),
    pay_cycle: profile.pay_cycle || null,
    next_pay_date: profile.next_pay_date || null,
    note: profile.note || null,
  };

  // Fallbacks if your table doesn't have some fields
  const f1 = { ...base };
  delete f1.role;

  const f2 = { ...f1 };
  delete f2.worker_name;

  const f3 = {
    user_id: profile.user_id,
    pay_amount: toNum(profile.pay_amount),
    pay_cycle: profile.pay_cycle || null,
    next_pay_date: profile.next_pay_date || null,
    note: profile.note || null,
  };

  return insertOrUpsertWithFallback(
    'tepiha_payroll_profiles',
    base,
    'user_id',
    [f1, f2, f3]
  );
}

export async function getPayrollProfile(userId) {
  const { data, error } = await supabase
    .from('tepiha_payroll_profiles')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function listPayrollMoves(userId, limit = 30) {
  const { data, error } = await supabase
    .from('tepiha_payroll_moves')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

export async function addPayrollMove(move) {
  const kind = String(move?.kind || '').toUpperCase();
  // Direction is required by your DB (NOT NULL). Keep it strict.
  // IN  = money comes back to us (worker returns debt)
  // OUT = money goes out from us (advance/salary/bonus, or debt added as liability)
  let direction = 'OUT';
  if (kind === 'BORXH_KTHE') direction = 'IN';

  const base = {
    user_id: move.user_id,
    worker_name: move.worker_name || move.name || null,
    kind,
    direction,
    amount: toNum(move.amount) || 0,
    note: move.note || null,
    source: move.source || null, // ARKA | COMPANY | PERSONAL (optional column)

    // actor/audit
    created_by: move.created_by || null,
    actor_name: move.actor_name || null,
    created_by_pin: move.created_by_pin || null,
    authorized_by: move.authorized_by || null,
    authorized_by_name: move.authorized_by_name || null,
  };

  // Progressive fallbacks for evolving schemas
  const fallbacks = [];
  {
    const f = { ...base };
    delete f.authorized_by;
    delete f.authorized_by_name;
    fallbacks.push(f);
  }
  {
    const f = { ...fallbacks[0] };
    delete f.created_by_pin;
    fallbacks.push(f);
  }
  {
    const f = { ...fallbacks[1] };
    delete f.source;
    fallbacks.push(f);
  }
  {
    const f = { ...fallbacks[2] };
    delete f.created_by;
    delete f.actor_name;
    fallbacks.push(f);
  }
  {
    const f = { ...fallbacks[3] };
    delete f.worker_name;
    fallbacks.push(f);
  }
  {
    const f = { ...fallbacks[4] };
    delete f.direction;
    fallbacks.push(f);
  }

  // 1) try full
  const r0 = await supabase.from('tepiha_payroll_moves').insert(base).select().maybeSingle();
  if (!r0.error) return r0.data;

  if (isMissingColumnError(r0.error)) {
    for (const p of fallbacks) {
      const r = await supabase.from('tepiha_payroll_moves').insert(p).select().maybeSingle();
      if (!r.error) return r.data;
      if (!isMissingColumnError(r.error)) throw r.error;
    }
  }
  throw r0.error;
}

// Debt logic:
// BORXH_SHTO increases debt, BORXH_KTHE decreases.
// RROGA/AVANS/BONUS are treated as payments (decrease debt) by default.
export function computeDebt(moves) {
  let d = 0;
  for (const m of moves || []) {
    const amt = Number(m.amount) || 0;
    const k = String(m.kind || '').toUpperCase();
    if (k === 'BORXH_SHTO') d += amt;
    else if (k === 'BORXH_KTHE') d -= amt;
    else d -= amt;
  }
  return d;
}
