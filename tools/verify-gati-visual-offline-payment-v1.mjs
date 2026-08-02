import fs from 'node:fs';

const files = {
  gati: fs.readFileSync('app/gati/page.jsx', 'utf8'),
  bridge: fs.readFileSync('lib/gatiVisualParityBridge.js', 'utf8'),
  arkaClient: fs.readFileSync('lib/arka/arkaClient.js', 'utf8'),
  syncEngine: fs.readFileSync('lib/syncEngine.js', 'utf8'),
  syncRunner: fs.readFileSync('components/OfflineSyncRunner.jsx', 'utf8'),
  main: fs.readFileSync('src/main.jsx', 'utf8'),
};

const failures = [];
function check(condition, message) {
  if (!condition) failures.push(message);
}

check(files.main.includes('installGatiVisualParityBridge'), 'GATI visual bridge must be installed in main runtime');
check(files.bridge.includes("return path === '/gati'"), 'Visual bridge must be strictly scoped to /gati');
check(files.bridge.includes('data-gati-card'), 'Visual bridge must mark only GATI order cards');
check(files.bridge.includes('data-gati-list-container'), 'Visual bridge must mark the GATI list container');
check(!/supabase|arkaTransaction|queueOp|updateOrder|insert\(/.test(files.bridge), 'Visual bridge must not contain DB/payment mutations');

check(files.gati.includes('GATI_OFFLINE_PAYMENT_V1'), 'GATI offline payment patch marker missing');
check(files.gati.includes('async function finalizeDeliveredUi(payload, options = {})'), 'GATI finalize UI must accept sync-pending mode');
check(files.gati.includes('_synced: !syncPending'), 'Offline UI shadow must stay marked unsynced');
check(files.gati.includes('_syncPending: syncPending'), 'Offline UI shadow must preserve pending state');
check(files.gati.includes("payment_sync_state: 'OUTBOX_PENDING'"), 'Offline payment must carry an outbox pending marker');
check(files.gati.includes('payment_idempotency_key: idempotencyKey'), 'Offline payment must preserve its idempotency key');
check(files.gati.includes('payRes?.offlineQueued || payRes?.queued || payRes?.localOnly'), 'GATI must recognize an ARKA queued result');
check(files.gati.includes('finalizeDeliveredUi(queuedPayload, { syncPending: true })'), 'Queued payment must close only the local GATI UI');
check(files.gati.includes("throw new Error(payRes?.error || 'ARKA_PAYMENT_VERIFY_FAILED')"), 'Real ARKA verification failures must remain blocking');
check(files.gati.includes("queueOp('patch_order_data'"), 'Paid-up delivery must also have an offline outbox path');
check(files.gati.includes("showFastPayNotice('U konfirmu. Mund të vazhdosh me klientin tjetër.'"), 'Worker should receive the same normal success feedback');

check(files.arkaClient.includes("const OFFLINE_QUEUE_TYPE = 'arka_transaction'"), 'ARKA client must queue one canonical transaction type');
check(files.arkaClient.includes('idempotencyKey'), 'ARKA queue must preserve idempotency');
check(files.syncEngine.includes("if (type === 'arka_transaction')"), 'Sync engine must own queued ARKA transaction delivery');
check(files.syncEngine.includes('_offline_flush: true'), 'Background ARKA flush must be explicitly marked');
check(files.syncEngine.includes('postArkaTransaction'), 'Background sync must use the canonical ARKA endpoint');
check(files.syncRunner.includes("window.addEventListener('online'"), 'Offline sync runner must wake when internet returns');
check(files.syncRunner.includes("window.addEventListener('tepiha:outbox-changed'"), 'Offline sync runner must wake when a payment is queued');
check(files.syncRunner.includes("window.addEventListener('TEPIHA_SYNC_TRIGGER'"), 'Offline sync runner must support immediate background triggers');

const queuedBranchStart = files.gati.indexOf('const queuedOffline = Boolean(');
const queuedBranchEnd = files.gati.indexOf("if (!payRes?.ok || !payRes?.payment?.id || !payRes?.order?.id)", queuedBranchStart);
const queuedBranch = queuedBranchStart >= 0 && queuedBranchEnd > queuedBranchStart
  ? files.gati.slice(queuedBranchStart, queuedBranchEnd)
  : '';
check(queuedBranch.includes('setPayBusy(false);') && queuedBranch.includes('return;'), 'Queued payment branch must finish cleanly without falling into the error alert');
check(!/alert\s*\(/.test(queuedBranch), 'Queued payment branch must not show an offline/error alert to the worker');

if (failures.length) {
  console.error(`FAIL: ${failures.length} GATI visual/offline safety check(s) failed.`);
  failures.forEach((message, index) => console.error(`${index + 1}. ${message}`));
  process.exit(1);
}

console.log('PASS: 24 GATI visual/offline payment safety checks passed.');
