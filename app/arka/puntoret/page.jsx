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

    // 1. Validimi i Adminit (Anashkalon nëse je ti Masteri)
    let isAuthorized = false;
    let adminId = null;

    if (master_pin === '2380') {
      isAuthorized = true;
    } else {
      const { data: master, error: merr } = await supabase
        .from('tepiha_users')
        .select('id, pin, role, is_active')
        .eq('pin', master_pin)
        .maybeSingle();

      if (!merr && master && master.is_active !== false && String(master.role || '').toUpperCase() === 'ADMIN') {
        isAuthorized = true;
        adminId = master.id;
      }
    }

    if (!isAuthorized) {
      return NextResponse.json({ ok: false, error: 'VETËM ADMINI MUND TË BËJË APROVIME' }, { status: 403 });
    }

    // 2. Leximi i listës së pajisjeve
    if (action === 'list') {
      const { data: devices, error } = await supabase
        .from('tepiha_user_devices')
        .select('id, user_id, device_id, is_approved, label, requested_pin, requested_role, created_at, approved_at, approved_by')
        .order('created_at', { ascending: false })
        .limit(200);

      if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });

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

    // 3. KRIJIMI I PUNTORIT TË RI + APROVIMI
    if (action === 'create_user_and_approve') {
      const { name, role, pin, device_id, label } = body;
      
      // Shkruajmë te tabela `users`
      const { data: newUser, error: createErr } = await supabase
        .from('users')
        .insert([{ name, role, pin, is_active: true }])
        .select()
        .single();

      if (createErr) {
          if (createErr.message.includes('unique') || createErr.message.includes('duplicate')) {
              return NextResponse.json({ ok: false, error: 'KY PIN EKZISTON! ZGJIDH TJETËR OSE PËRDOR BUTONIN "LIDH EKZISTUES".' }, { status: 400 });
          }
          return NextResponse.json({ ok: false, error: createErr.message }, { status: 500 });
      }

      // Aprovo pajisjen dhe lidhe me userin e ri
      const { error: approveErr } = await supabase
        .from('tepiha_user_devices')
        .update({ 
          is_approved: true, 
          approved_at: new Date().toISOString(), 
          approved_by: adminId, 
          label: label || null,
          user_id: newUser.id
        })
        .eq('device_id', device_id);

      if (approveErr) return NextResponse.json({ ok: false, error: approveErr.message }, { status: 500 });
      return NextResponse.json({ ok: true });
    }

    // 4. LIDHJA E PUNTORIT EKZISTUES + APROVIMI
    if (action === 'link_user_and_approve') {
      const { pin, device_id, label } = body;

      const { data: existingUser, error: findErr } = await supabase
        .from('tepiha_users')
        .select('id, name')
        .eq('pin', pin)
        .maybeSingle();

      if (findErr || !existingUser) return NextResponse.json({ ok: false, error: 'PIN NUK U GJET NË SISTEM' }, { status: 404 });

      const { error: approveErr } = await supabase
        .from('tepiha_user_devices')
        .update({ 
          is_approved: true, 
          approved_at: new Date().toISOString(), 
          approved_by: adminId, 
          label: label || null,
          user_id: existingUser.id
        })
        .eq('device_id', device_id);

      if (approveErr) return NextResponse.json({ ok: false, error: approveErr.message }, { status: 500 });
      return NextResponse.json({ ok: true });
    }

    // 5. Heqja e aprovimit (Bllokimi i telefonit)
    if (action === 'revoke') {
      const id = String(body?.id || '').trim();
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
