import fs from 'node:fs';

const GATI_PATH = 'app/gati/page.jsx';
const PASTRIMI_PATH = 'app/pastrimi/page.jsx';
const RECOVERY_PATH = 'lib/onlineDbTruthRecovery.js';
const MARKER = 'AUTHORITATIVE_OFFLINE_LISTS_V2';
const POLICY_IMPORT = "import { isDbTruthSnapshotMeta, isStrongPendingOfflineRow, selectAuthoritativeOfflineRows } from '@/lib/authoritativeOfflineListPolicy';";

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
  if (paramsStart < 0) throw new Error(`${name}_PARAMS_NOT_FOUND`);
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
  if (!source.includes(value)) throw new Error(`${label}_MISSING_AFTER_PATCH`);
}

function patchGati() {
  let source = fs.readFileSync(GATI_PATH, 'utf8');
  if (source.includes(`${MARKER}:GATI`)) return false;

  source = ensureImport(
    source,
    POLICY_IMPORT,
    "import { listBaseCreateRecovery } from '@/lib/syncRecovery';"
  );

  if (!source.includes("const GATI_DB_TRUTH_VERSION = 'gati-db-truth-2026-08-03-v1';")) {
    const anchor = 'const GATI_FETCH_LIMIT = 200;';
    if (!source.includes(anchor)) throw new Error('GATI_VERSION_ANCHOR_NOT_FOUND');
    source = source.replace(anchor, `${anchor}\nconst GATI_DB_TRUTH_VERSION = 'gati-db-truth-2026-08-03-v1';`);
  }

  source = replaceNamedFunction(source, 'readGatiRowsFromBaseMasterCache', `function readGatiRowsFromBaseMasterCache(cache = null) {
  try {
    // ${MARKER}:GATI — IndexedDB/master cache is an archive, not an offline list.
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    const verifiedSnapshot = readPageSnapshot('gati');
    if (offline || isGatiDbTruthSnapshot(verifiedSnapshot)) return [];
    return (getBaseRowsByStatus('gati', cache) || []).map(mapBaseCacheRowToGati);
  } catch {
    return [];
  }
}`);

  if (!source.includes('function isGatiDbTruthSnapshot(snapshot)')) {
    const anchor = 'function readGatiRowsFromPageSnapshot() {';
    if (!source.includes(anchor)) throw new Error('GATI_SNAPSHOT_FUNCTION_ANCHOR_NOT_FOUND');
    source = source.replace(anchor, `function isGatiDbTruthSnapshot(snapshot) {
  try {
    return isDbTruthSnapshotMeta(snapshot?.meta, {
      sourceMode: 'DB_ONLY',
      versionKey: 'gatiDbTruthVersion',
      version: GATI_DB_TRUTH_VERSION,
    });
  } catch {
    return false;
  }
}

${anchor}`);
  }

  source = replaceNamedFunction(source, 'readGatiRowsFromPageSnapshot', `function readGatiRowsFromPageSnapshot() {
  try {
    const snapshot = readPageSnapshot('gati');
    if (!isGatiDbTruthSnapshot(snapshot)) return [];
    return (Array.isArray(snapshot?.rows) ? snapshot.rows : []).map((row) => ({
      ...(row && typeof row === 'object' ? row : {}),
      _pageSnapshot: true,
      source: String(row?.source || 'PAGE_SNAPSHOT'),
    }));
  } catch {
    return [];
  }
}`);

  source = replaceNamedFunction(source, 'persistGatiPageSnapshot', `function persistGatiPageSnapshot(rows = [], meta = {}) {
  try {
    const safeMeta = meta && typeof meta === 'object' ? meta : {};
    const sourceMode = String(safeMeta?.sourceMode || safeMeta?.source || '').trim().toUpperCase();
    // ${MARKER}:GATI — offline/local composites may never overwrite DB truth.
    if (sourceMode !== 'DB_ONLY') return readPageSnapshot('gati');

    const cleanRows = dedupeGatiSnapshotRows(Array.isArray(rows) ? rows : [])
      .filter((row) => !/^T\\d+$/i.test(String(row?.code || '').trim()))
      .map((row) => {
        const next = row && typeof row === 'object' ? { ...row } : row;
        if (next && typeof next === 'object') {
          delete next._pageSnapshot;
          delete next._masterCache;
        }
        return next;
      });

    return writePageSnapshot('gati', cleanRows, {
      ...safeMeta,
      source: 'DB_ONLY',
      sourceMode: 'DB_ONLY',
      gatiDbTruthVersion: GATI_DB_TRUTH_VERSION,
      policyVersion: '${MARKER}',
    });
  } catch {
    return readPageSnapshot('gati');
  }
}`);

  source = replaceNamedFunction(source, 'rowLooksPendingOrLocalGati', `function rowLooksPendingOrLocalGati(row) {
  // ${MARKER}:GATI — source LOCAL alone is never proof of pending work.
  return isStrongPendingOfflineRow(row, isPersistedDbLikeId);
}`);

  source = replaceNamedFunction(source, 'buildImmediateGatiLocalRows', `async function buildImmediateGatiLocalRows() {
  // ${MARKER}:GATI — one authoritative snapshot plus strongly pending rows only.
  const snapshotRows = readGatiRowsFromPageSnapshot();
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
    `        const visibleOfflineRows = dedupeGatiSnapshotRows([\n          ...(Array.isArray(offlineRows) ? offlineRows : []),\n          ...(Array.isArray(syncSnapshot) ? syncSnapshot : []),\n          ...currentRows,\n        ])`,
    `        const transitionPendingRows = [\n          ...(Array.isArray(syncSnapshot) ? syncSnapshot : []),\n          ...currentRows,\n        ].filter((row) => rowLooksPendingOrLocalGati(row));\n        const visibleOfflineRows = dedupeGatiSnapshotRows([\n          ...(Array.isArray(offlineRows) ? offlineRows : []),\n          ...transitionPendingRows,\n        ])`,
    'GATI_OFFLINE_VISIBLE_ROWS'
  );

  source = replaceRequired(
    source,
    `        const keepVisibleRows = dedupeOrders([\n          ...(Array.isArray(syncSnapshot) ? syncSnapshot : []),\n          ...currentRows,\n        ])`,
    `        const authoritativeErrorRows = await buildImmediateGatiLocalRows().catch(() => []);\n        const errorPendingRows = [\n          ...(Array.isArray(syncSnapshot) ? syncSnapshot : []),\n          ...currentRows,\n        ].filter((row) => rowLooksPendingOrLocalGati(row));\n        const keepVisibleRows = dedupeOrders([\n          ...(Array.isArray(authoritativeErrorRows) ? authoritativeErrorRows : []),\n          ...errorPendingRows,\n        ])`,
    'GATI_ERROR_VISIBLE_ROWS'
  );

  source = source.replace(
    '// app/gati/page.jsx',
    `// app/gati/page.jsx\n// ${MARKER}:GATI`
  );

  assertIncludes(source, "sourceMode !== 'DB_ONLY'", 'GATI_SNAPSHOT_WRITE_GUARD');
  assertIncludes(source, 'gatiDbTruthVersion: GATI_DB_TRUTH_VERSION', 'GATI_SNAPSHOT_VERSION');
  assertIncludes(source, 'transitionPendingRows', 'GATI_TRANSITION_PENDING_ONLY');
  assertIncludes(source, 'authoritativeErrorRows', 'GATI_ERROR_PENDING_ONLY');

  fs.writeFileSync(GATI_PATH, source, 'utf8');
  return true;
}

