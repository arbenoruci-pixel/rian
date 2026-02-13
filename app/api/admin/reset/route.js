import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';

function json(data, status = 200) {
  return NextResponse.json(data, { status });
}

function pickExpectedPin() {
  return (
    process.env.TEPIHA_RESET_PASSWORD ||
    process.env.TEPIHA_RESET_PIN ||
    process.env.ADMIN_RESET_PIN ||
    process.env.RESET_PIN ||
    '2380'
  ).toString().trim();
}

function getAdminClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

async function wipeBucketAll(supabase, bucketName) {
  const bucket = supabase.storage.from(bucketName);
  const allPaths = [];
  const stack = ['']; // prefixes
  while (stack.length) {
    const prefix = stack.pop();
    const { data, error } = await bucket.list(prefix, { limit: 1000 });
    if (error) break;
    for (const it of data || []) {
      if (!it?.name) continue;
      if (it?.id) {
        allPaths.push(prefix ? `${prefix}/${it.name}` : it.name);
      } else {
        stack.push(prefix ? `${prefix}/${it.name}` : it.name);
      }
    }
  }
  if (allPaths.length) await bucket.remove(allPaths);
}

export async function POST(req) {
  try {
    const body = await req.json().catch(() => ({}));
    const expectedPin = pickExpectedPin();

    const gotPin = String(body?.pin || body?.reset_pin || body?.password || body?.requester_pin || '').trim();
    const confirm = String(body?.confirm || body?.confirm_text || body?.word || '').trim();

    if (gotPin !== expectedPin) return json({ ok: false, error: 'BAD_PIN' }, 401);
    if (confirm.toUpperCase() !== 'RESET') return json({ ok: false, error: 'BAD_CONFIRM' }, 400);

    const supabase = getAdminClient();
    if (!supabase) return json({ ok: false, error: 'MISSING_ENV' }, 500);

    // Modes:
    // - brand_new (default): full reset of operational data (BASE + TRANSPORT) via factory_reset_full_tepiha_v1
    // - clients_only: wipes only clients/orders/payments/arka operational tables via factory_reset_clients_only
    const mode = String(body?.mode || body?.reset_mode || 'brand_new').toLowerCase();

    if (mode === 'clients_only') {
      const { data, error } = await supabase.rpc('factory_reset_clients_only', {
        pin: Number(expectedPin),
      });
      if (error) return json({ ok: false, error: 'RPC_FAILED', detail: error.message, hint: error.hint }, 500);

      // Optional: wipe photos bucket objects if asked (usually NOT needed for clients-only).
      if (body?.wipe_photos) {
        try { await wipeBucketAll(supabase, 'tepiha-photos'); } catch {}
      }

      return json({ ok: true, mode: 'clients_only', result: data || null });
    }

    // Full destructive reset (but keeps schema). Includes BASE + TRANSPORT tables.
    // Requires installing the SQL in /supabase/factory_reset_full_tepiha_transport.sql
    const { data, error } = await supabase.rpc('factory_reset_full_tepiha_v1', {
      pin: Number(expectedPin),
    });
    if (error) return json({ ok: false, error: 'RPC_FAILED', detail: error.message, hint: error.hint }, 500);

    if (body?.wipe_photos) {
      try { await wipeBucketAll(supabase, 'tepiha-photos'); } catch {}
    }

    return json({ ok: true, mode: 'brand_new', result: data || null });
  } catch (err) {
    return json({ ok: false, error: 'UNEXPECTED', detail: String(err?.message || err) }, 500);
  }
}
