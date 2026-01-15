import { NextResponse } from 'next/server';
import { getServiceSupabase } from '../_lib/sbAdmin';
import { BACKUPS_TABLE, getReqPin, requirePinOrBypass } from '../_lib/utils';

export const dynamic = 'force-dynamic';

export async function GET(req) {
  try {
    const sb = getServiceSupabase();
    const pin = getReqPin(req);
    const pinDecision = requirePinOrBypass(pin);
    if (!pinDecision.ok) {
      return NextResponse.json({ ok: false, error: pinDecision.error }, { status: 401 });
    }

    const u = new URL(req.url);
    const limit = Math.max(1, Math.min(50, Number(u.searchParams.get('limit') || 15)));

    let q = sb.from(BACKUPS_TABLE).select('id,created_at,device,pin,has_payload').order('created_at', { ascending: false }).limit(limit);
    if (pinDecision.pin) q = q.eq('pin', pinDecision.pin);

    const { data, error } = await q;
    if (error) {
      return NextResponse.json({ ok: false, error: 'SUPABASE_BACKUPS_QUERY_FAILED', detail: error.message }, { status: 500 });
    }

    return NextResponse.json({ ok: true, items: data || [], table: BACKUPS_TABLE, used_pin: pinDecision.pin || null });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 500 });
  }
}
