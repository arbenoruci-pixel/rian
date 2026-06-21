-- ARKA single-pipeline DB RPC for atomic worker cash handoff submission.
-- Apply manually in Supabase SQL editor together with accept_cash_handoff_atomic.sql.
-- This creates/replaces a function only; it does not alter ARKA table structure.
-- Live schema note: arka_pending_payments has no handoff_id column. The payment
-- handoff relation is cash_handoff_items.pending_payment_id -> arka_pending_payments.id
-- and cash_handoff_items.handoff_id -> cash_handoffs.id.
-- The function adapts to optional live columns in cash_handoffs, cash_handoff_items,
-- and arka_pending_payments by building inserts/updates from information_schema.

create or replace function public.submit_cash_handoff_atomic(
  actor_pin text,
  actor_name text default null,
  actor_role text default null,
  payment_ids bigint[] default null,
  amount_declared numeric default null,
  handoff_note text default null,
  idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_pin text := nullif(trim(coalesce(actor_pin, '')), '');
  v_actor_name text := nullif(trim(coalesce(actor_name, '')), '');
  v_actor_role text := nullif(trim(coalesce(actor_role, '')), '');
  v_ids bigint[] := array[]::bigint[];
  v_requested_count integer := 0;
  v_locked_count integer := 0;
  v_bad_count integer := 0;
  v_actor_mismatch_count integer := 0;
  v_existing_handoff_id bigint := null;
  v_handoff public.cash_handoffs%rowtype;
  v_amount numeric := 0;
  v_item_sum numeric := 0;
  v_item_count integer := 0;
  v_is_hybrid boolean := false;
  v_commission_rate numeric := 0;
  v_now timestamptz := now();
  v_handoff_json jsonb := '{}'::jsonb;
  v_payment_patch jsonb := '{}'::jsonb;
  v_items_json jsonb := '[]'::jsonb;
  v_cols text := '';
  v_values text := '';
  v_set_sql text := '';
  v_item_cols text := '';
  v_item_values text := '';
begin
  if v_actor_pin is null then
    raise exception 'ACTOR_PIN_REQUIRED';
  end if;

  if to_regclass('public.users') is not null
     and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'users' and column_name = 'pin')
     and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'users' and column_name = 'is_hybrid_transport')
     and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'users' and column_name = 'commission_rate_m2') then
    execute 'select coalesce(is_hybrid_transport, false), coalesce(commission_rate_m2, 0)::numeric from public.users where trim(coalesce(pin::text, '''')) = $1 limit 1'
      into v_is_hybrid, v_commission_rate
      using v_actor_pin;
  end if;

  v_is_hybrid := coalesce(v_is_hybrid, false);
  v_commission_rate := coalesce(v_commission_rate, 0);

  if payment_ids is not null and array_length(payment_ids, 1) is not null then
    select coalesce(array_agg(distinct x order by x), array[]::bigint[])
      into v_ids
    from unnest(payment_ids) as x
    where x is not null and x > 0;
  else
    select coalesce(array_agg(id order by id), array[]::bigint[])
      into v_ids
    from (
      select p.id
      from public.arka_pending_payments p
      where (
          trim(coalesce(to_jsonb(p)->>'created_by_pin', '')) = v_actor_pin
          or trim(coalesce(to_jsonb(p)->>'handed_by_pin', '')) = v_actor_pin
        )
        and p.status in ('PENDING', 'COLLECTED')
        and coalesce(p.amount, 0) > 0
        and upper(coalesce(to_jsonb(p)->>'type', '')) not in ('EXPENSE', 'TIMA', 'MEAL_PAYMENT', 'MEAL_COVERED', 'ADVANCE')
        and not exists (
          select 1
          from public.cash_handoff_items i
          join public.cash_handoffs h on h.id = i.handoff_id
          where i.pending_payment_id = p.id
            and h.status in ('PENDING_DISPATCH_APPROVAL', 'ACCEPTED')
        )
      order by p.id asc
      for update
    ) ready;
  end if;

  v_requested_count := coalesce(array_length(v_ids, 1), 0);
  if v_requested_count <= 0 then
    raise exception 'NO_READY_PAYMENTS_FOR_HANDOFF';
  end if;

  perform 1
  from public.arka_pending_payments p
  where p.id = any(v_ids)
  for update;

  select count(*)::integer
    into v_locked_count
  from public.arka_pending_payments p
  where p.id = any(v_ids);

  if v_locked_count <> v_requested_count then
    raise exception 'HANDOFF_PAYMENT_MISSING requested=% locked=%', v_requested_count, v_locked_count;
  end if;

  -- Idempotent retry: if exactly these payments already belong to the same pending
  -- handoff via cash_handoff_items, return that handoff instead of creating another.
  with candidate as (
    select i.handoff_id, count(distinct i.pending_payment_id)::integer as matched_count
    from public.cash_handoff_items i
    join public.cash_handoffs h on h.id = i.handoff_id
    where i.pending_payment_id = any(v_ids)
      and h.status = 'PENDING_DISPATCH_APPROVAL'
    group by i.handoff_id
  )
  select c.handoff_id
    into v_existing_handoff_id
  from candidate c
  where c.matched_count = v_requested_count
    and (
      select count(distinct i2.pending_payment_id)::integer
      from public.cash_handoff_items i2
      where i2.handoff_id = c.handoff_id
    ) = v_requested_count
  order by c.handoff_id desc
  limit 1;

  if v_existing_handoff_id is not null then
    select * into v_handoff
    from public.cash_handoffs h
    where h.id = v_existing_handoff_id
      and h.status = 'PENDING_DISPATCH_APPROVAL';

    if found then
      return jsonb_build_object(
        'ok', true,
        'alreadySubmitted', true,
        'handoff', to_jsonb(v_handoff),
        'count', v_requested_count,
        'total', round(coalesce(v_handoff.amount, 0)::numeric, 2)
      );
    end if;
  end if;

  select count(*)::integer
    into v_bad_count
  from public.arka_pending_payments p
  where p.id = any(v_ids)
    and not (
      p.status in ('PENDING', 'COLLECTED')
      and coalesce(p.amount, 0) > 0
      and upper(coalesce(to_jsonb(p)->>'type', '')) not in ('EXPENSE', 'TIMA', 'MEAL_PAYMENT', 'MEAL_COVERED', 'ADVANCE')
      and not exists (
        select 1
        from public.cash_handoff_items i
        join public.cash_handoffs h on h.id = i.handoff_id
        where i.pending_payment_id = p.id
          and h.status in ('PENDING_DISPATCH_APPROVAL', 'ACCEPTED')
      )
    );

  if v_bad_count > 0 then
    raise exception 'PAYMENT_NOT_READY_FOR_HANDOFF: %', v_bad_count;
  end if;

  select count(*)::integer
    into v_actor_mismatch_count
  from public.arka_pending_payments p
  where p.id = any(v_ids)
    and (
      nullif(trim(coalesce(to_jsonb(p)->>'created_by_pin', '')), '') is not null
      or nullif(trim(coalesce(to_jsonb(p)->>'handed_by_pin', '')), '') is not null
    )
    and v_actor_pin not in (
      trim(coalesce(to_jsonb(p)->>'created_by_pin', '')),
      trim(coalesce(to_jsonb(p)->>'handed_by_pin', ''))
    );

  if v_actor_mismatch_count > 0 then
    raise exception 'PAYMENT_ACTOR_MISMATCH: %', v_actor_mismatch_count;
  end if;

  with ready as (
    select
      p.*,
      to_jsonb(p) as j,
      (
        upper(coalesce(to_jsonb(p)->>'source_module', '')) = 'TRANSPORT'
        or upper(coalesce(to_jsonb(p)->>'type', '')) = 'TRANSPORT'
        or nullif(to_jsonb(p)->>'transport_order_id', '') is not null
        or upper(coalesce(to_jsonb(p)->>'transport_code_str', '')) like 'T%'
      ) as is_transport,
      case
        when coalesce(to_jsonb(p)->>'transport_m2', '') ~ '^-?[0-9]+(\.[0-9]+)?$' then (to_jsonb(p)->>'transport_m2')::numeric
        else 0::numeric
      end as transport_m2_num
    from public.arka_pending_payments p
    where p.id = any(v_ids)
  )
  select round(coalesce(sum(
    case
      when is_transport and v_is_hybrid then
        greatest(0, coalesce(amount, 0)::numeric - least(coalesce(amount, 0)::numeric, transport_m2_num * v_commission_rate))
      else coalesce(amount, 0)::numeric
    end
  ), 0), 2)
    into v_amount
  from ready;

  if v_amount <= 0 then
    raise exception 'HANDOFF_AMOUNT_ZERO';
  end if;

  if amount_declared is not null and amount_declared > 0 and abs(round(amount_declared::numeric, 2) - v_amount) > 0.05 then
    raise exception 'HANDOFF_DECLARED_AMOUNT_MISMATCH declared=% computed=%', amount_declared, v_amount;
  end if;

  v_handoff_json := jsonb_build_object(
    'worker_pin', v_actor_pin,
    'worker_name', coalesce(v_actor_name, v_actor_pin),
    'driver_pin', v_actor_pin,
    'driver_name', coalesce(v_actor_name, v_actor_pin),
    'amount', v_amount,
    'total_amount', v_amount,
    'count_clients', v_requested_count,
    'status', 'PENDING_DISPATCH_APPROVAL',
    'submitted_at', v_now,
    'note', nullif(trim(coalesce(handoff_note, '')), ''),
    'payment_ids', v_ids,
    'order_ids', (
      select coalesce(array_agg(distinct (to_jsonb(p)->>'order_id')::bigint) filter (where coalesce(to_jsonb(p)->>'order_id', '') ~ '^\d+$'), array[]::bigint[])
      from public.arka_pending_payments p
      where p.id = any(v_ids)
    ),
    'data', jsonb_build_object(
      'kind', 'cash_handoff',
      'payment_ids', v_ids,
      'total_amount', v_amount,
      'count_clients', v_requested_count,
      'idempotency_key', nullif(trim(coalesce(idempotency_key, '')), '')
    ),
    'updated_at', v_now
  );

  select
    string_agg(quote_ident(c.column_name), ', ' order by c.ordinality),
    string_agg(format('(jsonb_populate_record(null::public.cash_handoffs, $1)).%I', c.column_name), ', ' order by c.ordinality)
    into v_cols, v_values
  from unnest(array['worker_pin','worker_name','driver_pin','driver_name','amount','total_amount','count_clients','status','submitted_at','note','payment_ids','order_ids','data','updated_at']) with ordinality as c(column_name, ordinality)
  join information_schema.columns ic
    on ic.table_schema = 'public'
   and ic.table_name = 'cash_handoffs'
   and ic.column_name = c.column_name;

  if v_cols is null or position('amount' in v_cols) = 0 or position('status' in v_cols) = 0 then
    raise exception 'CASH_HANDOFFS_REQUIRED_COLUMNS_MISSING';
  end if;

  execute format('insert into public.cash_handoffs (%s) select %s returning *', v_cols, v_values)
    into v_handoff
    using v_handoff_json;

  with ready as (
    select
      p.*,
      to_jsonb(p) as j,
      (
        upper(coalesce(to_jsonb(p)->>'source_module', '')) = 'TRANSPORT'
        or upper(coalesce(to_jsonb(p)->>'type', '')) = 'TRANSPORT'
        or nullif(to_jsonb(p)->>'transport_order_id', '') is not null
        or upper(coalesce(to_jsonb(p)->>'transport_code_str', '')) like 'T%'
      ) as is_transport,
      case
        when coalesce(to_jsonb(p)->>'transport_m2', '') ~ '^-?[0-9]+(\.[0-9]+)?$' then (to_jsonb(p)->>'transport_m2')::numeric
        else 0::numeric
      end as transport_m2_num
    from public.arka_pending_payments p
    where p.id = any(v_ids)
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'handoff_id', v_handoff.id,
    'pending_payment_id', id,
    'order_id', case
      when is_transport then null
      when coalesce(j->>'order_id', '') ~ '^\d+$' then (j->>'order_id')::bigint
      else null
    end,
    'order_code', case when is_transport then null else coalesce(j->>'order_code', j->>'code') end,
    'source_module', case when is_transport then 'TRANSPORT' else 'BASE' end,
    'transport_order_id', case when is_transport then nullif(j->>'transport_order_id', '') else null end,
    'transport_code_str', case when is_transport then nullif(j->>'transport_code_str', '') else null end,
    'transport_m2', case when is_transport then transport_m2_num else 0 end,
    'amount', round(case
      when is_transport and v_is_hybrid then
        greatest(0, coalesce(amount, 0)::numeric - least(coalesce(amount, 0)::numeric, transport_m2_num * v_commission_rate))
      else coalesce(amount, 0)::numeric
    end, 2)
  )), '[]'::jsonb)
    into v_items_json
  from ready;

  select
    string_agg(quote_ident(c.column_name), ', ' order by c.ordinality),
    string_agg(format('x.%I', c.column_name), ', ' order by c.ordinality)
    into v_item_cols, v_item_values
  from unnest(array['handoff_id','pending_payment_id','order_id','order_code','source_module','transport_order_id','transport_code_str','transport_m2','amount']) with ordinality as c(column_name, ordinality)
  join information_schema.columns ic
    on ic.table_schema = 'public'
   and ic.table_name = 'cash_handoff_items'
   and ic.column_name = c.column_name;

  if v_item_cols is null or position('handoff_id' in v_item_cols) = 0 or position('pending_payment_id' in v_item_cols) = 0 or position('amount' in v_item_cols) = 0 then
    raise exception 'CASH_HANDOFF_ITEMS_REQUIRED_COLUMNS_MISSING';
  end if;

  execute format(
    'insert into public.cash_handoff_items (%s) select %s from jsonb_populate_recordset(null::public.cash_handoff_items, $1) as x',
    v_item_cols,
    v_item_values
  ) using v_items_json;

  get diagnostics v_item_count = row_count;
  if v_item_count <> v_requested_count then
    raise exception 'HANDOFF_ITEM_COUNT_MISMATCH requested=% inserted=%', v_requested_count, v_item_count;
  end if;

  v_payment_patch := jsonb_build_object(
    'status', 'PENDING_DISPATCH_APPROVAL',
    'submitted_at', v_now,
    'handed_at', v_now,
    'handed_by_pin', v_actor_pin,
    'handed_by_name', v_actor_name,
    'handed_by_role', v_actor_role,
    'handoff_note', concat('Handoff #', v_handoff.id),
    'updated_at', v_now
  );

  select string_agg(format('%I = (jsonb_populate_record(null::public.arka_pending_payments, $2)).%I', c.column_name, c.column_name), ', ' order by c.ordinality)
    into v_set_sql
  from unnest(array['status','submitted_at','handed_at','handed_by_pin','handed_by_name','handed_by_role','handoff_note','updated_at']) with ordinality as c(column_name, ordinality)
  join information_schema.columns ic
    on ic.table_schema = 'public'
   and ic.table_name = 'arka_pending_payments'
   and ic.column_name = c.column_name;

  if v_set_sql is null or position('status =' in v_set_sql) = 0 then
    raise exception 'ARKA_PENDING_PAYMENTS_STATUS_COLUMN_REQUIRED';
  end if;

  execute format(
    'update public.arka_pending_payments p set %s where p.id = any($1) and p.status in (''PENDING'', ''COLLECTED'')',
    v_set_sql
  ) using v_ids, v_payment_patch;

  get diagnostics v_locked_count = row_count;
  if v_locked_count <> v_requested_count then
    raise exception 'HANDOFF_PAYMENT_CLAIM_COUNT_MISMATCH requested=% updated=%', v_requested_count, v_locked_count;
  end if;

  select coalesce(sum(i.amount), 0)::numeric, count(*)::integer
    into v_item_sum, v_item_count
  from public.cash_handoff_items i
  where i.handoff_id = v_handoff.id;

  if v_item_count <> v_requested_count then
    raise exception 'HANDOFF_ITEM_COUNT_MISMATCH requested=% inserted=%', v_requested_count, v_item_count;
  end if;

  if abs(coalesce(v_item_sum, 0)::numeric - coalesce(v_handoff.amount, 0)::numeric) > 0.05 then
    raise exception 'HANDOFF_ITEM_SUM_MISMATCH handoff=% items=%', v_handoff.amount, v_item_sum;
  end if;

  return jsonb_build_object(
    'ok', true,
    'alreadySubmitted', false,
    'handoff', to_jsonb(v_handoff),
    'count', v_requested_count,
    'total', round(coalesce(v_handoff.amount, v_amount)::numeric, 2)
  );
end;
$$;
