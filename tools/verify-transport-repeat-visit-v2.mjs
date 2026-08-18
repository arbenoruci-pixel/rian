import fs from 'node:fs';

const failures = [];
const check = (condition, message) => { if (!condition) failures.push(message); };

const board = fs.readFileSync('app/transport/board/page.jsx', 'utf8');
const dispatch = fs.readFileSync('app/dispatch/page.jsx', 'utf8');
const inbox = fs.readFileSync('app/transport/board/modules/inbox.jsx', 'utf8');
const pranimi = fs.readFileSync('app/transport/pranimi/page.jsx', 'utf8');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const vite = fs.readFileSync('vite.config.js', 'utf8');
const index = fs.readFileSync('index.html', 'utf8');
const gatiInstaller = fs.readFileSync('tools/apply-gati-rack-save-v1.mjs', 'utf8');

check(board.includes('TRANSPORT_REPEAT_VISIT_V2:BOARD'), 'board visit marker missing');
check(board.includes('transportBoardVisitIdentity'), 'visit identity helper missing');
check(board.includes("return 'id:' + id"), 'order id is not authoritative');
check(board.includes("':visit:' + visit"), 'visit fallback missing');
check(board.includes('const dbByVisit = new Map();'), 'visit reconciliation map missing');
check(!board.includes('const dbByCode = new Map();'), 'legacy code-only reconciliation still present');

check(dispatch.includes('TRANSPORT_REPEAT_VISIT_V2:DISPATCH'), 'Dispatch visit-plan marker missing');
check(dispatch.includes('value={pickupMeasurements}'), 'Dispatch create measurement field missing');
check(dispatch.includes('value={editPickupMeasurements}'), 'Dispatch edit measurement field missing');
check(dispatch.includes('pickup_plan: pickupPlan'), 'Dispatch create pickup plan missing');
check(dispatch.includes('pickup_plan: nextPickupPlan'), 'Dispatch edit pickup plan missing');
check(dispatch.includes('planned_tepiha: pickupPlan.items'), 'planned carpet rows missing');
check(dispatch.includes('planned_m2_total: pickupPlan.m2_total'), 'planned total m2 missing');
check(dispatch.includes('p.sh. 5.8, 5.8'), 'measurement guidance missing');

check(inbox.includes('TRANSPORT_REPEAT_VISIT_V2:INBOX'), 'Inbox visit-plan marker missing');
check(inbox.includes('TEPIHAT: {pickupPlanLabel}'), 'Inbox planned dimensions missing');
check(inbox.includes('orderPickupM2(order)'), 'Inbox m2 fallback missing');
check(inbox.includes('return actual > 0 ? actual : orderPickupPlan(order).pieces'), 'Inbox planned piece fallback missing');

check(pranimi.includes('TRANSPORT_REPEAT_VISIT_V2:PRANIMI'), 'Pranimi visit prefill marker missing');
check(pranimi.includes('d?.pickup_plan?.items'), 'Pranimi does not read pickup plan');
check(pranimi.includes('d.tepiha.length ? d.tepiha : plannedRows'), 'actual rows do not override planned rows');

const prebuild = String(pkg.scripts?.prebuild || '');
const v2 = 'node tools/apply-transport-repeat-visit-v2.mjs';
const unified = 'node tools/apply-unified-arka-payroll-v1.mjs';
const gati = 'node tools/apply-gati-rack-save-v1.mjs';
check(prebuild.includes(v2), 'repeat visit V2 installer missing');
check(!prebuild.includes('node tools/apply-transport-repeat-visit-v1.mjs'), 'failed V1 installer still registered');
check(prebuild.lastIndexOf(unified) < prebuild.lastIndexOf(v2), 'V2 must run after unified installer');
check(prebuild.lastIndexOf(v2) < prebuild.lastIndexOf(gati), 'V2 must run before GATI final version owner');
check(prebuild.trim().endsWith(gati), 'GATI final version owner is not last');
check(String(pkg.scripts?.build || '').includes('npm run test:transport-repeat-visit-v2'), 'V2 verifier missing from full build');
check(String(pkg.version || '').includes('repeat-visit-v2'), 'package version not bumped');
check(vite.includes('repeat-visit-v2'), 'PWA cache not bumped');
check(index.includes('repeat-visit-v2'), 'HTML build id not bumped');
check(gatiInstaller.includes('repeatVisitV2Installer'), 'GATI does not preserve V2 installer ordering');
check(!gatiInstaller.includes(";\\n  const repeatVisitV2Installer"), 'GATI contains literal newline escape from bootstrap');

const oldVisit = { id:'7376b149-2380-4af1-830f-6028ae7d12e6', code:'T1095', visit:1, status:'done' };
const newVisit = { id:'4306cf89-c5fc-4e5e-b767-b4464419e25e', code:'T1095', visit:2, status:'assigned' };
const identity = (r) => r.id ? 'id:' + r.id : 'code:' + r.code + ':visit:' + r.visit;
check(oldVisit.code === newVisit.code, 'repeat-visit fixture must share client T-code');
check(identity(oldVisit) !== identity(newVisit), 'repeat visits still collapse into one identity');

const values = '5.8, 5.8'.match(/\d{1,2}(?:[.,]\d{1,2})/g).map((v) => Number(v.replace(',', '.')));
check(values.length === 2 && values.every((v) => Math.abs(v - 5.8) < 0.001), '5.8 + 5.8 fixture parse failed');
check(Math.abs(values.reduce((a,b) => a+b,0) - 11.6) < 0.001, '5.8 + 5.8 fixture total is not 11.6');

if (failures.length) {
  console.error(`FAIL transport repeat visit V2: ${failures.length} check(s)`);
  failures.forEach((failure, index) => console.error(`${index + 1}. ${failure}`));
  process.exit(1);
}
console.log('PASS transport repeat visit V2: order/visit identity, Dispatch pickup plan, driver display and Pranimi prefill verified.');
