-- Base Ready Bonus V3
-- A base worker earns one 0.10 EUR/m2 bonus when either:
--   1) the order is completed/GATI within 48 hours, or
--   2) the worker records the full customer payment within 48 hours before GATI.
-- The same order can create only one bonus.

create or replace function public.base_ready_num_or_null_v2(p_value text)
returns numeric
language sql
immutable
as $$
  select case
    when nullif(btrim(coalesce($1,'')),'') ~ '^-?[0-9]+([.][0-9]+)?$'
      then btrim($1)::numeric
    else null
  end
$$;

alter table public.base_ready_bonuses
  add column if not exists activated_at timestamptz,
  add column if not exists activation_payment_id bigint,
  add column if not exists activation_source text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.base_ready_bonuses'::regclass
      and conname = 'base_ready_bonuses_activation_payment_id_fkey'
  ) then
    alter table public.base_ready_bonuses
      add constraint base_ready_bonuses_activation_payment_id_fkey
      foreign key (activation_payment_id)
      references public.arka_pending_payments(id)
      on delete set null;
  end if;
end
$$;

create index if not exists idx_base_ready_bonuses_activated
  on public.base_ready_bonuses(worker_pin, activated_at desc)
  where activated_at is not null;

create or replace function public.base_ready_payment_state_v2(p_order_id bigint)
returns jsonb
language plpgsql
security definer
set search_path to 'public','pg_temp'
as $function$
declare
  v_order public.orders%rowtype;
  v_total numeric := 0;
  v_paid numeric := 0;
  v_debt numeric := 0;
  v_debt_raw numeric;
  v_fully_paid boolean := false;
begin
  select *
  into v_order
  from public.orders
  where id = p_order_id;

  if not found then
    return jsonb_build_object(
      'ok',false,
      'fully_paid',false,
      'reason','ORDER_NOT_FOUND',
      'order_id',p_order_id
    );
  end if;

  v_total := greatest(
    coalesce(v_order.price_total,0),
    coalesce(public.base_ready_num_or_null_v2(v_order.data #>> '{pay,euro}'),0),
    coalesce(public.base_ready_num_or_null_v2(v_order.data #>> '{pay,total}'),0),
    coalesce(public.base_ready_num_or_null_v2(v_order.data ->> 'price_total'),0),
    coalesce(public.base_ready_num_or_null_v2(v_order.data ->> 'total'),0)
  );

  v_paid := greatest(
    coalesce(v_order.paid,0),
    coalesce(v_order.paid_cash,0),
    coalesce(public.base_ready_num_or_null_v2(v_order.data #>> '{pay,paid}'),0),
    coalesce(public.base_ready_num_or_null_v2(v_order.data #>> '{pay,arkaRecordedPaid}'),0),
    coalesce(public.base_ready_num_or_null_v2(v_order.data ->> 'clientPaid'),0),
    coalesce(public.base_ready_num_or_null_v2(v_order.data ->> 'paid'),0),
    coalesce(public.base_ready_num_or_null_v2(v_order.data ->> 'paid_eur'),0),
    coalesce(public.base_ready_num_or_null_v2(v_order.data ->> 'paid_cash'),0)
  );

  v_debt_raw := coalesce(
    public.base_ready_num_or_null_v2(v_order.data #>> '{pay,debt}'),
    public.base_ready_num_or_null_v2(v_order.data ->> 'debt')
  );
  v_debt := greatest(0,coalesce(v_debt_raw,v_total-v_paid));

  v_fully_paid := v_total > 0.005 and (
    lower(coalesce(v_order.data ->> 'isPaid','')) in ('true','1','yes','po')
    or v_debt <= 0.01
    or v_paid >= v_total-0.01
  );

  return jsonb_build_object(
    'ok',true,
    'order_id',v_order.id,
    'total',round(v_total,2),
    'paid',round(v_paid,2),
    'debt',round(v_debt,2),
    'fully_paid',v_fully_paid
  );
end;
$function$;

create or replace function public.base_ready_bonus_refresh_status_v1(p_bonus_id bigint)
returns public.base_ready_bonuses
language plpgsql
security definer
set search_path to 'public','pg_temp'
as $function$
declare
  v_bonus public.base_ready_bonuses%rowtype;
  v_status text;
begin
  select *
  into v_bonus
  from public.base_ready_bonuses
  where id = p_bonus_id
  for update;

  if not found then
    raise exception 'BASE_READY_BONUS_NOT_FOUND';
  end if;

  if v_bonus.status in ('VOIDED','REVIEW_REQUIRED','INELIGIBLE') then
    return v_bonus;
  end if;

  if v_bonus.retained_amount >= v_bonus.amount-0.005 then
    v_status := 'RETAINED';
  elsif v_bonus.reserved_amount >= v_bonus.amount-v_bonus.retained_amount-0.005
        and v_bonus.remaining_amount <= 0.005 then
    v_status := 'RESERVED';
  elsif v_bonus.reserved_amount > 0.005 then
    v_status := 'PARTIAL_RESERVED';
  elsif v_bonus.retained_amount > 0.005 then
    v_status := 'PARTIAL_RETAINED';
  else
    v_status := 'EARNED';
  end if;

  update public.base_ready_bonuses
  set status=v_status,
      activated_at=coalesce(activated_at,ready_at),
      activation_source=coalesce(nullif(activation_source,''),'GATI'),
      updated_at=now()
  where id=p_bonus_id
  returning * into v_bonus;

  return v_bonus;
end;
$function$;
