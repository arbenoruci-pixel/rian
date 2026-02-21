import { supabase } from '@/lib/supabaseClient';
import { dbGetActiveCycle, dbHasPendingHanded, dbAddCycleMove } from '@/lib/arkaDb';

const LS_PENDING_KEY = 'arka_pending_payments_v1';

// === PATCH FINAL: TRANSPORT vs BASE ROUTING ===
// Single brain rule: code starting with "T" goes to TRANSPORT arka.
export function detectArkaTypeFromCode(code){
  try{
    const c = String(code||'').trim().toUpperCase();
    if(c.startsWith('T')) return 'TRANSPORT';
    return 'BASE';
  }catch{
    return 'BASE';
  }
}
// === END PATCH ===


function isBrowser(){ return typeof window !== 'undefined' && typeof localStorage !== 'undefined'; }
function lsRead(){ if(!isBrowser()) return []; try{ const r=localStorage.getItem(LS_PENDING_KEY); const a=r?JSON.parse(r):[]; return Array.isArray(a)?a:[];}catch{return [];} }
function lsWrite(a){ if(!isBrowser()) return; try{ localStorage.setItem(LS_PENDING_KEY, JSON.stringify(a)); }catch{} }
function lsPush(i){ const a=lsRead(); a.unshift(i); lsWrite(a.slice(0,500)); }

// Best-effort extractors (fallback when we only have a note string)
function guessOrderCodeFromNote(note){
  const s=String(note||'');
  const m=s.match(/#\s*(\d{1,8})/);
  return m ? m[1] : null;
}
function guessOrderNameFromNote(note){
  const s=String(note||'');
  const parts=s.split('•').map(x=>String(x).trim()).filter(Boolean);
  const last=parts[parts.length-1]||'';
  return last && last.length>=2 ? last : null;
}

// Don't gate pending inserts on a SELECT probe: some RLS setups allow INSERT/UPDATE but block SELECT.
async function pendingTableOk(){
  return true;
}

async function backupPendingIntoOrder(payload = {}, external_id, rowLike = {}) {
  try {
    const order_id = payload.orderId || payload.order_id || null;
    if (!order_id || !external_id) return;

    // order_id is UUID in this project
    const { data, error } = await supabase.from('orders').select('id,data').eq('id', order_id).maybeSingle();
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
      // ✅ Keep enough metadata so Arka UI can show "emri" even when the real pending table is missing.
      order_id,
      order_code: payload.code || payload.order_code || null,
      client_name: payload.name || payload.client_name || null,
      created_by_pin: payload.createdByPin || payload.created_by_pin || null,
      created_by_name: payload.createdBy || payload.created_by_name || null,
      source: payload.source || rowLike.source || null,
      note: rowLike.note || payload.note || '',
      created_at: rowLike.created_at || new Date().toISOString(),
    });

    pay.pendingCash = pend.slice(0, 100);
    await supabase.from('orders').update({ data: { ...current, pay } }).eq('id', order_id);
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
      // Keep status aligned with DB values (PENDING/APPLIED/REJECTED)
      // For debt marking in the order backup, we use REJECTED + reject_note.
      pend[idx].status = 'REJECTED';
      pend[idx].rejected_at = new Date().toISOString();
      if (note && !pend[idx].reject_note) pend[idx].reject_note = note;
      await supabase.from('orders').update({ data: cur }).eq('id', row.id);
      break;
    }
  } catch {}
}

