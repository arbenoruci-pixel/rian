-- Minimal live-compatible schema for isolated PostgreSQL regression tests.
create table public.users("id" uuid primary key,"pin" text,"name" text,"role" text,"is_active" boolean,"created_at" timestamp with time zone,"is_master" boolean,"transport_id" uuid,"tid" uuid,"salary" numeric,"avans_manual" numeric,"borxh_afatgjat" numeric,"salary_day" integer,"bonus_transport" numeric,"bonus_ushqim" numeric,"is_hybrid_transport" boolean,"commission_rate_m2" numeric,"pay_salary_enabled" boolean,"pay_meal_enabled" boolean,"pay_meal_amount" numeric,"pay_commission_enabled" boolean,"pay_commission_rate_m2" numeric,"pay_transport_bonus_enabled" boolean,"pay_transport_bonus_amount" numeric,"pay_ready_bonus_enabled" boolean,"pay_cash_mode" text,"pay_notes" text,"pay_updated_at" timestamp with time zone,"pay_updated_by_pin" text,"pay_updated_by_name" text,"updated_at" timestamp with time zone);
create table public.orders("id" bigserial primary key,"code" bigint,"client_id" uuid,"status" text,"is_offline" boolean,"notes" text,"client_photo_url" text,"data" jsonb,"created_at" timestamp with time zone,"updated_at" timestamp with time zone,"client_phone" text,"total" numeric,"paid" numeric,"picked_up_at" timestamp with time zone,"ready_at" timestamp with time zone,"client_code" integer,"client_name" text,"photos_purged_at" timestamp with time zone,"claimed_by" text,"claimed_at" timestamp with time zone,"claim_expires_at" timestamp with time zone,"local_oid" text,"deliveredAt" timestamp with time zone,"delivered_at" timestamp with time zone,"is_paid_upfront" boolean,"m2_total" numeric,"price_total" numeric,"paid_cash" numeric,"pieces" integer,"note" text);
create table public.base_ready_bonus_config("id" smallint primary key,"enabled" boolean,"rate_m2" numeric,"window_hours" numeric,"effective_from" timestamp with time zone,"updated_at" timestamp with time zone,"updated_by_pin" text);
create table public.base_ready_bonuses("id" bigserial primary key,"order_id" bigint unique,"order_code" bigint,"worker_pin" text,"worker_name" text,"worker_role" text,"m2" numeric,"rate_m2" numeric,"amount" numeric,"entered_at" timestamp with time zone,"ready_at" timestamp with time zone,"elapsed_minutes" integer,"eligible" boolean,"status" text,"remaining_amount" numeric,"reserved_amount" numeric,"retained_amount" numeric,"arka_payment_id" bigint,"idempotency_key" text,"reason" text,"metadata" jsonb,"created_at" timestamp with time zone,"updated_at" timestamp with time zone,"activated_at" timestamp with time zone,"activation_payment_id" bigint,"activation_source" text,"payment_id" bigint,"qualification_source" text,"qualification_at" timestamp with time zone);
create table public.arka_pending_payments("id" bigserial primary key,"order_id" bigint,"cycle_id" bigint,"applied_cycle_id" bigint,"amount" numeric,"type" text,"status" text,"note" text,"client_name" text,"client_phone" text,"order_code" bigint,"created_by_pin" text,"created_by_name" text,"approved_by_pin" text,"approved_by_name" text,"handed_at" timestamp with time zone,"handed_by_pin" text,"handed_by_name" text,"handed_by_role" text,"handoff_note" text,"created_at" timestamp with time zone,"updated_at" timestamp with time zone,"source_module" text,"transport_order_id" uuid,"transport_code_str" text,"transport_m2" numeric,"idempotency_key" text);
CREATE OR REPLACE FUNCTION public.base_bonus_safe_numeric_v2(p_value text)
 RETURNS numeric
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
begin
  if p_value is null or btrim(p_value) = '' then return null; end if;
  if btrim(p_value) !~ '^-?[0-9]+([.][0-9]+)?$' then return null; end if;
  return btrim(p_value)::numeric;
