create or replace function public.mark_base_order_ready_with_bonus_v1(
  p_order_ref text,
  p_worker_pin text,
  p_ready_slots text[] default array[]::text[],
  p_ready_note text default null,
  p_ready_at timestamptz default null,
  p_idempotency_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public','pg_temp'
as $function$
declare
  v_order public.orders%rowtype;
  v_worker public.users%rowtype;
  v_config public.base_ready_bonus_config%rowtype;
  v_existing public.base_ready_bonuses%rowtype;
  v_bonus public.base_ready_bonuses%rowtype;
  v_payment public.arka_pending_payments%rowtype;
  v_ready_at timestamptz;
  v_now timestamptz := now();
  v_m2 numeric := 0;
  v_amount numeric := 0;
  v_elapsed_minutes integer := 0;
  v_eligible boolean := false;
  v_reason text := '';
  v_idem text;
  v_slots text[] := coalesce(p_ready_slots,array[]::text[]);
  v_location text;
  v_note text;
  v_data jsonb;
  v_summary jsonb;
begin
  if nullif(btrim(coalesce(p_order_ref,'')),'') is null then
    raise exception 'BASE_READY_ORDER_REF_REQUIRED';
  end if;
  if nullif(btrim(coalesce(p_worker_pin,'')),'') is null then
    raise exception 'BASE_READY_WORKER_PIN_REQUIRED';
  end if;

  if btrim(p_order_ref) ~ '^\d+$' then
    select * into v_order from public.orders where id=btrim(p_order_ref)::bigint for update;
  else
    select * into v_order from public.orders where local_oid=btrim(p_order_ref) for update;
  end if;
  if not found then
    raise exception 'BASE_READY_ORDER_NOT_FOUND';
  end if;

  select *
  into v_existing
  from public.base_ready_bonuses
  where order_id=v_order.id
  limit 1;

  if found then
    v_summary := public.get_base_ready_bonus_summary_v1(
      v_existing.worker_pin,
      v_existing.worker_pin,
      (coalesce(v_existing.activated_at,v_existing.ready_at) at time zone 'Europe/Belgrade')::date
    );
    return jsonb_build_object(
      'ok',true,
      'alreadyApplied',true,
      'order',to_jsonb(v_order),
      'bonus',to_jsonb(v_existing),
      'summary',v_summary
    );
  end if;

  if lower(coalesce(v_order.status,'')) <> 'pastrim' then
    raise exception 'BASE_READY_STATUS_NOT_PASTRIM:%',coalesce(v_order.status,'EMPTY');
  end if;

  select *
  into v_worker
  from public.users
  where pin=btrim(p_worker_pin)
    and is_active is true
  limit 1;

  if not found then
    raise exception 'BASE_READY_WORKER_NOT_FOUND';
  end if;

  if upper(coalesce(v_worker.role,'')) not in ('PUNTOR','PUNETOR','WORKER','BAZIST','BASE') then
    raise exception 'BASE_READY_WORKER_ROLE_NOT_ALLOWED:%',coalesce(v_worker.role,'EMPTY');
  end if;

  if coalesce(array_length(v_slots,1),0)<=0 then
    raise exception 'BASE_READY_RACK_REQUIRED';
  end if;

  if lower(coalesce(v_order.data->'paketimi_v1'->>'status','')) <> 'final_ready' then
    raise exception 'BASE_READY_PAKETIMI_NOT_FINAL';
  end if;

  select *
  into v_config
  from public.base_ready_bonus_config
  where id=1
  for share;

  if not found then
    raise exception 'BASE_READY_BONUS_CONFIG_MISSING';
  end if;

  v_ready_at := coalesce(p_ready_at,v_now);
  if v_ready_at>v_now+interval '5 minutes'
     or v_ready_at<v_now-interval '7 days'
     or v_ready_at<v_order.created_at-interval '5 minutes' then
    v_ready_at := v_now;
  end if;

  v_m2 := round(coalesce(public.tepiha_daily_order_m2(v_order.data,v_order.m2_total),0)::numeric,2);
  if v_m2<=0 then
    raise exception 'BASE_READY_M2_REQUIRED';
  end if;

  v_elapsed_minutes := greatest(0,floor(extract(epoch from (v_ready_at-v_order.created_at))/60)::integer);
  v_eligible := coalesce(v_config.enabled,false)
    and v_ready_at>=v_config.effective_from
    and v_elapsed_minutes<=floor(v_config.window_hours*60)::integer;

  if not coalesce(v_config.enabled,false) then
    v_reason := 'BONUS_DISABLED';
  elsif v_ready_at<v_config.effective_from then
    v_reason := 'BEFORE_EFFECTIVE_FROM';
  elsif v_elapsed_minutes>floor(v_config.window_hours*60)::integer then
    v_reason := 'OVER_48_HOURS';
  else
    v_reason := 'ELIGIBLE_WITHIN_48H_GATI';
  end if;

  v_amount := case when v_eligible then round(v_m2*v_config.rate_m2,2) else 0 end;
  v_idem := coalesce(
    nullif(btrim(coalesce(p_idempotency_key,'')),''),
    concat('BASE_READY_48H_BONUS:',v_order.id)
  );
  v_location := array_to_string(v_slots,', ');
  v_note := nullif(btrim(coalesce(p_ready_note,'')),'');

  v_data := coalesce(v_order.data,'{}'::jsonb) || jsonb_build_object(
    'status','gati',
    'state','gati',
    'ready_at',v_ready_at,
    'ready_note',case when v_note is null then concat('📍 [',v_location,']') else concat('📍 [',v_location,'] ',v_note) end,
    'ready_note_text',coalesce(v_note,''),
    'ready_location',v_location,
    'ready_slots',to_jsonb(v_slots),
    'ready_by_pin',v_worker.pin,
    'ready_by_name',v_worker.name,
    'ready_by_role',v_worker.role,
    'base_ready_bonus_v1',jsonb_build_object(
      'worker_pin',v_worker.pin,
      'worker_name',v_worker.name,
      'm2',v_m2,
      'rate_m2',v_config.rate_m2,
      'amount',v_amount,
      'entered_at',v_order.created_at,
      'ready_at',v_ready_at,
      'elapsed_minutes',v_elapsed_minutes,
      'eligible',v_eligible,
      'reason',v_reason,
      'status',case when v_eligible then 'EARNED' else 'INELIGIBLE' end,
      'activation_source','GATI',
      'idempotency_key',v_idem,
      'version','base-ready-ready-or-payment-v3'
    )
  );

  insert into public.base_ready_bonuses (
    order_id,order_code,worker_pin,worker_name,worker_role,m2,rate_m2,amount,
    entered_at,ready_at,elapsed_minutes,eligible,status,remaining_amount,reserved_amount,
    retained_amount,arka_payment_id,idempotency_key,reason,metadata,
    activated_at,activation_payment_id,activation_source,created_at,updated_at
  ) values (
    v_order.id,v_order.code,v_worker.pin,v_worker.name,v_worker.role,v_m2,v_config.rate_m2,v_amount,
    v_order.created_at,v_ready_at,v_elapsed_minutes,v_eligible,
    case when v_eligible then 'EARNED' else 'INELIGIBLE' end,
    v_amount,0,0,null,v_idem,v_reason,
    jsonb_build_object(
      'source','PASTRIMI_GATI',
      'version','base-ready-ready-or-payment-v3',
      'activation_source','GATI'
    ),
    case when v_eligible then v_ready_at else null end,
    null,
    case when v_eligible then 'GATI' else 'GATI_INELIGIBLE' end,
    v_now,v_now
  )
  returning * into v_bonus;

  if v_eligible and v_amount>0 then
    begin
      insert into public.arka_pending_payments (
        order_id,amount,type,status,note,client_name,client_phone,order_code,
        created_by_pin,created_by_name,approved_by_pin,approved_by_name,
        handoff_note,source_module,idempotency_key,created_at,updated_at
      ) values (
        v_order.id,v_amount,'READY_48H_BONUS','ACCEPTED_BY_DISPATCH',
        concat('BONUS 48H ',to_char(v_amount,'FM999999990.00'),'€ • #',v_order.code,' • ',coalesce(v_order.client_name,''),' • ',to_char(v_m2,'FM999999990.00'),' m² × ',to_char(v_config.rate_m2,'FM999999990.00'),'€ • ',to_char(v_elapsed_minutes::numeric/60,'FM999999990.00'),'h'),
        v_order.client_name,v_order.client_phone,v_order.code,
        v_worker.pin,v_worker.name,'SYSTEM','BONUS 48H AUTO',
        concat('READY_BONUS_OPEN:',v_bonus.id),'ARKA',v_idem,
        v_ready_at,v_now
      )
      returning * into v_payment;
    exception when unique_violation then
      select *
      into v_payment
      from public.arka_pending_payments
      where idempotency_key=v_idem
      limit 1;
    end;

    update public.base_ready_bonuses
    set arka_payment_id=v_payment.id,
        updated_at=v_now
    where id=v_bonus.id
    returning * into v_bonus;
  end if;

  update public.orders
  set status='gati',
      ready_at=v_ready_at,
      data=v_data,
      updated_at=v_now
  where id=v_order.id
  returning * into v_order;

  v_summary := public.get_base_ready_bonus_summary_v1(
    v_worker.pin,
    v_worker.pin,
    (coalesce(v_bonus.activated_at,v_ready_at) at time zone 'Europe/Belgrade')::date
  );

  return jsonb_build_object(
    'ok',true,
    'alreadyApplied',false,
    'order',to_jsonb(v_order),
    'bonus',to_jsonb(v_bonus),
    'summary',v_summary
  );
end;
$function$;

create or replace function public.get_base_ready_bonus_summary_v1(
  p_actor_pin text,
  p_worker_pin text default null,
  p_date date default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public','pg_temp'
as $function$
declare
  v_actor public.users%rowtype;
  v_actor_role text;
  v_target_pin text;
  v_date date := coalesce(p_date,(now() at time zone 'Europe/Belgrade')::date);
  v_day_start timestamptz;
  v_day_end timestamptz;
  v_month_start timestamptz;
  v_month_end timestamptz;
  v_config public.base_ready_bonus_config%rowtype;
  v_result jsonb;
begin
  select *
  into v_actor
  from public.users
  where pin=btrim(coalesce(p_actor_pin,''))
    and is_active is true
  limit 1;

  if not found then
    raise exception 'BONUS_ACTOR_NOT_FOUND';
  end if;

  v_actor_role := upper(coalesce(v_actor.role,''));
  if v_actor_role in ('DISPATCH','ADMIN','ADMIN_MASTER','OWNER','PRONAR','SUPERADMIN') then
    if nullif(upper(btrim(coalesce(p_worker_pin,''))),'') in ('ALL','*') then
      v_target_pin := null;
    else
      v_target_pin := nullif(btrim(coalesce(p_worker_pin,'')),'' );
    end if;
  else
    v_target_pin := btrim(coalesce(v_actor.pin,''));
  end if;

  v_day_start := v_date::timestamp at time zone 'Europe/Belgrade';
  v_day_end := (v_date+1)::timestamp at time zone 'Europe/Belgrade';
  v_month_start := date_trunc('month',v_date::timestamp)::timestamp at time zone 'Europe/Belgrade';
  v_month_end := (date_trunc('month',v_date::timestamp)+interval '1 month')::timestamp at time zone 'Europe/Belgrade';

  select * into v_config from public.base_ready_bonus_config where id=1;

  with scoped as (
    select b.*,o.client_name,coalesce(b.activated_at,b.ready_at) as earned_at
    from public.base_ready_bonuses b
    join public.orders o on o.id=b.order_id
    where (v_target_pin is null or b.worker_pin=v_target_pin)
  ),
  worker_scope as (
    select u.pin,u.name,u.role
    from public.users u
    where u.is_active is true
      and upper(coalesce(u.role,'')) in ('PUNTOR','PUNETOR','WORKER','BAZIST','BASE')
      and (v_target_pin is null or u.pin=v_target_pin)
  ),
  worker_totals as (
    select
      w.pin,w.name,w.role,
      count(s.id) filter (
        where s.eligible
          and s.status not in ('VOIDED','REVIEW_REQUIRED','INELIGIBLE')
          and s.earned_at>=v_day_start and s.earned_at<v_day_end
      )::int as today_orders,
      round(coalesce(sum(s.m2) filter (
        where s.eligible
          and s.status not in ('VOIDED','REVIEW_REQUIRED','INELIGIBLE')
          and s.earned_at>=v_day_start and s.earned_at<v_day_end
      ),0),2) as today_m2,
      round(coalesce(sum(s.amount) filter (
        where s.eligible
          and s.status not in ('VOIDED','REVIEW_REQUIRED','INELIGIBLE')
          and s.earned_at>=v_day_start and s.earned_at<v_day_end
      ),0),2) as today_earned,
      count(s.id) filter (
        where s.eligible
          and s.status not in ('VOIDED','REVIEW_REQUIRED','INELIGIBLE')
          and s.earned_at>=v_month_start and s.earned_at<v_month_end
      )::int as month_orders,
      round(coalesce(sum(s.m2) filter (
        where s.eligible
          and s.status not in ('VOIDED','REVIEW_REQUIRED','INELIGIBLE')
          and s.earned_at>=v_month_start and s.earned_at<v_month_end
      ),0),2) as month_m2,
      round(coalesce(sum(s.amount) filter (
        where s.eligible
          and s.status not in ('VOIDED','REVIEW_REQUIRED','INELIGIBLE')
          and s.earned_at>=v_month_start and s.earned_at<v_month_end
      ),0),2) as month_earned,
      round(coalesce(sum(s.remaining_amount) filter (
        where s.eligible
          and s.status not in ('VOIDED','REVIEW_REQUIRED','INELIGIBLE')
      ),0),2) as available_to_keep,
      round(coalesce(sum(s.reserved_amount) filter (where s.eligible),0),2) as reserved,
      round(coalesce(sum(s.retained_amount) filter (where s.eligible),0),2) as retained_total
    from worker_scope w
    left join scoped s on s.worker_pin=w.pin
    group by w.pin,w.name,w.role
  )
  select jsonb_build_object(
    'version','base-ready-ready-or-payment-v3',
    'date',v_date,
    'timezone','Europe/Belgrade',
    'generated_at',now(),
    'scope',case when v_target_pin is null then 'ALL' else 'WORKER' end,
    'worker_pin',v_target_pin,
    'config',jsonb_build_object(
      'enabled',coalesce(v_config.enabled,false),
      'rate_m2',coalesce(v_config.rate_m2,0),
      'window_hours',coalesce(v_config.window_hours,48),
      'effective_from',v_config.effective_from,
      'ready_or_full_payment',true,
      'one_bonus_per_order',true
    ),
    'totals',jsonb_build_object(
      'today_orders',(select coalesce(sum(today_orders),0) from worker_totals),
      'today_m2',(select round(coalesce(sum(today_m2),0),2) from worker_totals),
      'today_earned',(select round(coalesce(sum(today_earned),0),2) from worker_totals),
      'month_orders',(select coalesce(sum(month_orders),0) from worker_totals),
      'month_m2',(select round(coalesce(sum(month_m2),0),2) from worker_totals),
      'month_earned',(select round(coalesce(sum(month_earned),0),2) from worker_totals),
      'available_to_keep',(select round(coalesce(sum(available_to_keep),0),2) from worker_totals),
      'reserved',(select round(coalesce(sum(reserved),0),2) from worker_totals),
      'retained_total',(select round(coalesce(sum(retained_total),0),2) from worker_totals)
    ),
    'workers',(
      select coalesce(jsonb_agg(jsonb_build_object(
        'pin',pin,
        'name',name,
        'role',role,
        'today_orders',today_orders,
        'today_m2',today_m2,
        'today_earned',today_earned,
        'month_orders',month_orders,
        'month_m2',month_m2,
        'month_earned',month_earned,
        'available_to_keep',available_to_keep,
        'reserved',reserved,
        'retained_total',retained_total
      ) order by name),'[]'::jsonb)
      from worker_totals
    ),
    'rows',(
      select coalesce(jsonb_agg(jsonb_build_object(
        'id',id,
        'order_id',order_id,
        'order_code',order_code,
        'client_name',client_name,
        'worker_pin',worker_pin,
        'worker_name',worker_name,
        'm2',m2,
        'rate_m2',rate_m2,
        'amount',amount,
        'entered_at',entered_at,
        'ready_at',ready_at,
        'activated_at',activated_at,
        'activation_payment_id',activation_payment_id,
        'activation_source',activation_source,
        'elapsed_hours',round(elapsed_minutes::numeric/60,2),
        'eligible',eligible,
        'status',status,
        'remaining_amount',remaining_amount,
        'reserved_amount',reserved_amount,
        'retained_amount',retained_amount,
        'reason',reason
      ) order by earned_at desc),'[]'::jsonb)
      from scoped
      where earned_at>=v_day_start and earned_at<v_day_end
    )
  )
  into v_result;

  return v_result;
end;
$function$;

create or replace function public.list_worker_open_ready_bonus_payments_v1(p_actor_pin text)
returns table(
  payment_id bigint,
  bonus_id bigint,
  remaining_amount numeric,
  order_id bigint,
  order_code bigint,
  ready_at timestamptz
)
language plpgsql
security definer
set search_path to 'public','pg_temp'
as $function$
declare
  v_actor public.users%rowtype;
begin
  select *
  into v_actor
  from public.users
  where pin=btrim(coalesce(p_actor_pin,''))
    and is_active is true
  limit 1;

  if not found then
    raise exception 'BONUS_ACTOR_NOT_FOUND';
  end if;

  if upper(coalesce(v_actor.role,'')) not in ('PUNTOR','PUNETOR','WORKER','BAZIST','BASE') then
    raise exception 'BONUS_WORKER_ONLY';
  end if;

  return query
  select
    b.arka_payment_id,
    b.id,
    b.remaining_amount,
    b.order_id,
    b.order_code,
    b.ready_at
  from public.base_ready_bonuses b
  where b.worker_pin=v_actor.pin
    and b.eligible is true
    and b.arka_payment_id is not null
    and b.remaining_amount>0.005
    and b.status not in ('VOIDED','REVIEW_REQUIRED','INELIGIBLE')
  order by coalesce(b.activated_at,b.ready_at) asc,b.id asc;
end;
$function$;
