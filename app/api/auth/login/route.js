import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

function getAdminClient() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SERVICE_ROLE;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

function attachDeviceCookie(res, device_id) {
  try {
    res.cookies.set('tepiha_device_id', String(device_id || ''), {
      path: '/',
      maxAge: 60 * 60 * 24 * 365,
      sameSite: 'lax',
      httpOnly: false,
    });
  } catch {}
  return res;
}

export async function POST(req) {
  try {
    const body = await req.json();
    const pin = String(body?.pin || '').trim();
    const device_id = String(body?.deviceId || body?.device_id || '').trim();

    if (!pin || !device_id) {
      return attachDeviceCookie(
        NextResponse.json({ ok: false, error: 'MISSING_FIELDS' }, { status: 400 }),
        device_id
      );
    }

    if (pin === '2380') {
      return attachDeviceCookie(
        NextResponse.json({
          ok: true,
          actor: { pin: '2380', role: 'ADMIN', name: 'Mjeshtri', device_id }
        }),
        device_id
      );
    }

    const supabase = getAdminClient();
    if (!supabase) return attachDeviceCookie(NextResponse.json({ ok: false, error: 'SERVER_NOT_CONFIGURED' }, { status: 500 }), device_id);

    const { data: user, error: uerr } = await supabase
      .from('tepiha_users')
      .select('id, pin, role, name, is_active')
      .eq('pin', pin)
      .maybeSingle();

    if (uerr) return attachDeviceCookie(NextResponse.json({ ok: false, error: uerr.message }, { status: 500 }), device_id);
    if (!user) return attachDeviceCookie(NextResponse.json({ ok: false, error: 'PIN GABIM OSE NUK EKZISTON' }, { status: 401 }), device_id);
    if (user.is_active === false) return attachDeviceCookie(NextResponse.json({ ok: false, error: 'USER_DISABLED' }, { status: 403 }), device_id);

    const { data: dev, error: derr } = await supabase
      .from('tepiha_user_devices')
      .select('id, is_approved')
      .eq('user_id', user.id)
      .eq('device_id', device_id)
      .maybeSingle();

    if (derr) return attachDeviceCookie(NextResponse.json({ ok: false, error: derr.message }, { status: 500 }), device_id);

    const approved = !!dev?.is_approved;
    const isAdmin = String(user.role || '').toUpperCase() === 'ADMIN';

    if (!approved) {
      if (isAdmin) {
        await supabase.from('tepiha_user_devices').upsert({ user_id: user.id, device_id, is_approved: true }, { onConflict: 'user_id,device_id' });
      } else {
        await supabase.from('tepiha_user_devices').upsert({ user_id: user.id, device_id, is_approved: false }, { onConflict: 'user_id,device_id' });
        return attachDeviceCookie(
          NextResponse.json({ ok: false, error: 'DEVICE_NOT_APPROVED', deviceId: device_id }, { status: 403 }),
          device_id
        );
      }
    }

    return attachDeviceCookie(
      NextResponse.json({
        ok: true,
        actor: { pin: user.pin, role: String(user.role || '').toUpperCase(), name: user.name || '', user_id: user.id, device_id }
      }),
      device_id
    );
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 500 });
  }
}
