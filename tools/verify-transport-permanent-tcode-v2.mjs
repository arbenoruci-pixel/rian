import fs from 'node:fs';
import path from 'node:path';
import { buildOrderTrackUrl, buildTransportConfirmUrl, isUuidLike } from '../lib/smartSms.js';
import {
  isValidTransportPhoneServer,
  normalizeTransportPhoneKeyServer,
  normalizeTransportTCodeServer,
} from '../lib/transport/transportServer.js';

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const checks = [];
const check = (condition, message) => {
  checks.push({ condition: Boolean(condition), message });
  if (!condition) console.error(`FAIL: ${message}`);
};

const codes = read('lib/transportCodes.js');
const legacyCodePool = read('lib/transportCodePool.js');
const sms = read('lib/smartSms.js');
const selfEntry = read('app/transport/pranimi/page.jsx');
const dispatch = read('app/dispatch/page.jsx');
const transportDb = read('lib/transport/transportDb.js');
const serverHelper = read('lib/transport/transportServer.js');
const devBooking = read('server/index.mjs');
const deployBooking = read('api/public-booking.js');
const nextBooking = read('app/api/public-booking/route.js');
const nextOfflineSync = read('app/api/offline-sync/route.js');
const syncEngine = read('lib/transportCore/syncEngine.js');
const legacySync = read('lib/transportOfflineSync.js');
const genericSync = read('lib/syncEngine.js');
const offlineStore = read('lib/offlineStore.js');
const transportOrdersDb = read('lib/transportOrdersDb.js');
const ordersDb = read('lib/ordersDb.js');
const ordersService = read('lib/ordersService.js');
const publicBookingPage = read('app/porosit/page.jsx');
const tracking = read('app/k/[id]/page.jsx');

// Allocator and release safety.
check(/const DEFAULT_POOL_SIZE = 1;/.test(codes), 'Allocator returns at most one T-code');
check(codes.includes('transport_pool_mirror_v3_single_smallest_'), 'Multi-code browser mirror is invalidated');
check(codes.includes('cachedReservationBelongsToOwner'), 'Cached draft code is verified against DB owner');
check(codes.includes('const [knownUsed, owned] = await Promise.all'), 'Mirror code is re-verified against DB ownership before use');
check(codes.includes("key.startsWith('transport_pool_mirror_')"), 'Released code is purged from browser mirrors');
check(codes.includes("status === CLAIMED_POOL_STATUS && ownerId === wantedOwner"), 'Stale reservation cannot be reused by another owner');
check(codes.includes(".eq('tcode', c)"), 'Client T-code history check uses real transport_clients.tcode');
check(!codes.includes('code.eq.${c},code.eq.${n}'), 'Allocator no longer queries non-existent transport_clients.code');
check(!codes.includes('`code.eq.${c}`'), 'Allocator no longer queries non-existent transport_orders.code');
check(codes.includes('`client_tcode.eq.${c}`'), 'Allocator protects historical permanent client T-codes in orders');
check(codes.includes("select('id,type,source_module')"), 'Allocator checks both Transport payment markers');
check(codes.includes('release_transport_code_if_unused'), 'Unused code release is DB guarded');
check(codes.includes('Compatibility allocator must fail closed when Arka cannot be checked'), 'Allocator never reuses a code when payment lookup fails');
check(legacyCodePool.includes("from '@/lib/transportCodes'"), 'Legacy pool API delegates to canonical allocator');
check(!legacyCodePool.includes('DEFAULT_POOL_SIZE = 5'), 'Legacy pool cannot pre-reserve five codes');
check(codes.includes('getTransportCodeReservationForOrder'), 'Per-order reservation can be inspected and cleaned');

// Self Entry.
check(selfEntry.includes('officialOrderTcode = clientBookTcode;'), 'Self Entry reuses existing permanent T-code');
check(selfEntry.includes("TELEFONI NUK ËSHTË VALID"), 'Self Entry validates phone before code allocation');
check(selfEntry.includes('TRANSPORT_CLIENT_PHONE_LOOKUP_FAILED'), 'Self Entry lookup failures block save');
check(selfEntry.includes('findTransportClientByPhoneCanonical(phoneFull'), 'Self Entry final save uses canonical shared phone lookup');
check(selfEntry.includes('const acceptedExistingByPhone = isEdit ? isAcceptedTransportClientForCurrentPhone() : Boolean(existingPhoneClient);'), 'Self Entry ignores stale selected client after DB confirms new phone');
check(selfEntry.includes('clearTransportCodeReservationForOrder(oid)'), 'Self Entry clears draft reservation after verified save');
check(selfEntry.includes('public_order_id: oid'), 'Self Entry persists exact order UUID for Smart SMS');

