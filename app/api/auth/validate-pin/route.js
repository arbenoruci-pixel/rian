import { createAdminClientOrThrow } from '@/lib/supabaseAdminClient';
import { apiOk, apiFail, logApiError, readBody } from '@/lib/apiService';
import { normalizePin } from '@/lib/validation';
export const dynamic = 'force-dynamic';

export async function POST(req) {
  try {
    const body = await readBody(req);
    const pin = normalizePin(body?.pin, { min: 3, max: 12 });
    if (!pin) return apiFail('PIN_REQUIRED', 400);

    const supabase = createAdminClientOrThrow();
    let data = null;
    let error = null;
    const primary = await supabase
      .from('users')
      .select('pin,name,role,is_active')
      .eq('pin', pin)
      .limit(1)
      .maybeSingle();
    data = primary.data;
    error = primary.error;
    if (error && String(error.message || '').toLowerCase().includes('is_active')) {
      const fallback = await supabase
        .from('users')
        .select('pin,name,role')
        .eq('pin', pin)
        .limit(1)
        .maybeSingle();
      data = fallback.data;
      error = fallback.error;
    }

    if (error) return apiFail(error.message, 500);
    if (!data) return apiFail('PIN_NOT_FOUND', 404);
    if (Object.prototype.hasOwnProperty.call(data, 'is_active') && data.is_active === false) return apiFail('PIN_DISABLED', 403);

    return apiOk({ user: { pin: String(data.pin), name: data.name || null, role: String(data.role || '').toUpperCase() || null } });
  } catch (e) {
    logApiError('api.auth.validate-pin', e);
    return apiFail(String(e?.message || e), 500);
  }
}
