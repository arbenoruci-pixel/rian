import { createHash } from 'node:crypto';

export class TransportPushError extends Error {
  constructor(code, httpStatus = 400) { super(code); this.code = code; this.httpStatus = httpStatus; }
}
const fail = (code, status) => { throw new TransportPushError(code, status); };
export function validatePushSubscription(value) {
  let url;
  try { url = new URL(value?.endpoint); } catch { fail('PUSH_SUBSCRIPTION_INVALID'); }
  const host = url.hostname;
  const allowed = host === 'fcm.googleapis.com' || host === 'updates.push.services.mozilla.com'
    || /^[a-z0-9-]+\.push\.apple\.com$/.test(host)
    || /^[a-z0-9-]+\.notify\.windows\.com$/.test(host);
  if (!allowed || url.protocol !== 'https:' || url.port || url.username || url.password || url.hash
    || url.href.length > 2048) fail('PUSH_ENDPOINT_INVALID');
  const key = (name, size) => {
    const raw = value?.keys?.[name];
    if (typeof raw !== 'string' || !/^[A-Za-z0-9_-]+={0,2}$/.test(raw)
      || Buffer.from(raw, 'base64url').length !== size) fail('PUSH_SUBSCRIPTION_INVALID');
    return raw;
  };
  const keys = { p256dh: key('p256dh', 65), auth: key('auth', 16) };
  if (Buffer.from(keys.p256dh, 'base64url')[0] !== 4) fail('PUSH_SUBSCRIPTION_INVALID');
  return { endpoint: url.href, keys };
}

export async function authenticatePushActor(supabase, deviceId) {
  if (!deviceId || deviceId.length > 120) fail('AUTH_REQUIRED', 401);
  const { data: device, error } = await supabase.from('tepiha_user_devices')
    .select('user_id,is_approved').eq('device_id', deviceId).maybeSingle();
  if (error) fail('AUTH_DEVICE_LOOKUP_FAILED', 503);
  if (!device?.user_id || device.is_approved !== true) fail('DEVICE_NOT_APPROVED', 403);
  const result = await supabase.from('users').select('id,role,is_active,is_hybrid_transport').eq('id', device.user_id).maybeSingle();
  if (result.error) fail('AUTH_USER_LOOKUP_FAILED', 503);
  const user = result.data;
  if (!user || user.is_active === false) fail('AUTH_USER_DISABLED', 403);
  return { ...user, deviceId };
}

export async function pushAction(body, { supabase, actor }) {
  if (!actor?.id || String(body.expectedActorId || '') !== actor.id) fail('PUSH_SESSION_CHANGED', 403);
  const action = String(body.action || '').toUpperCase();
  // DISABLE also works after a role change. Every mutation is bound to the
  // approved device cookie and server-resolved user, never a caller's user ID.
  if (action !== 'DISABLE' && actor.role !== 'TRANSPORT' && actor.is_hybrid_transport !== true) fail('PUSH_DRIVER_REQUIRED', 403);
  if (action === 'OPEN') {
    if (!/^[0-9a-f-]{36}$/i.test(body.orderId || '')) fail('PUSH_ORDER_INVALID');
    const { data: order, error } = await supabase.from('transport_orders').select('id,transport_id,status,data').eq('id', body.orderId).maybeSingle();
    if (error) fail('PUSH_OPEN_FAILED', 503);
    const assigned = order?.transport_id || order?.data?.assigned_driver_id;
    if (!order || assigned !== actor.id || ['cancelled','canceled','done','delivered','archived','deleted','void'].includes(String(order.status).toLowerCase())) fail('PUSH_ORDER_CHANGED', 409);
    return { href: `/transport/item?id=${encodeURIComponent(order.id)}` };
  }
  const input = { p_action: action, p_user_id: actor.id, p_device_id: actor.deviceId };
  if (action === 'SUBSCRIBE') {
    input.p_subscription = validatePushSubscription(body.subscription);
    input.p_endpoint_hash = createHash('sha256').update(input.p_subscription.endpoint).digest('hex');
  }
  if (!['STATUS', 'SUBSCRIBE', 'DISABLE', 'TEST'].includes(action)) fail('PUSH_ACTION_INVALID');
  const { data, error } = await supabase.rpc('transport_push_manage_v1', input);
  if (error) fail(/^PUSH_[A-Z_]+$/.test(error.message || '') ? error.message : 'PUSH_SAVE_FAILED', 503);
  return data;
}
