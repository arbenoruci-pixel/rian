import { apiFail, apiOk, createAdminClientOrThrow, normalizeDeviceId, normalizePin, normalizeRole, setClientCookie, readBody } from '../_helpers.js';
import { canAutoApproveDevice, rolesCompatible } from '../../lib/roles.js';


export default async function handler(req, res) {
  if (req.method && req.method !== 'POST') return apiFail(res, 'METHOD_NOT_ALLOWED', 405);
  let device_id = '';
  try {
    const body = await readBody(req);
    const pin = normalizePin(body?.pin, { min: 3, max: 12 });
    const requested_role = normalizeRole(body?.role);
    device_id = normalizeDeviceId(body?.deviceId || body?.device_id);
    if (!pin || !device_id) return apiFail(res, 'MISSING_FIELDS', 400);

    const supabase = createAdminClientOrThrow();
    const { data: user, error: uerr } = await supabase
      .from('users')
      .select('id, pin, role, name, is_active, is_hybrid_transport')
      .eq('pin', pin)
      .maybeSingle();
    if (uerr) return apiFail(res, uerr.message, 500);
    if (!user) return apiFail(res, 'PIN GABIM OSE NUK EKZISTON', 401);
    if (user.is_active === false) return apiFail(res, 'USER_DISABLED', 403);

    const { data: dev, error: derr } = await supabase
      .from('tepiha_user_devices')
      .select('id, is_approved, user_id')
      .eq('device_id', device_id)
      .maybeSingle();
    if (derr) return apiFail(res, derr.message, 500);

    const userRole = String(user.role || '').toUpperCase();
    const isAdmin = canAutoApproveDevice(userRole);
    if (requested_role && !rolesCompatible(requested_role, userRole) && requested_role !== userRole) {
      return apiFail(res, 'ROLE_MISMATCH', 403);
    }

    const requestedRoleForRow = requested_role || userRole;
    const isCurrentlyApproved = dev && dev.user_id === user.id ? !!dev.is_approved : !!isAdmin;

    const devicePayload = {
      user_id: user.id,
      device_id,
      is_approved: isCurrentlyApproved,
      requested_pin: user.pin,
      requested_role: requestedRoleForRow,
      approved_at: isCurrentlyApproved ? new Date().toISOString() : null,
      approved_by: isCurrentlyApproved ? 'SYSTEM' : null,
    };

    if (dev?.id) {
      const { error: upErr } = await supabase.from('tepiha_user_devices').update(devicePayload).eq('id', dev.id);
      if (upErr) return apiFail(res, upErr.message, 500);
    } else {
      const { error: insErr } = await supabase.from('tepiha_user_devices').insert(devicePayload);
      if (insErr) return apiFail(res, insErr.message, 500);
    }

    if (!isCurrentlyApproved) return apiFail(res, 'DEVICE_NOT_APPROVED', 403, { deviceId: device_id });

    setClientCookie(res, 'tepiha_device_id', device_id);
    return apiOk(res, {
      actor: {
        pin: user.pin,
        role: userRole,
        name: user.name || '',
        user_id: user.id,
        device_id,
        is_hybrid_transport: user.is_hybrid_transport === true,
      },
    });
  } catch (error) {
    return apiFail(res, error, 500);
  }
}
