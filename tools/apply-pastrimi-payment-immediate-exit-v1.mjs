import fs from 'node:fs';

const PATH = 'app/pastrimi/page.jsx';
const MARKER = 'PASTRIMI_PAYMENT_IMMEDIATE_EXIT_V1';
let source = fs.readFileSync(PATH, 'utf8');

if (source.includes(MARKER)) {
  console.log('[pastrimi-payment-immediate-exit-v1] already installed');
  process.exit(0);
}

const callFrom = `      const payRes = await recordOrderCashPayment({`;
const callTo = `      const payRes = await withTimeout(recordOrderCashPayment({`;
if (!source.includes(callFrom)) throw new Error('PAYMENT_CALL_ANCHOR_NOT_FOUND');
source = source.replace(callFrom, callTo);

const callEndFrom = `        ...(fullPaymentTargetStatus ? { statusOnFullPayment: fullPaymentTargetStatus } : {}),\n      });\n      if (!payRes?.ok || !payRes?.payment || !payRes?.order) throw new Error(payRes?.error || 'ARKA_VERIFY_FAILED');\n      const engineOrder = payRes.order;`;
const callEndTo = `        ...(fullPaymentTargetStatus ? { statusOnFullPayment: fullPaymentTargetStatus } : {}),\n      }), 15000);\n      if (!payRes?.ok || !payRes?.payment || !payRes?.order) throw new Error(payRes?.error || 'ARKA_VERIFY_FAILED');\n      const engineOrder = payRes.order;`;
if (!source.includes(callEndFrom)) throw new Error('PAYMENT_CALL_END_ANCHOR_NOT_FOUND');
source = source.replace(callEndFrom, callEndTo);

const oldBlock = `      const engineData = engineOrder?.data || nextOrder;\n      const enginePay = engineData?.pay || {};\n      const enginePaid = Number(enginePay.paid ?? engineData.clientPaid ?? newPaid) || newPaid;\n      const engineDebt = Number(enginePay.debt ?? engineData.debt ?? newDebt) || 0;\n      const engineStatus = engineOrder?.status || engineData?.status || nextOrder.status;\n      const localOrder = { ...nextOrder, ...engineData, status: engineStatus, pay: { ...nextOrder.pay, ...enginePay } };\n      try { await saveOrderLocal({ id: String(rowPayOrder.id), status: engineStatus, data: localOrder, updated_at: engineOrder?.updated_at || actionAt, _table: 'orders', _synced: true }); } catch {}\n      try { patchBaseMasterRow({ id: rowPayOrder.id, status: engineStatus, data: localOrder, updated_at: engineOrder?.updated_at || actionAt, paid_amount: enginePaid, price_total: localOrder.price_total, _table: 'orders' }); } catch {}\n      try { localStorage.setItem(\`order_\${rowPayOrder.id}\`, JSON.stringify(localOrder)); } catch {}\n\n      setOrders((prev) => (prev || []).map((o) => String(o?.id) === String(rowPayOrder.id)\n        ? { ...o, paid: enginePaid, isPaid: engineDebt <= 0, total: Number(rowPayOrder.total || o?.total || 0), fullOrder: localOrder }\n        : o\n      ));\n      setRowPaySheet(false);\n      setRowPayOrder(null);\n      setRowPayAmount(0);\n      alert('✅ PAGESA U REGJISTRUA.');`;

const newBlock = `      const engineData = engineOrder?.data || nextOrder;\n      const enginePay = engineData?.pay || {};\n      const enginePaid = Number(enginePay.paid ?? engineData.clientPaid ?? newPaid) || newPaid;\n      const engineDebt = Number(enginePay.debt ?? engineData.debt ?? newDebt) || 0;\n      const engineStatus = normalizeStatus(engineOrder?.status || engineData?.status || nextOrder.status) || 'pastrim';\n      const paymentOrderId = String(rowPayOrder.id);\n      const localOrder = { ...nextOrder, ...engineData, status: engineStatus, state: engineStatus, pay: { ...nextOrder.pay, ...enginePay } };\n\n      // ${MARKER}: once ARKA + order are verified, close the payment UI and\n      // remove a delivered client immediately. Local mirrors are secondary and\n      // must never keep the worker blocked on the completed client.\n      setRowPaySheet(false);\n      setRowPayOrder(null);\n      setRowPayAmount(0);\n      if (engineStatus === 'dorzim') {\n        setOrders((prev) => (Array.isArray(prev) ? prev : []).filter((o) => String(o?.id) !== paymentOrderId));\n      } else {\n        setOrders((prev) => (Array.isArray(prev) ? prev : []).map((o) => String(o?.id) === paymentOrderId\n          ? { ...o, status: engineStatus, paid: enginePaid, isPaid: engineDebt <= 0, total: Number(rowPayOrder.total || o?.total || 0), fullOrder: localOrder }\n          : o\n        ));\n      }\n\n      void Promise.resolve().then(async () => {\n        try { await saveOrderLocal({ id: paymentOrderId, status: engineStatus, data: localOrder, updated_at: engineOrder?.updated_at || actionAt, _table: 'orders', _synced: true }); } catch {}\n        try { patchBaseMasterRow({ id: paymentOrderId, status: engineStatus, data: localOrder, updated_at: engineOrder?.updated_at || actionAt, paid_amount: enginePaid, price_total: localOrder.price_total, _table: 'orders' }); } catch {}\n        try { localStorage.setItem(\`order_\${paymentOrderId}\`, JSON.stringify(localOrder)); } catch {}\n        try { await refreshOrders({ force: true, source: 'pastrimi_payment_verified_exit' }); } catch {}\n      });\n\n      alert(engineStatus === 'dorzim'\n        ? '✅ PAGESA U REGJISTRUA. KLIENTI U HOQ NGA PASTRIMI.'\n        : '✅ PAGESA U REGJISTRUA.');`;

if (!source.includes(oldBlock)) throw new Error('PAYMENT_SUCCESS_BLOCK_NOT_FOUND');
source = source.replace(oldBlock, newBlock);
fs.writeFileSync(PATH, source, 'utf8');
console.log('[pastrimi-payment-immediate-exit-v1] installed');
