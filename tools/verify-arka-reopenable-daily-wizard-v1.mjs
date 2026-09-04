import fs from 'node:fs';

function check(condition, message) {
  if (!condition) throw new Error(message);
}

const component = fs.readFileSync('components/ArkaDailyCloseWizard.jsx', 'utf8');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const prebuild = String(pkg.scripts?.prebuild || '');
const build = String(pkg.scripts?.build || '');

check(component.includes('ARKA_REOPENABLE_DAILY_WIZARD_V1'), 'reopenable wizard marker missing');
check(component.includes('const hasLiveWizardWork = pendingHandoffs.length > 0'), 'live wizard work calculation missing');
check(component.includes('const showClosedReceiptOnly = isClosed && !hasLiveWizardWork;'), 'receipt-only gate missing');
check(component.includes('if (!preview || showClosedReceiptOnly || countedCashManualRef.current) return;'), 'counted cash still blocked by a prior close');
check(component.includes('if (!initializedRef.current) {'), 'pending handoffs are not initialized after a prior close');
check(!component.includes('if (!initializedRef.current && !obj(next?.closed_cycle)?.is_closed)'), 'legacy closed initialization guard remains');
check(component.includes('{showClosedReceiptOnly ? ('), 'receipt rendering does not use live-work gate');
check(!component.includes('{activeReceiptCycle?.is_closed ? ('), 'closed receipt still permanently hides the wizard');
check(component.includes('WIZARD-I ËSHTË RIHAPUR'), 'reopened-day warning missing');
check(component.includes("const CLOSE_RPC = 'close_arka_day_v2';"), 'daily finalization RPC missing');

const installer = 'node tools/apply-arka-reopenable-daily-wizard-v1.mjs';
const prebuildParts = prebuild.split('&&').map((part) => part.trim()).filter(Boolean);
check(prebuildParts.at(-1) === installer, 'reopenable wizard installer must run last in prebuild');
check(String(pkg.scripts?.['test:arka-reopenable-daily-wizard-v1'] || '').includes('verify-arka-reopenable-daily-wizard-v1.mjs'), 'reopenable wizard test script missing');
check(build.split('&&').map((part) => part.trim()).includes('npm run test:arka-reopenable-daily-wizard-v1'), 'reopenable wizard verifier missing from build');

console.log('PASS ARKA reopenable daily wizard V1: a prior report remains visible only when no later handoffs, expenses, advances, or worker cash require Dispatch action.');
