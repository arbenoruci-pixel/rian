import { NextResponse } from 'next/server';
import { createAdminClientOrThrow } from '@/lib/supabaseAdminClient';

export async function POST(req) {
  try {
    const body = await req.json().catch(() => ({}));
    const pin = String(body?.pin || '').trim();
    
    if (!pin || pin.length < 3) {
      return NextResponse.json({ ok: false, error: 'PIN_REQUIRED' }, { status: 400 });
    }


    const supabase = createAdminClientOrThrow();

    const { data, error } = await supabase
      .from('users')
      .select('pin,name,role,is_active')
      .eq('pin', pin)
      .limit(1)
      .maybeSingle();

    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    if (!data) return NextResponse.json({ ok: false, error: 'PIN_NOT_FOUND' }, { status: 404 });
    if (data.is_active === false) return NextResponse.json({ ok: false, error: 'PIN_DISABLED' }, { status: 403 });

    return NextResponse.json({ ok: true, user: { pin: String(data.pin), name: data.name || null, role: String(data.role || '').toUpperCase() || null } });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 500 });
  }
}
