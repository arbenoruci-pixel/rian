import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

function getAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SERVICE_ROLE;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

function normPin(pin) {
  const p = String(pin ?? '').trim();
  if (!/^[0-9]{4,8}$/.test(p)) return null;
  return p;
}

function normRole(role) {
  const r = String(role || '').trim().toUpperCase();
  if (!r) return 'PUNTOR';
  return r;
}

async function fetchUserByPinSafe(supabase, pin) {
  const TABLE = 'users';
  const STRICT = 'id, pin, role, name, is_active, is_master';
  const FALLBACK = 'id, pin, role, name';

  let user = null;
  let error = null;

  {
    const r1 = await supabase.from(TABLE).select(STRICT).eq('pin', pin).maybeSingle();
    user = r1.data;
    error = r1.error;
  }

  if (error) {
    const msg = String(error?.message || '').toLowerCase();
    const missingCol = msg.includes('column') && msg.includes('does not exist');
    if (missingCol) {
      const r2 = await supabase.from(TABLE).select(FALLBACK).eq('pin', pin).maybeSingle();
      user = r2.data ? { ...r2.data, is_active: true, is_master: false } : null;
      error = r2.error;
    }
  }

  return { user, error };
}

export async function POST(req) {
  try {
    const supabase = getAdminClient();
    if (!supabase) return NextResponse.json({ ok: false, error: 'SERVER_NOT_CONFIGURED' }, { status: 500 });

    const body = await req.json().catch(() => ({}));
    const action = String(body?.action || '');
    const master_pin = normPin(body?.master_pin);

    if (!master_pin) {
      return NextResponse.json({ ok: false, error: 'MASTER_PIN_REQUIRED' }, { status: 400 });
    }

    // ✅ Authorize ONLY: ADMIN + is_master=true
    const { user: master, error: merr } = await fetchUserByPinSafe(supabase, master_pin);

    if (merr) return NextResponse.json({ ok: false, error: merr.message }, { status: 500 });

    const isAdmin = String(master?.role || '').toUpperCase() === 'ADMIN';
    const isMaster = !!master?.is_master;
    const isActive = master?.is_active !== false;

    if (!master || !isActive || !isAdmin || !isMaster) {
      return NextResponse.json({ ok: false, error: 'VETËM MASTER ADMIN (is_master=true) MUND TË BËJË APROVIME' }, { status: 403 });
    }

    const adminId = master.id;

    // 1) List devices
    if (action === 'list') {
      // Show latest devices, including those with no linked user yet.
      const { data: devices, error } = await supabase
        .from('tepiha_user_devices')
        .select('id, user_id, device_id, is_approved, label, requested_pin, requested_role, created_at, approved_at, approved_by')
        .order('created_at', { ascending: false })
        .limit(300);

      if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

      const userIds = [...new Set((devices || []).map((d) => d.user_id).filter(Boolean))];
      const pinSet = [...new Set((devices || []).map((d) => d.requested_pin).filter(Boolean))];

      let usersMap = {};

      if (userIds.length > 0) {
        const { data: usersData } = await supabase
          .from('users')
          .select('id, name, role, pin, is_active, is_master')
          .in('id', userIds);

        (usersData || []).forEach((u) => {
          usersMap[u.id] = u;
        });
      }

      // If some devices are still unlinked (user_id null), try to resolve by requested_pin
      if (pinSet.length > 0) {
        const { data: usersByPin } = await supabase
          .from('users')
          .select('id, name, role, pin, is_active, is_master')
          .in('pin', pinSet);

        (usersByPin || []).forEach((u) => {
          // map by pin as well
          usersMap[`pin:${u.pin}`] = u;
        });
      }

      const items = (devices || []).map((d) => {
        const u = d.user_id ? usersMap[d.user_id] : usersMap[`pin:${d.requested_pin}`] || null;
        return { ...d, tepiha_users: u };
      });

      return NextResponse.json({ ok: true, items });
    }

    // 2) Approve / revoke
    if (action === 'approve' || action === 'revoke') {
      const id = String(body?.id || '').trim();
      if (!id) return NextResponse.json({ ok: false, error: 'MISSING_ID' }, { status: 400 });

      if (action === 'approve') {
        const label = body?.label == null ? null : String(body.label);
        const { error } = await supabase
          .from('tepiha_user_devices')
          .update({ is_approved: true, approved_at: new Date().toISOString(), approved_by: adminId, label })
          .eq('id', id);

        if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
        return NextResponse.json({ ok: true });
      }

      const { error } = await supabase
        .from('tepiha_user_devices')
        .update({ is_approved: false, approved_at: null, approved_by: null })
        .eq('id', id);

      if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
      return NextResponse.json({ ok: true });
    }

    // 3) Create user + link device + approve (one-click)
    if (action === 'create_user_and_approve') {
      const name = String(body?.name || '').trim();
      const role = normRole(body?.role);
      const pin = normPin(body?.pin);
      const device_id = String(body?.device_id || '').trim();
      const label = body?.label == null ? null : String(body.label);

      if (!name || !pin || !device_id) {
        return NextResponse.json({ ok: false, error: 'MISSING_FIELDS' }, { status: 400 });
      }

      // Prevent duplicate PIN
      const { data: existing } = await supabase
        .from('users')
        .select('id')
        .eq('pin', pin)
        .maybeSingle();

      if (existing?.id) return NextResponse.json({ ok: false, error: 'PIN_ALREADY_EXISTS' }, { status: 409 });

      const { data: user, error: uerr } = await supabase
        .from('users')
        .insert([{ name, role, pin, is_active: true, is_master: false }])
        .select('id,name,role,pin,is_active')
        .single();

      if (uerr) return NextResponse.json({ ok: false, error: uerr.message }, { status: 500 });

      // Upsert device by device_id
      const devicePayload = {
        device_id,
        user_id: user.id,
        is_approved: true,
        approved_at: new Date().toISOString(),
        approved_by: adminId,
        label,
        requested_pin: pin,
        requested_role: role,
      };

      let dev = null;
      try {
        const { data: d, error: derr } = await supabase
          .from('tepiha_user_devices')
          .upsert(devicePayload, { onConflict: 'device_id' })
          .select('id,device_id,user_id,is_approved,label')
          .single();

        if (derr) throw derr;
        dev = d;
      } catch {
        // Fallback for older schema
        const { data: d2, error: derr2 } = await supabase
          .from('tepiha_user_devices')
          .insert([devicePayload])
          .select('id,device_id,user_id,is_approved,label')
          .single();
        if (derr2) return NextResponse.json({ ok: false, error: derr2.message }, { status: 500 });
        dev = d2;
      }

      return NextResponse.json({ ok: true, user, device: dev });
    }

    // 4) Link an existing user to a device + approve
    if (action === 'link_user_and_approve') {
      const pin = normPin(body?.pin);
      const device_id = String(body?.device_id || '').trim();
      const label = body?.label == null ? null : String(body.label);

      if (!pin || !device_id) {
        return NextResponse.json({ ok: false, error: 'MISSING_FIELDS' }, { status: 400 });
      }

      const { data: user, error: uerr } = await supabase
        .from('users')
        .select('id,name,role,pin,is_active,is_master')
        .eq('pin', pin)
        .maybeSingle();

      if (uerr) return NextResponse.json({ ok: false, error: uerr.message }, { status: 500 });
      if (!user) return NextResponse.json({ ok: false, error: 'PIN_NOT_FOUND' }, { status: 404 });
      if (user.is_active === false) return NextResponse.json({ ok: false, error: 'USER_DISABLED' }, { status: 403 });

      const payload = {
        device_id,
        user_id: user.id,
        is_approved: true,
        approved_at: new Date().toISOString(),
        approved_by: adminId,
        label,
        requested_pin: pin,
        requested_role: String(user.role || '').toUpperCase(),
      };

      let dev = null;
      try {
        const { data: d, error: derr } = await supabase
          .from('tepiha_user_devices')
          .upsert(payload, { onConflict: 'device_id' })
          .select('id,device_id,user_id,is_approved,label')
          .single();
        if (derr) throw derr;
        dev = d;
      } catch {
        const { data: d2, error: derr2 } = await supabase
          .from('tepiha_user_devices')
          .insert([payload])
          .select('id,device_id,user_id,is_approved,label')
          .single();
        if (derr2) return NextResponse.json({ ok: false, error: derr2.message }, { status: 500 });
        dev = d2;
      }

      return NextResponse.json({ ok: true, user, device: dev });
    }

    return NextResponse.json({ ok: false, error: 'UNKNOWN_ACTION' }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 500 });
  }
}
