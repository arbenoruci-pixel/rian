import fs from 'node:fs';

const PATH = 'app/pastrimi/page.jsx';
const MARKER = 'PASTRIMI_PAYMENT_BACKGROUND_V1';

function scanMatching(source, start, openChar, closeChar, label) {
  if (source[start] !== openChar) throw new Error(`${label}_OPEN_NOT_FOUND`);
  let depth = 0;
  let quote = '';
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1] || '';
    if (lineComment) { if (ch === '\n') lineComment = false; continue; }
    if (blockComment) { if (ch === '*' && next === '/') { blockComment = false; i += 1; } continue; }
    if (quote) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '/' && next === '/') { lineComment = true; i += 1; continue; }
    if (ch === '/' && next === '*') { blockComment = true; i += 1; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === openChar) depth += 1;
    if (ch === closeChar) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  throw new Error(`${label}_UNTERMINATED`);
}

function replaceNamedFunction(source, name, replacement) {
  const match = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(source);
  if (!match) throw new Error(`${name}_NOT_FOUND`);
  const paramsStart = source.indexOf('(', match.index);
  const paramsEnd = scanMatching(source, paramsStart, '(', ')', `${name}_PARAMS`);
  let bodyStart = paramsEnd + 1;
  while (/\s/.test(source[bodyStart] || '')) bodyStart += 1;
  const bodyEnd = scanMatching(source, bodyStart, '{', '}', `${name}_BODY`);
  return `${source.slice(0, match.index)}${replacement}${source.slice(bodyEnd + 1)}`;
}

function ensureImport(source, line, anchor) {
  if (source.includes(line)) return source;
  if (!source.includes(anchor)) throw new Error(`IMPORT_ANCHOR_MISSING:${anchor}`);
  return source.replace(anchor, `${anchor}\n${line}`);
}

let source = fs.readFileSync(PATH, 'utf8');
if (source.includes(MARKER)) {
  console.log('[pastrimi-payment-background-v1] already installed');
  process.exit(0);
}

source = ensureImport(
  source,
  "import { ARKA_ACTION } from '@/lib/arka/arkaConstants';",
  "import { recordOrderCashPayment } from '@/components/payments/payService';"
);
source = ensureImport(
  source,
  "import { buildArkaIdempotencyKey } from '@/lib/arka/arkaClient';",
  "import { ARKA_ACTION } from '@/lib/arka/arkaConstants';"
);

