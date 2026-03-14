import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

function getAdminClient() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SERVICE_ROLE;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

export async function POST(req) {
  try {
    const body = await req.json();
    const pin = String(body?.pin || '').trim();
    const role = String(body?.role || '').trim().toUpperCase();
    const device_id = String(body?.deviceId || body?.device_id || '').trim();

    if (!pin || !device_id) {
      return NextResponse.json({ ok: false, error: 'MISSING_FIELDS' }, { status: 400 });
    }


    const supabase = getAdminClient();
    if (!supabase) return NextResponse.json({ ok: false, error: 'SERVER_NOT_CONFIGURED' }, { status: 500 });

    const { data: user, error: uerr } = await supabase
      .from('users')
      .select('id, pin, role, name, is_active')
      .eq('pin', pin)
      .maybeSingle();

    if (uerr) return NextResponse.json({ ok: false, error: uerr.message }, { status: 500 });
    if (!user) return NextResponse.json({ ok: false, error: 'PIN_NOT_FOUND' }, { status: 404 });
    if (user.is_active === false) return NextResponse.json({ ok: false, error: 'USER_DISABLED' }, { status: 403 });

    const { data: dev, error: derr } = await supabase
      .from('tepiha_user_devices')
      .select('id, is_approved')
      .eq('user_id', user.id)
      .eq('device_id', device_id)
      .maybeSingle();

    if (derr) return NextResponse.json({ ok: false, error: derr.message }, { status: 500 });

    const userRole = String(user.role || '').toUpperCase();
    const approved = userRole === 'ADMIN' ? true : !!dev?.is_approved;
    return NextResponse.json({
      ok: true,
      approved,
      actor: { pin: user.pin, role: userRole, name: user.name || '', user_id: user.id, device_id },
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 500 });
  }
}
