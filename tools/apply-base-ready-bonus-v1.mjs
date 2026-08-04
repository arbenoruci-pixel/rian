import fs from 'node:fs';

const PASTRIMI_PATH = 'app/pastrimi/page.jsx';
const SYNC_PATH = 'lib/syncEngine.js';
const FINANCE_PATH = 'lib/corporateFinance.js';
const ARKA_PATH = 'app/arka/page.jsx';
const CONSTANTS_PATH = 'lib/arka/arkaConstants.js';
const ROUTES_PATH = 'src/generated/routes.generated.jsx';
const MARKER = 'BASE_READY_48H_BONUS_V1';

function scanMatchingDelimiter(source, start, openChar, closeChar, label) {
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

function findNamedFunctionRange(source, name) {
  const match = new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(source);
  if (!match) throw new Error(`${name}_FUNCTION_NOT_FOUND`);
  const paramsStart = source.indexOf('(', match.index);
  const paramsEnd = scanMatchingDelimiter(source, paramsStart, '(', ')', `${name}_PARAMS`);
  let bodyStart = paramsEnd + 1;
  while (bodyStart < source.length && /\s/.test(source[bodyStart])) bodyStart += 1;
  if (source[bodyStart] !== '{') throw new Error(`${name}_BODY_NOT_FOUND`);
  const bodyEnd = scanMatchingDelimiter(source, bodyStart, '{', '}', `${name}_BODY`);
  return { start: match.index, end: bodyEnd + 1 };
}

function replaceNamedFunction(source, name, replacement) {
  const range = findNamedFunctionRange(source, name);
  return `${source.slice(0, range.start)}${replacement}${source.slice(range.end)}`;
}

function replaceRequired(source, from, to, label) {
  if (!source.includes(from)) throw new Error(`${label}_ANCHOR_NOT_FOUND`);
  return source.replace(from, to);
}

function ensureImport(source, line, anchor) {
  if (source.includes(line)) return source;
  if (!source.includes(anchor)) throw new Error(`IMPORT_ANCHOR_NOT_FOUND:${anchor}`);
  return source.replace(anchor, `${anchor}\n${line}`);
}

function insertBeforeFunctionReturn(source, name, insertion) {
  const range = findNamedFunctionRange(source, name);
  const block = source.slice(range.start, range.end);
  const marker = `\n  return '';\n`;
  if (!block.includes(marker)) throw new Error(`${name}_RETURN_ANCHOR_NOT_FOUND`);
  const next = block.replace(marker, `\n${insertion}\n  return '';\n`);
  return `${source.slice(0, range.start)}${next}${source.slice(range.end)}`;
}

function patchConstants() {
  let source = fs.readFileSync(CONSTANTS_PATH, 'utf8');
  if (source.includes(`${MARKER}:CONSTANTS`)) return false;
  source = replaceRequired(
    source,
    `  MEAL_COVERED: 'MEAL_COVERED',\n  SALARY_PAYMENT: 'SALARY_PAYMENT',`,
    `  MEAL_COVERED: 'MEAL_COVERED',\n  READY_48H_BONUS: 'READY_48H_BONUS',\n  SALARY_PAYMENT: 'SALARY_PAYMENT',\n  // ${MARKER}:CONSTANTS`,
    'BONUS_PAYMENT_TYPE'
  );
  fs.writeFileSync(CONSTANTS_PATH, source, 'utf8');
  return true;
}

function patchPastrimi() {
  let source = fs.readFileSync(PASTRIMI_PATH, 'utf8');
  if (source.includes(`${MARKER}:PASTRIMI`)) return false;

  source = ensureImport(
    source,
    `import { describeReadyBonusResult, markBaseOrderReadyWithBonus, resolveBaseReadyBonusWorker } from '@/lib/baseReadyBonusClient';`,
    `import { createPendingCashPayment } from '@/lib/arkaCashSync';`
  );

  source = replaceRequired(
    source,
    `    const resolvedReadySlotText = formatConcreteRackSlots(resolvedReadySlots);`,
    `    let readyBonusWorker = null;\n    if (!isPastrimTransportScopedRow(o)) {\n      readyBonusWorker = await resolveBaseReadyBonusWorker({\n        label: 'JEP PIN-IN E BAZISTIT QË E PËRFUNDOI DHE E PAKETOI KËTË POROSI',\n      });\n      if (!readyBonusWorker) {\n        if (btn) { btn.disabled = false; btn.innerText = 'GATI'; }\n        return;\n      }\n    }\n\n    const resolvedReadySlotText = formatConcreteRackSlots(resolvedReadySlots);`,
    'PASTRIMI_READY_WORKER_PROMPT'
  );

  source = replaceRequired(
    source,
    `      ready_at: now,\n      ...(existingLocalOid ? { local_oid: existingLocalOid } : {}),`,
    `      ready_at: now,\n      ...(existingLocalOid ? { local_oid: existingLocalOid } : {}),\n      ...(readyBonusWorker ? {\n        ready_by_pin: readyBonusWorker.pin,\n        ready_by_name: readyBonusWorker.name,\n        ready_by_role: readyBonusWorker.role,\n        base_ready_bonus_pending_v1: {\n          version: 'base-ready-48h-bonus-v1',\n          worker_pin: readyBonusWorker.pin,\n          worker_name: readyBonusWorker.name,\n          ready_at: now,\n          rate_m2: 0.10,\n          window_hours: 48,\n          sync_state: 'PENDING_OR_DB',\n        },\n      } : {}),`,
    'PASTRIMI_READY_WORKER_DATA'
  );

  source = replaceRequired(
    source,
    `    var updatedJson = null;`,
    `    var updatedJson = null;\n    var readyBonusResult = null;\n    // ${MARKER}:PASTRIMI`,
    'PASTRIMI_RESULT_STATE'
  );

  source = replaceRequired(
    source,
    `      if (localBranch) {\n        const { updateOrderStatus } = await import('@/lib/ordersDb');\n        await updateOrderStatus(o.id, 'gati', transitionPatch);\n      } else {\n        await transitionOrderStatus(table, o.id, 'gati', transitionPatch);\n        if (table === 'transport_orders') {\n          alert(\`✅ U bë GATI!\nShoferi u njoftua në listën e tij.\`);\n        }\n      }`,
    `      if (table === 'orders') {\n        readyBonusResult = await markBaseOrderReadyWithBonus({\n          orderRef: existingLocalOid || o.id,\n          worker: readyBonusWorker,\n          readySlots: resolvedReadySlots,\n          readyNote: resolvedReadyText,\n          readyAt: now,\n          forceQueue: localBranch || (typeof navigator !== 'undefined' && navigator.onLine === false),\n        });\n        const committedOrder = readyBonusResult?.order && typeof readyBonusResult.order === 'object' ? readyBonusResult.order : null;\n        if (committedOrder?.data && typeof committedOrder.data === 'object') {\n          updatedJson = committedOrder.data;\n        } else if (readyBonusResult?.offlineQueued) {\n          updatedJson = {\n            ...updatedJson,\n            base_ready_bonus_pending_v1: {\n              ...(updatedJson?.base_ready_bonus_pending_v1 || {}),\n              outbox_op_id: readyBonusResult?.queuedOpId || null,\n              idempotency_key: readyBonusResult?.idempotencyKey || null,\n              sync_state: 'OUTBOX_PENDING',\n            },\n          };\n        }\n        alert(\`✅ U bë GATI!\\n\${describeReadyBonusResult(readyBonusResult)}\`);\n      } else if (localBranch) {\n        const { updateOrderStatus } = await import('@/lib/ordersDb');\n        await updateOrderStatus(o.id, 'gati', transitionPatch);\n      } else {\n        await transitionOrderStatus(table, o.id, 'gati', transitionPatch);\n        if (table === 'transport_orders') {\n          alert(\`✅ U bë GATI!\nShoferi u njoftua në listën e tij.\`);\n        }\n      }`,
    'PASTRIMI_READY_TRANSITION'
  );

  source = replaceRequired(
    source,
    `        _synced: !localBranch,`,
    `        _synced: table === 'orders' ? !readyBonusResult?.offlineQueued : !localBranch,`,
    'PASTRIMI_READY_OPTIMISTIC_SYNC'
  );

  fs.writeFileSync(PASTRIMI_PATH, source, 'utf8');
  return true;
}

function patchSyncEngine() {
  let source = fs.readFileSync(SYNC_PATH, 'utf8');
  if (source.includes(`${MARKER}:SYNC`)) return false;

  source = insertBeforeFunctionReturn(source, 'validateOpShape', `  if (type === 'base_ready_bonus_transition') {\n    const orderRef = String(payload?.p_order_ref || payload?.order_id || payload?.id || op?.id || '').trim();\n    const workerPin = String(payload?.p_worker_pin || payload?.worker?.pin || '').trim();\n    const idempotency = String(payload?.p_idempotency_key || payload?.idempotency_key || '').trim();\n    if (!orderRef) return 'MISSING_ID';\n    if (!workerPin) return 'MISSING_READY_BONUS_WORKER_PIN';\n    if (!idempotency) return 'MISSING_READY_BONUS_IDEMPOTENCY_KEY';\n  }`);

  const handler = `  if (type === 'base_ready_bonus_transition') {\n    // ${MARKER}:SYNC — DB owns the 48h decision and creates the ARKA bonus atomically.\n    const rpcArgs = {\n      p_order_ref: String(payload?.p_order_ref || payload?.order_id || payload?.id || op?.id || ''),\n      p_worker_pin: String(payload?.p_worker_pin || payload?.worker?.pin || ''),\n      p_ready_slots: Array.isArray(payload?.p_ready_slots) ? payload.p_ready_slots : [],\n      p_ready_note: payload?.p_ready_note || null,\n      p_ready_at: payload?.p_ready_at || payload?.queued_at || nowIso(),\n      p_idempotency_key: payload?.p_idempotency_key || payload?.idempotency_key || null,\n    };\n    const { data: bonusResult, error } = await supabase.rpc('mark_base_order_ready_with_bonus_v1', rpcArgs);\n    if (error) throw error;\n    if (!bonusResult?.ok || !bonusResult?.order?.id) throw new Error('BASE_READY_BONUS_SYNC_VERIFY_FAILED');\n\n    const remote = bonusResult.order;\n    const remoteId = String(remote?.id || '');\n    const localRef = String(payload?.p_order_ref || payload?.order_id || payload?.id || op?.id || '');\n    await saveOrderLocal({\n      ...remote,\n      id: remoteId,\n      local_oid: remote?.local_oid || remote?.data?.local_oid || localRef || remoteId,\n      table: 'orders',\n      _table: 'orders',\n      _local: false,\n      _synced: true,\n      _syncPending: false,\n      _syncing: false,\n      _syncFailed: false,\n      _syncError: null,\n      server_id: remoteId,\n      updated_at: remote?.updated_at || nowIso(),\n    });\n    if (localRef && remoteId && localRef !== remoteId && !/^\\d+$/.test(localRef)) {\n      await deleteOrderLocal(localRef).catch(() => {});\n    }\n    return true;\n  }\n\n`;

  if (!source.includes(`  if (type === 'arka_transaction') {`)) throw new Error('SYNC_ARKA_HANDLER_ANCHOR_NOT_FOUND');
  source = source.replace(`  if (type === 'arka_transaction') {`, `${handler}  if (type === 'arka_transaction') {`);
  source = source.replace(
    `import { ARKA_SYNC_HTTP_TIMEOUT_MS, postArkaTransaction } from '@/lib/arka/arkaNetwork';`,
    `import { ARKA_SYNC_HTTP_TIMEOUT_MS, postArkaTransaction } from '@/lib/arka/arkaNetwork';\n// ${MARKER}:SYNC`
  );

  fs.writeFileSync(SYNC_PATH, source, 'utf8');
  return true;
}

function patchCorporateFinance() {
  let source = fs.readFileSync(FINANCE_PATH, 'utf8');
  if (source.includes(`${MARKER}:FINANCE`)) return false;

  source = ensureImport(
    source,
    `import { BASE_READY_BONUS_TYPE, listOpenBaseReadyBonusPayments } from '@/lib/baseReadyBonusClient';`,
    `import { arkaTransaction, buildArkaIdempotencyKey } from '@/lib/arka/arkaClient';`
  );

  source = replaceNamedFunction(source, 'isCashRowReadyForDispatch', `function isCashRowReadyForDispatch(row = {}) {
  const status = upper(row?.status);
  if (!['PENDING', 'COLLECTED'].includes(status)) return false;
  const type = upper(row?.type || '');
  if (['TIMA', 'EXPENSE', 'MEAL_PAYMENT', 'MEAL_COVERED', 'ADVANCE', BASE_READY_BONUS_TYPE].includes(type)) return false;
  return n(row?.amount) > 0;
}`);

  source = replaceNamedFunction(source, 'paymentVerifiedForHandoff', `function paymentVerifiedForHandoff(row = {}, handoffId = '') {
  const status = upper(row?.status);
  const type = upper(row?.type);
  const note = String(row?.handoff_note || '').toUpperCase();
  const linked = String(row?.handoff_note || '').includes(String(handoffId));
  if (type === ARKA_PAYMENT_TYPE.MEAL_PAYMENT) {
    return note.includes(\`SETTLED_IN_HANDOFF:\${handoffId}\`) || (note.includes('SETTLED_IN_HANDOFF') && linked);
  }
  if (type === ARKA_PAYMENT_TYPE.READY_48H_BONUS || type === BASE_READY_BONUS_TYPE) {
    return linked && (
      note.includes('SETTLED_IN_HANDOFF') ||
      note.includes('PARTIAL_IN_HANDOFF') ||
      note.includes('READY_BONUS_RETAINED') ||
      note.includes('RETAINED_IN_HANDOFF')
    );
  }
  return status === HANDOFF_STATUS_PENDING && linked;
}`);

  source = replaceNamedFunction(source, 'verifyHandoffSubmitResponse', `function verifyHandoffSubmitResponse(result = {}, paymentIds = [], options = {}) {
  if (!result?.ok) throw new Error(result?.error || result?.message || 'SUBMIT_HANDOFF_FAILED');

  const expectedIds = [...new Set((paymentIds || []).map((id) => normalizePendingPaymentId(id)).filter(Boolean))];
  const expectedMealIds = [...new Set((options?.expectedMealPaymentIds || []).map((id) => normalizePendingPaymentId(id)).filter(Boolean))];
  const expectedBonusIds = [...new Set((options?.expectedReadyBonusPaymentIds || []).map((id) => normalizePendingPaymentId(id)).filter(Boolean))];
  const handoff = extractSubmittedHandoff(result);
  if (!handoff?.id) throw new Error('HANDOFF_RESPONSE_MISSING_ID');
  if (upper(handoff?.status) !== HANDOFF_STATUS_PENDING) {
    throw new Error(\`HANDOFF_STATUS_INVALID:\${upper(handoff?.status) || 'EMPTY'}\`);
  }

  const items = Array.isArray(handoff?.cash_handoff_items) ? handoff.cash_handoff_items : [];
  if (!items.length) throw new Error('HANDOFF_ITEMS_EMPTY_AFTER_RPC');
  if (expectedIds.length && items.length !== expectedIds.length) {
    throw new Error(\`HANDOFF_ITEM_COUNT_MISMATCH expected=\${expectedIds.length} actual=\${items.length}\`);
  }

  const itemIds = new Set(items.map((item) => String(normalizePendingPaymentId(item?.pending_payment_id))).filter(Boolean));
  const missingIds = expectedIds.filter((id) => !itemIds.has(String(id)));
  if (missingIds.length) throw new Error(\`HANDOFF_ITEM_PAYMENT_MISSING:\${missingIds.join(',')}\`);

  const deductionsInItems = [...expectedMealIds, ...expectedBonusIds].filter((id) => itemIds.has(String(id)));
  if (deductionsInItems.length) throw new Error(\`HANDOFF_DEDUCTION_SHOULD_NOT_BE_ITEM:\${deductionsInItems.join(',')}\`);

  const itemSum = +items.reduce((sum, item) => sum + n(item?.amount), 0).toFixed(2);
  const handoffAmount = +n(handoff?.amount || handoff?.total_amount).toFixed(2);
  if (!approxEqual(itemSum, handoffAmount)) {
    throw new Error(\`HANDOFF_ITEM_SUM_MISMATCH handoff=\${handoffAmount.toFixed(2)} items=\${itemSum.toFixed(2)}\`);
  }

  const verification = result?.verification || {};
  const expectedVerificationCount = expectedIds.length + expectedMealIds.length + expectedBonusIds.length;
  if (expectedVerificationCount && !Object.prototype.hasOwnProperty.call(verification, 'paymentCount')) {
    throw new Error('HANDOFF_PAYMENT_VERIFY_MISSING');
  }
  if (expectedVerificationCount && Number(verification?.paymentCount) < expectedVerificationCount) {
    throw new Error(\`HANDOFF_PAYMENT_VERIFY_COUNT_MISMATCH expected_at_least=\${expectedVerificationCount} actual=\${Number(verification?.paymentCount || 0)}\`);
  }
  if (expectedVerificationCount && !Array.isArray(verification?.paymentStatuses)) {
    throw new Error('HANDOFF_PAYMENT_STATUS_VERIFY_MISSING');
  }

  const paymentStatusRows = Array.isArray(verification?.paymentStatuses) ? verification.paymentStatuses : [];
  const statusIds = new Set(paymentStatusRows.map((row) => String(normalizePendingPaymentId(row?.id))).filter(Boolean));
  const missingDeductionVerifyIds = [...expectedMealIds, ...expectedBonusIds].filter((id) => !statusIds.has(String(id)));
  if (missingDeductionVerifyIds.length) throw new Error(\`HANDOFF_DEDUCTION_VERIFY_MISSING:\${missingDeductionVerifyIds.join(',')}\`);

  const badPayment = paymentStatusRows.find((row) => !paymentVerifiedForHandoff(row, handoff.id));
  if (badPayment) throw new Error(\`HANDOFF_PAYMENT_VERIFY_FAILED:\${badPayment.id || 'UNKNOWN'}\`);

  return { handoff, items, itemSum, handoffAmount };
}`);

  source = replaceNamedFunction(source, 'submitWorkerCashToDispatch', `export async function submitWorkerCashToDispatch({ actor, note = '', amountOverride = null }) {
  const pin = String(actor?.pin || '').trim();
  if (!pin) throw new Error('MUNGON PIN-I I PUNËTORIT.');

  const lockKey = \`worker_cash_handoff:\${pin}\`;
  if (ACTIVE_WORKER_HANDOFF_SUBMITS.has(lockKey)) {
    throw new Error('DORËZIMI ËSHTË DUKE U KRYER. MOS E SHTYP DY HERË.');
  }

  ACTIVE_WORKER_HANDOFF_SUBMITS.add(lockKey);
  try {
    const readyItems = await listWorkerReadyCash(pin);
    const paymentIds = readyItems
      .map((item) => normalizePendingPaymentId(item?.id))
      .filter(Boolean)
      .sort((a, b) => a - b);
    if (!paymentIds.length) throw new Error('NUK KA PAGESA GATI PËR DORËZIM.');

    const [mealRows, readyBonusRows] = await Promise.all([
      listWorkerUnsettledMealPayments(pin, { limit: 100 }).catch(() => []),
      listOpenBaseReadyBonusPayments(pin),
    ]);
    const mealPaymentIds = (Array.isArray(mealRows) ? mealRows : [])
      .map((item) => normalizePendingPaymentId(item?.id))
      .filter(Boolean)
      .sort((a, b) => a - b);
    const readyBonusPaymentIds = (Array.isArray(readyBonusRows) ? readyBonusRows : [])
      .map((item) => normalizePendingPaymentId(item?.payment_id))
      .filter(Boolean)
      .sort((a, b) => a - b);
    const expectedIds = [...new Set(paymentIds)].sort((a, b) => a - b);

    await ensureTransportCollectedRowsHaveWorkerOwner(pin, expectedIds, actor);

    const stableKey = buildArkaIdempotencyKey(ARKA_ACTION.SUBMIT_HANDOFF, [
      pin,
      paymentIds.join('-'),
      mealPaymentIds.length ? \`MEAL:\${mealPaymentIds.join('-')}\` : 'NO_MEAL',
      readyBonusPaymentIds.length ? \`READY48:\${readyBonusPaymentIds.join('-')}\` : 'NO_READY48',
    ]);

    const { data, error } = await supabase.rpc('submit_cash_handoff_with_ready_bonus_v1', {
      actor_pin: pin,
      actor_name: actor?.name || null,
      actor_role: actor?.role || null,
      payment_ids: paymentIds,
      amount_declared: amountOverride,
      handoff_note: note || null,
      idempotency_key: stableKey,
      meal_payment_ids: mealPaymentIds,
      ready_bonus_payment_ids: readyBonusPaymentIds,
    });
    if (error) throw error;
    if (!data?.ok) throw new Error(data?.error || data?.message || 'SUBMIT_HANDOFF_WITH_READY_BONUS_FAILED');

    const result = {
      ...data,
      ok: true,
      action: ARKA_ACTION.SUBMIT_HANDOFF,
      directRpc: true,
      result: data,
      handoff: data?.handoff || null,
      verification: data?.verification || null,
    };

    const verified = verifyHandoffSubmitResponse(result, expectedIds, {
      expectedMealPaymentIds: mealPaymentIds,
      expectedReadyBonusPaymentIds: readyBonusPaymentIds,
    });
    return {
      ...result,
      handoff: verified.handoff,
      items: verified.items,
      count: Number(result?.count || verified.items.length),
      total: n(result?.total || verified.handoffAmount),
      mealPaymentIds,
      readyBonusPaymentIds,
      readyBonusTotal: n(result?.readyBonusTotal),
      mode: readyBonusPaymentIds.length
        ? 'SUBMIT_CASH_HANDOFF_ATOMIC_RPC_WITH_READY_48H_BONUS'
        : (mealPaymentIds.length ? 'SUBMIT_CASH_HANDOFF_ATOMIC_RPC_WITH_MEAL_DEDUCT' : 'SUBMIT_CASH_HANDOFF_ATOMIC_RPC'),
    };
  } finally {
    ACTIVE_WORKER_HANDOFF_SUBMITS.delete(lockKey);
  }
}`);

  source = source.replace(
    `import { BASE_READY_BONUS_TYPE, listOpenBaseReadyBonusPayments } from '@/lib/baseReadyBonusClient';`,
    `import { BASE_READY_BONUS_TYPE, listOpenBaseReadyBonusPayments } from '@/lib/baseReadyBonusClient';\n// ${MARKER}:FINANCE`
  );
  fs.writeFileSync(FINANCE_PATH, source, 'utf8');
  return true;
}

function patchArka() {
  let source = fs.readFileSync(ARKA_PATH, 'utf8');
  if (source.includes(`${MARKER}:ARKA`)) return false;

  source = ensureImport(source, `import ReadyBonusLiveCard from '@/components/ReadyBonusLiveCard';`, `import LocalErrorBoundary from '@/components/LocalErrorBoundary';`);
  source = ensureImport(
    source,
    `import { computeReadyBonusDeductionForCash, listOpenBaseReadyBonusPayments } from '@/lib/baseReadyBonusClient';`,
    `import { getActor } from '@/lib/actorSession';`
  );

  source = replaceRequired(
    source,
    `const EXTRA_TYPES = new Set(['TIMA', 'EXPENSE', 'MEAL_PAYMENT', 'MEAL_COVERED']);`,
    `const EXTRA_TYPES = new Set(['TIMA', 'EXPENSE', 'MEAL_PAYMENT', 'MEAL_COVERED', 'READY_48H_BONUS']);\n// ${MARKER}:ARKA`,
    'ARKA_EXTRA_TYPES'
  );

  source = replaceNamedFunction(source, 'submitHandoff', `async function submitHandoff() {
    if (busyRef.current) return;
    busyRef.current = 'handoff';
    try {
      const rows = Array.isArray(workerSnapshot?.cashBreakdownRows) ? workerSnapshot.cashBreakdownRows : [];
      const total = n(workerSnapshot?.baseCashForDispatchTotal ?? workerSnapshot?.collectedTotal);
      const grossTotal = n(workerSnapshot?.cashFromClientsTotal ?? workerSnapshot?.collectedGrossTotal ?? workerSnapshot?.collectedTotal);
      const commissionTotal = n(workerSnapshot?.commissionHeldTotal);
      if (!workerSnapshot || total <= 0 || !rows.length) return alert('🔴 NUK KE KLIENTË ME CASH I MARRË PËR DORËZIM.');
      if (n(workerSnapshot?.cashDuplicateTransportCount) > 0) {
        return alert('🔴 U GJET DUPLICATE TRANSPORT CASH. DORËZIMI U NDALUA PËR SIGURI QË MOS TË KRIJOHET HANDOFF I DYFISHTË.');
      }
      const mealDecision = await ensureMealDecisionBeforeHandoff({
        actor,
        workerPin: actor?.pin,
        workerName: actor?.name,
        workerRole: actor?.role,
        staffOptions: mealOptions,
        amountPerPerson: FOOD_DEDUCTION,
      });
      const mealDeduct = n(mealDecision?.deductAmount);
      const openBonusRows = await listOpenBaseReadyBonusPayments(actor?.pin);
      const readyBonusAvailable = +(openBonusRows.reduce((sum, row) => sum + n(row?.remaining_amount), 0)).toFixed(2);
      const afterMeal = Math.max(0, +(total - mealDeduct).toFixed(2));
      const readyBonusDeduct = computeReadyBonusDeductionForCash(afterMeal, readyBonusAvailable);
      const estimatedNet = Math.max(0, +(afterMeal - readyBonusDeduct).toFixed(2));
      const ok = window.confirm(
        \`A DON ME I DORËZU TE DISPATCH \${estimatedNet.toFixed(2)}€?\n\n\` +
        \`KLIENTËT PAGUAN: \${grossTotal.toFixed(2)}€\n\` +
        \`KOMISIONI TRANSPORT: \${commissionTotal.toFixed(2)}€\n\` +
        \`BONUSI 48H QË E MBAN: \${readyBonusDeduct.toFixed(2)}€\n\` +
        (readyBonusAvailable > readyBonusDeduct + 0.005 ? \`BONUSI QË BARTET: \${(readyBonusAvailable-readyBonusDeduct).toFixed(2)}€\n\` : '') +
        (mealDecision?.confirmLine ? \`\${mealDecision.confirmLine}\n\` : '') +
        \`\${rows.length} KLIENTË PËR DORËZIM.\`
      );
      if (!ok) return;
      setBusy('handoff');
      const submitted = await submitWorkerCashToDispatch({ actor });
      await scheduleManagerMutationRefresh(actor);
      const held = n(submitted?.readyBonusTotal);
      alert(\`✅ DORËZIMI U DËRGUA TE DISPATCH.\${held > 0 ? `\\nBONUSI 48H I MBAJTUR NË KËTË DORËZIM: \${held.toFixed(2)}€` : ''}\`);
    } catch (e) {
      alert(\`🔴 \${e?.message || 'NUK U DËRGUA DORËZIMI.'}\`);
    } finally {
      busyRef.current = '';
      setBusy('');
    }
  }`);

  source = replaceRequired(
    source,
    `<Link href="/" prefetch={false} className="arkaTopBtn">HOME</Link>`,
    `<Link href="/" prefetch={false} className="arkaTopBtn">HOME</Link>\n          <Link href="/arka/bonuset" prefetch={false} className="arkaTopBtn">BONUSI 48H</Link>`,
    'ARKA_BONUS_NAV'
  );

  source = replaceRequired(
    source,
    `          <section className="arkaSectionCard arkaCashListCard">`,
    `          <ReadyBonusLiveCard actor={actor} />\n\n          <section className="arkaSectionCard arkaCashListCard">`,
    'ARKA_WORKER_BONUS_CARD'
  );

  source = replaceRequired(
    source,
    `      {!loading && actor?.pin && canManage ? (\n        <>`,
    `      {!loading && actor?.pin && canManage ? (\n        <>\n          <ReadyBonusLiveCard actor={actor} />`,
    'ARKA_MANAGER_BONUS_CARD'
  );

  fs.writeFileSync(ARKA_PATH, source, 'utf8');
  return true;
}

function patchRoutes() {
  let source = fs.readFileSync(ROUTES_PATH, 'utf8');
  if (source.includes(`${MARKER}:ROUTES`)) return false;

  const importAnchor = source.includes(`import ArkaDitorePageEager from '@/app/arka/ditore/page.jsx';`)
    ? `import ArkaDitorePageEager from '@/app/arka/ditore/page.jsx';`
    : `import ArkaStafiPageEager from '@/app/arka/stafi/page.jsx';`;
  source = replaceRequired(
    source,
    importAnchor,
    `${importAnchor}\nimport ArkaBonusetPageEager from '@/app/arka/bonuset/page.jsx';\n// ${MARKER}:ROUTES`,
    'ROUTES_BONUS_IMPORT'
  );

  const routeAnchor = source.includes(`  { path: '/arka/ditore', element: eagerElement(ArkaDitorePageEager, '/arka/ditore') },`)
    ? `  { path: '/arka/ditore', element: eagerElement(ArkaDitorePageEager, '/arka/ditore') },`
    : `  { path: '/arka/obligimet', element: eagerElement(ArkaObligimetPageEager, '/arka/obligimet') },`;
  source = replaceRequired(
    source,
    routeAnchor,
    `  { path: '/arka/bonuset', element: eagerElement(ArkaBonusetPageEager, '/arka/bonuset') },\n${routeAnchor}`,
    'ROUTES_BONUS_ROUTE'
  );

  fs.writeFileSync(ROUTES_PATH, source, 'utf8');
  return true;
}

const changed = [
  patchConstants(),
  patchPastrimi(),
  patchSyncEngine(),
  patchCorporateFinance(),
  patchArka(),
  patchRoutes(),
].some(Boolean);

console.log(`[base-ready-bonus-v1] ${changed ? 'installed' : 'already installed'}`);
