import { createHmac, timingSafeEqual } from 'node:crypto';
import { cleanClientUuid, normalizeClientProfilePhone } from './clientProfileIdentity.js';
import { createShortFamilyLink, readShortFamilyLink, isShortFamilyCode } from './clientFamilyShortLink.js';

export class FamilyError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.httpStatus = status; }
}
const uuid = (v) => cleanClientUuid(v);
export function familyKey(source, id) {
  if (!['BASE', 'TRANSPORT'].includes(source) || !uuid(id)) throw new FamilyError('FAMILY_CLIENT_INVALID');
  return `${source}:${uuid(id)}`;
}
export function parseFamilyKey(key) {
  const [source, clientId, extra] = String(key || '').split(':');
  if (extra || familyKey(source, clientId) !== key) throw new FamilyError('FAMILY_CLIENT_INVALID');
  return { source, clientId };
}
function unavailable(error) { return ['PGRST202', '42883'].includes(error?.code); }
export async function familyRpc(supabase, name, args, { optional = false } = {}) {
  const { data, error } = await supabase.rpc(name, args);
  if (error) {
    if (optional && unavailable(error)) return null;
    const match = String(error.message || '').match(/\bFAMILY_[A-Z_]+\b/);
    const code = match?.[0] || 'FAMILY_REQUEST_FAILED';
    throw new FamilyError(code, /FORBIDDEN/.test(code) ? 403 : /CONFLICT|STALE|ALREADY_LINKED/.test(code) ? 409 : /NOT_FOUND/.test(code) ? 404 : match ? 400 : 503);
  }
  return data;
}
export async function readClientFamily(supabase, source, clientId) {
  if (!clientId) return null;
  return familyRpc(supabase, 'client_family_snapshot_v1', { p_key: familyKey(source, clientId) }, { optional: true });
}
export async function resolveFamilyPhone(supabase, source, phone) {
  if (!normalizeClientProfilePhone(phone)) return null;
  const id = await familyRpc(supabase, 'client_family_phone_owner_v1', { p_source: source, p_phone: phone }, { optional: true });
  if (!id) return null;
  const { data, error } = await supabase.from(source === 'BASE' ? 'clients' : 'transport_clients').select('*').eq('id', id).maybeSingle();
  if (error || !data) throw new FamilyError('FAMILY_CLIENT_NOT_FOUND', 404);
  return { ...data, master_phone: data.phone, phone, phone_digits: normalizeClientProfilePhone(phone), family_contact: true, family: await readClientFamily(supabase, source, id) };
}
export async function readFamilyOrder(supabase, source, orderId) {
  if (!['BASE', 'TRANSPORT'].includes(source) || (source === 'BASE' ? !/^[1-9]\d*$/.test(String(orderId)) : !uuid(orderId))) throw new FamilyError('FAMILY_ORDER_INVALID');
  const { data, error } = await supabase.from(source === 'BASE' ? 'orders' : 'transport_orders').select('id,client_id,client_name,client_phone,data').eq('id', orderId).maybeSingle();
  if (error || !data || !uuid(data.client_id)) throw new FamilyError('FAMILY_ORDER_NOT_LINKED', 404);
  return data;
}
function secretKey(secret) {
  if (!secret || secret.length < 24) throw new FamilyError('FAMILY_LINK_NOT_CONFIGURED', 503);
  return createHmac('sha256', secret).update('tepiha-family-link-v1').digest();
}
export function signFamilyToken(payload, secret, now = Date.now()) {
  familyKey(payload.source, payload.clientId);
  const body = Buffer.from(JSON.stringify({ v: 1, source: payload.source, clientId: payload.clientId, orderId: String(payload.orderId), exp: Math.floor(now / 1000) + 30 * 24 * 3600 })).toString('base64url');
  return `${body}.${createHmac('sha256', secretKey(secret)).update(body).digest('base64url')}`;
}
export function verifyFamilyToken(token, secret, now = Date.now()) {
  if (typeof token !== 'string' || token.length > 1400) throw new FamilyError('FAMILY_LINK_INVALID', 403);
  const [body, signature, extra] = token.split('.');
  if (!body || !signature || extra || !/^[A-Za-z0-9_-]+$/.test(body) || !/^[A-Za-z0-9_-]{43}$/.test(signature)) throw new FamilyError('FAMILY_LINK_INVALID', 403);
  const expected = createHmac('sha256', secretKey(secret)).update(body).digest();
  const given = Buffer.from(signature, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(expected, given)) throw new FamilyError('FAMILY_LINK_INVALID', 403);
  let payload; try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { throw new FamilyError('FAMILY_LINK_INVALID', 403); }
  if (payload.v !== 1 || !Number.isInteger(payload.exp) || payload.exp <= now / 1000) throw new FamilyError('FAMILY_LINK_EXPIRED', 403);
  familyKey(payload.source, payload.clientId);
  return payload;
}
export async function familyAction(body, { supabase, authUser, secret, now } = {}) {
  const action = String(body.action || 'GET_FAMILY');
  if (action === 'RESOLVE_LINK') {
    const link = await readShortFamilyLink(body.token, { supabase, now, allowExpired: true });
    const order = await readFamilyOrder(supabase, link.source, link.orderId);
    if (order.client_id !== link.clientId) throw new FamilyError('FAMILY_LINK_INVALID', 403);
    return { source: link.source, orderId: link.orderId, token: link.exp > (now ?? Date.now()) / 1000 ? body.token : '' };
  }
  if (['PUBLIC_INFO', 'PUBLIC_ADD'].includes(action)) {
    const token = isShortFamilyCode(body.token) ? await readShortFamilyLink(body.token, { supabase, now }) : verifyFamilyToken(body.token, secret, now);
    if (body.source !== token.source || String(body.orderId) !== token.orderId) throw new FamilyError('FAMILY_LINK_INVALID', 403);
    const order = await readFamilyOrder(supabase, token.source, token.orderId);
    if (order.client_id !== token.clientId) throw new FamilyError('FAMILY_LINK_INVALID', 403);
    const key = familyKey(token.source, token.clientId);
    if (action === 'PUBLIC_ADD') {
      await familyRpc(supabase, 'client_family_mutate_v1', { p_actor: null, p_public_key: key, p_payload: { action: 'ADD_CONTACTS', key, contacts: body.contacts, requestId: body.requestId } });
      return { saved: true };
    }
    const family = await readClientFamily(supabase, token.source, token.clientId);
    if (!family) throw new FamilyError('FAMILY_NOT_AVAILABLE', 503);
    // Customer links never expose the family phone list or any financial history.
    return { name: order.client_name || '', codes: family.members.map(m => ({ source: m.source, code: m.code })) };
  }
  if (!authUser?.id) throw new FamilyError('AUTH_REQUIRED', 401);
  if (action === 'SEARCH') return { items: await familyRpc(supabase, 'client_family_search_v1', { p_query: String(body.query || '').slice(0, 180), p_source: ['BASE', 'TRANSPORT'].includes(body.source) ? body.source : null }, { optional: true }) || [] };
  if (action === 'RESOLVE_PHONE') {
    if (!['BASE', 'TRANSPORT'].includes(body.source)) throw new FamilyError('FAMILY_CLIENT_INVALID');
    return { client: await resolveFamilyPhone(supabase, body.source, body.phone) };
  }
  if (action === 'SIGN_LINK') {
    const order = await readFamilyOrder(supabase, body.source, body.orderId);
    const family = await readClientFamily(supabase, body.source, order.client_id);
    if (!family) throw new FamilyError('FAMILY_NOT_AVAILABLE', 503);
    const payload = { source: body.source, orderId: order.id, clientId: order.client_id };
    return { token: signFamilyToken(payload, secret, now), shortUrl: await createShortFamilyLink(payload, { supabase, secret, now }) };
  }
  const key = familyKey(body.source, body.clientId);
  if (action === 'GET_FAMILY') return { family: await readClientFamily(supabase, body.source, body.clientId) };
  if (!['MERGE', 'UNLINK', 'ADD_CONTACTS', 'REMOVE_CONTACT'].includes(action)) throw new FamilyError('FAMILY_ACTION_INVALID');
  if (body.otherKey) parseFamilyKey(body.otherKey);
  const payload = { action, key, requestId: body.requestId, expectedRoot: body.expectedRoot, expectedRevision: body.expectedRevision,
    ...(body.otherKey ? { otherKey: body.otherKey, otherRoot: body.otherRoot, otherRevision: body.otherRevision } : {}),
    ...(action === 'ADD_CONTACTS' ? { contacts: body.contacts } : {}),
    ...(action === 'REMOVE_CONTACT' ? { contactId: body.contactId } : {}) };
  return { family: await familyRpc(supabase, 'client_family_mutate_v1', { p_payload: payload, p_actor: authUser.id, p_public_key: null }) };
}
