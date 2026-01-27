import { supabase } from '@/lib/supabaseClient';
import { dbGetActiveCycle, dbHasPendingHanded, dbAddCycleMove } from '@/lib/arkaDb';

const LS_PENDING_KEY = 'arka_pending_payments_v1';

function isBrowser(){ return typeof window !== 'undefined' && typeof localStorage !== 'undefined'; }
function lsRead(){ if(!isBrowser()) return []; try{ const r=localStorage.getItem(LS_PENDING_KEY); const a=r?JSON.parse(r):[]; return Array.isArray(a)?a:[];}catch{return [];} }
function lsWrite(a){ if(!isBrowser()) return; try{ localStorage.setItem(LS_PENDING_KEY, JSON.stringify(a)); }catch{} }
function lsPush(i){ const a=lsRead(); a.unshift(i); lsWrite(a.slice(0,500)); }

async function pendingTableOk(){ const { error } = await supabase.from('arka_pending_payments').select('id').limit(1); return !error; }


async function updatePendingRowWithFallback(id, payloadAttempts) {
  let lastErr = null;
  for (const payload of payloadAttempts) {
    const { error } = await supabase.from('arka_pending_payments').update(payload).eq('id', id);
    if (!error) return { ok: true };
    lastErr = error;
    const msg = String(error.message || '');
    // nëse është problem kolone, provo payload-in tjetër
    if (msg.includes('column') && msg.includes('does not exist')) continue;
    return { ok: false, error };
  }
  return { ok: false, error: lastErr || new Error('UPDATE FAILED') };
}

async function insertPendingRowWithFallback(rowAttempts) {
  let lastErr = null;
  for (const row of rowAttempts) {
    const { error } = await supabase.from('arka_pending_payments').insert(row);
    if (!error) return { ok: true };
    lastErr = error;
    const msg = String(error.message || '');
    if (msg.includes('column') && msg.includes('does not exist')) continue;
    return { ok: false, error };
  }
  return { ok: false, error: lastErr || new Error('INSERT FAILED') };
}
async function backupPendingIntoOrder(payload = {}, external_id, rowLike = {}) {
  try {
    const order_id = payload.orderId || payload.order_id || null;
    if (!order_id || !external_id) return;

    const { data, error } = await supabase.from('orders').select('id,data').eq('id', Number(order_id)).maybeSingle();
    if (error || !data?.id) return;

    const current = { ...(data.data || {}) };
    const pay = { ...(current.pay || {}) };
    const pend = Array.isArray(pay.pendingCash) ? [...pay.pendingCash] : [];

    // FIX: Kontroll i rrepte per external_id per te shmangur dublimin ne backup
    const exists = pend.some((x) => String(x.external_id || x.externalId || '') === String(external_id));
    if (exists) return;

    pend.unshift({
      external_id,
      status: 'PENDING',
      amount: Number(rowLike.amount || payload.amount || 0),
      type: String(rowLike.type || payload.type || 'IN').toUpperCase(),
      method: 'CASH',
      note: rowLike.note || payload.note || '',
      created_at: rowLike.created_at || new Date().toISOString(),
    });

    pay.pendingCash = pend.slice(0, 100);
    await supabase.from('orders').update({ data: { ...current, pay } }).eq('id', Number(order_id));
  } catch {}
}

async function markOrderPendingApplied(external_id) {
  if (!external_id) return;
  try {
    const { data } = await supabase.from('orders').select('id,data').order('created_at', { ascending: false }).limit(200);
    if (!data) return;
    for (const row of data) {
      const cur = row?.data || {};
      const pend = cur.pay?.pendingCash;
      if (!Array.isArray(pend)) continue;
      const idx = pend.findIndex((x) => String(x.external_id || x.externalId || '') === String(external_id));
      if (idx === -1) continue;
      pend[idx].status = 'APPLIED';
      pend[idx].applied_at = new Date().toISOString();
      await supabase.from('orders').update({ data: cur }).eq('id', row.id);
      break;
    }
  } catch {}
}

