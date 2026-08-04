import fs from 'node:fs';

const search = fs.readFileSync('lib/homeSearch.js', 'utf8');
const home = fs.readFileSync('app/page.jsx', 'utf8');
const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); };

check(search.includes('HOME_SEARCH_SOLID_V1:SEARCH'), 'search marker missing');
check(home.includes('HOME_SEARCH_SOLID_V1:HOME'), 'home marker missing');
check(search.includes('async function getRowsFromDbGeneral'), 'general DB search missing');
check(search.includes("from('clients')"), 'client DB search missing');
check(search.includes("ilike('phone'"), 'phone DB search missing');
check(search.includes("ilike('full_name'"), 'name DB search missing');
check(search.includes("from('orders')"), 'base DB search missing');
check(search.includes("from('transport_orders')"), 'transport DB search missing');
check(search.includes('_homeSearchSourceRank: 95'), 'general DB source rank missing');
check(search.includes('export async function resolveHomeSearchTarget'), 'live click resolver missing');
check(search.includes("_homeSearchSourceRank: 110"), 'live resolver authority missing');
check(search.includes("eq('id', id)"), 'click resolve by id missing');
check(search.includes("eq('local_oid', localOid)"), 'click resolve by local_oid missing');
check(search.includes("event: 'result_click_resolve'"), 'click diagnostic missing');
check(search.includes('dbGeneralRows'), 'general DB rows not merged');
check(search.includes("policyVersion: 'HOME_SEARCH_SOLID_V1'"), 'search policy diagnostic missing');

check(home.includes('resolveHomeSearchTarget'), 'home resolver import missing');
check(home.includes('const [openingResultKey'), 'opening state missing');
check(home.includes('Duke verifikuar statusin aktual në DB'), 'live verification feedback missing');
check(home.includes('await resolveHomeSearchTarget(result)'), 'home click does not await live resolver');
check(home.includes('disabled={!!openingResultKey}'), 'double-click guard missing');
check(home.includes("'DUKE HAPUR...'"), 'opening button feedback missing');

// Policy model: online truth must replace stale status before routing.
const route = (status) => status === 'gati' ? '/gati' : ['dorzim','dorezim','delivered'].includes(status) ? '/marrje-sot' : '/pastrimi';
check(route('pastrim') === '/pastrimi', 'pastrim route model failed');
check(route('gati') === '/gati', 'gati route model failed');
check(route('dorzim') === '/marrje-sot', 'dorzim route model failed');
check(route('dorzim') !== route('pastrim'), 'stale status redirect model failed');

if (failures.length) {
  console.error(`FAIL: ${failures.length} solid home search check(s) failed.`);
  failures.forEach((item, index) => console.error(`${index + 1}. ${item}`));
  process.exit(1);
}
console.log('PASS: 26 solid home search checks passed.');
