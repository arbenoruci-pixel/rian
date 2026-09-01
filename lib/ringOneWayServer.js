import crypto from 'node:crypto';
import { RingIntegrationError } from './ringIntegrationServer.js';

const RING_TOKEN_URL = 'https://oauth.ring.com/oauth/token';
const RING_API_BASE = 'https://api.amazonvision.com';
const OWNER_KEY = 'primary';
const LINK_WINDOW_MS = 10 * 60 * 1000;

function text(value) {
  return String(value ?? '').trim();
}

function safeEqual(a, b) {
  const aa = Buffer.from(text(a));
  const bb = Buffer.from(text(b));
  return aa.length > 0 && aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

async function loadCredentials(supabase) {
  const { data, error } = await supabase
    .from('ring_app_credentials')
    .select('client_id,client_secret,hmac_key,token_encryption_key')
    .eq('owner_key', OWNER_KEY)
    .maybeSingle();
  if (error) throw new RingIntegrationError('RING_CREDENTIALS_DB_FAILED', 500, { dbMessage: text(error.message) });
  if (!data?.client_id || !data?.client_secret || !data?.hmac_key || !data?.token_encryption_key) {
    throw new RingIntegrationError('RING_CREDENTIALS_MISSING', 503);
  }
  return data;
}

function keyFrom(value) {
  return crypto.createHash('sha256').update(text(value)).digest();
}

function encryptWithKey(value, keyText) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyFrom(keyText), iv);
  const ciphertext = Buffer.concat([cipher.update(text(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${ciphertext.toString('base64url')}`;
}

function decryptWithKey(packed, keyText) {
  const parts = text(packed).split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new RingIntegrationError('RING_TOKEN_DECRYPT_FAILED', 500);
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', keyFrom(keyText), Buffer.from(parts[1], 'base64url'));
    decipher.setAuthTag(Buffer.from(parts[2], 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    throw new RingIntegrationError('RING_TOKEN_DECRYPT_FAILED', 500);
  }
}

async function ringRequest(url, options = {}) {
  const response = await fetch(url, options);
  const raw = await response.text();
  let body = null;
  try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
  if (!response.ok) {
    throw new RingIntegrationError('RING_API_REQUEST_FAILED', response.status >= 500 ? 502 : 400, {
      ringStatus: response.status,
      ringBody: typeof body === 'string' ? body.slice(0, 500) : body,
    });
  }
  return body;
}

async function exchangeCode(code, credentials) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: text(code),
    client_id: credentials.client_id,
    client_secret: credentials.client_secret,
  });
  return ringRequest(RING_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
}

async function refreshAccess(refreshToken, credentials) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: text(refreshToken),
    client_id: credentials.client_id,
    client_secret: credentials.client_secret,
  });
  return ringRequest(RING_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
}

async function avJson(accessToken, path, options = {}) {
  return ringRequest(`${RING_API_BASE}${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: 'application/json',
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
}

function accountIdFromProfile(profile) {
  return text(profile?.data?.id || profile?.data?.attributes?.account_id || profile?.meta?.account_id);
}

function normalizeDevices(payload) {
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  return rows.map((item) => ({
    id: text(item?.id),
    type: text(item?.type || 'device'),
    name: text(item?.attributes?.name || item?.attributes?.description || item?.attributes?.device_name || item?.id || 'Ring camera'),
    attributes: item?.attributes && typeof item.attributes === 'object' ? item.attributes : {},
  }));
}

function computeNonce(timeParam, accountId, hmacKey) {
  const mac = crypto.createHmac('sha256', text(hmacKey)).update(`${text(timeParam)}:${text(accountId)}`).digest();
  return mac.toString('base64url');
}

function validateLinkTime(timeParam) {
  const t = Number(timeParam);
  if (!Number.isFinite(t)) throw new RingIntegrationError('RING_LINK_TIME_INVALID', 400);
  const delta = Date.now() - t;
  if (delta < -5000) throw new RingIntegrationError('RING_LINK_TIME_IN_FUTURE', 400);
  if (delta > LINK_WINDOW_MS) throw new RingIntegrationError('RING_LINK_EXPIRED', 410);
}

export async function acceptRingAuthorizationCode({ supabase, code }) {
  const authorizationCode = text(code);
  if (!authorizationCode) throw new RingIntegrationError('RING_AUTH_CODE_MISSING', 400);
  const credentials = await loadCredentials(supabase);
  const tokens = await exchangeCode(authorizationCode, credentials);
  const accessToken = text(tokens?.access_token);
  const refreshToken = text(tokens?.refresh_token);
  if (!accessToken || !refreshToken) throw new RingIntegrationError('RING_TOKEN_EXCHANGE_INVALID', 502);

  const profile = await avJson(accessToken, '/v1/users/me');
  const accountId = accountIdFromProfile(profile);
  if (!accountId) throw new RingIntegrationError('RING_ACCOUNT_ID_MISSING', 502);
  const expiresIn = Math.max(60, Number(tokens?.expires_in || 14400));
  const now = new Date();
  const row = {
    account_id: accountId,
    access_token_enc: encryptWithKey(accessToken, credentials.token_encryption_key),
    refresh_token_enc: encryptWithKey(refreshToken, credentials.token_encryption_key),
    access_expires_at: new Date(now.getTime() + expiresIn * 1000).toISOString(),
    refresh_expires_at: new Date(now.getTime() + 29 * 24 * 60 * 60 * 1000).toISOString(),
    scope: text(tokens?.scope || 'ava'),
    token_type: text(tokens?.token_type || 'Bearer'),
    claimed_at: null,
    updated_at: now.toISOString(),
  };
  const { error } = await supabase.from('ring_unclaimed_tokens').insert(row);
  if (error) throw new RingIntegrationError('RING_UNCLAIMED_TOKEN_STORE_FAILED', 500, { dbMessage: text(error.message) });
  return { accepted: true, accountId };
}

async function findMatchingUnclaimed({ supabase, nonce, timeParam, credentials }) {
  validateLinkTime(timeParam);
  const { data, error } = await supabase
    .from('ring_unclaimed_tokens')
    .select('*')
    .is('claimed_at', null)
    .order('created_at', { ascending: false })
    .limit(10);
  if (error) throw new RingIntegrationError('RING_UNCLAIMED_TOKEN_READ_FAILED', 500, { dbMessage: text(error.message) });
  for (const row of data || []) {
    const expected = computeNonce(timeParam, row.account_id, credentials.hmac_key);
    if (safeEqual(expected, nonce)) return row;
  }
  throw new RingIntegrationError('RING_LINK_NONCE_NO_MATCH', 403);
}

async function finalizeAppIntegration(accessToken, nonce, accountIdentifier) {
  await avJson(accessToken, '/v1/accounts/me/app-integrations', {
    method: 'POST',
    body: JSON.stringify({ account_identifier: accountIdentifier, nonce: text(nonce) }),
  });
  await avJson(accessToken, '/v1/accounts/me/app-integrations', {
    method: 'PATCH',
    body: JSON.stringify({ status: 'completed' }),
  });
}

export async function completeOneWayLink({ supabase, nonce, timeParam, accountIdentifier = 'a***i@yahoo.com' }) {
  const credentials = await loadCredentials(supabase);
  const row = await findMatchingUnclaimed({ supabase, nonce, timeParam, credentials });
  const accessToken = decryptWithKey(row.access_token_enc, credentials.token_encryption_key);
  await finalizeAppIntegration(accessToken, nonce, accountIdentifier);

  const devicesPayload = await avJson(accessToken, '/v1/devices?include=status,capabilities,location');
  const devices = normalizeDevices(devicesPayload);
  const now = new Date().toISOString();
  const integration = {
    owner_key: OWNER_KEY,
    account_id: row.account_id,
    access_token_enc: row.access_token_enc,
    refresh_token_enc: row.refresh_token_enc,
    access_expires_at: row.access_expires_at,
    refresh_expires_at: row.refresh_expires_at,
    scope: row.scope,
    token_type: row.token_type,
    devices,
    connected_at: now,
    last_refreshed_at: now,
    last_device_sync_at: now,
    revoked_at: null,
    metadata: { provider: 'ring', auth_mode: 'one_way_hmac', account_identifier: accountIdentifier },
    updated_at: now,
  };
  const { error: upsertError } = await supabase.from('ring_integrations').upsert(integration, { onConflict: 'owner_key' });
  if (upsertError) throw new RingIntegrationError('RING_INTEGRATION_STORE_FAILED', 500, { dbMessage: text(upsertError.message) });
  const { error: claimError } = await supabase
    .from('ring_unclaimed_tokens')
    .update({ claimed_at: now, updated_at: now })
    .eq('id', row.id);
  if (claimError) throw new RingIntegrationError('RING_TOKEN_CLAIM_MARK_FAILED', 500, { dbMessage: text(claimError.message) });
  return { connected: true, accountId: row.account_id, devices };
}

async function activeIntegration(supabase) {
  const { data, error } = await supabase
    .from('ring_integrations')
    .select('*')
    .eq('owner_key', OWNER_KEY)
    .is('revoked_at', null)
    .maybeSingle();
  if (error) throw new RingIntegrationError('RING_STATUS_DB_FAILED', 500, { dbMessage: text(error.message) });
  return data || null;
}

async function freshAccess({ supabase, row, credentials }) {
  const expiresAt = Date.parse(text(row?.access_expires_at));
  if (Number.isFinite(expiresAt) && expiresAt - Date.now() > 5 * 60 * 1000) {
    return { token: decryptWithKey(row.access_token_enc, credentials.token_encryption_key), row };
  }
  const refreshToken = decryptWithKey(row.refresh_token_enc, credentials.token_encryption_key);
  const tokens = await refreshAccess(refreshToken, credentials);
  const accessToken = text(tokens?.access_token);
  const nextRefresh = text(tokens?.refresh_token || refreshToken);
  if (!accessToken) throw new RingIntegrationError('RING_REFRESH_INVALID', 502);
  const expiresIn = Math.max(60, Number(tokens?.expires_in || 14400));
  const patch = {
    access_token_enc: encryptWithKey(accessToken, credentials.token_encryption_key),
    refresh_token_enc: encryptWithKey(nextRefresh, credentials.token_encryption_key),
    access_expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
    refresh_expires_at: new Date(Date.now() + 29 * 24 * 60 * 60 * 1000).toISOString(),
    last_refreshed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await supabase.from('ring_integrations').update(patch).eq('id', row.id).select('*').single();
  if (error) throw new RingIntegrationError('RING_REFRESH_STORE_FAILED', 500, { dbMessage: text(error.message) });
  return { token: accessToken, row: data };
}

export async function getOneWayRingStatus({ supabase, syncDevices = true } = {}) {
  const credentials = await loadCredentials(supabase);
  let row = await activeIntegration(supabase);
  if (!row) {
    const { count } = await supabase.from('ring_unclaimed_tokens').select('id', { count: 'exact', head: true }).is('claimed_at', null);
    return { configured: true, connected: false, devices: [], pendingTokens: Number(count || 0), config: { authMode: 'one_way_hmac', appHomepagePath: '/ring.html' } };
  }
  if (syncDevices) {
    const fresh = await freshAccess({ supabase, row, credentials });
    const payload = await avJson(fresh.token, '/v1/devices?include=status,capabilities,location');
    const devices = normalizeDevices(payload);
    const now = new Date().toISOString();
    const { data } = await supabase.from('ring_integrations').update({ devices, last_device_sync_at: now, updated_at: now }).eq('id', row.id).select('*').single();
    if (data) row = data;
  }
  return {
    configured: true,
    connected: true,
    accountId: row.account_id,
    connectedAt: row.connected_at,
    lastDeviceSyncAt: row.last_device_sync_at,
    devices: Array.isArray(row.devices) ? row.devices : [],
    config: { authMode: 'one_way_hmac', appHomepagePath: '/ring.html' },
  };
}

export async function listRingHistory({ supabase, deviceId, limit = 50, before = '', after = '' }) {
  const credentials = await loadCredentials(supabase);
  const row = await activeIntegration(supabase);
  if (!row) throw new RingIntegrationError('RING_NOT_CONNECTED', 404);
  const fresh = await freshAccess({ supabase, row, credentials });
  const params = new URLSearchParams();
  params.set('limit', String(Math.max(1, Math.min(100, Number(limit || 50)))));
  if (before) params.set('before', text(before));
  if (after) params.set('after', text(after));
  return avJson(fresh.token, `/v1/history/devices/${encodeURIComponent(text(deviceId))}/events?${params.toString()}`);
}

export async function verifyAndStoreWebhook({ supabase, rawBody, signature }) {
  const credentials = await loadCredentials(supabase);
  const received = text(signature).replace(/^sha256=/i, '').toLowerCase();
  const expected = crypto.createHmac('sha256', text(credentials.hmac_key)).update(rawBody).digest('hex').toLowerCase();
  if (!safeEqual(expected, received)) throw new RingIntegrationError('RING_WEBHOOK_SIGNATURE_INVALID', 403);
  let payload = null;
  try { payload = JSON.parse(Buffer.from(rawBody).toString('utf8')); } catch { throw new RingIntegrationError('RING_WEBHOOK_JSON_INVALID', 400); }
  const requestId = text(payload?.meta?.request_id) || null;
  const accountId = text(payload?.meta?.account_id) || null;
  const eventType = text(payload?.data?.type) || null;
  const deviceId = text(payload?.data?.attributes?.source_id || payload?.data?.relationships?.device?.data?.id || '') || null;
  const { error } = await supabase.from('ring_webhook_events').upsert({ request_id: requestId, account_id: accountId, event_type: eventType, device_id: deviceId, payload }, { onConflict: 'request_id', ignoreDuplicates: true });
  if (error && !text(error.message).toLowerCase().includes('duplicate')) {
    throw new RingIntegrationError('RING_WEBHOOK_STORE_FAILED', 500, { dbMessage: text(error.message) });
  }
  return { ok: true, requestId, eventType };
}
