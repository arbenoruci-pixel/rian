import fs from 'node:fs';

const gati = fs.readFileSync('app/gati/page.jsx', 'utf8');
const pastrimi = fs.readFileSync('app/pastrimi/page.jsx', 'utf8');
const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); };

check(gati.includes('AUTHORITATIVE_OFFLINE_LISTS_V1:GATI'), 'GATI marker missing');
check(gati.includes('if (Array.isArray(pageSnapshotRows) && pageSnapshotRows.length > 0)'), 'GATI must prefer verified snapshot');
check(gati.includes('.filter((row) => rowLooksPendingOrLocalGati(row))'), 'GATI must add only pending local/outbox rows');

const gatiStart = gati.indexOf('async function buildImmediateGatiLocalRows()');
const gatiEnd = gati.indexOf('// ---------------- HELPERS ----------------', gatiStart);
const gatiBlock = gati.slice(gatiStart, gatiEnd);
const snapshotBranchStart = gatiBlock.indexOf('if (Array.isArray(pageSnapshotRows)');
const snapshotBranchEnd = gatiBlock.indexOf('const masterCacheRows', snapshotBranchStart);
const snapshotBranch = gatiBlock.slice(snapshotBranchStart, snapshotBranchEnd);
check(!snapshotBranch.includes('masterCacheRows'), 'GATI verified snapshot branch must not merge master cache');
check(snapshotBranch.includes('pendingLocalRows'), 'GATI verified snapshot branch must preserve pending work');

check(pastrimi.includes('AUTHORITATIVE_OFFLINE_LISTS_V1:PASTRIMI'), 'PASTRIMI marker missing');
check(pastrimi.includes("const verifiedSnapshot = readPageSnapshot('pastrimi')"), 'PASTRIMI must inspect DB-truth snapshot');
check(pastrimi.includes('if (isPastrimiDbTruthSnapshot(verifiedSnapshot)'), 'PASTRIMI must recognize DB-only snapshot');
check(pastrimi.includes('return [];'), 'PASTRIMI must suppress historical master-cache rows when snapshot exists');

if (failures.length) {
  console.error(`FAIL: ${failures.length} authoritative offline list check(s) failed.`);
  failures.forEach((message, index) => console.error(`${index + 1}. ${message}`));
  process.exit(1);
}

console.log('PASS: 9 authoritative offline list checks passed.');
