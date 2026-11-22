import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

// Isolated PostgreSQL-compatible fixture. No application credentials, network
// requests, production identities, or production financial data are used.
export async function createWorkerHandoffTestDb({ beforeWizardMigration } = {}) {
  const db = new PGlite();
  const read = path => fs.readFileSync(path, 'utf8');
  const legacy = JSON.parse(read('tools/fixtures/transport-control-ledger.json'));
  const fixture = JSON.parse(read('tools/fixtures/handoff-receipt-schema.json'));
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema private;
    grant usage on schema public,private to service_role,anon,authenticated;
    select set_config('fixture.now','2026-11-21T12:00:00Z',false);
    create or replace function pg_catalog.now() returns timestamptz language sql stable as $$ select current_setting('fixture.now')::timestamptz $$;
    create or replace function pg_catalog.clock_timestamp() returns timestamptz language sql volatile as $$ select current_setting('fixture.now')::timestamptz $$;
  `);
  await db.exec(read('tools/fixtures/base-bonus-evidence-schema.sql').split('CREATE OR REPLACE FUNCTION')[0]);
  for (const table of ['cash_handoffs', 'cash_handoff_items', 'base_ready_bonus_allocations', 'company_budget_ledger', 'company_budget_summary', 'arka_cycles', 'arka_daily_close_items']) {
    const columns = [...legacy.columns, ...fixture.columns].filter(column => column.table === table);
    const definitions = columns.map(column => `"${column.name}" ${column.default?.startsWith('nextval') ? 'bigserial' : (column.type === 'ARRAY' ? 'bigint[]' : column.type) + (column.default ? ' default ' + column.default : '')}${column.name === 'id' ? ' primary key' : ''}`);
    await db.exec(`create table public.${table}(${definitions.join(',')});`);
  }
  await db.exec(`
    alter table cash_handoffs add constraint cash_handoffs_accepted_ledger_v1 check (status<>'ACCEPTED' or company_ledger_entry_id is not null);
    create unique index bonus_handoff_unique on base_ready_bonus_allocations(bonus_id,handoff_id);
    create unique index daily_item_unique on arka_daily_close_items(cycle_id,item_type,source_table,source_id) where source_id is not null;
    create unique index daily_date_unique on arka_cycles(cycle_date);
    create unique index company_budget_source_unique on company_budget_ledger(source_type,source_id) where source_id is not null;
    create table arka_payment_exclusions(payment_id bigint,cancelled_at timestamptz);
    create table cash_handoff_expense_decisions(id bigserial primary key,expense_payment_id bigint,decision_status text);
    create table company_fixed_expenses(id int,amount numeric,active boolean,essential boolean);
    create table payroll_month_closes(id int,month_key text,status text,snapshot jsonb);
    create table worker_compensation_audit(worker_pin text,worker_name text,before_profile jsonb,after_profile jsonb,changed_by_pin text,changed_by_name text,change_note text);
    create table tepiha_user_devices(device_id text primary key,user_id uuid,is_approved boolean);
    alter table base_ready_bonuses add column if not exists transport_control_id uuid;
    insert into company_budget_summary(id,current_balance,total_in,total_out)values(1,500,500,0);
  `);
  for (const f of legacy.functions.filter(row => ['base_ready_bonus_handoff_status_v1','base_ready_bonus_refresh_status_v1','submit_cash_handoff_with_ready_bonus_v1'].includes(row.name))) await db.exec(f.definition);
  for (const f of fixture.functions.filter(row => row.name !== 'get_dispatch_daily_control_v1')) await db.exec(f.definition);
  await db.exec('CREATE OR REPLACE FUNCTION public.preview_monthly_payroll_close' + read('tools/fixtures/meal-policy-legacy-functions.sql').split('CREATE OR REPLACE FUNCTION public.preview_monthly_payroll_close')[1]);
  await db.exec(read('tools/fixtures/meal-policy-legacy-profile-save.sql'));
  await db.exec(read('tools/fixtures/handoff-receipt-daily-functions.sql'));
  await db.exec(read('tools/fixtures/handoff-receipt-legacy-guards.sql'));
  await db.exec(read('tools/fixtures/handoff-receipt-client-guard.sql'));
  await db.exec(`
    create function get_dispatch_daily_control_v1(text,date) returns jsonb language sql as $$select '{"operations":{}}'::jsonb$$;
    create trigger guard_handoff before insert or update on cash_handoffs for each row execute function private.guard_cash_handoff_v1();
    create trigger guard_ledger before insert or update on company_budget_ledger for each row execute function private.guard_company_budget_ledger_v1();
    create trigger guard_payment before insert or update on arka_pending_payments for each row execute function private.guard_arka_cash_payment_v1();
    create trigger guard_payment_client before insert or update on arka_pending_payments for each row execute function private.guard_arka_cash_payment_client_v2();
    create constraint trigger accepted_complete after insert or update on cash_handoffs deferrable initially deferred for each row when (new.status='ACCEPTED') execute function private.assert_accepted_handoff_complete_v1();
    create trigger handoff_bonus after update of status on cash_handoffs for each row execute function base_ready_bonus_handoff_status_v1();
    grant select on all tables in schema public to service_role;
  `);
  await db.exec(read('supabase/migrations/20261122015736_meal_monthly_policy_v1.sql'));
  await db.exec(JSON.parse(read('tools/fixtures/handoff-receipt-payroll-after-meal.json')).definition);
  await db.exec(read('supabase/migrations/20261122015743_actual_handoff_receipts_v1.sql'));
  await db.exec(read('tools/fixtures/worker-handoff-expense-schema.sql'));
  await db.exec(read('tools/fixtures/worker-handoff-legacy-submit.sql'));
  if (beforeWizardMigration) await beforeWizardMigration(db);
  const migrations = fs.readdirSync('supabase/migrations').filter(name => /worker_handoff.*\.sql$/.test(name)).sort();
  if (!migrations.length) throw new Error('WORKER_HANDOFF_MIGRATION_MISSING');
  for (const name of migrations) await db.exec(read(`supabase/migrations/${name}`));
  return { db, migrationPaths: migrations.map(name => `supabase/migrations/${name}`) };
}
