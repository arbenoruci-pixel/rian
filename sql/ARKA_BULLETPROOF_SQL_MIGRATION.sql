-- ARKA BULLETPROOF HARDENING MIGRATION V1
-- Apply manually in Supabase SQL Editor before deploying the matching app code.
-- Additive/backward-compatible: no table/column/status rename, no live data delete.
-- Creates backup tables, idempotency indexes, atomic meal distribution, and an
-- extended atomic handoff submit RPC that settles meals inside one transaction.

begin;

create table if not exists public.bak_arka_pending_payments_bulletproof_v1 as table public.arka_pending_payments;
create table if not exists public.bak_cash_handoffs_bulletproof_v1 as table public.cash_handoffs;
create table if not exists public.bak_cash_handoff_items_bulletproof_v1 as table public.cash_handoff_items;
create table if not exists public.bak_company_budget_ledger_bulletproof_v1 as table public.company_budget_ledger;
create table if not exists public.bak_company_budget_summary_bulletproof_v1 as table public.company_budget_summary;

commit;

-- These indexes are safe only if validation shows no duplicates. If CREATE UNIQUE
-- fails, stop, inspect ARKA_BULLETPROOF_VALIDATION.sql duplicate reports, and do
-- not continue blindly.
create unique index concurrently if not exists arka_pending_payments_idemp_uidx
  on public.arka_pending_payments (idempotency_key)
  where idempotency_key is not null;

create unique index concurrently if not exists company_budget_ledger_source_uidx
  on public.company_budget_ledger (source_type, source_id)
  where source_type is not null and source_id is not null;

