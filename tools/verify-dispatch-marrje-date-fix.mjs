import fs from 'node:fs';

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

const marrje = fs.readFileSync('app/marrje-sot/page.jsx', 'utf8');
const acceptSql = fs.readFileSync('sql/accept_cash_handoff_atomic.sql', 'utf8');

if (/updated_at\.gte/.test(marrje)) {
  fail('marrje-sot still queries updated_at as a date filter');
}

const pickEventMatch = marrje.match(/function pickEventTs[\s\S]*?function hasPickupEventStamp/);
if (!pickEventMatch) fail('pickEventTs block not found');
const pickEventBlock = pickEventMatch[0];
if (/row\?\.updated_at|data\?\.updated_at|Date\.now\(\)/.test(pickEventBlock)) {
  fail('pickEventTs still falls back to updated_at/Date.now');
}

if (!/company_ledger_entry_id/.test(acceptSql)) {
  fail('accept_cash_handoff_atomic does not write company_ledger_entry_id');
}
if (!/ledger_id/.test(acceptSql) || !/alreadyAccepted/.test(acceptSql)) {
  fail('accept_cash_handoff_atomic idempotent ledger repair missing');
}

console.log('OK dispatch date + handoff ledger verification passed');
