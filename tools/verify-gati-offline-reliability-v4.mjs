import fs from 'node:fs';

const gati = fs.readFileSync('app/gati/page.jsx', 'utf8');
const sync = fs.readFileSync('lib/syncEngine.js', 'utf8');
const recovery = fs.readFileSync('lib/onlineDbTruthRecovery.js', 'utf8');
const durable = fs.readFileSync('lib/gatiDurableSnapshot.js', 'utf8');
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
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(match.index, i + 1);
    }
  }
  return '';
}

const persist = functionBlock(gati, 'persistGatiPageSnapshot');
const durableRead = functionBlock(gati, 'readGatiRowsFromDurableSnapshot');
const immediate = functionBlock(gati, 'buildImmediateGatiLocalRows');
const openPay = functionBlock(gati, 'openPay');
const confirm = functionBlock(gati, 'confirmDelivery');
const processOp = functionBlock(sync, 'processOp');
const validate = functionBlock(sync, 'validateOpShape');
const recoveryWrite = functionBlock(recovery, 'writeRecoveredGatiSnapshot');
const recoveryRun = functionBlock(recovery, 'reconcileOnlineDbTruth');

check(gati.includes('GATI_OFFLINE_RELIABILITY_V4:GATI'), 'GATI V4 marker missing');
check(sync.includes('GATI_OFFLINE_RELIABILITY_V4:SYNC'), 'Sync V4 marker missing');
check(recovery.includes('GATI_OFFLINE_RELIABILITY_V4:RECOVERY'), 'Recovery V4 marker missing');
check(gati.includes("from '@/lib/gatiDurableSnapshot'"), 'GATI durable import missing');
check(recovery.includes("from '@/lib/gatiDurableSnapshot'"), 'Recovery durable import missing');

check(durable.includes("GATI_DURABLE_SNAPSHOT_KEY = 'gati_offline_snapshot_v4'"), 'Durable key missing');
check(durable.includes("putValue('meta', record)"), 'Durable IndexedDB write missing');
check(durable.includes("getByKey('meta', GATI_DURABLE_SNAPSHOT_KEY)"), 'Durable IndexedDB read missing');
check(durable.includes('GATI_DURABLE_SNAPSHOT_VERIFY_FAILED'), 'Durable write verification missing');
check(durable.includes("status !== 'gati'"), 'Durable status validation missing');
check(durable.includes('isBaseDbId(id)'), 'Durable DB identity validation missing');
check(durable.includes('SIGNATURE_MISMATCH'), 'Durable signature validation missing');
check(durable.includes('PRESERVED_NON_EMPTY'), 'Durable non-empty preservation missing');

check(durableRead.includes('await readDurableGatiSnapshot()'), 'GATI durable read not awaited');
check(durableRead.includes('_durableSnapshot: true'), 'GATI durable row marker missing');
check(immediate.includes('readGatiRowsFromPageSnapshot()'), 'Immediate list lacks localStorage snapshot');
check(immediate.includes('await readGatiRowsFromDurableSnapshot()'), 'Immediate list lacks IndexedDB snapshot');
check(immediate.includes('isStrongPendingOfflineRow'), 'Immediate list must include only strong pending rows');
check(immediate.includes('selectAuthoritativeOfflineRows'), 'Immediate authoritative selection missing');

check(persist.startsWith('async function persistGatiPageSnapshot'), 'GATI persist must be async');
check(persist.includes("sourceMode !== 'DB_ONLY'"), 'GATI persist DB-only guard missing');
check(persist.includes('!cleanRows.length && !allowEmptyDbTruth'), 'GATI empty overwrite guard missing');
check(persist.includes("writePageSnapshot('gati', cleanRows"), 'GATI localStorage write missing');
check(persist.includes('await writeDurableGatiSnapshot(cleanRows'), 'GATI IndexedDB write missing');
check(gati.includes('await persistGatiPageSnapshot(baseOnly'), 'Online GATI must await durable persistence');
check(gati.includes('const durablePageSnapshotRows = await readGatiRowsFromDurableSnapshot()'), 'Offline startup durable hydration missing');