exception when others then
  return null;
end;
$function$
;
CREATE OR REPLACE FUNCTION public.tepiha_daily_try_numeric(p_value text)
 RETURNS numeric
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
begin
  if p_value is null or btrim(p_value) = '' then return null; end if;
  return replace(btrim(p_value), ',', '.')::numeric;
exception when others then
  return null;
end;
$function$;

CREATE OR REPLACE FUNCTION public.tepiha_daily_order_m2(p_data jsonb, p_top numeric DEFAULT 0)
 RETURNS numeric
 LANGUAGE sql
 IMMUTABLE
AS $function$
  with d as (
    select coalesce(p_data, '{}'::jsonb) as j
  ), candidates as (
    select greatest(
      coalesce(p_top, 0),
      coalesce(public.tepiha_daily_try_numeric(j->>'m2_total'), 0),
      coalesce(public.tepiha_daily_try_numeric(j->>'total_m2'), 0),
      coalesce(public.tepiha_daily_try_numeric(j->>'m2'), 0),
      coalesce(public.tepiha_daily_try_numeric(j->'pay'->>'m2'), 0),
      coalesce(public.tepiha_daily_try_numeric(j->'pay'->>'m2_total'), 0),
      coalesce(public.tepiha_daily_try_numeric(j->'totals'->>'m2'), 0),
      coalesce(public.tepiha_daily_try_numeric(j->'totals'->>'m2_total'), 0),
      coalesce((select sum(
        coalesce(public.tepiha_daily_try_numeric(x->>'m2'), public.tepiha_daily_try_numeric(x->>'m'), public.tepiha_daily_try_numeric(x->>'area'), 0)
        * coalesce(public.tepiha_daily_try_numeric(x->>'qty'), public.tepiha_daily_try_numeric(x->>'pieces'), 0)
      ) from jsonb_array_elements(case when jsonb_typeof(j->'tepiha')='array' then j->'tepiha' else '[]'::jsonb end) x), 0)
      + coalesce((select sum(
        coalesce(public.tepiha_daily_try_numeric(x->>'m2'), public.tepiha_daily_try_numeric(x->>'m'), public.tepiha_daily_try_numeric(x->>'area'), 0)
        * coalesce(public.tepiha_daily_try_numeric(x->>'qty'), public.tepiha_daily_try_numeric(x->>'pieces'), 0)
      ) from jsonb_array_elements(case when jsonb_typeof(j->'staza')='array' then j->'staza' else '[]'::jsonb end) x), 0)
      + coalesce(public.tepiha_daily_try_numeric(j->'shkallore'->>'qty'), public.tepiha_daily_try_numeric(j->>'stairsQty'), 0)
        * coalesce(public.tepiha_daily_try_numeric(j->'shkallore'->>'per'), public.tepiha_daily_try_numeric(j->>'stairsPer'), 0.3)
    ) as value
    from d
  )
  select round(coalesce(value,0),2) from candidates;
$function$
;
CREATE OR REPLACE FUNCTION public.base_order_is_fully_paid_v2(p_data jsonb, p_price_total numeric DEFAULT NULL::numeric, p_paid numeric DEFAULT NULL::numeric, p_paid_cash numeric DEFAULT NULL::numeric)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
declare
  v_data jsonb := coalesce(p_data, '{}'::jsonb);
  v_pay jsonb := case when jsonb_typeof(coalesce(p_data, '{}'::jsonb)->'pay') = 'object' then coalesce(p_data, '{}'::jsonb)->'pay' else '{}'::jsonb end;
  v_total numeric := 0;
  v_paid numeric := 0;
  v_debt numeric := null;
  v_flag text := '';
