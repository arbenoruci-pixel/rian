// lib/offlineSyncNow.js
import { supabase } from '@/lib/supabaseClient';
import { getAllOrdersLocal, saveOrderLocal } from '@/lib/offlineStore';

async function isOnlineDbFast(timeoutMs = 1200) {
  try {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;
  } catch {}
  try {
    const ping = supabase.from('orders').select('id').limit(1);
    const timeout = new Promise((resolve) =>
      setTimeout(() => resolve({ error: { message: 'TIMEOUT' } }), timeoutMs)
    );
    const res = await Promise.race([ping, timeout]);
    return !res?.error;
  } catch {
    return false;
  }
}

function toNum(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

export async function syncLocalOrdersToDbNow() {
  const online = await isOnlineDbFast();
  if (!online) return { ok: false, reason: 'OFFLINE' };

  const local = await getAllOrdersLocal();
  const pending = (local || []).filter((o) => o && (o._synced === false || o._local === true));

  let pushed = 0;
  let failed = 0;

  for (const o of pending) {
    try {
      const dbRow = {
        code: o.code,
        code_n: o.code_n ?? o.code,
        status: o.status || 'pastrim',
        client_name: o.client_name || o.data?.client?.name || null,
        client_phone: o.client_phone || o.data?.client?.phone || null,
        total: toNum(o.total ?? o.data?.pay?.euro ?? o.data?.pay?.total ?? 0),
        paid: toNum(o.paid ?? o.data?.pay?.paid ?? 0),
        data: o.data || null,
        is_offline: false,
        updated_at: new Date().toISOString(),
      };

      const { data: ins, error } = await supabase
        .from('orders')
        .insert([dbRow])
        .select('id, created_at, code')
        .single();

      if (error) throw error;

      await saveOrderLocal({
        ...o,
        id: ins?.id || o.id,
        _synced: true,
        _local: false,
        created_at: ins?.created_at || o.created_at || o.updated_at,
      });

      pushed++;
    } catch (e) {
      failed++;
      console.log('SYNC_FAIL_ORDER', o?.code, e?.message || e);
    }
  }

  return { ok: failed === 0, pushed, failed, pending: pending.length };
}
