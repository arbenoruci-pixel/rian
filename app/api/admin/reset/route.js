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

    const gotPin = normalizePin(body?.pin || body?.reset_pin || body?.password || body?.requester_pin, { min: 3, max: 32 });
    const confirm = String(body?.confirm || body?.confirm_text || body?.word || '').trim().toUpperCase();
    if (gotPin !== expectedPin) return apiFail('BAD_PIN', 401);
    if (confirm !== 'RESET') return apiFail('BAD_CONFIRM', 400);

    const supabase = createServiceClientOrThrow();
    const mode = String(body?.mode || body?.reset_mode || 'brand_new').toLowerCase();

    if (mode === 'clients_only') {
      const { data, error } = await supabase.rpc('factory_reset_clients_only', { pin: Number(expectedPin) });
      if (error) return apiFail('RPC_FAILED', 500, { detail: error.message, hint: error.hint });
      if (normalizeBoolean(body?.wipe_photos)) { try { await wipeBucketAll(supabase, 'tepiha-photos'); } catch {} }
      return apiOk({ mode: 'clients_only', result: data || null });
    }

    const { data, error } = await supabase.rpc('factory_reset_full_tepiha_v1', { pin: Number(expectedPin) });
    if (error) return apiFail('RPC_FAILED', 500, { detail: error.message, hint: error.hint });
    if (normalizeBoolean(body?.wipe_photos)) { try { await wipeBucketAll(supabase, 'tepiha-photos'); } catch {} }
    return apiOk({ mode: 'brand_new', result: data || null });
  } catch (err) {
    logApiError('api.admin.reset', err);
    return apiFail('UNEXPECTED', 500, { detail: String(err?.message || err) });
  }
}
