import fs from 'node:fs';
import {
  isStrongPendingOfflineRow,
  selectAuthoritativeOfflineRows,
} from '../lib/authoritativeOfflineListPolicy.js';

const gati = fs.readFileSync('app/gati/page.jsx', 'utf8');
const pastrimi = fs.readFileSync('app/pastrimi/page.jsx', 'utf8');
const recovery = fs.readFileSync('lib/onlineDbTruthRecovery.js', 'utf8');
const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); };

function scanMatchingDelimiter(source, start, openChar, closeChar) {
  if (source[start] !== openChar) return -1;
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
  return -1;
}

function functionBlock(source, name) {
  const match = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(source);
  if (!match) return '';
  const paramsStart = source.indexOf('(', match.index);
  if (paramsStart < 0) return '';
  const paramsEnd = scanMatchingDelimiter(source, paramsStart, '(', ')');
  if (paramsEnd < 0) return '';
  let bodyStart = paramsEnd + 1;
  while (bodyStart < source.length && /\s/.test(source[bodyStart])) bodyStart += 1;
  if (source[bodyStart] !== '{') return '';
  const bodyEnd = scanMatchingDelimiter(source, bodyStart, '{', '}');
  if (bodyEnd < 0) return '';
  return source.slice(match.index, bodyEnd + 1);
}

