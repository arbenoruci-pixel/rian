import { createAdminClientOrThrow } from '@/lib/supabaseAdminClient';
import { apiOk, apiFail, logApiError, readBody } from '@/lib/apiService';
import { normalizePin } from '@/lib/validation';
export const dynamic = 'force-dynamic';

export async function POST(req) {
  try {
    const body = await readBody(req);
    const pin = normalizePin(body?.pin, { min: 4, max: 8, digitsOnly: true });
    if (!pin) return apiFail('INVALID_PIN', 400);

    const supabase = createAdminClientOrThrow();
    const { data, error } = await supabase
      .from('tepiha_users')
      .select('pin, role, name')
      .eq('pin', pin)
      .limit(1);

    if (error) return apiFail(error.message, 500);
    const user = Array.isArray(data) && data.length ? data[0] : null;
    if (!user) return apiFail('PIN_NOT_FOUND', 404);

    return apiOk({ user: { pin: user.pin, role: String(user.role || '').toUpperCase(), name: user.name } });
  } catch (err) {
    logApiError('api.auth.pin', err);
    return apiFail(String(err?.message || err), 500);
  }
}