begin
  v_total := greatest(
    coalesce(p_price_total, 0),
    coalesce(public.base_bonus_safe_numeric_v2(v_pay->>'euro'), 0),
    coalesce(public.base_bonus_safe_numeric_v2(v_pay->>'total'), 0),
    coalesce(public.base_bonus_safe_numeric_v2(v_data->>'price_total'), 0),
    coalesce(public.base_bonus_safe_numeric_v2(v_data->>'total'), 0)
  );

  v_paid := greatest(
    coalesce(p_paid, 0),
    coalesce(p_paid_cash, 0),
    coalesce(public.base_bonus_safe_numeric_v2(v_pay->>'paid'), 0),
    coalesce(public.base_bonus_safe_numeric_v2(v_pay->>'arkaRecordedPaid'), 0),
    coalesce(public.base_bonus_safe_numeric_v2(v_data->>'clientPaid'), 0),
    coalesce(public.base_bonus_safe_numeric_v2(v_data->>'paid'), 0)
  );

  v_debt := coalesce(
    public.base_bonus_safe_numeric_v2(v_pay->>'debt'),
    public.base_bonus_safe_numeric_v2(v_data->>'debt')
  );
  v_flag := lower(coalesce(v_data->>'isPaid', v_data->>'is_paid', ''));

  if v_flag in ('true','1','yes','po') then return true; end if;
  if v_total > 0 and v_paid >= v_total - 0.01 then return true; end if;
  if v_paid > 0 and v_debt is not null and v_debt <= 0.01 then return true; end if;
  return false;
end;
$function$
;
CREATE OR REPLACE FUNCTION public.enforce_bujar_only_base_bonus_v1()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_bujar_pin text;
begin
  select pin into v_bujar_pin from public.users where id='19d3ab97-2067-493a-aeb1-8a23572dc5f8' and is_active is true limit 1;
  if coalesce(new.worker_pin,'') <> coalesce(v_bujar_pin,'__NO_BUJAR__') then
    new.eligible := false;
    new.amount := 0;
    new.remaining_amount := 0;
    new.reserved_amount := 0;
    new.retained_amount := 0;
    new.status := 'INELIGIBLE';
    new.reason := 'WORKER_NOT_EXCLUSIVE_BUJAR';
  else
    new.worker_name := 'bujar oruqi';
    new.rate_m2 := 0.10;
    if coalesce(new.eligible,false) then
      new.amount := round(coalesce(new.m2,0)*0.10,2);
      new.remaining_amount := greatest(0,new.amount-coalesce(new.reserved_amount,0)-coalesce(new.retained_amount,0));
    end if;
  end if;
  return new;
end;
$function$
;
CREATE OR REPLACE FUNCTION public.block_non_bujar_bonus_payment_v1()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_bujar_pin text;
begin
  select pin into v_bujar_pin from public.users where id='19d3ab97-2067-493a-aeb1-8a23572dc5f8' and is_active is true limit 1;
  if upper(coalesce(new.type,''))='READY_48H_BONUS'
     and coalesce(new.created_by_pin,'') <> coalesce(v_bujar_pin,'__NO_BUJAR__') then
    new.status := 'VOIDED';
    new.handoff_note := 'BONUS_BLOCKED_EXCLUSIVE_BUJAR';
    new.approved_by_pin := 'SYSTEM';
    new.approved_by_name := 'BONUS VETEM BUJAR ORUQI';
  end if;
  return new;
end;
$function$
;
CREATE OR REPLACE FUNCTION public.base_ready_payment_state_v2(p_order_id bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$

;
create unique index arka_pending_payments_idemp_uidx on arka_pending_payments(idempotency_key) where idempotency_key is not null;
create unique index base_bonus_idem on base_ready_bonuses(idempotency_key);
CREATE OR REPLACE FUNCTION public.base_ready_num_or_null_v2(p_value text)
 RETURNS numeric
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select case
    when nullif(btrim(coalesce($1,'')),'') ~ '^-?[0-9]+([.][0-9]+)?$'
      then btrim($1)::numeric
    else null
  end
$function$

;
