import fs from 'node:fs';

const failures = [];
const check = (condition, message) => { if (!condition) failures.push(message); };
const read = (path) => fs.readFileSync(path, 'utf8');

const dispatch = read('app/dispatch/page.jsx');
const transportDb = read('lib/transport/transportDb.js');
const server = read('lib/transport/dispatchOrderServer.js');
const v2Installer = read('tools/apply-dispatch-phone-check-resilience-v2.mjs');
const vite = read('vite.config.js');
const pkg = JSON.parse(read('package.json'));

const marker = 'DISPATCH_CREATE_NETWORK_RESILIENCE_V3';
const installer = 'node tools/apply-dispatch-create-network-resilience-v3.mjs';
const testCommand = 'npm run test:dispatch-create-network-resilience-v3';

const sendStart = dispatch.indexOf('async function send()');
const sendEnd = dispatch.indexOf('\n\n  function openRow', sendStart);
const sendBlock = sendStart >= 0 && sendEnd > sendStart ? dispatch.slice(sendStart, sendEnd) : '';
const createGateStart = dispatch.indexOf('const canCreateNewDispatchOrder');
const createGateEnd = dispatch.indexOf(';', createGateStart);
const createGate = createGateStart >= 0 && createGateEnd > createGateStart ? dispatch.slice(createGateStart, createGateEnd + 1) : '';
const prebuildParts = String(pkg.scripts?.prebuild || '').split('&&').map((part) => part.trim()).filter(Boolean);
const buildParts = String(pkg.scripts?.build || '').split('&&').map((part) => part.trim()).filter(Boolean);

check(dispatch.includes(marker), 'V3 marker missing from Dispatch source');
check(createGate.includes('canSend'), 'create gate lost form validation');
check(createGate.includes('existingClientConfirmed'), 'create gate lost explicit known-client confirmation');
check(createGate.includes('!activePhoneOrder'), 'create gate lost known active-order guard');
check(!createGate.includes('phoneCheckReady'), 'advisory PHONE_CHECK still hard-disables create');
check(!sendBlock.includes('if (!phoneCheckReady)'), 'send still hard-blocks on PHONE_CHECK completion');
check(!sendBlock.includes('inspectDispatchTransportPhoneViaApi(cleanPhone'), 'send still repeats PHONE_CHECK before CREATE');
check(sendBlock.includes('const exactPhoneClient = phoneHit && dispatchSamePhone'), 'submit does not reuse exact cached CRM evidence');
check(sendBlock.includes('const verifiedPhoneClient = exactPhoneClient || null;'), 'submit can still trigger a browser-side final client lookup');
check(sendBlock.includes('const createResult = await insertTransportOrder'), 'atomic CREATE path missing');
check(sendBlock.includes('const deduplicatedActive = createResult?.deduplicatedActive === true;'), 'server active-order dedupe handling missing');
check(dispatch.includes('SERVERI E VERIFIKON NË RUAJTJE'), 'advisory phone-check message does not explain server verification');
check(!dispatch.includes('phoneBusy ? "DUKE KONTROLLU TELEFONIN…"'), 'button still visually locks while advisory lookup is running');

check(transportDb.includes("fetch('/api/transport/order'"), 'Dispatch CREATE API call missing');
check(transportDb.includes('reconcileAtomicDispatchOrder(expected)'), 'ambiguous CREATE response reconciliation missing');
check(transportDb.includes("'DISPATCH_ORDER_API_TIMEOUT'"), 'CREATE timeout classification missing');
check(transportDb.includes("'DISPATCH_ORDER_API_NETWORK_FAILED'"), 'CREATE network classification missing');
check(server.includes("supabase.rpc('create_transport_order'"), 'server no longer uses atomic create_transport_order RPC');
check(server.includes('deduplicatedActive: true'), 'server duplicate-active recovery missing');

check(v2Installer.includes(`source.includes('${marker}')`), 'V2 prebuild installer can overwrite V3 source');
check(vite.includes('dispatch-phone-check-resilience-v2-dispatch-create-network-resilience-v3'), 'installed-PWA cache identity was not bumped');
check(vite.includes('sw-navigation-diag.js?v=3515'), 'service-worker navigation generation was not bumped');
check(String(pkg.version || '').includes('dispatch-create-network-resilience-v3'), 'package release identity missing V3 tag');
check(prebuildParts.at(-1) === installer, 'V3 installer must be the final prebuild owner');
check(String(pkg.scripts?.['test:dispatch-create-network-resilience-v3'] || '').includes('verify-dispatch-create-network-resilience-v3.mjs'), 'V3 test script missing');
check(buildParts.includes(testCommand), 'V3 verifier missing from build');

if (failures.length) {
  console.error(`FAIL Dispatch create network resilience V3: ${failures.length} check(s)`);
  failures.forEach((failure, index) => console.error(`${index + 1}. ${failure}`));
  process.exit(1);
}

console.log('PASS Dispatch create network resilience V3: PHONE_CHECK is advisory, submit goes straight to idempotent atomic CREATE, dedupe/reconcile remain authoritative, and installed PWA cache identity is refreshed.');
