import { NextResponse } from 'next/server';
import { runArkaTransaction } from '@/lib/arka/arkaEngine.js';
import { createServiceRoleClientOrThrow } from '@/lib/supabaseAdminClient.js';

export const dynamic = 'force-dynamic';

export async function POST(req) {
  let body = null;
  try {
    body = await req.json();
    const supabase = createServiceRoleClientOrThrow();
    const result = await runArkaTransaction(body || {}, { supabase });
    return NextResponse.json({ ok: true, ...(result || {}) }, { status: 200 });
  } catch (error) {
    const message = String(error?.message || error || 'ARKA_TRANSACTION_FAILED');
    // BELI_STRAIGHT_SALARY_PAYMENT_RECOVERY_V1:API_LOG — safe context for future failed payments.
    try {
      console.error('[ARKA_TRANSACTION_FAILED]', {
        action: String(body?.action || ''),
        actorPin: String(body?.actorPin || body?.actor_pin || ''),
        orderId: body?.orderId || body?.order_id || null,
        transportOrderId: body?.transportOrderId || body?.transport_order_id || null,
        transportCode: String(body?.transportCode || body?.transport_code_str || ''),
        amount: body?.amount ?? null,
        error: message,
      });
    } catch {}
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
