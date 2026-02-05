import { supabase } from '@/lib/supabaseClient';

const OFFLINE_KEY = 'transport_offline_queue_v1';

// --- PJESA 1: ONLINE (Database) ---

/**
 * Ruan porosinë në Supabase (kur ka rrjet).
 */
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
      console.error("❌ SQL Insert Error:", error);
      return { ok: false, error: error.message };
    }

    return { ok: true, data };

  } catch (err) {
    console.error("❌ JS Error:", err);
    return { ok: false, error: err.message };
  }
}

// --- PJESA 2: OFFLINE (Local Storage) ---

/**
 * E ruan porosinë në telefon (LocalStorage) kur s'ka rrjet.
 */
export function saveOfflineTransportOrder(order) {
  try {
    // 1. Marrim listën e vjetër
    const raw = localStorage.getItem(OFFLINE_KEY);
    const list = raw ? JSON.parse(raw) : [];

    // 2. Shtojmë porosinë e re në fillim
    // I shtojmë një flamur 'is_offline: true' për ta ditur më vonë
    const offlineOrder = { ...order, is_offline: true, saved_at: Date.now() };
    list.unshift(offlineOrder);

    // 3. E ruajmë prapë
    localStorage.setItem(OFFLINE_KEY, JSON.stringify(list));
    return true;
  } catch (e) {
    console.error("❌ Dështoi ruajtja lokale:", e);
    return false;
  }
}

/**
 * Merr të gjitha porositë offline (për t'i shfaqur te "Të pa sinkronizuara").
 */
export function getOfflineTransportOrders() {
  try {
    const raw = localStorage.getItem(OFFLINE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

/**
 * Fshin një porosi offline (pasi të jetë sinkronizuar me sukses).
 */
export function deleteOfflineTransportOrder(orderId) {
  try {
    const list = getOfflineTransportOrders();
    const newList = list.filter((o) => o.id !== orderId);
    localStorage.setItem(OFFLINE_KEY, JSON.stringify(newList));
  } catch {}
}

/**
 * Ndihmës për update (Online)
 */
export async function updateTransportOrder(orderId, updates) {
  try {
    const { data, error } = await supabase
      .from('transport_orders')
      .update(updates)
      .eq('id', orderId)
      .select();

    if (error) throw error;
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
