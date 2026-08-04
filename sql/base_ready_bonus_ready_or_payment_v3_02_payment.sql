create or replace function public.apply_base_ready_bonus_after_payment_v3(
  p_order_id bigint,
  p_payment_id bigint default null,
  p_paid_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public','pg_temp'
as $function$
declare
  v_order public.orders%rowtype;
  v_config public.base_ready_bonus_config%rowtype;
  v_existing public.base_ready_bonuses%rowtype;
  v_bonus public.base_ready_bonuses%rowtype;
  v_payment public.arka_pending_payments%rowtype;
  v_bonus_payment public.arka_pending_payments%rowtype;
  v_worker public.users%rowtype;
  v_state jsonb;
  v_fully_paid boolean := false;
  v_now timestamptz := now();
  v_paid_at timestamptz;
  v_m2 numeric := 0;
  v_amount numeric := 0;
  v_elapsed_minutes integer := 0;
  v_eligible boolean := false;
  v_reason text := '';
  v_idem text := '';
  v_summary jsonb;
  v_created_by_this_payment boolean := false;
begin
  select *
  into v_order
  from public.orders
  where id=p_order_id
  for update;

  if not found then
    return jsonb_build_object('ok',false,'createdFromPayment',false,'reason','ORDER_NOT_FOUND','order_id',p_order_id);
  end if;

  select *
  into v_existing
  from public.base_ready_bonuses
  where order_id=v_order.id
  for update;

  if found and v_existing.status <> 'WAITING_PAYMENT' then
    v_created_by_this_payment := p_payment_id is not null
      and v_existing.activation_payment_id = p_payment_id
      and v_existing.activation_source = 'PAYMENT_DIRECT';
    v_summary := public.get_base_ready_bonus_summary_v1(
      v_existing.worker_pin,
      v_existing.worker_pin,
      (coalesce(v_existing.activated_at,v_existing.ready_at) at time zone 'Europe/Belgrade')::date
    );
    return jsonb_build_object(
      'ok',true,
      'createdFromPayment',v_created_by_this_payment,
      'activated',v_existing.eligible,
      'alreadyApplied',true,
      'reason',case when v_created_by_this_payment then 'BONUS_CREATED_BY_THIS_PAYMENT' else 'ORDER_ALREADY_HAS_BONUS' end,
      'order',to_jsonb(v_order),
      'bonus',to_jsonb(v_existing),
      'summary',v_summary
    );
  end if;

  v_state := public.base_ready_payment_state_v2(v_order.id);
  v_fully_paid := coalesce((v_state->>'fully_paid')::boolean,false);
  if not v_fully_paid then
    return jsonb_build_object(
      'ok',true,
      'createdFromPayment',false,
      'reason','WAITING_FULL_PAYMENT',
      'order_id',v_order.id,
      'payment_state',v_state
    );
  end if;

  if p_payment_id is not null then
    select *
    into v_payment
    from public.arka_pending_payments
    where id=p_payment_id
      and order_id=v_order.id
      and upper(coalesce(type,''))='IN'
      and upper(coalesce(source_module,''))='BASE'
    limit 1;
  end if;

  if p_payment_id is null or v_payment.id is null then
    select *
    into v_payment
    from public.arka_pending_payments
    where order_id=v_order.id
      and upper(coalesce(type,''))='IN'
      and upper(coalesce(source_module,''))='BASE'
      and coalesce(amount,0)>0
      and upper(coalesce(status,'')) in ('PENDING','COLLECTED','PENDING_DISPATCH_APPROVAL','ACCEPTED_BY_DISPATCH','HANDED')
    order by created_at desc,id desc
    limit 1;
  end if;

  if v_payment.id is null then
    return jsonb_build_object(
      'ok',true,
      'createdFromPayment',false,
      'reason','BASE_PAYMENT_ROW_NOT_FOUND',
      'order_id',v_order.id,
      'payment_state',v_state
    );
  end if;

  v_paid_at := coalesce(v_payment.created_at,p_paid_at,v_now);

  if v_existing.id is not null and v_existing.status='WAITING_PAYMENT' then
    -- Compatibility repair for the brief V2 state: GATI bonuses become immediately usable.
    v_idem := v_existing.idempotency_key;
    begin
      insert into public.arka_pending_payments (
        order_id,amount,type,status,note,client_name,client_phone,order_code,
        created_by_pin,created_by_name,approved_by_pin,approved_by_name,
        handoff_note,source_module,idempotency_key,created_at,updated_at
      ) values (
        v_order.id,v_existing.amount,'READY_48H_BONUS','ACCEPTED_BY_DISPATCH',
        concat('BONUS 48H ',to_char(v_existing.amount,'FM999999990.00'),'€ • #',v_order.code,' • ',coalesce(v_order.client_name,''),' • ',to_char(v_existing.m2,'FM999999990.00'),' m² × ',to_char(v_existing.rate_m2,'FM999999990.00'),'€'),
        v_order.client_name,v_order.client_phone,v_order.code,
        v_existing.worker_pin,v_existing.worker_name,'SYSTEM','BONUS 48H AUTO',
        concat('READY_BONUS_OPEN:',v_existing.id),'ARKA',v_idem,
        coalesce(v_existing.ready_at,v_now),v_now
      )
      returning * into v_bonus_payment;
    exception when unique_violation then
      select *
      into v_bonus_payment
      from public.arka_pending_payments
      where idempotency_key=v_idem
      limit 1;
    end;

    update public.base_ready_bonuses
    set status='EARNED',
        arka_payment_id=v_bonus_payment.id,
        activated_at=coalesce(activated_at,ready_at,v_now),
        activation_payment_id=coalesce(activation_payment_id,v_payment.id),
        activation_source='GATI',
        reason=case when reason like 'ELIGIBLE%' then 'ELIGIBLE_WITHIN_48H_GATI' else reason end,
        metadata=coalesce(metadata,'{}'::jsonb) || jsonb_build_object(
          'version','base-ready-ready-or-payment-v3',
          'activation_source','GATI',
          'payment_trigger_seen',true
        ),
        updated_at=v_now
    where id=v_existing.id
    returning * into v_bonus;

    v_summary := public.get_base_ready_bonus_summary_v1(
      v_bonus.worker_pin,
      v_bonus.worker_pin,
      (v_bonus.activated_at at time zone 'Europe/Belgrade')::date
    );

    return jsonb_build_object(
      'ok',true,
      'createdFromPayment',false,
      'alreadyApplied',false,
      'activated',true,
      'reason','GATI_BONUS_COMPAT_ACTIVATED',
      'order',to_jsonb(v_order),
      'bonus',to_jsonb(v_bonus),
      'bonusPayment',to_jsonb(v_bonus_payment),
      'payment',to_jsonb(v_payment),
      'payment_state',v_state,
      'summary',v_summary
    );
  end if;

  select *
  into v_worker
  from public.users
  where pin=btrim(coalesce(v_payment.created_by_pin,''))
    and is_active is true
    and upper(coalesce(role,'')) in ('PUNTOR','PUNETOR','WORKER','BAZIST','BASE')
  limit 1;

  if not found then
    select *
    into v_worker
    from public.users
    where pin=btrim(coalesce(v_order.data ->> 'ready_by_pin',''))
      and is_active is true
      and upper(coalesce(role,'')) in ('PUNTOR','PUNETOR','WORKER','BAZIST','BASE')
    limit 1;
  end if;

  if v_worker.id is null then
    return jsonb_build_object(
      'ok',true,
      'createdFromPayment',false,
      'reason','PAYMENT_ACTOR_NOT_BASE_WORKER',
      'order_id',v_order.id,
      'payment_id',v_payment.id,
      'payment_state',v_state
    );
  end if;

  select *
  into v_config
  from public.base_ready_bonus_config
  where id=1
  for share;

  if not found then
    raise exception 'BASE_READY_BONUS_CONFIG_MISSING';
  end if;

  v_m2 := round(coalesce(public.tepiha_daily_order_m2(v_order.data,v_order.m2_total),0)::numeric,2);
  if v_m2 <= 0 then
    return jsonb_build_object('ok',true,'createdFromPayment',false,'reason','BASE_READY_M2_REQUIRED','order_id',v_order.id);
  end if;

  v_elapsed_minutes := greatest(0,floor(extract(epoch from (v_paid_at-v_order.created_at))/60)::integer);
  v_eligible := coalesce(v_config.enabled,false)
    and v_paid_at >= v_config.effective_from
    and v_elapsed_minutes <= floor(v_config.window_hours*60)::integer;

  if not coalesce(v_config.enabled,false) then
    v_reason := 'BONUS_DISABLED';
  elsif v_paid_at < v_config.effective_from then
    v_reason := 'BEFORE_EFFECTIVE_FROM';
  elsif v_elapsed_minutes > floor(v_config.window_hours*60)::integer then
    v_reason := 'OVER_48_HOURS_AT_PAYMENT';
  else
    v_reason := 'ELIGIBLE_DIRECT_FULL_PAYMENT_WITHIN_48H';
  end if;

  v_amount := case when v_eligible then round(v_m2*v_config.rate_m2,2) else 0 end;
  v_idem := concat('BASE_READY_48H_BONUS:',v_order.id);

  insert into public.base_ready_bonuses (
    order_id,order_code,worker_pin,worker_name,worker_role,m2,rate_m2,amount,
    entered_at,ready_at,elapsed_minutes,eligible,status,remaining_amount,reserved_amount,
    retained_amount,arka_payment_id,idempotency_key,reason,metadata,
    activated_at,activation_payment_id,activation_source,created_at,updated_at
  ) values (
    v_order.id,v_order.code,v_worker.pin,v_worker.name,v_worker.role,v_m2,v_config.rate_m2,v_amount,
    v_order.created_at,v_paid_at,v_elapsed_minutes,v_eligible,
    case when v_eligible then 'EARNED' else 'INELIGIBLE' end,
    v_amount,0,0,null,v_idem,v_reason,
    jsonb_build_object(
      'source','PAYMENT_DIRECT',
      'version','base-ready-ready-or-payment-v3',
      'payment_id',v_payment.id,
      'payment_actor_pin',v_payment.created_by_pin,
      'completion_event','FULL_PAYMENT'
    ),
    case when v_eligible then v_paid_at else null end,
    v_payment.id,
    case when v_eligible then 'PAYMENT_DIRECT' else 'PAYMENT_DIRECT_INELIGIBLE' end,
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
        concat('BONUS 48H NGA PAGESA ',to_char(v_amount,'FM999999990.00'),'€ • #',v_order.code,' • ',coalesce(v_order.client_name,''),' • ',to_char(v_m2,'FM999999990.00'),' m² × ',to_char(v_config.rate_m2,'FM999999990.00'),'€ • ',to_char(v_elapsed_minutes::numeric/60,'FM999999990.00'),'h'),
        v_order.client_name,v_order.client_phone,v_order.code,
        v_worker.pin,v_worker.name,'SYSTEM','BONUS 48H AUTO',
        concat('READY_BONUS_OPEN:',v_bonus.id),'ARKA',v_idem,
        v_paid_at,v_now
      )
      returning * into v_bonus_payment;
    exception when unique_violation then
      select *
      into v_bonus_payment
      from public.arka_pending_payments
      where idempotency_key=v_idem
      limit 1;
    end;

    update public.base_ready_bonuses
    set arka_payment_id=v_bonus_payment.id,
        updated_at=v_now
    where id=v_bonus.id
    returning * into v_bonus;
  end if;

  v_summary := public.get_base_ready_bonus_summary_v1(
    v_worker.pin,
    v_worker.pin,
    (coalesce(v_bonus.activated_at,v_bonus.ready_at) at time zone 'Europe/Belgrade')::date
  );

  return jsonb_build_object(
    'ok',true,
    'createdFromPayment',v_eligible,
    'alreadyApplied',false,
    'activated',v_eligible,
    'reason',v_reason,
    'order',to_jsonb(v_order),
    'bonus',to_jsonb(v_bonus),
    'bonusPayment',case when v_bonus_payment.id is null then null else to_jsonb(v_bonus_payment) end,
    'payment',to_jsonb(v_payment),
    'payment_state',v_state,
    'summary',v_summary
  );
end;
$function$;

-- Compatibility name used by the short-lived payment-gate build.
create or replace function public.apply_base_ready_bonus_after_payment_v2(
  p_order_id bigint,
  p_payment_id bigint default null,
  p_paid_at timestamptz default null
)
returns jsonb
language sql
security definer
set search_path to 'public','pg_temp'
as $$
  select public.apply_base_ready_bonus_after_payment_v3($1,$2,$3)
$$;
