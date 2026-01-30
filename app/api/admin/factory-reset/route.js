import { NextResponse } from 'next/server';
// Korrigjim: Përdorim rrugën relative për Vercel
import { createAdminClientOrNull } from '@/lib/supabaseAdminClient';

function json(data, status = 200) {
  return NextResponse.json(data, { status });
}

function pickExpectedPin() {
  // Kontrollon të gjithë emrat e mundshëm që keni vënë në Vercel
  return (
    process.env.TEPIHA_RESET_PASSWORD ||
    process.env.TEPIHA_RESET_PIN ||
    process.env.ADMIN_RESET_PIN || 
    process.env.RESET_PIN ||
    '2380'
  ).toString().trim();
}

// ... mbani funksionet safeDeleteAll dhe deleteAllStorageObjects siç ishin ...

export async function POST(req) {
  try {
    const body = await req.json().catch(() => ({}));
    const expectedPin = pickExpectedPin();

    const gotPin = (body.reset_pin || body.pin || body.password || "").toString().trim();
    const confirm = (body.confirm_text || body.confirm || body.word || "").toString().trim();

    if (gotPin !== expectedPin || confirm.toUpperCase() !== 'RESET') {
      return json({ ok: false, error: 'WRONG_RESET_PIN' }, 401);
    }

    const supabase = createAdminClientOrNull();
    if (!supabase) {
      return json({ ok: false, error: 'MISSING_ENV_VARS', detail: 'Kontrolloni çelësat në Vercel' }, 500);
    }

    // Pjesa tjetër e logjikës së fshirjes vazhdon këtu...
    return json({ ok: true, message: "Reset u krye me sukses" });
  } catch (e) {
    return json({ ok: false, error: 'UNEXPECTED', detail: e?.message }, 500);
  }
}