// Shared browser save path.
check(transportDb.includes("supabase.rpc('create_transport_order'"), 'Browser create uses atomic DB RPC');
check(transportDb.includes('TRANSPORT_CLIENT_FINAL_LOOKUP_FAILED'), 'Shared save fails closed on final phone lookup');
check(transportDb.includes('TRANSPORT_PHONE_IDENTITY_CONFLICT'), 'Historical phone identity conflicts block allocation');
check(transportDb.includes('TRANSPORT_ORDER_PHONE_HISTORY_LOOKUP_FAILED'), 'Historical phone lookup failures are blocking');
check(transportDb.includes('TRANSPORT_CLIENT_PHONE_HISTORY_LOOKUP_FAILED'), 'Legacy-formatted master client lookup is fail-closed');
check(transportDb.includes("existingPhoneClient?.source === 'transport_clients'"), 'Browser save sends canonical stored phone to exact-match DB RPC');
check(transportDb.includes('TRANSPORT_ORDER_CODE_RECONCILE_FAILED'), 'Phone race reconciles public code to permanent T-code');
check(transportDb.includes('superseded_reserved_tcode'), 'Superseded temporary code is auditable');
check(transportDb.includes('releaseTransportCodeIfUnused(requestedCode'), 'Superseded/failed reservation is returned safely');
check(transportDb.includes('TRANSPORT_ORDER_VERIFY_VISIT_NR_MISSING'), 'Save requires verified visit_nr');

