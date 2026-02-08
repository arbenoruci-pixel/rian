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
    // - Disa projekte kane constraint qe transport_id NUK lejohet me u bo UPDATE (vetem DEFAULT).
    // - Upsert mundet me ra ne UPDATE kur id ekziston (draft/edit), edhe atehere prishet.
    // Prandaj: provojme INSERT; nese s'bon (p.sh. duplicate id), bojm UPDATE pa transport_id.

    const ins = await supabase
      .from('transport_orders')
      .insert(row)
      .select('id')
      .single();

    if (!ins.error) return { ok: true, data: ins.data };

    // Fallback UPDATE (pa transport_id)
    const { transport_id, ...rowNoTransport } = row;
    const upd = await supabase
      .from('transport_orders')
      .update(rowNoTransport)
      .eq('id', row.id)
      .select('id')
      .single();

    if (upd.error) {
      console.error('❌ transport_orders insert/update error:', ins.error, upd.error);
      return { ok: false, error: upd.error.message || ins.error.message || String(upd.error || ins.error) };
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
