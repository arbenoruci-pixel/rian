import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabaseAdminClient';

export async function GET() {
  try {
    const usingServiceRole = !!(process.env.SUPABASE_SERVICE_ROLE_KEY && String(process.env.SUPABASE_SERVICE_ROLE_KEY).trim());
    // This will throw if SUPABASE_URL / keys are missing.
    getSupabaseAdmin();
    return NextResponse.json({ ok: true, using_service_role: usingServiceRole });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: 'PING_FAILED', detail: e?.message || String(e) },
      { status: 500 }
    );
  }
}
