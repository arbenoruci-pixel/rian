import fs from 'node:fs';

const PATH = 'app/pastrimi/page.jsx';
const MARKER = 'PASTRIMI_PAYMENT_BACKGROUND_V2';
let source = fs.readFileSync(PATH, 'utf8');

if (source.includes(MARKER)) {
  console.log('[pastrimi-payment-background-v2] already installed');
  process.exit(0);
}
if (!source.includes('PASTRIMI_PAYMENT_BACKGROUND_V1')) {
  throw new Error('PASTRIMI_PAYMENT_BACKGROUND_V1_REQUIRED');
}

const importAnchor = "import { buildArkaIdempotencyKey } from '@/lib/arka/arkaClient';";
const importLine = "import { enqueuePastrimiPaymentIntent, removePastrimiPaymentIntent, savePastrimiPaymentIntent } from '@/lib/pastrimiPaymentIntent';";
if (!source.includes(importLine)) {
  if (!source.includes(importAnchor)) throw new Error('PAYMENT_INTENT_IMPORT_ANCHOR_MISSING');
  source = source.replace(importAnchor, `${importAnchor}\n${importLine}`);
}

source = source.replace(
  '// PASTRIMI_PAYMENT_BACKGROUND_V1',
  '// PASTRIMI_PAYMENT_BACKGROUND_V1\n    // PASTRIMI_PAYMENT_BACKGROUND_V2'
);

const oldQueueBlock = `    let durableQueueCreated = false;
    if (pickupNow) {
      try {
        await queueOp('arka_transaction', {
          transaction: {
            action: ARKA_ACTION.BASE_ORDER_PAYMENT,
            actorPin: String(pinData.pin || ''),
            actorName: String(pinData.name || ''),
            actorRole: String(pinData.role || ''),
            orderId,
            amount: applied,
            method: 'CASH',
            note: \`PAGESË NË PASTRIMI \${applied.toFixed(2)}€ • #\${rowPayOrder.code} • \${rowPayOrder.name || ''} • CLIENT_PICKED_UP_TO_DORZIM\`,
            orderCode: rowPayOrder.code,
            clientName: rowPayOrder.name,
            clientPhone: rowPayOrder.phone,
            statusOnFullPayment: 'dorzim',
            status_on_full_payment: 'dorzim',
            idempotencyKey: paymentIdempotencyKey,
            idempotency_key: paymentIdempotencyKey,
          },
        });
        durableQueueCreated = true;
        try { window.dispatchEvent(new Event('tepiha:outbox-changed')); } catch {}
      } catch {}

      try { await saveOrderLocal({ id: orderId, status: 'dorzim', data: optimisticOrder, updated_at: actionAt, _table: 'orders', _synced: false, _syncPending: true }); } catch {}
      try { patchBaseMasterRow({ id: orderId, status: 'dorzim', data: optimisticOrder, updated_at: actionAt, paid_amount: newPaid, price_total: optimisticOrder.price_total, _table: 'orders' }); } catch {}
      try { localStorage.setItem(\`order_\${orderId}\`, JSON.stringify(optimisticOrder)); } catch {}
      setOrders((prev) => (prev || []).filter((o) => String(o?.id) !== orderId));
      setRowPaySheet(false);
      setRowPayOrder(null);
      setRowPayAmount(0);
      setRowPayBusy(false);
    } else {
      setRowPayBusy(true);
    }
`;