// Dispatch.
check((dispatch.match(/reserveTransportCode\(/g) || []).length === 1, 'Dispatch allocates only inside new-client preparation');
check(dispatch.includes('prepareDispatchTransportClientLink'), 'Dispatch has phone-first preparation');
check(dispatch.includes('The final DB lookup is authoritative'), 'Dispatch cached CRM hit cannot override final DB lookup');
check(dispatch.includes('const verifiedPhoneClient = undefined;'), 'Dispatch forces one final live lookup immediately before allocation');
check(!dispatch.includes(': (existingPhoneClient && dispatchSamePhone'), 'Dispatch does not fall back to stale cached client identity');
check(dispatch.includes('insertTransportOrder({ ...payload, code_owner: poolOwner })'), 'Dispatch uses atomic shared create path');
check(!dispatch.includes('createOrderRecord("transport_orders"'), 'Dispatch no longer inserts transport order directly');
check(!dispatch.includes('upsertTransportClient({'), 'Dispatch no longer creates orphan client before order');
check(dispatch.includes('TRANSPORT_PERMANENT_TCODE_VERIFY_FAILED'), 'Dispatch verifies code_str equals permanent client T-code');
check(dispatch.includes('TRANSPORT_ORDER_UUID_VERIFY_FAILED'), 'Dispatch verifies exact order UUID');
check(dispatch.includes('clearTransportCodeReservationForOrder(orderId)'), 'Dispatch clears reservation binding after success');

// Online public booking, dev and deploy.
for (const [label, source] of [
  ['Dev public booking', devBooking],
  ['Deploy public booking', deployBooking],
  ['Next public booking', nextBooking],
]) {
  check(source.includes('createTransportOrderAtomicServer'), `${label} uses atomic transport helper`);
  check(source.includes('isValidTransportPhoneServer'), `${label} validates normalized phone`);
  check(!source.includes("from('transport_orders').insert(payload)"), `${label} has no direct transport order insert`);
}
check(serverHelper.includes("reserve_transport_codes_batch"), 'Server helper reserves one smallest T-code for new phone');
check(serverHelper.includes('findTransportClientByPhoneServer'), 'Server helper looks up canonical client by phone');
check(serverHelper.includes('TRANSPORT_HISTORICAL_PHONE_TCODE_CONFLICT'), 'Server helper blocks ambiguous historical T-codes');
check(serverHelper.includes('historical_order_only: true'), 'Server helper can recover one unambiguous historical T-code');
check(serverHelper.includes('releaseTransportTCodeServer'), 'Server helper releases unused race/failure code');
check(serverHelper.includes('const suppliedCode = normalizeTransportTCodeServer'), 'Server helper reuses one offline-reserved code instead of allocating another');
check(serverHelper.includes("existingClient?.source === 'transport_clients'"), 'Server helper sends the canonical stored phone to exact-match DB RPC');
check(serverHelper.includes('TRANSPORT_ORDER_CODE_RECONCILE_FAILED'), 'Server helper reconciles concurrent phone creation');

// Offline sync.
check(syncEngine.includes('insertTransportOrder({'), 'Active offline sync uses atomic create path');
check(!/processTransportOrderInsert[\s\S]{0,900}\.upsert\(/.test(syncEngine), 'Active offline insert has no direct upsert');
check(legacySync.includes('insertTransportOrder({'), 'Legacy draft sync also uses atomic create path');
check(!legacySync.includes("from('transport_orders')"), 'Legacy draft sync has no direct transport write');
check(legacySync.includes('ensureDraftUuid'), 'Offline retry keeps stable UUID');
check(legacySync.includes("const DRAFT_ITEM_PREFIX = 'transport_draft_order_'"), 'Legacy draft sync reads the real per-draft storage layout');
check(legacySync.includes('draft?.phonePrefix'), 'Legacy draft sync restores the saved international phone prefix');
check(nextOfflineSync.includes('createTransportOrderAtomicServer'), 'Next offline API routes Transport insert through atomic helper');
check(nextOfflineSync.includes('stableTransportOrderUuid'), 'Next offline API deterministically maps legacy local IDs to UUIDs');
check(!/from\(["']transport_orders["']\)[\s\S]{0,420}\.(insert|upsert)\(/.test(nextOfflineSync), 'Next offline API has no direct Transport insert/upsert');
check(genericSync.includes("if (table === 'transport_orders')" ) && genericSync.includes('insertTransportOrder(payload)'), 'Generic sync routes Transport create through atomic helper');
check(offlineStore.includes("if (table === 'transport_orders')") && offlineStore.includes('insertTransportOrder(clean)'), 'Offline store routes Transport outbox through atomic helper');
check(transportOrdersDb.includes('const result = await insertTransportOrder(order)'), 'Legacy Transport DB helper routes create through atomic helper');
check(transportOrdersDb.includes('function createTransportUuid()'), 'Legacy Transport DB helper creates a real UUID');
check(ordersDb.includes('const result = await insertTransportOrder(row)'), 'Generic orders DB routes Transport create through atomic helper');
check(ordersService.includes("if (table === 'transport_orders')") && ordersService.includes('insertTransportOrder(payload)'), 'Orders service routes Transport create/upsert through atomic helper');
for (const [label, source] of [
  ['Transport DB helper', transportOrdersDb],
  ['Generic orders DB', ordersDb],
  ['Orders service', ordersService],
  ['Generic sync', genericSync],
  ['Offline store', offlineStore],
]) {
  check(!/from\(['"]transport_orders['"]\)[\s\S]{0,260}\.(insert|upsert)\(/.test(source), `${label} has no direct Transport insert/upsert`);
}
check(publicBookingPage.includes('bookingIdRef'), 'Public booking keeps one stable UUID across retries');
check(publicBookingPage.includes('PUBLIC_BOOKING_ID_KEY'), 'Public booking UUID survives a retry or reload in the same session');
check(publicBookingPage.includes('getOrCreatePublicBookingUuid'), 'Public booking reuses the persisted idempotency UUID');
check(publicBookingPage.includes('name="bookingId"'), 'Public booking submits exact UUID to API');

function collectSourceFiles(dir) {
  const absolute = path.join(root, dir);
  if (!fs.existsSync(absolute)) return [];
  const out = [];
  for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
    const relative = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectSourceFiles(relative));
    else if (/\.(?:js|jsx|mjs|cjs|ts|tsx)$/.test(entry.name)) out.push(relative);
  }
  return out;
}
const activeSourceFiles = ['app', 'lib', 'server', 'api', 'src', 'components', 'public']
  .flatMap(collectSourceFiles);
const directTransportCreates = activeSourceFiles.filter((file) =>
  /from\(["']transport_orders["']\)[\s\S]{0,420}\.(insert|upsert)\(/.test(read(file))
);
check(directTransportCreates.length === 0, `No active source bypasses atomic Transport create: ${directTransportCreates.join(', ')}`);

// Smart SMS and tracking.
check(sms.includes('Structured order UUID fields outrank'), 'Smart SMS prioritizes structured order UUID');
check(sms.includes("getTransportLifecycle(order).includes('PERMANENT_CLIENT_TCODE')"), 'New lifecycle never falls back to ambiguous shared T-code');
check(tracking.includes("src === 'transport'") || tracking.includes('srcHint'), 'Tracking page has explicit transport source handling');
check(tracking.includes("if (!resolved && (isTransportCode || isShortNumeric))"), 'Tracking UUID bypasses ambiguous T-code lookup');
check(!tracking.includes("if (!resolved && (srcHint === 'transport' || isTransportCode || isShortNumeric))"), 'Transport source hint alone cannot turn a UUID into a code lookup');

const exactUuid = 'a6217999-17bd-4225-8fb6-5ea27295083c';
check(isUuidLike(exactUuid), 'UUID validator accepts production Transport UUID');
check(
  buildOrderTrackUrl({
    id: 'wrapper-row-17',
    client_tcode: 'T272',
    data: { order_id: exactUuid, tcode_lifecycle: 'PERMANENT_CLIENT_TCODE_V1' },
  }) === `https://tepiha.vercel.app/k/${exactUuid}?src=transport`,
  'Smart SMS opens exact UUID even when wrapper id is unrelated',
);
check(
  buildOrderTrackUrl({ client_tcode: 'T272', data: { tcode_lifecycle: 'PERMANENT_CLIENT_TCODE_V1' } }) === 'https://tepiha.vercel.app/k/',
  'Permanent lifecycle without UUID fails safe instead of opening another visit',
);
check(
  buildTransportConfirmUrl({ client_tcode: 'T272', data: { tcode_lifecycle: 'PERMANENT_CLIENT_TCODE_V1' } }) === 'https://tepiha.vercel.app/k/',
  'Transport confirmation helper also fails safe without an exact UUID',
);
check(
  buildOrderTrackUrl({ client_tcode: 'T272' }) === 'https://tepiha.vercel.app/k/T272?src=transport',
  'Legacy pre-UUID T-code link remains compatible',
);

// Normalization invariants.
check(normalizeTransportPhoneKeyServer('+383 45 255 074') === '45255074', 'Server phone normalization matches Transport identity');
check(normalizeTransportPhoneKeyServer('00383 045 255 074') === '45255074', 'Kosovo trunk-zero international format maps to the same identity');
check(
  normalizeTransportPhoneKeyServer('+355 68 123 4567') === normalizeTransportPhoneKeyServer('00355 068 123 4567'),
  'Albania plus/00/trunk-zero formats map to one identity',
);
check(
  normalizeTransportPhoneKeyServer('+41 79 123 45 67') === normalizeTransportPhoneKeyServer('0041 079 123 45 67'),
  'Switzerland plus/00/trunk-zero formats map to one identity',
);
check(normalizeTransportPhoneKeyServer('049120102') === '49120102', 'Kosovo local number beginning with 49 is not mistaken for Germany');
check(isValidTransportPhoneServer('045255074'), 'Valid Kosovo phone is accepted');
check(isValidTransportPhoneServer('+355 68 123 4567'), 'Valid supported international phone is accepted');
check(!isValidTransportPhoneServer('1234'), 'Short phone is rejected');
check(normalizeTransportTCodeServer('000272') === 'T272', 'T-code always keeps canonical T prefix');

const failed = checks.filter((item) => !item.condition);
if (failed.length) {
  console.error(`\n${failed.length}/${checks.length} checks failed.`);
  process.exit(1);
}
console.log(`PASS: ${checks.length} Transport permanent T-code V2 checks.`);
