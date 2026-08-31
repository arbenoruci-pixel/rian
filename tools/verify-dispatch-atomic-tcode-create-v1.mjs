import fs from 'node:fs';

const dispatch = fs.readFileSync('app/dispatch/page.jsx', 'utf8');
const transportDb = fs.readFileSync('lib/transport/transportDb.js', 'utf8');
const allocatorMigration = fs.readFileSync(
  'supabase/migrations/20260830211827_transport_order_atomic_tcode_allocator_v1.sql',
  'utf8',
);
const repairMigration = fs.readFileSync(
  'supabase/migrations/20260830212301_dispatch_tcode_stranded_cleanup_v1.sql',
  'utf8',
);
const repairMigrationV2 = fs.readFileSync(
  'supabase/migrations/20260830221249_dispatch_tcode_stranded_cleanup_v2.sql',
  'utf8',
);
const repairMigrationV3 = fs.readFileSync(
  'supabase/migrations/20260831071200_dispatch_tcode_stranded_cleanup_v3.sql',
  'utf8',
);

const failures = [];
const check = (condition, message) => {
  if (!condition) failures.push(message);
};

const prepareStart = dispatch.indexOf('async function prepareDispatchTransportClientLink');
const prepareEnd = dispatch.indexOf('\n\nfunction dispatchSafePhoneMatch', prepareStart);
const prepareBlock = prepareStart >= 0 && prepareEnd > prepareStart
  ? dispatch.slice(prepareStart, prepareEnd)
  : '';

const insertStart = transportDb.indexOf('export async function insertTransportOrder');
const insertEnd = transportDb.indexOf('\n\nexport function saveOfflineTransportOrder', insertStart);
const insertBlock = insertStart >= 0 && insertEnd > insertStart
  ? transportDb.slice(insertStart, insertEnd)
  : '';

check(Boolean(prepareBlock), 'Dispatch prepare block exists');
check(!prepareBlock.includes('reserveTransportCode'), 'new Dispatch client has no pre-create reservation RPC');
check(prepareBlock.includes('const atomicDbTcodeAllocation = !tcode'), 'only a client without a master T-code requests atomic allocation');
check(dispatch.includes('transport_tcode_allocation_mode: atomicDbTcodeAllocation ? "ATOMIC_DB" : "EXISTING_CLIENT"'), 'Dispatch sends explicit allocation mode');
check(dispatch.includes('code_owner: poolOwner'), 'Dispatch sends the intended pool audit owner');
check(dispatch.includes('!atomicDbTcodeAllocation'), 'Dispatch payload completeness allows blank code only for the atomic path');

check(Boolean(insertBlock), 'transportDb insert block exists');
check(insertBlock.includes("createdByRole === 'DISPATCH' && tcodeAllocationMode === 'ATOMIC_DB'"), 'blank T-code is restricted to explicit Dispatch atomic requests');
check(insertBlock.includes("if (!permanentTcode && !allowAtomicDispatchTcode)"), 'all other callers still require a code');
const apiBranch = insertBlock.indexOf('if (useDispatchServerCreate)');
const directUuidLookup = insertBlock.indexOf(".from('transport_orders')");
check(apiBranch >= 0 && directUuidLookup > apiBranch, 'atomic Dispatch reaches the authenticated API before any client UUID short-circuit');
check(transportDb.includes("fetch('/api/transport/order'"), 'atomic Dispatch uses the same-origin transport endpoint');
check(transportDb.includes('keepalive: requestJson.length < 60000'), 'Dispatch create survives iPhone lifecycle/network suspension');
check(transportDb.includes('reconcileAtomicDispatchOrder(expected)'), 'Dispatch reconciles a committed order after a lost API response');
check(transportDb.includes("query.timeout(10000, 'DISPATCH_ORDER_RECONCILE_TIMEOUT')"), 'Dispatch timeout reconciliation is bounded');
check(transportDb.includes('setTimeout(() => controller.abort(), 35000)'), 'Dispatch allows the verified server transaction to finish under load');
check(insertBlock.includes("tcodeAllocationMode === 'ATOMIC_DB' || tcodeAllocationMode === 'EXISTING_CLIENT'"), 'new and existing Dispatch clients use the trusted server boundary');
check(insertBlock.includes('p_code_n: payload.code_n ?? null'), 'RPC always receives its p_code_n argument');
check(insertBlock.includes('p_code_str: permanentTcode || null'), 'atomic Dispatch sends null p_code_str');
check(insertBlock.includes('requestedOwner ? { code_owner: requestedOwner }'), 'supplied-code callers preserve the exact reservation owner');
check(insertBlock.includes('if (rpcResult?.success === false)'), 'direct supplied-code callers stop on structured DB conflicts');
check(insertBlock.includes("row?.client_tcode || rpc?.data?.client_tcode"), 'client reads the permanent T-code returned by DB');
check(insertBlock.includes('assertAtomicTransportOrder(row'), 'created DB row is identity-verified');

