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
