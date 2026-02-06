import { supabase } from '@/lib/supabaseClient';

const OFFLINE_KEY = 'transport_offline_queue_v1';

// --- ONLINE (SUPABASE) ---
export async function insertTransportOrder(order) {
  try {
    const params = {
      p_id: order.id,
      p_code_n: order.code,
      p_code_str: order.data.client.code,
      p_client_name: order.data.client.name,
      p_client_phone: order.data.client.phone,
      p_address: order.data.transport.address,
      p_gps_lat: order.data.transport.lat,
      p_gps_lng: order.data.transport.lng,
      p_data: order.data,
      p_status: order.status
    };

    const { data, error } = await supabase.rpc('create_transport_order', params);

    if (error) {
      // Duplicate primary key (usually double-save or retry after partial success)
      const msg = String(error.message || '');
      const code = String(error.code || '');
      if (code === '23505' || msg.toLowerCase().includes('duplicate key')) {
        // Fallback: update existing row by id
        const { error: uerr } = await supabase
          .from('transport_orders')
          .update({
            code_n: order.code,
            code: order.data.client.code,
            client_name: order.data.client.name,
            client_phone: order.data.client.phone,
            address: order.data.transport.address,
            gps_lat: order.data.transport.lat,
            gps_lng: order.data.transport.lng,
            data: order.data,
            status: order.status,
            updated_at: new Date().toISOString(),
          })
          .eq('id', order.id);

        if (uerr) {
          console.error("❌ Update-after-duplicate failed:", uerr);
          return { ok: false, error: uerr.message || String(uerr) };
        }
        return { ok: true, mode: 'update-after-duplicate' };
      }

      console.error("❌ SQL Insert Error:", error);
      return { ok: false, error: error.message };
    }
    return { ok: true, data };
  } catch (err) {
    console.error("❌ JS Error:", err);
    return { ok: false, error: err.message };
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
