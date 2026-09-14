import { createHash, createHmac } from 'node:crypto';

export const isShortFamilyCode = value => /^s_[A-Za-z0-9_-]{22}$/.test(String(value || ''));
const hash = token => createHash('sha256').update(token).digest('hex');
const DAY = 86400000;
function error(code, status = 403) { return Object.assign(new Error(code), { code, httpStatus: status }); }

export async function createShortFamilyLink(payload, { supabase, secret, now = Date.now() }) {
  if (!secret || secret.length < 24) throw error('FAMILY_LINK_NOT_CONFIGURED', 503);
  // Reopening the same order during a day reuses the link without accumulating
  // a new row on every click. 128 opaque bits are independent of public codes.
  const expires = (Math.floor(now / DAY) + 30) * DAY;
  const input = JSON.stringify([payload.source, String(payload.orderId), payload.clientId, expires]);
  const token = 's_' + createHmac('sha256', secret).update('tepiha-short-family-v1\0').update(input).digest().subarray(0, 16).toString('base64url');
  const row = { token_hash: hash(token), source: payload.source, order_id: String(payload.orderId), client_id: payload.clientId, expires_at: new Date(expires).toISOString() };
  const { error: dbError } = await supabase.from('client_family_short_links').upsert(row, { onConflict: 'token_hash', ignoreDuplicates: true });
  if (dbError) {
    // During deployment the existing signed link remains usable.
    if (['42P01', 'PGRST205'].includes(dbError.code)) return null;
    throw error('FAMILY_REQUEST_FAILED', 503);
  }
  return `https://tepiha.vercel.app/k/${token}`;
}

export async function readShortFamilyLink(token, { supabase, now = Date.now(), allowExpired = false }) {
  if (!isShortFamilyCode(token)) throw error('FAMILY_LINK_INVALID');
  const { data, error: dbError } = await supabase.from('client_family_short_links').select('source,order_id,client_id,expires_at').eq('token_hash', hash(token)).maybeSingle();
  if (dbError) throw error('FAMILY_REQUEST_FAILED', 503);
  if (!data) throw error('FAMILY_LINK_INVALID');
  const expires = Date.parse(data.expires_at);
  if (!Number.isFinite(expires)) throw error('FAMILY_LINK_INVALID');
  if (!allowExpired && expires <= now) throw error('FAMILY_LINK_EXPIRED');
  return { source: data.source, orderId: data.order_id, clientId: data.client_id, exp: expires / 1000 };
}
