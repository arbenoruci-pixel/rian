-- Function shapes captured for isolated migration verification; the reserved fixture PIN is synthetic.
CREATE OR REPLACE FUNCTION public.get_worker_compensation_profile_v1(p_actor_pin text, p_worker_pin text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_actor_role text;
  v_worker public.users%rowtype;
begin
  select upper(coalesce(role,'')) into v_actor_role
  from public.users
  where pin=trim(coalesce(p_actor_pin,'')) and is_active is true
  limit 1;

  if trim(coalesce(p_actor_pin,'')) <> trim(coalesce(p_worker_pin,''))
     and v_actor_role not in ('ADMIN','ADMIN_MASTER','DISPATCH','OWNER','PRONAR','SUPERADMIN','MASTER','MASTER_USER','MASTERUSER') then
    raise exception 'WORKER_FINANCE_ACCESS_DENIED';
  end if;

  select * into v_worker
  from public.users
  where pin=trim(coalesce(p_worker_pin,'')) and is_active is true
  limit 1;
  if not found then raise exception 'WORKER_NOT_FOUND:%',p_worker_pin; end if;

  return jsonb_build_object(
    'pin',v_worker.pin,
    'name',v_worker.name,
    'role',v_worker.role,
    'active',v_worker.is_active,
    'salary_enabled',v_worker.pay_salary_enabled,
    'salary_amount',round(coalesce(v_worker.salary,0)::numeric,2),
    'salary_day',v_worker.salary_day,
    'meal_enabled',v_worker.pay_meal_enabled,
    'meal_amount',round(coalesce(v_worker.pay_meal_amount,0)::numeric,2),
    'commission_enabled',v_worker.pay_commission_enabled,
    'commission_rate_m2',round(coalesce(v_worker.pay_commission_rate_m2,0)::numeric,4),
    'transport_bonus_enabled',v_worker.pay_transport_bonus_enabled,
    'transport_bonus_amount',round(coalesce(v_worker.pay_transport_bonus_amount,0)::numeric,2),
    'ready_bonus_enabled',v_worker.pay_ready_bonus_enabled,
    'cash_mode',v_worker.pay_cash_mode,
    'notes',v_worker.pay_notes,
    'updated_at',v_worker.pay_updated_at,
    'updated_by_pin',v_worker.pay_updated_by_pin,
    'updated_by_name',v_worker.pay_updated_by_name
  );
end;
$function$;


CREATE OR REPLACE FUNCTION public.get_worker_finance_snapshot_v1(p_actor_pin text, p_worker_pin text, p_date date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_actor_role text;
  v_worker public.users%rowtype;
  v_date date := coalesce(p_date,(now() at time zone 'Europe/Belgrade')::date);
  v_start timestamptz := v_date::timestamp at time zone 'Europe/Belgrade';
  v_end timestamptz := (v_date+1)::timestamp at time zone 'Europe/Belgrade';
  v_month_start timestamptz := date_trunc('month',v_date::timestamp)::timestamp at time zone 'Europe/Belgrade';
  v_month_end timestamptz := (date_trunc('month',v_date::timestamp)+interval '1 month')::timestamp at time zone 'Europe/Belgrade';
  v_result jsonb;
begin
  select upper(coalesce(role,'')) into v_actor_role
  from public.users
  where pin=trim(coalesce(p_actor_pin,'')) and is_active is true
  limit 1;

  if trim(coalesce(p_actor_pin,'')) <> trim(coalesce(p_worker_pin,''))
     and v_actor_role not in ('ADMIN','ADMIN_MASTER','DISPATCH','OWNER','PRONAR','SUPERADMIN','MASTER','MASTER_USER','MASTERUSER') then
    raise exception 'WORKER_FINANCE_ACCESS_DENIED';
  end if;

  select * into v_worker
  from public.users
  where pin=trim(coalesce(p_worker_pin,'')) and is_active is true
  limit 1;
  if not found then raise exception 'WORKER_NOT_FOUND:%',p_worker_pin; end if;

  with all_real as (
    select p.*,
      case when upper(coalesce(p.source_module,''))='TRANSPORT'
                 or upper(coalesce(p.type,''))='TRANSPORT'
                 or p.transport_order_id is not null
                 or upper(coalesce(p.transport_code_str,'')) ~ '^T[0-9]+$'
           then true else false end as is_transport
    from public.arka_pending_payments p
    where p.created_by_pin=v_worker.pin
      and upper(coalesce(p.type,'')) not in ('EXPENSE','TIMA','MEAL_PAYMENT','MEAL_COVERED','READY_48H_BONUS','ADVANCE','SALARY_PAYMENT')
      and not exists(
        select 1 from public.arka_payment_exclusions e
        where e.payment_id=p.id and e.cancelled_at is null
      )
  ), calc as (
    select r.*,
      case when v_worker.pay_commission_enabled is true
                 and v_worker.pay_cash_mode='HYBRID_COMMISSION'
                 and r.is_transport
           then least(round(r.amount::numeric,2),round((coalesce(r.transport_m2,0)*coalesce(v_worker.pay_commission_rate_m2,0))::numeric,2))
           else 0::numeric end as commission,
      (r.created_at at time zone 'Europe/Belgrade')::date as local_date
    from all_real r
  ), money_rows as (
    select c.*,
      round((round(c.amount::numeric,2)-round(c.commission::numeric,2))::numeric,2) as due_to_base
    from calc c
  ), open_rows as (
    select * from money_rows where upper(coalesce(status,'')) in ('PENDING','COLLECTED')
  ), accepted_rows as (
    select * from money_rows where upper(coalesce(status,'')) in ('ACCEPTED_BY_DISPATCH','APPROVED','ACCEPTED')
  ), extra_rows as (
    select p.*,(p.created_at at time zone 'Europe/Belgrade')::date local_date
    from public.arka_pending_payments p
    where (p.created_by_pin=v_worker.pin or p.handed_by_pin=v_worker.pin)
      and upper(coalesce(p.type,'')) in ('EXPENSE','MEAL_PAYMENT','MEAL_COVERED','TIMA')
      and upper(coalesce(p.status,'')) not in ('REJECTED','REFUZUAR','CANCELLED','CANCELED','VOIDED')
  ), active_advances as (
    select p.*
    from public.arka_pending_payments p
    where p.created_by_pin=v_worker.pin
      and (upper(coalesce(p.type,''))='ADVANCE' or upper(coalesce(p.status,''))='ADVANCE')
      and upper(coalesce(p.status,'')) not in ('SETTLED_IN_SALARY','CANCELLED','CANCELED','VOIDED')
  ), pending_handoffs as (
    select h.* from public.cash_handoffs h
    where h.worker_pin=v_worker.pin and upper(coalesce(h.status,''))='PENDING_DISPATCH_APPROVAL'
  ), accepted_handoffs as (
    select h.* from public.cash_handoffs h
    where h.worker_pin=v_worker.pin and upper(coalesce(h.status,''))='ACCEPTED'
  )
  select jsonb_build_object(
    'version','WORKER_FINANCE_SNAPSHOT_V1',
    'date',v_date,
    'generated_at',now(),
    'actor',jsonb_build_object('pin',trim(p_actor_pin),'role',v_actor_role,'can_manage',v_actor_role in ('ADMIN','ADMIN_MASTER','DISPATCH','OWNER','PRONAR','SUPERADMIN','MASTER','MASTER_USER','MASTERUSER')),
    'worker',jsonb_build_object('id',v_worker.id,'pin',v_worker.pin,'name',v_worker.name,'role',v_worker.role,'active',v_worker.is_active),
    'profile',public.get_worker_compensation_profile_v1(p_actor_pin,p_worker_pin),
    'cash',jsonb_build_object(
      'open_gross',coalesce((select round(sum(amount)::numeric,2) from open_rows),0),
      'open_commission',coalesce((select round(sum(commission)::numeric,2) from open_rows),0),
      'open_due_to_base',coalesce((select round(sum(due_to_base)::numeric,2) from open_rows),0),
      'open_count',(select count(*) from open_rows),
      'today_gross',coalesce((select round(sum(amount)::numeric,2) from open_rows where local_date=v_date),0),
      'today_commission',coalesce((select round(sum(commission)::numeric,2) from open_rows where local_date=v_date),0),
      'today_due_to_base',coalesce((select round(sum(due_to_base)::numeric,2) from open_rows where local_date=v_date),0),
      'today_count',(select count(*) from open_rows where local_date=v_date),
      'carryover_gross',coalesce((select round(sum(amount)::numeric,2) from open_rows where local_date<v_date),0),
      'carryover_commission',coalesce((select round(sum(commission)::numeric,2) from open_rows where local_date<v_date),0),
      'carryover_due_to_base',coalesce((select round(sum(due_to_base)::numeric,2) from open_rows where local_date<v_date),0),
      'carryover_count',(select count(*) from open_rows where local_date<v_date),
      'accepted_month_gross',coalesce((select round(sum(amount)::numeric,2) from accepted_rows where created_at>=v_month_start and created_at<v_month_end),0),
      'accepted_month_commission',coalesce((select round(sum(commission)::numeric,2) from accepted_rows where created_at>=v_month_start and created_at<v_month_end),0),
      'accepted_month_due_to_base',coalesce((select round(sum(due_to_base)::numeric,2) from accepted_rows where created_at>=v_month_start and created_at<v_month_end),0),
      'pending_handoff_total',coalesce((select round(sum(amount)::numeric,2) from pending_handoffs),0),
      'pending_handoff_count',(select count(*) from pending_handoffs),
      'accepted_handoff_today',coalesce((select round(sum(amount)::numeric,2) from accepted_handoffs where decided_at>=v_start and decided_at<v_end),0),
      'rows',coalesce((select jsonb_agg(jsonb_build_object(
        'id',id,'code',coalesce(transport_code_str,case when order_code is not null then order_code::text else null end),
        'client_name',client_name,'amount',round(amount::numeric,2),'commission',round(commission::numeric,2),
        'due_to_base',round(due_to_base::numeric,2),'m2',round(coalesce(transport_m2,0)::numeric,2),
        'status',status,'type',type,'source_module',source_module,'created_at',created_at,'local_date',local_date
      ) order by created_at desc,id desc) from open_rows),'[]'::jsonb),
      'accepted_rows',coalesce((select jsonb_agg(jsonb_build_object(
        'id',id,'code',coalesce(transport_code_str,case when order_code is not null then order_code::text else null end),
        'client_name',client_name,'amount',round(amount::numeric,2),'commission',round(commission::numeric,2),
        'due_to_base',round(due_to_base::numeric,2),'status',status,'created_at',created_at
      ) order by created_at desc,id desc) from (select * from accepted_rows order by created_at desc,id desc limit 30) a),'[]'::jsonb)
    ),
    'expenses',jsonb_build_object(
      'today_total',coalesce((select round(sum(amount)::numeric,2) from extra_rows where local_date=v_date and upper(type) in ('EXPENSE','MEAL_PAYMENT','MEAL_COVERED')),0),
      'today_pending',coalesce((select round(sum(amount)::numeric,2) from extra_rows where local_date=v_date and upper(status) in ('PENDING','COLLECTED','PENDING_DISPATCH_APPROVAL')),0),
      'today_accepted',coalesce((select round(sum(amount)::numeric,2) from extra_rows where local_date=v_date and upper(status) in ('ACCEPTED_BY_DISPATCH','APPROVED','ACCEPTED')),0),
      'rows',coalesce((select jsonb_agg(jsonb_build_object('id',id,'type',type,'status',status,'amount',round(amount::numeric,2),'note',note,'created_at',created_at) order by created_at desc,id desc) from extra_rows where local_date=v_date),'[]'::jsonb)
    ),
    'advances',jsonb_build_object(
      'active_total',coalesce((select round(sum(amount)::numeric,2) from active_advances),0),
      'active_count',(select count(*) from active_advances),
      'rows',coalesce((select jsonb_agg(jsonb_build_object('id',id,'amount',round(amount::numeric,2),'note',note,'status',status,'created_at',created_at) order by created_at desc,id desc) from active_advances),'[]'::jsonb)
    ),
    'payroll',jsonb_build_object(
      'salary',case when v_worker.pay_salary_enabled then round(coalesce(v_worker.salary,0)::numeric,2) else 0 end,
      'meal_bonus',case when v_worker.pay_meal_enabled then round(coalesce(v_worker.pay_meal_amount,0)::numeric,2) else 0 end,
      'transport_bonus',case when v_worker.pay_transport_bonus_enabled then round(coalesce(v_worker.pay_transport_bonus_amount,0)::numeric,2) else 0 end,
      'commission_retained_month',case when v_worker.pay_commission_enabled and v_worker.pay_cash_mode='HYBRID_COMMISSION' then coalesce((select round(sum(commission)::numeric,2) from money_rows where created_at>=v_month_start and created_at<v_month_end),0) else 0 end,
      'advances_active',coalesce((select round(sum(amount)::numeric,2) from active_advances),0),
      'gross_fixed',round((
        case when v_worker.pay_salary_enabled then coalesce(v_worker.salary,0) else 0 end +
        case when v_worker.pay_meal_enabled then coalesce(v_worker.pay_meal_amount,0) else 0 end +
        case when v_worker.pay_transport_bonus_enabled then coalesce(v_worker.pay_transport_bonus_amount,0) else 0 end
      )::numeric,2),
      'net_fixed_after_advances',greatest(0,round((
        case when v_worker.pay_salary_enabled then coalesce(v_worker.salary,0) else 0 end +
        case when v_worker.pay_meal_enabled then coalesce(v_worker.pay_meal_amount,0) else 0 end +
        case when v_worker.pay_transport_bonus_enabled then coalesce(v_worker.pay_transport_bonus_amount,0) else 0 end -
        coalesce((select sum(amount) from active_advances),0)
      )::numeric,2)),
      'salary_day',v_worker.salary_day
    )
  ) into v_result;

  return v_result;
end;
$function$;


CREATE OR REPLACE FUNCTION public.preview_monthly_payroll_close(p_month_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
AS $function$
DECLARE
  v_month_key text;
  v_month_start timestamptz;
  v_month_end timestamptz;

  v_company_balance numeric := 0;
  v_salary_base_total numeric := 0;
  v_advances_total numeric := 0;
  v_payroll_net_total numeric := 0;
  v_essential_obligations_total numeric := 0;
  v_cash_open_total numeric := 0;
  v_pending_dispatch_total numeric := 0;
  v_existing_closed_close boolean := false;
  v_total_workers integer := 0;

  v_workers jsonb := '[]'::jsonb;
  v_blocked_reasons jsonb := '[]'::jsonb;
  v_safe boolean := false;
BEGIN
  v_month_key := left(coalesce(p_month_key, ''), 7);

  IF v_month_key !~ '^[0-9]{4}-[0-9]{2}$' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'safe', false,
      'month_key', p_month_key,
      'blocked_reasons', jsonb_build_array('month_key invalid. Expected format YYYY-MM.'),
      'workers', jsonb_build_array()
    );
  END IF;

  -- Month boundaries based on Kosovo business timezone
  v_month_start := ((v_month_key || '-01 00:00:00')::timestamp AT TIME ZONE 'Europe/Belgrade');
  v_month_end := (((v_month_key || '-01')::date + interval '1 month')::timestamp AT TIME ZONE 'Europe/Belgrade');

  SELECT coalesce((
    SELECT cbs.current_balance
    FROM public.company_budget_summary cbs
    ORDER BY cbs.id
    LIMIT 1
  ), 0)
  INTO v_company_balance;

  SELECT coalesce(sum(cfe.amount), 0)
  INTO v_essential_obligations_total
  FROM public.company_fixed_expenses cfe
  WHERE cfe.active = true
    AND cfe.essential IS DISTINCT FROM false;

  SELECT coalesce(sum(app.amount), 0)
  INTO v_cash_open_total
  FROM public.arka_pending_payments app
  WHERE upper(coalesce(app.status, '')) IN ('PENDING', 'COLLECTED')
    AND upper(coalesce(app.type, '')) NOT IN (
      'EXPENSE',
      'TIMA',
      'MEAL_PAYMENT',
      'MEAL_COVERED',
      'ADVANCE',
      'SALARY_PAYMENT'
    );

  SELECT coalesce(sum(app.amount), 0)
  INTO v_pending_dispatch_total
  FROM public.arka_pending_payments app
  WHERE upper(coalesce(app.status, '')) = 'PENDING_DISPATCH_APPROVAL'
    AND upper(coalesce(app.type, '')) NOT IN (
      'EXPENSE',
      'TIMA',
      'MEAL_PAYMENT',
      'MEAL_COVERED',
      'ADVANCE',
      'SALARY_PAYMENT'
    );

  SELECT EXISTS (
    SELECT 1
    FROM public.payroll_month_closes pmc
    WHERE pmc.month_key = v_month_key
      AND pmc.status = 'CLOSED'
  )
  INTO v_existing_closed_close;

  WITH eligible_workers AS (
    SELECT
      u.id,
      u.pin,
      u.name,
      u.role,
      coalesce(u.salary, 0)::numeric AS salary_base,
      coalesce(u.avans_manual, 0)::numeric AS manual_advance,
      coalesce(u.borxh_afatgjat, 0)::numeric AS long_term_debt
    FROM public.users u
    WHERE u.is_active = true
      AND coalesce(u.pin, '') <> ''
      AND coalesce(u.pin, '') <> '9900'
      AND upper(coalesce(u.role, '')) NOT IN (
        'ADMIN',
        'ADMIN_MASTER',
        'SUPERADMIN',
        'OWNER',
        'PRONAR',
        'MASTER',
        'SYSTEM'
      )
      AND upper(coalesce(u.name, '')) <> 'MASTER'
      AND upper(coalesce(u.name, '')) NOT LIKE '%MASTER USER%'
  ),
  worker_calc AS (
    SELECT
      ew.id,
      ew.pin,
      ew.name,
      ew.role,
      ew.salary_base,
      ew.manual_advance,
      ew.long_term_debt,

      coalesce((
        SELECT sum(app.amount)
        FROM public.arka_pending_payments app
        WHERE app.created_at >= v_month_start
          AND app.created_at < v_month_end
          AND (
            upper(coalesce(app.status, '')) = 'ADVANCE'
            OR upper(coalesce(app.type, '')) = 'ADVANCE'
          )
          AND (
            coalesce(app.created_by_pin, '') = coalesce(ew.pin, '')
            OR upper(coalesce(app.created_by_name, '')) = upper(coalesce(ew.name, ''))
          )
      ), 0)::numeric AS auto_advance,

      coalesce((
        SELECT sum(app.amount)
        FROM public.arka_pending_payments app
        WHERE upper(coalesce(app.status, '')) IN ('PENDING', 'COLLECTED')
          AND upper(coalesce(app.type, '')) NOT IN (
            'EXPENSE',
            'TIMA',
            'MEAL_PAYMENT',
            'MEAL_COVERED',
            'ADVANCE',
            'SALARY_PAYMENT'
          )
          AND (
            coalesce(app.created_by_pin, '') = coalesce(ew.pin, '')
            OR upper(coalesce(app.created_by_name, '')) = upper(coalesce(ew.name, ''))
          )
      ), 0)::numeric AS cash_open_at_close,

      coalesce((
        SELECT sum(app.amount)
        FROM public.arka_pending_payments app
        WHERE upper(coalesce(app.status, '')) = 'PENDING_DISPATCH_APPROVAL'
          AND upper(coalesce(app.type, '')) NOT IN (
            'EXPENSE',
            'TIMA',
            'MEAL_PAYMENT',
            'MEAL_COVERED',
            'ADVANCE',
            'SALARY_PAYMENT'
          )
          AND (
            coalesce(app.created_by_pin, '') = coalesce(ew.pin, '')
            OR upper(coalesce(app.created_by_name, '')) = upper(coalesce(ew.name, ''))
          )
      ), 0)::numeric AS pending_dispatch_at_close,

      EXISTS (
        SELECT 1
        FROM public.arka_pending_payments app
        WHERE app.created_at >= v_month_start
          AND app.created_at < v_month_end
          AND (
            upper(coalesce(app.status, '')) = 'SALARY_PAID'
            OR upper(coalesce(app.type, '')) = 'SALARY_PAYMENT'
          )
          AND (
            coalesce(app.created_by_pin, '') = coalesce(ew.pin, '')
            OR upper(coalesce(app.created_by_name, '')) = upper(coalesce(ew.name, ''))
          )
      ) AS already_paid_this_month
    FROM eligible_workers ew
  ),
  final_rows AS (
    SELECT
      wc.*,
      greatest(0, wc.auto_advance + wc.manual_advance)::numeric AS advance_deducted,
      CASE
        WHEN wc.already_paid_this_month THEN 0
        ELSE greatest(0, wc.salary_base - greatest(0, wc.auto_advance + wc.manual_advance))
      END::numeric AS net_pay,
      CASE
        WHEN wc.already_paid_this_month THEN 'PAID'
        WHEN wc.cash_open_at_close > 0 OR wc.pending_dispatch_at_close > 0 THEN 'BLOCKED'
        WHEN wc.salary_base <= 0 THEN 'REVIEW'
        ELSE 'PENDING_WORKER_ACCEPTANCE'
      END AS preview_status,
      CASE
        WHEN wc.already_paid_this_month THEN 'Already marked paid this month'
        WHEN wc.cash_open_at_close > 0 THEN 'Worker has open cash'
        WHEN wc.pending_dispatch_at_close > 0 THEN 'Worker has pending dispatch cash'
        WHEN wc.salary_base <= 0 THEN 'Missing salary base'
        ELSE null
      END AS block_reason
    FROM worker_calc wc
  )
  SELECT
    count(*)::integer,
    coalesce(sum(fr.salary_base), 0),
    coalesce(sum(fr.advance_deducted), 0),
    coalesce(sum(fr.net_pay), 0),
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'worker_id', fr.id,
          'worker_pin', fr.pin,
          'worker_name', fr.name,
          'worker_role', fr.role,
          'salary_base', fr.salary_base,
          'auto_advance', fr.auto_advance,
          'manual_advance', fr.manual_advance,
          'advance_deducted', fr.advance_deducted,
          'long_term_debt', fr.long_term_debt,
          'net_pay', fr.net_pay,
          'cash_open_at_close', fr.cash_open_at_close,
          'pending_dispatch_at_close', fr.pending_dispatch_at_close,
          'already_paid_this_month', fr.already_paid_this_month,
          'preview_status', fr.preview_status,
          'block_reason', fr.block_reason
        )
        ORDER BY fr.name, fr.pin
      ),
      '[]'::jsonb
    )
  INTO
    v_total_workers,
    v_salary_base_total,
    v_advances_total,
    v_payroll_net_total,
    v_workers
  FROM final_rows fr;

  IF v_cash_open_total > 0 THEN
    v_blocked_reasons := v_blocked_reasons || jsonb_build_array('Ka cash të hapur te punëtorët.');
  END IF;

  IF v_pending_dispatch_total > 0 THEN
    v_blocked_reasons := v_blocked_reasons || jsonb_build_array('Ka cash në pritje për aprovim nga dispatch.');
  END IF;

  IF v_existing_closed_close THEN
    v_blocked_reasons := v_blocked_reasons || jsonb_build_array('Ky muaj është mbyllur një herë si CLOSED.');
  END IF;

  IF v_company_balance < (v_payroll_net_total + v_essential_obligations_total) THEN
    v_blocked_reasons := v_blocked_reasons || jsonb_build_array('Company budget nuk mjafton për payroll net + obligime esenciale.');
  END IF;

  v_safe := (
    v_cash_open_total <= 0
    AND v_pending_dispatch_total <= 0
    AND v_existing_closed_close = false
    AND v_company_balance >= (v_payroll_net_total + v_essential_obligations_total)
  );

  RETURN jsonb_build_object(
    'ok', true,
    'safe', v_safe,
    'month_key', v_month_key,
    'month_start_kosovo', v_month_start,
    'month_end_kosovo', v_month_end,

    'blocked_reasons', v_blocked_reasons,

    'company_balance', v_company_balance,
    'total_workers', v_total_workers,
    'payroll_net_total', v_payroll_net_total,
    'salary_base_total', v_salary_base_total,
    'advances_total', v_advances_total,
    'essential_obligations_total', v_essential_obligations_total,
    'cash_open_total', v_cash_open_total,
    'pending_dispatch_total', v_pending_dispatch_total,
    'existing_closed_close', v_existing_closed_close,

    'budget_required_for_safety_check', v_payroll_net_total + v_essential_obligations_total,
    'budget_after_payroll_only', v_company_balance - v_payroll_net_total,
    'note', 'READ ONLY DRY RUN. Obligimet esenciale janë vetëm safety buffer. Close real më vonë duhet të zbresë vetëm payroll_net_total.',

    'workers', v_workers
  );
END;
$function$;