export async function createPendingCashPayment(payload={}){
  const now = new Date().toISOString();
  // FIX: Sigurohemi qe gjithmone kemi nje ID unike
  const external_id = payload.externalId || payload.external_id || `pend_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const amount = Number(payload.amount || 0);
  
  const row = { 
    external_id, 
    // default is PENDING, but TRANSPORT payments should be stored as COLLECTED
    // (they must NOT be auto-applied into daily ARKA until handoff)
    status: String((String(payload.type||'').toUpperCase()==='TRANSPORT' && !payload.status) ? 'COLLECTED' : (payload.status || 'PENDING')).toUpperCase(), 
    amount, 
    type: String(payload.type || 'IN').toUpperCase(), 
    method: 'CASH',
    order_id: payload.order_id || payload.orderId || null,
    order_code: payload.order_code || payload.code || null,
    client_name: payload.client_name || payload.name || null,
    note: payload.note || '',
    created_by_pin: payload.created_by_pin || payload.user_pin || null,
    created_by_name: payload.created_by_name || payload.user || null,
    created_at: now 
  };

  let lastDbError = null;
  try {
    const ok = await pendingTableOk();
    if (ok) {
      // FIX: Hiqet rowMinimal. Nese deshton inserti me external_id, nuk bejme insert "anonim".
      const { data, error } = await supabase.from('arka_pending_payments').insert(row).select('*').single();
      if (!error) {
        let rowData = data;
        try {
          if (String(row.type||'').toUpperCase()==='TRANSPORT' && String(rowData?.status||'').toUpperCase()!=='COLLECTED') {
            await supabase.from('arka_pending_payments').update({ status: 'COLLECTED' }).eq('external_id', row.external_id);
            rowData = { ...(rowData||{}), status: 'COLLECTED' };
          }
        } catch {}
        return { ok: true, pending: true, row: rowData };
      }

      // keep error so UI can show why it fell back to local
      lastDbError = { code: error.code, message: error.message, details: error.details, hint: error.hint };
      
      // Nese ID ekziston (Unique Error), kthejme rreshtin ekzistues
      if (error.code === '23505') {
        const { data: ex } = await supabase.from('arka_pending_payments').select('*').eq('external_id', external_id).maybeSingle();
        return { ok: true, pending: true, row: ex };
      }
    }
  } catch (e) {
    // non-Postgrest exception
    lastDbError = lastDbError || { message: String(e?.message || e) };
  }

  // Backup nese DB deshton
  await backupPendingIntoOrder(payload, external_id, row);
  lsPush(row);
  return { ok: true, pending: true, local: true, row, db_error: lastDbError };
}

export async function recordCashMove(payload={}){
  const amt = Number(payload.amount || 0);
  if (amt <= 0) return { ok: false, skipped: true };
  const external_id = payload.external_id || payload.externalId || `cash_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const typeUpper = String(payload.type || '').toUpperCase();
  const oc = String(payload.order_code || payload.code || '').toUpperCase();
  // ✅ ROUTING RULE (PRODUCTION):
  // Transport is ONLY when explicitly marked as TRANSPORT (or arka_type/arkaType === 'TRANSPORT').
  // Do NOT infer transport from the order code (T123) because BASE can also collect cash for transport orders.
  const explicitArkaType = String(payload.arka_type || payload.arkaType || '').toUpperCase();
  const isTransport = (explicitArkaType === 'TRANSPORT') || (typeUpper === 'TRANSPORT');
try {
    // 1) KRIJO/UPSERT ALWAYS PENDING (kjo e ben rrugen e pagesave 100% te qarte)
    const pendingRes = await createPendingCashPayment({ ...payload, external_id, amount: amt });

    // TRANSPORT: gjithmone ruaj edhe ne local wallet te transportusit (per UI)
    try {
      if (isTransport && typeof window !== 'undefined' && typeof localStorage !== 'undefined') {
        const tid = String(payload.created_by_pin || payload.createdByPin || payload.user_pin || payload.userPin || payload.transport_id || payload.transportId || '').trim();
        const key = `arka_transport_wallet_v1_${tid || 'unknown'}`;
        const raw = localStorage.getItem(key);
        const st = raw ? JSON.parse(raw) : { items: [], expenses: [], transfers: [] };
        const next = {
          ...st,
          items: [
            {
              ts: Date.now(),
              external_id,
              order_code: payload.order_code || payload.code || '',
              client_name: payload.client_name || payload.name || '',
              amount: amt,
              note: payload.note || '',
              status: String(payload.status || 'COLLECTED').toUpperCase(),
            },
            ...(Array.isArray(st.items) ? st.items : []),
          ].slice(0, 500),
        };
        localStorage.setItem(key, JSON.stringify(next));
      }
    } catch {}


    // 2) Nese ka CYCLE OPEN dhe nuk eshte HANDED, e aplikojme MENJEHERE
    const cycle = await dbGetActiveCycle();
    const hasHanded = await dbHasPendingHanded();
    if (!isTransport && cycle?.id && !cycle.closed_at && !hasHanded) {
      // a) krijo levizje ne cycle
      await dbAddCycleMove({
        cycle_id: cycle.id,
        type: String(payload.type || 'IN').toUpperCase(),
        amount: amt,
        note: payload.note || '',
        source: payload.source || 'ORDER_PAY',
        created_by: payload.user || 'SYSTEM',
        external_id,
        order_id: payload.order_id || payload.orderId || null,
      });

      // b) sheno pending = APPLIED (nese ekziston)
      try {
        await supabase
          .from('arka_pending_payments')
          .update({
            status: 'APPLIED',
            approved_by_name: payload?.created_by_name || payload?.user?.name || payload?.user_name || null,
            approved_by_pin: payload?.created_by_pin || payload?.user?.pin || payload?.user_pin || null,
            applied_cycle_id: cycle.id,
            applied_at: new Date().toISOString(),
          })
          .eq('external_id', external_id)
          .eq('status','PENDING');
      } catch {}

      return { ok: true, direct: true, applied: true, external_id, cycle_id: cycle.id };
    }

    // Nese s'ka cycle OPEN ose eshte HANDED, mbetet PENDING per konfirmim ne ARKE.
    return pendingRes;
  } catch (e) {
    return await createPendingCashPayment({ ...payload, external_id, amount: amt });
  }
}

