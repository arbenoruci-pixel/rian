import { STAFF_ADMIN_ROLES, staffRoleRank } from './roles.js';

const DEVICE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{5,119}$/;
const DEVICE_ACTIONS = new Set(['LIST_PENDING', 'APPROVE', 'REVOKE', 'REJECT']);
const DEVICE_FIELDS = [
  'id',
  'user_id',
  'device_id',
  'label',
  'is_approved',
  'requested_pin',
  'requested_role',
  'created_at',
  'approved_at',
  'approved_by',
].join(',');
const MIRROR_FIELDS = [
  'id',
  'pin',
  'role',
  'device_id',
  'label',
  'approved',
  'approved_by',
  'approved_at',
  'last_seen_at',
  'created_at',
].join(',');
const DEVICE_MANAGER_ROLES = new Set(STAFF_ADMIN_ROLES);

export class DeviceAdminError extends Error {
  constructor(code, status = 400, extra = {}) {
    super(String(code || 'DEVICE_ADMIN_REQUEST_FAILED'));
    this.name = 'DeviceAdminError';
    this.code = String(code || 'DEVICE_ADMIN_REQUEST_FAILED');
    this.httpStatus = Number(status) || 400;
    this.extra = extra && typeof extra === 'object' ? extra : {};
  }
}

function fail(code, status = 400, extra = {}) {
  throw new DeviceAdminError(code, status, extra);
}

export function normalizeDeviceAdminId(value) {
  const clean = String(value ?? '').trim();
  return DEVICE_ID_RE.test(clean) ? clean : '';
}

function normalizeUser(row) {
  if (!row) return null;
  return {
    id: row.id == null ? null : String(row.id),
    name: String(row.name || ''),
    pin: String(row.pin || ''),
    role: String(row.role || '').trim().toUpperCase(),
  };
}

function deviceView(row, user = null) {
  const linkedUser = normalizeUser(user) || {
    id: row?.user_id == null ? null : String(row.user_id),
    name: 'Përdorues i panjohur',
    pin: String(row?.requested_pin || ''),
    role: String(row?.requested_role || '').trim().toUpperCase(),
  };
  return {
    ...(row || {}),
    requested_pin: String(row?.requested_pin || linkedUser.pin || ''),
    requested_role: String(row?.requested_role || linkedUser.role || '').trim().toUpperCase(),
    tepiha_users: linkedUser,
  };
}

function assertManager(authUser) {
  if (!authUser?.id) fail('AUTH_REQUIRED', 401);
  const role = String(authUser.role || '').trim().toUpperCase();
  if (
    authUser.is_active === false
    || !DEVICE_MANAGER_ROLES.has(role)
    || staffRoleRank(role) < 0
  ) {
    fail('DEVICE_ADMIN_ACTOR_NOT_ALLOWED', 403);
  }
}

function assertTargetRoleAllowed(authUser, targetUser) {
  const actorRank = staffRoleRank(authUser?.role);
  const targetRank = staffRoleRank(targetUser?.role);
  if (actorRank < 0 || targetRank < 0 || targetRank > actorRank) {
    fail('DEVICE_ADMIN_TARGET_NOT_ALLOWED', 403);
  }
}

async function readPendingDevices(supabase, authUser) {
  const { data, error } = await supabase
    .from('tepiha_user_devices')
    .select(DEVICE_FIELDS)
    .eq('is_approved', false)
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) fail('DEVICE_PENDING_LIST_FAILED', 500);

  const rows = Array.isArray(data) ? data : [];
  if (!rows.length) return [];

  const userIds = [...new Set(
    rows.map((row) => String(row?.user_id || '').trim()).filter(Boolean),
  )];
  if (!userIds.length) return [];

  const { data: userData, error: userError } = await supabase
    .from('users')
    .select('id,name,pin,role')
    .in('id', userIds)
    .limit(Math.min(userIds.length, 200));
  if (userError) fail('DEVICE_PENDING_USERS_LOOKUP_FAILED', 500);

  const byId = new Map();
  for (const user of Array.isArray(userData) ? userData : []) {
    if (user?.id != null) byId.set(String(user.id), user);
  }

  const actorRank = staffRoleRank(authUser?.role);
  return rows.flatMap((row) => {
    const user = byId.get(String(row?.user_id ?? '')) || null;
    if (!user) return [];
    const targetRank = staffRoleRank(user.role);
    if (actorRank < 0 || targetRank < 0 || targetRank > actorRank) return [];
    return [deviceView(row, user)];
  });
}

