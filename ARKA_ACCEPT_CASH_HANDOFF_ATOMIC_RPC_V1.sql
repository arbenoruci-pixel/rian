-- ARKA ACCEPT CASH HANDOFF ATOMIC RPC V1
-- Required for Dispatch "PRANO CASH" fast/atomic accept.
-- Safe additive migration: creates/replaces one SECURITY DEFINER function.

create or replace function public.accept_cash_handoff_atomic(
  handoff_id bigint,
  accepted_by_pin text default null,
  accepted_by_name text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_handoff_id bigint := $1;
  v_actor_pin text := nullif(trim(coalesce($2, '')), '');
  v_actor_name text := nullif(trim(coalesce($3, $2, 'DISPATCH')), '');
  v_handoff public.cash_handoffs%rowtype;
  v_status text;
  v_now timestamptz := now();
  v_item_count integer := 0;
  v_item_sum numeric := 0;
  v_payment_ids bigint[] := array[]::bigint[];
  v_payment_count integer := 0;
  v_ledger_count integer := 0;
  v_ledger_sum numeric := 0;
  v_ledger_id bigint := null;
  v_summary_diff_in numeric := 0;
  v_summary_diff_out numeric := 0;
  v_patch jsonb;
  v_payment_patch jsonb;
  v_ledger_json jsonb;
  v_set_sql text;
  v_cols text;
  v_values text;
begin
  if v_handoff_id is null or v_handoff_id <= 0 then
    raise exception 'HANDOFF_ID_INVALID';
  end if;

  if v_actor_pin is null then
    raise exception 'ACCEPTED_BY_PIN_REQUIRED';
  end if;

  select *
    into v_handoff
  from public.cash_handoffs
  where id = v_handoff_id
  for update;

  if not found then
    raise exception 'HANDOFF_NOT_FOUND';
  end if;

  v_status := upper(coalesce(v_handoff.status, ''));
  if v_status not in ('PENDING_DISPATCH_APPROVAL', 'ACCEPTED') then
    raise exception 'HANDOFF_NOT_PENDING_OR_ACCEPTED:%', v_status;
  end if;

  select
    count(*)::integer,
    round(coalesce(sum(amount), 0)::numeric, 2),
    coalesce(array_agg(distinct pending_payment_id order by pending_payment_id) filter (where pending_payment_id is not null), array[]::bigint[])
  into v_item_count, v_item_sum, v_payment_ids
  from public.cash_handoff_items
  where handoff_id = v_handoff_id;

  if v_item_count <= 0 then
    raise exception 'HANDOFF_HAS_NO_ITEMS';
  end if;

  if v_item_sum <= 0 then
    raise exception 'HANDOFF_AMOUNT_ZERO';
  end if;

  if abs(round(coalesce(v_handoff.amount, 0)::numeric, 2) - v_item_sum) > 0.05 then
    raise exception 'HANDOFF_ITEM_SUM_MISMATCH handoff=% items=%', v_handoff.amount, v_item_sum;
  end if;

  -- Mark handoff accepted, dynamically skipping optional columns that do not exist.
  if v_status <> 'ACCEPTED' then
    v_patch := jsonb_build_object(
      'status', 'ACCEPTED',
      'amount', v_item_sum,
      'total_amount', v_item_sum,
      'decided_at', v_now,
      'accepted_at', v_now,
      'dispatch_pin', v_actor_pin,
      'accepted_by_pin', v_actor_pin,
      'accepted_by_name', v_actor_name,
      'updated_at', v_now
    );

    select string_agg(format('%I = (jsonb_populate_record(null::public.cash_handoffs, $1)).%I', c.column_name, c.column_name), ', ' order by c.ordinality)
      into v_set_sql
    from unnest(array['status','amount','total_amount','decided_at','accepted_at','dispatch_pin','accepted_by_pin','accepted_by_name','updated_at']) with ordinality as c(column_name, ordinality)
    join information_schema.columns ic
      on ic.table_schema = 'public'
     and ic.table_name = 'cash_handoffs'
     and ic.column_name = c.column_name;

    if v_set_sql is null or position('status =' in v_set_sql) = 0 then
      raise exception 'CASH_HANDOFFS_STATUS_COLUMN_REQUIRED';
    end if;

    execute format('update public.cash_handoffs set %s where id = $2', v_set_sql)
      using v_patch, v_handoff_id;
  end if;

  -- Mark linked payments accepted.
  if coalesce(array_length(v_payment_ids, 1), 0) > 0 then
    v_payment_patch := jsonb_build_object(
      'status', 'ACCEPTED_BY_DISPATCH',
      'accepted_at', v_now,
      'accepted_by_pin', v_actor_pin,
      'accepted_by_name', v_actor_name,
      'updated_at', v_now
    );

    select string_agg(format('%I = (jsonb_populate_record(null::public.arka_pending_payments, $1)).%I', c.column_name, c.column_name), ', ' order by c.ordinality)
      into v_set_sql
    from unnest(array['status','accepted_at','accepted_by_pin','accepted_by_name','updated_at']) with ordinality as c(column_name, ordinality)
    join information_schema.columns ic
      on ic.table_schema = 'public'
     and ic.table_name = 'arka_pending_payments'
     and ic.column_name = c.column_name;

    if v_set_sql is null or position('status =' in v_set_sql) = 0 then
      raise exception 'ARKA_PENDING_PAYMENTS_STATUS_COLUMN_REQUIRED';
    end if;

    execute format('update public.arka_pending_payments set %s where id = any($2)', v_set_sql)
      using v_payment_patch, v_payment_ids;
  end if;

  -- Insert exactly one ledger row for this handoff if missing.
  select count(*)::integer, round(coalesce(sum(amount),0)::numeric,2)
    into v_ledger_count, v_ledger_sum
  from public.company_budget_ledger
  where source_type = 'cash_handoff'
    and source_id = v_handoff_id;

  if v_ledger_count = 0 then
    v_ledger_json := jsonb_build_object(
      'direction', 'IN',
      'amount', v_item_sum,
      'category', 'WORKER_TO_DISPATCH',
      'description', 'PRANIM NGA DISPATCH — ' || coalesce(v_handoff.worker_name, v_handoff.worker_pin::text, 'worker'),
      'source_type', 'cash_handoff',
      'source_id', v_handoff_id,
      'related_handoff_id', v_handoff_id,
      'created_by_pin', v_actor_pin,
      'created_by_name', v_actor_name,
      'approved_by_pin', v_actor_pin,
      'approved_by_name', v_actor_name,
      'worker_pin', v_handoff.worker_pin,
      'worker_name', v_handoff.worker_name,
      'created_at', v_now
    );

    select
      string_agg(quote_ident(c.column_name), ', ' order by c.ordinality),
      string_agg(format('(jsonb_populate_record(null::public.company_budget_ledger, $1)).%I', c.column_name), ', ' order by c.ordinality)
      into v_cols, v_values
    from unnest(array['direction','amount','category','description','source_type','source_id','related_handoff_id','created_by_pin','created_by_name','approved_by_pin','approved_by_name','worker_pin','worker_name','created_at']) with ordinality as c(column_name, ordinality)
    join information_schema.columns ic
      on ic.table_schema = 'public'
     and ic.table_name = 'company_budget_ledger'
     and ic.column_name = c.column_name;

    if v_cols is null or position('amount' in v_cols) = 0 or position('direction' in v_cols) = 0 then
      raise exception 'COMPANY_BUDGET_LEDGER_REQUIRED_COLUMNS_MISSING';
    end if;

    execute format('insert into public.company_budget_ledger (%s) select %s returning id', v_cols, v_values)
      into v_ledger_id
      using v_ledger_json;
  elsif v_ledger_count = 1 then
    if abs(v_ledger_sum - v_item_sum) > 0.05 then
      raise exception 'LEDGER_AMOUNT_MISMATCH handoff=% ledger=%', v_item_sum, v_ledger_sum;
    end if;
  else
    raise exception 'DUPLICATE_LEDGER_FOR_HANDOFF:%', v_handoff_id;
  end if;

  -- Recalculate summary from ledger truth.
  update public.company_budget_summary
  set
    total_in = (
      select round(coalesce(sum(amount),0)::numeric,2)
      from public.company_budget_ledger
      where upper(direction) = 'IN'
    ),
    total_out = (
      select round(coalesce(sum(amount),0)::numeric,2)
      from public.company_budget_ledger
      where upper(direction) = 'OUT'
    )
  where id = 1;

  if exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='company_budget_summary' and column_name='current_balance'
  ) then
    execute '
      update public.company_budget_summary
      set current_balance = round(coalesce(total_in,0)::numeric - coalesce(total_out,0)::numeric, 2)
      where id = 1';
  end if;

  -- Final verification.
  select count(*)::integer, round(coalesce(sum(amount),0)::numeric,2)
    into v_ledger_count, v_ledger_sum
  from public.company_budget_ledger
  where source_type = 'cash_handoff'
    and source_id = v_handoff_id;

  if v_ledger_count <> 1 then
    raise exception 'ACCEPT_VERIFY_LEDGER_ROW_COUNT:%', v_ledger_count;
  end if;

  if abs(v_ledger_sum - v_item_sum) > 0.05 then
    raise exception 'ACCEPT_VERIFY_LEDGER_AMOUNT_MISMATCH handoff=% ledger=%', v_item_sum, v_ledger_sum;
  end if;

  if coalesce(array_length(v_payment_ids, 1), 0) > 0 then
    select count(*)::integer
      into v_payment_count
    from public.arka_pending_payments
    where id = any(v_payment_ids)
      and upper(coalesce(status,'')) = 'ACCEPTED_BY_DISPATCH';

    if v_payment_count <> array_length(v_payment_ids, 1) then
      raise exception 'ACCEPT_VERIFY_PAYMENT_COUNT_MISMATCH expected=% actual=%', array_length(v_payment_ids, 1), v_payment_count;
    end if;
  end if;

  select
    (
      (select total_in from public.company_budget_summary where id=1)
      -
      (select round(coalesce(sum(amount),0)::numeric,2) from public.company_budget_ledger where upper(direction)='IN')
    ),
    (
      (select total_out from public.company_budget_summary where id=1)
      -
      (select round(coalesce(sum(amount),0)::numeric,2) from public.company_budget_ledger where upper(direction)='OUT')
    )
  into v_summary_diff_in, v_summary_diff_out;

  if abs(coalesce(v_summary_diff_in,0)) > 0.01 or abs(coalesce(v_summary_diff_out,0)) > 0.01 then
    raise exception 'ACCEPT_VERIFY_SUMMARY_DIFF in=% out=%', v_summary_diff_in, v_summary_diff_out;
  end if;

  return jsonb_build_object(
    'ok', true,
    'alreadyAccepted', v_status = 'ACCEPTED',
    'handoffId', v_handoff_id,
    'handoff', (
      select to_jsonb(h)
      from public.cash_handoffs h
      where h.id = v_handoff_id
    ),
    'ledger', (
      select to_jsonb(l)
      from public.company_budget_ledger l
      where l.source_type='cash_handoff' and l.source_id=v_handoff_id
      order by l.id desc
      limit 1
    ),
    'verification', jsonb_build_object(
      'acceptedCommitted', true,
      'handoffId', v_handoff_id,
      'amount', v_item_sum,
      'itemCount', v_item_count,
      'itemSum', v_item_sum,
      'paymentCount', coalesce(array_length(v_payment_ids, 1), 0),
      'ledgerCount', v_ledger_count,
      'ledgerAmount', v_ledger_sum,
      'summary', jsonb_build_object('diffIn', v_summary_diff_in, 'diffOut', v_summary_diff_out)
    )
  );
end;
$$;

grant execute on function public.accept_cash_handoff_atomic(bigint,text,text) to anon, authenticated;
