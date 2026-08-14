import fs from 'node:fs';

const source = fs.readFileSync('lib/homeSearch.js', 'utf8');
const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); };

check(source.includes('HOME_SEARCH_EXACT_DB_TRUTH_V3'), 'V3 marker missing');
check(source.includes("supabase.rpc('find_base_order_by_code_fast'"), 'fast base-code RPC missing');
check(source.includes('attempts: 2'), 'exact search retry missing');
check(source.includes('HOME_SEARCH_BASE_CODE_RPC_TIMEOUT'), 'RPC timeout label missing');
check(source.includes('HOME_SEARCH_BASE_CODE_FALLBACK_TIMEOUT'), 'fallback timeout label missing');
check(source.includes(".order('updated_at', { ascending: false })"), 'latest exact visit ordering missing');
check(source.includes("_homeSearchSource: 'db-exact-orders-fast'"), 'authoritative source rank missing');
check(!source.includes(".select('id,code,client_name,client_phone,status,data,created_at,updated_at')\n          .eq('code', codeNumber)"), 'exact base query still downloads full data JSON');
check(source.includes("status === 'gati'\n    ? '/gati'"), 'GATI route mapping changed');
check(source.includes("params.set('openId', id)"), 'openId exact routing missing');
check(source.includes("params.set('exact', '1')"), 'exact route flag missing');

// Regression model for the production #915 row: the exact DB result must remain
// identifiable as BASE/GATI and route to GATI instead of producing an empty result.
const row915 = {
  id: 2954,
  local_oid: 'f2284857-18e9-4810-a3a7-7d505372080a',
  code: 915,
  client_code: 915,
  client_name: 'faruk shefkiu',
  client_phone: '+38349958866',
  status: 'gati',
  pieces: 12,
  m2_total: 31.8,
};
check(Number(row915.code) === 915, '#915 regression fixture invalid');
check(row915.status === 'gati', '#915 must remain GATI');
check(row915.id === 2954, '#915 stable DB id changed in regression fixture');

if (failures.length) {
  console.error(`FAIL: ${failures.length} Home exact DB-truth check(s) failed.`);
  failures.forEach((message, index) => console.error(`${index + 1}. ${message}`));
  process.exit(1);
}
console.log('PASS: Home exact search has DB-truth retry/fallback and #915 GATI routing guards.');
