import { createClient } from 'npm:@supabase/supabase-js@2.48.0';
import webpush from 'npm:web-push@3.6.7';
import { timingSafeEqual } from 'node:crypto';
import { deliverPushBatch } from './worker.js';

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false, autoRefreshToken: false },
});
async function rpc(name: string, args = {}) {
  const { data, error } = await db.rpc(name, args);
  if (error) throw new Error('PUSH_DATABASE_UNAVAILABLE');
  return data;
}
let cached: { value: any; at: number } | undefined;
Deno.serve(async req => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const token = req.headers.get('x-tepiha-push-key') || '';
  if (!/^[a-f0-9]{64}$/.test(token)) return new Response('Unauthorized', { status: 401 });
  try {
    if (!cached || Date.now() - cached.at > 60_000) cached = { value: await rpc('transport_push_worker_config_v1'), at: Date.now() };
    const cfg = cached.value;
    const expected = String(cfg?.workerToken || '');
    if (expected.length !== token.length || !timingSafeEqual(new TextEncoder().encode(expected), new TextEncoder().encode(token))) {
      return new Response('Unauthorized', { status: 401 });
    }
    if (cfg.enabled !== true) return Response.json({ paused: true });
    const result = await deliverPushBatch({ rpc, config: cfg, send: webpush.sendNotification.bind(webpush) });
    return Response.json(result);
  } catch {
    // Never log keys, subscription endpoints, customer data, or provider bodies.
    console.error('transport_push_worker_failed');
    return Response.json({ error: 'PUSH_WORKER_FAILED' }, { status: 503 });
  }
});
