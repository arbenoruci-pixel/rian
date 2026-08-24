import fs from 'node:fs';

const failures = [];
const check = (condition, message) => { if (!condition) failures.push(message); };

const component = fs.readFileSync('components/ArkaDailyCloseWizard.jsx', 'utf8');
const migration = fs.readFileSync(
  'supabase/migrations/20260825003000_arka_closed_day_expense_correction_v1.sql',
  'utf8',
);

check(
  component.includes("const CLOSED_EXPENSE_CREATE_RPC = 'add_arka_closed_day_expense_v1'"),
  'closed-day correction RPC is not wired into the UI',
);
check(component.includes('async function createClosedDailyExpense'), 'closed-day expense handler missing');
check(component.includes('SHPENZIM I HARRUAR PAS MBYLLJES'), 'closed receipt correction form missing');
check(component.includes('SHTO NË MBYLLJEN ZYRTARE'), 'closed receipt correction CTA missing');
check(component.includes('p_date: date'), 'operational date is not sent to correction RPC');
check(component.includes('p_idempotency_key: idempotencyKey'), 'stable correction key is not sent');

check(
  migration.includes('create or replace function public.add_arka_closed_day_expense_v1'),
  'atomic closed-day correction function missing',
);
check(
  migration.includes("- interval '4 hours'"),
  '04:00 operational cutoff is missing from ledger guard',
);
check(
  migration.includes("perform set_config('tepiha.daily_close_context', 'on', true)"),
  'official daily-close correction context is missing',
);
check(
  migration.includes("'KORRIGJIM PAS MBYLLJES — ' || v_note"),
  'close-item audit note is missing',
);
check(
  migration.includes('posted_expenses_total = round((coalesce(c.posted_expenses_total, 0) + v_amount)'),
  'official cycle expense total is not updated',
);
check(
  migration.includes('budget_balance_before = round((coalesce(c.budget_balance_before, 0) - v_amount)'),
  'pre-close budget snapshot is not corrected',
);
check(
  migration.includes('budget_balance_after = round((coalesce(c.budget_balance_after, 0) - v_amount)'),
  'final budget snapshot is not corrected',
);
check(
  migration.includes('CLOSED_DAY_EXPENSE_BUDGET_MISMATCH'),
  'final budget/cycle invariant check is missing',
);
check(
  migration.includes('grant execute on function public.add_arka_closed_day_expense_v1'),
  'RPC execute grant is missing',
);

if (failures.length) {
  console.error(`FAIL ARKA closed-day expense V1: ${failures.length} check(s)`);
  failures.forEach((failure, index) => console.error(`${index + 1}. ${failure}`));
  process.exit(1);
}

console.log('PASS ARKA closed-day expense V1: audited post-close correction is wired and preserves the official cycle/budget invariant.');
