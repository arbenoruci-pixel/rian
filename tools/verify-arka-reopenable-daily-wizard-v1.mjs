import fs from 'node:fs';

function check(condition, message) {
  if (!condition) throw new Error(message);
}

const component = fs.readFileSync('components/ArkaDailyCloseWizard.jsx', 'utf8');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const prebuild = String(pkg.scripts?.prebuild || '');
const build = String(pkg.scripts?.build || '');

check(component.includes('ARKA_REOPENABLE_DAILY_WIZARD_V1'), 'reopenable wizard marker missing');
check(component.includes('ARKA_ACTIONABLE_REOPEN_V2'), 'actionable reopen marker missing');
check(component.includes('const hasLiveWizardWork = pendingHandoffs.length > 0'), 'live wizard work calculation missing');
check(!component.includes('|| openCashAtWorkers.length > 0'), 'unsubmitted worker cash still reopens a finalized report');
check(component.includes('const showClosedReceiptOnly = isClosed && !hasLiveWizardWork;'), 'receipt-only gate missing');
check(component.includes('if (!preview || showClosedReceiptOnly || countedCashManualRef.current) return;'), 'counted cash still blocked by a prior close');
check(component.includes('if (!initializedRef.current) {'), 'pending handoffs are not initialized after a prior close');
check(!component.includes('if (!initializedRef.current && !obj(next?.closed_cycle)?.is_closed)'), 'legacy closed initialization guard remains');
check(component.includes('{showClosedReceiptOnly ? ('), 'receipt rendering does not use live-work gate');
check(!component.includes('{activeReceiptCycle?.is_closed ? ('), 'closed receipt still permanently hides the wizard');
check(component.includes('WIZARD-I ËSHTË RIHAPUR'), 'reopened-day warning missing');
check(component.includes('PARA ENDE TE PUNËTORËT'), 'closed-report worker cash information missing');
check(component.includes('prit dorëzimin e punëtorit'), 'worker cash is not explained as waiting for a real handoff');
check(component.includes('Raporti mbetet i finalizuar'), 'closed report status is not explained');
check(component.includes("const CLOSE_RPC = 'close_arka_day_v2';"), 'daily finalization RPC missing');

const installer = 'node tools/apply-arka-reopenable-daily-wizard-v1.mjs';
const finalVersionOwner = 'node tools/apply-gati-rack-save-v1.mjs';
const prebuildParts = prebuild.split('&&').map((part) => part.trim()).filter(Boolean);
const installerIndex = prebuildParts.indexOf(installer);
const ownerIndex = prebuildParts.lastIndexOf(finalVersionOwner);
check(installerIndex >= 0, 'reopenable wizard installer missing from prebuild');
check(
  ownerIndex >= 0 ? installerIndex < ownerIndex : installerIndex === prebuildParts.length - 1,
  'reopenable wizard installer must run before the compatible final version owner',
);
check(String(pkg.scripts?.['test:arka-reopenable-daily-wizard-v1'] || '').includes('verify-arka-reopenable-daily-wizard-v1.mjs'), 'reopenable wizard test script missing');
check(build.split('&&').map((part) => part.trim()).includes('npm run test:arka-reopenable-daily-wizard-v1'), 'reopenable wizard verifier missing from build');

console.log('PASS ARKA actionable reopen V2: submitted handoffs and actionable movements reopen the wizard; unsubmitted worker cash remains visible without reopening the finalized report.');
