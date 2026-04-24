import { NextResponse } from 'next/server';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    // IMPORTANT:
    // Ping must NEVER require SERVICE ROLE. Otherwise PRANIMI will think it's offline
    // even when the internet is OK.
    const hasPublicUrl = !!(process.env.NEXT_PUBLIC_SUPABASE_URL && String(process.env.NEXT_PUBLIC_SUPABASE_URL).trim());
    const hasAnonKey = !!(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY && String(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY).trim());
    const hasServiceRole = !!((process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SERVICE_ROLE || process.env.SUPABASE_SERVICE_ROLE) && String((process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SERVICE_ROLE || process.env.SUPABASE_SERVICE_ROLE)).trim());
    return NextResponse.json({ ok: true, supabase_public: hasPublicUrl && hasAnonKey, using_service_role: hasServiceRole });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: 'PING_FAILED', detail: e?.message || String(e) },
      { status: 500 }
    );
  }
}
