import fs from 'node:fs';

const GATI_PATH = 'app/gati/page.jsx';
const SYNC_PATH = 'lib/syncEngine.js';
const RECOVERY_PATH = 'lib/onlineDbTruthRecovery.js';
const MARKER = 'GATI_OFFLINE_RELIABILITY_V4';
const DURABLE_IMPORT = "import { clearDurableGatiSnapshot, readDurableGatiSnapshot, writeDurableGatiSnapshot } from '@/lib/gatiDurableSnapshot';";

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

    if (lineComment) {
      if (ch === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (ch === '*' && next === '/') {
        blockComment = false;
        i += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '/' && next === '/') {
      lineComment = true;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      blockComment = true;
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === openChar) depth += 1;
    if (ch === closeChar) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  throw new Error(`${label}_UNTERMINATED`);
}

function findNamedFunctionRange(source, name) {
  const match = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(source);
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

function insertAfterNamedFunction(source, name, addition) {
  const range = findNamedFunctionRange(source, name);
  return `${source.slice(0, range.end)}\n\n${addition}${source.slice(range.end)}`;
}

function ensureImport(source, line, anchor) {
  if (source.includes(line)) return source;
  if (!source.includes(anchor)) throw new Error(`IMPORT_ANCHOR_NOT_FOUND:${anchor}`);
  return source.replace(anchor, `${anchor}\n${line}`);
}

function replaceRequired(source, from, to, label) {
  if (!source.includes(from)) throw new Error(`${label}_ANCHOR_NOT_FOUND`);
  return source.replace(from, to);
}

function assertIncludes(source, value, label) {
  if (!source.includes(value)) throw new Error(`${label}_MISSING`);
}

function patchGati() {
  let source = fs.readFileSync(GATI_PATH, 'utf8');
  if (source.includes(`${MARKER}:GATI`)) return false;
  if (!source.includes('GATI_OFFLINE_SNAPSHOT_V3:GATI')) throw new Error('GATI_V3_MUST_RUN_FIRST');
  if (!source.includes('GATI_OFFLINE_PAYMENT_V1')) throw new Error('GATI_OFFLINE_PAYMENT_V1_MUST_RUN_FIRST');

  source = ensureImport(
    source,
    DURABLE_IMPORT,
    "import { clearPageSnapshot, readPageSnapshot, writePageSnapshot } from '@/lib/pageSnapshotCache';"
  );

  if (!source.includes('async function readGatiRowsFromDurableSnapshot()')) {
    source = insertAfterNamedFunction(source, 'readGatiRowsFromPageSnapshot', `async function readGatiRowsFromDurableSnapshot() {
  try {
    const snapshot = await readDurableGatiSnapshot();
    const rows = Array.isArray(snapshot?.rows) ? snapshot.rows : [];
    return rows.map((row) => ({
      ...(row && typeof row === 'object' ? row : {}),
      _durableSnapshot: true,
      source: 'DB',
    }));
  } catch {
    return [];
  }
}`);
  }

  source = replaceNamedFunction(source, 'persistGatiPageSnapshot', `async function persistGatiPageSnapshot(rows = [], meta = {}) {
  try {
    const safeMeta = meta && typeof meta === 'object' ? meta : {};
    const sourceMode = String(safeMeta?.sourceMode || safeMeta?.source || '').trim().toUpperCase();
    if (sourceMode !== 'DB_ONLY') return readPageSnapshot('gati');

    const cleanRows = dedupeGatiSnapshotRows(Array.isArray(rows) ? rows : [])
      .filter((row) => !/^T\\d+$/i.test(String(row?.code || '').trim()))
      .map((row) => {
        const next = row && typeof row === 'object' ? { ...row } : row;
        if (next && typeof next === 'object') {
          delete next._pageSnapshot;
          delete next._durableSnapshot;
          delete next._masterCache;
        }
        return next;
      });

    const allowEmptyDbTruth = safeMeta?.allowEmptyDbTruth === true;
    if (!cleanRows.length && !allowEmptyDbTruth) {
      const previous = readPageSnapshot('gati');
      try {
        const durable = await readDurableGatiSnapshot();
        if (Array.isArray(durable?.rows) && durable.rows.length > 0) return previous;
      } catch {}
      return previous;
    }

    const finalMeta = {
      ...safeMeta,
      source: 'DB_ONLY',
      sourceMode: 'DB_ONLY',
      gatiDbTruthVersion: GATI_DB_TRUTH_VERSION,
      policyVersion: '${MARKER}',
      allowEmptyDbTruth,
    };

    const localSnapshot = writePageSnapshot('gati', cleanRows, finalMeta);
    try {
      await writeDurableGatiSnapshot(cleanRows, finalMeta);
    } catch (error) {
      gatiDbg('gati_durable_snapshot_write_failed', {
        message: String(error?.message || error || ''),
        count: cleanRows.length,
      });
    }
    return localSnapshot;
  } catch {
    return readPageSnapshot('gati');
  }
}`);

  source = replaceNamedFunction(source, 'buildImmediateGatiLocalRows', `async function buildImmediateGatiLocalRows() {
  // ${MARKER}:GATI — localStorage and IndexedDB carry the same last DB-only list.
  const pageSnapshotRows = readGatiRowsFromPageSnapshot();
  const durableSnapshotRows = await readGatiRowsFromDurableSnapshot();
  const snapshotRows = dedupeGatiSnapshotRows([
    ...(Array.isArray(pageSnapshotRows) ? pageSnapshotRows : []),
    ...(Array.isArray(durableSnapshotRows) ? durableSnapshotRows : []),
  ]);
  const local = await getAllOrdersLocal().catch(() => []);
  const pendingRows = (Array.isArray(local) ? local : [])
    .filter((row) => isGatiRowLike(row))
    .map(mapLocalOrderToGatiRow)
    .filter((row) => isStrongPendingOfflineRow(row, isPersistedDbLikeId));

  return dedupeGatiSnapshotRows(selectAuthoritativeOfflineRows({
    snapshotRows,
    pendingRows,
  }));
}`);

  source = replaceRequired(
    source,
    `      const pageSnapshotRows = dedupeGatiSnapshotRows(readGatiRowsFromPageSnapshot());\n      syncSnapshot = dedupeGatiSnapshotRows([\n        ...(Array.isArray(pageSnapshotRows) ? pageSnapshotRows : []),\n        ...readGatiRowsFromBaseMasterCache(),\n      ]);`,
    `      const localPageSnapshotRows = dedupeGatiSnapshotRows(readGatiRowsFromPageSnapshot());\n      const durablePageSnapshotRows = await readGatiRowsFromDurableSnapshot();\n      const pageSnapshotRows = dedupeGatiSnapshotRows([\n        ...(Array.isArray(localPageSnapshotRows) ? localPageSnapshotRows : []),\n        ...(Array.isArray(durablePageSnapshotRows) ? durablePageSnapshotRows : []),\n      ]);\n      syncSnapshot = dedupeGatiSnapshotRows([\n        ...(Array.isArray(pageSnapshotRows) ? pageSnapshotRows : []),\n        ...readGatiRowsFromBaseMasterCache(),\n      ]);`,
    'GATI_OFFLINE_INITIAL_DURABLE_READ'
  );

  source = replaceRequired(
    source,
    `      persistGatiPageSnapshot(baseOnly, { source: 'DB_ONLY', seq, reason, count: baseOnly.length });`,
    `      await persistGatiPageSnapshot(baseOnly, { source: 'DB_ONLY', sourceMode: 'DB_ONLY', seq, reason, count: baseOnly.length });`,
    'GATI_DB_SNAPSHOT_AWAIT'
  );

  source = replaceNamedFunction(source, 'openPay', `async function openPay(row) {
    if (!hasConcreteReadyRack(row)) {
      alert(buildConcreteRackRequiredMessage('PAGUAJ nuk lejohet.'));
      await openPlaceCard(row);
      return;
    }
    try {
      let order = null;

      if (row?.fullOrder && typeof row.fullOrder === 'object' && Object.keys(row.fullOrder).length > 0) {
        try { order = JSON.parse(JSON.stringify(row.fullOrder)); } catch { order = { ...row.fullOrder }; }
      }

      if (!order) {
        try {
          const raw = localStorage.getItem(\`order_\${row.id}\`);
          if (raw) order = JSON.parse(raw);
        } catch {
          order = null;
        }
      }

      if (!order) {
        try {
          const localRows = await getAllOrdersLocal();
          const wantedId = String(row?.id || '').trim();
          const wantedLocal = String(row?.local_oid || row?.fullOrder?.local_oid || row?.fullOrder?.oid || '').trim();
          const hit = (Array.isArray(localRows) ? localRows : []).find((item) => {
            const itemId = String(item?.id || item?.data?.id || '').trim();
            const itemLocal = String(item?.local_oid || item?.oid || item?.data?.local_oid || item?.data?.oid || '').trim();
            return (!!wantedId && itemId === wantedId) || (!!wantedLocal && itemLocal === wantedLocal);
          });
          if (hit) order = unwrapGatiOrder(hit?.data || hit);
        } catch {}
      }

      const online = typeof navigator === 'undefined' ? true : navigator.onLine !== false;
      if (!order && online) {
        const res = await dbFetchOrderById(row.id);
        order = res.order;
        scheduleLocalShadowWrite(\`order_\${row.id}\`, order, 650);
      }
      if (!order) return alert('Nuk u gjet porosia në të dhënat e fundit të sinkronizuara.');

      order.id = String(order?.id || row?.id || '');
      order.local_oid = String(order?.local_oid || order?.oid || row?.local_oid || row?.id || '');
      order.status = 'gati';
      order.state = 'gati';
      if (!order.client || typeof order.client !== 'object') order.client = {};
      order.client = {
        ...order.client,
        name: order.client?.name || order.client_name || row?.name || '',
        phone: order.client?.phone || order.client_phone || row?.phone || '',
        code: order.client?.code || order.code || row?.code || '',
      };

      const total = Number(order.pay?.euro || row?.total || computeTotalEuro(order)) || 0;
      const paid = Number(order.pay?.paid ?? row?.paid ?? 0) || 0;
      const resolvedCode = pickFirstValidCode(order.code, order.code_n, row.code, order.client?.code, order.client_code);

      setPayOrder({
        id: String(row.id),
        order,
        code: resolvedCode,
        name: order.client?.name || order.client_name || row.name || '',
        phone: order.client?.phone || order.client_phone || row.phone || '',
        total,
        paid,
        arkaRecordedPaid: Number(order.pay?.arkaRecordedPaid || 0) || 0,
        paidUpfront: !!order.pay?.paidUpfront,
        m2: Number(row?.m2 || computeM2(order)) || 0,
      });
      setPayDeliveryPending(readPaymentDoneButDeliveryPending(row.id));
      const dueNow = Math.max(0, Number((total - paid).toFixed(2)));
      setPayAdd(dueNow);
      setPayMethod('CASH');
      setShowPaySheet(true);
    } catch {
      alert('❌ Gabim gjatë hapjes së pagesës.');
    }
  }`);

  const oldQueuedBlock = `        if (queuedOffline) {\n          const queuedPayload = {\n            ...optimisticPayload,\n            offline_payment_pending: true,\n            payment_sync_state: 'OUTBOX_PENDING',\n            payment_outbox_op_id: payRes?.queuedOpId || null,\n            payment_idempotency_key: idempotencyKey,\n            updated_at: actionAt,\n          };\n          await finalizeDeliveredUi(queuedPayload, { syncPending: true });\n          showFastPayNotice('U konfirmu. Mund të vazhdosh me klientin tjetër.', 'ok', 2200);\n          try { window.dispatchEvent(new Event('tepiha:outbox-changed')); } catch {}\n          setPayBusy(false);\n          return;\n        }`;

  const newQueuedBlock = `        if (queuedOffline) {\n          const syncTransaction = buildFastPaymentTransaction({\n            payload,\n            amount: applied,\n            pinData,\n            method: payMethod,\n            idempotencyKey,\n          });\n          const deliveryOpId = await queueOp('gati_payment_delivery', {\n            table: 'orders',\n            id: orderId,\n            order_id: orderId,\n            idempotency_key: idempotencyKey,\n            transaction: syncTransaction,\n            delivery_patch: {\n              status: 'dorzim',\n              data: payload,\n              updated_at: payload?.updated_at || actionAt,\n              delivered_at: payload?.delivered_at || actionAt,\n              picked_up_at: payload?.picked_up_at || actionAt,\n            },\n          });\n          const queuedPayload = {\n            ...optimisticPayload,\n            offline_payment_pending: true,\n            offline_delivery_pending: true,\n            payment_sync_state: 'OUTBOX_PENDING',\n            delivery_sync_state: 'OUTBOX_PENDING',\n            payment_outbox_op_id: payRes?.queuedOpId || null,\n            delivery_outbox_op_id: deliveryOpId || null,\n            payment_idempotency_key: idempotencyKey,\n            updated_at: actionAt,\n          };\n          await finalizeDeliveredUi(queuedPayload, { syncPending: true });\n          showFastPayNotice('U ruajt. Mund të vazhdosh me klientin tjetër.', 'ok', 2200);\n          try { window.dispatchEvent(new Event('tepiha:outbox-changed')); } catch {}\n          setPayBusy(false);\n          return;\n        }`;
  source = replaceRequired(source, oldQueuedBlock, newQueuedBlock, 'GATI_QUEUED_PAYMENT_DELIVERY');

  source = replaceRequired(
    source,
    `                  const cleared = clearBaseMasterCacheScope(['gati']);\n                  clearPageSnapshot('gati');`,
    `                  const cleared = clearBaseMasterCacheScope(['gati']);\n                  clearPageSnapshot('gati');\n                  void clearDurableGatiSnapshot();`,
    'GATI_MANUAL_CLEAR_DURABLE'
  );

  source = source.replace(
    '// GATI_OFFLINE_SNAPSHOT_V3:GATI',
    `// GATI_OFFLINE_SNAPSHOT_V3:GATI\n// ${MARKER}:GATI`
  );

  assertIncludes(source, 'readGatiRowsFromDurableSnapshot', 'GATI_DURABLE_READER');
  assertIncludes(source, "queueOp('gati_payment_delivery'", 'GATI_COMBINED_PAYMENT_DELIVERY_OP');
  assertIncludes(source, 'await persistGatiPageSnapshot(baseOnly', 'GATI_AWAIT_PERSIST');
  fs.writeFileSync(GATI_PATH, source, 'utf8');
  return true;
}

function patchSyncEngine() {
  let source = fs.readFileSync(SYNC_PATH, 'utf8');
  if (source.includes(`${MARKER}:SYNC`)) return false;

  source = replaceRequired(
    source,
    `  if (type === 'arka_transaction') {\n    const tx = payload?.transaction && typeof payload.transaction === 'object' ? payload.transaction : payload;\n    const action = String(tx?.action || payload?.action || '').trim();\n    const idempotency = String(tx?.idempotencyKey || tx?.idempotency_key || payload?.idempotency_key || '').trim();\n    if (!action) return 'MISSING_ARKA_ACTION';\n    if (!idempotency) return 'MISSING_ARKA_IDEMPOTENCY_KEY';\n  }`,
    `  if (type === 'arka_transaction' || type === 'gati_payment_delivery') {\n    const tx = payload?.transaction && typeof payload.transaction === 'object' ? payload.transaction : payload;\n    const action = String(tx?.action || payload?.action || '').trim();\n    const idempotency = String(tx?.idempotencyKey || tx?.idempotency_key || payload?.idempotency_key || '').trim();\n    if (!action) return 'MISSING_ARKA_ACTION';\n    if (!idempotency) return 'MISSING_ARKA_IDEMPOTENCY_KEY';\n    if (type === 'gati_payment_delivery') {\n      const id = String(payload?.id || payload?.order_id || '').trim();\n      if (!id) return 'MISSING_ID';\n      if (!payload?.delivery_patch || typeof payload.delivery_patch !== 'object') return 'MISSING_DELIVERY_PATCH';\n    }\n  }`,
    'SYNC_VALIDATE_GATI_PAYMENT_DELIVERY'
  );

  const arkaHandler = `  if (type === 'arka_transaction') {\n    const tx = payload?.transaction && typeof payload.transaction === 'object' ? payload.transaction : payload;`;
  if (!source.includes(arkaHandler)) throw new Error('SYNC_ARKA_HANDLER_ANCHOR_NOT_FOUND');
  const combinedHandler = `  if (type === 'gati_payment_delivery') {\n    // ${MARKER}:SYNC — retrying this operation is safe because the ARKA\n    // transaction uses a stable idempotency key before the delivery patch.\n    const tx = payload?.transaction && typeof payload.transaction === 'object' ? payload.transaction : {};\n    const result = await postArkaTransaction({\n      ...(tx || {}),\n      _offline_flush: true,\n      _outbox_op_id: String(op?.op_id || ''),\n      _gati_payment_delivery: true,\n    }, { timeoutMs: Math.min(ARKA_SYNC_HTTP_TIMEOUT_MS, SYNC_OP_TIMEOUT_MS - 1000) });\n\n    const payment = result?.payment || result?.data?.payment || null;\n    const paidOrder = result?.order || result?.data?.order || null;\n    if (!payment?.id || !paidOrder?.id) throw new Error('GATI_OFFLINE_ARKA_VERIFY_FAILED');\n\n    const table = String(payload?.table || 'orders');\n    const id = String(payload?.id || payload?.order_id || paidOrder?.id || '');\n    const rawPatch = payload?.delivery_patch && typeof payload.delivery_patch === 'object'\n      ? payload.delivery_patch\n      : {};\n    await ensureArkaPaymentBeforePaidCashOrderPatch(table, id, rawPatch);\n    const patch = stripNonSchemaCols({ ...(rawPatch || {}) }, table);\n    if ('data_patch' in patch) delete patch.data_patch;\n    await updateByIdOrLocalOid(table, id, patch);\n    return true;\n  }\n\n`;
  source = source.replace(arkaHandler, `${combinedHandler}${arkaHandler}`);
  source = source.replace(
    "import { ARKA_SYNC_HTTP_TIMEOUT_MS, postArkaTransaction } from '@/lib/arka/arkaNetwork';",
    "import { ARKA_SYNC_HTTP_TIMEOUT_MS, postArkaTransaction } from '@/lib/arka/arkaNetwork';\n// GATI_OFFLINE_RELIABILITY_V4:SYNC"
  );

  assertIncludes(source, "type === 'gati_payment_delivery'", 'SYNC_COMBINED_OP_HANDLER');
  fs.writeFileSync(SYNC_PATH, source, 'utf8');
  return true;
}

function patchRecovery() {
  let source = fs.readFileSync(RECOVERY_PATH, 'utf8');
  if (source.includes(`${MARKER}:RECOVERY`)) return false;
  if (!source.includes('GATI_OFFLINE_SNAPSHOT_V3:RECOVERY')) throw new Error('RECOVERY_V3_MUST_RUN_FIRST');

  source = ensureImport(
    source,
    "import { writeDurableGatiSnapshot } from '@/lib/gatiDurableSnapshot';",
    "import { rebuildBaseMasterCacheFromOrders } from '@/lib/baseMasterCache';"
  );

  source = replaceNamedFunction(source, 'writeRecoveredGatiSnapshot', `async function writeRecoveredGatiSnapshot(dbRows = [], source = 'recovery') {
  const rows = buildRecoveredGatiSnapshotRows(dbRows);
  const meta = {
    source: 'DB_ONLY',
    sourceMode: 'DB_ONLY',
    gatiDbTruthVersion: GATI_DB_TRUTH_VERSION,
    policyVersion: GATI_SNAPSHOT_POLICY_VERSION,
    builtBy: VERSION,
    recoverySource: String(source || 'recovery'),
    dbRowCount: Array.isArray(dbRows) ? dbRows.length : 0,
    gatiRowCount: rows.length,
    allowEmptyDbTruth: true,
  };
  const localSnapshot = writePageSnapshot('gati', rows, meta);
  await writeDurableGatiSnapshot(rows, meta);
  return localSnapshot;
}`);

  source = replaceRequired(
    source,
    '    const gatiSnapshot = writeRecoveredGatiSnapshot(dbRows, source);',
    '    const gatiSnapshot = await writeRecoveredGatiSnapshot(dbRows, source);',
    'RECOVERY_AWAIT_DURABLE_GATI'
  );

  source = source.replace(
    '// GATI_OFFLINE_SNAPSHOT_V3:RECOVERY',
    `// GATI_OFFLINE_SNAPSHOT_V3:RECOVERY\n// ${MARKER}:RECOVERY`
  );

  assertIncludes(source, 'await writeDurableGatiSnapshot(rows, meta)', 'RECOVERY_DURABLE_WRITE');
  fs.writeFileSync(RECOVERY_PATH, source, 'utf8');
  return true;
}

const changed = [patchGati(), patchSyncEngine(), patchRecovery()].some(Boolean);
console.log(`[gati-offline-reliability-v4] ${changed ? 'installed' : 'already installed'}`);
