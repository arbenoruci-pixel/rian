import fs from 'node:fs';

const PAGE_PATH = 'app/transport/pranimi/page.jsx';
const ENGINE_PATH = 'lib/arka/arkaEngine.js';
const MARKER = 'TRANSPORT_PAYMENT_CONFIRM_CLOSE_V1';

function scanMatching(source, start, openChar, closeChar) {
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
    if (ch === closeChar && --depth === 0) return i;
  }
  return -1;
}

function functionRange(source, name) {
  const match = new RegExp('(?:export\\s+)?(?:async\\s+)?function\\s+' + name + '\\s*\\(').exec(source);
  if (!match) throw new Error(name + ': function not found');
  const paramsStart = source.indexOf('(', match.index);
  const paramsEnd = scanMatching(source, paramsStart, '(', ')');
  let bodyStart = paramsEnd + 1;
  while (/\s/.test(source[bodyStart])) bodyStart += 1;
  const bodyEnd = scanMatching(source, bodyStart, '{', '}');
  if (paramsEnd < 0 || source[bodyStart] !== '{' || bodyEnd < 0) throw new Error(name + ': invalid function range');
  return { start: match.index, end: bodyEnd + 1 };
}

function replaceNamedFunction(source, name, nextFunction) {
  const range = functionRange(source, name);
  return source.slice(0, range.start) + nextFunction + source.slice(range.end);
}

function replaceOnce(source, oldText, newText, label) {
  if (source.includes(newText)) return source;
  const count = source.split(oldText).length - 1;
  if (count !== 1) throw new Error(label + ': expected one match, found ' + count);
  return source.replace(oldText, newText);
}

