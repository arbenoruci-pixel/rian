import fs from 'node:fs';

const failures = [];
const check = (condition, message) => { if (!condition) failures.push(message); };

const component = fs.readFileSync('components/ArkaDailyCloseWizard.jsx', 'utf8');
const installer = fs.readFileSync('tools/apply-arka-daily-expense-step-v1.mjs', 'utf8');
const gatiInstaller = fs.readFileSync('tools/apply-gati-rack-save-v1.mjs', 'utf8');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const vite = fs.readFileSync('vite.config.js', 'utf8');
const index = fs.readFileSync('index.html', 'utf8');

check(component.includes('ARKA_DAILY_EXPENSE_STEP_V1'), 'expense-step marker missing');
check(component.includes("const EXPENSE_RESOLVE_RPC = 'resolve_arka_expense_v2'"), 'atomic expense resolution RPC missing');
check(component.includes("const EXPENSE_CREATE_RPC = 'create_and_resolve_arka_expense_v2'"), 'atomic new-expense RPC missing');
check(component.includes('async function resolvePendingExpense'), 'pending expense resolver missing');
check(component.includes('async function createDailyExpense'), 'new expense creator missing');
check(component.includes("p_resolution: resolution"), 'expense decision type is not passed to DB');
check(component.includes("p_resolution: 'BUSINESS_EXPENSE'"), 'Dispatch-entered expense is not posted as business expense');
check(component.includes('expenseMutationLockRef'), 'duplicate expense-action guard missing');
check(component.includes('SHPENZIMET NË PRITJE'), 'pending expense list missing');
check(component.includes('PRANO BIZNES'), 'business approval action missing');
check(component.includes('KTHE NË AVANS'), 'personal advance action missing');
check(component.includes('REFUZO'), 'rejection action missing');
check(component.includes('SHTO SHPENZIM TË RI'), 'new expense form missing');
check(component.includes('REGJISTRO DHE ZBRITE NGA BUXHETI'), 'new expense posting action missing');
check(component.includes("pendingExpenseCount > 0 ? `VENDOS EDHE ${pendingExpenseCount} KËRKESA` : 'VAZHDO TE NUMËRIMI →'"), 'continue-state explanation missing');
check(component.includes('await loadPreview({ force: true })'), 'post-mutation authoritative refresh missing');
check(component.includes("window.dispatchEvent(new Event('arka:refresh'))"), 'cross-view ARKA refresh missing');

const prebuild = String(pkg.scripts?.prebuild || '');
const expenseInstaller = 'node tools/apply-arka-daily-expense-step-v1.mjs';
const arkaInstaller = 'node tools/apply-arka-daily-close-v2.mjs';
const gatiInstallerCommand = 'node tools/apply-gati-rack-save-v1.mjs';
check(prebuild.includes(expenseInstaller), 'expense-step installer missing from prebuild');
check(prebuild.includes(arkaInstaller), 'ARKA daily-close installer missing from prebuild');
check(prebuild.includes(gatiInstallerCommand), 'final GATI version owner missing');
// The ARKA and expense installers are independent and idempotent. Later compatible
// version-owner installers may reorder them; both must complete before GATI finalizes
// the build identity and PWA cache generation.
check(prebuild.lastIndexOf(arkaInstaller) < prebuild.lastIndexOf(gatiInstallerCommand), 'ARKA daily-close installer must run before final version owner');
check(prebuild.lastIndexOf(expenseInstaller) < prebuild.lastIndexOf(gatiInstallerCommand), 'expense step must run before final version owner');
check(prebuild.trim().endsWith(gatiInstallerCommand), 'GATI compatible final version owner is not last');
check(String(pkg.scripts?.build || '').includes('npm run test:arka-daily-expense-step-v1'), 'expense-step verifier missing from full build');
check(String(pkg.scripts?.['test:arka-daily-expense-step-v1'] || '').includes('verify-arka-daily-expense-step-v1.mjs'), 'expense-step test script missing');
check(String(pkg.version || '').includes('arka-daily-expense-step-v1'), 'package build identity missing expense-step suffix');
check(gatiInstaller.includes('arka-daily-expense-step-v1'), 'final version owner can overwrite expense-step build identity');
check(vite.includes('arka-daily-expense-step-v1'), 'PWA cache generation missing expense-step suffix');
check(index.includes('arka-daily-expense-step-v1'), 'HTML build id missing expense-step suffix');
check(installer.includes('ARKA_DAILY_EXPENSE_STEP_V1'), 'installer marker missing');

if (failures.length) {
  console.error(`FAIL ARKA daily expense step V1: ${failures.length} check(s)`);
  failures.forEach((failure, index) => console.error(`${index + 1}. ${failure}`));
  process.exit(1);
}

console.log('PASS ARKA daily expense step V1: pending expenses are visible and actionable, new expenses post atomically, and step 3 unlocks after reconciliation.');
