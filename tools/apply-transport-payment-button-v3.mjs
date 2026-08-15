import fs from 'node:fs';

const PAGE_PATH = 'app/transport/pranimi/page.jsx';
const MARKER = 'TRANSPORT_PAYMENT_BUTTON_V3';

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

let page = fs.readFileSync(PAGE_PATH, 'utf8');

if (!page.includes('function round2(value)')) {
  const anchor = `function sameMoney(a, b) {\n  return Math.abs(Number(a || 0) - Number(b || 0)) <= 0.005;\n}`;
  const helper = `${anchor}\nfunction round2(value) {\n  const n = Number(value || 0);\n  if (!Number.isFinite(n)) return 0;\n  return Math.round((n + Number.EPSILON) * 100) / 100;\n}`;
  if (!page.includes(anchor)) throw new Error('sameMoney anchor missing');
  page = page.replace(anchor, helper);
}

if (!page.includes(MARKER + ':PAGE')) {
  page = replaceNamedFunction(page, 'applyPayAndClose', `async function applyPayAndClose() {
    // ${MARKER}:PAGE — await the real PIN contract, apply only the debt, verify ARKA, then close once.
    if (paymentBusyRef.current || paymentBusy) return;

    const cashGiven = round2(payAdd);
    const dueNow = round2(Math.max(0, Number(totalEuro || 0) - Number(clientPaid || 0)));
    if (cashGiven <= 0) {
      alert('SHKRUANI SHUMËN QË PAGUAN KLIENTI.');
      return;
    }
    if (dueNow <= 0) {
      alert('POROSIA ËSHTË PAGUAR PLOTËSISHT.');
      setShowPaySheet(false);
      return;
    }
    if (cashGiven + 0.001 < dueNow) {
      alert('KLIENTI DHA MË PAK SE BORXHI!');
      return;
    }

    const applied = dueNow;
    const change = round2(Math.max(0, cashGiven - applied));
    const pinLabel = [
      'PAGESË: ' + applied.toFixed(2) + '€',
      'KLIENTI DHA: ' + cashGiven.toFixed(2) + '€',
      'KUSURI (RESTO): ' + change.toFixed(2) + '€',
      '',
      'JEP PIN PËR TË KRYER PAGESËN',
    ].join('\\n');

    const paymentActor = await requirePaymentPin({ label: pinLabel });
    const actorPin = String(paymentActor?.pin || '').trim();
    if (!actorPin) return;

    const actorName = String(paymentActor?.name || me?.name || me?.full_name || me?.username || '').trim();
    const actorRole = String(paymentActor?.role || me?.role || 'TRANSPORT').trim();
    const transportCode = normalizeTcode(codeRaw || clientTcode);
    const transportM2 = Number(totalM2 || 0) || 0;
    const clientPhone = buildTransportPhoneDigits(phonePrefix, phone) || null;
    const nextClientPaid = round2(Number(clientPaid || 0) + applied);
    const nextArkaPaid = round2(Number(arkaRecordedPaid || 0) + applied);
    const currentEditStatus = String(editRowStatus || '').trim().toLowerCase();
    const shouldFinalizeDelivery = Boolean(
      isEdit && ['delivery', 'dorzim', 'dorezim', 'dorëzim', 'delivered'].includes(currentEditStatus)
    );
    const transportNote = 'PAGESA ' + applied.toFixed(2) + '€ - ' + (name || 'KLIENT') + ' • ' + (transportCode || 'T-KOD') + ' • ' + transportM2.toFixed(2) + ' m²';

    paymentBusyRef.current = true;
    setPaymentBusy(true);

    try {
      let arkaResult = null;
      try {
        arkaResult = await arkaTransaction({
          action: ARKA_ACTION.TRANSPORT_ORDER_PAYMENT,
          actorPin,
          actorName: actorName || null,
          actorRole: actorRole || null,
          transportOrderId: oid,
          transportCode,
          transportM2,
          amount: applied,
          method: String(payMethod || 'CASH').toUpperCase(),
          note: transportNote,
          clientName: name,
          clientPhone,
          sourceModule: 'TRANSPORT',
          statusOnFullPayment: shouldFinalizeDelivery ? 'done' : undefined,
          idempotencyKey: buildArkaIdempotencyKey(
            ARKA_ACTION.TRANSPORT_ORDER_PAYMENT,
            [oid, applied.toFixed(2), actorPin]
          ),
        }, {
          timeoutMs: 9000,
          maxAttempts: 2,
          retryDelaysMs: [450],
        });

        assertVerifiedTransportPaymentResult(arkaResult, {
          orderId: oid,
          code: transportCode,
          amount: applied,
          actorPin,
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

      let verifiedOrder = arkaResult?.transportOrder || arkaResult?.transport_order || null;

      if (shouldFinalizeDelivery && isEdit && oid) {
        const engineStatus = String(verifiedOrder?.status || verifiedOrder?.data?.status || '').trim().toLowerCase();
        if (!['done', 'completed', 'delivered'].includes(engineStatus)) {
          const finalized = await persistTransportPaymentState({
            nextClientPaid,
            nextArkaPaid,
            paymentActor,
            currentOrderOverride: verifiedOrder,
          });
          verifiedOrder = finalized?.order || verifiedOrder;
        }
      }

      setClientPaid(nextClientPaid);
      setArkaRecordedPaid(nextArkaPaid);
      setPayAdd(0);
      setShowPaySheet(false);

      try {
        const actorTid = String(me?.transport_id || assignTid || '').trim();
        if (actorTid && arkaResult?.duplicate !== true) {
          addTransportCollected(actorTid, {
            id: 'cash_' + Date.now(),
            amount: applied,
            order_code: transportCode,
            client_name: name,
            note: transportNote,
            created_at: new Date().toISOString(),
            created_by_pin: actorPin,
          });
        }
      } catch {}

      if (shouldFinalizeDelivery && isEdit && oid) {
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
      }
    } catch (error) {
      alert('ARKA PROBLEM: ' + String(error?.message || error || 'PAGESA NUK U RUAJT. PROVO PRAPË.'));
    } finally {
      paymentBusyRef.current = false;
      setPaymentBusy(false);
    }
  }`);
}

fs.writeFileSync(PAGE_PATH, page);

let vite = fs.readFileSync('vite.config.js', 'utf8');
vite = vite.replace(/sw-navigation-diag\.js\?v=\d+/, 'sw-navigation-diag.js?v=3509');
vite = vite.replace(/tepiha-vite-business-routes-[^']+/, 'tepiha-vite-business-routes-v44-query-authority-transport-guard-payment-button-v3');
vite = vite.replace(/tepiha-vite-static-assets-[^']+/, 'tepiha-vite-static-assets-v44-query-authority-transport-guard-payment-button-v3');
vite = vite.replace(/tepiha-vite-media-[^']+/, 'tepiha-vite-media-v44-query-authority-transport-guard-payment-button-v3');
fs.writeFileSync('vite.config.js', vite);
console.log('transport payment button v3 applied');
