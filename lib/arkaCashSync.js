import { supabase } from '@/lib/supabaseClient';
import { dbGetActiveCycle, dbHasPendingHanded, dbAddCycleMove } from '@/lib/arkaDb';

const LS_PENDING_KEY = 'arka_pending_payments_v1';

function isBrowser(){ return typeof window !== 'undefined' && typeof localStorage !== 'undefined'; }
function lsRead(){ if(!isBrowser()) return []; try{ const r=localStorage.getItem(LS_PENDING_KEY); const a=r?JSON.parse(r):[]; return Array.isArray(a)?a:[];}catch{return [];} }
function lsWrite(a){ if(!isBrowser()) return; try{ localStorage.setItem(LS_PENDING_KEY, JSON.stringify(a)); }catch{} }
function lsPush(i){ const a=lsRead(); a.unshift(i); lsWrite(a.slice(0,500)); }

async function pendingTableOk(){ const { error } = await supabase.from('arka_pending_payments').select('id').limit(1); return !error; }

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

export async function createPendingCashPayment(payload={}){
  // created_at e lejmë DEFAULT në DB (disa skema s'pranojnë vlerë manuale)
  // FIX: Sigurohemi qe gjithmone kemi nje ID unike
  const external_id = payload.externalId || payload.external_id || `pend_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const amount = Number(payload.amount || 0);
  
  const row = { 
    external_id, 
    status: 'PENDING', 
    amount, 
    type: String(payload.type || 'IN').toUpperCase(), 
    method: 'CASH',
    order_id: payload.order_id || payload.orderId || null,
    order_code: payload.order_code || payload.code || null,
    client_name: payload.client_name || payload.name || null,
    note: payload.note || '',
    created_by_pin: payload.created_by_pin || payload.user_pin || null,
    created_by_name: payload.created_by_name || payload.user || null,
  };

  try {
    const ok = await pendingTableOk();
    if (ok) {
      // FIX: Hiqet rowMinimal. Nese deshton inserti me external_id, nuk bejme insert "anonim".
      const { data, error } = await supabase.from('arka_pending_payments').insert(row).select('*').single();
      if (!error) return { ok: true, pending: true, row: data };
      
      // Nese ID ekziston (Unique Error), kthejme rreshtin ekzistues
      if (error.code === '23505') {
        const { data: ex } = await supabase.from('arka_pending_payments').select('*').eq('external_id', external_id).maybeSingle();
        return { ok: true, pending: true, row: ex };
      }
    }
  } catch {}

  // Backup nese DB deshton
  await backupPendingIntoOrder(payload, external_id, row);
  lsPush(row);
  return { ok: true, pending: true, local: true, row };
}

export async function recordCashMove(payload={}){
  const amt = Number(payload.amount || 0);
  if (amt <= 0) return { ok: false, skipped: true };
  const external_id = payload.external_id || payload.externalId || `cash_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  
  try {
    const cycle = await dbGetActiveCycle(supabase);
    const hasHanded = await dbHasPendingHanded(supabase);
    
    // FIX: Kontrolli per arken e mbyllur
    if (!cycle?.id || cycle.closed_at || hasHanded) {
      return await createPendingCashPayment({ ...payload, external_id, amount: amt });
    }
    
    // FIX: ID-ja nuk ndryshon kurre, mbetet origjinalja
    await dbAddCycleMove(supabase, { 
      cycle_id: cycle.id, 
      type: String(payload.type || 'IN').toUpperCase(), 
      amount: amt, 
      note: payload.note || '', 
      source: payload.source || 'ORDER_PAY', 
      created_by: payload.user || 'SYSTEM', 
      external_id: external_id 
    });
    return { ok: true, direct: true };
  } catch (e) {
    return await createPendingCashPayment({ ...payload, external_id, amount: amt });
  }
}

export async function listPendingCashPayments(limit=200){
  const items = [];
  const seen = new Set();

  // 1. DB SQL
  try {
    const { data } = await supabase.from('arka_pending_payments').select('*').eq('status','PENDING').order('created_at', {ascending: true}).limit(limit);
    if (data) data.forEach(r => { if(!seen.has(r.external_id)){ items.push(r); seen.add(r.external_id); } });
  } catch {}

  // 2. Orders Backup
  try {
    const { data } = await supabase.from('orders').select('id,data').order('created_at', {ascending: false}).limit(100);
    if (data) {
      data.forEach(row => {
        const pends = row.data?.pay?.pendingCash || [];
        pends.forEach(p => {
          const eid = p.external_id || p.externalId;
          if (p.status === 'PENDING' && eid && !seen.has(eid)) {
            items.push({ ...p, external_id: eid, order_id: row.id });
            seen.add(eid);
          }
        });
      });
    }
  } catch {}

  // 3. Local
  lsRead().forEach(l => {
    if (l.status === 'PENDING' && l.external_id && !seen.has(l.external_id)) {
      items.push(l);
      seen.add(l.external_id);
    }
  });

  return { ok: true, items: items.slice(0, limit) };
}

