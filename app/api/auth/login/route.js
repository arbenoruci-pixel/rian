import { createServiceClientOrThrow, apiOk, apiFail, logApiError, readBody } from '@/lib/apiService';
import { normalizeDeviceId, normalizePin, normalizeRole } from '@/lib/validation';
export const dynamic = 'force-dynamic';

function attachDeviceCookie(res, device_id) {
  try {
    res.cookies.set('tepiha_device_id', String(device_id || ''), {
      path: '/',
      maxAge: 60 * 60 * 24 * 365,
      sameSite: 'lax',
      httpOnly: false,
    });
  } catch {}
  return res;
}


function rolesCompatible(requestedRole, userRole) {
  const req = String(requestedRole || '').toUpperCase();
  const actual = String(userRole || '').toUpperCase();
  if (!req || !actual) return false;
  if (req === actual) return true;
  const adminPair = new Set(['ADMIN', 'ADMIN_MASTER']);
  return adminPair.has(req) && adminPair.has(actual);
}
export async function POST(req) {
  let device_id = '';
  try {
    const body = await readBody(req);
    const pin = normalizePin(body?.pin, { min: 3, max: 12 });
    const requested_role = normalizeRole(body?.role);
    device_id = normalizeDeviceId(body?.deviceId || body?.device_id) || '';

    if (!pin || !device_id) {
      return attachDeviceCookie(apiFail('MISSING_FIELDS', 400), device_id);
    }

    const supabase = createServiceClientOrThrow();

    const { data: user, error: uerr } = await supabase
      .from('users')
      .select('id, pin, role, name, is_active, is_hybrid_transport')
      .eq('pin', pin)
      .maybeSingle();

    if (uerr) return attachDeviceCookie(apiFail(uerr.message, 500), device_id);
    if (!user) return attachDeviceCookie(apiFail('PIN GABIM OSE NUK EKZISTON', 401), device_id);
    if (user.is_active === false) return attachDeviceCookie(apiFail('USER_DISABLED', 403), device_id);

    const { data: dev, error: derr } = await supabase
      .from('tepiha_user_devices')
      .select('id, is_approved, user_id')
      .eq('device_id', device_id)
      .maybeSingle();

    if (derr) return attachDeviceCookie(apiFail(derr.message, 500), device_id);

    const userRole = String(user.role || '').toUpperCase();
    const isAdmin = ['ADMIN', 'ADMIN_MASTER', 'OWNER', 'PRONAR', 'SUPERADMIN'].includes(userRole);

    if (requested_role && !rolesCompatible(requested_role, userRole)) {
      return attachDeviceCookie(apiFail('ROLE_MISMATCH', 403), device_id);
    }

    const requestedRoleForRow = requested_role || userRole;
    const isCurrentlyApproved = dev && dev.user_id === user.id ? !!dev.is_approved : !!isAdmin;

    async function syncApprovalMirror(approvedFlag) {
      const basePayload = {
        pin: user.pin,
        role: requestedRoleForRow,
        device_id,
        approved: !!approvedFlag,
        approved_by: approvedFlag ? 'SYSTEM' : null,
        approved_at: approvedFlag ? new Date().toISOString() : null,
        last_seen_at: new Date().toISOString(),
      };

      const { data: mirror } = await supabase
        .from('tepiha_device_approvals')
        .select('id')
        .eq('device_id', device_id)
        .maybeSingle();

      if (mirror?.id) {
        await supabase.from('tepiha_device_approvals').update(basePayload).eq('id', mirror.id);
      } else {
        await supabase.from('tepiha_device_approvals').insert(basePayload);
      }
    }

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
      if (upErr) return attachDeviceCookie(apiFail(upErr.message, 500), device_id);
    } else {
      const { error: insErr } = await supabase.from('tepiha_user_devices').insert(devicePayload);
      if (insErr) return attachDeviceCookie(apiFail(insErr.message, 500), device_id);
    }

    await syncApprovalMirror(isCurrentlyApproved);

    if (!isCurrentlyApproved) {
      return attachDeviceCookie(apiFail('DEVICE_NOT_APPROVED', 403, { deviceId: device_id }), device_id);
    }

    return attachDeviceCookie(apiOk({ actor: { pin: user.pin, role: userRole, name: user.name || '', user_id: user.id, device_id, is_hybrid_transport: user.is_hybrid_transport === true } }), device_id);
  } catch (e) {
    logApiError('api.auth.login', e, { device_id });
    return attachDeviceCookie(apiFail(String(e?.message || e), 500), device_id);
  }
}
