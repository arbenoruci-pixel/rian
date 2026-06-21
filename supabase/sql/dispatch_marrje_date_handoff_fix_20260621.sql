-- DISPATCH / MARRJE DATE + ARKA HANDOFF LEDGER FIX V38 — 2026-06-21
-- Safe/idempotent for this incident.
-- Fixes:
-- 1) future dispatch accept RPC writes cash_handoffs.company_ledger_entry_id
-- 2) already accepted handoffs can repair missing ledger link on re-run
-- 3) backfills accepted handoffs that already have a ledger row but no link
-- 4) rejects the two false PENDING rows created by the old Marrje updated_at filter

begin;

-- Backup current incident rows before touching them.
create table if not exists public.backup_dispatch_marrje_handoff_fix_20260621_cash_handoffs as
select * from public.cash_handoffs where id = 260;

create table if not exists public.backup_dispatch_marrje_handoff_fix_20260621_pending_payments as
select * from public.arka_pending_payments where id in (1617, 1618);

-- Replace RPC with ledger-link hardening.
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
    -- Idempotent repair for older accepted handoffs: if the ledger row exists
    -- but cash_handoffs.company_ledger_entry_id was not written by the older
    -- RPC body, link it now instead of returning a half-linked handoff.
    begin
      execute
        'select id::text from public.company_budget_ledger where source_type = $1 and source_id::text = $2 limit 1'
        into v_existing_ledger_id
        using 'cash_handoff', $1::text;

      if v_existing_ledger_id is not null and exists (
        select 1 from information_schema.columns
        where table_schema = 'public'
          and table_name = 'cash_handoffs'
          and column_name = 'company_ledger_entry_id'
      ) then
        execute
          'update public.cash_handoffs set company_ledger_entry_id = $2::bigint where id = $1 and company_ledger_entry_id is null returning *'
          into v_handoff
          using $1, v_existing_ledger_id;
      end if;
    exception when others then
      -- Keep accept idempotency safe even on older schemas.
      null;
    end;

    return jsonb_build_object(
      'ok', true,
      'alreadyAccepted', true,
      'handoff', to_jsonb(v_handoff),
      'ledger_id', v_existing_ledger_id
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
    'company_ledger_entry_id', case when v_ledger_id ~ '^[0-9]+$' then v_ledger_id::bigint else null end,
    'updated_at', v_now
  );

  select string_agg(format('%I = (jsonb_populate_record(null::public.cash_handoffs, $2)).%I', c.column_name, c.column_name), ', ' order by c.ordinality)
    into v_set_sql
  from unnest(array['status','decided_at','accepted_at','accepted_by_pin','accepted_by_name','dispatch_pin','company_ledger_entry_id','updated_at']) with ordinality as c(column_name, ordinality)
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

grant execute on function public.accept_cash_handoff_atomic(bigint, text, text) to anon, authenticated, service_role;

-- Backfill any accepted cash handoff where the ledger exists but company_ledger_entry_id is still null.
update public.cash_handoffs ch
set company_ledger_entry_id = cbl.id
from public.company_budget_ledger cbl
where ch.status = 'ACCEPTED'
  and ch.company_ledger_entry_id is null
  and cbl.source_type = 'cash_handoff'
  and cbl.source_id::text = ch.id::text;

-- Close the two false pending payments from the old Marrje date bug.
-- These came from orders that were only updated today, not actually delivered/picked today.
update public.arka_pending_payments app
set status = 'REJECTED',
    note = concat_ws(' | ', nullif(app.note, ''), 'AUTO_REJECT_FALSE_PENDING_UPDATED_AT_DATE_FILTER_20260621'),
    handoff_note = concat_ws(' | ', nullif(app.handoff_note, ''), 'AUTO_REJECT_FALSE_PENDING_UPDATED_AT_DATE_FILTER_20260621'),
    updated_at = now()
where app.id in (1617, 1618)
  and app.status = 'PENDING'
  and app.created_by_pin::text = '2020'
  and app.order_id in (2071, 2120)
  and not exists (
    select 1
    from public.cash_handoff_items chi
    where chi.pending_payment_id = app.id
  );

commit;

-- Verification result: should show handoff_260 linked to ledger 282, and payments 1617/1618 REJECTED.
select
  'HANDOFF_260_LEDGER_LINK' as check_name,
  ch.id as handoff_id,
  ch.status as handoff_status,
  ch.amount as handoff_amount,
  ch.company_ledger_entry_id,
  cbl.id as ledger_id,
  cbl.amount as ledger_amount,
  cbl.direction as ledger_direction,
  cbl.category as ledger_category
from public.cash_handoffs ch
left join public.company_budget_ledger cbl
  on cbl.source_type = 'cash_handoff'
 and cbl.source_id::text = ch.id::text
where ch.id = 260

union all

select
  'FALSE_PENDING_PAYMENT_CLOSED' as check_name,
  null::bigint as handoff_id,
  app.status as handoff_status,
  app.amount as handoff_amount,
  null::bigint as company_ledger_entry_id,
  app.id as ledger_id,
  app.amount as ledger_amount,
  null::text as ledger_direction,
  app.client_name as ledger_category
from public.arka_pending_payments app
where app.id in (1617, 1618)
order by check_name, ledger_id;
