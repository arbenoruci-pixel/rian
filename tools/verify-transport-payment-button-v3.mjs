import fs from 'node:fs';

const page = fs.readFileSync('app/transport/pranimi/page.jsx', 'utf8');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const vite = fs.readFileSync('vite.config.js', 'utf8');
const receivablesMigration = fs.readFileSync('supabase/migrations/20260821143000_transport_receivables_v1.sql', 'utf8');
const receivablesHotfix = fs.readFileSync('supabase/migrations/20260821165000_transport_receivables_security_v2.sql', 'utf8');
const receivablesApi = fs.readFileSync('api/transport/receivables.js', 'utf8');
const receivablesClient = fs.readFileSync('lib/transportReceivablesClient.js', 'utf8');
const transportLogin = fs.readFileSync('app/transport/login/page.jsx', 'utf8');
const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); };

check(page.includes('TRANSPORT_PAYMENT_BUTTON_V3:PAGE'), 'v3 page marker missing');
check(page.includes('function round2(value)'), 'round2 helper missing');
check(page.includes('const paymentActor = await requirePaymentPin({ label: pinLabel });'), 'PIN is not awaited with the real return contract');
check(page.includes("sourceModule: 'TRANSPORT'"), 'transport source is not a literal safe value');
const legacyAppliedDebtOnly = page.includes('const applied = dueNow;');
const ledgerAppliesServerSide = page.includes('const applied = round2(Math.min(cashGiven, dueNow));')
  && page.includes('amountReceived: cashGiven')
  && receivablesMigration.includes('v_applied := least(v_received, round(v_total_due, 2));')
  && receivablesMigration.includes("'COLLECTED',\n      v_allocate,");
check(legacyAppliedDebtOnly || ledgerAppliesServerSide, 'cash-given is still being recorded instead of debt applied');
check(page.includes('orderId: oid'), 'payment verifier orderId key is wrong');
check(page.includes('code: transportCode'), 'payment verifier code key is wrong');
check(!page.includes('const pinResult = requirePaymentPin();'), 'old synchronous PIN bug remains');
check(!page.includes('sourceModule: ARKA_SOURCE_MODULE.TRANSPORT'), 'undefined ARKA_SOURCE_MODULE remains');
check(!page.includes('transportCode: displayCode || code'), 'undefined displayCode/code remains');
check(!page.includes('transportM2: totals.m2'), 'undefined totals remains');
check(!page.includes('clientPhone: fullPhone'), 'undefined fullPhone remains');
check(String(pkg.scripts?.prebuild || '').includes('apply-transport-payment-button-v3.mjs'), 'v3 installer missing from prebuild');
check(String(pkg.scripts?.build || '').includes('test:transport-payment-button-v3'), 'v3 verifier missing from build');
check(vite.includes('query-authority-transport-guard-payment-button-v3'), 'PWA cache generation lost the transport payment guard');
check(page.includes("LEDGER_PAYMENT_STATUSES") && page.includes("'done', 'completed'"), 'completed debt-payment aliases are missing');
check(page.includes('readTransportPaymentIntent(oid)') && page.includes('paymentIntent.idempotencyKey'), 'stable retry idempotency intent is missing');
check(!page.includes("idempotencyKey: 'TRANSPORT_CLIENT_PAYMENT:' + oid + ':' + Date.now()"), 'per-tap payment idempotency key remains');
check(page.includes('Math.max(ledgerDebt, legacyDebt)'), 'legacy debt warning fallback is missing');
check(page.includes('allowDebt={isDeliveryFinalizeFlow'), 'deliver-with-debt is not restricted to an active delivery');

check(receivablesApi.includes("readCookie(req, 'tepiha_device_id')"), 'receivables endpoint lacks approved-device authentication');
check(receivablesApi.includes("is_hybrid_transport") && receivablesApi.includes("role === 'PUNTOR'"), 'hybrid transport role authorization is missing');
check(receivablesApi.includes('authorizeOrder') && receivablesApi.includes('ORDER_NOT_ASSIGNED_TO_ACTOR'), 'order assignment authorization is missing');
check(receivablesApi.includes('authorizeClient') && receivablesApi.includes('CLIENT_NOT_ASSIGNED_TO_ACTOR'), 'client-only summary authorization is missing');
check(receivablesApi.includes('requestOriginAllowed') && receivablesApi.includes('ORIGIN_NOT_ALLOWED'), 'same-origin mutation guard is missing');
check(receivablesApi.includes("private, no-store") && receivablesApi.includes("x-content-type-options"), 'private API cache/security headers are missing');
check(receivablesApi.includes('sanitizeRpcResult(result)'), 'receivables API exposes raw RPC output');
check(receivablesApi.includes('p_actor_pin: auth.user.pin'), 'server-derived actor PIN is missing');
check(receivablesClient.includes("credentials: 'same-origin'"), 'receivables client does not bind requests to device session');
check(transportLogin.includes("fetch('/api/auth/login'") && transportLogin.includes('getDeviceId()'), 'dedicated transport login does not establish server device auth');

check(receivablesMigration.includes('transport_order_active_arka_paid_v1'), 'active ARKA reconciliation helper is missing');
check(receivablesMigration.includes("status in ('ACCEPTED_BY_DISPATCH', 'COLLECTED', 'PENDING_DISPATCH_APPROVAL')"), 'active ARKA status whitelist is missing');
check(receivablesMigration.includes("'requiresReconciliation', v_requires_reconciliation"), 'legacy completed-order reconciliation guard is missing');
check(receivablesMigration.includes('and v_is_delivery then'), 'legacy done orders can still be auto-created as debt');
check(receivablesMigration.includes('PAYMENT_IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD'), 'server replay payload guard is missing');
check(receivablesMigration.includes('0, -- Debt-settlement cash must not drive collector transport commission.'), 'cash allocations can still double transport commission');
check(receivablesHotfix.includes('M2=0 CASH_ALLOCATION_V2'), 'live V1 allocation normalization is missing');

if (failures.length) {
  console.error('FAIL transport payment button v3:', failures);
  process.exit(1);
}
console.log('PASS transport payment button v3');
