import { apiFail, apiOk, createAdminClientOrThrow, normalizePin, readBody } from '../_helpers.js';

export default async function handler(req, res) {
  if (req.method && req.method !== 'POST') return apiFail(res, 'METHOD_NOT_ALLOWED', 405);
  try {
    const body = await readBody(req);
    const pin = normalizePin(body?.pin, { min: 3, max: 12 });
    if (!pin) return apiFail(res, 'PIN_REQUIRED', 400);
    const supabase = createAdminClientOrThrow();
    const { data, error } = await supabase
      .from('users')
      .select('pin,name,role,is_active')
      .eq('pin', pin)
      .limit(1)
      .maybeSingle();
    if (error) return apiFail(res, error.message, 500);
    if (!data) return apiFail(res, 'PIN_NOT_FOUND', 404);
    if (data.is_active === false) return apiFail(res, 'PIN_DISABLED', 403);
    return apiOk(res, { user: { pin: String(data.pin), name: data.name || null, role: String(data.role || '').toUpperCase() || null } });
  } catch (error) {
    return apiFail(res, error, 500);
  }
}