const replacement = `async function applyRowPayAndClose() {
    // ${MARKER}
    if (!rowPayOrder || rowPayBusy) return;

    const cashGiven = Number((Number(rowPayAmount) || 0).toFixed(2));
    const due = Math.max(0, Number((Number(rowPayOrder.total || 0) - Number(rowPayOrder.paid || 0)).toFixed(2)));
    if (due <= 0) {
      alert('KJO POROSI ËSHTË E PAGUAR PLOTËSISHT.');
      return;
    }
    if (cashGiven <= 0) {
      alert('SHKRUANI SHUMËN!');
      return;
    }

    const applied = Math.min(cashGiven, due);
    const remaining = Math.max(0, Number((due - applied).toFixed(2)));
    const kusuri = Math.max(0, cashGiven - due);
    const willSettleFull = remaining <= 0.01;
    const fullPaymentTargetStatus = willSettleFull
      ? askPastrimiPaidPickupTarget({ code: rowPayOrder.code, clientName: rowPayOrder.name })
      : '';
    const pickupNow = willSettleFull && fullPaymentTargetStatus === 'dorzim';
    const destinationLine = willSettleFull
      ? (pickupNow
        ? 'VEPRIMI: KLIENTI I MERR — KALO NË DORZIM'
        : 'VEPRIMI: PAGUAR — MBETET NË PASTRIMI')
      : 'VEPRIMI: PAGESË PARTIALE — MBETET STATUSI AKTUAL';

    const pinLabel = \`PAGESË NË PASTRIMI\\nKODI: \${rowPayOrder.code}\\n\\nPAGESË SOT: \${applied.toFixed(2)}€\\nKLIENTI DHA: \${cashGiven.toFixed(2)}€\\nKUSURI: \${kusuri.toFixed(2)}€\\nBORXHI PAS: \${remaining.toFixed(2)}€\\n\${destinationLine}\\n\\n👉 SHKRUAJ PIN-IN TËND PËR TË KRYER PAGESËN:\`;
    const pinData = await requirePaymentPin({ label: pinLabel });
    if (!pinData) return;

    const actionAt = new Date().toISOString();
    const orderId = String(rowPayOrder.id || '').trim();
    const paymentIdempotencyKey = buildArkaIdempotencyKey(ARKA_ACTION.BASE_ORDER_PAYMENT, [orderId, applied, pinData.pin]);
    const newPaid = Number((Number(rowPayOrder.paid || 0) + applied).toFixed(2));
    const newDebt = Math.max(0, Number((Number(rowPayOrder.total || 0) - newPaid).toFixed(2)));
    const baseOrder = rowPayOrder.order || {};
    const existingPay = (baseOrder?.pay && typeof baseOrder.pay === 'object') ? baseOrder.pay : {};
    const nextOrder = {
      ...baseOrder,
      id: orderId || String(baseOrder?.id || ''),
      status: normalizeStatus(baseOrder?.status || 'pastrim') || 'pastrim',
      code: rowPayOrder.code || baseOrder?.code || '',
      client_name: baseOrder?.client_name || baseOrder?.client?.name || rowPayOrder.name || '',
      client_phone: baseOrder?.client_phone || baseOrder?.client?.phone || rowPayOrder.phone || '',
      price_total: Number(baseOrder?.price_total ?? existingPay?.euro ?? rowPayOrder.total ?? 0) || 0,
      paid_cash: newPaid,
      pay: {
        ...existingPay,
        euro: Number(existingPay?.euro ?? rowPayOrder.total ?? 0) || 0,
        paid: newPaid,
        debt: newDebt,
        arkaRecordedPaid: Number((Number(existingPay?.arkaRecordedPaid || 0) + applied).toFixed(2)),
        method: 'CASH',
        paidUpfront: !!existingPay?.paidUpfront,
      },
      clientPaid: newPaid,
      paid: newPaid,
      debt: newDebt,
      isPaid: newDebt <= 0,
      updated_at: actionAt,
    };
    if (!nextOrder.client || typeof nextOrder.client !== 'object') nextOrder.client = {};
    nextOrder.client = {
      ...nextOrder.client,
      name: nextOrder.client?.name || nextOrder.client_name || rowPayOrder.name || '',
      phone: nextOrder.client?.phone || nextOrder.client_phone || rowPayOrder.phone || '',
      code: nextOrder.client?.code || rowPayOrder.code || '',
    };

    const originalRow = (orders || []).find((o) => String(o?.id) === orderId) || null;
    const optimisticOrder = pickupNow ? {
      ...nextOrder,
      status: 'dorzim',
      state: 'dorzim',
      delivered_at: actionAt,
      picked_up_at: actionAt,
      payment_sync_state: 'BACKGROUND_PENDING',
      delivery_sync_state: 'BACKGROUND_PENDING',
      payment_idempotency_key: paymentIdempotencyKey,
      last_payment_by_pin: String(pinData.pin || ''),
      last_payment_by_name: String(pinData.name || ''),
    } : nextOrder;

    let durableQueueCreated = false;
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

    const runPaymentInBackground = async () => {
      try {
        const payRes = await recordOrderCashPayment({
          rawOrder: {
            ...nextOrder,
            status: fullPaymentTargetStatus || nextOrder.status || 'pastrim',
          },
          orderId,
          code: rowPayOrder.code,
          clientName: rowPayOrder.name,
          clientPhone: rowPayOrder.phone,
          amount: applied,
          note: \`PAGESË NË PASTRIMI \${applied.toFixed(2)}€ • #\${rowPayOrder.code} • \${rowPayOrder.name || ''} • \${pickupNow ? 'CLIENT_PICKED_UP_TO_DORZIM' : 'PAID_STAYS_PASTRIMI'}\`,
          source: 'PASTRIMI_ROW_PAY',
          payMethod: 'CASH',
          user: pinData,
          idempotencyKey: paymentIdempotencyKey,
          idempotency_key: paymentIdempotencyKey,
          ...(fullPaymentTargetStatus ? { statusOnFullPayment: fullPaymentTargetStatus } : {}),
        });

        const queued = !!(payRes?.queued || payRes?.offlineQueued || payRes?.localOnly || payRes?.pending);
        if ((!payRes?.ok || !payRes?.payment || !payRes?.order) && !queued) {
          throw new Error(payRes?.error || 'ARKA_VERIFY_FAILED');
        }
        if (queued) return;

        const engineOrder = payRes.order;
        const engineData = engineOrder?.data || nextOrder;
        const enginePay = engineData?.pay || {};
        const enginePaid = Number(enginePay.paid ?? engineData.clientPaid ?? newPaid) || newPaid;
        const engineDebt = Number(enginePay.debt ?? engineData.debt ?? newDebt) || 0;
        const engineStatus = engineOrder?.status || engineData?.status || nextOrder.status;
        const localOrder = { ...nextOrder, ...engineData, status: engineStatus, pay: { ...nextOrder.pay, ...enginePay } };
        try { await saveOrderLocal({ id: orderId, status: engineStatus, data: localOrder, updated_at: engineOrder?.updated_at || actionAt, _table: 'orders', _synced: true }); } catch {}
        try { patchBaseMasterRow({ id: orderId, status: engineStatus, data: localOrder, updated_at: engineOrder?.updated_at || actionAt, paid_amount: enginePaid, price_total: localOrder.price_total, _table: 'orders' }); } catch {}
        try { localStorage.setItem(\`order_\${orderId}\`, JSON.stringify(localOrder)); } catch {}

        if (!pickupNow) {
          setOrders((prev) => (prev || []).map((o) => String(o?.id) === orderId
            ? { ...o, paid: enginePaid, isPaid: engineDebt <= 0, total: Number(rowPayOrder.total || o?.total || 0), fullOrder: localOrder }
            : o
          ));
          setRowPaySheet(false);
          setRowPayOrder(null);
          setRowPayAmount(0);
          alert('✅ PAGESA U REGJISTRUA.');
        }
      } catch (err) {
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
      } finally {
        if (!pickupNow) setRowPayBusy(false);
      }
    };

    if (pickupNow) {
      Promise.resolve().then(runPaymentInBackground);
      return;
    }
    await runPaymentInBackground();
  }`;

source = replaceNamedFunction(source, 'applyRowPayAndClose', replacement);
fs.writeFileSync(PATH, source, 'utf8');
console.log('[pastrimi-payment-background-v1] installed');