check(openPay.includes('row?.fullOrder'), 'Offline payment must open from visible snapshot row');
check(openPay.includes('await getAllOrdersLocal()'), 'Offline payment IndexedDB order fallback missing');
check(openPay.includes("navigator.onLine !== false"), 'Offline payment DB fetch guard missing');
check(openPay.includes("order.status = 'gati'"), 'Offline payment normalized status missing');

check(confirm.includes("queueOp('gati_payment_delivery'"), 'Combined offline payment-delivery op missing');
check(confirm.includes('buildFastPaymentTransaction'), 'Combined op ARKA transaction payload missing');
check(confirm.includes("delivery_sync_state: 'OUTBOX_PENDING'"), 'Delivery pending state missing');
check(confirm.includes("showFastPayNotice('U ruajt."), 'Quiet queued confirmation missing');
check(validate.includes("type === 'gati_payment_delivery'"), 'Combined op validation missing');
check(validate.includes('MISSING_DELIVERY_PATCH'), 'Combined op delivery patch validation missing');
check(processOp.includes("if (type === 'gati_payment_delivery')"), 'Combined op sync handler missing');
check(processOp.includes('await postArkaTransaction'), 'Combined op must post ARKA first');
check(processOp.includes('GATI_OFFLINE_ARKA_VERIFY_FAILED'), 'Combined op ARKA verification missing');
check(processOp.includes('await updateByIdOrLocalOid'), 'Combined op delivery update missing');
check(processOp.indexOf("if (type === 'gati_payment_delivery')") < processOp.indexOf("if (type === 'arka_transaction')"), 'Combined op handler must precede generic ARKA handler');

check(recoveryWrite.startsWith('async function writeRecoveredGatiSnapshot'), 'Recovery durable writer must be async');
check(recoveryWrite.includes("writePageSnapshot('gati', rows"), 'Recovery localStorage snapshot missing');
check(recoveryWrite.includes('await writeDurableGatiSnapshot(rows, meta)'), 'Recovery IndexedDB snapshot missing');
check(recoveryWrite.includes('allowEmptyDbTruth: true'), 'Recovery explicit empty truth marker missing');
check(recoveryRun.includes('await writeRecoveredGatiSnapshot(dbRows, source)'), 'Recovery durable snapshot not awaited');

// Runtime policy model: a valid DB list must survive when localStorage is unavailable.
const sampleRows = [
  { id: '1001', status: 'gati', code: '54', m2: 10.5, readyTs: 10, fullOrder: { id: '1001', status: 'gati', code: '54' } },
  { id: '1002', status: 'gati', code: '55', m2: 9.5, readyTs: 20, fullOrder: { id: '1002', status: 'gati', code: '55' } },
];
const staleRows = [
  { id: '1003', status: 'dorzim', code: '56' },
  { id: 'bad-local-id', status: 'gati', code: '57' },
  { id: '1004', status: 'gati', code: 'T700' },
];
const normalizeModel = (rows) => rows.filter((row) => /^\d+$/.test(String(row.id || '')) && String(row.status || '').toLowerCase() === 'gati' && !/^T\d+$/i.test(String(row.code || '')));
check(normalizeModel(sampleRows).length === 2, 'Durable policy lost valid DB rows');
check(normalizeModel(staleRows).length === 0, 'Durable policy accepted stale/local/transport rows');
check(sampleRows.reduce((sum, row) => sum + Number(row.m2 || 0), 0) === 20, 'Durable total model failed');

if (failures.length) {
  console.error(`FAIL: ${failures.length} GATI offline reliability V4 check(s) failed.`);
  failures.forEach((message, index) => console.error(`${index + 1}. ${message}`));
  process.exit(1);
}

console.log('PASS: 50 GATI offline reliability V4 checks passed.');