function patchPastrimi() {
  let source = fs.readFileSync(PASTRIMI_PATH, 'utf8');
  if (source.includes(`${MARKER}:PASTRIMI`)) return false;

  source = ensureImport(
    source,
    POLICY_IMPORT,
    "import { createPendingCashPayment } from '@/lib/arkaCashSync';"
  );

  source = replaceNamedFunction(source, 'readPastrimRowsFromBaseMasterCache', `function readPastrimRowsFromBaseMasterCache(cache = null) {
  try {
    // ${MARKER}:PASTRIMI — master cache must never paint an offline client list.
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    const verifiedSnapshot = readPageSnapshot('pastrimi');
    if (offline || isPastrimiDbTruthSnapshot(verifiedSnapshot)) return [];
    return [
      ...(getBaseRowsByStatus('pastrim', cache) || []),
      ...(getBaseRowsByStatus('pastrimi', cache) || []),
    ].map(mapBaseCacheRowToPastrim);
  } catch {
    return [];
  }
}`);

  source = replaceNamedFunction(source, 'persistPastrimPageSnapshot', `function persistPastrimPageSnapshot(rows = [], meta = {}) {
  try {
    const safeMeta = meta && typeof meta === 'object' ? meta : {};
    const sourceMode = String(safeMeta?.sourceMode || safeMeta?.source || '').trim().toUpperCase();
    // ${MARKER}:PASTRIMI — preserve the last DB snapshot during offline/fallback renders.
    if (sourceMode !== 'DB_ONLY') return readPageSnapshot('pastrimi');

    const cleanRows = dedupePastrimRows((Array.isArray(rows) ? rows : []).map((row) => normalizeRenderableOrderRow(row)))
      .filter((row) => shouldShowTransportBridgeInPastrim(row))
      .map((row) => {
        const next = row && typeof row === 'object' ? { ...row } : row;
        if (next && typeof next === 'object') {
          delete next._pageSnapshot;
          delete next._masterCache;
        }
        return next;
      });

    return writePageSnapshot('pastrimi', cleanRows, {
      ...safeMeta,
      source: 'DB_ONLY',
      sourceMode: 'DB_ONLY',
      pastrimiDbTruthVersion: PASTRIMI_DB_TRUTH_VERSION,
      policyVersion: '${MARKER}',
    });
  } catch {
    return readPageSnapshot('pastrimi');
  }
}`);

  source = replaceNamedFunction(source, 'buildImmediatePastrimLocalRows', `function buildImmediatePastrimLocalRows() {
  try {
    // ${MARKER}:PASTRIMI — no IndexedDB archive and no master-cache merge.
    const snapshotRows = readPastrimRowsFromPageSnapshot();
    const pendingRows = buildPendingOutboxPastrimRows()
      .map((row) => normalizeRenderableOrderRow(row))
      .filter((row) => isStrongPendingOfflineRow(row));
    const rows = dedupePastrimRows(selectAuthoritativeOfflineRows({
      snapshotRows,
      pendingRows,
    }))
      .filter((row) => shouldShowTransportBridgeInPastrim(row))
      .sort((a, b) => Number(b?.ts || 0) - Number(a?.ts || 0));
    return rows;
  } catch {
    return [];
  }
}`);

  source = replaceNamedFunction(source, 'buildPastrimFallbackRows', `async function buildPastrimFallbackRows(trace = null, diagEnabled = false) {
  // ${MARKER}:PASTRIMI — visible offline rows come from DB truth + outbox only.
  const snapshotRows = readPastrimRowsFromPageSnapshot();
  const pendingRows = buildPendingOutboxPastrimRows()
    .map((row) => normalizeRenderableOrderRow(row))
    .filter((row) => isStrongPendingOfflineRow(row));
  const rows = dedupePastrimRows(selectAuthoritativeOfflineRows({
    snapshotRows,
    pendingRows,
  }))
    .filter((row) => shouldShowTransportBridgeInPastrim(row))
    .sort((a, b) => Number(b?.ts || 0) - Number(a?.ts || 0));

  rows.forEach((row) => pushPastrimTrace(trace, 'offline_final', row, 'keep', 'db_snapshot_or_pending_outbox'));
  if (diagEnabled) {
    try { if (typeof window !== 'undefined') window.__tepihaPastrimTrace = trace; } catch {}
    try { console.debug('[PASTRIM authoritative offline trace]', trace); } catch {}
  }
  return rows;
}`);

  if (!source.includes('async function readPendingLocalOrdersByStatus(status)')) {
    const anchor = 'async function readLocalOrdersByStatus(status) {';
    if (!source.includes(anchor)) throw new Error('PASTRIMI_LOCAL_STATUS_READER_ANCHOR_NOT_FOUND');
    source = source.replace(anchor, `async function readPendingLocalOrdersByStatus(status) {
  // ${MARKER}:PASTRIMI — compatibility path for any remaining callers.
  // It may expose only rows with explicit outbox/local pending evidence.
  const rows = await readLocalOrdersByStatus(status);
  return (Array.isArray(rows) ? rows : []).filter((row) => isStrongPendingOfflineRow(row));
}

${anchor}`);
  }

  source = source.split("readLocalOrdersByStatus('pastrim')").join("readPendingLocalOrdersByStatus('pastrim')");

  source = source.replace(
    "'use client';",
    `'use client';\n\n// ${MARKER}:PASTRIMI`
  );

  assertIncludes(source, "sourceMode !== 'DB_ONLY'", 'PASTRIMI_SNAPSHOT_WRITE_GUARD');
  assertIncludes(source, 'pastrimiDbTruthVersion: PASTRIMI_DB_TRUTH_VERSION', 'PASTRIMI_SNAPSHOT_VERSION');
  if (source.includes("readLocalOrdersByStatus('pastrim')")) throw new Error('PASTRIMI_STALE_LOCAL_ARCHIVE_CALL_REMAINS');

  fs.writeFileSync(PASTRIMI_PATH, source, 'utf8');
  return true;
}

