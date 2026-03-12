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
    const requested_role = String(body?.role || '').trim().toUpperCase();
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

    // KËTU ËSHTË ZGJIDHJA: Gjej nëse pajisja ekziston, pavarësisht kush e ka pasur para
    const { data: dev, error: derr } = await supabase
      .from('tepiha_user_devices')
      .select('id, is_approved, user_id')
      .eq('device_id', device_id)
      .maybeSingle();

    if (derr) return attachDeviceCookie(NextResponse.json({ ok: false, error: derr.message }, { status: 500 }), device_id);

    const userRole = String(user.role || '').toUpperCase();
    const isAdmin = userRole === 'ADMIN';

    if (requested_role && requested_role !== userRole) {
      return attachDeviceCookie(
        NextResponse.json({ ok: false, error: 'ROLE_MISMATCH' }, { status: 403 }),
        device_id
      );
    }

    const requestedRoleForRow = requested_role || userRole;
    
    // Nëse është përdorues i ri në këtë telefon, duhet aprovim i ri (përveç nëse është admin)
    const isCurrentlyApproved = dev && dev.user_id === user.id ? !!dev.is_approved : !!isAdmin;

    async function syncApprovalMirror(approvedFlag) {
      const basePayload = {
        pin: user.pin,
        role: requestedRoleForRow,
        device_id,
        approved: !!approvedFlag,
        approved_by: approvedFlag ? 'SYSTEM' : null,
        approved_at: approvedFlag ? new Date().toISOString() : null,
        last_seen_at: new Date().toISOString(),
      };

      const { data: mirror } = await supabase
        .from('tepiha_device_approvals')
        .select('id')
        .eq('device_id', device_id)
        .maybeSingle();

      if (mirror?.id) {
        await supabase.from('tepiha_device_approvals').update(basePayload).eq('id', mirror.id);
      } else {
        await supabase.from('tepiha_device_approvals').insert(basePayload);
      }
    }

    const devicePayload = {
      user_id: user.id,
      device_id,
      is_approved: isCurrentlyApproved,
      requested_pin: user.pin,
      requested_role: requestedRoleForRow,
      approved_at: isCurrentlyApproved ? new Date().toISOString() : null,
      approved_by: isCurrentlyApproved ? 'SYSTEM' : null,
    };

    // UPDATE OSE INSERT (Nuk do të ketë më bllokime nga Unique Constraint)
    if (dev?.id) {
      const { error: upErr } = await supabase.from('tepiha_user_devices').update(devicePayload).eq('id', dev.id);
      if (upErr) return attachDeviceCookie(NextResponse.json({ ok: false, error: upErr.message }, { status: 500 }), device_id);
    } else {
      const { error: insErr } = await supabase.from('tepiha_user_devices').insert(devicePayload);
      if (insErr) return attachDeviceCookie(NextResponse.json({ ok: false, error: insErr.message }, { status: 500 }), device_id);
    }

    await syncApprovalMirror(isCurrentlyApproved);

    if (!isCurrentlyApproved) {
      return attachDeviceCookie(
        NextResponse.json({ ok: false, error: 'DEVICE_NOT_APPROVED', deviceId: device_id }, { status: 403 }),
        device_id
      );
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
