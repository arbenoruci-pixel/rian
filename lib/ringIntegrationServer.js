import crypto from 'node:crypto';

export class RingIntegrationError extends Error {
  constructor(code, httpStatus = 400, extra = {}) {
    super(code);
    this.name = 'RingIntegrationError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.extra = extra;
  }
}

const RING_AUTHORIZE_URL = 'https://account.ring.com/account/integrations/partner-link/authorize';
const RING_TOKEN_URL = 'https://oauth.ring.com/oauth/token';
const RING_API_BASE = 'https://api.amazonvision.com';
const OWNER_KEY = 'primary';

function env(name) {
  return String(process.env[name] || '').trim();
}

function requiredEnv(name) {
  const value = env(name);
  if (!value) throw new RingIntegrationError(`RING_CONFIG_MISSING_${name}`, 503);
  return value;
}

export function getRingPublicConfig(req = null) {
  const clientId = env('RING_CLIENT_ID');
  const clientSecret = env('RING_CLIENT_SECRET');
  const tokenKey = env('RING_TOKEN_ENCRYPTION_KEY');
  const scope = env('RING_SCOPE') || 'ava';
  const configuredRedirect = env('RING_REDIRECT_URI');
  const host = String(req?.headers?.['x-forwarded-host'] || req?.headers?.host || '').split(',')[0].trim();
  const proto = String(req?.headers?.['x-forwarded-proto'] || 'https').split(',')[0].trim() || 'https';
  const inferredRedirect = host ? `${proto}://${host}/api/ring/callback` : '';
  return {
    configured: !!(clientId && clientSecret && tokenKey && (configuredRedirect || inferredRedirect)),
    hasClientId: !!clientId,
    hasClientSecret: !!clientSecret,
    hasTokenEncryptionKey: !!tokenKey,
    scope,
    redirectUri: configuredRedirect || inferredRedirect,
    appHomepagePath: '/ring.html',
    authorizeMode: 'partner_initiated_oauth_pkce',
  };
}

function ringConfig(req = null) {
  const publicConfig = getRingPublicConfig(req);
  if (!publicConfig.configured) throw new RingIntegrationError('RING_NOT_CONFIGURED', 503, { config: publicConfig });
  return {
    clientId: requiredEnv('RING_CLIENT_ID'),
    clientSecret: requiredEnv('RING_CLIENT_SECRET'),
    tokenEncryptionKey: requiredEnv('RING_TOKEN_ENCRYPTION_KEY'),
    scope: publicConfig.scope,
    redirectUri: publicConfig.redirectUri,
  };
}

function base64url(buffer) {
  return Buffer.from(buffer).toString('base64url');
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest();
}

function timingSafeEqualText(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  if (!left.length || left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function encryptionKey() {
  return sha256(requiredEnv('RING_TOKEN_ENCRYPTION_KEY'));
}

export function encryptRingSecret(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(value || ''), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${base64url(iv)}.${base64url(tag)}.${base64url(ciphertext)}`;
}

export function decryptRingSecret(packed) {
  const parts = String(packed || '').split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new RingIntegrationError('RING_TOKEN_DECRYPT_FAILED', 500);
  try {
    const iv = Buffer.from(parts[1], 'base64url');
    const tag = Buffer.from(parts[2], 'base64url');
    const ciphertext = Buffer.from(parts[3], 'base64url');
    const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    throw new RingIntegrationError('RING_TOKEN_DECRYPT_FAILED', 500);
  }
}

function cookieValue(name, req) {
  const raw = String(req?.headers?.cookie || '');
  const prefix = `${name}=`;
  for (const chunk of raw.split(';')) {
    const part = chunk.trim();
    if (!part.startsWith(prefix)) continue;
    try { return decodeURIComponent(part.slice(prefix.length)); } catch { return ''; }
  }
  return '';
}

function cookieOptions(req, maxAgeSeconds) {
  const proto = String(req?.headers?.['x-forwarded-proto'] || '').toLowerCase();
  const secure = proto ? proto.includes('https') : process.env.NODE_ENV === 'production';
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.max(0, Number(maxAgeSeconds || 0))}${secure ? '; Secure' : ''}`;
}

export function setRingOauthCookies(req, res, { state, verifier }) {
  const stateCookie = `ring_oauth_state=${encodeURIComponent(state)}; ${cookieOptions(req, 900)}`;
  const verifierCookie = `ring_oauth_verifier=${encodeURIComponent(verifier)}; ${cookieOptions(req, 900)}`;
  res.setHeader('Set-Cookie', [stateCookie, verifierCookie]);
}

export function clearRingOauthCookies(req, res) {
  res.setHeader('Set-Cookie', [
    `ring_oauth_state=; ${cookieOptions(req, 0)}`,
    `ring_oauth_verifier=; ${cookieOptions(req, 0)}`,
  ]);
}

export function buildRingAuthorization(req, res) {
  const cfg = ringConfig(req);
  const state = base64url(crypto.randomBytes(32));
  const verifier = base64url(crypto.randomBytes(64));
  const challenge = base64url(sha256(verifier));
  const url = new URL(RING_AUTHORIZE_URL);
  url.searchParams.set('client_id', cfg.clientId);
  url.searchParams.set('redirect_uri', cfg.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', cfg.scope);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  setRingOauthCookies(req, res, { state, verifier });
  return { url: url.toString(), redirectUri: cfg.redirectUri, scope: cfg.scope };
}

async function ringFetch(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch {}
  if (!response.ok) {
    throw new RingIntegrationError('RING_API_REQUEST_FAILED', response.status >= 500 ? 502 : 400, {
      ringStatus: response.status,
      ringBody: json || text.slice(0, 800),
    });
  }
  return json;
}

async function exchangeAuthorizationCode(req, code, verifier) {
  const cfg = ringConfig(req);
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
  });
  return ringFetch(RING_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
}

async function refreshTokens(req, refreshToken) {
  const cfg = ringConfig(req);
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
  });
  return ringFetch(RING_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
}

async function fetchRingJson(accessToken, path) {
  return ringFetch(`${RING_API_BASE}${path}`, {
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: 'application/json',
    },
  });
}

