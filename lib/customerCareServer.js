import { canManageCustomerCare, canUseCustomerCare } from './roles.js';
import { ClientProfileError } from './clientProfileServer.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const clean = (v) => String(v ?? '').trim();
const fail = (code, status = 400) => { throw new ClientProfileError(code, status); };

export function normalizeCustomerFeedback(body, { clientId, orderId, actor, canManage }) {
  if (!UUID.test(clean(body.id))) fail('CUSTOMER_FEEDBACK_ID_INVALID');
  const rating = body.rating == null || body.rating === '' ? null : Number(body.rating);
  if (rating !== null && (!Number.isInteger(rating) || rating < 1 || rating > 5)) fail('CUSTOMER_RATING_INVALID');
  const note = clean(body.note);
  if (note.length > 2000) fail('CUSTOMER_NOTE_TOO_LONG');
  const issue = clean(body.issue) || null;
  if (issue && !['PAYMENT', 'NO_SHOW', 'ACCESS', 'OTHER'].includes(issue)) fail('CUSTOMER_ISSUE_INVALID');
  if (body.noPickup != null && (typeof body.noPickup !== 'boolean' || !canManage)) fail('CUSTOMER_FLAG_NOT_ALLOWED', 403);
  const noPickup = body.noPickup ?? null;
  if (noPickup === true && !note) fail('CUSTOMER_FLAG_REASON_REQUIRED');
  if (rating === null && !note && !issue && noPickup === null) fail('CUSTOMER_FEEDBACK_EMPTY');
  return { id: clean(body.id), client_id: clientId, order_id: orderId || null, rating, note, issue,
    no_pickup: noPickup, created_by: actor.id, author_name: actor.name || actor.role, author_role: actor.role };
}

export async function customerCareServer(body, { supabase, authUser }) {
  if (!authUser?.id) fail('AUTH_REQUIRED', 401);
  const role = clean(authUser.role).toUpperCase();
  const canManage = canManageCustomerCare(role);
  if (!canUseCustomerCare(role, 'role-check')) fail('CUSTOMER_FEEDBACK_FORBIDDEN', 403);
  if (!['GET_CUSTOMER_CARE', 'ADD_CUSTOMER_FEEDBACK'].includes(body.action)) fail('CUSTOMER_FEEDBACK_ACTION_INVALID');
  let clientId = clean(body.clientId);
  const orderId = clean(body.orderId);
  if (orderId) {
    if (!UUID.test(orderId)) fail('CUSTOMER_ORDER_INVALID');
    const { data: order, error } = await supabase.from('transport_orders').select('id,client_id,transport_id,data').eq('id', orderId).maybeSingle();
    if (error) fail('CUSTOMER_ORDER_LOOKUP_FAILED', 503);
    if (!order?.client_id) fail('CUSTOMER_ORDER_NOT_FOUND', 404);
    if (clientId && clientId !== order.client_id) fail('CUSTOMER_IDENTITY_CONFLICT', 409);
    clientId = order.client_id;
    if (!canManage) {
      const d = order.data || {};
      const ids = [order.transport_id, d.transport_id, d.transport_user_id, d.assigned_driver_id];
      let owned = ids.includes(authUser.id);
      if (!owned) {
        const { data: user, error: userError } = await supabase.from('users').select('pin').eq('id', authUser.id).maybeSingle();
        if (userError) fail('CUSTOMER_OWNER_LOOKUP_FAILED', 503);
        owned = !!user?.pin && [d.transport_pin, d.driver_pin].map(clean).includes(clean(user.pin));
      }
      if (!owned) fail('CUSTOMER_ORDER_NOT_ASSIGNED', 403);
    }
  } else if (!canManage) fail('CUSTOMER_ORDER_REQUIRED', 403);
  if (!UUID.test(clientId)) fail('CUSTOMER_ID_REQUIRED');
  const { data: client, error } = await supabase.from('transport_clients').select('id,notes').eq('id', clientId).maybeSingle();
  if (error) fail('CUSTOMER_LOOKUP_FAILED', 503);
  if (!client) fail('CUSTOMER_NOT_FOUND', 404);
  if (body.action === 'ADD_CUSTOMER_FEEDBACK') {
    const entry = normalizeCustomerFeedback(body, { clientId, orderId, actor: authUser, canManage });
    const saved = await supabase.from('transport_customer_feedback').insert(entry).select('*').single();
    if (saved.error?.code === '23505') {
      const prior = await supabase.from('transport_customer_feedback').select('*').eq('id', entry.id).maybeSingle();
      if (prior.error || !prior.data || Object.keys(entry).some((key) => entry[key] !== prior.data[key])) fail('CUSTOMER_FEEDBACK_RETRY_CONFLICT', 409);
      return { ok: true, entry: prior.data, duplicate: true };
    }
    if (saved.error || !saved.data) fail('CUSTOMER_FEEDBACK_SAVE_FAILED', 503);
    return { ok: true, entry: saved.data };
  }
  const [recent, flag] = await Promise.all([
    supabase.from('transport_customer_feedback').select('*').eq('client_id', clientId).order('created_at', { ascending: false }).limit(30),
    supabase.from('transport_customer_feedback').select('no_pickup,note,created_at,author_name').eq('client_id', clientId).not('no_pickup', 'is', null).order('created_at', { ascending: false }).limit(1),
  ]);
  if (recent.error || flag.error) fail('CUSTOMER_FEEDBACK_LOAD_FAILED', 503);
  return { ok: true, clientId, canManage, legacyNotes: client.notes || '', entries: recent.data || [], flag: flag.data?.[0] || null };
}
