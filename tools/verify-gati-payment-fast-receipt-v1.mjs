import fs from 'node:fs';

const files = {
  gati: fs.readFileSync('app/gati/page.jsx', 'utf8'),
  recovery: fs.readFileSync('lib/deviceSessionRecovery.js', 'utf8'),
  network: fs.readFileSync('lib/arka/arkaNetwork.js', 'utf8'),
  sync: fs.readFileSync('lib/syncEngine.js', 'utf8'),
  payService: fs.readFileSync('components/payments/payService.js', 'utf8'),
  offlineSyncClient: fs.readFileSync('lib/offlineSyncClient.js', 'utf8'),
  server: fs.readFileSync('server/index.mjs', 'utf8'),
  loginApi: fs.readFileSync('api/auth/login.js', 'utf8'),
  package: fs.readFileSync('package.json', 'utf8'),
  rackInstaller: fs.readFileSync('tools/apply-gati-rack-save-v1.mjs', 'utf8'),
  epoch: fs.readFileSync('lib/appEpoch.js', 'utf8'),
  sw: fs.readFileSync('public/sw.js', 'utf8'),
};

function check(condition, message) {
  if (!condition) throw new Error(`FAIL: ${message}`);
}

function ordered(source, tokens, label) {
  let cursor = -1;
  for (const token of tokens) {
    const next = source.indexOf(token, cursor + 1);
    check(next > cursor, `${label}: missing/out-of-order ${token}`);
    cursor = next;
  }
}

check(files.gati.includes('GATI_PAYMENT_FAST_RECEIPT_V1'), 'GATI fast receipt marker missing');
check(files.gati.includes('const [paymentSmsReceipt, setPaymentSmsReceipt] = useState(null)'), 'GATI receipt state missing');
check(files.gati.includes('paySubmitLockRef.current'), 'synchronous duplicate-tap lock missing');
check(files.gati.includes(".find((value) => /^\\d+$/.test(value) && Number(value) > 0)"), 'payment open lacks canonical DB order ID resolution');
check(files.gati.includes('if (!Number.isInteger(canonicalOrderId) || canonicalOrderId <= 0)'), 'payment confirm can queue an order ID of zero');
check(files.gati.includes('Prit sinkronizimin para pagesës.'), 'local-only payment guard has no worker guidance');
check(files.gati.includes('PAGESA U REGJISTRUA'), 'payment receipt title missing');
check(files.gati.includes('DËRGO SMS TË PAGESËS'), 'payment receipt SMS action missing');
check(files.gati.includes("window.location.href = 'sms:' + phone"), 'native SMS deep link missing');
check(files.gati.includes('closeImmediately: true'), 'fast local UI close missing');
check(files.gati.includes("const hasSyncSnapshot = Array.isArray(syncSnapshot)"), 'online local snapshot hydration missing');
check(!files.gati.includes('const hasSyncSnapshot = !onlineAtStart'), 'snapshot still restricted to offline opens');

const confirmStart = files.gati.indexOf('async function confirmDelivery()');
const confirmEnd = files.gati.indexOf('async function closeDeliveryOnlyRetry()', confirmStart);
const confirm = files.gati.slice(confirmStart, confirmEnd);
ordered(confirm, [
  'paySubmitLockRef.current = true',
  'ensureApprovedDeviceSession({ actor: pinData',
  "queueOp('gati_payment_delivery'",
  'await finalizeDeliveredUi(queuedPayload, { syncPending: true, closeImmediately: true })',
  'setPaymentSmsReceipt({',
  'finishFastDeliverySync({',
], 'GATI confirm safety order');
check(confirm.includes('void refreshOrders('), 'failure refresh must be detached');
check(!confirm.includes('await recordOrderCashPayment('), 'GATI confirm still waits on ARKA network');
check(confirm.includes("}, { deferSync: true })"), 'outbox sync can race the pending local snapshot write');
ordered(confirm, [
  'await finalizeDeliveredUi(queuedPayload, { syncPending: true, closeImmediately: true })',
  'finishFastDeliverySync({',
], 'local finalize before either background sync owner');
check(!confirm.includes("window.dispatchEvent(new Event('TEPIHA_SYNC_TRIGGER'))"), 'outbox runner races the direct fast sync');
check(files.offlineSyncClient.includes('const deferSync = options?.deferSync === true'), 'queue client lacks deferred-sync support');
const fastSyncStart = files.gati.indexOf('async function finishFastDeliverySync');
const fastSyncEnd = files.gati.indexOf('function formatPendingPaymentNotice', fastSyncStart);
const fastSync = files.gati.slice(fastSyncStart, fastSyncEnd);
ordered(fastSync, ['await saveOrderLocal({', 'await deleteOp(deliveryOpId)'], 'canonical local save before outbox deletion');

