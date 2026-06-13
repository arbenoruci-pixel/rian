import { NextResponse } from 'next/server';
import { runArkaTransaction } from '@/lib/arka/arkaEngine.js';
import { createAdminClientOrThrow } from '@/lib/supabaseAdminClient.js';

export const dynamic = 'force-dynamic';

export async function POST(req) {
  try {
    const body = await req.json();
    const supabase = createAdminClientOrThrow();
    const result = await runArkaTransaction(body || {}, { supabase });
    return NextResponse.json({ ok: true, ...(result || {}) }, { status: 200 });
  } catch (error) {
    return NextResponse.json({ ok: false, error: String(error?.message || error || 'ARKA_TRANSACTION_FAILED') }, { status: 400 });
  }
}
