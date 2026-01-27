import { supabase } from '@/lib/supabaseClient';
import { dbGetActiveCycle, dbHasPendingHanded, dbAddCycleMove } from '@/lib/arkaDb';

const LS_PENDING_KEY = 'arka_pending_payments_v1';
function lsRead(){ if(typeof window === 'undefined') return []; try{ const r=localStorage.getItem(LS_PENDING_KEY); return r?JSON.parse(r):[];}catch{return [];} }
function lsWrite(a){ if(typeof window !== 'undefined') localStorage.setItem(LS_PENDING_KEY, JSON.stringify(a)); }

export async function createPendingCashPayment(payload={}){
  const external_id = payload.external_id || `pend_${Date.now()}`;
  const row = { external_id, status: 'PENDING', amount: Number(payload.amount || 0), type: payload.type || 'IN', method: 'CASH', order_id: payload.order_id || null, created_by_pin: payload.created_by_pin || null, created_at: new Date().toISOString() };
  const { data, error } = await supabase.from('arka_pending_payments').insert(row).select('*').single();
  if (error) return { ok: false, error: error.message };
  return { ok: true, row: data };
}

export async function applyPendingPaymentToCycle({ pending, cycle_id, approved_by_name, approved_by_pin }){
  try {
    const move = await dbAddCycleMove({
      cycle_id,
      type: pending.type || 'IN',
      amount: pending.amount,
      note: pending.note || 'Pagese Pending',
      external_id: pending.external_id,
      created_by_pin: approved_by_pin || pending.created_by_pin
    });

    if (move.ok) {
      await supabase.from('arka_pending_payments').update({ status: 'APPLIED', applied_at: new Date().toISOString() }).eq('external_id', pending.external_id);
      return { ok: true };
    }
    return { ok: false, error: "Deshtoi dbAddCycleMove" };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export async function listPendingCashPayments(limit=200){
  const { data } = await supabase.from('arka_pending_payments').select('*').eq('status','PENDING').order('created_at', {ascending: true}).limit(limit);
  return { ok: true, items: data || [] };
}

export async function rejectPendingPayment({ pending, reject_note }) {
  const { error } = await supabase.from('arka_pending_payments').update({ status: 'REJECTED', reject_note }).eq('external_id', pending.external_id);
  return { ok: !error, error: error?.message };
}