async function markOrderPendingDebt(external_id, note='') {
  if (!external_id) return;
  try {
    const { data } = await supabase.from('orders').select('id,data').order('created_at', { ascending: false }).limit(200);
    if (!data) return;
    for (const row of data) {
      const cur = row?.data || {};
      const pend = cur.pay?.pendingCash;
      if (!Array.isArray(pend)) continue;
      const idx = pend.findIndex((x) => String(x.external_id || x.externalId || '') === String(external_id));
      if (idx === -1) continue;
      pend[idx].status = 'DEBT';
      pend[idx].rejected_at = new Date().toISOString();
      if (note && !pend[idx].reject_note) pend[idx].reject_note = note;
      await supabase.from('orders').update({ data: cur }).eq('id', row.id);
      break;
    }
  } catch {}
}


export async function createPendingCashPayment(payload) {
  try {
    if (!(await pendingTableOk())) return { ok: false, error: 'Tabela arka_pending_payments nuk ekziston' };

    const p = payload || {};
    const rowFull = {
      order_id: p.order_id ?? null,
      external_id: p.external_id ?? null,
      amount: Number(p.amount || 0),
      status: 'PENDING',
      created_at: new Date().toISOString(),
      created_by_pin: p.created_by_pin ?? null,
      created_by_name: p.created_by_name ?? null,
      created_by_role: p.created_by_role ?? null,
      note: p.note ?? null,
    };

    const rowNoMeta = {
      order_id: rowFull.order_id,
      external_id: rowFull.external_id,
      amount: rowFull.amount,
      status: rowFull.status,
      created_at: rowFull.created_at,
      note: rowFull.note,
    };

    const ins = await insertPendingRowWithFallback([rowFull, rowNoMeta]);
    if (!ins.ok) return { ok: false, error: ins.error };

    return { ok: true };
  } catch (e) {
    return { ok: false, error: e };
  }
}


export async function listPendingCashPayments(limit = 200) {
  try {
    if (!(await pendingTableOk())) return [];

    // Disa versione e kanë statusin OWED kur arka është e mbyllur
    let q = supabase
      .from('arka_pending_payments')
      .select('*')
      .in('status', ['PENDING', 'OWED'])
      .order('created_at', { ascending: false })
      .limit(Number(limit || 200));

    let { data, error } = await q;
    if (error) {
      // fallback për versione që s’e suportojnë .in ose kanë vetëm PENDING
      const r2 = await supabase
        .from('arka_pending_payments')
        .select('*')
        .eq('status', 'PENDING')
        .order('created_at', { ascending: false })
        .limit(Number(limit || 200));
      data = r2.data;
      error = r2.error;
    }
    if (error) return [];
    return data || [];
  } catch (e) {
    return [];
  }
}

export async function listOwedCashPaymentsByPin(limit=500){
  // 1) Merr pagesat OWED nga DB (arka_pending_payments)
  let rows = [];
  try {
    const { data } = await supabase
      .from('arka_pending_payments')
      .select('*')
      .eq('status', 'OWED')
      .order('created_at', { ascending: true })
      .limit(limit);
    if (Array.isArray(data)) rows = data;
  } catch {}

  // 2) Fallback: nese nuk ka rows (ose DB s'ka), provo nga orders.data.pay.pendingCash
  if (!rows.length) {
    try {
      const { data } = await supabase
        .from('orders')
        .select('id,data')
        .order('created_at', { ascending: false })
        .limit(200);
      if (Array.isArray(data)) {
        const tmp = [];
        data.forEach(row => {
          const pends = row.data?.pay?.pendingCash || [];
          pends.forEach(p => {
            if (p.status === 'OWED') tmp.push({ ...p, order_id: row.id });
          });
        });
        rows = tmp;
      }
    } catch {}
  }

  // 3) Group by created_by_pin (ose pin)
  const byPin = new Map();
  for (const r of rows) {
    const pin = r.created_by_pin || r.pin || 'PA_PIN';
    const name = r.created_by_name || r.name || '';
    const key = pin;
    if (!byPin.has(key)) byPin.set(key, { pin, name, total: 0, count: 0, items: [] });
    const g = byPin.get(key);
    const amt = Number(r.amount ?? r.sum ?? 0) || 0;
    g.total += amt;
    g.count += 1;
    g.items.push(r);
  }

  const groups = Array.from(byPin.values())
    .sort((a,b) => (b.total - a.total) || (b.count - a.count) || String(a.pin).localeCompare(String(b.pin)));

  return { ok: true, items: groups };
}


