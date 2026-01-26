import { NextResponse } from 'next/server';
import { adminClient } from '../_lib/dbdaily';

export const runtime = 'nodejs';

// Called by Vercel Cron (vercel.json)
export async function GET() {
  try {
    const sb = adminClient();
    const { error } = await sb.rpc('run_daily_backup', { retention_days: 30 });
    if (error) {
      const { error: error2 } = await sb.rpc('run_daily_backup');
      if (error2) return NextResponse.json({ ok: false, error: 'RPC_FAILED', detail: error2.message }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: 'CRON_FAILED', detail: e?.message || String(e) }, { status: 500 });
  }
}
