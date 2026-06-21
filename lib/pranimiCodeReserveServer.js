import { reserveBaseCodesForPin } from './baseCodeAllocatorServer.js';

export async function runPranimiCodeReserveAction(body = {}, { supabase } = {}) {
  try {
    const result = await reserveBaseCodesForPin({
      pin: body?.pin ?? body?.actor_pin ?? body?.p_pin,
      count: body?.count ?? body?.n ?? body?.p_n ?? body?.p_count,
      leaseMinutes: body?.leaseMinutes ?? body?.lease_minutes ?? body?.p_lease_minutes,
      draftSessionId: body?.draftSessionId ?? body?.draft_session_id ?? body?.p_draft_session_id ?? body?.oid ?? body?.local_oid,
      deviceId: body?.deviceId ?? body?.device_id ?? null,
    }, { supabase });
    return { ...result, ok: true, signature: result?.source || 'RPC:get_or_assign_pranimi_code' };
  } catch (error) {
    return { ok: false, status: Number(error?.status || 500), error: String(error?.message || error || 'PRANIMI_CODE_RESERVE_FAILED'), error_code: error?.code || null, details: error?.details || null };
  }
}
