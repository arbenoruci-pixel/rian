import fs from 'node:fs';

const page = fs.readFileSync('app/arka/page.jsx', 'utf8');
const component = fs.readFileSync('components/ArkaWorkerDailyStatus.jsx', 'utf8');
const css = fs.readFileSync('components/ArkaWorkerDailyStatus.css', 'utf8');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));

const checks = [
  ['page imports daily status', page.includes("import ArkaWorkerDailyStatus from '@/components/ArkaWorkerDailyStatus';")],
  ['page renders one daily status card', (page.split('<ArkaWorkerDailyStatus snapshot={workerSnapshot} actor={actor} />').length - 1) === 1],
  ['worker daily marker exists', page.includes('ARKA_WORKER_DAILY_STATUS_V1:PAGE')],
  ['daily status reads all extras including approved expenses', component.includes('snapshot?.allExtraRows')],
  ['daily status recognizes accepted expense', component.includes("'ACCEPTED_BY_DISPATCH'")],
  ['daily status uses Kosovo business timezone', component.includes("const TIME_ZONE = 'Europe/Belgrade';")],
  ['daily status title is visible', component.includes('GJENDJA DITORE')],
  ['daily status shows expenses', component.includes('SHPENZIME SOT')],
  ['daily status shows current base cash', component.includes('PËR BAZË TASH')],
  ['daily status styles installed', css.includes('ARKA_WORKER_DAILY_STATUS_V1') && css.includes('.arkaDailyStatusCard')],
  ['handoff action preserved', page.includes('DORËZO TE DISPATCH')],
  ['prebuild installer registered', String(pkg?.scripts?.prebuild || '').includes('apply-arka-worker-daily-status-v1.mjs')],
];

const failed = checks.filter(([, ok]) => !ok);
for (const [label, ok] of checks) console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`);
if (failed.length) {
  throw new Error(`${failed.length} ARKA worker daily status check(s) failed.`);
}
console.log(`PASS — ${checks.length} ARKA worker daily status controls verified.`);
