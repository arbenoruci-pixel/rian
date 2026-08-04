import fs from 'node:fs';

const page = fs.readFileSync('app/pastrimi/page.jsx', 'utf8');
const journal = fs.readFileSync('lib/pastrimiPaymentIntent.js', 'utf8');
const failures = [];
const check = (ok, msg) => { if (!ok) failures.push(msg); };

check(page.includes('PASTRIMI_PAYMENT_BACKGROUND_V2'), 'V2 marker missing');
check(page.includes('savePastrimiPaymentIntent(paymentIntent)'), 'synchronous intent save missing');
check(page.includes('await enqueuePastrimiPaymentIntent(paymentIntent)'), 'background outbox enqueue missing');
check(page.includes('removePastrimiPaymentIntent(paymentIdempotencyKey)'), 'intent cleanup missing');
check(page.includes("setOrders((prev) => (prev || []).filter((o) => String(o?.id) !== orderId))"), 'immediate row removal missing');
check(page.includes('void saveOrderLocal({ id: orderId'), 'non-blocking local mirror missing');
check(page.includes('the command is already in the synchronous'), 'retry-safe failure policy missing');
check(page.indexOf('savePastrimiPaymentIntent(paymentIntent)') < page.indexOf("setOrders((prev) => (prev || []).filter"), 'intent must be saved before row removal');
check(page.indexOf("setOrders((prev) => (prev || []).filter") < page.indexOf('await enqueuePastrimiPaymentIntent(paymentIntent)'), 'UI must finish before IndexedDB enqueue');

check(journal.includes("const KEY = 'tepiha_pastrimi_payment_intents_v1'"), 'journal key missing');
check(journal.includes('window.localStorage.setItem(KEY'), 'synchronous localStorage journal missing');
check(journal.includes("queueOp('arka_transaction'"), 'outbox bridge missing');
check(journal.includes('idempotencyKey'), 'idempotency key missing');
check(journal.includes("window.addEventListener('online', run)"), 'online auto retry missing');
check(journal.includes("window.addEventListener('pageshow', run)"), 'pageshow auto retry missing');
check(journal.includes("document.visibilityState === 'visible'"), 'visibility auto retry missing');
check(journal.includes('removePastrimiPaymentIntent(stored.idempotencyKey)'), 'journal removal after queue missing');
check(journal.includes('if (flushing) return flushing'), 'parallel flush guard missing');

if (failures.length) {
  console.error(`FAIL: ${failures.length} Pastrimi payment background V2 check(s) failed.`);
  failures.forEach((item, index) => console.error(`${index + 1}. ${item}`));
  process.exit(1);
}
console.log('PASS: 18 Pastrimi payment background V2 checks passed.');