const newQueueBlock = `    const paymentTransaction = {
      action: ARKA_ACTION.BASE_ORDER_PAYMENT,
      actorPin: String(pinData.pin || ''),
      actorName: String(pinData.name || ''),
      actorRole: String(pinData.role || ''),
      orderId,
      amount: applied,
      method: 'CASH',
      note: \`PAGESË NË PASTRIMI \${applied.toFixed(2)}€ • #\${rowPayOrder.code} • \${rowPayOrder.name || ''} • \${pickupNow ? 'CLIENT_PICKED_UP_TO_DORZIM' : 'PAID_STAYS_PASTRIMI'}\`,
      orderCode: rowPayOrder.code,
      clientName: rowPayOrder.name,
      clientPhone: rowPayOrder.phone,
      statusOnFullPayment: fullPaymentTargetStatus || undefined,
      status_on_full_payment: fullPaymentTargetStatus || undefined,
      idempotencyKey: paymentIdempotencyKey,
      idempotency_key: paymentIdempotencyKey,
    };
    const paymentIntent = {
      idempotencyKey: paymentIdempotencyKey,
      orderId,
      code: rowPayOrder.code,
      clientName: rowPayOrder.name,
      pickupNow,
      saved_at: actionAt,
      transaction: paymentTransaction,
    };

    // Journal the command synchronously before changing the UI. This is the
    // crash-safe handoff: even if iOS suspends the app immediately afterward,
    // the next app open/online event moves it into the IndexedDB outbox.
    try {
      savePastrimiPaymentIntent(paymentIntent);
    } catch (intentError) {
      alert(\`❌ KOMANDA NUK U RUAJT: \${intentError?.message || 'PROVO PËRSËRI.'}\`);
      return;
    }

    let durableQueueCreated = false;
    if (pickupNow) {
      // User-facing completion must never wait for IndexedDB, network, ARKA,
      // bonus creation or cache refresh. Those continue below in background.
      try { localStorage.setItem(\`order_\${orderId}\`, JSON.stringify(optimisticOrder)); } catch {}
      try { patchBaseMasterRow({ id: orderId, status: 'dorzim', data: optimisticOrder, updated_at: actionAt, paid_amount: newPaid, price_total: optimisticOrder.price_total, _table: 'orders' }); } catch {}
      setOrders((prev) => (prev || []).filter((o) => String(o?.id) !== orderId));
      setRowPaySheet(false);
      setRowPayOrder(null);
      setRowPayAmount(0);
      setRowPayBusy(false);
      try { window.dispatchEvent(new Event('tepiha:outbox-changed')); } catch {}
      void saveOrderLocal({ id: orderId, status: 'dorzim', data: optimisticOrder, updated_at: actionAt, _table: 'orders', _synced: false, _syncPending: true }).catch(() => {});
    } else {
      setRowPayBusy(true);
    }
`;

if (!source.includes(oldQueueBlock)) throw new Error('V1_QUEUE_BLOCK_NOT_FOUND');
source = source.replace(oldQueueBlock, newQueueBlock);

const runStart = `    const runPaymentInBackground = async () => {
      try {
        const payRes = await recordOrderCashPayment({`;
const runStartReplacement = `    const runPaymentInBackground = async () => {
      try {
        try {
          await enqueuePastrimiPaymentIntent(paymentIntent);
          durableQueueCreated = true;
        } catch {
          // The synchronous journal remains and will retry on app open/online.
        }

        const payRes = await recordOrderCashPayment({`;
if (!source.includes(runStart)) throw new Error('BACKGROUND_RUN_START_NOT_FOUND');
source = source.replace(runStart, runStartReplacement);

const queuedReturn = `        if (queued) return;

        const engineOrder = payRes.order;`;
const queuedReturnReplacement = `        if (queued) {
          if (durableQueueCreated) removePastrimiPaymentIntent(paymentIdempotencyKey);
          return;
        }

        removePastrimiPaymentIntent(paymentIdempotencyKey);
        const engineOrder = payRes.order;`;
if (!source.includes(queuedReturn)) throw new Error('QUEUED_RETURN_ANCHOR_NOT_FOUND');
source = source.replace(queuedReturn, queuedReturnReplacement);

const oldCatch = `      } catch (err) {
        if (pickupNow && durableQueueCreated) {
          try { window.dispatchEvent(new Event('tepiha:outbox-changed')); } catch {}
          return;
        }
        if (pickupNow && originalRow) {
          setOrders((prev) => {
            const exists = (prev || []).some((o) => String(o?.id) === orderId);
            return exists ? prev : [originalRow, ...(prev || [])];
          });
        }
        alert(\`❌ PAGESA NUK U RUAJT: \${err?.message || 'PROVO PËRSËRI.'}\`);
      } finally {`;
const newCatch = `      } catch (err) {
        if (pickupNow) {
          // Keep the row hidden: the command is already in the synchronous
          // intent journal and will retry automatically. Restoring the row
          // would invite a second tap for the same cash payment.
          try { window.dispatchEvent(new Event('tepiha:outbox-changed')); } catch {}
          return;
        }
        alert(\`❌ PAGESA NUK U RUAJT: \${err?.message || 'PROVO PËRSËRI.'}\`);
      } finally {`;
if (!source.includes(oldCatch)) throw new Error('BACKGROUND_CATCH_BLOCK_NOT_FOUND');
source = source.replace(oldCatch, newCatch);

fs.writeFileSync(PATH, source, 'utf8');
console.log('[pastrimi-payment-background-v2] installed');