let page = fs.readFileSync(PAGE_PATH, 'utf8');
if (!page.includes(MARKER + ':PAGE')) {
  page = replaceNamedFunction(page, 'persistTransportPaymentState', `async function persistTransportPaymentState({
    nextClientPaid,
    nextArkaPaid,
    paymentActor,
    currentOrderOverride = null,
  } = {}) {
    // ${MARKER}:PAGE — verified cash must finish once, even when the first UI response is lost.
    if (!isEdit || !oid) return { ok: true, skipped: true };

    const paidValue = round2(Math.max(0, Number(nextClientPaid || 0)));
    const arkaValue = round2(Math.max(0, Number(nextArkaPaid || 0)));
    let currentOrder = currentOrderOverride && typeof currentOrderOverride === 'object'
      ? currentOrderOverride
      : null;
    if (!currentOrder?.id) {
      currentOrder = await fetchTransportOrderById(oid).catch(() => null);
    }
    if (!currentOrder?.id) throw new Error('TRANSPORT_ORDER_NOT_FOUND_AFTER_PAYMENT');

    const currentData = currentOrder?.data && typeof currentOrder.data === 'object'
      ? currentOrder.data
      : {};
    const currentPay = currentData?.pay && typeof currentData.pay === 'object'
      ? currentData.pay
      : {};
    const completedAt = new Date().toISOString();
    const terminalStatus = 'done';
    const nextData = {
      ...currentData,
      status: terminalStatus,
      state: terminalStatus,
      pay: {
        ...currentPay,
        paid: paidValue,
        arkaRecordedPaid: arkaValue,
        debt: 0,
        method: String(payMethod || currentPay?.method || 'CASH').toUpperCase(),
        last_paid_at: currentPay?.last_paid_at || completedAt,
      },
      clientPaid: paidValue,
      paid: paidValue,
      debt: 0,
      isPaid: true,
      paid_done: true,
      paid_at: currentData?.paid_at || completedAt,
      completed_at: currentData?.completed_at || completedAt,
      delivered_at: currentData?.delivered_at || completedAt,
      done_at: currentData?.done_at || completedAt,
      completed_by_pin: String(paymentActor?.pin || currentData?.completed_by_pin || '').trim() || null,
      completed_by_name: String(paymentActor?.name || currentData?.completed_by_name || '').trim() || null,
      updated_at: completedAt,
    };

    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const updatedOrder = await updateTransportOrderById(oid, {
          status: terminalStatus,
          data: nextData,
          updated_at: completedAt,
        });
        return { ok: true, order: updatedOrder || { ...currentOrder, status: terminalStatus, data: nextData } };
      } catch (error) {
        lastError = error;
        if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 350));
      }
    }

    const readback = await fetchTransportOrderById(oid).catch(() => null);
    const readbackData = readback?.data && typeof readback.data === 'object' ? readback.data : {};
    const readbackPay = readbackData?.pay && typeof readbackData.pay === 'object' ? readbackData.pay : {};
    const readbackPaid = round2(Math.max(Number(readbackPay?.paid || 0), Number(readbackPay?.arkaRecordedPaid || 0)));
    const readbackStatus = String(readback?.status || readbackData?.status || '').trim().toLowerCase();
    if (readback?.id && readbackPaid + 0.01 >= paidValue && ['done', 'completed', 'delivered'].includes(readbackStatus)) {
      return { ok: true, order: readback, verifiedByReadback: true };
    }
    throw lastError || new Error('TRANSPORT_PAYMENT_FINALIZE_FAILED');
  }`);

  page = replaceNamedFunction(page, 'applyPayAndClose', `async function applyPayAndClose() {
    if (paymentBusyRef.current || paymentBusy) return;
    const add = round2(payAdd);
    if (add <= 0) {
      alert('SHKRUANI SHUMËN QË PAGUAN KLIENTI.');
      return;
    }
    const dueNow = round2(Math.max(0, totalEuro - clientPaid));
    if (dueNow <= 0) {
      alert('POROSIA ËSHTË PAGUAR PLOTËSISHT.');
      setShowPaySheet(false);
      return;
    }
    if (add + 0.001 < dueNow) {
      alert('PAGESA DUHET TË MBULOJË BORXHIN E SOTËM.');
      return;
    }

    const pinResult = requirePaymentPin();
    if (!pinResult?.ok) {
      if (!pinResult?.cancelled) alert(pinResult?.error || 'PIN I PAVLEFSHËM.');
      return;
    }

    const paymentActor = pinResult.actor;
    const nextClientPaid = round2(clientPaid + add);
    const nextArkaPaid = round2(arkaRecordedPaid + add);
    const currentEditStatus = String(editRowStatus || '').trim().toLowerCase();
    const shouldFinalizeDelivery = Boolean(
      isEdit && ['delivery', 'dorzim', 'dorezim', 'dorëzim', 'delivered'].includes(currentEditStatus)
    );
    let completed = false;
    paymentBusyRef.current = true;
    setPaymentBusy(true);

    try {
      let arkaResult = null;
      try {
        arkaResult = await arkaTransaction({
          action: ARKA_ACTION.TRANSPORT_ORDER_PAYMENT,
          actor: paymentActor,
          transportOrderId: oid,
          amount: add,
          method: payMethod,
          sourceModule: ARKA_SOURCE_MODULE.TRANSPORT,
          transportCode: displayCode || code,
          transportM2: totals.m2,
          clientName: name,
          clientPhone: fullPhone,
          statusOnFullPayment: shouldFinalizeDelivery ? 'done' : undefined,
          note: 'PAGESA ' + add + '€ - ' + (name || 'KLIENT') + ' • ' + (displayCode || code || 'T') + ' • ' + totals.m2.toFixed(2) + ' m²',
          idempotencyKey: buildArkaIdempotencyKey(ARKA_ACTION.TRANSPORT_ORDER_PAYMENT, [oid || displayCode || code, add, paymentActor.pin]),
        }, {
          timeoutMs: 9000,
          maxAttempts: 2,
          retryDelaysMs: [450],
        });
        assertVerifiedTransportPaymentResult(arkaResult, {
          transportOrderId: oid,
          amount: add,
          actorPin: paymentActor.pin,
          transportCode: displayCode || code,
        });
      } catch (primaryError) {
        const recoveredOrder = isEdit && oid
          ? await fetchTransportOrderById(oid).catch(() => null)
          : null;
        const recoveredData = recoveredOrder?.data && typeof recoveredOrder.data === 'object'
          ? recoveredOrder.data
          : {};
        const recoveredPay = recoveredData?.pay && typeof recoveredData.pay === 'object'
          ? recoveredData.pay
          : {};
        const recoveredPaid = round2(Math.max(
          Number(recoveredPay?.paid || 0),
          Number(recoveredPay?.arkaRecordedPaid || 0),
          Number(recoveredData?.clientPaid || 0)
        ));
        if (!recoveredOrder?.id || recoveredPaid + 0.01 < nextClientPaid) throw primaryError;
        arkaResult = {
          ok: true,
          paymentVerified: true,
          recoveredAfterResponseLoss: true,
          transportOrder: recoveredOrder,
          transport_order: recoveredOrder,
        };
      }

      const verifiedOrder = arkaResult?.transportOrder || arkaResult?.transport_order || null;
      setClientPaid(nextClientPaid);
      setArkaRecordedPaid(nextArkaPaid);
      setPayAdd(0);
      setShowPaySheet(false);

      if (shouldFinalizeDelivery && isEdit && oid) {
        const engineStatus = String(verifiedOrder?.status || verifiedOrder?.data?.status || '').trim().toLowerCase();
        if (!['done', 'completed', 'delivered'].includes(engineStatus)) {
          try {
            await persistTransportPaymentState({
              nextClientPaid,
              nextArkaPaid,
              paymentActor,
              currentOrderOverride: verifiedOrder,
            });
          } catch (finalizeError) {
            console.error('[TRANSPORT_PAYMENT_FINALIZE_AFTER_VERIFIED_CASH_FAILED]', {
              orderId: oid,
              paymentAmount: add,
              error: String(finalizeError?.message || finalizeError || 'UNKNOWN'),
            });
          }
        }

        completed = true;
        try {
          window.parent && window.parent !== window && window.parent.postMessage({ type: 'transport-payment-complete' }, window.location.origin);
        } catch {}

        const paymentReturnUrl = '/transport/board?tab=delivered&payment=ok';
        try { router.replace(paymentReturnUrl); } catch {}
        try {
          window.setTimeout(() => {
            try {
              if (String(window.location.pathname || '').includes('/transport/pranimi')) {
                window.location.replace(paymentReturnUrl);
              }
            } catch {}
          }, 450);
        } catch {}
        return;
      }

      completed = true;
    } catch (e) {
      alert('ARKA PROBLEM: ' + String(e?.message || e || 'PAGESA NUK U RUAJT. PROVO PRAPË.'));
    } finally {
      paymentBusyRef.current = false;
      if (!completed) setPaymentBusy(false);
    }
  }`);

  page = replaceOnce(
    page,
    'confirmText="KRYEJ PAGESËN"',
    "confirmText={paymentBusy ? 'DUKE RUAJTUR...' : 'KRYEJ PAGESËN'}",
    'payment busy label',
  );
}
fs.writeFileSync(PAGE_PATH, page);

