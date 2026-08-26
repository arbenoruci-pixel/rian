-- ARKA closed-day expense correction V1.
--
-- Normal expenses must be posted in step 2 before the daily close. This
-- migration closes the midnight/cutoff gap and provides one audited escape
-- hatch for a manager to attach a forgotten expense to the just-closed
-- operational day without leaving the official receipt stale.

create or replace function public.guard_company_ledger_after_closed_day_v2()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_day date := (
    (coalesce(new.created_at, now()) at time zone 'Europe/Belgrade')
    - interval '4 hours'
  )::date;
begin
  if coalesce(current_setting('tepiha.daily_close_context', true), '') <> 'on'
     and exists (
       select 1
       from public.arka_cycles c
       where c.cycle_date = v_day
         and c.is_closed is true
     ) then
    raise exception 'ARKA_DAY_ALREADY_CLOSED:%', v_day;
  end if;
  return new;
end;
$$;

create or replace function public.guard_dispatch_expense_after_closed_day_v1()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_day date := (
    (coalesce(new.created_at, now()) at time zone 'Europe/Belgrade')
    - interval '4 hours'
  )::date;
begin
  if upper(coalesce(new.type, '')) = 'EXPENSE'
     and upper(coalesce(new.source_module, '')) = 'ARKA_DAILY_CLOSE'
     and coalesce(current_setting('tepiha.daily_close_context', true), '') <> 'on'
     and exists (
       select 1
       from public.arka_cycles c
       where c.cycle_date = v_day
         and c.is_closed is true
     ) then
    raise exception 'ARKA_DAY_ALREADY_CLOSED_USE_CORRECTION:%', v_day;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_dispatch_expense_after_closed_day_v1
  on public.arka_pending_payments;

create trigger trg_guard_dispatch_expense_after_closed_day_v1
before insert on public.arka_pending_payments
for each row execute function public.guard_dispatch_expense_after_closed_day_v1();

