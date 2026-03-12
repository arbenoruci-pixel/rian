export const dynamic = 'force-dynamic';
export const revalidate = 0;

import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

function getAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SERVICE_ROLE || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
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

    let isAuthorized = master_pin === '2380';
    let adminId = null;

    const { data: master } = await supabase.from('tepiha_users').select('id, pin, role').eq('pin', master_pin).maybeSingle();
    if (master && String(master.role || '').toUpperCase() === 'ADMIN') {
      isAuthorized = true;
      adminId = master.id;
    }

    if (!isAuthorized) return NextResponse.json({ ok: false, error: 'VETËM ADMINI MUND TË BËJË APROVIME' }, { status: 403 });

    if (action === 'list') {
      // Lexojmë nga të dyja tabelat njëkohësisht për të mos humbur asnjë kërkesë
      const { data: dev1 } = await supabase.from('tepiha_user_devices').select('*').order('created_at', { ascending: false }).limit(200);
      const { data: dev2 } = await supabase.from('tepiha_device_approvals').select('*').order('created_at', { ascending: false }).limit(200);

      const { data: allUsers } = await supabase.from('tepiha_users').select('id, name, role, pin');
      const usersMap = {};
      (allUsers || []).forEach(u => {
          usersMap[u.id] = u;
          if (u.pin) usersMap[u.pin] = u;
      });

      const merged = {};
      (dev1 || []).forEach(d => {
          merged[d.device_id] = { ...d, is_approved: !!d.is_approved };
      });

      (dev2 || []).forEach(d => {
          if (!merged[d.device_id]) {
              merged[d.device_id] = {
                  id: d.id, device_id: d.device_id, user_id: null,
                  is_approved: !!d.approved, requested_pin: d.pin, requested_role: d.role,
                  created_at: d.created_at
              };
          } else {
              if (!d.approved) merged[d.device_id].is_approved = false;
          }
      });

      const items = Object.values(merged).map(d => {
         const linkedUser = d.requested_pin ? usersMap[d.requested_pin] : usersMap[d.user_id];
         return { ...d, tepiha_users: linkedUser || { name: 'Pajisje e Re (PIN: ' + (d.requested_pin || 'Pa PIN') + ')' } };
      });

      return NextResponse.json({ ok: true, items });
    }

    if (action === 'approve') {
      const device_id = String(body?.device_id || '').trim();
      if (!device_id) return NextResponse.json({ ok: false, error: 'MISSING_DEVICE_ID' }, { status: 400 });

      const { data: existing } = await supabase.from('tepiha_user_devices').select('*').eq('device_id', device_id).maybeSingle();
      let targetUserId = existing?.user_id;

      if (existing?.requested_pin) {
          const { data: reqUser } = await supabase.from('tepiha_users').select('id').eq('pin', existing.requested_pin).maybeSingle();
          if (reqUser?.id) targetUserId = reqUser.id;
      }

      await supabase.from('tepiha_user_devices').update({
          is_approved: true, approved_at: new Date().toISOString(), approved_by: adminId, user_id: targetUserId
      }).eq('device_id', device_id);

      try {
        await supabase.from('tepiha_device_approvals').update({
            approved: true, approved_at: new Date().toISOString(), approved_by: adminId
        }).eq('device_id', device_id);
      } catch(e) {}

      return NextResponse.json({ ok: true });
    }

    if (action === 'revoke') {
      const device_id = String(body?.device_id || '').trim();
      if (!device_id) return NextResponse.json({ ok: false, error: 'MISSING_DEVICE_ID' }, { status: 400 });
      await supabase.from('tepiha_user_devices').delete().eq('device_id', device_id);
      try { await supabase.from('tepiha_device_approvals').delete().eq('device_id', device_id); } catch(e) {}
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ ok: false, error: 'UNKNOWN_ACTION' }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 500 });
  }
}