-- Atomic creation of one meal group: 1 payer MEAL_PAYMENT + N MEAL_COVERED rows.
create or replace function public.create_meal_distribution_atomic(
  actor_pin text,
  actor_name text default null,
  actor_role text default null,
  payer_pin text default null,
  payer_name text default null,
  payer_role text default null,
  meal_day text default null,
  amount_per_person numeric default 3,
  targets jsonb default '[]'::jsonb,
  note text default null,
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
  v_payer_pin text := nullif(trim(coalesce(payer_pin, actor_pin, '')), '');
  v_payer_name text := nullif(trim(coalesce(payer_name, actor_name, payer_pin, actor_pin, '')), '');
  v_payer_role text := nullif(trim(coalesce(payer_role, actor_role, 'WORKER')), '');
  v_meal_day text := nullif(trim(coalesce(meal_day, '')), '');
  v_per numeric := round(coalesce(amount_per_person, 3)::numeric, 2);
  v_targets jsonb := coalesce(targets, '[]'::jsonb);
  v_target_count integer := 0;
  v_total numeric := 0;
  v_target_pins text := '';
  v_target_labels text := '';
  v_idem text := nullif(trim(coalesce(idempotency_key, '')), '');
  v_note text := nullif(trim(coalesce(note, 'USHQIM EKIPI')), '');
  v_now timestamptz := now();
  v_cols text;
  v_values text;
  v_payment_json jsonb;
  v_cover_json jsonb;
  v_payment public.arka_pending_payments%rowtype;
  v_cover public.arka_pending_payments%rowtype;
  v_rows jsonb := '[]'::jsonb;
  v_existing jsonb;
  t jsonb;
begin
  if v_actor_pin is null then raise exception 'ACTOR_PIN_REQUIRED'; end if;
  if v_payer_pin is null then raise exception 'PAYER_PIN_REQUIRED'; end if;
  if v_per <> 3 then raise exception 'MEAL_DAILY_AMOUNT_MUST_BE_3'; end if;
  if v_meal_day is null then v_meal_day := to_char((now() at time zone 'Europe/Belgrade')::date, 'YYYY-MM-DD'); end if;
  if v_meal_day !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'MEAL_DAY_INVALID'; end if;
  if jsonb_typeof(v_targets) <> 'array' then raise exception 'MEAL_TARGETS_REQUIRED'; end if;

  if v_idem is not null then
    select jsonb_agg(to_jsonb(p) order by p.id) into v_existing
    from public.arka_pending_payments p
    where p.idempotency_key = v_idem
       or p.handoff_note ilike concat('%MEAL_DAY:', v_meal_day, '%MEAL_BY:', v_payer_pin, '%');
    if v_existing is not null and jsonb_array_length(v_existing) > 0 then
      return jsonb_build_object('ok', true, 'alreadyApplied', true, 'rows', v_existing);
    end if;
  end if;

  create temporary table if not exists pg_temp.arka_meal_targets(pin text primary key, name text, role text) on commit drop;
  truncate table pg_temp.arka_meal_targets;

  for t in select * from jsonb_array_elements(v_targets)
  loop
    if nullif(trim(coalesce(t->>'pin', t->>'workerPin', t->>'worker_pin', '')), '') is not null then
      insert into pg_temp.arka_meal_targets(pin, name, role)
      values (
        trim(coalesce(t->>'pin', t->>'workerPin', t->>'worker_pin')),
        nullif(trim(coalesce(t->>'name', t->>'workerName', t->>'worker_name', t->>'pin', 'PUNTOR')), ''),
        nullif(trim(coalesce(t->>'role', t->>'workerRole', t->>'worker_role', 'WORKER')), '')
      )
      on conflict (pin) do update set name = excluded.name, role = excluded.role;
    end if;
  end loop;

  select count(*)::integer, string_agg(pin, ',' order by pin), string_agg(coalesce(name, pin) || '(' || pin || ')', ', ' order by pin)
    into v_target_count, v_target_pins, v_target_labels
  from pg_temp.arka_meal_targets;
  if v_target_count <= 0 then raise exception 'MEAL_TARGETS_REQUIRED'; end if;

  -- One worker/day guard: a target is blocked if they already have a guarded same-day
  -- MEAL_COVERED row or any guarded same-day MEAL_PAYMENT targeting them.
  if exists (
    select 1
    from public.arka_pending_payments p
    cross join pg_temp.arka_meal_targets tgt
    where upper(coalesce(to_jsonb(p)->>'type','')) in ('MEAL_PAYMENT','MEAL_COVERED')
      and upper(coalesce(to_jsonb(p)->>'status','')) not in ('REJECTED','REFUZUAR','VOIDED','CANCELLED','CANCELED')
      and coalesce(to_jsonb(p)->>'handoff_note','') ilike concat('%MEAL_DAY:', v_meal_day, '%')
      and (
        coalesce(to_jsonb(p)->>'handoff_note','') ilike concat('%MEAL_FOR:', tgt.pin, '%')
        or coalesce(to_jsonb(p)->>'handoff_note','') ilike concat('%MEAL_TARGETS:%', tgt.pin, '%')
        or (upper(coalesce(to_jsonb(p)->>'type','')) = 'MEAL_PAYMENT' and trim(coalesce(to_jsonb(p)->>'created_by_pin','')) = tgt.pin and coalesce(to_jsonb(p)->>'handoff_note','') ilike concat('%MEAL_BY:', tgt.pin, '%'))
      )
  ) then
    raise exception 'MEAL_ALREADY_REGISTERED_TODAY';
  end if;

  v_total := round(v_per * v_target_count, 2);

  select
    string_agg(quote_ident(c.column_name), ', ' order by c.ordinality),
    string_agg(format('(jsonb_populate_record(null::public.arka_pending_payments, $1)).%I', c.column_name), ', ' order by c.ordinality)
    into v_cols, v_values
  from unnest(array['idempotency_key','amount','type','status','note','source_module','created_by_pin','created_by_name','created_by_role','approved_by_pin','approved_by_name','handed_at','handed_by_pin','handed_by_name','handed_by_role','handoff_note','created_at','updated_at']) with ordinality as c(column_name, ordinality)
  join information_schema.columns ic on ic.table_schema='public' and ic.table_name='arka_pending_payments' and ic.column_name=c.column_name;

  if v_cols is null or position('amount' in v_cols)=0 or position('type' in v_cols)=0 or position('status' in v_cols)=0 then
    raise exception 'ARKA_PENDING_PAYMENTS_REQUIRED_COLUMNS_MISSING';
  end if;

  v_payment_json := jsonb_build_object(
    'idempotency_key', v_idem,
    'amount', v_total,
    'type', 'MEAL_PAYMENT',
    'status', 'ACCEPTED_BY_DISPATCH',
    'note', concat(v_note, ' • 3.00€ × ', v_target_count),
    'source_module', 'ARKA',
    'created_by_pin', v_payer_pin,
    'created_by_name', v_payer_name,
    'created_by_role', v_payer_role,
    'approved_by_pin', v_actor_pin,
    'approved_by_name', v_actor_name,
    'handed_at', v_now,
    'handed_by_pin', v_actor_pin,
    'handed_by_name', v_actor_name,
    'handed_by_role', v_actor_role,
    'handoff_note', concat('MEAL_DAY:', v_meal_day, '|MEAL_OPEN:', v_meal_day, '|MEAL_BY:', v_payer_pin, '|MEAL_TARGETS:', v_target_pins, '|', v_target_labels),
    'created_at', v_now,
    'updated_at', v_now
  );

  execute format('insert into public.arka_pending_payments (%s) select %s returning *', v_cols, v_values)
    into v_payment using v_payment_json;
  v_rows := v_rows || jsonb_build_array(to_jsonb(v_payment));

  for t in select jsonb_build_object('pin', pin, 'name', name, 'role', role) from pg_temp.arka_meal_targets
  loop
    v_cover_json := jsonb_build_object(
      'idempotency_key', concat(coalesce(v_idem, concat('MEAL:', v_meal_day, ':', v_payer_pin)), ':COVERED:', t->>'pin'),
      'amount', 3,
      'type', 'MEAL_COVERED',
      'status', 'ACCEPTED_BY_DISPATCH',
      'note', case when t->>'pin' = v_payer_pin then concat(v_note, ' • AUTO PËR ', coalesce(t->>'name', t->>'pin')) else concat(v_note, ' • PAGUAR NGA ', v_payer_name) end,
      'source_module', 'ARKA',
      'created_by_pin', t->>'pin',
      'created_by_name', coalesce(t->>'name', t->>'pin'),
      'created_by_role', coalesce(t->>'role', 'WORKER'),
      'approved_by_pin', v_actor_pin,
      'approved_by_name', v_actor_name,
      'handed_at', v_now,
      'handed_by_pin', v_actor_pin,
      'handed_by_name', v_actor_name,
      'handed_by_role', v_actor_role,
      'handoff_note', concat('MEAL_DAY:', v_meal_day, '|MEAL_FOR:', t->>'pin', '|MEAL_BY:', v_payer_pin, case when t->>'pin'=v_payer_pin then '|SELF' else '|COVERED' end),
      'created_at', v_now,
      'updated_at', v_now
    );
    execute format('insert into public.arka_pending_payments (%s) select %s returning *', v_cols, v_values)
      into v_cover using v_cover_json;
    v_rows := v_rows || jsonb_build_array(to_jsonb(v_cover));
  end loop;

  return jsonb_build_object('ok', true, 'payment', to_jsonb(v_payment), 'rows', v_rows, 'count', v_target_count, 'total', v_total);
end;
$$;

-- Replace old submit RPC signature with a meal-aware atomic signature.
drop function if exists public.submit_cash_handoff_atomic(text,text,text,bigint[],numeric,text,text);

create or replace function public.submit_cash_handoff_atomic(
  actor_pin text,
  actor_name text default null,
  actor_role text default null,
  payment_ids bigint[] default null,
  amount_declared numeric default null,
  handoff_note text default null,
  idempotency_key text default null,
  meal_payment_ids bigint[] default null
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
  v_meal_ids bigint[] := array[]::bigint[];
  v_requested_count integer := 0;
  v_meal_count integer := 0;
  v_locked_count integer := 0;
  v_bad_count integer := 0;
  v_existing_handoff_id bigint := null;
  v_handoff public.cash_handoffs%rowtype;
  v_gross_amount numeric := 0;
  v_meal_total numeric := 0;
  v_amount numeric := 0;
  v_item_sum numeric := 0;
  v_item_count integer := 0;
  v_is_hybrid boolean := false;
  v_commission_rate numeric := 0;
  v_now timestamptz := now();
  v_handoff_json jsonb := '{}'::jsonb;
  v_payment_patch jsonb := '{}'::jsonb;
  v_meal_patch jsonb := '{}'::jsonb;
  v_items_json jsonb := '[]'::jsonb;
  v_cols text := '';
  v_values text := '';
  v_set_sql text := '';
  v_item_cols text := '';
  v_item_values text := '';
begin
  if v_actor_pin is null then raise exception 'ACTOR_PIN_REQUIRED'; end if;

  if to_regclass('public.users') is not null
     and exists (select 1 from information_schema.columns where table_schema='public' and table_name='users' and column_name='pin')
     and exists (select 1 from information_schema.columns where table_schema='public' and table_name='users' and column_name='is_hybrid_transport')
     and exists (select 1 from information_schema.columns where table_schema='public' and table_name='users' and column_name='commission_rate_m2') then
    execute 'select coalesce(is_hybrid_transport, false), coalesce(commission_rate_m2, 0)::numeric from public.users where trim(coalesce(pin::text, '''')) = $1 limit 1'
      into v_is_hybrid, v_commission_rate using v_actor_pin;
  end if;
  v_is_hybrid := coalesce(v_is_hybrid, false);
  v_commission_rate := coalesce(v_commission_rate, 0);

  if payment_ids is not null and array_length(payment_ids, 1) is not null then
    select coalesce(array_agg(distinct x order by x), array[]::bigint[]) into v_ids from unnest(payment_ids) as x where x is not null and x > 0;
  else
    select coalesce(array_agg(id order by id), array[]::bigint[]) into v_ids
    from (
      select p.id
      from public.arka_pending_payments p
      where (trim(coalesce(to_jsonb(p)->>'created_by_pin',''))=v_actor_pin or trim(coalesce(to_jsonb(p)->>'handed_by_pin',''))=v_actor_pin)
        and p.status in ('PENDING','COLLECTED')
        and coalesce(p.amount,0)>0
        and upper(coalesce(to_jsonb(p)->>'type','')) not in ('EXPENSE','TIMA','MEAL_PAYMENT','MEAL_COVERED','ADVANCE')
        and not exists (select 1 from public.cash_handoff_items i join public.cash_handoffs h on h.id=i.handoff_id where i.pending_payment_id=p.id and h.status in ('PENDING_DISPATCH_APPROVAL','ACCEPTED'))
      order by p.id asc for update
    ) ready;
  end if;

  if meal_payment_ids is not null and array_length(meal_payment_ids, 1) is not null then
    select coalesce(array_agg(distinct x order by x), array[]::bigint[]) into v_meal_ids from unnest(meal_payment_ids) as x where x is not null and x > 0;
  end if;

  v_requested_count := coalesce(array_length(v_ids,1),0);
  v_meal_count := coalesce(array_length(v_meal_ids,1),0);
  if v_requested_count <= 0 then raise exception 'NO_READY_PAYMENTS_FOR_HANDOFF'; end if;

  perform 1 from public.arka_pending_payments p where p.id = any(v_ids) for update;
  if v_meal_count > 0 then perform 1 from public.arka_pending_payments p where p.id = any(v_meal_ids) for update; end if;

  select count(*)::integer into v_locked_count from public.arka_pending_payments p where p.id = any(v_ids);
  if v_locked_count <> v_requested_count then raise exception 'HANDOFF_PAYMENT_MISSING requested=% locked=%', v_requested_count, v_locked_count; end if;

  if v_meal_count > 0 then
    select count(*)::integer into v_locked_count from public.arka_pending_payments p where p.id = any(v_meal_ids);
    if v_locked_count <> v_meal_count then raise exception 'HANDOFF_MEAL_MISSING requested=% locked=%', v_meal_count, v_locked_count; end if;
  end if;

  with candidate as (
    select i.handoff_id, count(distinct i.pending_payment_id)::integer as matched_count
    from public.cash_handoff_items i join public.cash_handoffs h on h.id=i.handoff_id
    where i.pending_payment_id = any(v_ids) and h.status='PENDING_DISPATCH_APPROVAL'
    group by i.handoff_id
  )
  select c.handoff_id into v_existing_handoff_id
  from candidate c
  where c.matched_count = v_requested_count
    and (select count(distinct i2.pending_payment_id)::integer from public.cash_handoff_items i2 where i2.handoff_id=c.handoff_id)=v_requested_count
  order by c.handoff_id desc limit 1;

  if v_existing_handoff_id is not null then
    select * into v_handoff from public.cash_handoffs h where h.id=v_existing_handoff_id and h.status='PENDING_DISPATCH_APPROVAL';
    if found then
      return jsonb_build_object('ok', true, 'alreadySubmitted', true, 'handoff', to_jsonb(v_handoff), 'count', v_requested_count, 'total', round(coalesce(v_handoff.amount,0)::numeric,2));
    end if;
  end if;

  select count(*)::integer into v_bad_count
  from public.arka_pending_payments p
  where p.id = any(v_ids)
    and not (p.status in ('PENDING','COLLECTED') and coalesce(p.amount,0)>0 and upper(coalesce(to_jsonb(p)->>'type','')) not in ('EXPENSE','TIMA','MEAL_PAYMENT','MEAL_COVERED','ADVANCE')
      and not exists (select 1 from public.cash_handoff_items i join public.cash_handoffs h on h.id=i.handoff_id where i.pending_payment_id=p.id and h.status in ('PENDING_DISPATCH_APPROVAL','ACCEPTED')));
  if v_bad_count > 0 then raise exception 'PAYMENT_NOT_READY_FOR_HANDOFF: %', v_bad_count; end if;

  if v_meal_count > 0 then
    select count(*)::integer into v_bad_count
    from public.arka_pending_payments p
    where p.id = any(v_meal_ids)
      and not (
        upper(coalesce(to_jsonb(p)->>'type','')) = 'MEAL_PAYMENT'
        and upper(coalesce(to_jsonb(p)->>'status','')) in ('PENDING','COLLECTED','PENDING_DISPATCH_APPROVAL','ACCEPTED_BY_DISPATCH','APPROVED','ACCEPTED')
        and coalesce(p.amount,0)>0
        and trim(coalesce(to_jsonb(p)->>'created_by_pin','')) = v_actor_pin
        and coalesce(to_jsonb(p)->>'handoff_note','') ~* 'MEAL_(DAY|OPEN|CARRY|DEBT):[0-9]{4}-[0-9]{2}-[0-9]{2}'
        and coalesce(to_jsonb(p)->>'handoff_note','') !~* '^SETTLED_IN_HANDOFF:'
      );
    if v_bad_count > 0 then raise exception 'MEAL_PAYMENT_NOT_READY_FOR_HANDOFF: %', v_bad_count; end if;
    select round(coalesce(sum(p.amount),0)::numeric,2) into v_meal_total from public.arka_pending_payments p where p.id=any(v_meal_ids);
  end if;

  with ready as (
    select p.*, to_jsonb(p) as j,
      (upper(coalesce(to_jsonb(p)->>'source_module',''))='TRANSPORT' or upper(coalesce(to_jsonb(p)->>'type',''))='TRANSPORT' or nullif(to_jsonb(p)->>'transport_order_id','') is not null or upper(coalesce(to_jsonb(p)->>'transport_code_str','')) like 'T%') as is_transport,
      case when coalesce(to_jsonb(p)->>'transport_m2','') ~ '^-?[0-9]+(\.[0-9]+)?$' then (to_jsonb(p)->>'transport_m2')::numeric else 0::numeric end as transport_m2_num
    from public.arka_pending_payments p where p.id=any(v_ids)
  ), base as (
    select *, round(case when is_transport and v_is_hybrid then greatest(0, coalesce(amount,0)::numeric - least(coalesce(amount,0)::numeric, transport_m2_num * v_commission_rate)) else coalesce(amount,0)::numeric end, 2) as base_amount
    from ready
  )
  select round(coalesce(sum(base_amount),0),2) into v_gross_amount from base;

  v_amount := round(v_gross_amount - coalesce(v_meal_total,0), 2);
  if v_amount <= 0 then raise exception 'HANDOFF_AMOUNT_ZERO_AFTER_MEAL_DEDUCT'; end if;
  if amount_declared is not null and amount_declared > 0 and abs(round(amount_declared::numeric,2)-v_amount)>0.05 then raise exception 'HANDOFF_DECLARED_AMOUNT_MISMATCH declared=% computed=%', amount_declared, v_amount; end if;

  v_handoff_json := jsonb_build_object(
    'worker_pin', v_actor_pin, 'worker_name', coalesce(v_actor_name, v_actor_pin), 'driver_pin', v_actor_pin, 'driver_name', coalesce(v_actor_name, v_actor_pin),
    'amount', v_amount, 'total_amount', v_amount, 'count_clients', v_requested_count, 'status', 'PENDING_DISPATCH_APPROVAL', 'submitted_at', v_now,
    'note', nullif(trim(coalesce(handoff_note,'')), ''), 'payment_ids', v_ids,
    'order_ids', (select coalesce(array_agg(distinct (to_jsonb(p)->>'order_id')::bigint) filter (where coalesce(to_jsonb(p)->>'order_id','') ~ '^\d+$'), array[]::bigint[]) from public.arka_pending_payments p where p.id=any(v_ids)),
    'data', jsonb_build_object('kind','cash_handoff','payment_ids',v_ids,'meal_payment_ids',v_meal_ids,'total_amount',v_amount,'gross_amount',v_gross_amount,'meal_total',v_meal_total,'count_clients',v_requested_count,'idempotency_key',nullif(trim(coalesce(idempotency_key,'')),'')),
    'updated_at', v_now
  );

  select string_agg(quote_ident(c.column_name), ', ' order by c.ordinality), string_agg(format('(jsonb_populate_record(null::public.cash_handoffs, $1)).%I', c.column_name), ', ' order by c.ordinality)
    into v_cols, v_values
  from unnest(array['worker_pin','worker_name','driver_pin','driver_name','amount','total_amount','count_clients','status','submitted_at','note','payment_ids','order_ids','data','updated_at']) with ordinality as c(column_name, ordinality)
  join information_schema.columns ic on ic.table_schema='public' and ic.table_name='cash_handoffs' and ic.column_name=c.column_name;
  if v_cols is null or position('amount' in v_cols)=0 or position('status' in v_cols)=0 then raise exception 'CASH_HANDOFFS_REQUIRED_COLUMNS_MISSING'; end if;
  execute format('insert into public.cash_handoffs (%s) select %s returning *', v_cols, v_values) into v_handoff using v_handoff_json;

  with ready as (
    select p.*, to_jsonb(p) as j,
      (upper(coalesce(to_jsonb(p)->>'source_module',''))='TRANSPORT' or upper(coalesce(to_jsonb(p)->>'type',''))='TRANSPORT' or nullif(to_jsonb(p)->>'transport_order_id','') is not null or upper(coalesce(to_jsonb(p)->>'transport_code_str','')) like 'T%') as is_transport,
      case when coalesce(to_jsonb(p)->>'transport_m2','') ~ '^-?[0-9]+(\.[0-9]+)?$' then (to_jsonb(p)->>'transport_m2')::numeric else 0::numeric end as transport_m2_num
    from public.arka_pending_payments p where p.id=any(v_ids)
  ), base as (
    select *, round(case when is_transport and v_is_hybrid then greatest(0, coalesce(amount,0)::numeric - least(coalesce(amount,0)::numeric, transport_m2_num * v_commission_rate)) else coalesce(amount,0)::numeric end, 2) as base_amount
    from ready
  ), caps as (
    select *, greatest(0, base_amount - 0.01) as cap,
      coalesce(sum(greatest(0, base_amount - 0.01)) over (order by base_amount desc, id asc rows between unbounded preceding and 1 preceding), 0) as prev_cap
    from base
  ), adjusted as (
    select *, round(base_amount - case when v_meal_total <= prev_cap then 0 else least(cap, greatest(0, v_meal_total - prev_cap)) end, 2) as net_amount
    from caps
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'handoff_id', v_handoff.id, 'pending_payment_id', id,
    'order_id', case when is_transport then null when coalesce(j->>'order_id','') ~ '^\d+$' then (j->>'order_id')::bigint else null end,
    'order_code', case when is_transport then null else coalesce(j->>'order_code', j->>'code') end,
    'source_module', case when is_transport then 'TRANSPORT' else 'BASE' end,
    'transport_order_id', case when is_transport then nullif(j->>'transport_order_id','') else null end,
    'transport_code_str', case when is_transport then nullif(j->>'transport_code_str','') else null end,
    'transport_m2', case when is_transport then transport_m2_num else 0 end,
    'amount', net_amount
  )), '[]'::jsonb) into v_items_json
  from adjusted;

  select string_agg(quote_ident(c.column_name), ', ' order by c.ordinality), string_agg(format('x.%I', c.column_name), ', ' order by c.ordinality)
    into v_item_cols, v_item_values
  from unnest(array['handoff_id','pending_payment_id','order_id','order_code','source_module','transport_order_id','transport_code_str','transport_m2','amount']) with ordinality as c(column_name, ordinality)
  join information_schema.columns ic on ic.table_schema='public' and ic.table_name='cash_handoff_items' and ic.column_name=c.column_name;
  if v_item_cols is null or position('handoff_id' in v_item_cols)=0 or position('pending_payment_id' in v_item_cols)=0 or position('amount' in v_item_cols)=0 then raise exception 'CASH_HANDOFF_ITEMS_REQUIRED_COLUMNS_MISSING'; end if;
  execute format('insert into public.cash_handoff_items (%s) select %s from jsonb_populate_recordset(null::public.cash_handoff_items, $1) as x', v_item_cols, v_item_values) using v_items_json;
  get diagnostics v_item_count = row_count;
  if v_item_count <> v_requested_count then raise exception 'HANDOFF_ITEM_COUNT_MISMATCH requested=% inserted=%', v_requested_count, v_item_count; end if;

  v_payment_patch := jsonb_build_object('status','PENDING_DISPATCH_APPROVAL','submitted_at',v_now,'handed_at',v_now,'handed_by_pin',v_actor_pin,'handed_by_name',v_actor_name,'handed_by_role',v_actor_role,'handoff_note',concat('Handoff #',v_handoff.id),'updated_at',v_now);
  select string_agg(format('%I = (jsonb_populate_record(null::public.arka_pending_payments, $2)).%I', c.column_name, c.column_name), ', ' order by c.ordinality) into v_set_sql
  from unnest(array['status','submitted_at','handed_at','handed_by_pin','handed_by_name','handed_by_role','handoff_note','updated_at']) with ordinality as c(column_name, ordinality)
  join information_schema.columns ic on ic.table_schema='public' and ic.table_name='arka_pending_payments' and ic.column_name=c.column_name;
  if v_set_sql is null or position('status =' in v_set_sql)=0 then raise exception 'ARKA_PENDING_PAYMENTS_STATUS_COLUMN_REQUIRED'; end if;
  execute format('update public.arka_pending_payments p set %s where p.id = any($1) and p.status in (''PENDING'',''COLLECTED'')', v_set_sql) using v_ids, v_payment_patch;
  get diagnostics v_locked_count = row_count;
  if v_locked_count <> v_requested_count then raise exception 'HANDOFF_PAYMENT_CLAIM_COUNT_MISMATCH requested=% updated=%', v_requested_count, v_locked_count; end if;

  if v_meal_count > 0 then
    v_meal_patch := jsonb_build_object('handed_at',v_now,'handed_by_pin',v_actor_pin,'handed_by_name',v_actor_name,'handed_by_role',v_actor_role,'handoff_note',concat('SETTLED_IN_HANDOFF:', v_handoff.id),'updated_at',v_now);
    select string_agg(format('%I = (jsonb_populate_record(null::public.arka_pending_payments, $2)).%I', c.column_name, c.column_name), ', ' order by c.ordinality) into v_set_sql
    from unnest(array['handed_at','handed_by_pin','handed_by_name','handed_by_role','handoff_note','updated_at']) with ordinality as c(column_name, ordinality)
    join information_schema.columns ic on ic.table_schema='public' and ic.table_name='arka_pending_payments' and ic.column_name=c.column_name;
    execute format('update public.arka_pending_payments p set %s where p.id = any($1)', v_set_sql) using v_meal_ids, v_meal_patch;
    get diagnostics v_locked_count = row_count;
    if v_locked_count <> v_meal_count then raise exception 'HANDOFF_MEAL_SETTLE_COUNT_MISMATCH requested=% updated=%', v_meal_count, v_locked_count; end if;
  end if;

  select coalesce(sum(i.amount),0)::numeric, count(*)::integer into v_item_sum, v_item_count from public.cash_handoff_items i where i.handoff_id=v_handoff.id;
  if v_item_count <> v_requested_count then raise exception 'HANDOFF_ITEM_COUNT_MISMATCH requested=% inserted=%', v_requested_count, v_item_count; end if;
  if abs(coalesce(v_item_sum,0)::numeric - coalesce(v_handoff.amount,0)::numeric) > 0.05 then raise exception 'HANDOFF_ITEM_SUM_MISMATCH handoff=% items=%', v_handoff.amount, v_item_sum; end if;

  return jsonb_build_object('ok', true, 'alreadySubmitted', false, 'handoff', to_jsonb(v_handoff), 'count', v_requested_count, 'total', round(coalesce(v_handoff.amount, v_amount)::numeric,2), 'mealTotal', v_meal_total, 'grossTotal', v_gross_amount);
end;
$$;
