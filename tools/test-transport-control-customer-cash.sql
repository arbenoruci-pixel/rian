-- Run after the migration. All fixture rows are session-local.
begin;
create temporary table customer_cash_fixture(transport_order_id uuid, type text, amount numeric, status text);
create temporary table opening_cash_fixture(source_module text, order_key text, amount numeric);
do $test$
declare
  fixture uuid := gen_random_uuid();
  definition text := pg_get_functiondef('public.transport_order_active_arka_paid_v1(uuid)'::regprocedure);
begin
  definition := replace(definition,'public.transport_order_active_arka_paid_v1','pg_temp.customer_cash_test');
  definition := replace(definition,'public.arka_pending_payments','pg_temp.customer_cash_fixture');
  definition := replace(definition,'private.finance_opening_cash_v1','pg_temp.opening_cash_fixture');
  execute definition;

  insert into customer_cash_fixture values (fixture,'READY_48H_BONUS',0.50,'ACCEPTED_BY_DISPATCH');
  if pg_temp.customer_cash_test(fixture) is distinct from 0::numeric then
    raise exception 'A worker bonus reduced the customer balance';
  end if;
  insert into customer_cash_fixture values
    (fixture,'TRANSPORT',34.78,'COLLECTED'),(fixture,'TRANSPORT',10,'VOIDED');
  if pg_temp.customer_cash_test(fixture) is distinct from 34.78 then
    raise exception 'Customer cash included a bonus or a voided payment';
  end if;
  insert into opening_cash_fixture values ('TRANSPORT',fixture::text,2),('BASE',fixture::text,5);
  if pg_temp.customer_cash_test(fixture) is distinct from 36.78 then
    raise exception 'Transport opening balance was not preserved';
  end if;
end;
$test$;
rollback;
