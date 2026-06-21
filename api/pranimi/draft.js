import { apiFail, apiOk, createAdminClientOrThrow, readBody } from '../_helpers.js';
import { runPranimiDraftDbAction } from '../../lib/pranimiDraftDb.js';

export default async function handler(req, res) {
  try {
    if (req.method && req.method !== 'POST') return apiFail(res, 'METHOD_NOT_ALLOWED', 405);
    const body = await readBody(req);
    const supabase = createAdminClientOrThrow();
    const result = await runPranimiDraftDbAction(body || {}, { supabase });
    if (result?.ok === false) return apiFail(res, result.error || 'PRANIMI_DRAFT_DB_FAILED', result.status || 400, result);
    return apiOk(res, result || {});
  } catch (error) {
    return apiFail(res, error, 400);
  }
}