function normalizeDevices(payload) {
  const data = Array.isArray(payload?.data) ? payload.data : [];
  return data.map((item) => ({
    id: String(item?.id || ''),
    type: String(item?.type || 'device'),
    name: String(item?.attributes?.name || item?.attributes?.description || item?.attributes?.device_name || item?.id || 'Ring camera'),
    attributes: item?.attributes && typeof item.attributes === 'object' ? item.attributes : {},
  }));
}

async function accountIdFromToken(accessToken) {
  try {
    const profile = await fetchRingJson(accessToken, '/v1/users/me');
    return String(profile?.data?.id || profile?.data?.attributes?.account_id || profile?.meta?.account_id || '');
  } catch {
    return '';
  }
}

export async function completeRingAuthorization(req, res, { supabase, code, state }) {
  const cookieState = cookieValue('ring_oauth_state', req);
  const verifier = cookieValue('ring_oauth_verifier', req);
  if (!code || !state || !cookieState || !verifier) throw new RingIntegrationError('RING_OAUTH_SESSION_MISSING', 400);
  if (!timingSafeEqualText(state, cookieState)) throw new RingIntegrationError('RING_OAUTH_STATE_MISMATCH', 403);

  const tokens = await exchangeAuthorizationCode(req, code, verifier);
  const accessToken = String(tokens?.access_token || '');
  const refreshToken = String(tokens?.refresh_token || '');
  const expiresIn = Math.max(60, Number(tokens?.expires_in || 14400));
  if (!accessToken || !refreshToken) throw new RingIntegrationError('RING_TOKEN_EXCHANGE_INVALID', 502);

  const [accountId, devicesPayload] = await Promise.all([
    accountIdFromToken(accessToken),
    fetchRingJson(accessToken, '/v1/devices?include=status,capabilities,location'),
  ]);
  const devices = normalizeDevices(devicesPayload);
  const now = new Date();
  const accessExpiresAt = new Date(now.getTime() + expiresIn * 1000).toISOString();
  const refreshExpiresAt = new Date(now.getTime() + 29 * 24 * 60 * 60 * 1000).toISOString();

  const row = {
    owner_key: OWNER_KEY,
    account_id: accountId || null,
    access_token_enc: encryptRingSecret(accessToken),
    refresh_token_enc: encryptRingSecret(refreshToken),
    access_expires_at: accessExpiresAt,
    refresh_expires_at: refreshExpiresAt,
    scope: String(tokens?.scope || ringConfig(req).scope || ''),
    token_type: String(tokens?.token_type || 'Bearer'),
    devices,
    connected_at: now.toISOString(),
    last_refreshed_at: now.toISOString(),
    last_device_sync_at: now.toISOString(),
    revoked_at: null,
    metadata: { provider: 'ring', auth_mode: 'partner_initiated_oauth_pkce' },
    updated_at: now.toISOString(),
  };

  const { error } = await supabase.from('ring_integrations').upsert(row, { onConflict: 'owner_key' });
  if (error) throw new RingIntegrationError('RING_TOKEN_STORE_FAILED', 500, { dbMessage: String(error.message || '') });
  clearRingOauthCookies(req, res);
  return { connected: true, accountId, devices };
}