let engine = fs.readFileSync(ENGINE_PATH, 'utf8');
if (!engine.includes(MARKER + ':ENGINE')) {
  engine = replaceNamedFunction(engine, 'buildTransportPatch', `function normalizeTransportPaymentFullStatus(value = '') {
    const status = cleanText(value, '').toLowerCase();
    if (['done', 'completed', 'delivered', 'dorzuar', 'dorezuar', 'dorëzuar'].includes(status)) return 'done';
    return '';
  }

  function buildTransportPatch(row = {}, amount, opts = {}) {
    // ${MARKER}:ENGINE — delivery cash and terminal status are committed by one server transaction.
    const { duplicate = false } = opts || {};
    const data = asObject(row?.data);
    const pay = asObject(data?.pay);
    const total = money(pick(pay.euro, pay.total, data.total, 0));
    const currentPaid = money(Math.max(money(pay.paid), money(pay.arkaRecordedPaid)));
    const currentArka = money(pay.arkaRecordedPaid);
    const nextPaid = duplicate ? round2(Math.max(currentPaid, currentArka, amount)) : round2(currentPaid + amount);
    const nextArka = duplicate ? round2(Math.max(currentArka, amount)) : round2(currentArka + amount);
    const debt = round2(Math.max(0, total - Math.max(nextPaid, nextArka)));
    const paidAt = nowIso();
    const currentStatus = cleanText(row.status || data.status || data.state || 'delivery', 'delivery').toLowerCase() || 'delivery';
    const requestedFullStatus = normalizeTransportPaymentFullStatus(
      opts?.statusOnFullPayment ||
      opts?.status_on_full_payment ||
      opts?.fullPaymentStatus ||
      opts?.full_payment_status
    );
    const nextStatus = debt <= 0.01 && requestedFullStatus ? requestedFullStatus : currentStatus;
    const nextData = {
      ...data,
      status: nextStatus,
      state: nextStatus,
      pay: {
        ...pay,
        paid: nextPaid,
        arkaRecordedPaid: nextArka,
        debt,
        last_paid_at: paidAt,
      },
      updated_at: paidAt,
    };
    if (debt <= 0.01) {
      nextData.paid_done = true;
      nextData.paid_at = nextData.paid_at || paidAt;
    }
    if (nextStatus === 'done') {
      nextData.completed_at = nextData.completed_at || paidAt;
      nextData.delivered_at = nextData.delivered_at || paidAt;
      nextData.done_at = nextData.done_at || paidAt;
    }
    return { status: nextStatus, data: nextData, updated_at: paidAt };
  }`);

  engine = replaceOnce(
    engine,
    'transportOrder = await updateTransportAfterPayment(sb, row, amount, { duplicate: Boolean(duplicateByTransport) });',
    `transportOrder = await updateTransportAfterPayment(sb, row, amount, {
      duplicate: Boolean(duplicateByTransport),
      statusOnFullPayment:
        guardedPayload.statusOnFullPayment ||
        guardedPayload.status_on_full_payment ||
        guardedPayload.fullPaymentStatus ||
        guardedPayload.full_payment_status,
    });`,
    'transport full-payment status',
  );
}
fs.writeFileSync(ENGINE_PATH, engine);

console.log('transport payment confirmation/close patch applied');