export async function listPendingCashPayments(limit=200){
  const items = [];
  const seen = new Set();

  // 1. DB SQL
  try {
    // NOTE: historical data may use status=PENDING or OWED. We treat both as "needs confirmation".
    // Also table uses method (CASH/BANK/...) rather than a dedicated boolean.
    const { data } = await supabase
      .from('arka_pending_payments')
      .select('*')
      // show normal PENDING + transport COLLECTED that still needs to be applied
      .or("status.eq.PENDING,and(type.eq.TRANSPORT,status.eq.COLLECTED)")
      .eq('method','CASH')
      .order('created_at', {ascending: true})
      .limit(limit);
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
  // 1) Merr pagesat PENDING nga DB (arka_pending_payments)
  let rows = [];
  try {
    const { data } = await supabase
      .from('arka_pending_payments')
      .select('*')
      .or("status.eq.PENDING,and(type.eq.TRANSPORT,status.eq.COLLECTED)")
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
            if (p.status === 'PENDING') tmp.push({ ...p, order_id: row.id });
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
  if (!pending || !cycle_id) return { ok: false, error: 'NO_CYCLE' };
  const eid = pending.external_id || pending.externalId;
  const nowIso = new Date().toISOString();

  try {
    // --- AUTO-HEALING: Kontrollojme nese rreshti ekziston ne DB ---
    const chk = await supabase.from('arka_pending_payments').select('id,status').eq('external_id', eid).maybeSingle();
    
    // Nese nuk ekziston (eshte vetem ne Backup), e krijojme para se ta bejme update
    if (!chk.data) {
       await supabase.from('arka_pending_payments').insert({
         external_id: eid,
         status: 'PENDING',
         amount: Number(pending.amount || 0),
      // TRANSPORT pagesa duhet me u regjistru si IN në CYCLE, përndryshe nuk hyn në llogaritje (IN/OUT).
      type: String((String(pending?.type||'').toUpperCase() === 'TRANSPORT') ? 'IN' : (pending.type || 'IN')).toUpperCase(),
         method: 'CASH',
         order_id: pending.order_id || null,
         note: pending.note || 'Restored from backup',
         created_at: pending.created_at || nowIso,
         created_by_pin: pending.created_by_pin || null,
         created_by_name: pending.created_by_name || null
       });
    } else if (chk.data.status === 'APPLIED') {
       return { ok: true, already: true };
    }

    // 1) First, flip pending row -> APPLIED (this is the source of truth)
    const fullUpdate = {
      status: 'APPLIED',
      applied_at: nowIso,
      applied_cycle_id: cycle_id,
      approved_by_pin: (approved_by_pin ?? null),
      approved_by_name: (approved_by_name ?? null),
      approved_by_role: (approved_by_role ?? null),
    };

    let up = await supabase
      .from('arka_pending_payments')
      .update(fullUpdate)
      .eq('external_id', eid)
      .select('id,status');

    // If the DB doesn't have approved_by_* columns, fall back to minimal update.
    if (up.error && String(up.error.message || '').toLowerCase().includes('column')) {
      up = await supabase
        .from('arka_pending_payments')
        .update({ status: 'APPLIED', applied_at: nowIso, applied_cycle_id: cycle_id })
        .eq('external_id', eid)
        .select('id,status');
    }

    if (up.error) throw up.error;

    // 2) Then add the cycle move. If it already exists (re-try), ignore.
    const codeGuess = pending.order_code || pending.code || pending.client_code || guessOrderCodeFromNote(pending.note);
    const nameGuess = pending.client_name || pending.name || pending.order_name || guessOrderNameFromNote(pending.note);
    const add = await dbAddCycleMove({
      cycle_id,
      // TRANSPORT pagesa duhet me u regjistru si IN në CYCLE, përndryshe nuk hyn në llogaritje (IN/OUT).
      type: String((String(pending?.type||'').toUpperCase() === 'TRANSPORT') ? 'IN' : (pending.type || 'IN')).toUpperCase(),
      amount: Number(pending.amount),
      note: pending.note || `PAGESA CASH ${Number(pending.amount)}€${codeGuess ? ` • #${codeGuess}` : ''}${nameGuess ? ` • ${nameGuess}` : ''}`,
      source: 'ORDER_PAY',
      created_by: approved_by_name || 'SYSTEM',
      external_id: eid,
      order_id: pending.order_id || pending.orderId || pending.order_id || null,
      order_code: codeGuess ? String(codeGuess) : null,
      order_name: nameGuess ? String(nameGuess) : null,
    });

    if (add?.error) {
      const msg = String(add.error.message || add.error || '');
      // ignore duplicates on external_id
      if (!msg.includes('duplicate') && !msg.includes('23505')) throw add.error;
    }

    await markOrderPendingApplied(eid);

    const next = lsRead().map(x => (x.external_id === eid || x.externalId === eid) ? { ...x, status: 'APPLIED' } : x);
    lsWrite(next);

    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
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
      status: 'REJECTED',
      type: 'WORKER_DEBT',
      rejected_at: now,
      rejected_by_pin: rejected_by_pin ?? null,
      rejected_by_name: rejected_by_name ?? null,
      rejected_by_role: rejected_by_role ?? null,
      reject_note: reject_note ?? null,
    };
    await supabase.from('arka_pending_payments').update(payload).eq('external_id', eid);
  } catch (e1) {
    try {
      await supabase.from('arka_pending_payments').update({ status: 'REJECTED', type: 'WORKER_DEBT', rejected_at: now }).eq('external_id', eid);
    } catch {}
  }

  // 2) Orders fallback: sheno pendingCash si REJECTED (DEBT)
  try {
    await markOrderPendingDebt(eid, reject_note);
  } catch {}

  // 3) LocalStorage fallback
  try {
    const next = lsRead().map(x => (x.external_id === eid || x.externalId === eid)
      ? { ...x, status: 'REJECTED', type: 'WORKER_DEBT', rejected_at: now, rejected_by_pin: rejected_by_pin ?? null, rejected_by_name: rejected_by_name ?? null, rejected_by_role: rejected_by_role ?? null, reject_note: reject_note ?? null }
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


// ✅ Worker debt: list OWED items for a specific worker name (PIN stays hidden in UI)
export async function listWorkerOwedPayments(workerName, limit=200){
  const name = String(workerName || '').trim();
  if (!name) return { ok:true, rows:[] };

  // 1) DB
  try {
    const { data } = await supabase
      .from('arka_pending_payments')
      .select('*')
      .in('status',['OWED','REJECTED'])
      .eq('method','CASH')
      .eq('created_by_name', name)
      .order('created_at', { ascending: true })
      .limit(limit);
    if (Array.isArray(data) && data.length) return { ok:true, rows:data };
  } catch {}

  // 2) Fallback from orders backup
  try {
    const { data } = await supabase
      .from('orders')
      .select('id,data')
      .order('created_at', { ascending: false })
      .limit(200);
    const rows = [];
    if (Array.isArray(data)) {
      data.forEach(row => {
        const pends = row.data?.pay?.pendingCash || [];
        pends.forEach(p => {
          if ((p.status === 'OWED' || p.status === 'REJECTED') && String(p.created_by_name || p.name || '').trim() === name) {
            rows.push({ ...p, order_id: row.id });
          }
        });
      });
    }
    return { ok:true, rows: rows.slice(0, limit) };
  } catch {}

  return { ok:true, rows:[] };
}

// ✅ Worker confirms they delivered cash -> convert OWED back to PENDING (for DISPATCH to PRANO)
export async function markOwedAsPending({ pending, actor } = {}){
  const eid = pending?.external_id || pending?.externalId;
  if (!eid) return { ok:false, error:'Missing external_id' };
  const now = new Date().toISOString();

  try {
    const payload = {
      status: 'PENDING',
      delivered_at: now,
      delivered_by_name: actor?.name ?? null,
      delivered_by_role: actor?.role ?? null,
      delivered_by_pin: actor?.pin ?? null,
    };
    const { error } = await supabase
      .from('arka_pending_payments')
      .update(payload)
      .eq('external_id', eid);
    if (error) throw error;
    return { ok:true };
  } catch {}

  // fallback: try minimal
  try {
    const { error } = await supabase
      .from('arka_pending_payments')
      .update({ status:'PENDING' })
      .eq('external_id', eid);
    if (error) throw error;
    return { ok:true };
  } catch (e) {
    return { ok:false, error: e?.message || String(e) };
  }
}

// ✅ Worker accepts as advance -> mark OWED as ADVANCE (not expected in ARKA anymore)
export async function markOwedAsAdvance({ pending, actor, note } = {}){
  const eid = pending?.external_id || pending?.externalId;
  if (!eid) return { ok:false, error:'Missing external_id' };
  const now = new Date().toISOString();

  try {
    const payload = {
      status: 'ADVANCE',
      advance_at: now,
      advance_by_name: actor?.name ?? null,
      advance_by_role: actor?.role ?? null,
      advance_by_pin: actor?.pin ?? null,
      advance_note: note ?? null,
    };
    const { error } = await supabase
      .from('arka_pending_payments')
      .update(payload)
      .eq('external_id', eid);
    if (error) throw error;
    return { ok:true };
  } catch {}

  // fallback minimal
  try {
    const { error } = await supabase
      .from('arka_pending_payments')
      .update({ status:'ADVANCE' })
      .eq('external_id', eid);
    if (error) throw error;
    return { ok:true };
  } catch (e) {
    return { ok:false, error: e?.message || String(e) };
  }
}
