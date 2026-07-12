import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const checks = [];
const check = (condition, message) => {
  checks.push({ condition: Boolean(condition), message });
  if (!condition) console.error(`FAIL: ${message}`);
};

const codes = read('lib/transportCodes.js');
const sms = read('lib/smartSms.js');
const selfEntry = read('app/transport/pranimi/page.jsx');
const dispatch = read('app/dispatch/page.jsx');
const transportDb = read('lib/transport/transportDb.js');
const sanitize = read('lib/transport/sanitize.js');
const ordersService = read('lib/ordersService.js');

check(/const DEFAULT_POOL_SIZE = 1;/.test(codes), 'Transport allocator mirror size is exactly 1');
check(/transport_pool_mirror_v3_single_smallest_/.test(codes), 'Old multi-code mirror is invalidated');
check(!codes.includes('Background refill when mirror gets low'), 'No background pool refill after allocation');
check(codes.includes("release_transport_code_if_unused"), 'Unused reserved T-code calls guarded DB release RPC');
check(codes.includes("data->>legacy_order_code"), 'Allocator protects historical order aliases');

const reserveCallsSelf = (selfEntry.match(/getOrReserveTransportCode\(/g) || []).length;
check(reserveCallsSelf === 2, 'Self Entry reserves only in helper + final new-client save');
check(selfEntry.includes('officialOrderTcode = clientBookTcode;'), 'Existing Self Entry client reuses permanent T-code');
check(selfEntry.includes('TRANSPORT_CLIENT_PHONE_LOOKUP_FAILED'), 'Self Entry lookup failure blocks save');
check(selfEntry.includes('id: oid') && selfEntry.includes('public_order_id: oid'), 'Self Entry Smart SMS carries exact order UUID');
check(selfEntry.includes('releaseTransportCodeIfUnused(reservedNewTcode, tid)'), 'Failed new-client save releases unused code');

const reserveCallsDispatch = (dispatch.match(/reserveTransportCode\(/g) || []).length;
check(reserveCallsDispatch === 1, 'Dispatch reserves only once in genuinely new-client path');
check(!dispatch.includes('markTransportCodeUsed('), 'Dispatch does not separately burn codes');
check(!dispatch.includes('reservedPlanCode'), 'Dispatch assignment never reserves a new T-code');
check(dispatch.includes('const officialOrderCode = normTCode(clientLink.tcode);'), 'Dispatch order uses permanent client T-code');

check(sms.includes('getExactOrderId(order)'), 'Smart SMS resolves exact order ID');
check(sms.includes('?src=transport') && sms.includes('Legacy fallback'), 'Smart SMS uses UUID with legacy T-code fallback');
check(transportDb.includes("supabase.rpc('create_transport_order'"), 'Self Entry uses atomic client+order DB RPC');
check(transportDb.includes('TRANSPORT_CLIENT_PHONE_LOOKUP_FAILED'), 'Shared Transport lookup fails closed');
check(sanitize.includes('client_tcode is the permanent Transport client identity'), 'Sanitizer preserves permanent client identity');
check(ordersService.includes("data->>legacy_order_code"), 'Old SMS T-code links can resolve legacy order aliases');

const failed = checks.filter((item) => !item.condition);
if (failed.length) {
  console.error(`\n${failed.length}/${checks.length} checks failed.`);
  process.exit(1);
}
console.log(`PASS: ${checks.length} Transport permanent T-code checks.`);
