import { supabase } from '@/lib/supabaseClient';

const OFFLINE_KEY = 'transport_offline_queue_v1';

// --- ONLINE (SUPABASE) ---
export async function insertTransportOrder(order) {
  // transport_orders: INSERT për porosi të re; UPDATE pa prekur transport_id në retry/edit
  try {
    const nowIso = new Date().toISOString();
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
      updated_at: nowIso,
    };

    // 1) PROVO INSERT (transport_id vendoset vetëm këtu)
    const ins = await supabase
      .from('transport_orders')
      .insert(row)
      .select('id')
      .single();

    if (!ins.error) return { ok: true, data: ins.data };

    // 2) Nëse ekziston ID (p.sh. retry), bëj UPDATE pa transport_id
    const errCode = ins.error?.code || ins.error?.details || '';
    if (String(errCode).includes('23505') || String(ins.error?.message || '').toLowerCase().includes('duplicate')) {
      const updRow = {
        code_n: row.code_n,
        code_str: row.code_str,
        client_id: row.client_id,
        client_name: row.client_name,
        client_phone: row.client_phone,
        status: row.status,
        data: row.data,
        updated_at: nowIso,
      };
      const upd = await supabase
        .from('transport_orders')
        .update(updRow)
        .eq('id', row.id)
        .select('id')
        .single();

      if (upd.error) {
        console.error('❌ transport_orders update error:', upd.error);
        return { ok: false, error: upd.error.message || String(upd.error) };
      }
      return { ok: true, data: upd.data };
    }

    // 3) tjetër error (RLS, column lock, etj)
    console.error('❌ transport_orders insert error:', ins.error);
    return { ok: false, error: ins.error.message || String(ins.error) };
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