check(allocatorMigration.includes('create or replace function public.create_transport_order('), 'allocator migration replaces the existing RPC signature');
check(allocatorMigration.includes('security invoker'), 'create RPC stays SECURITY INVOKER');
check(allocatorMigration.includes("upper(btrim(coalesce(p_data->>'transport_tcode_allocation_mode','')))='ATOMIC_DB'"), 'DB requires the explicit atomic allocation flag');
check(allocatorMigration.includes("nullif(auth.role(),'')") && allocatorMigration.includes('current_user::text'), 'DB derives the trusted invoker role with PostgREST and SQL fallbacks');
check(allocatorMigration.includes("v_caller_role<>'service_role'"), 'blank allocation is service-role-only');
check(allocatorMigration.includes('TRANSPORT_CREATE_FINGERPRINT_REQUIRED'), 'atomic create requires a trusted stable fingerprint');
check(allocatorMigration.includes('TRANSPORT_SUPPLIED_TCODE_CLAIM_INVALID'), 'supplied new-client codes require a locked pool/lease claim');
check((allocatorMigration.match(/TRANSPORT_ORDER_IDEMPOTENCY_FINGERPRINT_CONFLICT/g) || []).length === 2, 'fingerprint is compared on both idempotent paths');
check(allocatorMigration.includes('add column if not exists transport_create_fingerprint_v1 text'), 'fingerprint has a durable DB column');
check(allocatorMigration.includes('trg_zzz_transport_order_fingerprint_guard_v1'), 'last-running BEFORE trigger preserves the immutable fingerprint and JSON mirror');
check(allocatorMigration.includes('TRANSPORT_CREATE_FINGERPRINT_SERVICE_ROLE_REQUIRED'), 'only service-role may seed the protected fingerprint');
check(allocatorMigration.includes('v_reserved_codes:=public.reserve_transport_codes_batch(v_owner,1)'), 'allocator executes inside create transaction');
check(allocatorMigration.includes("pg_advisory_xact_lock(hashtextextended('transport-order:'||p_id::text,0))"), 'same-UUID creates are serialized before phone locking');
check(allocatorMigration.includes("pg_advisory_xact_lock(hashtextextended('transport-phone:'||v_phone_digits,0))"), 'same-phone creates are serialized');
check((allocatorMigration.match(/TRANSPORT_ORDER_IDEMPOTENCY_PHONE_CONFLICT/g) || []).length === 2, 'UUID identity is checked before and after the phone lock');
for (const alias of ['code_str', 'code', 'order_code', 'official_order_code', 'order_tcode', 'client_tcode', 'transport_client_tcode']) {
  check((allocatorMigration.match(new RegExp(`'${alias}'`, 'g')) || []).length >= 2, `DB writes top-level and nested ${alias} aliases`);
}
for (const relation of [
  'cash_handoff_items',
  'arka_payment_exclusions',
  'transport_client_debts',
  'transport_receivables',
  'dispatch_tasks',
  'transport_order_measurement_audit',
  'transport_keep_one',
]) {
  check(allocatorMigration.includes(`public.${relation}`), `unused-code release fails closed on ${relation}`);
}
check(allocatorMigration.includes("o.data->'client'->>'transport_client_tcode'"), 'unused-code release checks nested client aliases');
check(!allocatorMigration.includes('generate_series(1233,1288)'), 'schema migration contains no incident data repair');

