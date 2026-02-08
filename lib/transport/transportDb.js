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

    // Upsert by id (safe on retries)
    const { data, error } = await supabase
      .from('transport_orders')
      .upsert(row, { onConflict: 'id' })
      .select('id')
      .single();

    if (error) {
      console.error('❌ transport_orders upsert error:', error);
      return { ok: false, error: error.message || String(error) };
    }
    return { ok: true, data };
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
