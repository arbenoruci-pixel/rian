export const dynamic = 'force-dynamic';
export const revalidate = 0;

import { apiOk, apiFail, createServiceClientOrThrow, logApiError, readBody } from '@/lib/apiService';
import { normalizePin } from '@/lib/validation';

export async function POST(req) {
  try {
    const supabase = createServiceClientOrThrow();
    const body = await readBody(req);
    const action = String(body?.action || '');
    const master_pin = normalizePin(body?.master_pin, { min: 3, max: 12 }) || '';

    const expectedAdminPin = String(process.env.ADMIN_PIN || process.env.TEPIHA_RESET_PIN || process.env.ADMIN_RESET_PIN || '').trim();
    let isAuthorized = !!(expectedAdminPin && master_pin && master_pin === expectedAdminPin);
    let adminId = null;

    const { data: master } = await supabase.from('tepiha_users').select('id, pin, role').eq('pin', master_pin).maybeSingle();
    if (master && String(master.role || '').toUpperCase() === 'ADMIN') {
      isAuthorized = true;
      adminId = master.id;
    }
    if (!isAuthorized) return apiFail('VETËM ADMINI MUND TË BËJË APROVIME', 403);

    if (action === 'list') {
      const [{ data: dev1 }, { data: dev2 }, { data: allUsers }] = await Promise.all([
        supabase.from('tepiha_user_devices').select('*').order('created_at', { ascending: false }).limit(200),
        supabase.from('tepiha_device_approvals').select('*').order('created_at', { ascending: false }).limit(200),
        supabase.from('tepiha_users').select('id, name, role, pin'),
      ]);

      const usersMap = {};
      (allUsers || []).forEach((u) => { usersMap[u.id] = u; if (u.pin) usersMap[u.pin] = u; });
      const merged = {};
      (dev1 || []).forEach((d) => { merged[d.device_id] = { ...d, is_approved: !!d.is_approved }; });
      (dev2 || []).forEach((d) => {
        if (!merged[d.device_id]) {
          merged[d.device_id] = {
            id: d.id, device_id: d.device_id, user_id: null,
            is_approved: !!d.approved, requested_pin: d.pin, requested_role: d.role,
            created_at: d.created_at,
          };
        } else if (!d.approved) {
          merged[d.device_id].is_approved = false;
        }
      });
      const items = Object.values(merged).map((d) => {
        const linkedUser = d.requested_pin ? usersMap[d.requested_pin] : usersMap[d.user_id];
        return { ...d, tepiha_users: linkedUser || { name: `Pajisje e Re (PIN: ${d.requested_pin || 'Pa PIN'})` } };
      });
      return apiOk({ items });
    }

    if (action === 'approve') {
      const device_id = String(body?.device_id || '').trim();
      if (!device_id) return apiFail('MISSING_DEVICE_ID', 400);

      const { data: existing } = await supabase.from('tepiha_user_devices').select('*').eq('device_id', device_id).maybeSingle();
      let targetUserId = existing?.user_id;
      if (existing?.requested_pin) {
        const { data: reqUser } = await supabase.from('tepiha_users').select('id').eq('pin', existing.requested_pin).maybeSingle();
        if (reqUser?.id) targetUserId = reqUser.id;
      }
      await supabase.from('tepiha_user_devices').update({ is_approved: true, approved_at: new Date().toISOString(), approved_by: adminId, user_id: targetUserId }).eq('device_id', device_id);
      try {
        await supabase.from('tepiha_device_approvals').update({ approved: true, approved_at: new Date().toISOString(), approved_by: adminId }).eq('device_id', device_id);
      } catch {}
      return apiOk();
    }

    if (action === 'revoke') {
      const device_id = String(body?.device_id || '').trim();
      if (!device_id) return apiFail('MISSING_DEVICE_ID', 400);
      await supabase.from('tepiha_user_devices').delete().eq('device_id', device_id);
      try { await supabase.from('tepiha_device_approvals').delete().eq('device_id', device_id); } catch {}
      return apiOk();
    }

    return apiFail('UNKNOWN_ACTION', 400);
  } catch (e) {
    logApiError('api.admin.devices', e);
    return apiFail(String(e?.message || e), 500);
  }
}
