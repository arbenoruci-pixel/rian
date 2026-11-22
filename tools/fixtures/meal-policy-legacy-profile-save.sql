-- Legacy save function shape for isolated synthetic migration verification.
CREATE OR REPLACE FUNCTION public.save_worker_compensation_profile_v1(p_actor_pin text, p_actor_name text, p_worker_pin text, p_profile jsonb, p_change_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_actor_role text;
  v_before public.users%rowtype;
  v_after public.users%rowtype;
  v_cash_mode text;
  v_salary_enabled boolean;
  v_meal_enabled boolean;
  v_commission_enabled boolean;
  v_transport_bonus_enabled boolean;
  v_ready_bonus_enabled boolean;
  v_salary numeric(12,2);
  v_salary_day integer;
  v_meal numeric(12,2);
  v_rate numeric(12,4);
  v_transport_bonus numeric(12,2);
begin
  select upper(coalesce(role,'')) into v_actor_role
  from public.users
  where pin=trim(coalesce(p_actor_pin,'')) and is_active is true
  limit 1;
  if v_actor_role not in ('ADMIN','ADMIN_MASTER','DISPATCH','OWNER','PRONAR','SUPERADMIN','MASTER','MASTER_USER','MASTERUSER') then
    raise exception 'COMPENSATION_MANAGER_ONLY';
  end if;

  select * into v_before
  from public.users
  where pin=trim(coalesce(p_worker_pin,'')) and is_active is true
  for update;
  if not found then raise exception 'WORKER_NOT_FOUND:%',p_worker_pin; end if;

  v_salary_enabled := case when p_profile ? 'salary_enabled' then coalesce((p_profile->>'salary_enabled')::boolean,false) else v_before.pay_salary_enabled end;
  v_salary := greatest(0,round(coalesce(nullif(p_profile->>'salary_amount','')::numeric,v_before.salary,0)::numeric,2));
  v_salary_day := case when p_profile ? 'salary_day' then nullif(p_profile->>'salary_day','')::integer else v_before.salary_day end;
  if v_salary_day is not null and (v_salary_day<1 or v_salary_day>31) then raise exception 'SALARY_DAY_INVALID'; end if;

  v_meal_enabled := case when p_profile ? 'meal_enabled' then coalesce((p_profile->>'meal_enabled')::boolean,false) else v_before.pay_meal_enabled end;
  v_meal := greatest(0,round(coalesce(nullif(p_profile->>'meal_amount','')::numeric,v_before.pay_meal_amount,0)::numeric,2));

  v_commission_enabled := case when p_profile ? 'commission_enabled' then coalesce((p_profile->>'commission_enabled')::boolean,false) else v_before.pay_commission_enabled end;
  v_rate := greatest(0,round(coalesce(nullif(p_profile->>'commission_rate_m2','')::numeric,v_before.pay_commission_rate_m2,0)::numeric,4));

  v_transport_bonus_enabled := case when p_profile ? 'transport_bonus_enabled' then coalesce((p_profile->>'transport_bonus_enabled')::boolean,false) else v_before.pay_transport_bonus_enabled end;
  v_transport_bonus := greatest(0,round(coalesce(nullif(p_profile->>'transport_bonus_amount','')::numeric,v_before.pay_transport_bonus_amount,0)::numeric,2));

  v_ready_bonus_enabled := case when p_profile ? 'ready_bonus_enabled' then coalesce((p_profile->>'ready_bonus_enabled')::boolean,false) else v_before.pay_ready_bonus_enabled end;
  if upper(coalesce(v_before.role,''))='TRANSPORT' then v_ready_bonus_enabled := false; end if;

  v_cash_mode := upper(coalesce(nullif(trim(p_profile->>'cash_mode'),''),v_before.pay_cash_mode,'FULL_CASH'));
  if v_cash_mode not in ('FULL_CASH','HYBRID_COMMISSION','NO_CASH') then raise exception 'CASH_MODE_INVALID:%',v_cash_mode; end if;
  if v_cash_mode='HYBRID_COMMISSION' and not v_commission_enabled then raise exception 'HYBRID_MODE_REQUIRES_COMMISSION'; end if;
  if not v_commission_enabled then
    v_rate := 0;
    if v_cash_mode='HYBRID_COMMISSION' then v_cash_mode := 'FULL_CASH'; end if;
  end if;

  update public.users
  set salary=case when v_salary_enabled then v_salary else 0 end,
      salary_day=v_salary_day,
      pay_salary_enabled=v_salary_enabled,
      pay_meal_enabled=v_meal_enabled,
      pay_meal_amount=case when v_meal_enabled then v_meal else 0 end,
      pay_commission_enabled=v_commission_enabled,
      pay_commission_rate_m2=case when v_commission_enabled then v_rate else 0 end,
      pay_transport_bonus_enabled=v_transport_bonus_enabled,
      pay_transport_bonus_amount=case when v_transport_bonus_enabled then v_transport_bonus else 0 end,
      pay_ready_bonus_enabled=v_ready_bonus_enabled,
      pay_cash_mode=v_cash_mode,
      pay_notes=coalesce(p_profile->>'notes',pay_notes),
      pay_updated_at=now(),
      pay_updated_by_pin=trim(p_actor_pin),
      pay_updated_by_name=coalesce(nullif(trim(p_actor_name),''),trim(p_actor_pin)),
      -- Legacy compatibility fields stay synchronized.
      bonus_ushqim=case when v_meal_enabled then v_meal else 0 end,
      bonus_transport=case when v_transport_bonus_enabled then v_transport_bonus else 0 end,
      is_hybrid_transport=v_commission_enabled and v_cash_mode='HYBRID_COMMISSION',
      commission_rate_m2=case when v_commission_enabled and v_cash_mode='HYBRID_COMMISSION' then v_rate else 0 end
  where id=v_before.id
  returning * into v_after;

  insert into public.worker_compensation_audit(
    worker_pin,worker_name,before_profile,after_profile,changed_by_pin,changed_by_name,change_note
  ) values (
    v_before.pin,v_before.name,to_jsonb(v_before),to_jsonb(v_after),trim(p_actor_pin),
    coalesce(nullif(trim(p_actor_name),''),trim(p_actor_pin)),nullif(trim(coalesce(p_change_note,'')),'')
  );

  return public.get_worker_compensation_profile_v1(p_actor_pin,p_worker_pin);
end;
$function$;
