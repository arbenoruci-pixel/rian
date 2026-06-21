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
  const jsonData = data?.data && typeof data.data === 'object' && !Array.isArray(data.data) ? { ...data.data } : {};
  const nextStatus = String(data.status || jsonData.status || 'pastrim').trim();
  data.status = nextStatus;
  data.data = { ...jsonData, status: nextStatus };
  return stripNonSchemaCols(data);
}

function isDbNumericId(value) {
  return /^\d+$/.test(String(value || '').trim());
}

function normBaseCode(value) {
  const digits = String(value ?? '').replace(/\D+/g, '').replace(/^0+/, '');
  const n = Number(digits || 0);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function baseOrderCodeMatches(existing = {}, row = {}) {
  const existingData = existing?.data && typeof existing.data === 'object' && !Array.isArray(existing.data) ? existing.data : {};
  const rowData = row?.data && typeof row.data === 'object' && !Array.isArray(row.data) ? row.data : {};
  const existingCode = normBaseCode(existing?.code ?? existingData?.code ?? existingData?.client?.code);
  const incomingCode = normBaseCode(row?.code ?? rowData?.code ?? rowData?.client?.code);
  if (!existingCode || !incomingCode) return true;
  return existingCode === incomingCode;
}

function mergeExistingBaseRowForUpdate(existing = {}, row = {}) {
  const existingData = existing?.data && typeof existing.data === 'object' && !Array.isArray(existing.data) ? existing.data : {};
  const rowData = row?.data && typeof row.data === 'object' && !Array.isArray(row.data) ? row.data : {};
  const nextStatus = String(row?.status || rowData?.status || existing?.status || existingData?.status || 'pastrim').trim();
  const patch = {
    ...row,
    status: nextStatus,
    data: {
      ...existingData,
      ...rowData,
      status: nextStatus,
    },
    updated_at: new Date().toISOString(),
  };
  delete patch.local_oid;
  return stripNonSchemaCols(patch);
}

export async function POST(req) {
  try {
    const supabase = createServiceClientOrThrow();
    const body = await readBody(req);
    const { type, data, id } = body || {};

    if (type === 'insert_order') {
      const row = normalizeInsertOrderPayload(body);

      if (row.local_oid && isDbNumericId(row.local_oid)) {
        const numericId = Number(row.local_oid);
        const { data: existing, error: lookupError } = await supabase
          .from('orders')
          .select('id,code,local_oid,status,data')
          .eq('id', numericId)
          .maybeSingle();

        if (lookupError) return apiFail(lookupError.message, 500);

        if (existing?.id) {
          if (!baseOrderCodeMatches(existing, row)) {
            return apiFail(`NUMERIC_LOCAL_OID_CODE_MISMATCH:${row.local_oid}`, 409);
          }

          const patch = mergeExistingBaseRowForUpdate(existing, row);
          const { error: updateError } = await supabase
            .from('orders')
            .update(patch)
            .eq('id', numericId);

          if (updateError) return apiFail(updateError.message, 500);
          return apiOk({
            localId: body.localId,
            updated_existing: true,
            duplicate_guard: 'NUMERIC_LOCAL_OID_UPDATED_DB_ID',
            id: numericId,
          });
        }
      }

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
      await updateOrderRecord('orders', id, payload);
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
