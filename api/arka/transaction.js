import { apiFail, apiOk, createAdminClientOrThrow, readBody } from '../_helpers.js';
import { runArkaTransaction } from '../../lib/arka/arkaEngine.js';

export default async function handler(req, res) {
  try {
    if (req.method && req.method !== 'POST') return apiFail(res, 'METHOD_NOT_ALLOWED', 405);
    const body = typeof readBody === 'function' ? await readBody(req) : (req.body || {});
    const supabase = createAdminClientOrThrow();
    const result = await runArkaTransaction(body || {}, { supabase });
    return apiOk(res, result || {});
  } catch (error) {
    return apiFail(res, error, 400);
  }
}
