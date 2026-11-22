CREATE OR REPLACE FUNCTION private.guard_arka_cash_payment_client_v2()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
declare
  v_is_cash boolean;
  v_client boolean := current_user in ('anon', 'authenticated', 'service_role');
  v_maintenance boolean :=
    current_user = 'postgres'
    and current_setting('tepiha.finance_maintenance', true) = 'on';
  v_user_name text;
begin
  v_is_cash :=
    upper(coalesce(case when tg_op = 'INSERT' then new.type else old.type end, ''))
      in ('IN', 'TRANSPORT')
    or (
      upper(coalesce(case when tg_op = 'INSERT' then new.source_module else old.source_module end, ''))
        = 'TRANSPORT'
      and upper(coalesce(case when tg_op = 'INSERT' then new.type else old.type end, ''))
        not in (
          'EXPENSE', 'TIMA', 'MEAL_PAYMENT', 'MEAL_COVERED',
          'READY_48H_BONUS', 'ADVANCE', 'SALARY_PAYMENT'
        )
    )
    or (
      tg_op = 'UPDATE'
      and (
        upper(coalesce(new.type, '')) in ('IN', 'TRANSPORT')
        or (
          upper(coalesce(new.source_module, '')) = 'TRANSPORT'
          and upper(coalesce(new.type, '')) not in (
            'EXPENSE', 'TIMA', 'MEAL_PAYMENT', 'MEAL_COVERED',
            'READY_48H_BONUS', 'ADVANCE', 'SALARY_PAYMENT'
          )
        )
      )
    );

  if not v_is_cash then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if v_client then
      new.created_by_pin := nullif(trim(coalesce(new.created_by_pin, '')), '');

      select u.name
      into v_user_name
      from public.users u
      where u.pin = new.created_by_pin
        and u.is_active is true
      limit 1;

      if v_user_name is null then
        raise exception 'ACTIVE_CASH_COLLECTOR_REQUIRED:%', new.created_by_pin;
      end if;

      new.created_by_name := v_user_name;
      new.created_at := coalesce(new.created_at, now());
      new.updated_at := now();
      new.idempotency_key := nullif(trim(coalesce(new.idempotency_key, '')), '');

      if new.created_at > now() + interval '10 minutes'
         or new.created_at < now() - interval '24 hours' then
        raise exception 'CASH_PAYMENT_TIMESTAMP_OUT_OF_RANGE:%', new.created_at;
      end if;
    end if;

    return new;
  end if;

  if not v_maintenance and (
       new.amount is distinct from old.amount
    or new.type is distinct from old.type
    or new.source_module is distinct from old.source_module
    or new.order_id is distinct from old.order_id
    or new.order_code is distinct from old.order_code
    or new.transport_order_id is distinct from old.transport_order_id
    or new.transport_code_str is distinct from old.transport_code_str
    or new.transport_m2 is distinct from old.transport_m2
    or new.created_by_pin is distinct from old.created_by_pin
    or new.created_by_name is distinct from old.created_by_name
    or new.idempotency_key is distinct from old.idempotency_key
    or new.created_at is distinct from old.created_at
  ) then
    raise exception 'CASH_PAYMENT_IDENTITY_AND_AMOUNT_ARE_IMMUTABLE:%', old.id;
  end if;

  if v_client then
    if upper(coalesce(old.status, '')) not in ('PENDING', 'COLLECTED')
       or new.status is distinct from old.status then
      raise exception 'CASH_PAYMENT_STATUS_IS_RPC_ONLY:%', old.id;
    end if;

    if (
      to_jsonb(new)
        - array['handed_by_pin', 'handed_by_name', 'updated_at']::text[]
    ) is distinct from (
      to_jsonb(old)
        - array['handed_by_pin', 'handed_by_name', 'updated_at']::text[]
    ) then
      raise exception 'CASH_PAYMENT_CLIENT_MUTATION_NOT_ALLOWED:%', old.id;
    end if;

    if new.handed_by_pin is distinct from old.handed_by_pin
       or new.handed_by_name is distinct from old.handed_by_name then
      if nullif(trim(coalesce(old.handed_by_pin, '')), '') is not null
         or nullif(trim(coalesce(new.handed_by_pin, '')), '') is null then
        raise exception 'CASH_PAYMENT_CLAIM_IS_ONE_TIME:%', old.id;
      end if;

      new.handed_by_pin := trim(new.handed_by_pin);

      select u.name
      into v_user_name
      from public.users u
      where u.pin = new.handed_by_pin
        and u.is_active is true
      limit 1;

      if v_user_name is null then
        raise exception 'ACTIVE_HANDOFF_CLAIMANT_REQUIRED:%', new.handed_by_pin;
      end if;

      new.handed_by_name := v_user_name;
    end if;

    new.updated_at := now();
  end if;

  return new;
end
$function$
;
