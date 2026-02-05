import { supabase } from '@/lib/supabaseClient';

/**
 * Ruan porosinë e re të Transportit duke thirrur funksionin SQL.
 * Kjo siguron që klienti të krijohet/përditësohet dhe porosia të ruhet
 * në tabelat speciale të transportit.
 */
export async function insertTransportOrder(order) {
  try {
    // 1. Përgatitja e të dhënave për SQL Function (RPC)
    // Emrat e parametrave (p_...) duhet të jenë fiks siç i krijuam në SQL.
    const params = {
      p_id: order.id,
      p_code_n: order.code,                 // Numri (psh: 27) për renditje
      p_code_str: order.data.client.code,   // Teksti (psh: "T27" ose "T-OFF-...")
      p_client_name: order.data.client.name,
      p_client_phone: order.data.client.phone,
      p_address: order.data.transport.address,
      p_gps_lat: order.data.transport.lat,
      p_gps_lng: order.data.transport.lng,
      p_data: order.data,                   // JSON i plotë (tepiha, staza, fotot)
      p_status: order.status
    };

    // 2. Thirrja e funksionit në Supabase
    const { data, error } = await supabase.rpc('create_transport_order', params);

    if (error) {
      console.error("❌ SQL Insert Error:", error);
      // Kthejmë errorin që ta kapë UI dhe ta shfaqë
      return { ok: false, error: error.message };
    }

    return { ok: true, data };

  } catch (err) {
    console.error("❌ JS Error:", err);
    return { ok: false, error: err.message };
  }
}

/**
 * Përditëson një porosi ekzistuese të transportit.
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
    console.error("Update Error:", err);
    return { ok: false, error: err.message };
  }
}

/**
 * Opsionale: Kërkimi i klientëve të transportit (nëse do ta shtojmë më vonë në UI)
 */
export async function searchTransportClients(q) {
  const qq = String(q || '').trim();
  if (!qq) return [];
  const text = qq.toLowerCase();

  const { data, error } = await supabase
    .from('transport_clients')
    .select('id, name, phone, address, gps_lat, gps_lng')
    .or(`phone.ilike.%${text}%,name.ilike.%${text}%`)
    .limit(10);

  if (error) return [];
  return data || [];
}
