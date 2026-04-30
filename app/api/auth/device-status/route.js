import { createServiceClientOrThrow, apiOk, apiFail, logApiError, readBody } from '@/lib/apiService';
import { normalizeDeviceId, normalizePin, normalizeRole } from '@/lib/validation';
export const dynamic = 'force-dynamic';

export async function POST(req) {
  try {
    const body = await readBody(req);
    const pin = normalizePin(body?.pin, { min: 3, max: 12 });
    const role = normalizeRole(body?.role);
    const device_id = normalizeDeviceId(body?.deviceId || body?.device_id);

    if (!pin || !device_id) {
      return apiFail('MISSING_FIELDS', 400);
    }

    const supabase = createServiceClientOrThrow();

    const { data: user, error: uerr } = await supabase
      .from('users')
      .select('id, pin, role, name, is_active')
      .eq('pin', pin)
      .maybeSingle();

    if (uerr) return apiFail(uerr.message, 500);
    if (!user) return apiFail('PIN_NOT_FOUND', 404);
    if (user.is_active === false) return apiFail('USER_DISABLED', 403);

    const userRole = String(user.role || '').toUpperCase();
    if (role && role !== userRole) return apiFail('ROLE_MISMATCH', 403);

    const { data: dev, error: derr } = await supabase
      .from('tepiha_user_devices')
      .select('id, is_approved')
      .eq('user_id', user.id)
      .eq('device_id', device_id)
      .maybeSingle();

    if (derr) return apiFail(derr.message, 500);

    const approved = userRole === 'ADMIN' ? true : !!dev?.is_approved;
    return apiOk({ approved, actor: { pin: user.pin, role: userRole, name: user.name || '', user_id: user.id, device_id } });
  } catch (e) {
    logApiError('api.auth.device-status', e);
    return apiFail(String(e?.message || e), 500);
  }
}