async function readDevice(supabase, deviceId) {
  const { data, error } = await supabase
    .from('tepiha_user_devices')
    .select(DEVICE_FIELDS)
    .eq('device_id', deviceId)
    .maybeSingle();
  if (error) fail('DEVICE_LOOKUP_FAILED', 500);
  return data || null;
}

async function readTargetUser(supabase, target, { requireActive = true, requirePin = true } = {}) {
  const userId = String(target?.user_id || '').trim();
  if (!userId) fail('DEVICE_USER_LINK_MISSING', 409);

  const { data, error } = await supabase
    .from('users')
    .select('id,name,pin,role,is_active')
    .eq('id', userId)
    .maybeSingle();
  if (error) fail('DEVICE_USER_LOOKUP_FAILED', 500);
  if (!data) fail('DEVICE_USER_NOT_FOUND', 409);
  if (requireActive && data.is_active === false) fail('DEVICE_USER_DISABLED', 409);
  if (
    (requirePin && !String(data.pin || '').trim())
    || !String(data.role || '').trim()
  ) {
    fail('DEVICE_USER_IDENTITY_INVALID', 409);
  }
  return data;
}

async function readApprovalMirror(supabase, deviceId) {
  const { data, error } = await supabase
    .from('tepiha_device_approvals')
    .select(MIRROR_FIELDS)
    .eq('device_id', deviceId)
    .limit(2);
  if (error) fail('DEVICE_APPROVAL_MIRROR_LOOKUP_FAILED', 500);
  const rows = Array.isArray(data) ? data : [];
  if (rows.length > 1) fail('DEVICE_APPROVAL_MIRROR_CONFLICT', 409);
  return rows[0] || null;
}

function mirrorSnapshotPatch(snapshot) {
  const patch = {};
  for (const field of [
    'pin',
    'role',
    'device_id',
    'label',
    'approved',
    'approved_by',
    'approved_at',
    'last_seen_at',
  ]) {
    if (Object.prototype.hasOwnProperty.call(snapshot || {}, field)) patch[field] = snapshot[field];
  }
  return patch;
}

async function writeApprovedMirror(supabase, snapshot, { deviceId, user, authUser, approvedAt }) {
  const payload = {
    pin: String(user.pin),
    role: String(user.role).trim().toUpperCase(),
    device_id: deviceId,
    approved: true,
    approved_by: String(authUser.id),
    approved_at: approvedAt,
    last_seen_at: approvedAt,
  };

  let response;
  if (snapshot?.id) {
    response = await supabase
      .from('tepiha_device_approvals')
      .update(payload)
      .eq('id', snapshot.id)
      .eq('device_id', deviceId)
      .eq('pin', snapshot.pin)
      .eq('approved', snapshot.approved === true)
      .select(MIRROR_FIELDS)
      .maybeSingle();
  } else {
    response = await supabase
      .from('tepiha_device_approvals')
      .insert(payload)
      .select(MIRROR_FIELDS)
      .maybeSingle();
  }

  if (response?.error) fail('DEVICE_APPROVAL_MIRROR_UPDATE_FAILED', 500);
  const mirror = response?.data || null;
  if (
    !mirror
    || mirror.approved !== true
    || String(mirror.device_id || '') !== deviceId
    || String(mirror.pin || '') !== String(user.pin)
    || String(mirror.approved_by || '') !== String(authUser.id)
  ) {
    fail('DEVICE_APPROVAL_MIRROR_NOT_VERIFIED', 503);
  }
  return mirror;
}

