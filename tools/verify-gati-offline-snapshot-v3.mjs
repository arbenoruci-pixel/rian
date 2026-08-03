import fs from 'node:fs';

const gati = fs.readFileSync('app/gati/page.jsx', 'utf8');
const recovery = fs.readFileSync('lib/onlineDbTruthRecovery.js', 'utf8');
const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); };

function functionBlock(source, name) {
  const match = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(source);
  if (!match) return '';
  const bodyStart = source.indexOf('{', match.index);
  if (bodyStart < 0) return '';

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
      if (depth === 0) return source.slice(match.index, i + 1);
    }
  }
  return '';
}

const snapshotCheck = functionBlock(gati, 'isGatiDbTruthSnapshot');
const snapshotRead = functionBlock(gati, 'readGatiRowsFromPageSnapshot');
const recoveryRows = functionBlock(recovery, 'buildRecoveredGatiSnapshotRows');
const recoveryWrite = functionBlock(recovery, 'writeRecoveredGatiSnapshot');

check(gati.includes('GATI_OFFLINE_SNAPSHOT_V3:GATI'), 'GATI V3 marker missing');
check(recovery.includes('GATI_OFFLINE_SNAPSHOT_V3:RECOVERY'), 'Recovery V3 marker missing');
check(gati.includes("const GATI_DB_TRUTH_VERSION = 'gati-db-truth-2026-08-03-v3'"), 'GATI current snapshot version missing');
check(gati.includes("'gati-db-truth-2026-08-03-v1'"), 'GATI V1 compatibility missing');
check(gati.includes('GATI_DB_TRUTH_COMPAT_VERSIONS'), 'GATI compatibility set missing');

check(snapshotCheck.includes('meta?.sourceMode || meta?.source'), 'Legacy DB_ONLY source fallback missing');
check(snapshotCheck.includes('if (version) return GATI_DB_TRUTH_COMPAT_VERSIONS.has(version)'), 'Version compatibility validation missing');
check(snapshotCheck.includes('rows.every'), 'Legacy rows must be validated');
check(snapshotCheck.includes('isPersistedDbLikeId(id)'), 'Legacy rows must require persisted DB identity');
check(snapshotCheck.includes("status === 'gati'"), 'Legacy rows must remain scoped to GATI');
check(snapshotCheck.includes("['DB', 'ORDERS', 'ONLINE', 'PAGE_SNAPSHOT']"), 'Legacy rows must have a trusted source');

check(snapshotRead.includes("writePageSnapshot('gati', rawRows"), 'Legacy snapshot must be upgraded in place');
check(snapshotRead.includes('migratedFromVersion'), 'Snapshot migration provenance missing');
check(snapshotRead.includes("sourceMode: 'DB_ONLY'"), 'Migrated snapshot must remain DB_ONLY');
check(snapshotRead.includes('gatiDbTruthVersion: GATI_DB_TRUTH_VERSION'), 'Migrated snapshot must receive the current version');

check(recovery.includes("import { writePageSnapshot } from '@/lib/pageSnapshotCache'"), 'Recovery must be able to persist GATI snapshot');
check(recovery.includes('ready_at,picked_up_at,delivered_at'), 'Recovery DB scan lacks GATI lifecycle columns');
check(recoveryRows.includes("statusOf(row) === 'gati'"), 'Recovery snapshot must include current GATI DB rows only');
check(recoveryRows.includes("source: 'DB'"), 'Recovered rows must retain DB source identity');
check(recoveryRows.includes("status: 'gati'"), 'Recovered rows must retain GATI status');
check(recoveryRows.includes('fullOrder'), 'Recovered rows must retain full order data for offline actions');
check(recoveryWrite.includes("writePageSnapshot('gati', rows"), 'Recovery must write the GATI page snapshot');
check(recoveryWrite.includes("sourceMode: 'DB_ONLY'"), 'Recovery snapshot must be DB_ONLY');
check(recoveryWrite.includes('gatiDbTruthVersion: GATI_DB_TRUTH_VERSION'), 'Recovery snapshot version missing');
check(recovery.includes('const gatiSnapshot = writeRecoveredGatiSnapshot(dbRows, source);'), 'Recovery run does not build GATI snapshot');
check(recovery.includes('gatiSnapshotRows: Number(gatiSnapshot?.count || 0)'), 'Recovery result does not report GATI snapshot count');
check(!recovery.includes("clearPageSnapshot('gati')"), 'Recovery must not clear the GATI snapshot');

// Regression model for the exact field mismatch that caused the screenshot:
// the previous production snapshot used meta.source='DB_ONLY' without version.
function acceptsSnapshot(snapshot) {
  const meta = snapshot?.meta && typeof snapshot.meta === 'object' ? snapshot.meta : {};
  const sourceMode = String(meta?.sourceMode || meta?.source || '').trim().toUpperCase();
  if (sourceMode !== 'DB_ONLY') return false;
  const versions = new Set([
    'gati-db-truth-2026-08-03-v1',
    'gati-db-truth-2026-08-03-v2',
    'gati-db-truth-2026-08-03-v3',
  ]);
  const version = String(meta?.gatiDbTruthVersion || '').trim();
  if (version) return versions.has(version);
  const rows = Array.isArray(snapshot?.rows) ? snapshot.rows : [];
  return rows.every((row) => {
    const source = String(row?.source || '').trim().toUpperCase();
    const persisted = /^\d+$/.test(String(row?.id || '').trim()) || /^[0-9a-f-]{32,}$/i.test(String(row?.id || '').trim());
    return persisted && String(row?.status || '').toLowerCase() === 'gati' && (!source || ['DB', 'ORDERS', 'ONLINE', 'PAGE_SNAPSHOT'].includes(source));
  });
}

const legacyValid = {
  meta: { source: 'DB_ONLY' },
  rows: [{ id: '2548', status: 'gati', source: 'DB' }],
};
const staleLocal = {
  meta: { source: 'LOCAL' },
  rows: [{ id: '2548', status: 'gati', source: 'LOCAL' }],
};
const wrongStatus = {
  meta: { source: 'DB_ONLY' },
  rows: [{ id: '2548', status: 'dorzim', source: 'DB' }],
};
check(acceptsSnapshot(legacyValid), 'Legacy unversioned DB_ONLY snapshot regression failed');
check(!acceptsSnapshot(staleLocal), 'LOCAL snapshot must remain rejected');
check(!acceptsSnapshot(wrongStatus), 'Non-GATI legacy rows must remain rejected');

if (failures.length) {
  console.error(`FAIL: ${failures.length} GATI offline snapshot V3 check(s) failed.`);
  failures.forEach((message, index) => console.error(`${index + 1}. ${message}`));
  process.exit(1);
}

console.log('PASS: 31 GATI offline snapshot V3 checks passed.');
