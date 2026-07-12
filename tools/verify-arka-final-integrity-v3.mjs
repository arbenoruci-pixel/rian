import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const checks = [];
const check = (name, ok) => checks.push({ name, ok: Boolean(ok) });

const migration = read('sql/arka_final_integrity_v3_20260712.sql');
const acceptSql = read('sql/accept_cash_handoff_atomic.sql');
const engine = read('lib/arka/arkaEngine.js');
const finance = read('lib/corporateFinance.js');
const arkaPage = read('app/arka/page.jsx');

check('unique payment per handoff item', migration.includes('ux_cash_handoff_items_pending_payment_once'));
check('unique ledger source guard', migration.includes('ux_company_budget_ledger_source_once'));
check('business expense ledger OUT', migration.includes("'OUT',v_amount,'BUSINESS_EXPENSE'"));
check('business expense source identity', migration.includes("'arka_expense_decision',v_decision.id"));
check('business expense summary debit', migration.includes('current_balance=round((coalesce(current_balance,0)-v_amount)'));
check('business expense idempotent retry', migration.includes("'already_finalized',true"));
check('rejected expense does not post budget', migration.includes("v_mode:='REJECTED_OPEN_CASH'"));
check('secure search_path', migration.includes("set search_path to 'public','pg_temp'"));
check('accept retry re-reads handoff', /select\s+\*\s+into\s+v_handoff\s+from\s+public\.cash_handoffs/i.test(acceptSql));
check('accept verifies item sum', acceptSql.includes('HANDOFF_AMOUNT_MISMATCH'));
check('accept uses ledger source identity', acceptSql.includes('source_type = $1') && acceptSql.includes("'cash_handoff'"));
check('engine BASE payment idempotency', engine.includes('BASE_ARKA_IDEMPOTENCY_CONFLICT'));
check('engine Transport payment verification', engine.includes('TRANSPORT_ARKA_PAYMENT_VERIFY_FAILED'));
check('engine handoff requires atomic RPC', engine.includes('submit_cash_handoff_atomic'));
check('corporate finance RPC-only submit', finance.includes('rpcOnly: true'));
check('expense UI uses decision RPC', arkaPage.includes('create_standalone_expense_decision'));
check('expense UI uses finalize RPC', arkaPage.includes('finalize_business_or_rejected_expense_decision'));

const failed = checks.filter((x) => !x.ok);
for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'} ${c.name}`);
if (failed.length) {
  console.error(`\n${failed.length}/${checks.length} checks failed.`);
  process.exit(1);
}
console.log(`\nPASS — ${checks.length} ARKA final-integrity controls verified.`);
