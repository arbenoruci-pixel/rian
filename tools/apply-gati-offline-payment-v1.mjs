import fs from 'node:fs';

const path = 'app/gati/page.jsx';
const marker = 'GATI_OFFLINE_PAYMENT_V1';
let source = fs.readFileSync(path, 'utf8');
let changed = false;

function replaceOnce(input, from, to, label) {
  if (!input.includes(from)) throw new Error(`${label}_ANCHOR_NOT_FOUND`);
  return input.replace(from, to);
}

if (!source.includes(marker)) {
  const finalizeStartToken = '  async function finalizeDeliveredUi(payload) {';
  const finalizeEndToken = '\n  function closePay() {';
  const start = source.indexOf(finalizeStartToken);
  const end = source.indexOf(finalizeEndToken, start);
  if (start < 0 || end < 0) throw new Error('GATI_FINALIZE_DELIVERED_UI_BLOCK_NOT_FOUND');

  let finalizeBlock = source.slice(start, end);
  finalizeBlock = replaceOnce(
    finalizeBlock,
    finalizeStartToken,
    `  async function finalizeDeliveredUi(payload, options = {}) {\n    // ${marker}: an outbox-backed offline payment may close only the local UI.\n    const syncPending = options?.syncPending === true;`,
    'GATI_FINALIZE_SIGNATURE'
  );

  const syncedCount = (finalizeBlock.match(/_synced:\s*true/g) || []).length;
  if (syncedCount !== 2) throw new Error(`GATI_FINALIZE_SYNCED_FIELD_COUNT_${syncedCount}`);
  finalizeBlock = finalizeBlock.replace(/(\s*)_synced:\s*true,\n/g, (_match, indent) => (
    `${indent}_synced: !syncPending,\n` +
    `${indent}_syncPending: syncPending,\n` +
    `${indent}dirty: syncPending,\n` +
    `${indent}pending_ops: syncPending ? 1 : 0,\n`
  ));

  finalizeBlock = replaceOnce(
    finalizeBlock,
    '    clearPaymentDoneButDeliveryPending(payload?.id);',
    '    if (!syncPending) clearPaymentDoneButDeliveryPending(payload?.id);',
    'GATI_FINALIZE_PENDING_CLEAR'
  );

  source = `${source.slice(0, start)}${finalizeBlock}${source.slice(end)}`;

  const paymentBlockOld = `        const payRes = await recordOrderCashPayment({\n          ...payload,\n          payment_external_id: idempotencyKey,\n          idempotencyKey,\n          idempotency_key: idempotencyKey,\n        }, applied, pinData, payMethod);\n        if (!payRes?.ok || !payRes?.payment?.id || !payRes?.order?.id) {\n          throw new Error(payRes?.error || 'ARKA_PAYMENT_VERIFY_FAILED');\n        }\n        const engineOrder = payRes.order || {};`;

  const paymentBlockNew = `        const payRes = await recordOrderCashPayment({\n          ...payload,\n          payment_external_id: idempotencyKey,\n          idempotencyKey,\n          idempotency_key: idempotencyKey,\n        }, applied, pinData, payMethod);\n\n        // ${marker}: arkaTransaction already persisted this exact idempotent\n        // payment in IndexedDB. Close the worker UI quietly; OfflineSyncRunner\n        // sends it when connectivity returns and the ARKA engine updates the\n        // order atomically on the server.\n        const queuedOffline = Boolean(payRes?.offlineQueued || payRes?.queued || payRes?.localOnly);\n        if (queuedOffline) {\n          const queuedPayload = {\n            ...optimisticPayload,\n            offline_payment_pending: true,\n            payment_sync_state: 'OUTBOX_PENDING',\n            payment_outbox_op_id: payRes?.queuedOpId || null,\n            payment_idempotency_key: idempotencyKey,\n            updated_at: actionAt,\n          };\n          await finalizeDeliveredUi(queuedPayload, { syncPending: true });\n          showFastPayNotice('U konfirmu. Mund të vazhdosh me klientin tjetër.', 'ok', 2200);\n          try { window.dispatchEvent(new Event('tepiha:outbox-changed')); } catch {}\n          setPayBusy(false);\n          return;\n        }\n\n        if (!payRes?.ok || !payRes?.payment?.id || !payRes?.order?.id) {\n          throw new Error(payRes?.error || 'ARKA_PAYMENT_VERIFY_FAILED');\n        }\n        const engineOrder = payRes.order || {};`;

  source = replaceOnce(source, paymentBlockOld, paymentBlockNew, 'GATI_OFFLINE_PAYMENT_RESULT');

  const noPaymentBlockOld = `      } else {\n        await closeOrderStatusWithVerification(orderId, payload);\n      }`;
  const noPaymentBlockNew = `      } else {\n        const offlineAtConfirm = typeof navigator !== 'undefined' && navigator.onLine === false;\n        if (offlineAtConfirm) {\n          const deliveryOpId = await queueOp('patch_order_data', {\n            id: orderId,\n            table: 'orders',\n            status: 'dorzim',\n            data: {\n              status: 'dorzim',\n              data: payload,\n              updated_at: payload?.updated_at || actionAt,\n              delivered_at: payload?.delivered_at || actionAt,\n              picked_up_at: payload?.picked_up_at || actionAt,\n            },\n          });\n          const queuedDeliveryPayload = {\n            ...payload,\n            offline_delivery_pending: true,\n            delivery_sync_state: 'OUTBOX_PENDING',\n            delivery_outbox_op_id: deliveryOpId || null,\n          };\n          await finalizeDeliveredUi(queuedDeliveryPayload, { syncPending: true });\n          showFastPayNotice('U konfirmu. Mund të vazhdosh me klientin tjetër.', 'ok', 2200);\n          setPayBusy(false);\n          return;\n        }\n        await closeOrderStatusWithVerification(orderId, payload);\n      }`;

  source = replaceOnce(source, noPaymentBlockOld, noPaymentBlockNew, 'GATI_OFFLINE_DELIVERY_ONLY');
  changed = true;
}

if (changed) fs.writeFileSync(path, source, 'utf8');
console.log(`[gati-offline-payment-v1] ${changed ? 'installed' : 'already installed'}`);
