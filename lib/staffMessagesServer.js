import { ADMIN_ROLES } from './roles.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEND_ROLES = new Set([...ADMIN_ROLES, 'MASTER', 'MASTER USER', 'MASTER_USER', 'MASTERUSER']);
const RECIPIENT_ROLES = new Set(['PUNTOR', 'PUNETOR', 'WORKER', 'BAZIST', 'BASE', 'TRANSPORT', 'DISPATCH']);
const STAFF_ROLES = new Set([...SEND_ROLES, ...RECIPIENT_ROLES]);
const upper = value => String(value || '').trim().toUpperCase();
const KNOWN_ERRORS = new Set([
  'STAFF_MESSAGE_FORBIDDEN', 'STAFF_MESSAGE_RECIPIENT_INVALID', 'STAFF_MESSAGE_BODY_INVALID',
  'STAFF_MESSAGE_IDEMPOTENCY_CONFLICT', 'STAFF_MESSAGE_RATE_LIMIT', 'STAFF_MESSAGE_NOT_FOUND',
]);

export class StaffMessagesError extends Error {
  constructor(code, httpStatus = 400) {
    super(code);
    this.code = code;
    this.httpStatus = httpStatus;
  }
}
const fail = (code, status = 400) => { throw new StaffMessagesError(code, status); };
export const canSendStaffMessages = role => SEND_ROLES.has(upper(role));

export async function authenticateStaffMessagesActor(supabase, deviceId) {
  if (typeof deviceId !== 'string' || !deviceId || deviceId.length > 120) fail('AUTH_REQUIRED', 401);
  const { data: device, error: deviceError } = await supabase.from('tepiha_user_devices')
    .select('user_id,is_approved').eq('device_id', deviceId).maybeSingle();
  if (deviceError) fail('STAFF_MESSAGE_AUTH_FAILED', 503);
  if (!device?.user_id || device.is_approved !== true) fail('DEVICE_NOT_APPROVED', 403);
  const { data: actor, error } = await supabase.from('users')
    .select('id,name,role,is_active').eq('id', device.user_id).maybeSingle();
  if (error) fail('STAFF_MESSAGE_AUTH_FAILED', 503);
  if (!actor?.id || actor.is_active !== true || !STAFF_ROLES.has(upper(actor.role))) fail('STAFF_MESSAGE_FORBIDDEN', 403);
  return actor;
}

async function rpc(supabase, name, args) {
  const { data, error } = await supabase.rpc(name, args);
  if (error) {
    const code = [...KNOWN_ERRORS].find(item => String(error.message || '').includes(item));
    if (code) fail(code, code === 'STAFF_MESSAGE_FORBIDDEN' ? 403 : code === 'STAFF_MESSAGE_NOT_FOUND' ? 404 : code === 'STAFF_MESSAGE_RATE_LIMIT' ? 429 : code === 'STAFF_MESSAGE_IDEMPOTENCY_CONFLICT' ? 409 : 400);
    fail('STAFF_MESSAGE_REQUEST_FAILED', 503);
  }
  if (!data || typeof data !== 'object') fail('STAFF_MESSAGE_REQUEST_FAILED', 503);
  return data;
}

async function readRecipients(supabase, actor) {
  if (!canSendStaffMessages(actor.role)) fail('STAFF_MESSAGE_FORBIDDEN', 403);
  const { data, error } = await supabase.from('users')
    .select('id,name,role,is_active').eq('is_active', true).order('name').limit(251);
  if (error || !Array.isArray(data) || data.length > 250) fail('STAFF_MESSAGE_RECIPIENTS_UNAVAILABLE', 503);
  return data.filter(user => UUID_RE.test(String(user.id || '')) && user.id !== actor.id && RECIPIENT_ROLES.has(upper(user.role)))
    .map(user => ({ id: user.id, name: String(user.name || 'Punëtor'), role: upper(user.role) }));
}

function checkFields(body, extra) {
  const allowed = new Set(['action', 'expectedActorId', ...extra]);
  if (Object.keys(body).some(key => !allowed.has(key))) fail('STAFF_MESSAGE_BODY_INVALID');
}

