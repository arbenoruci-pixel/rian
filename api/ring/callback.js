import { completeRingAuthorization, clearRingOauthCookies } from '../../lib/ringIntegrationServer.js';
import {
  authenticateRingManager,
  safeRingError,
  setPrivateNoStore,
} from './_common.js';

function redirect(res, location) {
  res.statusCode = 302;
  res.setHeader('location', location);
  res.end();
}

export default async function handler(req, res) {
  setPrivateNoStore(res);
  try {
    if (String(req?.method || '').toUpperCase() !== 'GET') {
      res.statusCode = 405;
      res.setHeader('allow', 'GET');
      return res.end('METHOD_NOT_ALLOWED');
    }

    const error = String(req?.query?.error || '').trim();
    if (error) {
      clearRingOauthCookies(req, res);
      return redirect(res, `/ring.html?ring_error=${encodeURIComponent(error)}`);
    }

    const code = String(req?.query?.code || '').trim();
    const state = String(req?.query?.state || '').trim();
    const { supabase } = await authenticateRingManager(req);
    await completeRingAuthorization(req, res, { supabase, code, state });
    return redirect(res, '/ring.html?connected=1');
  } catch (error) {
    const safe = safeRingError(error);
    console.error('[ring-callback]', { code: safe.code, status: safe.httpStatus });
    try { clearRingOauthCookies(req, res); } catch {}
    return redirect(res, `/ring.html?ring_error=${encodeURIComponent(safe.code)}`);
  }
}
