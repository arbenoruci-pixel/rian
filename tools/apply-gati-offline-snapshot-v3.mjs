import fs from 'node:fs';

const GATI_PATH = 'app/gati/page.jsx';
const RECOVERY_PATH = 'lib/onlineDbTruthRecovery.js';
const MARKER = 'GATI_OFFLINE_SNAPSHOT_V3';
const GATI_DB_TRUTH_VERSION = 'gati-db-truth-2026-08-03-v3';
const POLICY_VERSION = 'gati-offline-snapshot-v3-2026-08-03';

function findNamedFunctionRange(source, name) {
  const match = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(source);
  if (!match) throw new Error(`${name}_FUNCTION_NOT_FOUND`);
  const bodyStart = source.indexOf('{', match.index);
  if (bodyStart < 0) throw new Error(`${name}_BODY_NOT_FOUND`);

  let depth = 0;
  let quote = '';
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let i = bodyStart; i < source.length; i += 1) {
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
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return { start: match.index, end: i + 1 };
    }
  }

  throw new Error(`${name}_FUNCTION_UNTERMINATED`);
}

function replaceNamedFunction(source, name, replacement) {
  const range = findNamedFunctionRange(source, name);
  return `${source.slice(0, range.start)}${replacement}${source.slice(range.end)}`;
}

function patchGati() {
  let source = fs.readFileSync(GATI_PATH, 'utf8');
  if (source.includes(`${MARKER}:GATI`)) return false;

  const versionPattern = /const GATI_DB_TRUTH_VERSION = '[^']+';/;
  if (!versionPattern.test(source)) throw new Error('GATI_DB_TRUTH_VERSION_NOT_FOUND');
  source = source.replace(
    versionPattern,
    `const GATI_DB_TRUTH_VERSION = '${GATI_DB_TRUTH_VERSION}';\nconst GATI_DB_TRUTH_COMPAT_VERSIONS = new Set([\n  'gati-db-truth-2026-08-03-v1',\n  'gati-db-truth-2026-08-03-v2',\n  '${GATI_DB_TRUTH_VERSION}',\n]);`
  );

  source = replaceNamedFunction(source, 'isGatiDbTruthSnapshot', `function isGatiDbTruthSnapshot(snapshot) {
  try {
    const meta = snapshot?.meta && typeof snapshot.meta === 'object' ? snapshot.meta : {};
    const sourceMode = String(meta?.sourceMode || meta?.source || '').trim().toUpperCase();
    if (sourceMode !== 'DB_ONLY') return false;

    const version = String(meta?.gatiDbTruthVersion || '').trim();
    if (version) return GATI_DB_TRUTH_COMPAT_VERSIONS.has(version);

    // ${MARKER}:GATI — snapshots written by the previous production build
    // had meta.source='DB_ONLY' but no explicit version. Validate every row
    // before accepting and upgrading that already-correct DB snapshot.
    const rows = Array.isArray(snapshot?.rows) ? snapshot.rows : [];
    return rows.every((row) => {
      const rowSource = String(row?.source || '').trim().toUpperCase();
      const id = String(row?.id || row?.db_id || row?.server_id || '').trim();
      const status = normalizeGatiStatus(
        row?.status ||
        row?.fullOrder?.status ||
        row?.fullOrder?.state ||
        row?.fullOrder?.data?.status ||
        'gati'
      );
      const sourceOk = !rowSource || ['DB', 'ORDERS', 'ONLINE', 'PAGE_SNAPSHOT'].includes(rowSource);
      return sourceOk && status === 'gati' && isPersistedDbLikeId(id);
    });
  } catch {
    return false;
  }
}`);

  source = replaceNamedFunction(source, 'readGatiRowsFromPageSnapshot', `function readGatiRowsFromPageSnapshot() {
  try {
    const snapshot = readPageSnapshot('gati');
    if (!isGatiDbTruthSnapshot(snapshot)) return [];

    const rawRows = Array.isArray(snapshot?.rows) ? snapshot.rows : [];
    const meta = snapshot?.meta && typeof snapshot.meta === 'object' ? snapshot.meta : {};
    const storedVersion = String(meta?.gatiDbTruthVersion || '').trim();

    // ${MARKER}:GATI — migrate a valid legacy DB_ONLY snapshot in place.
    if (storedVersion !== GATI_DB_TRUTH_VERSION) {
      try {
        writePageSnapshot('gati', rawRows, {
          ...meta,
          source: 'DB_ONLY',
          sourceMode: 'DB_ONLY',
          gatiDbTruthVersion: GATI_DB_TRUTH_VERSION,
          policyVersion: '${POLICY_VERSION}',
          migratedFromVersion: storedVersion || 'legacy-db-only-unversioned',
          migratedAt: new Date().toISOString(),
        });
      } catch {}
    }

    return rawRows.map((row) => ({
      ...(row && typeof row === 'object' ? row : {}),
      _pageSnapshot: true,
      source: String(row?.source || 'PAGE_SNAPSHOT'),
    }));
  } catch {
    return [];
  }
}`);

  const markerAnchor = '// AUTHORITATIVE_OFFLINE_LISTS_V2:GATI';
  if (!source.includes(markerAnchor)) throw new Error('GATI_V2_MARKER_NOT_FOUND');
  source = source.replace(markerAnchor, `${markerAnchor}\n// ${MARKER}:GATI`);

  fs.writeFileSync(GATI_PATH, source, 'utf8');
  return true;
}

