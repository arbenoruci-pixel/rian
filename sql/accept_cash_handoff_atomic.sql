-- ARKA single-pipeline DB RPC for atomic dispatch acceptance.
-- Apply manually in Supabase SQL editor.
-- This creates/replaces a function only; it does not alter ARKA table structure.
-- The function is defensive around optional legacy columns by using information_schema
-- and dynamic column lists for cash_handoffs / arka_pending_payments updates.

create or replace function public.accept_cash_handoff_atomic(
  handoff_id bigint,
  accepted_by_pin text,
  accepted_by_name text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_handoff public.cash_handoffs%rowtype;
  v_item_sum numeric := 0;
  v_item_count integer := 0;
  v_missing_payment_count integer := 0;
  v_existing_ledger_id text := null;
  v_ledger_id text := null;
  v_now timestamptz := now();
  v_worker_label text := '';
  v_handoff_patch jsonb := '{}'::jsonb;
  v_payment_patch jsonb := '{}'::jsonb;
  v_cols text := '';
  v_set_sql text := '';
  v_ledger_description text := '';
  v_ledger_json jsonb := '{}'::jsonb;
  v_insert_cols text := '';
  v_insert_values text := '';
begin
  select *
    into v_handoff
  from public.cash_handoffs h
  where h.id = $1
  for update;

  if not found then
    raise exception 'HANDOFF_NOT_FOUND';
  end if;

  if v_handoff.status = 'ACCEPTED' then
    return jsonb_build_object(
      'ok', true,
      'alreadyAccepted', true,
      'handoff', to_jsonb(v_handoff)
    );
  end if;

  if v_handoff.status <> 'PENDING_DISPATCH_APPROVAL' then
    raise exception 'HANDOFF_STATUS_NOT_PENDING_DISPATCH_APPROVAL: %', v_handoff.status;
  end if;

  select
    coalesce(sum(coalesce(i.amount, 0)), 0)::numeric,
    count(*)::integer
    into v_item_sum, v_item_count
  from public.cash_handoff_items i
  where i.handoff_id = $1;

  if v_item_count <= 0 then
    raise exception 'HANDOFF_HAS_NO_ITEMS';
  end if;

  if abs(coalesce(v_handoff.amount, 0)::numeric - coalesce(v_item_sum, 0)::numeric) > 0.01 then
    raise exception 'HANDOFF_AMOUNT_MISMATCH handoff=% items=%', v_handoff.amount, v_item_sum;
  end if;

  select count(*)::integer
    into v_missing_payment_count
  from public.cash_handoff_items i
  left join public.arka_pending_payments p on p.id = i.pending_payment_id
  where i.handoff_id = $1
    and p.id is null;

  if v_missing_payment_count > 0 then
    raise exception 'HANDOFF_HAS_MISSING_PAYMENTS: %', v_missing_payment_count;
  end if;

  perform 1
  from public.arka_pending_payments p
  join public.cash_handoff_items i on i.pending_payment_id = p.id
  where i.handoff_id = $1
  for update of p;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'company_budget_ledger' and column_name = 'source_type'
  ) or not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'company_budget_ledger' and column_name = 'source_id'
  ) then
    raise exception 'COMPANY_BUDGET_LEDGER_SOURCE_COLUMNS_REQUIRED';
  end if;

  execute
    'select id::text from public.company_budget_ledger where source_type = $1 and source_id::text = $2 limit 1'
    into v_existing_ledger_id
    using 'cash_handoff', $1::text;

  v_worker_label := coalesce(
    nullif(to_jsonb(v_handoff)->>'worker_name', ''),
    nullif(to_jsonb(v_handoff)->>'driver_name', ''),
    nullif(to_jsonb(v_handoff)->>'worker_pin', ''),
    nullif(to_jsonb(v_handoff)->>'driver_pin', ''),
    'PUNTOR'
  );
  v_ledger_description := concat('PRANIM NGA DISPATCH — ', v_worker_label);

  if v_existing_ledger_id is null then
    v_ledger_json := jsonb_build_object(
      'direction', 'IN',
      'amount', round(coalesce(v_handoff.amount, v_item_sum)::numeric, 2),
      'category', 'WORKER_TO_DISPATCH',
      'description', v_ledger_description,
      'source_type', 'cash_handoff',
      'source_id', $1::text,
      'created_by_pin', nullif($2, ''),
      'created_by_name', nullif($3, ''),
      'approved_by_pin', nullif($2, ''),
      'approved_by_name', nullif($3, '')
    );

    select
      string_agg(quote_ident(c.column_name), ', ' order by c.ordinality),
      string_agg(format('(jsonb_populate_record(null::public.company_budget_ledger, $1)).%I', c.column_name), ', ' order by c.ordinality)
      into v_insert_cols, v_insert_values
    from unnest(array['direction','amount','category','description','source_type','source_id','created_by_pin','created_by_name','approved_by_pin','approved_by_name']) with ordinality as c(column_name, ordinality)
    join information_schema.columns ic
      on ic.table_schema = 'public'
     and ic.table_name = 'company_budget_ledger'
     and ic.column_name = c.column_name;

    if v_insert_cols is null or position('direction' in v_insert_cols) = 0 or position('amount' in v_insert_cols) = 0 then
      raise exception 'COMPANY_BUDGET_LEDGER_REQUIRED_COLUMNS_MISSING';
    end if;

    execute format('insert into public.company_budget_ledger (%s) select %s returning id::text', v_insert_cols, v_insert_values)
      into v_ledger_id
      using v_ledger_json;

    insert into public.company_budget_summary (id, current_balance, total_in, total_out)
    values (1, 0, 0, 0)
    on conflict (id) do nothing;

    update public.company_budget_summary
    set
      current_balance = coalesce(current_balance, 0) + round(coalesce(v_handoff.amount, v_item_sum)::numeric, 2),
      total_in = coalesce(total_in, 0) + round(coalesce(v_handoff.amount, v_item_sum)::numeric, 2)
    where id = 1;
  else
    v_ledger_id := v_existing_ledger_id;
  end if;

  v_handoff_patch := jsonb_build_object(
    'status', 'ACCEPTED',
    'decided_at', v_now,
    'accepted_at', v_now,
    'accepted_by_pin', nullif($2, ''),
    'accepted_by_name', nullif($3, ''),
    'dispatch_pin', nullif($2, ''),
    'updated_at', v_now
  );

  select string_agg(format('%I = (jsonb_populate_record(null::public.cash_handoffs, $2)).%I', c.column_name, c.column_name), ', ' order by c.ordinality)
    into v_set_sql
  from unnest(array['status','decided_at','accepted_at','accepted_by_pin','accepted_by_name','dispatch_pin','updated_at']) with ordinality as c(column_name, ordinality)
  join information_schema.columns ic
    on ic.table_schema = 'public'
   and ic.table_name = 'cash_handoffs'
   and ic.column_name = c.column_name;

  if v_set_sql is null or v_set_sql = '' then
    raise exception 'CASH_HANDOFFS_STATUS_COLUMN_REQUIRED';
  end if;

  execute format('update public.cash_handoffs set %s where id = $1 returning *', v_set_sql)
    into v_handoff
    using $1, v_handoff_patch;

  v_payment_patch := jsonb_build_object(
    'status', 'ACCEPTED_BY_DISPATCH',
    'accepted_at', v_now,
    'accepted_by_pin', nullif($2, ''),
    'accepted_by_name', nullif($3, ''),
    'approved_at', v_now,
    'approved_by_pin', nullif($2, ''),
    'approved_by_name', nullif($3, ''),
    'updated_at', v_now
  );

  select string_agg(format('%I = (jsonb_populate_record(null::public.arka_pending_payments, $2)).%I', c.column_name, c.column_name), ', ' order by c.ordinality)
    into v_set_sql
  from unnest(array['status','accepted_at','accepted_by_pin','accepted_by_name','approved_at','approved_by_pin','approved_by_name','updated_at']) with ordinality as c(column_name, ordinality)
  join information_schema.columns ic
    on ic.table_schema = 'public'
   and ic.table_name = 'arka_pending_payments'
   and ic.column_name = c.column_name;

  if v_set_sql is null or position('status =' in v_set_sql) = 0 then
    raise exception 'ARKA_PENDING_PAYMENTS_STATUS_COLUMN_REQUIRED';
  end if;

  execute format(
    'update public.arka_pending_payments p set %s where p.id in (select i.pending_payment_id from public.cash_handoff_items i where i.handoff_id = $1)',
    v_set_sql
  ) using $1, v_payment_patch;

  return jsonb_build_object(
    'ok', true,
    'alreadyAccepted', false,
    'handoff', to_jsonb(v_handoff),
    'ledger_id', v_ledger_id,
    'amount', round(coalesce(v_handoff.amount, v_item_sum)::numeric, 2)
  );
end;
$$;