async function restoreApprovalMirror(
  supabase,
  snapshot,
  writtenMirror,
  deviceId,
  { approvedAt, authUser, user } = {},
) {
  try {
    if (snapshot?.id) {
      const restorePatch = {
        ...mirrorSnapshotPatch(snapshot),
        approved: false,
        approved_by: null,
        approved_at: null,
      };
      const { error } = await supabase
        .from('tepiha_device_approvals')
        .update(restorePatch)
        .eq('id', snapshot.id)
        .eq('device_id', deviceId)
        .eq('approved', true)
        .eq('approved_by', String(authUser?.id || ''))
        .eq('approved_at', approvedAt)
        .select('id');
      if (error) return false;

      const { data: restored, error: verifyError } = await supabase
        .from('tepiha_device_approvals')
        .select('id,approved')
        .eq('id', snapshot.id)
        .maybeSingle();
      return !verifyError && !!restored && restored.approved === false;
    }

    let query = supabase
      .from('tepiha_device_approvals')
      .delete();
    if (writtenMirror?.id) query = query.eq('id', writtenMirror.id);
    else {
      query = query
        .eq('device_id', deviceId)
        .eq('pin', String(user?.pin || ''))
        .eq('approved', true)
        .eq('approved_by', String(authUser?.id || ''))
        .eq('approved_at', approvedAt);
    }
    const { error } = await query.select('id');
    if (error) return false;
    const { data: remaining, error: verifyError } = await supabase
      .from('tepiha_device_approvals')
      .select('id,approved,approved_by,approved_at')
      .eq('device_id', deviceId)
      .limit(10);
    return !verifyError
      && Array.isArray(remaining)
      && !remaining.some((row) => (
        row?.approved === true
        && String(row?.approved_by || '') === String(authUser?.id || '')
        && String(row?.approved_at || '') === String(approvedAt || '')
      ));
  } catch {
    return false;
  }
}

async function rollbackApprovedDevice(supabase, target, approvedAt, authUser) {
  try {
    const { data, error } = await supabase
      .from('tepiha_user_devices')
      .update({
        user_id: target.user_id,
        requested_pin: target.requested_pin ?? null,
        requested_role: target.requested_role ?? null,
        is_approved: false,
        approved_at: target.approved_at ?? null,
        approved_by: target.approved_by ?? null,
      })
      .eq('id', target.id)
      .eq('device_id', target.device_id)
      .eq('is_approved', true)
      .eq('approved_at', approvedAt)
      .eq('approved_by', String(authUser.id))
      .select(DEVICE_FIELDS)
      .maybeSingle();
    return !error
      && !!data
      && data.is_approved === false
      && String(data.id || '') === String(target.id)
      && String(data.device_id || '') === String(target.device_id);
  } catch {
    return false;
  }
}

async function ensureAuthoritativeApprovalAbsent(supabase, target, approvedAt, authUser) {
  try {
    const { data, error } = await supabase
      .from('tepiha_user_devices')
      .select(DEVICE_FIELDS)
      .eq('id', target.id)
      .eq('device_id', target.device_id)
      .maybeSingle();
    if (error) return false;
    if (!data) return true;
    if (data.is_approved === false) return true;
    if (
      data.is_approved === true
      && String(data.approved_at || '') === String(approvedAt || '')
      && String(data.approved_by || '') === String(authUser?.id || '')
    ) {
      return rollbackApprovedDevice(supabase, target, approvedAt, authUser);
    }
    return false;
  } catch {
    return false;
  }
}