// Pagesa CASH qe jane regjistruar kur ARKA ka qene e MBYLLUR.
// Kjo liste duhet me u konfirmu nga DISPATCH/ADMIN me "PRANO" ose "BORXH".
// Kthehet e grupuar sipas PIN-it (created_by_pin) per UI.
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

export async function applyPendingPaymentToCycle({ pending, cycle_id, approved_by_name, approved_by_pin, approved_by_role }){
  if (!pending || !cycle_id) return { ok: false };
  const eid = pending.external_id || pending.externalId;

  try {
    // FIX: external_id mbetet i njejte (eid), nuk i shtohet "applied:"
    await dbAddCycleMove(supabase, {
      cycle_id,
      type: pending.type || 'IN',
      amount: Number(pending.amount),
      note: pending.note || 'Pending Payment',
      source: 'ORDER_PAY',
      created_by: approved_by_name || 'SYSTEM',
      external_id: eid 
    });

    // RLS/policies can cause "0 rows updated" with no error; we must verify.
const nowIso = new Date().toISOString();

// Some DB versions use approved_by_* fields (approved_at may NOT exist; applied_at usually exists).
const fullUpdate = {
  status: 'APPLIED',
  applied_at: nowIso,
  applied_cycle_id: cycle_id,
  approved_by_pin: (approved_by_pin ?? null),
  approved_by_name: (approved_by_name ?? null),
  approved_by_role: (approved_by_role ?? null),
};

// Try full update first; if DB doesn't have these columns, fall back to minimal update.
let up = await supabase
  .from('arka_pending_payments')
  .update(fullUpdate)
  .eq('external_id', eid)
  .select('id,status');

if (up.error && String(up.error.message || '').includes('column')) {
  up = await supabase
    .from('arka_pending_payments')
    .update({ status: 'APPLIED', applied_at: nowIso, applied_cycle_id: cycle_id })
    .eq('external_id', eid)
    .select('id,status');
}

if (up.error) throw up.error;
if (!up.data || up.data.length === 0) {
  throw new Error('RLS_BLOCKED_UPDATE');
}

    await markOrderPendingApplied(eid);
    
    const next = lsRead().map(x => (x.external_id === eid || x.externalId === eid) ? { ...x, status: 'APPLIED' } : x);
    lsWrite(next);
    
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// Sheno pagesen e mbetur "pending" si BORXH (DEBT).
// - Update arka_pending_payments (nese ekziston tabela)
// - Update orders.data.pay.pendingCash (fallback)
// - Update localStorage fallback list
export async function rejectPendingPayment({ pending, rejected_by_pin, rejected_by_name, rejected_by_role, reject_note } = {}) {
  if (!pending?.external_id && !pending?.externalId) return { ok: false, error: 'Missing pending.external_id' };
  const eid = pending.external_id || pending.externalId;
  const now = new Date().toISOString();

  // 1) DB: provo me ruajt fushat e plota; nese schema s'i ka, bie ne update minimal.
  try {
    const payload = {
      status: 'DEBT',
      rejected_at: now,
      rejected_by_pin: rejected_by_pin ?? null,
      rejected_by_name: rejected_by_name ?? null,
      rejected_by_role: rejected_by_role ?? null,
      reject_note: reject_note ?? null,
    };
    await supabase.from('arka_pending_payments').update(payload).eq('external_id', eid);
  } catch (e1) {
    try {
      await supabase.from('arka_pending_payments').update({ status: 'DEBT', rejected_at: now }).eq('external_id', eid);
    } catch {}
  }

  // 2) Orders fallback: sheno pendingCash si DEBT
  try {
    await markOrderPendingDebt(eid, reject_note);
  } catch {}

  // 3) LocalStorage fallback
  try {
    const next = lsRead().map(x => (x.external_id === eid || x.externalId === eid)
      ? { ...x, status: 'DEBT', rejected_at: now, rejected_by_pin: rejected_by_pin ?? null, rejected_by_name: rejected_by_name ?? null, rejected_by_role: rejected_by_role ?? null, reject_note: reject_note ?? null }
      : x
    );
    lsWrite(next);
  } catch {}

  return { ok: true };
}

export async function processPendingPayments({ approved_by_name } = {}) {
  const cycle = await dbGetActiveCycle();
  if (!cycle?.id) return { ok: false };
  const { items } = await listPendingCashPayments();
  let applied = 0;
  for (const p of items) {
    const res = await applyPendingPaymentToCycle({ pending: p, cycle_id: cycle.id, approved_by_name });
    if (res.ok) applied++;
  }
  return { ok: true, applied };
}