async function readActiveIntegration(supabase) {
  const { data, error } = await supabase
    .from('ring_integrations')
    .select('*')
    .eq('owner_key', OWNER_KEY)
    .is('revoked_at', null)
    .maybeSingle();
  if (error) throw new RingIntegrationError('RING_STATUS_DB_FAILED', 500, { dbMessage: String(error.message || '') });
  return data || null;
}

async function ensureFreshAccessToken(req, supabase, row) {
  if (!row) throw new RingIntegrationError('RING_NOT_CONNECTED', 404);
  const expiresAtMs = Date.parse(String(row.access_expires_at || ''));
  const nowMs = Date.now();
  if (Number.isFinite(expiresAtMs) && expiresAtMs - nowMs > 5 * 60 * 1000) {
    return { row, accessToken: decryptRingSecret(row.access_token_enc), refreshed: false };
  }

  const refreshToken = decryptRingSecret(row.refresh_token_enc);
  const tokens = await refreshTokens(req, refreshToken);
  const accessToken = String(tokens?.access_token || '');
  const nextRefresh = String(tokens?.refresh_token || refreshToken);
  const expiresIn = Math.max(60, Number(tokens?.expires_in || 14400));
  if (!accessToken) throw new RingIntegrationError('RING_REFRESH_INVALID', 502);
  const patch = {
    access_token_enc: encryptRingSecret(accessToken),
    refresh_token_enc: encryptRingSecret(nextRefresh),
    access_expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
    refresh_expires_at: new Date(Date.now() + 29 * 24 * 60 * 60 * 1000).toISOString(),
    last_refreshed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await supabase
    .from('ring_integrations')
    .update(patch)
    .eq('id', row.id)
    .select('*')
    .single();
  if (error) throw new RingIntegrationError('RING_REFRESH_STORE_FAILED', 500, { dbMessage: String(error.message || '') });
  return { row: data, accessToken, refreshed: true };
}

export async function getRingStatus(req, { supabase, syncDevices = true } = {}) {
  const config = getRingPublicConfig(req);
  let row = await readActiveIntegration(supabase);
  if (!row) return { configured: config.configured, config, connected: false, devices: [] };

  if (!config.configured) {
    return {
      configured: false,
      config,
      connected: true,
      devices: Array.isArray(row.devices) ? row.devices : [],
      accountId: row.account_id || null,
      connectedAt: row.connected_at || null,
      warning: 'RING_ENV_NOT_CONFIGURED',
    };
  }

  let refreshed = false;
  if (syncDevices) {
    const fresh = await ensureFreshAccessToken(req, supabase, row);
    row = fresh.row;
    refreshed = fresh.refreshed;
    const payload = await fetchRingJson(fresh.accessToken, '/v1/devices?include=status,capabilities,location');
    const devices = normalizeDevices(payload);
    const { data, error } = await supabase
      .from('ring_integrations')
      .update({ devices, last_device_sync_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', row.id)
      .select('*')
      .single();
    if (!error && data) row = data;
  }

  return {
    configured: true,
    config,
    connected: true,
    accountId: row.account_id || null,
    connectedAt: row.connected_at || null,
    lastRefreshedAt: row.last_refreshed_at || null,
    lastDeviceSyncAt: row.last_device_sync_at || null,
    refreshed,
    devices: Array.isArray(row.devices) ? row.devices : [],
  };
}

export async function disconnectRing({ supabase }) {
  const now = new Date().toISOString();
  const { error } = await supabase
    .from('ring_integrations')
    .update({
      revoked_at: now,
      access_token_enc: encryptRingSecret('revoked'),
      refresh_token_enc: encryptRingSecret('revoked'),
      devices: [],
      updated_at: now,
    })
    .eq('owner_key', OWNER_KEY)
    .is('revoked_at', null);
  if (error) throw new RingIntegrationError('RING_DISCONNECT_FAILED', 500, { dbMessage: String(error.message || '') });
  return { disconnected: true };
}
