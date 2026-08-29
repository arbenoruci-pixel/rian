import { createServiceClientOrThrow, apiOk, apiFail, logApiError, readBody } from '@/lib/apiService';
import { normalizeDeviceId, normalizePin, normalizeRole } from '@/lib/validation';
import { getExistingDeviceApproval, isDeviceLinkedToOtherUser } from '@/lib/authDeviceApproval';
import { isRetiredStaffPin } from '@/lib/staffIdentityAliases';
export const dynamic = 'force-dynamic';

function attachDeviceCookie(res, device_id) {
  const value = String(device_id || '').trim();
  if (!value) return res;
  try {
    if (res?.cookies?.set) {
      res.cookies.set('tepiha_device_id', value, {
        path: '/',
        maxAge: 60 * 60 * 24 * 365,
        sameSite: 'lax',
        httpOnly: false,
      });
    } else if (res?.headers?.append) {
      res.headers.append(
        'set-cookie',
        `tepiha_device_id=${encodeURIComponent(value)}; Path=/; Max-Age=${60 * 60 * 24 * 365}; SameSite=Lax`,
      );
    }
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
      return apiFail('MISSING_FIELDS', 400);
    }
    if (isRetiredStaffPin(pin)) {
      return apiFail('PIN_RETIRED_USE_CURRENT_PIN', 401);
    }

    const supabase = createServiceClientOrThrow();

    const { data: user, error: uerr } = await supabase
      .from('users')
      .select('id, pin, role, name, is_active, is_hybrid_transport')
      .eq('pin', pin)
      .maybeSingle();

    if (uerr) return apiFail(uerr.message, 500);
    if (!user) return apiFail('PIN GABIM OSE NUK EKZISTON', 401);
    if (user.is_active === false) return apiFail('USER_DISABLED', 403);

    const { data: dev, error: derr } = await supabase
      .from('tepiha_user_devices')
      .select('id, is_approved, user_id, approved_at, approved_by')
      .eq('device_id', device_id)
      .maybeSingle();

    if (derr) return apiFail(derr.message, 500);

    const userRole = String(user.role || '').toUpperCase();

    // A physical browser/device stays bound to its existing user. Trying a
    // different PIN must never reassign or downgrade that row.
    if (isDeviceLinkedToOtherUser(dev, user.id)) {
      return apiFail('DEVICE_LINKED_TO_OTHER_USER', 409, { deviceId: device_id });
    }

    if (requested_role && !rolesCompatible(requested_role, userRole)) {
      return apiFail('ROLE_MISMATCH', 403);
    }

    const requestedRoleForRow = requested_role || userRole;
    const existingApproval = getExistingDeviceApproval(dev, user.id);
    const isCurrentlyApproved = existingApproval.approved;

    async function syncApprovalMirror(approval) {
      const basePayload = {
        pin: user.pin,
        role: requestedRoleForRow,
        device_id,
        approved: approval.approved,
        approved_by: approval.approvedBy,
        approved_at: approval.approvedAt,
        last_seen_at: new Date().toISOString(),
      };

      const { data: mirror, error: mirrorLookupError } = await supabase
        .from('tepiha_device_approvals')
        .select('id')
        .eq('device_id', device_id)
        .maybeSingle();
      if (mirrorLookupError) throw mirrorLookupError;

      if (mirror?.id) {
        const { error: mirrorUpdateError } = await supabase
          .from('tepiha_device_approvals')
          .update(basePayload)
          .eq('id', mirror.id);
        if (mirrorUpdateError) throw mirrorUpdateError;
      } else {
        const { error: mirrorInsertError } = await supabase
          .from('tepiha_device_approvals')
          .insert(basePayload);
        if (mirrorInsertError) throw mirrorInsertError;
      }
    }

    const devicePayload = {
      user_id: user.id,
      device_id,
      is_approved: isCurrentlyApproved,
      requested_pin: user.pin,
      requested_role: requestedRoleForRow,
      approved_at: existingApproval.approvedAt,
      approved_by: existingApproval.approvedBy,
    };

    // Mirror first, authoritative row last. A mirror failure can never create
    // or elevate an authoritative device approval.
    await syncApprovalMirror(existingApproval);

    if (dev?.id) {
      const { error: upErr } = await supabase.from('tepiha_user_devices').update(devicePayload).eq('id', dev.id);
      if (upErr) return apiFail(upErr.message, 500);
    } else {
      const { error: insErr } = await supabase.from('tepiha_user_devices').insert(devicePayload);
      if (insErr) return apiFail(insErr.message, 500);
    }

    if (!isCurrentlyApproved) {
      return apiFail('DEVICE_NOT_APPROVED', 403, { deviceId: device_id });
    }

    return attachDeviceCookie(apiOk({ actor: { pin: user.pin, role: userRole, name: user.name || '', user_id: user.id, device_id, is_hybrid_transport: user.is_hybrid_transport === true } }), device_id);
  } catch (e) {
    logApiError('api.auth.login', e, { device_id });
    return apiFail(String(e?.message || e), 500);
  }
}
