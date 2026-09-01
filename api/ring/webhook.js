import { createAdminClientOrThrow } from '../_helpers.js';
import { verifyAndStoreWebhook } from '../../lib/ringOneWayServer.js';

export const config = { api: { bodyParser: false } };

async function readRaw(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  res.setHeader('cache-control', 'no-store');
  if (String(req.method || '').toUpperCase() !== 'POST') {
    res.setHeader('allow', 'POST');
    return res.status(405).json({ ok: false, error: 'METHOD_NOT_ALLOWED' });
  }
  try {
    const rawBody = await readRaw(req);
    const signature = String(req.headers['x-signature'] || '');
    const supabase = createAdminClientOrThrow();
    const result = await verifyAndStoreWebhook({ supabase, rawBody, signature });
    console.log('[ring-webhook]', { requestId: result.requestId, eventType: result.eventType });
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('[ring-webhook]', { code: error?.code || error?.message, status: error?.httpStatus || 500 });
    return res.status(Number(error?.httpStatus || 500)).json({ ok: false, error: String(error?.code || 'RING_WEBHOOK_FAILED') });
  }
}
