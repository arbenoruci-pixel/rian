import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

function getAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SERVICE_ROLE;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

export async function POST(req) {
  try {
    const supabase = getAdminClient();
    if (!supabase) return NextResponse.json({ ok: false, error: 'SERVER_NOT_CONFIGURED' }, { status: 500 });

    const body = await req.json();
    const action = String(body?.action || '');
    const master_pin = String(body?.master_pin || '').trim();

    // 👑 1. Validimi i Adminit (Me Master Key-n e Integruar)
    let isAuthorized = false;
    let adminId = null;

    if (master_pin === '2380') {
      isAuthorized = true;
    }

    // Hequr 'is_master' për të shmangur crash-in e databazës
    const { data: master, error: merr } = await supabase
      .from('tepiha_users')
      .select('id, pin, role, is_active, name')
      .eq('pin', master_pin)
      .maybeSingle();

    if (merr) return NextResponse.json({ ok: false, error: merr.message }, { status: 500 });

    if (master && master.is_active !== false && String(master.role || '').toUpperCase() === 'ADMIN') {
      isAuthorized = true;
      adminId = master.id;
    }

    if (!isAuthorized) {
      return NextResponse.json({ ok: false, error: 'VETËM ADMINI MUND TË BËJË APROVIME' }, { status: 403 });
    }

    // 🛠️ 2. Leximi i pajisjeve (Zgjidhja e problemit të VIEW)
    if (action === 'list') {
      const { data: devices, error } = await supabase
        .from('tepiha_user_devices')
        .select('id, user_id, device_id, is_approved, label, created_at, approved_at, approved_by')
        .order('created_at', { ascending: false })
        .limit(200);

      if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

      // Bashkimi manual sepse tepiha_users është VIEW dhe nuk suporton Join të drejtpërdrejtë
      const userIds = [...new Set((devices || []).map(d => d.user_id).filter(Boolean))];
      let usersMap = {};
      
      if (userIds.length > 0) {
         const { data: usersData } = await supabase
           .from('tepiha_users')
           .select('id, name, role, pin')
           .in('id', userIds);
         
         (usersData || []).forEach(u => { usersMap[u.id] = u; });
      }

      const items = (devices || []).map(d => ({
         ...d,
         tepiha_users: usersMap[d.user_id] || null
      }));

      return NextResponse.json({ ok: true, items });
    }

    // 3. Aprovimi i pajisjes
    if (action === 'approve') {
      const id = String(body?.id || '').trim();
      const label = body?.label == null ? null : String(body.label);
      if (!id) return NextResponse.json({ ok: false, error: 'MISSING_ID' }, { status: 400 });

      const { error } = await supabase
        .from('tepiha_user_devices')
        .update({ is_approved: true, approved_at: new Date().toISOString(), approved_by: adminId, label })
        .eq('id', id);

      if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
      return NextResponse.json({ ok: true });
    }

    // 3b. Krijo user + aprovo pajisjen (Single Dashboard)
    // - Krijimi bëhet në TABLE `users`
    // - Pajisja aprovohet në `tepiha_user_devices` dhe lidhet me user_id
    if (action === 'create_user_and_approve') {
      const deviceRowId = String(body?.device_row_id || body?.id || '').trim();
      const name = String(body?.name || '').trim();
      const role = String(body?.role || 'WORKER').trim();
      const pin = String(body?.pin || '').trim();
      const label = body?.label == null ? null : String(body.label);

      if (!deviceRowId) return NextResponse.json({ ok: false, error: 'MISSING_DEVICE_ROW_ID' }, { status: 400 });
      if (!name) return NextResponse.json({ ok: false, error: 'MISSING_NAME' }, { status: 400 });
      if (!pin) return NextResponse.json({ ok: false, error: 'MISSING_PIN' }, { status: 400 });

      // 1) Sigurohu që PIN s’është i zënë (lexim nga VIEW)
      const { data: existing, error: exErr } = await supabase
        .from('tepiha_users')
        .select('id, pin')
        .eq('pin', pin)
        .maybeSingle();
      if (exErr) return NextResponse.json({ ok: false, error: exErr.message }, { status: 500 });
      if (existing?.id) return NextResponse.json({ ok: false, error: 'PIN_ALREADY_EXISTS' }, { status: 409 });

      // 2) Krijo user-in në TABLE reale `users`
      const { data: created, error: cErr } = await supabase
        .from('users')
        .insert({
          name,
          role: role.toUpperCase(),
          pin,
          is_active: true,
          is_master: false,
        })
        .select('id')
        .single();
      if (cErr) return NextResponse.json({ ok: false, error: cErr.message }, { status: 500 });
      const newUserId = created?.id;
      if (!newUserId) return NextResponse.json({ ok: false, error: 'USER_CREATE_FAILED' }, { status: 500 });

      // 3) Aprovimi + lidhja e pajisjes
      const { error: aErr } = await supabase
        .from('tepiha_user_devices')
        .update({
          user_id: newUserId,
          is_approved: true,
          approved_at: new Date().toISOString(),
          approved_by: adminId,
          label,
        })
        .eq('id', deviceRowId);
      if (aErr) return NextResponse.json({ ok: false, error: aErr.message }, { status: 500 });

      return NextResponse.json({ ok: true, user_id: newUserId });
    }

    // 3c. Lidhu me user ekzistues (me PIN) + aprovo pajisjen
    // - User lookup bëhet nga VIEW `tepiha_users`
    // - Update pajisja në `tepiha_user_devices`
    if (action === 'link_user_and_approve') {
      const deviceRowId = String(body?.device_row_id || body?.id || '').trim();
      const pin = String(body?.pin || '').trim();
      const label = body?.label == null ? null : String(body.label);

      if (!deviceRowId) return NextResponse.json({ ok: false, error: 'MISSING_DEVICE_ROW_ID' }, { status: 400 });
      if (!pin) return NextResponse.json({ ok: false, error: 'MISSING_PIN' }, { status: 400 });

      const { data: u, error: uErr } = await supabase
        .from('tepiha_users')
        .select('id, pin, is_active, role')
        .eq('pin', pin)
        .maybeSingle();
      if (uErr) return NextResponse.json({ ok: false, error: uErr.message }, { status: 500 });
      if (!u?.id) return NextResponse.json({ ok: false, error: 'USER_NOT_FOUND' }, { status: 404 });
      if (u.is_active === false) return NextResponse.json({ ok: false, error: 'USER_INACTIVE' }, { status: 403 });

      const { error: aErr } = await supabase
        .from('tepiha_user_devices')
        .update({
          user_id: u.id,
          is_approved: true,
          approved_at: new Date().toISOString(),
          approved_by: adminId,
          label,
        })
        .eq('id', deviceRowId);
      if (aErr) return NextResponse.json({ ok: false, error: aErr.message }, { status: 500 });

      return NextResponse.json({ ok: true, user_id: u.id });
    }

    // 4. Heqja e aprovimit (Bllokimi)
    if (action === 'revoke') {
      const id = String(body?.id || '').trim();
      if (!id) return NextResponse.json({ ok: false, error: 'MISSING_ID' }, { status: 400 });

      const { error } = await supabase
        .from('tepiha_user_devices')
        .update({ is_approved: false, approved_at: null, approved_by: null })
        .eq('id', id);

      if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ ok: false, error: 'UNKNOWN_ACTION' }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 500 });
  }
}
