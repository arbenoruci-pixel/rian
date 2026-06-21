import { apiFail, apiOk, createAdminClientOrThrow, readBody } from '../_helpers.js';
import { reserveBaseCodesForPin } from '../../lib/baseCodeAllocatorServer.js';

export default async function handler(req, res) {
  if (req.method && req.method !== 'POST') return apiFail(res, 'METHOD_NOT_ALLOWED', 405);
  try {
    const body = await readBody(req);
    const supabase = createAdminClientOrThrow();
    const result = await reserveBaseCodesForPin(body || {}, { supabase });
    return apiOk(res, result || {});
  } catch (error) {
    return apiFail(res, error, Number(error?.status || 500), {
      code: error?.code || null,
      details: error?.details || null,
    });
  }
}
