import { NextResponse } from 'next/server';
import { getServiceSupabase } from '../_lib/sbAdmin';
import { BACKUPS_TABLE } from '../_lib/utils';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const sb = getServiceSupabase();

    // table probe
    const { error } = await sb.from(BACKUPS_TABLE).select('id').limit(1);

    const has = {
      NEXT_PUBLIC_SUPABASE_URL: !!process.env.NEXT_PUBLIC_SUPABASE_URL,
      SUPABASE_URL: !!process.env.SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: !!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    };

    return NextResponse.json({
      ok: !error,
      diag: {
        node: process.version,
        backups_table: BACKUPS_TABLE,
        has,
        url_preview: (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '').slice(0, 24),
        table_probe_ok: !error,
        table_probe_error: error ? { message: error.message, code: error.code } : null,
      },
    });
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        error: String(e?.message || e),
        diag: {
          node: process.version,
          backups_table: BACKUPS_TABLE,
        },
      },
      { status: 500 }
    );
  }
}
