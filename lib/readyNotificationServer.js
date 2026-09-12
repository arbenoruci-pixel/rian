import { ClientProfileError } from './clientProfileServer.js';
import { canTrackReadyNotifications } from './roles.js';
import { isReadyNotificationOrderId } from './readyNotificationModel.js';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail = (message, status = 400) => { throw new ClientProfileError(message, status); };
export function normalizeReadyNotification(body, actor) {
  if (!actor?.id) fail('AUTH_REQUIRED', 401);
  if (!canTrackReadyNotifications(actor.role)) fail('READY_NOTIFICATION_ROLE_DENIED', 403);
  if (body.actor_id !== actor.id) fail('ACTOR_SESSION_MISMATCH', 403);
  if (!uuid.test(body.id || '') || !uuid.test(body.attempt_id || '')) fail('READY_NOTIFICATION_ID_INVALID');
  const orderId = String(body.order_id || '');
  if (!isReadyNotificationOrderId(orderId)) fail('READY_NOTIFICATION_ORDER_INVALID');
  if (!['sms','whatsapp','viber'].includes(body.channel) || !['opened','confirmed','cancelled'].includes(body.kind)) fail('READY_NOTIFICATION_EVENT_INVALID');
  const time = Date.parse(body.occurred_at);
  if (!Number.isFinite(time)) fail('READY_NOTIFICATION_TIME_INVALID');
  return { id: body.id, attempt_id: body.attempt_id, order_id: orderId, actor_id: actor.id,
    author_name: actor.name || actor.role, channel: body.channel, kind: body.kind, occurred_at: new Date(time).toISOString() };
}
export async function readyNotificationServer(body, { supabase, authUser }) {
  if (!authUser?.id) fail('AUTH_REQUIRED', 401);
  if (!canTrackReadyNotifications(authUser.role)) fail('READY_NOTIFICATION_ROLE_DENIED', 403);
  const table = () => supabase.from('ready_notification_events');
  if (body.action === 'GET_READY_NOTIFICATIONS') {
    const ids = [...new Set((Array.isArray(body.order_ids) ? body.order_ids : []).map(String))];
    if (!ids.length || ids.length > 100 || ids.some(id => !isReadyNotificationOrderId(id))) fail('READY_NOTIFICATION_ORDER_INVALID');
    const { data, error } = await table().select('*').in('order_id', ids).order('created_at', { ascending: false }).limit(2000);
    if (error) fail('READY_NOTIFICATION_READ_FAILED', 503);
    return { events: data || [], truncated: data?.length === 2000 };
  }
  if (body.action !== 'ADD_READY_NOTIFICATION') fail('READY_NOTIFICATION_ACTION_INVALID');
  const entry = normalizeReadyNotification(body, authUser);
  // Only the authenticated worker can attest to this attempt. Offline replay
  // can arrive after pickup, so require an existing base order, not live GATI.
  const order = await supabase.from('orders').select('id').eq('id', entry.order_id).maybeSingle();
  if (order.error) fail('READY_NOTIFICATION_ORDER_LOOKUP_FAILED', 503);
  if (!order.data) fail('READY_NOTIFICATION_ORDER_NOT_FOUND', 404);
  if (entry.kind !== 'opened') {
    const attempt = await table().select('id').eq('attempt_id', entry.attempt_id).eq('order_id', entry.order_id)
      .eq('actor_id', entry.actor_id).eq('channel', entry.channel).eq('kind', 'opened').limit(1);
    if (attempt.error) fail('READY_NOTIFICATION_READ_FAILED', 503);
    if (!attempt.data?.length) fail('READY_NOTIFICATION_ATTEMPT_PENDING', 409);
  }
  const saved = await table().insert(entry).select('*').single();
  if (saved.error?.code === '23505') {
    const previous = await table().select('*').eq('id', entry.id).maybeSingle();
    const keys = ['id','attempt_id','order_id','actor_id','channel','kind'];
    if (previous.error || !previous.data || keys.some(key => String(previous.data[key]) !== String(entry[key]))
      || Date.parse(previous.data.occurred_at) !== Date.parse(entry.occurred_at)) fail('READY_NOTIFICATION_RETRY_CONFLICT', 409);
    return { event: previous.data };
  }
  if (saved.error || !saved.data) fail('READY_NOTIFICATION_SAVE_FAILED', 503);
  return { event: saved.data };
}
