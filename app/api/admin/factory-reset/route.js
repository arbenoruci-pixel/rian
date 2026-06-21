import { createServiceClientOrThrow, apiOk, apiFail, logApiError, readBody } from '@/lib/apiService';
import { normalizeBoolean, normalizePin } from '@/lib/validation';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function pickExpectedPin() {
  const value = (
    process.env.TEPIHA_RESET_PASSWORD ||
    process.env.TEPIHA_RESET_PIN ||
    process.env.ADMIN_RESET_PIN ||
    process.env.RESET_PIN ||
    process.env.ADMIN_PIN ||
    ''
  ).toString().trim();
  return value || null;
}

async function wipeBucketAll(supabase, bucketName) {
  const bucket = supabase.storage.from(bucketName);
  const allPaths = [];
  const stack = [''];
  while (stack.length) {
    const prefix = stack.pop();
    const { data, error } = await bucket.list(prefix, { limit: 1000 });
    if (error) break;
    for (const it of data || []) {
      if (!it?.name) continue;
      if (it?.id) allPaths.push(prefix ? `${prefix}/${it.name}` : it.name);
      else stack.push(prefix ? `${prefix}/${it.name}` : it.name);
    }
  }
  if (allPaths.length) await bucket.remove(allPaths);
}

export async function POST(req) {
  try {
    const body = await readBody(req);
    const expectedPin = pickExpectedPin();
    if (!expectedPin) return apiFail('RESET_PIN_NOT_SET', 500);

    const gotPin = normalizePin(body?.reset_pin || body?.pin || body?.password || body?.requester_pin, { min: 3, max: 32 });
    const confirm = String(body?.confirm_text || body?.confirm || body?.word || '').trim().toUpperCase();
    if (gotPin !== expectedPin) return apiFail('BAD_PIN', 401);
    if (confirm !== 'RESET') return apiFail('BAD_CONFIRM', 400);

    const supabase = createServiceClientOrThrow();
    const { error } = await supabase.rpc('tepiha_brand_new_v1');
    if (error) return apiFail('RPC_FAILED', 500, { detail: error.message, hint: error.hint });
    if (normalizeBoolean(body?.wipe_photos)) { try { await wipeBucketAll(supabase, 'tepiha-photos'); } catch {} }
    return apiOk({ mode: 'brand_new' });
  } catch (err) {
    logApiError('api.admin.factory-reset', err);
    return apiFail('UNEXPECTED', 500, { detail: String(err?.message || err) });
  }
}
