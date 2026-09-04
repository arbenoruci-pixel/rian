import fs from 'node:fs';

function read(path) {
  return fs.readFileSync(path, 'utf8');
}

function check(condition, message) {
  if (!condition) throw new Error(`ARKA_DIRECT_FLOW_V1_FAILED: ${message}`);
}

const arka = read('app/arka/page.jsx');
const payroll = read('app/arka/payroll/page.jsx');
const layout = read('app/arka/layout.jsx');
const routes = read('src/generated/routes.generated.jsx');
const finance = read('lib/corporateFinance.js');
const migration = read('supabase/migrations/20260904192356_retire_legacy_arka_cycle_guards_v3.sql');

const activeRuntime = [arka, payroll, layout, routes, finance].join('\n');
const retiredTokens = [
  'ARKA_DAY_ALREADY_CLOSED',
  'ARKA_DAILY_CLOSE_V2_ONE_WAY',
  'ArkaDailyCloseWizard',
  'ArkaDailyCloseShortcut',
  'HAP MBYLLJEN DITORE',
  'MBYLLJA DITORE',
  "window.location.assign('/arka/ditore')",
  'arka_open_cycle_safe',
  'close_arka_day_v2',
  'get_arka_daily_close_preview_v2',
  'get_arka_daily_close_preview_v3',
  'get_arka_daily_close_preview_v4',
  'add_arka_closed_day_expense_v1',
];

for (const token of retiredTokens) {
  check(!activeRuntime.includes(token), `retired runtime token remains: ${token}`);
}

check(
  routes.includes("{ path: '/arka/ditore', element: <Navigate to='/arka' replace /> }"),
  'retired /arka/ditore URL must redirect safely to /arka',
);
check(!routes.includes('ArkaDitorePageEager'), 'daily-close page must not load in routing truth');
check(!fs.existsSync('components/ArkaDailyCloseWizard.jsx'), 'daily-close wizard component still exists');
check(!fs.existsSync('components/ArkaDailyCloseShortcut.jsx'), 'daily-close shortcut component still exists');

check(arka.includes('async function handleAccept()'), 'direct row acceptance handler missing');
check(
  arka.includes('await acceptDispatchHandoff({ handoffId: row.id, actor });'),
  'direct handoff acceptance call missing',
);
check(
  arka.includes('setCashAcceptReview(buildWorkerHandoffReview(item));'),
  'manager review flow missing',
);
check(arka.includes('PRANO CASH'), 'direct cash acceptance label missing');

for (const role of ['ADMIN', 'ADMIN_MASTER', 'DISPATCH', 'OWNER', 'PRONAR', 'SUPERADMIN']) {
  check(payroll.includes(`'${role}'`) || payroll.includes(`"${role}"`), `payroll role missing: ${role}`);
}
check(!payroll.includes('masterPin'), 'legacy Master PIN state remains');
check(!payroll.includes('setMasterPin'), 'legacy Master PIN setter remains');
check(!payroll.includes('Kërkohet Master PIN'), 'legacy Master PIN prompt remains');
check(
  payroll.includes('actorPin: actor?.pin') || payroll.includes("String(actor?.pin || '').trim()"),
  'logged-in actor PIN is not used for audit',
);

check(finance.includes('export async function acceptDispatchHandoff'), 'handoff API bridge missing');
check(finance.includes('/api/arka/handoffs/accept'), 'server acceptance fallback missing');

for (const functionName of [
  'guard_company_ledger_after_closed_day_v2',
  'guard_dispatch_expense_after_closed_day_v1',
  'guard_closed_arka_cycle_v2',
  'arka_pending_guard_apply',
  'guard_handoff_accept_daily_close_v2',
]) {
  check(migration.includes(`drop function if exists public.${functionName}()`), `DB guard retirement missing: ${functionName}`);
}
check(migration.includes("'DISPATCH','ADMIN','ADMIN_MASTER'"), 'DISPATCH/admin advance authorization missing');
check(migration.includes('independent of arka day cycles'), 'continuous ARKA migration marker missing');

console.log('ARKA_DIRECT_FLOW_V1_OK');
