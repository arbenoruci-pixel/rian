import { createAdminClientOrThrow } from '../_helpers.js';
import { acceptRingAuthorizationCode } from '../../lib/ringOneWayServer.js';

function pickCode(body) {
  if (!body) return '';
  if (typeof body === 'string') {
    try {
      const parsed = JSON.parse(body);
      return pickCode(parsed);
    } catch {
      const params = new URLSearchParams(body);
      return String(params.get('code') || params.get('authorization_code') || '').trim();
    }
  }
  if (typeof body === 'object') {
    return String(body.code || body.authorization_code || body.authorizationCode || body?.data?.code || body?.data?.authorization_code || '').trim();
  }
  return '';
}

export default async function handler(req, res) {
  res.setHeader('cache-control', 'no-store');
  if (String(req.method || '').toUpperCase() !== 'POST') {
    res.setHeader('allow', 'POST');
    return res.status(405).json({ ok: false, error: 'METHOD_NOT_ALLOWED' });
  }
  try {
    const code = pickCode(req.body);
    if (!code) {
      console.warn('[ring-token] missing code', { contentType: req.headers['content-type'] || '', bodyType: typeof req.body });
      return res.status(400).json({ ok: false, error: 'RING_AUTH_CODE_MISSING' });
    }
    const supabase = createAdminClientOrThrow();
    const result = await acceptRingAuthorizationCode({ supabase, code });
    console.log('[ring-token] accepted', { accountId: result.accountId });
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('[ring-token]', { code: error?.code || error?.message, status: error?.httpStatus || 500, extra: error?.extra || null });
    return res.status(Number(error?.httpStatus || 500)).json({ ok: false, error: String(error?.code || 'RING_TOKEN_EXCHANGE_FAILED') });
  }
}
