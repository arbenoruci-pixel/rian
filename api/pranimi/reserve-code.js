// Legacy endpoint alias for older cached PWA bundles.
// It intentionally delegates to the single authoritative allocator.
import { apiFail, apiOk, createAdminClientOrThrow, readBody } from '../_helpers.js';
import { reserveBaseCodesForPin } from '../../lib/baseCodeAllocatorServer.js';

export default async function handler(req, res) {
  if (req.method && req.method !== 'POST') return apiFail(res, 'METHOD_NOT_ALLOWED', 405);
  try {
    const body = await readBody(req);
    const supabase = createAdminClientOrThrow();
    const result = await reserveBaseCodesForPin(body || {}, { supabase });
    return apiOk(res, {
      ...(result || {}),
      count: Array.isArray(result?.codes) ? result.codes.length : 0,
    });
  } catch (error) {
    return apiFail(res, error, Number(error?.status || 500), {
      code: error?.code || null,
      details: error?.details || null,
    });
  }
}