function patchOnlineRecovery() {
  let source = fs.readFileSync(RECOVERY_PATH, 'utf8');
  if (source.includes(`${MARKER}:RECOVERY`)) return false;

  const oldClear = `    try { clearPageSnapshot('pastrimi'); } catch {}\n    try { clearPageSnapshot('gati'); } catch {}`;
  if (!source.includes(oldClear)) throw new Error('ONLINE_RECOVERY_SNAPSHOT_CLEAR_ANCHOR_NOT_FOUND');
  source = source.replace(oldClear, `    // ${MARKER}:RECOVERY\n    // A full base-order scan does not contain transport_orders. Clearing the\n    // page snapshots here destroys the only authoritative combined Base +\n    // Transport offline list and forces the UI back to historical IndexedDB.\n    try {\n      window.localStorage?.setItem?.('tepiha_authoritative_snapshots_preserved_v2', JSON.stringify({\n        at: new Date().toISOString(),\n        source,\n        dbRows: dbRows.length,\n        preserved: ['pastrimi', 'gati'],\n      }));\n    } catch {}`);

  fs.writeFileSync(RECOVERY_PATH, source, 'utf8');
  return true;
}

const changed = [patchGati(), patchPastrimi(), patchOnlineRecovery()].some(Boolean);
console.log(`[authoritative-offline-lists-v2] ${changed ? 'installed' : 'already installed'}`);