check(repairMigration.includes('v_expected_count <> 53'), 'repair requires exactly 53 incident codes');
check(repairMigration.includes('DISPATCH_TCODE_CLEANUP_REFERENCE_BLOCKERS'), 'repair aborts on any reference blocker');
check(repairMigration.includes('DISPATCH_TCODE_CLEANUP_UPDATE_COUNT_CHANGED'), 'repair checks update count against the guarded target');
check(repairMigration.includes('DISPATCH_TCODE_CLEANUP_POSTCHECK_FAILED'), 'repair asserts the final pool state');
check(repairMigration.includes('where n not in (1237, 1267, 1279)'), 'repair excludes the three real orders');
check(repairMigration.includes("from public.offline_code_leases l"), 'repair checks offline lease history');
check(repairMigration.includes('backup_dispatch_tcode_stranded_cleanup_20260830_v1'), 'repair creates a protected recovery backup');

check(repairMigrationV2.includes('generate_series(1290::bigint, 1298::bigint)'), 'second repair is limited to the nine fresh stranded codes');
check(repairMigrationV2.includes('v_expected_count <> 9'), 'second repair requires exactly nine incident codes');
check(repairMigrationV2.includes("('T1289'::text, 1289::bigint)"), 'second repair protects completed T1289');
check(repairMigrationV2.includes("('T1299'::text, 1299::bigint)"), 'second repair protects completed T1299');
check(repairMigrationV2.includes('DISPATCH_TCODE_CLEANUP_V2_REFERENCE_BLOCKERS'), 'second repair aborts on lifecycle references');
check(repairMigrationV2.includes('DISPATCH_TCODE_CLEANUP_V2_UPDATE_COUNT_CHANGED'), 'second repair verifies its exact update count');
check(repairMigrationV2.includes('DISPATCH_TCODE_CLEANUP_V2_POSTCHECK_FAILED'), 'second repair asserts all nine codes are available');
check(repairMigrationV2.includes('backup_dispatch_tcode_stranded_cleanup_20260830_v2'), 'second repair creates a separate protected recovery backup');

check(repairMigrationV3.includes('generate_series(1301::bigint, 1310::bigint)'), 'third repair includes the first exact retry-storm interval');
check(repairMigrationV3.includes('generate_series(1312::bigint, 1326::bigint)'), 'third repair includes the second exact retry-storm interval');
check(repairMigrationV3.includes('generate_series(1329::bigint, 1330::bigint)'), 'third repair includes the final two pre-cutover stranded codes');
check(repairMigrationV3.includes('v_expected_count <> 27'), 'third repair requires exactly twenty-seven incident codes');
check(repairMigrationV3.includes('v_pool_count <> v_expected_count'), 'third repair couples pool cardinality to the exact incident set');
check(repairMigrationV3.includes("('T1300'::text, 1300::bigint)"), 'third repair protects completed T1300');
check(repairMigrationV3.includes("('T1311'::text, 1311::bigint)"), 'third repair protects completed T1311');
check(repairMigrationV3.includes("('T1327'::text, 1327::bigint)"), 'third repair protects completed T1327');
check(repairMigrationV3.includes("('T1328'::text, 1328::bigint)"), 'third repair protects completed T1328');
check(repairMigrationV3.includes('transport_tcode_has_lifecycle_reference_v2'), 'third repair uses the strict lifecycle reference guard');
check(repairMigrationV3.includes('DISPATCH_TCODE_CLEANUP_V3_REFERENCE_BLOCKERS'), 'third repair aborts on lifecycle references');
check(repairMigrationV3.includes('DISPATCH_TCODE_CLEANUP_V3_UPDATE_COUNT_CHANGED'), 'third repair verifies its exact update count');
check(repairMigrationV3.includes('DISPATCH_TCODE_CLEANUP_V3_POSTCHECK_FAILED'), 'third repair verifies every released code');
check(repairMigrationV3.includes('DISPATCH_TCODE_CLEANUP_V3_PROTECTED_POSTCHECK_FAILED'), 'third repair re-verifies protected completed codes');
check(repairMigrationV3.includes('backup_dispatch_tcode_stranded_cleanup_20260831_v3'), 'third repair creates a separate protected recovery backup');

if (failures.length) {
  console.error(`FAIL: ${failures.length} atomic Dispatch T-code check(s) failed.`);
  failures.forEach((failure, index) => console.error(`${index + 1}. ${failure}`));
  process.exit(1);
}

console.log('PASS: Dispatch delegates new-client T-code allocation to the atomic create RPC; legacy/offline supplied codes remain supported and incident cleanup is isolated and guarded.');
