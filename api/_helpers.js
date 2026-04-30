import { createClient } from '@supabase/supabase-js';
import { APP_VERSION, APP_DATA_EPOCH } from '../lib/appEpoch.js';
import { sanitizeTransportOrderPayload } from '../lib/transport/sanitize.js';

export { APP_VERSION, APP_DATA_EPOCH, sanitizeTransportOrderPayload };

export function pickEnv(...keys) {
  for (const key of keys) {
    const value = process.env[key];
    if (value && String(value).trim()) return String(value).trim();
  }
  return '';
}

export function createAdminClientOrThrow() {
  const url = pickEnv('SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL', 'VITE_SUPABASE_URL', 'VITE_NEXT_PUBLIC_SUPABASE_URL');
  const serviceKey = pickEnv('SUPABASE_SERVICE_ROLE_KEY', 'SERVICE_ROLE', 'SUPABASE_SERVICE_ROLE');
  if (!url || !serviceKey) throw new Error('SERVER_NOT_CONFIGURED');
  return createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

export function apiOk(res, payload = {}, status = 200) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ ok: true, ...payload }));
}

export function apiFail(res, error, status = 400, extra = {}) {
  const message = typeof error === 'string' ? error : String(error?.message || error || 'UNKNOWN_ERROR');
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ ok: false, error: message, ...extra }));
}

export function normalizePin(value, { min = 3, max = 12 } = {}) {
  const clean = String(value || '').replace(/\D/g, '').trim();
  if (!clean || clean.length < min || clean.length > max) return '';
  return clean;
}

export function normalizeRole(value) {
  const clean = String(value || '').trim().toUpperCase();
  return clean || '';
}

export function normalizeDeviceId(value) {
  return String(value || '').trim().slice(0, 120);
}

export function cleanText(value) {
  return String(value || '').trim();
}

export function safeNumberOrNull(value) {
  if (value === '' || value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function asObject(value) {
  return value && typeof value === 'object' ? value : {};
}

export function jparse(value, fallback = {}) {
  try {
    if (value && typeof value === 'object') return value;
    if (value == null || value === '') return fallback;
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
}

export function normPhone(value) {
  return String(value || '').replace(/\D+/g, '');
}

export function normalizeName(value) {
  return String(value || '').trim();
}

export function orderData(row) {
  return asObject(jparse(row?.data, {}));
}

export function pickClientCode(row, data) {
  const client = asObject(data?.client);
  return String(row?.client_tcode || row?.code_str || client?.tcode || client?.code || row?.code || '').trim();
}

export function pickClientName(row, data, clientRow) {
  const client = asObject(data?.client);
  return normalizeName(row?.client_name || clientRow?.name || clientRow?.full_name || client?.name || client?.full_name || row?.name || '-');
}

export function pickClientPhone(row, data, clientRow) {
  const client = asObject(data?.client);
  return String(row?.client_phone || clientRow?.phone || client?.phone || '').trim();
}

export function extractClientKeys(row, data) {
  const client = asObject(data?.client);
  const keys = new Set();
  const tcode = String(row?.client_tcode || client?.tcode || client?.code || '').trim();
  const id = String(row?.client_id || client?.id || '').trim();
  const phone = normPhone(row?.client_phone || client?.phone || '');
  if (tcode) keys.add(`tcode:${tcode.toUpperCase()}`);
  if (id) keys.add(`id:${id}`);
  if (phone) keys.add(`phone:${phone}`);
  return Array.from(keys);
}

export async function readUsers(sb) {
  const attempts = [
    () => sb.from('users').select('id,name,pin,role').order('name', { ascending: true }).limit(5000),
    () => sb.from('tepiha_users').select('id,name,pin,role').order('name', { ascending: true }).limit(5000),
  ];
  for (const run of attempts) {
    try {
      const res = await run();
      if (!res?.error) return Array.isArray(res?.data) ? res.data : [];
    } catch {}
  }
  return [];
}

export async function readBody(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;

  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString('utf8');
  const contentType = String(req.headers['content-type'] || '').toLowerCase();

  if (!raw) return {};
  if (contentType.includes('application/json')) {
    try { return JSON.parse(raw); } catch { return {}; }
  }
  if (contentType.includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(raw));
  }
  if (contentType.includes('multipart/form-data')) {
    return Object.fromEntries(new URLSearchParams(raw));
  }
  return { raw };
}

export function redirect(res, location, status = 303) {
  res.statusCode = status;
  res.setHeader('location', location);
  res.end('');
}

export function setClientCookie(res, name, value, { maxAge = 60 * 60 * 24 * 365, path = '/', sameSite = 'Lax' } = {}) {
  const encoded = `${name}=${encodeURIComponent(String(value || ''))}; Path=${path}; Max-Age=${maxAge}; SameSite=${sameSite}`;
  const existing = res.getHeader('Set-Cookie');
  if (!existing) res.setHeader('Set-Cookie', encoded);
  else if (Array.isArray(existing)) res.setHeader('Set-Cookie', [...existing, encoded]);
  else res.setHeader('Set-Cookie', [existing, encoded]);
}
