/*
 SYNC ROUTE — HARDENED VERSION
 - original insert_order behavior preserved
 - validation + logger added
 - set_status now uses status engine through ordersService
*/
import { createServiceClientOrThrow, apiOk, apiFail, logApiError, readBody } from '@/lib/apiService';
import { transitionOrderStatus, updateOrderRecord } from '@/lib/ordersService';
import { validateOrderStatus } from '@/lib/validation';
export const dynamic = 'force-dynamic';

function stripNonSchemaCols(row = {}) {
  const out = { ...(row || {}) };
  delete out.table;
  delete out._table;
  delete out.localOnly;
  delete out.kind;
  delete out.op;
  delete out.op_id;
  delete out.attempts;
  delete out.lastError;
  delete out.nextRetryAt;
  delete out.server_id;
  delete out.client;
  delete out.code_n;
  delete out.data_patch;
  Object.keys(out).forEach((key) => {
    if (String(key || '').startsWith('_')) delete out[key];
  });
  return out;
}

function normalizeInsertOrderPayload(body) {
  const data = stripNonSchemaCols({ ...(body?.data || {}) });
  if (typeof data.id === 'string') delete data.id;
  if (!data.local_oid) {
    data.local_oid = body?.localId || data.local_id || null;
  }
  delete data.local_id;
  if (data.is_offline === undefined) data.is_offline = true;
  if (!data.status) data.status = 'pastrim';
  return stripNonSchemaCols(data);
}

export async function POST(req) {
  try {
    const supabase = createServiceClientOrThrow();
    const body = await readBody(req);
    const { type, data, id } = body || {};

    if (type === 'insert_order') {
      const row = normalizeInsertOrderPayload(body);
      const q = row.local_oid
        ? supabase.from('orders').upsert(row, { onConflict: 'local_oid', ignoreDuplicates: true })
        : supabase.from('orders').insert(row);
      const { error } = await q;
      if (error) return apiFail(error.message, 500);
      return apiOk({ localId: body.localId });
    }

    if (type === 'patch_order_data') {
      const payload = stripNonSchemaCols({ ...(data || {}) });
      delete payload.data_patch;
      const { error } = await supabase.from('orders').update(payload).eq('id', id);
      if (error) return apiFail(error.message, 500);
      return apiOk();
    }

    if (type === 'set_status') {
      const nextStatus = validateOrderStatus('orders', data?.status, ['pranim', 'pastrim', 'gati', 'dispatched', 'marrje', 'dorzim']);
      if (!nextStatus) return apiFail('INVALID_STATUS', 400);
      await transitionOrderStatus('orders', id, nextStatus);
      await updateOrderRecord('orders', id, { updated_at: new Date().toISOString() });
      return apiOk();
    }

    return apiFail('UNKNOWN_OP_TYPE', 400);
  } catch (e) {
    logApiError('api.sync', e);
    const msg = String(e?.message || e);
    if (msg.includes('STATUS_TRANSITION_NOT_ALLOWED')) return apiFail(msg, 400);
    return apiFail(msg, 500);
  }
}
