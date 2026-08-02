import fs from 'node:fs';

const GATI = 'app/gati/page.jsx';
const PASTRIMI = 'app/pastrimi/page.jsx';
const MARKER = 'AUTHORITATIVE_OFFLINE_LISTS_V1';

function replaceOnce(source, from, to, label) {
  if (!source.includes(from)) throw new Error(`${label}_ANCHOR_NOT_FOUND`);
  return source.replace(from, to);
}

function patchGati() {
  let source = fs.readFileSync(GATI, 'utf8');
  if (source.includes(`${MARKER}:GATI`)) return false;

  const oldBlock = `async function buildImmediateGatiLocalRows() {
  const pageSnapshotRows = readGatiRowsFromPageSnapshot();
  const masterCacheRows = readGatiRowsFromBaseMasterCache();
  const local = await getAllOrdersLocal().catch(() => []);
  const localRows = (Array.isArray(local) ? local : [])
    .filter((o) => isGatiRowLike(o))
    .map(mapLocalOrderToGatiRow);
  return dedupeGatiSnapshotRows([
    ...(Array.isArray(pageSnapshotRows) ? pageSnapshotRows : []),
    ...(Array.isArray(masterCacheRows) ? masterCacheRows : []),
    ...localRows,
  ]);
}`;

  const newBlock = `async function buildImmediateGatiLocalRows() {
  // ${MARKER}:GATI
  // The last DB-verified page snapshot is the offline source of truth.
  // IndexedDB/master cache may contain historical status copies, so only
  // genuinely pending local/outbox rows may be layered on top of it.
  const pageSnapshotRows = readGatiRowsFromPageSnapshot();
  const local = await getAllOrdersLocal().catch(() => []);
  const pendingLocalRows = (Array.isArray(local) ? local : [])
    .filter((o) => isGatiRowLike(o))
    .map(mapLocalOrderToGatiRow)
    .filter((row) => rowLooksPendingOrLocalGati(row));

  if (Array.isArray(pageSnapshotRows) && pageSnapshotRows.length > 0) {
    return dedupeGatiSnapshotRows([
      ...pageSnapshotRows,
      ...pendingLocalRows,
    ]);
  }

  const masterCacheRows = readGatiRowsFromBaseMasterCache();
  return dedupeGatiSnapshotRows([
    ...(Array.isArray(masterCacheRows) ? masterCacheRows : []),
    ...pendingLocalRows,
  ]);
}`;

  source = replaceOnce(source, oldBlock, newBlock, 'GATI_IMMEDIATE_LOCAL_ROWS');
  fs.writeFileSync(GATI, source, 'utf8');
  return true;
}

function patchPastrimi() {
  let source = fs.readFileSync(PASTRIMI, 'utf8');
  if (source.includes(`${MARKER}:PASTRIMI`)) return false;

  const oldBlock = `function readPastrimRowsFromBaseMasterCache(cache = null) {
  try {
    return [
      ...(getBaseRowsByStatus('pastrim', cache) || []),
      ...(getBaseRowsByStatus('pastrimi', cache) || []),
    ].map(mapBaseCacheRowToPastrim);
  } catch {
    return [];
  }
}`;

  const newBlock = `function readPastrimRowsFromBaseMasterCache(cache = null) {
  try {
    // ${MARKER}:PASTRIMI
    // Once a DB-only snapshot exists, never merge historical master-cache
    // status copies into the visible list. The snapshot remains stable during
    // connectivity changes and the normal outbox path adds pending work.
    const verifiedSnapshot = readPageSnapshot('pastrimi');
    if (isPastrimiDbTruthSnapshot(verifiedSnapshot) && Array.isArray(verifiedSnapshot?.rows)) {
      return [];
    }
    return [
      ...(getBaseRowsByStatus('pastrim', cache) || []),
      ...(getBaseRowsByStatus('pastrimi', cache) || []),
    ].map(mapBaseCacheRowToPastrim);
  } catch {
    return [];
  }
}`;

  source = replaceOnce(source, oldBlock, newBlock, 'PASTRIMI_MASTER_CACHE_ROWS');
  fs.writeFileSync(PASTRIMI, source, 'utf8');
  return true;
}

const changed = [patchGati(), patchPastrimi()].some(Boolean);
console.log(`[authoritative-offline-lists-v1] ${changed ? 'installed' : 'already installed'}`);
