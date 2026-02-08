import { NextResponse } from 'next/server';

export async function GET() {
  try {
    const hasUrl = !!(process.env.SUPABASE_URL && String(process.env.SUPABASE_URL).trim());
    const hasAnon = !!(process.env.SUPABASE_ANON_KEY && String(process.env.SUPABASE_ANON_KEY).trim());
    const usingServiceRole = !!(process.env.SUPABASE_SERVICE_ROLE_KEY && String(process.env.SUPABASE_SERVICE_ROLE_KEY).trim());

    // ✅ This endpoint must NEVER require the service role key.
    // It is used only to detect "server reachable" from the browser.
    if (!hasUrl || !hasAnon) {
      return NextResponse.json(
        { ok: false, error: 'ENV_MISSING', using_service_role: usingServiceRole },
        { status: 500 }
      );
    }

    return NextResponse.json({ ok: true, using_service_role: usingServiceRole });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: 'PING_FAILED', detail: e?.message || String(e) },
      { status: 500 }
    );
  }
}