function patchRecovery() {
  let source = fs.readFileSync(RECOVERY_PATH, 'utf8');
  if (source.includes(`${MARKER}:RECOVERY`)) return false;

  const oldSnapshotImport = "import { clearPageSnapshot } from '@/lib/pageSnapshotCache';";
  const newSnapshotImport = "import { writePageSnapshot } from '@/lib/pageSnapshotCache';";
  if (source.includes(oldSnapshotImport)) source = source.replace(oldSnapshotImport, newSnapshotImport);
  else if (!source.includes(newSnapshotImport)) throw new Error('RECOVERY_SNAPSHOT_IMPORT_NOT_FOUND');

  const versionAnchor = "const VERSION = 'online-db-truth-recovery-v1';";
  if (!source.includes(versionAnchor)) throw new Error('RECOVERY_VERSION_ANCHOR_NOT_FOUND');
  source = source.replace(
    versionAnchor,
    `${versionAnchor}\nconst GATI_DB_TRUTH_VERSION = '${GATI_DB_TRUTH_VERSION}';\nconst GATI_SNAPSHOT_POLICY_VERSION = '${POLICY_VERSION}';\n// ${MARKER}:RECOVERY`
  );

  const oldSelect = "id,local_oid,status,created_at,updated_at,data,code,client_id,client_name,client_phone,price_total,m2_total,pieces,paid_cash,is_paid_upfront";
  const newSelect = "id,local_oid,status,created_at,updated_at,ready_at,picked_up_at,delivered_at,data,code,client_id,client_name,client_phone,price_total,m2_total,pieces,paid_cash,is_paid_upfront";
  if (source.includes(oldSelect)) source = source.replace(oldSelect, newSelect);
  else if (!source.includes(newSelect)) throw new Error('RECOVERY_ORDERS_SELECT_NOT_FOUND');

  const helperAnchor = 'function dispatchRecovery(detail = {}) {';
  if (!source.includes(helperAnchor)) throw new Error('RECOVERY_HELPER_ANCHOR_NOT_FOUND');
  const helpers = `function recoveryObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function recoveryNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function recoveryNormalizeCode(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const digits = raw.replace(/\\D+/g, '').replace(/^0+/, '');
  return digits || '0';
}

function recoveryRows(data, firstKey, secondKey) {
  if (Array.isArray(data?.[firstKey])) return data[firstKey];
  if (Array.isArray(data?.[secondKey])) return data[secondKey];
  return [];
}

function recoveryComputeM2(data = {}) {
  let total = 0;
  for (const row of recoveryRows(data, 'tepiha', 'tepihaRows')) {
    total += recoveryNumber(row?.m2 ?? row?.m ?? row?.area, 0) * recoveryNumber(row?.qty ?? row?.pieces, 0);
  }
  for (const row of recoveryRows(data, 'staza', 'stazaRows')) {
    total += recoveryNumber(row?.m2 ?? row?.m ?? row?.area, 0) * recoveryNumber(row?.qty ?? row?.pieces, 0);
  }
  const stairsQty = recoveryNumber(data?.shkallore?.qty ?? data?.stairsQty, 0);
  const stairsPer = recoveryNumber(data?.shkallore?.per ?? data?.stairsPer, 0.3);
  total += stairsQty * stairsPer;
  return Number(total.toFixed(2));
}

function recoveryComputePieces(data = {}) {
  let total = 0;
  for (const row of recoveryRows(data, 'tepiha', 'tepihaRows')) total += recoveryNumber(row?.qty ?? row?.pieces, 0);
  for (const row of recoveryRows(data, 'staza', 'stazaRows')) total += recoveryNumber(row?.qty ?? row?.pieces, 0);
  total += recoveryNumber(data?.shkallore?.qty ?? data?.stairsQty, 0);
  return total;
}

function buildRecoveredGatiSnapshotRows(dbRows = []) {
  return (Array.isArray(dbRows) ? dbRows : [])
    .filter((row) => statusOf(row) === 'gati')
    .map((row) => {
      const data = recoveryObject(row?.data);
      const client = recoveryObject(data?.client);
      const id = String(row?.id || '').trim();
      const localOid = String(row?.local_oid || data?.local_oid || data?.oid || id).trim();
      const code = recoveryNormalizeCode(row?.code || data?.code || client?.code || '');
      const name = String(row?.client_name || data?.client_name || client?.name || 'Pa Emër').trim() || 'Pa Emër';
      const phone = String(row?.client_phone || data?.client_phone || client?.phone || '').trim();
      const structuredM2 = recoveryComputeM2(data);
      const m2 = recoveryNumber(row?.m2_total, 0) > 0 ? recoveryNumber(row?.m2_total, 0) : structuredM2;
      const structuredPieces = recoveryComputePieces(data);
      const cope = recoveryNumber(row?.pieces, 0) > 0 ? recoveryNumber(row?.pieces, 0) : structuredPieces;
      const total = Math.max(
        0,
        recoveryNumber(row?.price_total, 0),
        recoveryNumber(data?.price_total, 0),
        recoveryNumber(data?.pay?.euro, 0),
        recoveryNumber(data?.total, 0)
      );
      const paid = Math.max(
        0,
        recoveryNumber(row?.paid_cash, 0),
        recoveryNumber(data?.paid_cash, 0),
        recoveryNumber(data?.pay?.paid, 0),
        recoveryNumber(data?.clientPaid, 0),
        recoveryNumber(data?.paid, 0)
      );
      const readySlots = Array.isArray(data?.ready_slots) ? data.ready_slots : [];
      const readyLocation = String(data?.ready_location || readySlots.join(', ') || '').trim();
      const readyText = String(data?.ready_note_text || '').trim();
      const readyNote = String(data?.ready_note || readyLocation || readyText || '').trim();
      const readyTs = Date.parse(row?.ready_at || data?.ready_at || row?.updated_at || row?.created_at || 0) || recoveryNumber(data?.ready_at || data?.ts, 0) || Date.now();
      const ts = recoveryNumber(data?.ts, 0) || Date.parse(row?.created_at || row?.updated_at || 0) || readyTs;
      const fullOrder = {
        ...data,
        id,
        local_oid: localOid,
        oid: String(data?.oid || localOid),
        status: 'gati',
        state: 'gati',
        code,
        client_name: name,
        client_phone: phone,
        client: {
          ...client,
          name: client?.name || name,
          phone: client?.phone || phone,
          code: client?.code || code,
        },
        pay: {
          ...recoveryObject(data?.pay),
          euro: total,
          paid,
        },
        ready_note: readyNote,
        ready_note_text: readyText,
        ready_location: readyLocation,
        ready_slots: readySlots,
      };

      return {
        id,
        local_oid: localOid,
        source: 'DB',
        status: 'gati',
        ts,
        updated_at: String(row?.updated_at || data?.updated_at || ''),
        readyTs,
        picked_up_at: row?.picked_up_at || data?.picked_up_at || null,
        delivered_at: row?.delivered_at || data?.delivered_at || null,
        name,
        phone,
        code,
        m2: Number(recoveryNumber(m2, 0).toFixed(2)),
        cope: recoveryNumber(cope, 0),
        total: Number(recoveryNumber(total, 0).toFixed(2)),
        paid: Number(recoveryNumber(paid, 0).toFixed(2)),
        paidUpfront: Boolean(row?.is_paid_upfront ?? data?.is_paid_upfront ?? data?.pay?.paidUpfront),
        isReturn: Boolean(data?.returnInfo?.active),
        readyNote,
        ready_location: readyLocation,
        ready_note_text: readyText,
        ready_slots: readySlots,
        fullOrder,
      };
    })
    .sort((a, b) => Number(b?.readyTs || 0) - Number(a?.readyTs || 0));
}

function writeRecoveredGatiSnapshot(dbRows = [], source = 'recovery') {
  const rows = buildRecoveredGatiSnapshotRows(dbRows);
  return writePageSnapshot('gati', rows, {
    source: 'DB_ONLY',
    sourceMode: 'DB_ONLY',
    gatiDbTruthVersion: GATI_DB_TRUTH_VERSION,
    policyVersion: GATI_SNAPSHOT_POLICY_VERSION,
    builtBy: VERSION,
    recoverySource: String(source || 'recovery'),
    dbRowCount: Array.isArray(dbRows) ? dbRows.length : 0,
    gatiRowCount: rows.length,
  });
}

`;
  source = source.replace(helperAnchor, `${helpers}${helperAnchor}`);

  const rebuildAnchor = '    rebuildBaseMasterCacheFromOrders(rebuiltRows);';
  if (!source.includes(rebuildAnchor)) throw new Error('RECOVERY_REBUILD_ANCHOR_NOT_FOUND');
  source = source.replace(
    rebuildAnchor,
    `${rebuildAnchor}\n    const gatiSnapshot = writeRecoveredGatiSnapshot(dbRows, source);`
  );

  const resultAnchor = '      hydrated,\n      preservedPending: preservedPending.length,';
  if (!source.includes(resultAnchor)) throw new Error('RECOVERY_RESULT_ANCHOR_NOT_FOUND');
  source = source.replace(
    resultAnchor,
    `      hydrated,\n      gatiSnapshotRows: Number(gatiSnapshot?.count || 0),\n      gatiSnapshotVersion: GATI_DB_TRUTH_VERSION,\n      preservedPending: preservedPending.length,`
  );

  fs.writeFileSync(RECOVERY_PATH, source, 'utf8');
  return true;
}

const changed = [patchGati(), patchRecovery()].some(Boolean);
console.log(`[gati-offline-snapshot-v3] ${changed ? 'installed' : 'already installed'}`);