export async function handleStaffMessages(body, { supabase, actor } = {}) {
  if (!actor?.id || actor.is_active !== true || !STAFF_ROLES.has(upper(actor.role))) fail('STAFF_MESSAGE_FORBIDDEN', 403);
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail('STAFF_MESSAGE_BODY_INVALID');
  if (body.expectedActorId !== actor.id) fail('STAFF_MESSAGE_SESSION_CHANGED', 403);
  const capability = { actor: { id: actor.id, name: String(actor.name || ''), canSend: canSendStaffMessages(actor.role) } };

  if (body.action === 'list' || body.action === 'badge') {
    checkFields(body, ['mode', 'cursor']);
    const mode = body.action === 'badge' ? 'badge' : body.mode || 'inbox';
    if (!['inbox', 'sent', 'badge'].includes(mode)) fail('STAFF_MESSAGE_BODY_INVALID');
    if (mode === 'sent' && !canSendStaffMessages(actor.role)) fail('STAFF_MESSAGE_FORBIDDEN', 403);
    const cursor = body.cursor;
    if (cursor != null && (typeof cursor !== 'object' || Array.isArray(cursor) || !UUID_RE.test(String(cursor.id || '')) || !/^\d{4}-\d{2}-\d{2}T/.test(String(cursor.at || '')) || !Number.isFinite(Date.parse(cursor.at)))) fail('STAFF_MESSAGE_BODY_INVALID');
    return { ...capability, ...await rpc(supabase, 'staff_messages_read_v1', {
      p_actor_id: actor.id, p_mode: mode, p_before_at: cursor?.at || null, p_before_id: cursor?.id || null, p_limit: 30,
    }) };
  }
  if (body.action === 'recipients') {
    checkFields(body, []);
    return { ...capability, recipients: await readRecipients(supabase, actor) };
  }
  if (body.action === 'send') {
    checkFields(body, ['title', 'body', 'recipientIds', 'allWorkers', 'requestKey']);
    if (!canSendStaffMessages(actor.role)) fail('STAFF_MESSAGE_FORBIDDEN', 403);
    if (typeof body.title !== 'string' || typeof body.body !== 'string' || !UUID_RE.test(String(body.requestKey || ''))) fail('STAFF_MESSAGE_BODY_INVALID');
    const title = body.title.trim().replace(/\s+/g, ' ');
    const text = body.body.replace(/\r\n?/g, '\n').trim();
    if (!title || title.length > 120 || !text || text.length > 4000 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(title + text)) fail('STAFF_MESSAGE_BODY_INVALID');
    if (body.allWorkers != null && typeof body.allWorkers !== 'boolean') fail('STAFF_MESSAGE_BODY_INVALID');
    if (body.allWorkers === true && body.recipientIds != null) fail('STAFF_MESSAGE_BODY_INVALID');
    let recipients = null;
    if (body.allWorkers === true) recipients = null;
    else {
      if (!Array.isArray(body.recipientIds) || body.recipientIds.some(id => typeof id !== 'string' || !UUID_RE.test(id))) fail('STAFF_MESSAGE_RECIPIENT_INVALID');
      recipients = [...new Set(body.recipientIds)];
    }
    if (body.allWorkers !== true && (!recipients.length || recipients.length > 100)) fail('STAFF_MESSAGE_RECIPIENT_INVALID');
    return { ...capability, ...await rpc(supabase, 'staff_message_send_v1', {
      p_actor_id: actor.id, p_recipient_ids: recipients, p_title: title, p_body: text, p_request_key: body.requestKey, p_all_workers: body.allWorkers === true,
    }) };
  }
  if (body.action === 'read' || body.action === 'acknowledge') {
    checkFields(body, ['messageId']);
    if (!UUID_RE.test(String(body.messageId || ''))) fail('STAFF_MESSAGE_BODY_INVALID');
    return { ...capability, ...await rpc(supabase, 'staff_message_read_receipt_v1', {
      p_actor_id: actor.id, p_message_id: body.messageId, p_acknowledge: body.action === 'acknowledge',
    }) };
  }
  fail('STAFF_MESSAGE_BODY_INVALID');
}