async function approveDevice(supabase, deviceId, authUser) {
  const target = await readDevice(supabase, deviceId);
  if (!target) fail('DEVICE_NOT_FOUND', 404);
  if (target.is_approved !== false) fail('DEVICE_ALREADY_APPROVED', 409);
  if (!target.id) fail('DEVICE_IDENTITY_INVALID', 409);

  const user = await readTargetUser(supabase, target);
  assertTargetRoleAllowed(authUser, user);
  const approvedAt = new Date().toISOString();
  const mirrorSnapshot = await readApprovalMirror(supabase, deviceId);
  if (mirrorSnapshot?.approved === true) fail('DEVICE_APPROVAL_MIRROR_STATE_CONFLICT', 409);

  let writtenMirror = null;
  try {
    writtenMirror = await writeApprovedMirror(supabase, mirrorSnapshot, {
      deviceId,
      user,
      authUser,
      approvedAt,
    });
  } catch (mirrorError) {
    const mirrorRollbackVerified = await restoreApprovalMirror(
      supabase,
      mirrorSnapshot,
      writtenMirror,
      deviceId,
      { approvedAt, authUser, user },
    );
    if (!mirrorRollbackVerified) {
      fail('DEVICE_APPROVAL_MIRROR_ROLLBACK_NOT_VERIFIED', 503, {
        authoritative_approval_absent: true,
        mirror_rollback_verified: false,
      });
    }
    if (mirrorError instanceof DeviceAdminError) {
      fail(mirrorError.code, mirrorError.httpStatus, {
        authoritative_approval_absent: true,
        mirror_rollback_verified: true,
      });
    }
    fail('DEVICE_APPROVAL_MIRROR_UPDATE_FAILED', 500, {
      authoritative_approval_absent: true,
      mirror_rollback_verified: true,
    });
  }

  try {
    const currentUser = await readTargetUser(supabase, target);
    assertTargetRoleAllowed(authUser, currentUser);
    if (
      String(currentUser.id || '') !== String(user.id || '')
      || String(currentUser.pin || '') !== String(user.pin || '')
      || String(currentUser.role || '').trim().toUpperCase()
        !== String(user.role || '').trim().toUpperCase()
    ) {
      fail('DEVICE_USER_STATE_CHANGED', 409);
    }

    let update = supabase
      .from('tepiha_user_devices')
      .update({
        user_id: currentUser.id,
        requested_pin: String(currentUser.pin),
        requested_role: String(currentUser.role).trim().toUpperCase(),
        is_approved: true,
        approved_at: approvedAt,
        approved_by: String(authUser.id),
      })
      .eq('id', target.id)
      .eq('device_id', deviceId)
      .eq('is_approved', false)
      .eq('user_id', target.user_id);
    if (target.requested_pin != null) update = update.eq('requested_pin', target.requested_pin);
    if (target.requested_role != null) update = update.eq('requested_role', target.requested_role);

    const { data: approved, error: updateError } = await update
      .select(DEVICE_FIELDS)
      .maybeSingle();
    if (updateError) fail('DEVICE_APPROVAL_UPDATE_FAILED', 500);
    if (!approved) fail('DEVICE_APPROVAL_STATE_CHANGED', 409);
    if (
      approved.is_approved !== true
      || String(approved.id || '') !== String(target.id)
      || String(approved.device_id || '') !== deviceId
      || String(approved.user_id || '') !== String(currentUser.id)
      || String(approved.approved_by || '') !== String(authUser.id)
      || String(approved.approved_at || '') !== approvedAt
    ) {
      fail('DEVICE_APPROVAL_NOT_VERIFIED', 503);
    }
    return deviceView(approved, currentUser);
  } catch (approvalError) {
    const authoritativeRollbackVerified = await ensureAuthoritativeApprovalAbsent(
      supabase,
      target,
      approvedAt,
      authUser,
    );
    const mirrorRollbackVerified = await restoreApprovalMirror(
      supabase,
      mirrorSnapshot,
      writtenMirror,
      deviceId,
      { approvedAt, authUser, user },
    );
    if (!authoritativeRollbackVerified || !mirrorRollbackVerified) {
      fail('DEVICE_APPROVAL_ROLLBACK_NOT_VERIFIED', 503, {
        authoritative_rollback_verified: authoritativeRollbackVerified,
        mirror_rollback_verified: mirrorRollbackVerified,
      });
    }
    if (approvalError instanceof DeviceAdminError) {
      fail(approvalError.code, approvalError.httpStatus, {
        authoritative_rollback_verified: true,
        mirror_rollback_verified: true,
      });
    }
    fail('DEVICE_APPROVAL_UPDATE_FAILED', 500, {
      authoritative_rollback_verified: true,
      mirror_rollback_verified: true,
    });
  }
}

async function deleteApprovalMirror(supabase, deviceId) {
  const { error: deleteError } = await supabase
    .from('tepiha_device_approvals')
    .delete()
    .eq('device_id', deviceId)
    .select('id');
  if (deleteError) return false;

  const { data: remaining, error: verifyError } = await supabase
    .from('tepiha_device_approvals')
    .select('id')
    .eq('device_id', deviceId)
    .limit(1);
  return !verifyError && (!Array.isArray(remaining) || remaining.length === 0);
}

