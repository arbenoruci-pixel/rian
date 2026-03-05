import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

function getAdminClient() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
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
  return r || 'PUNTOR';
}

async function fetchUserByPinSafe(supabase, pin) {
  // Prefer base table to avoid VIEW column-mismatch issues.
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

async function upsertPendingDevice(supabase, { device_id, requested_pin, requested_role }) {
  // Device rows should be unique by device_id (recommended). If your DB still uses (user_id,device_id),
  // this upsert will still work when there is only one row per device.
  try {
    await supabase
      .from('tepiha_user_devices')
      .upsert(
        {
          device_id,
          is_approved: false,
          requested_pin: requested_pin || null,
          requested_role: requested_role || null,
        },
        { onConflict: 'device_id' }
      );
  } catch {
    // Fallback for older schema (no unique on device_id)
    await supabase.from('tepiha_user_devices').insert([
      {
        device_id,
        is_approved: false,
        requested_pin: requested_pin || null,
        requested_role: requested_role || null,
      },
    ]);
  }
}

export async function POST(req) {
  try {
    const body = await req.json().catch(() => ({}));
    const pin = normPin(body?.pin);
    const device_id = String(body?.deviceId || '').trim();
    const requested_role = normRole(body?.role);

    if (!pin || !device_id) {
      return NextResponse.json({ ok: false, error: 'MISSING_FIELDS' }, { status: 400 });
    }

    const supabase = getAdminClient();
    if (!supabase) return NextResponse.json({ ok: false, error: 'SERVER_NOT_CONFIGURED' }, { status: 500 });

    // 1) Find user by PIN
    const { user, error: uerr } = await fetchUserByPinSafe(supabase, pin);

    if (uerr) return NextResponse.json({ ok: false, error: uerr.message }, { status: 500 });

    // If PIN doesn't exist yet: register device as PENDING so Admin can see it, then block.
    if (!user) {
      await upsertPendingDevice(supabase, { device_id, requested_pin: pin, requested_role });
      return NextResponse.json(
        { ok: false, error: 'PIN_NOT_FOUND', deviceId: device_id },
        { status: 404 }
      );
    }

    if (user.is_active === false) return NextResponse.json({ ok: false, error: 'USER_DISABLED' }, { status: 403 });

    const role = String(user.role || '').toUpperCase();
    const isAdmin = role === 'ADMIN';
    const isMaster = !!user.is_master;

    // 2) Load device record by device_id (preferred)
    const { data: dev, error: derr } = await supabase
      .from('tepiha_user_devices')
      .select('id, user_id, device_id, is_approved')
      .eq('device_id', device_id)
      .maybeSingle();

    if (derr) return NextResponse.json({ ok: false, error: derr.message }, { status: 500 });

    // 3) If device doesn't exist, create as pending linked to this user
    if (!dev) {
      // Master admin can auto-approve their own new device
      const autoApprove = isAdmin && isMaster;
      await supabase
        .from('tepiha_user_devices')
        .insert([
          {
            device_id,
            user_id: user.id,
            is_approved: autoApprove,
            approved_at: autoApprove ? new Date().toISOString() : null,
            requested_pin: pin,
            requested_role,
          },
        ]);

      if (!autoApprove) {
        return NextResponse.json({ ok: false, error: 'DEVICE_NOT_APPROVED', deviceId: device_id }, { status: 403 });
      }

      return NextResponse.json({
        ok: true,
        actor: { pin: user.pin, role, name: user.name || '', user_id: user.id, device_id },
      });
    }

    // 4) If device is linked to another user, block (prevents device hijack)
    if (dev.user_id && dev.user_id !== user.id) {
      // Allow MASTER ADMIN to reclaim if needed (rare). Everyone else: block.
      if (!(isAdmin && isMaster)) {
        return NextResponse.json({ ok: false, error: 'DEVICE_OWNED_BY_OTHER_USER' }, { status: 403 });
      }
    }

    // 5) Ensure device is linked to this user_id (and store request metadata)
    // Note: safe update even if already correct.
    const { error: linkErr } = await supabase
      .from('tepiha_user_devices')
      .update({
        user_id: user.id,
        requested_pin: pin,
        requested_role,
      })
      .eq('id', dev.id);

    if (linkErr) return NextResponse.json({ ok: false, error: linkErr.message }, { status: 500 });

    // 6) Approval gate
    const approved = !!dev.is_approved;

    if (!approved) {
      // Master admin can auto-approve ONLY their own device.
      if (isAdmin && isMaster) {
        await supabase
          .from('tepiha_user_devices')
          .update({ is_approved: true, approved_at: new Date().toISOString(), approved_by: user.id })
          .eq('id', dev.id);
      } else {
        return NextResponse.json({ ok: false, error: 'DEVICE_NOT_APPROVED', deviceId: device_id }, { status: 403 });
      }
    }

    return NextResponse.json({
      ok: true,
      actor: { pin: user.pin, role, name: user.name || '', user_id: user.id, device_id },
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 500 });
  }
}