// Runtime policy simulation: 291 historical Tapin rows must never be layered
// onto a 51-order DB snapshot. Only two explicitly pending rows may be added.
const snapshot = Array.from({ length: 51 }, (_, index) => ({
  id: String(index + 1),
  source: 'DB',
  status: 'pastrim',
}));
const staleTransport = Array.from({ length: 291 }, (_, index) => ({
  id: `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
  source: 'LOCAL',
  status: 'pastrim',
  _synced: true,
  _local: false,
  _syncPending: false,
  pending_ops: 0,
}));
const pending = [
  { id: 'local_new_1', local_oid: 'local_new_1', source: 'OUTBOX', _synced: false },
  { id: 'local_new_2', local_oid: 'local_new_2', source: 'LOCAL', _syncPending: true },
];

check(staleTransport.every((row) => !isStrongPendingOfflineRow(row)), 'Synced historical transport mirrors must not qualify as pending');
check(pending.every((row) => isStrongPendingOfflineRow(row)), 'Real outbox/pending rows must qualify');
const selected = selectAuthoritativeOfflineRows({ snapshotRows: snapshot, pendingRows: [...staleTransport, ...pending] });
check(selected.length === 53, `Expected 51 snapshot + 2 pending rows, got ${selected.length}`);
check(!selected.some((row) => staleTransport.includes(row)), 'Historical transport rows leaked into authoritative selection');

check(gati.includes('AUTHORITATIVE_OFFLINE_LISTS_V2:GATI'), 'GATI V2 marker missing');
check(pastrimi.includes('AUTHORITATIVE_OFFLINE_LISTS_V2:PASTRIMI'), 'PASTRIMI V2 marker missing');
check(recovery.includes('AUTHORITATIVE_OFFLINE_LISTS_V2:RECOVERY'), 'Recovery V2 marker missing');

const gatiImmediate = functionBlock(gati, 'buildImmediateGatiLocalRows');
check(gatiImmediate.length > 200, 'GATI immediate selector function could not be parsed');
check(gatiImmediate.includes('selectAuthoritativeOfflineRows'), 'GATI immediate selector must use the shared authority policy');
check(gatiImmediate.includes('isStrongPendingOfflineRow'), 'GATI immediate selector must require strong pending evidence');
check(!gatiImmediate.includes('readGatiRowsFromBaseMasterCache'), 'GATI immediate offline selector must not read master cache');

const gatiPending = functionBlock(gati, 'rowLooksPendingOrLocalGati');
check(gatiPending.includes('isStrongPendingOfflineRow'), 'GATI pending predicate must use strict policy');
check(!gatiPending.includes("source === 'LOCAL'"), 'GATI source LOCAL alone must not qualify as pending');

const gatiPersist = functionBlock(gati, 'persistGatiPageSnapshot');
check(gatiPersist.length > 300, 'GATI snapshot writer function could not be parsed');
check(gatiPersist.includes("sourceMode !== 'DB_ONLY'"), 'GATI must reject non-DB snapshot writes');
check(gatiPersist.includes('gatiDbTruthVersion'), 'GATI DB snapshot must be versioned');
check(!gatiPersist.includes("clearPageSnapshot('gati')"), 'GATI empty/offline path must not destroy the verified snapshot');

const gatiMaster = functionBlock(gati, 'readGatiRowsFromBaseMasterCache');
check(gatiMaster.includes('if (offline || isGatiDbTruthSnapshot'), 'GATI master cache must be blocked offline and when DB snapshot exists');
check(gati.includes('const transitionPendingRows = ['), 'GATI offline transition must isolate pending rows');
check(gati.includes('.filter((row) => rowLooksPendingOrLocalGati(row));'), 'GATI transition/error rows must pass strict pending predicate');
check(gati.includes('const authoritativeErrorRows = await buildImmediateGatiLocalRows()'), 'GATI network-error path must rebuild from authoritative snapshot');
check(!gati.includes("persistGatiPageSnapshot(visibleOfflineRows, { source: 'offline_snapshot'" ) || gatiPersist.includes("sourceMode !== 'DB_ONLY'"), 'GATI offline composite must never overwrite DB truth');

const pastrimImmediate = functionBlock(pastrimi, 'buildImmediatePastrimLocalRows');
check(pastrimImmediate.length > 200, 'PASTRIMI immediate selector function could not be parsed');
check(pastrimImmediate.includes('selectAuthoritativeOfflineRows'), 'PASTRIMI immediate selector must use authority policy');
check(!pastrimImmediate.includes('readPastrimRowsFromBaseMasterCache'), 'PASTRIMI immediate selector must not read master cache');
check(!pastrimImmediate.includes('readLocalOrdersByStatus'), 'PASTRIMI immediate selector must not read the local archive');

const pastrimFallback = functionBlock(pastrimi, 'buildPastrimFallbackRows');
check(pastrimFallback.length > 300, 'PASTRIMI fallback function could not be parsed');
check(pastrimFallback.includes('selectAuthoritativeOfflineRows'), 'PASTRIMI fallback must use authority policy');
check(pastrimFallback.includes('buildPendingOutboxPastrimRows'), 'PASTRIMI fallback must preserve real pending work');
check(!pastrimFallback.includes('readLocalOrdersByStatus'), 'PASTRIMI fallback must never merge historical IndexedDB rows');
check(!pastrimFallback.includes('getAllOrdersLocal'), 'PASTRIMI fallback must not scan the full local archive');
check(!pastrimFallback.includes('readPastrimRowsFromBaseMasterCache'), 'PASTRIMI fallback must not merge master cache');

const pastrimPersist = functionBlock(pastrimi, 'persistPastrimPageSnapshot');
check(pastrimPersist.length > 300, 'PASTRIMI snapshot writer function could not be parsed');
check(pastrimPersist.includes("sourceMode !== 'DB_ONLY'"), 'PASTRIMI must reject offline/fallback snapshot writes');
check(pastrimPersist.includes('pastrimiDbTruthVersion'), 'PASTRIMI DB snapshot must remain versioned');
check(!pastrimPersist.includes("clearPageSnapshot('pastrimi')"), 'PASTRIMI empty/offline path must not destroy the verified snapshot');

const pastrimMaster = functionBlock(pastrimi, 'readPastrimRowsFromBaseMasterCache');
check(pastrimMaster.includes('if (offline || isPastrimiDbTruthSnapshot'), 'PASTRIMI master cache must be blocked offline and when DB snapshot exists');
check(!pastrimi.includes("readLocalOrdersByStatus('pastrim')"), 'No visible path may request the full local pastrim archive');
check(pastrimi.includes("readPendingLocalOrdersByStatus('pastrim')"), 'Remaining compatibility paths must use pending-only local rows');

check(!recovery.includes("try { clearPageSnapshot('pastrimi'); } catch {}"), 'Online recovery must preserve PASTRIMI snapshot');
check(!recovery.includes("try { clearPageSnapshot('gati'); } catch {}"), 'Online recovery must preserve GATI snapshot');
check(recovery.includes("preserved: ['pastrimi', 'gati']"), 'Recovery must record snapshot preservation');

if (failures.length) {
  console.error(`FAIL: ${failures.length} authoritative offline V2 check(s) failed.`);
  failures.forEach((message, index) => console.error(`${index + 1}. ${message}`));
  process.exit(1);
}

console.log('PASS: 36 authoritative offline V2 checks passed.');