async function disableApprovalMirror(supabase, deviceId) {
  const { error: updateError } = await supabase
    .from('tepiha_device_approvals')
    .update({
      approved: false,
      approved_by: null,
      approved_at: null,
    })
    .eq('device_id', deviceId)
    .select('id');
  if (updateError) return false;

  const { data: remaining, error: verifyError } = await supabase
    .from('tepiha_device_approvals')
    .select('id,approved')
    .eq('device_id', deviceId)
    .limit(10);
  return !verifyError
    && Array.isArray(remaining)
    && remaining.every((row) => row?.approved === false);
}

async function revokeDevice(supabase, deviceId, action, authUser) {
  const target = await readDevice(supabase, deviceId);
  if (!target) fail('DEVICE_NOT_FOUND', 404);
  if (!target.id) fail('DEVICE_IDENTITY_INVALID', 409);

  const user = await readTargetUser(supabase, target, {
    requireActive: false,
    requirePin: false,
  });
  assertTargetRoleAllowed(authUser, user);

  if (action === 'REJECT') {
    if (target.is_approved !== false) fail('DEVICE_REJECT_REQUIRES_PENDING', 409);
    const { data: removed, error: deleteError } = await supabase
      .from('tepiha_user_devices')
      .delete()
      .eq('id', target.id)
      .eq('device_id', deviceId)
      .eq('is_approved', false)
      .select(DEVICE_FIELDS)
      .maybeSingle();
    if (deleteError) fail('DEVICE_REJECT_FAILED', 500);
    if (!removed) fail('DEVICE_REJECT_STATE_CHANGED', 409);

    const mirrorRemoved = await deleteApprovalMirror(supabase, deviceId);
    const device = {
      ...deviceView(removed, user),
      removed: true,
      revocation: 'PENDING_REQUEST_REJECTED',
      action,
    };
    if (!mirrorRemoved) {
      fail('DEVICE_REJECTED_MIRROR_CLEANUP_FAILED', 503, {
        authoritative_rejected: true,
        device,
      });
    }
    return device;
  }

  if (target.is_approved !== true) fail('DEVICE_REVOKE_REQUIRES_APPROVED', 409);
  const { data: revoked, error: revokeError } = await supabase
    .from('tepiha_user_devices')
    .update({
      is_approved: false,
      approved_by: null,
      approved_at: null,
    })
    .eq('id', target.id)
    .eq('device_id', deviceId)
    .eq('is_approved', true)
    .select(DEVICE_FIELDS)
    .maybeSingle();
  if (revokeError) fail('DEVICE_REVOKE_FAILED', 500);
  if (
    !revoked
    || revoked.is_approved !== false
    || String(revoked.id || '') !== String(target.id)
  ) {
    fail('DEVICE_REVOKE_STATE_CHANGED', 409);
  }

  const mirrorDisabled = await disableApprovalMirror(supabase, deviceId);
  const device = {
    ...deviceView(revoked, user),
    removed: false,
    revocation: 'APPROVED_DEVICE_REVOKED',
    action,
  };
  if (!mirrorDisabled) {
    fail('DEVICE_REVOKED_MIRROR_SYNC_FAILED', 503, {
      authoritative_revoked: true,
      device,
    });
  }
  return device;
}

export async function runDeviceAdminAction(bodyLike, { supabase, authUser } = {}) {
  if (!supabase) fail('SERVER_NOT_CONFIGURED', 500);
  assertManager(authUser);

  const body = bodyLike && typeof bodyLike === 'object' && !Array.isArray(bodyLike)
    ? bodyLike
    : {};
  const action = String(body.action || '').trim().toUpperCase();
  if (!DEVICE_ACTIONS.has(action)) fail('DEVICE_ACTION_INVALID', 400);

  if (action === 'LIST_PENDING') {
    return { devices: await readPendingDevices(supabase, authUser) };
  }

  const deviceId = normalizeDeviceAdminId(body.deviceId ?? body.device_id);
  if (!deviceId) fail('DEVICE_ID_INVALID', 400);

  if (action === 'APPROVE') {
    return { device: await approveDevice(supabase, deviceId, authUser) };
  }

  return { device: await revokeDevice(supabase, deviceId, action, authUser) };
}
