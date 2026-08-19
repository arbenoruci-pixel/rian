import fs from 'node:fs';

const PASTRIMI_PATH = 'app/pastrimi/page.jsx';
const PACKAGE_PATH = 'package.json';
const GATI_INSTALLER_PATH = 'tools/apply-gati-rack-save-v1.mjs';
const MARKER = 'PASTRIMI_PAYMENT_FAST_CLOSE_V4';
const INSTALLER = 'node tools/apply-pastrimi-payment-fast-close-v4.mjs';
const TEST_COMMAND = 'npm run test:pastrimi-payment-fast-close-v4';
const APP_VERSION = '2.0.115-query-authority-transport-guard-v4-arka-daily-close-v2-home-search-base-role-v1-gati-rack-save-v1-pastrimi-payment-touch-v3-unified-arka-payroll-v1-repeat-visit-v2-pastrimi-payment-fast-close-v4-arka-daily-expense-step-v1';
const CACHE_VERSION = 'v44-query-authority-transport-guard-payment-button-v3-arka-daily-close-v2-home-search-base-role-v1-gati-rack-save-v1-pastrimi-payment-touch-v3-unified-arka-payroll-v1-repeat-visit-v2-pastrimi-payment-fast-close-v4-arka-daily-expense-step-v1';

function scanBalanced(source, start, openChar, closeChar, label) {
  if (source[start] !== openChar) throw new Error(`${label}_OPEN_MISSING`);
  let depth = 0;
  let quote = '';
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = start; index < source.length; index += 1) {
    const ch = source[index];
    const next = source[index + 1] || '';
    if (lineComment) {
      if (ch === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (ch === '*' && next === '/') { blockComment = false; index += 1; }
      continue;
    }
    if (quote) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '/' && next === '/') { lineComment = true; index += 1; continue; }
    if (ch === '/' && next === '*') { blockComment = true; index += 1; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === openChar) depth += 1;
    if (ch === closeChar) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  throw new Error(`${label}_UNTERMINATED`);
}

