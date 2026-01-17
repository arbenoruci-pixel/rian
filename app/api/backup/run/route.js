import { NextResponse } from 'next/server';
import { adminClient, requirePinFromReq } from '../_lib/dbdaily';

export const runtime = 'nodejs';

export async function POST(req) {
  try {
    const pinCheck = requirePinFromReq(req);
    if (!pinCheck.ok) return NextResponse.json({ ok: false, error: pinCheck.error }, { status: 401 });

    const sb = adminClient();

    // run RPC that writes to backups_daily
    const { error } = await sb.rpc('run_daily_backup', { retention_days: 30 });
    if (error) {
      // fallback: some versions created it as (retention_days int default 30) without named arg
      const { error: error2 } = await sb.rpc('run_daily_backup');
      if (error2) {
        return NextResponse.json({ ok: false, error: 'RPC_FAILED', detail: error2.message }, { status: 500 });
      }
    }

    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: 'RUN_FAILED', detail: e?.message || String(e) }, { status: 500 });
  }
}

// allow GET for one-click manual run (kept for convenience)
export async function GET(req) {
  return POST(req);
}
