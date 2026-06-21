import { NextResponse } from 'next/server';
import { adminClient } from '../_lib/dbdaily';
import { backupUnauthorized, requireBackupPin } from '../_lib/auth';
export const dynamic = 'force-dynamic';

export const runtime = 'nodejs';

export async function GET(req) {
  try {
    const auth = requireBackupPin(req, { allowCron: true });
    if (!auth.ok || auth.via !== 'cron') {
      return backupUnauthorized(auth.ok ? { ok: false, status: 401, error: 'CRON_SECRET_REQUIRED' } : auth);
    }

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