function functionRange(source, name) {
  const match = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(').exec(source);
  if (!match) throw new Error(`FUNCTION_NOT_FOUND:${name}`);
  const paramsStart = source.indexOf('(', match.index);
  const paramsEnd = scanBalanced(source, paramsStart, '(', ')', `${name}_PARAMS`);
  let bodyStart = paramsEnd + 1;
  while (/\s/.test(source[bodyStart] || '')) bodyStart += 1;
  const bodyEnd = scanBalanced(source, bodyStart, '{', '}', `${name}_BODY`);
  return { start: match.index, end: bodyEnd + 1 };
}

function replaceOnce(source, oldText, newText, label) {
  if (source.includes(newText)) return source;
  const count = source.split(oldText).length - 1;
  if (count !== 1) throw new Error(`${label}: expected 1 match, found ${count}`);
  return source.replace(oldText, newText);
}

function patchPastrimiPayment() {
  let source = fs.readFileSync(PASTRIMI_PATH, 'utf8');
  const range = functionRange(source, 'applyRowPayAndClose');
  let fn = source.slice(range.start, range.end);

  if (!fn.includes(MARKER)) {
    fn = replaceOnce(
      fn,
      'async function applyRowPayAndClose() {',
      `async function applyRowPayAndClose() {\n    // ${MARKER}: confirm locally, close immediately, sync idempotently in background.`,
      'payment-fast-close-marker',
    );
  }

  if (!fn.includes('PASTRIMI_FAST_CLOSE_OPTIMISTIC_V4')) {
    const queueStart = fn.indexOf('    let durableQueueCreated = false;');
    const runStart = fn.indexOf('    const runPaymentInBackground = async () => {', queueStart);
    if (queueStart < 0 || runStart < 0 || runStart <= queueStart) {
      throw new Error('PAYMENT_QUEUE_REGION_NOT_FOUND');
    }

    const optimisticBlock = `    let durableQueueCreated = false;
    // PASTRIMI_FAST_CLOSE_OPTIMISTIC_V4
    // The command is already in the synchronous intent journal. From this
    // point the cashier must never wait for network, ARKA verification, bonus
    // creation, IndexedDB or a later order refresh.
    setRowPayBusy(true);
    const visibleOptimisticOrder = {
      ...optimisticOrder,
      payment_sync_state: 'BACKGROUND_PENDING',
      payment_idempotency_key: paymentIdempotencyKey,
      last_payment_by_pin: String(pinData.pin || ''),
      last_payment_by_name: String(pinData.name || ''),
      updated_at: actionAt,
    };
    const optimisticStatus = normalizeStatus(visibleOptimisticOrder?.status || nextOrder?.status || 'pastrim') || 'pastrim';

    try { localStorage.setItem(\`order_\${orderId}\`, JSON.stringify(visibleOptimisticOrder)); } catch {}
    try {
      patchBaseMasterRow({
        id: orderId,
        status: optimisticStatus,
        data: visibleOptimisticOrder,
        updated_at: actionAt,
        paid_amount: newPaid,
        price_total: visibleOptimisticOrder.price_total,
        _table: 'orders',
      });
    } catch {}

    if (pickupNow) {
      setOrders((prev) => (prev || []).filter((o) => String(o?.id) !== orderId));
    } else {
      setOrders((prev) => (prev || []).map((o) => String(o?.id) === orderId
        ? {
            ...o,
            paid: newPaid,
            isPaid: newDebt <= 0,
            total: Number(rowPayOrder.total || o?.total || 0),
            fullOrder: visibleOptimisticOrder,
          }
        : o
      ));
    }

    setPaymentSmsReceipt({
      code: String(rowPayOrder?.code || rowPayOrder?.order_code || rowPayOrder?.fullOrder?.code || '').replace(/^T/i, ''),
      name: String(rowPayOrder?.name || rowPayOrder?.client_name || rowPayOrder?.fullOrder?.client_name || rowPayOrder?.fullOrder?.client?.name || 'Klient').trim(),
      phone: String(rowPayOrder?.phone || rowPayOrder?.client_phone || rowPayOrder?.fullOrder?.client_phone || rowPayOrder?.fullOrder?.client?.phone || '').trim(),
      amount: applied,
      syncPending: true,
    });
    setRowPaySheet(false);
    setRowPayOrder(null);
    setRowPayAmount(0);
    setRowPayBusy(false);
    try { window.dispatchEvent(new Event('tepiha:outbox-changed')); } catch {}
    void saveOrderLocal({
      id: orderId,
      status: optimisticStatus,
      data: visibleOptimisticOrder,
      updated_at: actionAt,
      _table: 'orders',
      _synced: false,
      _syncPending: true,
    }).catch(() => {});

`;
    fn = fn.slice(0, queueStart) + optimisticBlock + fn.slice(runStart);
  }

  fn = fn.replace(
    "          15000,\n          'PASTRIMI_ROW_PAYMENT_TIMEOUT'",
    "          60000,\n          'PASTRIMI_ROW_PAYMENT_TIMEOUT'",
  );

  const runStart = fn.indexOf('    const runPaymentInBackground = async () => {');
  if (runStart < 0) throw new Error('BACKGROUND_RUN_NOT_FOUND');

  const successNeedle = '        if (!pickupNow) {';
  const successStart = fn.indexOf(successNeedle, fn.indexOf('const localOrder', runStart));
  if (successStart < 0) throw new Error('BACKGROUND_SUCCESS_BLOCK_NOT_FOUND');
  const successOpen = fn.indexOf('{', successStart);
  const successEnd = scanBalanced(fn, successOpen, '{', '}', 'BACKGROUND_SUCCESS_BLOCK');
  const successReplacement = `        if (!pickupNow) {
          setOrders((prev) => (prev || []).map((o) => String(o?.id) === orderId
            ? { ...o, paid: enginePaid, isPaid: engineDebt <= 0, total: Number(rowPayOrder.total || o?.total || 0), fullOrder: localOrder }
            : o
          ));
          setPaymentSmsReceipt((prev) => prev ? { ...prev, syncPending: false } : prev);
        }`;
  fn = fn.slice(0, successStart) + successReplacement + fn.slice(successEnd + 1);

  const finallyAt = fn.indexOf('      } finally {', runStart);
  if (finallyAt < 0) throw new Error('BACKGROUND_FINALLY_NOT_FOUND');
  const catchStart = fn.lastIndexOf('      } catch (err) {', finallyAt);
  if (catchStart < 0) throw new Error('BACKGROUND_CATCH_NOT_FOUND');
  const catchOpen = fn.indexOf('{', catchStart);
  const catchEnd = scanBalanced(fn, catchOpen, '{', '}', 'BACKGROUND_CATCH_BLOCK');
  const catchReplacement = `      } catch (err) {
        // The durable journal remains authoritative. A slow server response or
        // temporary network failure must not reopen the payment sheet or invite
        // a second cash entry with the same idempotency key.
        try { window.dispatchEvent(new Event('tepiha:outbox-changed')); } catch {}
        try { console.warn('[PASTRIMI_PAYMENT_FAST_CLOSE_V4] background sync pending', err); } catch {}
        return;
      }`;
  fn = fn.slice(0, catchStart) + catchReplacement + fn.slice(catchEnd + 1);

  fn = fn.replace(
    '        if (!pickupNow) setRowPayBusy(false);',
    '        setRowPayBusy(false);',
  );

  const blockingTail = `    if (pickupNow) {
      Promise.resolve().then(runPaymentInBackground);
      return;
    }
    await runPaymentInBackground();`;
  const detachedTail = `    // PASTRIMI_FAST_CLOSE_DETACHED_V4 — the sheet is already closed.
    Promise.resolve().then(runPaymentInBackground);
    return;`;
  if (fn.includes(blockingTail)) {
    fn = fn.replace(blockingTail, detachedTail);
  } else if (!fn.includes('PASTRIMI_FAST_CLOSE_DETACHED_V4')) {
    throw new Error('BLOCKING_PAYMENT_TAIL_NOT_FOUND');
  }

  if (!fn.includes(MARKER)) throw new Error('FAST_CLOSE_MARKER_MISSING');
  if (!fn.includes('PASTRIMI_FAST_CLOSE_OPTIMISTIC_V4')) throw new Error('OPTIMISTIC_CLOSE_MISSING');
  if (!fn.includes('PASTRIMI_FAST_CLOSE_DETACHED_V4')) throw new Error('DETACHED_BACKGROUND_MISSING');
  if (fn.includes('await runPaymentInBackground();')) throw new Error('BLOCKING_BACKGROUND_WAIT_REMAINS');
  if (!fn.includes("amount: applied,\n      syncPending: true")) throw new Error('OPTIMISTIC_RECEIPT_AMOUNT_MISSING');
  if (!fn.includes("60000,\n          'PASTRIMI_ROW_PAYMENT_TIMEOUT'")) throw new Error('BACKGROUND_TIMEOUT_NOT_RELAXED');

  source = source.slice(0, range.start) + fn + source.slice(range.end);
  fs.writeFileSync(PASTRIMI_PATH, source, 'utf8');
}

function patchFinalVersionOwner() {
  let gati = fs.readFileSync(GATI_INSTALLER_PATH, 'utf8');
  gati = gati
    .replace(/const APP_VERSION = '[^']+';/, `const APP_VERSION = '${APP_VERSION}';`)
    .replace(/const CACHE_VERSION = '[^']+';/, `const CACHE_VERSION = '${CACHE_VERSION}';`);

  const repeatDecl = "  const repeatVisitV2Installer = 'node tools/apply-transport-repeat-visit-v2.mjs';";
  const fastDecl = "  const pastrimiFastCloseV4Installer = 'node tools/apply-pastrimi-payment-fast-close-v4.mjs';";
  if (!gati.includes(fastDecl)) {
    if (!gati.includes(repeatDecl)) throw new Error('GATI_REPEAT_VISIT_DECLARATION_MISSING');
    gati = gati.replace(repeatDecl, `${repeatDecl}\n${fastDecl}`);
  }
  gati = gati.replace(
    '.filter((item) => item !== installer && item !== arkaInstaller && item !== unifiedInstaller && item !== repeatVisitV2Installer);',
    '.filter((item) => item !== installer && item !== arkaInstaller && item !== unifiedInstaller && item !== repeatVisitV2Installer && item !== pastrimiFastCloseV4Installer);',
  );
  gati = gati.replace(
    'pre.push(arkaInstaller, unifiedInstaller, repeatVisitV2Installer, installer);',
    'pre.push(arkaInstaller, unifiedInstaller, repeatVisitV2Installer, pastrimiFastCloseV4Installer, installer);',
  );
  const compatibleGatiFinalOrder =
    gati.includes('repeatVisitV2Installer, pastrimiFastCloseV4Installer, installer')
    || gati.includes('repeatVisitV2Installer, pastrimiFastCloseV4Installer, homeSearchLocalOidDedupeV1Installer, installer');
  if (!compatibleGatiFinalOrder) {
    throw new Error('GATI_FINAL_INSTALLER_ORDER_NOT_PATCHED');
  }
  fs.writeFileSync(GATI_INSTALLER_PATH, gati, 'utf8');
}

function patchPackage() {
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_PATH, 'utf8'));
  pkg.version = APP_VERSION;
  const scripts = pkg.scripts || (pkg.scripts = {});
  const gatiInstaller = 'node tools/apply-gati-rack-save-v1.mjs';
  const prebuild = String(scripts.prebuild || '')
    .split('&&')
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item) => item !== INSTALLER);
  const gatiIndex = prebuild.lastIndexOf(gatiInstaller);
  if (gatiIndex >= 0) prebuild.splice(gatiIndex, 0, INSTALLER);
  else prebuild.push(INSTALLER);
  scripts.prebuild = prebuild.join(' && ');
  scripts['test:pastrimi-payment-fast-close-v4'] = 'node tools/verify-pastrimi-payment-fast-close-v4.mjs';

  let build = String(scripts.build || '');
  if (!build.includes(TEST_COMMAND)) {
    if (!build.includes(' && vite build')) throw new Error('VITE_BUILD_ANCHOR_MISSING');
    build = build.replace(' && vite build', ` && ${TEST_COMMAND} && vite build`);
  }
  scripts.build = build;
  fs.writeFileSync(PACKAGE_PATH, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
}

patchPastrimiPayment();
patchFinalVersionOwner();
patchPackage();
console.log('PASS PASTRIMI payment fast close V4: durable intent, immediate UI close, idempotent background sync.');
