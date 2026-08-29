function sameIdentity(left, right) {
  const a = String(left || '').trim();
  const b = String(right || '').trim();
  return !!a && !!b && a === b;
}

// Login may retain trust that was explicitly granted to this exact
// user/device row. A role (including an administrator role) never grants
// device trust by itself.
export function getExistingDeviceApproval(device, userId) {
  const approved = !!device?.id
    && sameIdentity(device?.user_id, userId)
    && device?.is_approved === true;

  return Object.freeze({
    approved,
    approvedAt: approved ? (device?.approved_at || null) : null,
    approvedBy: approved ? (device?.approved_by || null) : null,
  });
}

export function isDeviceLinkedToOtherUser(device, userId) {
  return !!device?.id
    && !!String(device?.user_id || '').trim()
    && !sameIdentity(device.user_id, userId);
}
