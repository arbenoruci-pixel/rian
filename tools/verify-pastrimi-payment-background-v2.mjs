import fs from 'node:fs';

const page = fs.readFileSync('app/pastrimi/page.jsx', 'utf8');
const journal = fs.readFileSync('lib/pastrimiPaymentIntent.js', 'utf8');
const failures = [];
const check = (ok, msg) => { if (!ok) failures.push(msg); };

check(page.includes('PASTRIMI_PAYMENT_BACKGROUND_V2'), 'V2 page marker missing');
check(page.includes('savePastrimiPaymentIntent(paymentIntent)'), 'synchronous intent save missing');
check(page.includes('await enqueuePastrimiPaymentIntent(paymentIntent)'), 'background outbox enqueue missing');
check(page.includes('removePastrimiPaymentIntent(paymentIdempotencyKey)'), 'intent cleanup missing');
check(page.includes("setOrders((prev) => (prev || []).filter((o) => String(o?.id) !== orderId))"), 'immediate row removal missing');
check(page.includes('void saveOrderLocal({ id: orderId'), 'non-blocking local mirror missing');
check(page.includes('the command is already in the synchronous'), 'retry-safe failure policy missing');
check(page.indexOf('savePastrimiPaymentIntent(paymentIntent)') < page.indexOf("setOrders((prev) => (prev || []).filter"), 'intent must be saved before row removal');
check(page.indexOf("setOrders((prev) => (prev || []).filter") < page.indexOf('await enqueuePastrimiPaymentIntent(paymentIntent)'), 'UI must finish before IndexedDB enqueue');

check(journal.includes('PASTRIMI_PAYMENT_INTENT_RESILIENCE_V3'), 'V3 resilience marker missing');
check(journal.includes("const KEY = 'tepiha_pastrimi_payment_intents_v1'"), 'primary journal key missing');
check(journal.includes('window.localStorage'), 'localStorage primary journal missing');
check(journal.includes('window.sessionStorage'), 'sessionStorage fallback missing');
check(journal.includes('const memoryJournal = new Map()'), 'memory fallback missing');
check(journal.includes('indexedDB.open(DB_NAME, 1)'), 'IndexedDB fallback missing');
check(journal.includes('caches.open(CACHE_NAME)'), 'Cache Storage fallback missing');
check(journal.includes('storage_compact_recovery'), 'quota compaction recovery missing');
check(journal.includes('sync_storage_fallback'), 'sync fallback diagnostic missing');
check(journal.includes('async_storage_failed'), 'async fallback diagnostic missing');
check(!journal.includes("throw new Error('PASTRIMI_PAYMENT_INTENT_STORAGE_FAILED')"), 'single-storage fatal error must be removed');
check(journal.includes("queueOp('arka_transaction'"), 'outbox bridge missing');
check(journal.includes('idempotencyKey'), 'idempotency key missing');
check(journal.includes('await persistIntentAsync(stored)'), 'async durable persistence before outbox missing');
check(journal.includes("window.addEventListener('online', run)"), 'online auto retry missing');
check(journal.includes("window.addEventListener('pageshow', run)"), 'pageshow auto retry missing');
check(journal.includes("window.addEventListener('focus', run)"), 'focus auto retry missing');
check(journal.includes("window.addEventListener('storage', run)"), 'cross-tab storage retry missing');
check(journal.includes("document.visibilityState === 'visible'"), 'visibility auto retry missing');
check(journal.includes('await deleteIntentAsync(stored.idempotencyKey)'), 'all-store cleanup after queue missing');
check(journal.includes('if (flushing) return flushing'), 'parallel flush guard missing');

if (failures.length) {
  console.error(`FAIL: ${failures.length} Pastrimi payment resilience check(s) failed.`);
  failures.forEach((item, index) => console.error(`${index + 1}. ${item}`));
  process.exit(1);
}
console.log('PASS: 30 Pastrimi payment background/resilience checks passed.');