check(files.recovery.includes("fetch('/api/auth/login'"), 'approved-session recovery does not use server login');
check(files.recovery.includes("approval?.source === 'approval-cache'"), 'offline payment trust is not tied to explicit device approval cache');
check(files.recovery.includes('if (!response.ok || data?.ok !== true)'), 'malformed or rejected login response is not fail-closed');
check(files.recovery.includes('OFFLINE_APPROVAL_MAX_AGE_MS'), 'offline device approval has no bounded lifetime');
check(files.recovery.includes("verifiedPin !== clean(actor?.pin)"), 'repaired session actor is not verified');
check(files.recovery.includes('!rolesCompatible(actor.role, verifiedRole)'), 'repaired session role is not verified');
check(files.loginApi.includes("if (!isCurrentlyApproved) return apiFail(res, 'DEVICE_NOT_APPROVED'"), 'login API no longer rejects unknown devices');

ordered(files.network, [
  'await syncStableDeviceCookie()',
  'postArkaTransactionOnce(payload, opts)',
  'await repairApprovedDeviceSession(payload, opts)',
  'return postArkaTransactionOnce(payload, {',
], 'ARKA one-time session repair');

check(files.sync.includes('device_session_retry_queued'), 'device-blocked outbox operation is not retained');
check(files.sync.includes('if (deviceAuthorizationBlocked)'), 'sync engine device authorization branch missing');
check(files.sync.includes('DEVICE_LINKED_TO_OTHER_USER') && files.sync.includes('ROLE_MISMATCH'), 'recoverable device/account blocks are not retained');
const deliverySyncStart = files.sync.lastIndexOf("if (type === 'gati_payment_delivery')");
const deliverySyncEnd = files.sync.indexOf("if (type === 'base_ready_bonus_transition')", deliverySyncStart);
const deliverySync = files.sync.slice(deliverySyncStart, deliverySyncEnd);
check(deliverySync.includes('isDeliveredBaseStatus'), 'outbox flush does not verify atomic delivery result');
check(deliverySync.includes('const paidData = readNestedObject(paidOrder?.data)'), 'outbox flush does not use authoritative order data');
check(deliverySync.includes('await saveOrderLocal({'), 'outbox flush does not refresh local state from authoritative result');
check(!deliverySync.includes('payload?.delivery_patch'), 'outbox flush can replay stale client delivery data');
check(!deliverySync.includes('updateByIdOrLocalOid'), 'outbox flush performs a non-atomic second server patch');
check(files.payService.includes('clientPhone:'), 'legacy payment arguments still drop client phone');
check(files.payService.includes("input?.arkaOptions || {}"), 'fast ARKA request options are not forwarded');

check(files.server.includes("import arkaTransactionHandler from '../api/arka/transaction.js'"), 'local server lacks production ARKA handler');
check(files.server.includes("app.post('/api/arka/transaction', arkaTransactionHandler)"), 'local ARKA route bypasses production authentication');
check(!files.server.includes("import { runArkaTransaction } from '../lib/arka/arkaEngine.js'"), 'local server retains direct unauthenticated ARKA engine import');

check(files.epoch.includes('gati-payment-fast-receipt-v1'), 'runtime build version marker missing');
check(files.sw.includes('gati-payment-fast-receipt-v1'), 'service-worker build version marker missing');
check(files.gati.includes("syncState: 'pending'"), 'receipt does not expose pending synchronization');
check(files.gati.includes("syncState: 'error'"), 'background failure is not shown in the receipt');
check(files.gati.includes('PAGESA U RUAJT • DUKE U SINKRONIZUAR'), 'pending receipt is presented as confirmed success');
check(files.gati.indexOf('const rootGatiPromise = onlineAtStart') < files.gati.indexOf('const durablePageSnapshotRows = await readGatiRowsFromDurableSnapshot()'), 'live DB fetch still waits behind durable snapshot hydration');
check(files.gati.includes('isGatiRowBlockedByDeliveryTombstone'), 'delivered snapshot rows can become payable again');
const packageJson = JSON.parse(files.package);
const prebuild = String(packageJson.scripts?.prebuild || '');
const fastInstaller = 'node tools/apply-gati-payment-fast-receipt-v1.mjs';
const rackInstaller = 'node tools/apply-gati-rack-save-v1.mjs';
check(prebuild.includes(`${fastInstaller} && ${rackInstaller}`), 'fast receipt installer must run directly before final GATI release owner');
check(prebuild.trim().endsWith(rackInstaller), 'GATI rack must remain the final prebuild release owner');
ordered(files.rackInstaller, [
  "await import('./apply-arka-expense-submit-v1.mjs')",
  "await import('./apply-gati-payment-fast-receipt-v1.mjs')",
], 'final release owner hotfix order');

console.log('PASS GATI payment fast receipt V1: approved-device recovery, durable fast close, duplicate guard, receipt SMS, retained auth-blocked outbox and dev/prod parity verified.');
