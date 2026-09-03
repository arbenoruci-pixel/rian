import fs from 'node:fs';

const PAGE_PATH = 'app/transport/pranimi/page.jsx';
const MARKER = 'TRANSPORT_PAYMENT_FAST_CLOSE_V1';

function replaceOnce(source, oldText, newText, label) {
  if (source.includes(newText)) return source;
  const count = source.split(oldText).length - 1;
  if (count !== 1) throw new Error(`${label}: expected one match, found ${count}`);
  return source.replace(oldText, newText);
}

let page = fs.readFileSync(PAGE_PATH, 'utf8');

if (!page.includes(MARKER)) {
  const paymentStart = `      paymentBusyRef.current = true;\n      setPaymentBusy(true);\n      try {\n        const ledgerResult = await collectTransportClientPayment({`;
  const fastPaymentStart = `      // ${MARKER}: once the durable payment intent exists, close the cash sheet immediately.\n      // The verified ledger write continues in the same handler and all existing idempotency/recovery guards stay active.\n      setPayAdd(0);\n      setShowPaySheet(false);\n      paymentBusyRef.current = true;\n      setPaymentBusy(true);\n      try {\n        const ledgerResult = await collectTransportClientPayment({`;
  page = replaceOnce(page, paymentStart, fastPaymentStart, 'TRANSPORT_FAST_CLOSE_START');

  const paymentCatch = `      } catch (error) {\n        // Preserve the same key on ambiguous failures. The explicit balance\n        // guard is the only pre-write rejection that is safe to clear.\n        setPayAdd(paymentIntent.amountReceived);`;
  const fastPaymentCatch = `      } catch (error) {\n        // ${MARKER}: a failed/unverified request reopens the exact durable intent.\n        // This keeps the UI fast on success and fail-closed when the server cannot verify the money.\n        setPayAdd(paymentIntent.amountReceived);\n        setShowPaySheet(true);\n        // Preserve the same key on ambiguous failures. The explicit balance\n        // guard is the only pre-write rejection that is safe to clear.`;
  page = replaceOnce(page, paymentCatch, fastPaymentCatch, 'TRANSPORT_FAST_CLOSE_CATCH');
}

const markerAt = page.indexOf(MARKER);
const acquireAt = page.lastIndexOf('await acquireTransportPaymentIntent', markerAt);
const closeAt = page.indexOf('setShowPaySheet(false);', markerAt);
const ledgerAt = page.indexOf('await collectTransportClientPayment', markerAt);
const reopenAt = page.indexOf('setShowPaySheet(true);', ledgerAt);
if (markerAt < 0) throw new Error('TRANSPORT_FAST_CLOSE_MARKER_MISSING');
if (acquireAt < 0 || acquireAt > closeAt) throw new Error('TRANSPORT_FAST_CLOSE_DURABLE_INTENT_ORDER_INVALID');
if (closeAt < 0 || ledgerAt < 0 || closeAt > ledgerAt) throw new Error('TRANSPORT_FAST_CLOSE_UI_ORDER_INVALID');
if (reopenAt < 0) throw new Error('TRANSPORT_FAST_CLOSE_FAILURE_REOPEN_MISSING');
if (!page.includes('paymentIntent.idempotencyKey')) throw new Error('TRANSPORT_FAST_CLOSE_IDEMPOTENCY_MISSING');
if (!page.includes('await clearTransportPaymentIntent(oid, paymentIntent.idempotencyKey)')) throw new Error('TRANSPORT_FAST_CLOSE_CLEAR_AFTER_VERIFY_MISSING');

fs.writeFileSync(PAGE_PATH, page, 'utf8');
console.log('PASS Transport payment fast close V1: durable intent first, instant sheet close, verified ledger write, safe retry reopen.');