create or replace function public.add_arka_closed_day_expense_v1(
  p_actor_pin text,
  p_actor_name text,
  p_date date,
  p_amount numeric,
  p_note text,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role text;
  v_actor_name text;
  v_operational_date date := (
    (now() at time zone 'Europe/Belgrade') - interval '4 hours'
  )::date;
  v_date date := coalesce(p_date, v_operational_date);
  v_amount numeric(12,2) := round(coalesce(p_amount, 0)::numeric, 2);
  v_note text := trim(coalesce(p_note, ''));
  v_key text;
  v_cycle public.arka_cycles%rowtype;
  v_expense_id bigint;
  v_decision_id bigint;
  v_ledger_id bigint;
  v_close_item_id bigint;
  v_budget_before numeric(12,2);
  v_budget_after numeric(12,2);
  v_expected_budget numeric(12,2);
  v_item_inserted integer := 0;
  v_create_result jsonb;
begin
  if nullif(trim(coalesce(p_actor_pin, '')), '') is null then
    raise exception 'MISSING_ACTOR_PIN';
  end if;
  if v_amount <= 0 then
    raise exception 'INVALID_EXPENSE_AMOUNT';
  end if;
  if length(v_note) < 2 then
    raise exception 'EXPENSE_NOTE_REQUIRED';
  end if;
  if v_date <> v_operational_date then
    raise exception 'CLOSED_DAY_CORRECTION_ONLY_CURRENT_OPERATIONAL_DAY:%', v_operational_date;
  end if;

  select upper(coalesce(u.role, '')),
         coalesce(nullif(trim(u.name), ''), trim(p_actor_pin))
    into v_role, v_actor_name
  from public.users u
  where u.pin = trim(p_actor_pin)
    and u.is_active is true
  limit 1;

  if v_role not in (
    'DISPATCH', 'MASTER', 'MASTER USER', 'MASTER_USER', 'MASTERUSER',
    'ADMIN', 'ADMIN_MASTER', 'OWNER', 'PRONAR', 'SUPERADMIN'
  ) then
    raise exception 'DISPATCH_ONLY';
  end if;

  if exists (
    select 1
    from public.arka_cycles c
    where c.cycle_date > v_date
  ) then
    raise exception 'CLOSED_DAY_CORRECTION_NOT_LATEST_CYCLE:%', v_date;
  end if;

  v_key := coalesce(
    nullif(trim(coalesce(p_idempotency_key, '')), ''),
    'ARKA_CLOSED_DAY_EXPENSE_V1:' || v_date::text || ':' ||
      md5(v_amount::text || ':' || upper(v_note))
  );

  perform pg_advisory_xact_lock(hashtext('ARKA_CLOSED_DAY_EXPENSE_V1:' || v_date::text));

  select * into v_cycle
  from public.arka_cycles c
  where c.cycle_date = v_date
  for update;

  if not found or v_cycle.is_closed is not true
     or upper(coalesce(v_cycle.close_status, '')) <> 'CLOSED' then
    raise exception 'CLOSED_ARKA_CYCLE_NOT_FOUND:%', v_date;
  end if;

  select round(coalesce(s.current_balance, 0)::numeric, 2)
    into v_budget_before
  from public.company_budget_summary s
  where s.id = 1
  for update;

  select p.id into v_expense_id
  from public.arka_pending_payments p
  where p.idempotency_key = v_key
  limit 1;

  if v_expense_id is null
     and abs(v_budget_before - round(coalesce(v_cycle.budget_balance_after, v_cycle.closing_cash, 0)::numeric, 2)) > 0.01 then
    raise exception 'POST_CLOSE_BUDGET_CHANGED:%:%',
      v_budget_before,
      round(coalesce(v_cycle.budget_balance_after, v_cycle.closing_cash, 0)::numeric, 2);
  end if;

  perform set_config('tepiha.daily_close_context', 'on', true);

  v_create_result := public.create_and_resolve_arka_expense_v2(
    trim(p_actor_pin),
    v_actor_name,
    v_amount,
    v_note,
    'BUSINESS_EXPENSE',
    null,
    null,
    v_key
  );

  if coalesce((v_create_result ->> 'ok')::boolean, false) is not true then
    raise exception 'CLOSED_DAY_EXPENSE_CREATE_FAILED:%', v_create_result;
  end if;

  v_expense_id := coalesce(
    (v_create_result ->> 'expense_payment_id')::bigint,
    v_expense_id
  );

  select d.id into v_decision_id
  from public.arka_expense_decisions d
  where d.expense_payment_id = v_expense_id
    and d.finalized_at is not null
    and upper(coalesce(d.decision_type, '')) = 'BUSINESS_EXPENSE'
  order by d.id desc
  limit 1;

  if v_decision_id is null then
    raise exception 'CLOSED_DAY_EXPENSE_DECISION_MISSING:%', v_expense_id;
  end if;

  select l.id into v_ledger_id
  from public.company_budget_ledger l
  where l.source_type = 'arka_expense_decision'
    and l.source_id = v_decision_id
    and l.direction = 'OUT'
  limit 1;

  if v_ledger_id is null then
    raise exception 'CLOSED_DAY_EXPENSE_LEDGER_MISSING:%', v_decision_id;
  end if;

  insert into public.arka_daily_close_items(
    cycle_id,
    item_type,
    source_table,
    source_id,
    worker_pin,
    worker_name,
    amount,
    direction,
    status_snapshot,
    included,
    confirmed,
    note
  ) values (
    v_cycle.id,
    'EXPENSE',
    'company_budget_ledger',
    v_ledger_id,
    trim(p_actor_pin),
    v_actor_name,
    v_amount,
    'OUT',
    'POST_CLOSE_CORRECTION',
    true,
    true,
    'KORRIGJIM PAS MBYLLJES — ' || v_note
  )
  on conflict (cycle_id, item_type, source_table, source_id)
    where source_id is not null
  do nothing
  returning id into v_close_item_id;

  get diagnostics v_item_inserted = row_count;

  if v_item_inserted = 1 then
    update public.arka_cycles c
    set total_out = round((coalesce(c.total_out, 0) + v_amount)::numeric, 2),
        posted_expenses_total = round((coalesce(c.posted_expenses_total, 0) + v_amount)::numeric, 2),
        expected_cash = round((coalesce(c.expected_cash, 0) - v_amount)::numeric, 2),
        counted_cash = round((coalesce(c.counted_cash, 0) - v_amount)::numeric, 2),
        closing_cash = round((coalesce(c.closing_cash, 0) - v_amount)::numeric, 2),
        budget_balance_before = round((coalesce(c.budget_balance_before, 0) - v_amount)::numeric, 2),
        budget_balance_after = round((coalesce(c.budget_balance_after, 0) - v_amount)::numeric, 2),
        updated_at = now()
    where c.id = v_cycle.id;
  else
    select i.id into v_close_item_id
    from public.arka_daily_close_items i
    where i.cycle_id = v_cycle.id
      and i.item_type = 'EXPENSE'
      and i.source_table = 'company_budget_ledger'
      and i.source_id = v_ledger_id
    limit 1;
  end if;

  select round(coalesce(s.current_balance, 0)::numeric, 2)
    into v_budget_after
  from public.company_budget_summary s
  where s.id = 1;

  select round(coalesce(c.budget_balance_after, c.closing_cash, 0)::numeric, 2)
    into v_expected_budget
  from public.arka_cycles c
  where c.id = v_cycle.id;

  if abs(v_budget_after - v_expected_budget) > 0.01 then
    raise exception 'CLOSED_DAY_EXPENSE_BUDGET_MISMATCH:%:%',
      v_budget_after,
      v_expected_budget;
  end if;

  return jsonb_build_object(
    'ok', true,
    'already_exists', coalesce((v_create_result ->> 'already_exists')::boolean, false),
    'date', v_date,
    'cycle_id', v_cycle.id,
    'expense_payment_id', v_expense_id,
    'decision_id', v_decision_id,
    'ledger_id', v_ledger_id,
    'close_item_id', v_close_item_id,
    'amount', v_amount,
    'budget_balance', v_budget_after,
    'cycle', (
      select to_jsonb(c)
      from public.arka_cycles c
      where c.id = v_cycle.id
    )
  );
end;
$$;

revoke all on function public.add_arka_closed_day_expense_v1(
  text, text, date, numeric, text, text
) from public;

grant execute on function public.add_arka_closed_day_expense_v1(
  text, text, date, numeric, text, text
) to anon, authenticated, service_role;