export async function applyPendingPaymentToCycle({ pending, approved_by_pin, approved_by_name, approved_by_role } = {}) {
  try {
    if (!(await pendingTableOk())) return { ok: false, error: 'Tabela arka_pending_payments nuk ekziston' };
    if (!pending?.id) return { ok: false, error: 'pending.id mungon' };

    const nowIso = new Date().toISOString();

    // gjej ciklin aktiv (OPEN)
    const { data: cycle, error: cycleErr } = await supabase
      .from('arka_cycles')
      .select('*')
      .eq('status', 'OPEN')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (cycleErr) return { ok: false, error: cycleErr };
    if (!cycle?.id) return { ok: false, error: 'Arka s’është OPEN' };

    // 1) shto levizje ne arka_cycle_moves (note mban punëtorin)
    const who = (approved_by_name || '').trim() || (approved_by_pin ? `#${approved_by_pin}` : '');
    const whoRole = (approved_by_role || '').trim();
    const note = `PAGESË NGA PENDING${who ? ` — ${who}` : ''}${whoRole ? ` (${whoRole})` : ''}`.trim();

    const moveIns = await supabase.from('arka_cycle_moves').insert({
      cycle_id: cycle.id,
      type: 'IN',
      amount: Number(pending.amount || 0),
      note,
      created_at: nowIso,
    });

    if (moveIns.error) return { ok: false, error: moveIns.error };

    // 2) shëno pending si APPLIED (me fallback për kolonat)
    const attempts = [
      { status: 'APPLIED', applied_at: nowIso, applied_cycle_id: cycle.id, approved_by_pin: approved_by_pin ?? null, approved_by_name: approved_by_name ?? null, approved_by_role: approved_by_role ?? null },
      { status: 'APPLIED', applied_at: nowIso, applied_cycle_id: cycle.id, applied_by_pin: approved_by_pin ?? null, applied_by_name: approved_by_name ?? null, applied_by_role: approved_by_role ?? null },
      { status: 'APPLIED', applied_at: nowIso, applied_cycle_id: cycle.id },
      { status: 'APPLIED', applied_at: nowIso },
      { status: 'APPLIED' },
    ];

    const up = await updatePendingRowWithFallback(pending.id, attempts);
    if (!up.ok) return { ok: false, error: up.error };

    // 3) nëse është e lidhur me order, pastro pending flag në order (nëse ekziston fusha)
    if (pending.order_id) {
      // tolerancë: në disa skema ka fushë pending_cash / cash_pending
      await supabase.from('orders').update({ cash_pending: false, pending_cash: false }).eq('id', pending.order_id);
    }

    return { ok: true };
  } catch (e) {
    return { ok: false, error: e };
  }
}


export async function rejectPendingPayment({ pending, rejected_by_pin, rejected_by_name, rejected_by_role, reject_note } = {}) {
  try {
    if (!(await pendingTableOk())) return { ok: false, error: 'Tabela arka_pending_payments nuk ekziston' };
    if (!pending?.id) return { ok: false, error: 'pending.id mungon' };

    const nowIso = new Date().toISOString();
    const attempts = [
      { status: 'REJECTED', rejected_at: nowIso, rejected_by_pin: rejected_by_pin ?? null, rejected_by_name: rejected_by_name ?? null, rejected_by_role: rejected_by_role ?? null, reject_note: reject_note ?? null },
      { status: 'REJECTED', rejected_at: nowIso, reject_note: reject_note ?? null },
      { status: 'REJECTED' },
    ];
    const up = await updatePendingRowWithFallback(pending.id, attempts);
    if (!up.ok) return { ok: false, error: up.error };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e };
  }
}


