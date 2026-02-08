import { supabase } from '@/lib/supabaseClient';

const OFFLINE_KEY = 'transport_offline_queue_v1';

// --- ONLINE (SUPABASE) ---
export async function insertTransportOrder(order) {
  // NOTE: transport_orders tabela NUK ka kolona si "code"/"address"/"gps_*".
  // Ne e ruajme gjithcka te order.data dhe perdorim kolona standarde te skemes.
  try {
    const row = {
      id: order.id,
      code_n: Number(order.code) || null,
      code_str: String(order?.data?.client?.code || ''),
      client_id: order?.data?.client?.client_id || null,
      client_name: String(order?.data?.client?.name || ''),
      client_phone: String(order?.data?.client?.phone || ''),
      status: String(order.status || 'pickup'),
      data: order.data || {},
      transport_id: String(order?.data?.transport?.transport_id || order?.transport_id || ''),
      updated_at: new Date().toISOString(),
    };

    // IMPORTANT:
    // transport_orders.transport_id is treated as an immutable ownership field in DB
    // (some setups block updating it except DEFAULT). So we:
    // 1) try INSERT (new order)
    // 2) if duplicate id -> UPDATE without transport_id
    let ins = await supabase
      .from('transport_orders')
      .insert(row)
      .select('id')
      .single();

    if (!ins.error) {
      return { ok: true, data: ins.data };
    }

    // Duplicate key (or conflict): update the mutable columns ONLY.
    const code = ins.error?.code || ins.error?.details || '';
    const isDup = String(code).includes('23505') || String(ins.error?.message || '').toLowerCase().includes('duplicate');
    if (!isDup) {
      console.error('❌ transport_orders insert error:', ins.error);
      return { ok: false, error: ins.error?.message || String(ins.error) };
    }

    const updateRow = {
      code_n: row.code_n,
      code_str: row.code_str,
      client_id: row.client_id,
      client_name: row.client_name,
      client_phone: row.client_phone,
      status: row.status,
      data: row.data,
      updated_at: row.updated_at,
      // DO NOT include transport_id here
    };

    const upd = await supabase
      .from('transport_orders')
      .update(updateRow)
      .eq('id', row.id)
      .select('id')
      .single();

    if (upd.error) {
      console.error('❌ transport_orders update error:', upd.error);
      return { ok: false, error: upd.error?.message || String(upd.error) };
    }
    return { ok: true, data: upd.data };
  } catch (err) {
    console.error('❌ JS Error:', err);
    return { ok: false, error: err?.message || String(err) };
  }
}

// --- OFFLINE (LOCAL STORAGE - QUEUE) ---
// Kjo ruan porositë e PËRFUNDUARA kur s'ka rrjet
export function saveOfflineTransportOrder(order) {
  try {
    const raw = localStorage.getItem(OFFLINE_KEY);
    const list = raw ? JSON.parse(raw) : [];
    const offlineOrder = { ...order, is_offline: true, saved_at: Date.now() };
    list.unshift(offlineOrder);
    localStorage.setItem(OFFLINE_KEY, JSON.stringify(list));
    return true;
  } catch (e) {
    return false;
  }
}
