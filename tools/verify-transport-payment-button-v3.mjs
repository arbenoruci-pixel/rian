import fs from 'node:fs';

const page = fs.readFileSync('app/transport/pranimi/page.jsx', 'utf8');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const vite = fs.readFileSync('vite.config.js', 'utf8');
const receivablesMigration = fs.readFileSync('supabase/migrations/20260821143000_transport_receivables_v1.sql', 'utf8');
const receivablesHotfix = fs.readFileSync('supabase/migrations/20260821165000_transport_receivables_security_v2.sql', 'utf8');
const receivablesV3 = fs.readFileSync('supabase/migrations/20260821171500_transport_receivables_commission_concurrency_v3.sql', 'utf8');
const loadedDeliveryV4 = fs.readFileSync('supabase/migrations/20260821174500_transport_loaded_delivery_payment_v4.sql', 'utf8');
const paymentBalanceGuardV5 = fs.readFileSync('supabase/migrations/20260824140500_transport_payment_balance_guard_v5.sql', 'utf8');
const receivablesApi = fs.readFileSync('api/transport/receivables.js', 'utf8');
const receivablesClient = fs.readFileSync('lib/transportReceivablesClient.js', 'utf8');
const paymentIntent = fs.readFileSync('lib/transportPaymentIntent.js', 'utf8');
const transportLogin = fs.readFileSync('app/transport/login/page.jsx', 'utf8');
const loginApi = fs.readFileSync('api/auth/login.js', 'utf8');
const legacyArkaApi = fs.readFileSync('api/arka/transaction.js', 'utf8');
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
check(paymentIntent.includes('TRANSPORT_PAYMENT_INTENT_RESILIENCE_V2'), 'resilient transport payment intent journal is missing');
check(paymentIntent.includes('window.localStorage') && paymentIntent.includes('window.sessionStorage'), 'web-storage payment intent fallback is incomplete');
check(paymentIntent.includes('globalThis?.indexedDB') && paymentIntent.includes('globalThis?.caches'), 'durable async payment intent fallbacks are incomplete');
check(paymentIntent.includes('durable: local || asyncResult.idb || asyncResult.cache'), 'payment can proceed without restart-durable intent storage');
check(paymentIntent.includes('storageConflict: true') && page.includes('paymentIntent?.storageConflict'), 'conflicting payment intent keys are not blocked');
check(paymentIntent.includes('navigator?.locks') && paymentIntent.includes('withInPageOrderLock'), 'concurrent payment intent acquisition is not serialized');
check(paymentBalanceGuardV5.includes('transport_collect_client_payment_guarded_v2') && paymentBalanceGuardV5.includes("raise exception 'PAYMENT_BALANCE_CHANGED'"), 'server-side stale-balance payment guard is missing');
check(paymentBalanceGuardV5.includes("pg_advisory_xact_lock") && paymentBalanceGuardV5.indexOf("PAYMENT_BALANCE_CHANGED") < paymentBalanceGuardV5.indexOf("transport_collect_client_payment_v1("), 'balance guard is not atomic before payment collection');
check(receivablesApi.includes("transport_collect_client_payment_guarded_v2") && receivablesApi.includes('p_expected_total_due'), 'transport API does not enforce the server balance snapshot');
check(
  receivablesClient.includes('expectedTotalDue')
    && paymentIntent.includes('expectedTotalDue: cleanExpectedTotalDue')
    && page.includes('expectedTotalDue: paymentIntent.expectedTotalDue'),
  'payment client does not bind the expected debt snapshot to its durable intent',
);
check(
  receivablesApi.includes('p_expected_total_due: hasExpectedTotalDue')
    && receivablesApi.includes(': null,'),
  'legacy payment intents cannot reach the guarded RPC for safe committed-key verification',
);
check(!paymentIntent.includes('removeItem(paymentIntentStorageKey') && !paymentIntent.includes('const expired ='), 'unresolved transport intents can still expire silently');
check(page.includes('await clearTransportPaymentIntent(oid, paymentIntent.idempotencyKey)') && page.includes('Preserve the same key on ambiguous failures'), 'payment intent is not retained safely across failed requests');
check(!page.includes("if (error?.requestAmbiguous === false) {\n          clearTransportPaymentIntent"), 'definitive-looking errors still discard the retry key');
check(page.includes('LOADED_DELIVERY_PAYMENT_STATUSES') && page.includes('confirmDelivery: confirmsLoadedDelivery'), 'loaded payment is not an explicit atomic delivery action');
check(page.includes('activeSummary?.requiresReconciliation === true'), 'reconciliation-required payments are not blocked');
check(!page.includes('totalForPayment ||'), 'authoritative zero totals still fall back to legacy JSON debt');
check(!page.includes("idempotencyKey: 'TRANSPORT_CLIENT_PAYMENT:' + oid + ':' + Date.now()"), 'per-tap payment idempotency key remains');
check(page.includes('Math.max(ledgerDebt, legacyDebt)'), 'legacy debt warning fallback is missing');
check(page.includes('allowDebt={isDeliveryFinalizeFlow'), 'deliver-with-debt is not restricted to an active delivery');

