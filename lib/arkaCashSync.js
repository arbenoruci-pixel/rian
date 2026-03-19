import { supabase } from '@/lib/supabaseClient';
import { dbGetActiveCycle, dbHasPendingHanded, dbAddCycleMove } from '@/lib/arkaDb';
import { budgetAddMove } from '@/lib/companyBudgetDb';

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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(v){ return UUID_RE.test(String(v||'').trim()); }
function normalizeUuid(v){ const s = String(v||'').trim(); return isUuid(s) ? s : null; }
function translateDbError(errLike){
  const msg = String(errLike?.message || errLike?.details || errLike?.hint || errLike || '').toLowerCase();
  if (!msg) return 'Gabim i panjohur gjatë komunikimit me databazën.';
  if (msg.includes('nuk ekziston ose perdoruesi nuk eshte aktiv') || msg.includes('nuk ekziston ose përdoruesi nuk është aktiv')) return 'GABIM: PIN-i nuk ekziston ose llogaria nuk është aktive!';
  if (msg.includes('foreign key') && msg.includes('applied_cycle_id')) return 'GABIM: Cikli i arkës nuk është valid. Rifresko faqen dhe provo përsëri.';
  if (msg.includes('invalid input syntax for type uuid')) return 'GABIM: Cikli i arkës ka ID jo valide.';
  if (msg.includes('schema cache') || msg.includes('could not find')) return 'GABIM: Databaza po përditësohet. Provo përsëri pas pak.';
  return String(errLike?.message || errLike?.details || errLike || 'Gabim i panjohur');
}
function readCurrentUserData(){
  if (!isBrowser()) return null;
  try {
    const raw = localStorage.getItem('CURRENT_USER_DATA');
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

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

async function markOrderPendingApplied(external_id, order_id = null) {
  if (!external_id) return;
  try {
    if (order_id) {
      const { data } = await supabase.from('orders').select('id,data').eq('id', order_id).maybeSingle();
      if (data?.id) {
        const cur = data?.data || {};
        const pend = Array.isArray(cur?.pay?.pendingCash) ? [...cur.pay.pendingCash] : [];
        const idx = pend.findIndex((x) => String(x.external_id || x.externalId || '') === String(external_id));
        if (idx !== -1) {
          pend[idx] = { ...pend[idx], status: 'APPLIED', applied_at: new Date().toISOString() };
          await supabase.from('orders').update({ data: { ...cur, pay: { ...(cur.pay || {}), pendingCash: pend } } }).eq('id', order_id);
          return;
        }
      }
    }

    const { data } = await supabase.from('orders').select('id,data').order('created_at', { ascending: false }).limit(50);
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

async function markOrderPendingDebt(external_id, note = '', order_id = null) {
  if (!external_id) return;
  try {
    if (order_id) {
      const { data } = await supabase.from('orders').select('id,data').eq('id', order_id).maybeSingle();
      if (data?.id) {
        const cur = data?.data || {};
        const pend = Array.isArray(cur?.pay?.pendingCash) ? [...cur.pay.pendingCash] : [];
        const idx = pend.findIndex((x) => String(x.external_id || x.externalId || '') === String(external_id));
        if (idx !== -1) {
          pend[idx] = { ...pend[idx], status: 'REJECTED', rejected_at: new Date().toISOString(), reject_note: note || pend[idx]?.reject_note || '' };
          await supabase.from('orders').update({ data: { ...cur, pay: { ...(cur.pay || {}), pendingCash: pend } } }).eq('id', order_id);
          return;
        }
      }
    }

    const { data } = await supabase.from('orders').select('id,data').order('created_at', { ascending: false }).limit(50);
    if (!data) return;
    for (const row of data) {
      const cur = row?.data || {};
      const pend = cur.pay?.pendingCash;
      if (!Array.isArray(pend)) continue;
      const idx = pend.findIndex((x) => String(x.external_id || x.externalId || '') === String(external_id));
      if (idx === -1) continue;
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

  let actorPin = payload.created_by_pin || payload.user_pin || payload.createdByPin || payload.userPin || payload?.user?.pin || null;
  let actorName = payload.created_by_name || payload.user_name || payload.createdByName || payload.user || payload?.user?.name || null;
  const currentUser = (!actorPin || !actorName) ? readCurrentUserData() : null;
  actorPin = actorPin || currentUser?.pin || null;
  actorName = actorName || currentUser?.name || null;

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
    created_by_pin: actorPin || null,
    created_at: now 
  };

  const rowForLocal = {
    ...row,
    created_by_name: actorName || null,
    created_by_role: payload.created_by_role || payload.user_role || payload.createdByRole || payload?.user?.role || null,
  };

  let lastDbError = null;
  try {
    const ok = await pendingTableOk();
    if (ok) {
      const { data, error } = await supabase.from('arka_pending_payments').insert(row).select('*').single();
      if (!error) {
        let rowData = data;
        try {
          if (String(row.type||'').toUpperCase()==='TRANSPORT' && String(rowData?.status||'').toUpperCase()!=='COLLECTED') {
            const { data: fixedData } = await supabase.from('arka_pending_payments').update({ status: 'COLLECTED' }).eq('external_id', row.external_id).select('*').single();
            rowData = fixedData || { ...(rowData||{}), status: 'COLLECTED' };
          }
        } catch {}
        return { ok: true, pending: true, row: rowData };
      }

      lastDbError = { code: error.code, message: translateDbError(error), raw_message: error.message, details: error.details, hint: error.hint };
      if (error.code === '23505') {
        const { data: ex } = await supabase.from('arka_pending_payments').select('*').eq('external_id', external_id).maybeSingle();
        return { ok: true, pending: true, row: ex };
      }
    }
  } catch (e) {
    lastDbError = lastDbError || { message: translateDbError(e), raw_message: String(e?.message || e) };
  }

  await backupPendingIntoOrder({ ...payload, created_by_pin: actorPin || null, created_by_name: actorName || null }, external_id, rowForLocal);
  lsPush(rowForLocal);
  return { ok: true, pending: true, local: true, row: rowForLocal, db_error: lastDbError };
}

export async function recordCashMove(payload = {}) {
  const amt = Number(payload.amount || 0);
  if (amt <= 0) return { ok: false, skipped: true };

  const external_id = payload.external_id || payload.externalId || `cash_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const typeUpper = String(payload.type || '').toUpperCase();
  const explicitArkaType = String(payload.arka_type || payload.arkaType || '').toUpperCase();
  const isTransport = explicitArkaType === 'TRANSPORT' || typeUpper === 'TRANSPORT';

  let actor = {
    pin:
      payload.created_by_pin ||
      payload.createdByPin ||
      payload.user_pin ||
      payload.userPin ||
      payload?.user?.pin ||
      null,
    name:
      payload.created_by_name ||
      payload.createdByName ||
      payload.created_by ||
      payload.createdBy ||
      payload.user_name ||
      payload.user ||
      payload?.user?.name ||
      null,
    role:
      payload.created_by_role ||
      payload.createdByRole ||
      payload.user_role ||
      payload.userRole ||
      payload?.user?.role ||
      null,
  };

  if (typeof window !== 'undefined' && (!actor.pin || !actor.name || !actor.role)) {
    try {
      const raw = localStorage.getItem('CURRENT_USER_DATA');
      const parsed = raw ? JSON.parse(raw) : null;
      actor = {
        pin: actor.pin || parsed?.pin || null,
        name: actor.name || parsed?.name || null,
        role: actor.role || parsed?.role || null,
      };
    } catch {}
  }

  const normalizedPayload = {
    ...payload,
    external_id,
    amount: amt,
    created_by_pin: actor.pin || null,
    created_by_name: actor.name || null,
    created_by_role: actor.role || null,
    createdByPin: actor.pin || null,
    createdByName: actor.name || null,
    createdByRole: actor.role || null,
  };

  try {
    const pendingRes = await createPendingCashPayment(normalizedPayload);

    try {
      if (isTransport && typeof window !== 'undefined' && typeof localStorage !== 'undefined') {
        const tid = String(actor.pin || payload.transport_id || payload.transportId || '').trim();
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
              created_by_pin: actor.pin || null,
              created_by_name: actor.name || null,
            },
            ...(Array.isArray(st.items) ? st.items : []),
          ].slice(0, 500),
        };
        localStorage.setItem(key, JSON.stringify(next));
      }
    } catch {}

    const cycle = await dbGetActiveCycle();
    const hasHanded = await dbHasPendingHanded();
    if (!isTransport && cycle?.id && !cycle.closed_at && !hasHanded) {
      await dbAddCycleMove({
        cycle_id: cycle.id,
        type: String(payload.type || 'IN').toUpperCase(),
        amount: amt,
        note: payload.note || '',
        source: payload.source || 'ORDER_PAY',
        created_by: actor.name || 'SYSTEM',
        created_by_name: actor.name || null,
        created_by_pin: actor.pin || null,
        created_by_role: actor.role || null,
        external_id,
        order_id: payload.order_id || payload.orderId || null,
        order_code: payload.order_code || payload.code || null,
        order_name: payload.client_name || payload.name || null,
      });

      try {
        const applyUpdate = {
          status: 'APPLIED',
          approved_by_pin: actor.pin || null,
          approved_by_role: actor.role || null,
          applied_at: new Date().toISOString(),
        };
        const cycleUuid = normalizeUuid(cycle?.id);
        if (cycleUuid) applyUpdate.applied_cycle_id = cycleUuid;

        const { error: applyErr } = await supabase
          .from('arka_pending_payments')
          .update(applyUpdate)
          .eq('external_id', external_id)
          .in('status', ['PENDING', 'COLLECTED']);

        if (applyErr) throw applyErr;
      } catch (applyErr) {
        return { ok: false, error: translateDbError(applyErr), raw_error: String(applyErr?.message || applyErr) };
      }

      return { ok: true, direct: true, applied: true, external_id, cycle_id: cycle.id };
    }

    return pendingRes;
  } catch (e) {
    return await createPendingCashPayment(normalizedPayload);
  }
}

export async function listPendingCashPayments(limit = 100) {
  const hardLimit = Math.max(1, Math.min(Number(limit || 100), 200));
  const items = [];
  const seen = new Set();

  try {
    const { data } = await supabase
      .from('arka_pending_payments')
      .select('*')
      .or("status.eq.PENDING,and(type.eq.TRANSPORT,status.eq.COLLECTED)")
      .eq('method', 'CASH')
      .order('created_at', { ascending: true })
      .limit(hardLimit);
    if (data) {
      data.forEach((r) => {
        if (!seen.has(r.external_id)) {
          items.push(r);
          seen.add(r.external_id);
        }
      });
    }
  } catch {}

  if (items.length < hardLimit) {
    try {
      const { data } = await supabase.from('orders').select('id,data').order('created_at', { ascending: false }).limit(40);
      if (data) {
        data.forEach((row) => {
          const pends = row.data?.pay?.pendingCash || [];
          pends.forEach((p) => {
            const eid = p.external_id || p.externalId;
            if (p.status === 'PENDING' && eid && !seen.has(eid)) {
              items.push({ ...p, external_id: eid, order_id: row.id });
              seen.add(eid);
            }
          });
        });
      }
    } catch {}
  }

  if (items.length < hardLimit) {
    lsRead().forEach((l) => {
      if (l.status === 'PENDING' && l.external_id && !seen.has(l.external_id)) {
        items.push(l);
        seen.add(l.external_id);
      }
    });
  }

  return { ok: true, items: items.slice(0, hardLimit) };
}

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

// 🎯 KËTU ËSHTË RREGULLIMI MAGJIK QË BYPASSON GABIMIN: "GUARD: applied_cycle_id not found"
export async function applyPendingPaymentToCycle({ pending, cycle_id, approved_by_name, approved_by_pin, approved_by_role }) {
  if (!pending || !cycle_id) return { ok: false, error: 'NO_CYCLE' };
  const cycleUuid = normalizeUuid(cycle_id);
  if (!cycleUuid) return { ok: false, error: 'GABIM: Cikli i arkës ka ID jo valide.' };
  const eid = pending.external_id || pending.externalId;
  const nowIso = new Date().toISOString();

  try {
    const pendingType = String((String(pending?.type || '').toUpperCase() === 'TRANSPORT') ? 'IN' : (pending.type || 'IN')).toUpperCase();

    const chk = await supabase.from('arka_pending_payments').select('id,status').eq('external_id', eid).maybeSingle();
    if (!chk.data) {
      const restoreRow = {
        external_id: eid,
        status: 'PENDING',
        amount: Number(pending.amount || 0),
        type: pendingType,
        method: 'CASH',
        order_id: pending.order_id || null,
        order_code: pending.order_code || pending.code || null,
        client_name: pending.client_name || pending.name || null,
        note: pending.note || 'Restored from backup',
        created_at: pending.created_at || nowIso,
        created_by_pin: pending.created_by_pin || null,
      };
      const { error: restoreErr } = await supabase.from('arka_pending_payments').insert(restoreRow);
      if (restoreErr) throw restoreErr;
    } else if (chk.data.status === 'APPLIED') {
      return { ok: true, already: true };
    }

    const safeUpdate = {
      status: 'APPLIED',
      applied_cycle_id: cycleUuid,
      applied_at: nowIso,
      approved_by_pin: approved_by_pin ?? null,
    };

    let up = await supabase.from('arka_pending_payments').update(safeUpdate).eq('external_id', eid).select('id,status');
    if (up.error && String(up.error.message || '').toLowerCase().includes('column')) {
      up = await supabase
        .from('arka_pending_payments')
        .update({ status: 'APPLIED', applied_cycle_id: cycleUuid, applied_at: nowIso, approved_by_pin: approved_by_pin ?? null })
        .eq('external_id', eid)
        .select('id,status');
    }
    if (up.error) throw up.error;

    const codeGuess = pending.order_code || pending.code || pending.client_code || guessOrderCodeFromNote(pending.note);
    const nameGuess = pending.client_name || pending.name || pending.order_name || guessOrderNameFromNote(pending.note);
    
    const add = await dbAddCycleMove({
      cycle_id: cycleUuid,
      type: pendingType,
      amount: Number(pending.amount),
      note: pending.note || `PAGESA CASH ${Number(pending.amount)}€${codeGuess ? ` • #${codeGuess}` : ''}${nameGuess ? ` • ${nameGuess}` : ''}`,
      source: pending.source || 'ORDER_PAY',
      created_by: pending.created_by_name || approved_by_name || 'SYSTEM',
      created_by_name: pending.created_by_name || null,
      created_by_pin: pending.created_by_pin || null,
      created_by_role: pending.created_by_role || null,
      external_id: eid,
      order_id: pending.order_id || pending.orderId || null,
      order_code: codeGuess ? String(codeGuess) : null,
      order_name: nameGuess ? String(nameGuess) : null,
    });

    if (add?.error) {
      const msg = String(add.error.message || add.error || '');
      if (!msg.includes('duplicate') && !msg.includes('23505')) throw add.error;
    }

    await markOrderPendingApplied(eid, pending.order_id || pending.orderId || null);

    const next = lsRead().map((x) => (x.external_id === eid || x.externalId === eid) ? { ...x, status: 'APPLIED', applied_cycle_id: cycleUuid, approved_by_pin: approved_by_pin ?? null } : x);
    lsWrite(next);

    return { ok: true, external_id: eid };
  } catch (err) {
    return { ok: false, error: translateDbError(err), raw_error: String(err?.message || err) };
  }
}

export async function rejectPendingPayment({ pending, rejected_by_pin, rejected_by_name, rejected_by_role, reject_note } = {}) {
  if (!pending?.external_id && !pending?.externalId) return { ok: false, error: 'Missing pending.external_id' };
  const eid = pending.external_id || pending.externalId;
  const now = new Date().toISOString();

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

  try {
    await markOrderPendingDebt(eid, reject_note, pending.order_id || pending.orderId || null);
  } catch {}

  try {
    const next = lsRead().map((x) => (x.external_id === eid || x.externalId === eid)
      ? { ...x, status: 'REJECTED', type: 'WORKER_DEBT', rejected_at: now, rejected_by_pin: rejected_by_pin ?? null, rejected_by_name: rejected_by_name ?? null, rejected_by_role: rejected_by_role ?? null, reject_note: reject_note ?? null }
      : x
    );
    lsWrite(next);
  } catch {}

  return { ok: true, external_id: eid };
}

export async function processPendingPayments({ approved_by_name, approved_by_pin, approved_by_role } = {}) {
  const cycle = await dbGetActiveCycle();
  if (!cycle?.id) return { ok: false };
  const { items } = await listPendingCashPayments();
  let applied = 0;
  for (const p of items) {
    const res = await applyPendingPaymentToCycle({ pending: p, cycle_id: cycle.id, approved_by_name, approved_by_pin, approved_by_role });
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



async function addAcceptedBudgetEntry(item = {}, actorPin = null, dispatchUser = null) {
  const amount = Number(item?.amount || 0);
  if (!(amount > 0)) return { ok: true, skipped: true };
  const eid = item?.external_id || item?.externalId || `accepted_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const note = [
    'PRANIM NGA TERRENI',
    item?.created_by_name ? `PUNËTORI: ${item.created_by_name}` : null,
    actorPin ? `PIN: ${actorPin}` : null,
    item?.client_name ? `KLIENTI: ${item.client_name}` : null,
    item?.order_code ? `KODI: ${item.order_code}` : null,
    item?.note ? `SHËNIM: ${item.note}` : null,
  ].filter(Boolean).join(' • ');

  try {
    await budgetAddMove({
      direction: 'IN',
      amount,
      reason: 'FIELD_HANDOFF_ACCEPTED',
      note,
      source: 'ARKA_PENDING_ACCEPT',
      created_by: dispatchUser?.name || 'DISPATCH',
      created_by_name: dispatchUser?.name || null,
      created_by_pin: dispatchUser?.pin || null,
      ref_type: 'arka_pending_payments',
      external_id: eid,
    });
    return { ok: true };
  } catch (e) {
    // Best effort fallback to new company_budget table if available.
    try {
      const payload = {
        direction: 'IN',
        amount,
        reason: 'FIELD_HANDOFF_ACCEPTED',
        note,
        source: 'ARKA_PENDING_ACCEPT',
        status: 'ACTIVE',
        worker_pin: actorPin || item?.created_by_pin || null,
        worker_name: item?.created_by_name || null,
        accepted_by_pin: dispatchUser?.pin || null,
        accepted_by_name: dispatchUser?.name || null,
        accepted_at: new Date().toISOString(),
        external_id: eid,
      };
      const { error } = await supabase.from('company_budget').insert(payload);
      if (error) throw error;
      return { ok: true };
    } catch {
      return { ok: false, error: String(e?.message || e || 'budget insert failed') };
    }
  }
}

export async function confirmHandoffByDispatch(actorPin) {
  const pin = String(actorPin || '').trim();
  if (!pin) return { ok: false, error: 'MISSING_ACTOR_PIN' };
  const dispatchUser = readCurrentUserData() || null;
  const now = new Date().toISOString();
  let items = [];

  try {
    const { data } = await supabase
      .from('arka_pending_payments')
      .select('*')
      .eq('created_by_pin', pin)
      .eq('status', 'HANDED')
      .order('created_at', { ascending: true })
      .limit(500);
    if (Array.isArray(data)) items = data;
  } catch {}

  if (!items.length) {
    try {
      items = lsRead().filter((x) => String(x?.created_by_pin || x?.pin || '').trim() === pin && String(x?.status || '').toUpperCase() === 'HANDED');
    } catch {}
  }

  if (!items.length) return { ok: true, count: 0, total: 0 };

  let acceptedCount = 0;
  let total = 0;
  for (const item of items) {
    const eid = item?.external_id || item?.externalId;
    if (!eid) continue;

    try {
      const { error } = await supabase
        .from('arka_pending_payments')
        .update({
          status: 'ACCEPTED',
          accepted_at: now,
          accepted_by_pin: dispatchUser?.pin || null,
          accepted_by_name: dispatchUser?.name || null,
          accepted_by_role: dispatchUser?.role || null,
        })
        .eq('external_id', eid)
        .eq('status', 'HANDED');
      if (error) throw error;
    } catch {}

    try {
      await addAcceptedBudgetEntry(item, pin, dispatchUser);
    } catch {}

    total += Number(item?.amount || 0) || 0;
    acceptedCount += 1;

    try {
      await markOrderPendingApplied(eid, item?.order_id || item?.orderId || null);
    } catch {}
  }

  try {
    const next = lsRead().map((x) => {
      const p = String(x?.created_by_pin || x?.pin || '').trim();
      const st = String(x?.status || '').toUpperCase();
      if (p === pin && st === 'HANDED') {
        return {
          ...x,
          status: 'ACCEPTED',
          accepted_at: now,
          accepted_by_pin: dispatchUser?.pin || null,
          accepted_by_name: dispatchUser?.name || null,
          accepted_by_role: dispatchUser?.role || null,
        };
      }
      return x;
    });
    lsWrite(next);
  } catch {}

  return { ok: true, count: acceptedCount, total: Number(total.toFixed(2)), items };
}

export async function listPendingCashForActor(actorPin, limit = 200) {
  const pin = String(actorPin || '').trim();
  if (!pin) return { ok: true, items: [] };
  const res = await listPendingCashPayments(limit);
  const items = Array.isArray(res?.items) ? res.items.filter((x) => String(x?.created_by_pin || x?.pin || '').trim() === pin) : [];
  return { ok: true, items };
}

export async function handoffActorPendingCash({ actor, note = '' } = {}) {
  const pin = String(actor?.pin || '').trim();
  if (!pin) return { ok: false, error: 'MISSING_PIN' };
  const itemsRes = await listPendingCashForActor(pin, 500);
  const items = Array.isArray(itemsRes?.items) ? itemsRes.items.filter((x) => ['PENDING','COLLECTED'].includes(String(x?.status || '').toUpperCase())) : [];
  const total = items.reduce((sum, x) => sum + (Number(x?.amount || 0) || 0), 0);
  if (!items.length || total <= 0) return { ok: true, total: 0, count: 0 };

  const now = new Date().toISOString();
  for (const item of items) {
    const eid = item.external_id || item.externalId;
    if (!eid) continue;
    try {
      await supabase
        .from('arka_pending_payments')
        .update({
          status: 'HANDED',
          handed_at: now,
          handed_by_pin: pin,
          handed_by_name: actor?.name || null,
          handed_by_role: actor?.role || null,
          handoff_note: note || null,
        })
        .eq('external_id', eid)
        .in('status', ['PENDING', 'COLLECTED']);
    } catch {}
  }

  try {
    const next = lsRead().map((x) => {
      const p = String(x?.created_by_pin || x?.pin || '').trim();
      const st = String(x?.status || '').toUpperCase();
      if (p === pin && (st === 'PENDING' || st === 'COLLECTED')) {
        return { ...x, status: 'HANDED', handed_at: now, handed_by_pin: pin, handed_by_name: actor?.name || null, handed_by_role: actor?.role || null, handoff_note: note || null };
      }
      return x;
    });
    lsWrite(next);
  } catch {}

  return { ok: true, total: Number(total.toFixed(2)), count: items.length, items };
}