check(receivablesApi.includes("readCookie(req, 'tepiha_device_id')"), 'receivables endpoint lacks approved-device authentication');
check(receivablesApi.includes("is_hybrid_transport") && receivablesApi.includes("role === 'PUNTOR'"), 'hybrid transport role authorization is missing');
check(receivablesApi.includes('authorizeOrder') && receivablesApi.includes('ORDER_NOT_ASSIGNED_TO_ACTOR'), 'order assignment authorization is missing');
check(receivablesApi.includes('canonicalAssignment') && receivablesApi.includes('if (canonicalAssignment) return'), 'canonical order assignment does not override stale JSON fallbacks');
check(receivablesApi.includes('KNOWN_RPC_BUSINESS_ERRORS') && receivablesApi.includes("|| 503"), 'ambiguous RPC failures are still classified as definitive 4xx errors');
check(receivablesApi.includes('LOADED_ORDER_REQUIRES_DELIVERY_CONFIRMATION') && receivablesApi.includes('p_confirm_delivery:'), 'server does not pass explicit confirmation into the loaded delivery transaction');
check(receivablesClient.includes('confirmDelivery: confirmDelivery === true'), 'client does not send explicit loaded delivery confirmation');
check(receivablesApi.includes('authorizeClient') && receivablesApi.includes('CLIENT_NOT_ASSIGNED_TO_ACTOR'), 'client-only summary authorization is missing');
check(receivablesApi.includes('requestOriginAllowed') && receivablesApi.includes('ORIGIN_NOT_ALLOWED'), 'same-origin mutation guard is missing');
check(receivablesApi.includes("private, no-store") && receivablesApi.includes("x-content-type-options"), 'private API cache/security headers are missing');
check(receivablesApi.includes('sanitizeRpcResult(result)'), 'receivables API exposes raw RPC output');
check(receivablesApi.includes('p_actor_pin: auth.user.pin'), 'server-derived actor PIN is missing');
check(receivablesClient.includes("credentials: 'same-origin'"), 'receivables client does not bind requests to device session');
check(receivablesClient.includes('ambiguous: response.status >= 500'), '5xx retries can lose their stable idempotency key');
check(transportLogin.includes("fetch('/api/auth/login'") && transportLogin.includes('getDeviceId()'), 'dedicated transport login does not establish server device auth');
check(loginApi.includes('DEVICE_LINKED_TO_OTHER_USER') && loginApi.indexOf('DEVICE_LINKED_TO_OTHER_USER') < loginApi.indexOf('devicePayload'), 'shared-device login can still mutate and de-approve the existing owner');
check(legacyArkaApi.includes("readCookie(req, 'tepiha_device_id')") && legacyArkaApi.includes('ACTOR_SESSION_MISMATCH'), 'legacy ARKA endpoint lacks device-bound actor authentication');
check(legacyArkaApi.includes('TRANSPORT_RECEIVABLE_PAYMENT_REQUIRED') && legacyArkaApi.includes('orderAssignedToActor'), 'legacy transport payments can bypass assignment or the receivables ledger');
check(legacyArkaApi.includes("return apiFail(res, 'TRANSPORT_RECEIVABLE_PAYMENT_REQUIRED', 409);"), 'legacy transport cash writes are not disabled');
check(page.includes('if (!shouldFinalizeDelivery)') && page.includes('NJË LEDGER TË VETËM'), 'UI can still enter the legacy transport payment path');

check(receivablesMigration.includes('transport_order_active_arka_paid_v1'), 'active ARKA reconciliation helper is missing');
check(receivablesMigration.includes("status in ('ACCEPTED_BY_DISPATCH', 'COLLECTED', 'PENDING_DISPATCH_APPROVAL')"), 'active ARKA status whitelist is missing');
check(receivablesMigration.includes("'requiresReconciliation', v_requires_reconciliation"), 'legacy completed-order reconciliation guard is missing');
check(receivablesMigration.includes('and v_is_delivery then'), 'legacy done orders can still be auto-created as debt');
check(receivablesMigration.includes('PAYMENT_IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD'), 'server replay payload guard is missing');
check(receivablesHotfix.includes('M2=0 CASH_ALLOCATION_V2'), 'live V1 allocation normalization is missing');
check(receivablesMigration.includes('commission_m2 numeric(12,4)') && receivablesV3.includes('commission_m2 numeric(12,4)'), 'commission entitlement tracking is missing');
check(receivablesV3.includes('perform pg_advisory_xact_lock') && receivablesV3.indexOf('perform pg_advisory_xact_lock') < receivablesV3.indexOf('for update'), 'client advisory lock is not acquired before order row locks');
check(receivablesV3.includes('v_current_cash_applied') && receivablesV3.includes('v_current_debt_remaining'), 'delivery audit event is not based on post-allocation values');
check(receivablesV3.includes('payment_batch_id') && receivablesV3.includes('TRANSPORT_EVENT_REPAIR_AMBIGUOUS'), 'delivery events are not exactly linked and safely repaired');
check(receivablesV3.includes("'transport-receivables-v3:' || v_client_id::text"), 'client advisory lock is not namespaced');
check(receivablesV3.includes('PAYMENT_IDEMPOTENCY_ALLOCATION_SUM_MISMATCH'), 'duplicate retries do not re-verify persisted allocations');
check(receivablesV3.includes('TRANSPORT_COMMISSION_M2_EXCEEDS_SERVICE'), 'commission square-metre invariant is missing');
check(loadedDeliveryV4.includes("v_is_delivery := v_status in ('loaded'"), 'loaded payment is not atomically finalized as delivery');
check(loadedDeliveryV4.includes('p_confirm_delivery boolean default false') && loadedDeliveryV4.includes('p_confirm_delivery is not true'), 'loaded confirmation is not checked inside the locked SQL transaction');

if (failures.length) {
  console.error('FAIL transport payment button v3:', failures);
  process.exit(1);
}
console.log('PASS transport payment button v3');
