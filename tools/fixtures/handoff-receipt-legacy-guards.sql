CREATE OR REPLACE FUNCTION private.guard_arka_cash_payment_v1()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
declare
  v_is_cash boolean;
  v_old_status text;
  v_new_status text;
  v_maintenance boolean :=
    current_user='postgres'
    and current_setting('tepiha.finance_maintenance',true)='on';
  v_count integer;
  v_critical_changed boolean;
begin
  if tg_op='INSERT' then
    v_is_cash :=
      upper(coalesce(new.type,'')) in ('IN','TRANSPORT')
      or (
        upper(coalesce(new.source_module,''))='TRANSPORT'
        and upper(coalesce(new.type,'')) not in (
          'EXPENSE','TIMA','MEAL_PAYMENT','MEAL_COVERED',
          'READY_48H_BONUS','ADVANCE','SALARY_PAYMENT'
        )
      );

    if v_is_cash and not v_maintenance then
      if coalesce(new.amount,0) <= 0 then
        raise exception 'CASH_PAYMENT_AMOUNT_MUST_BE_POSITIVE';
      end if;
      if upper(coalesce(new.status,'')) not in ('PENDING','COLLECTED') then
        raise exception 'NEW_CASH_PAYMENT_MUST_START_OPEN:%',new.status;
      end if;
      if nullif(trim(coalesce(new.idempotency_key,'')),'') is null then
        raise exception 'CASH_PAYMENT_IDEMPOTENCY_KEY_REQUIRED';
      end if;
      if nullif(trim(coalesce(new.created_by_pin,'')),'') is null
         or not exists (
           select 1 from public.users u
           where u.pin=trim(new.created_by_pin) and u.is_active is true
         ) then
        raise exception 'ACTIVE_CASH_COLLECTOR_REQUIRED:%',new.created_by_pin;
      end if;
    end if;
    return new;
  end if;

  v_is_cash :=
    upper(coalesce(old.type,'')) in ('IN','TRANSPORT')
    or upper(coalesce(new.type,'')) in ('IN','TRANSPORT')
    or (
      upper(coalesce(old.source_module,''))='TRANSPORT'
      and upper(coalesce(old.type,'')) not in (
        'EXPENSE','TIMA','MEAL_PAYMENT','MEAL_COVERED',
        'READY_48H_BONUS','ADVANCE','SALARY_PAYMENT'
      )
    );

  if not v_is_cash or v_maintenance then
    return new;
  end if;

  v_old_status := upper(coalesce(old.status,''));
  v_new_status := upper(coalesce(new.status,''));

  v_critical_changed :=
       new.amount is distinct from old.amount
    or new.type is distinct from old.type
    or new.source_module is distinct from old.source_module
    or new.order_id is distinct from old.order_id
    or new.order_code is distinct from old.order_code
    or new.transport_order_id is distinct from old.transport_order_id
    or new.transport_code_str is distinct from old.transport_code_str
    or new.created_by_pin is distinct from old.created_by_pin
    or new.created_by_name is distinct from old.created_by_name
    or new.idempotency_key is distinct from old.idempotency_key
    or new.created_at is distinct from old.created_at;

  if v_critical_changed then
    if v_old_status in ('ACCEPTED','ACCEPTED_BY_DISPATCH') then
      raise exception 'ACCEPTED_CASH_PAYMENT_IS_IMMUTABLE:%',old.id;
    end if;
    if current_user <> 'postgres' then
      raise exception 'CASH_PAYMENT_IDENTITY_AND_AMOUNT_ARE_IMMUTABLE:%',old.id;
    end if;
  end if;

  if v_new_status is not distinct from v_old_status then
    return new;
  end if;

  if v_old_status in ('ACCEPTED','ACCEPTED_BY_DISPATCH') then
    raise exception 'ACCEPTED_CASH_PAYMENT_STATUS_IS_TERMINAL:%',old.id;
  end if;

  if v_new_status='PENDING_DISPATCH_APPROVAL' then
    if v_old_status not in ('PENDING','COLLECTED') then
      raise exception 'INVALID_CASH_PAYMENT_TRANSITION:%->%',v_old_status,v_new_status;
    end if;

    select count(*)::integer into v_count
    from public.cash_handoff_items i
    join public.cash_handoffs h on h.id=i.handoff_id
    where i.pending_payment_id=new.id
      and i.released_at is null
      and upper(coalesce(h.status,''))='PENDING_DISPATCH_APPROVAL'
      and trim(coalesce(h.worker_pin,''))=trim(coalesce(new.created_by_pin,''));

    if v_count <> 1 then
      raise exception 'PENDING_APPROVAL_REQUIRES_ONE_MATCHED_HANDOFF:%:%',new.id,v_count;
    end if;

  elsif v_new_status='ACCEPTED_BY_DISPATCH' then
    if v_old_status <> 'PENDING_DISPATCH_APPROVAL'
       or current_user <> 'postgres' then
      raise exception 'CASH_ACCEPTANCE_REQUIRES_SERVER_RPC:%',new.id;
    end if;

    select count(*)::integer into v_count
    from public.cash_handoff_items i
    join public.cash_handoffs h on h.id=i.handoff_id
    join public.company_budget_ledger l
      on l.id=h.company_ledger_entry_id
     and lower(coalesce(l.source_type,''))='cash_handoff'
     and l.source_id=h.id
     and abs(l.amount-h.amount) <= 0.01
    where i.pending_payment_id=new.id
      and i.released_at is null
      and upper(coalesce(h.status,''))='ACCEPTED';

    if v_count <> 1 then
      raise exception 'CASH_ACCEPTANCE_CHAIN_INCOMPLETE:%:%',new.id,v_count;
    end if;

  elsif v_new_status in ('PENDING','COLLECTED') then
    if v_old_status='PENDING_DISPATCH_APPROVAL' then
      if current_user <> 'postgres'
         or current_setting('tepiha.handoff_reject_context',true) <> 'on'
         or exists (
           select 1 from public.cash_handoff_items i
           where i.pending_payment_id=new.id and i.released_at is null
         ) then
        raise exception 'CASH_PAYMENT_RELEASE_REQUIRES_ATOMIC_REJECT:%',new.id;
      end if;
    elsif v_old_status not in ('PENDING','COLLECTED') then
      raise exception 'INVALID_CASH_PAYMENT_REOPEN:%->%',v_old_status,v_new_status;
    end if;

  elsif v_new_status='VOIDED' then
    if current_user <> 'postgres'
       or exists (
         select 1 from public.cash_handoff_items i
         where i.pending_payment_id=new.id and i.released_at is null
       ) then
      raise exception 'CASH_VOID_REQUIRES_CONTROLLED_UNLINKED_RPC:%',new.id;
    end if;

  else
    raise exception 'INVALID_CASH_PAYMENT_TRANSITION:%->%',v_old_status,v_new_status;
  end if;

  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION private.guard_cash_handoff_v1()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
declare
  v_maintenance boolean :=
    current_user='postgres'
    and current_setting('tepiha.finance_maintenance',true)='on';
  v_old_status text;
  v_new_status text;
  v_item_count integer;
  v_link_count integer;
  v_bad_payments integer;
  v_item_sum numeric;
  v_ledger_count integer;
begin
  if v_maintenance then
    return new;
  end if;

  if tg_op='INSERT' then
    if coalesce(new.amount,0) <= 0 then
      raise exception 'HANDOFF_AMOUNT_MUST_BE_POSITIVE';
    end if;
    if upper(coalesce(new.status,'')) <> 'PENDING_DISPATCH_APPROVAL' then
      raise exception 'HANDOFF_MUST_START_PENDING_DISPATCH_APPROVAL';
    end if;
    if new.company_ledger_entry_id is not null then
      raise exception 'NEW_HANDOFF_CANNOT_HAVE_LEDGER';
    end if;
    if nullif(trim(coalesce(new.worker_pin,'')),'') is null
       or not exists (
         select 1 from public.users u
         where u.pin=trim(new.worker_pin) and u.is_active is true
       ) then
      raise exception 'ACTIVE_HANDOFF_WORKER_REQUIRED:%',new.worker_pin;
    end if;
    return new;
  end if;

  v_old_status := upper(coalesce(old.status,''));
  v_new_status := upper(coalesce(new.status,''));

  if old.worker_pin is distinct from new.worker_pin
     or old.worker_name is distinct from new.worker_name then
    if current_user <> 'postgres' then
      raise exception 'HANDOFF_WORKER_IS_IMMUTABLE:%',old.id;
    end if;
  end if;

  if old.amount is distinct from new.amount then
    if current_user <> 'postgres'
       or v_old_status <> 'PENDING_DISPATCH_APPROVAL' then
      raise exception 'HANDOFF_AMOUNT_CHANGE_NOT_ALLOWED:%',old.id;
    end if;
  end if;

  if old.company_ledger_entry_id is distinct from new.company_ledger_entry_id
     and current_user <> 'postgres' then
    raise exception 'HANDOFF_LEDGER_LINK_SERVER_ONLY:%',old.id;
  end if;

  if v_old_status in ('ACCEPTED','REJECTED','CANCELLED')
     and v_new_status is distinct from v_old_status then
    raise exception 'TERMINAL_HANDOFF_STATUS_IS_IMMUTABLE:%',old.id;
  end if;

  if v_new_status is not distinct from v_old_status then
    return new;
  end if;

  if v_old_status <> 'PENDING_DISPATCH_APPROVAL' then
    raise exception 'INVALID_HANDOFF_TRANSITION:%->%',v_old_status,v_new_status;
  end if;

  if v_new_status='ACCEPTED' then
    if current_user <> 'postgres' then
      raise exception 'HANDOFF_ACCEPTANCE_REQUIRES_SERVER_RPC:%',old.id;
    end if;

    select
      count(*)::integer,
      count(i.pending_payment_id)::integer,
      coalesce(round(sum(i.amount)::numeric,2),0),
      count(*) filter (
        where p.id is null
           or upper(coalesce(p.status,'')) <> 'PENDING_DISPATCH_APPROVAL'
      )::integer
    into v_item_count,v_link_count,v_item_sum,v_bad_payments
    from public.cash_handoff_items i
    left join public.arka_pending_payments p on p.id=i.pending_payment_id
    where i.handoff_id=old.id and i.released_at is null;

    if v_item_count <= 0
       or v_item_count <> v_link_count
       or abs(v_item_sum-new.amount) > 0.01
       or v_bad_payments > 0 then
      raise exception
        'HANDOFF_ACCEPT_INTEGRITY_FAILED:id=% items=% links=% sum=% amount=% bad_payments=%',
        old.id,v_item_count,v_link_count,v_item_sum,new.amount,v_bad_payments;
    end if;

    select count(*)::integer into v_ledger_count
    from public.company_budget_ledger l
    where l.id=new.company_ledger_entry_id
      and lower(coalesce(l.source_type,''))='cash_handoff'
      and l.source_id=old.id
      and upper(coalesce(l.direction,''))='IN'
      and abs(l.amount-new.amount) <= 0.01;

    if v_ledger_count <> 1 then
      raise exception 'HANDOFF_ACCEPT_LEDGER_MISSING_OR_MISMATCH:%',old.id;
    end if;

  elsif v_new_status in ('REJECTED','CANCELLED') then
    if current_user <> 'postgres'
       or current_setting('tepiha.handoff_reject_context',true) <> 'on' then
      raise exception 'HANDOFF_REJECT_REQUIRES_ATOMIC_RPC:%',old.id;
    end if;

  else
    raise exception 'INVALID_HANDOFF_TRANSITION:%->%',v_old_status,v_new_status;
  end if;

  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION private.guard_company_budget_ledger_v1()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
declare
  v_maintenance boolean :=
    current_user='postgres'
    and current_setting('tepiha.finance_maintenance',true)='on';
  v_h public.cash_handoffs%rowtype;
begin
  if v_maintenance then
    return new;
  end if;

  if tg_op='INSERT' then
    if lower(coalesce(new.source_type,''))='cash_handoff' then
      if current_user <> 'postgres' then
        raise exception 'CASH_HANDOFF_LEDGER_SERVER_ONLY';
      end if;
      select * into v_h from public.cash_handoffs where id=new.source_id;
      if not found
         or upper(coalesce(v_h.status,'')) <> 'PENDING_DISPATCH_APPROVAL'
         or upper(coalesce(new.direction,'')) <> 'IN'
         or abs(coalesce(new.amount,0)-coalesce(v_h.amount,0)) > 0.01 then
        raise exception 'CASH_HANDOFF_LEDGER_INVALID:%',new.source_id;
      end if;
    end if;
    return new;
  end if;

  if lower(coalesce(old.source_type,''))='cash_handoff'
     or lower(coalesce(new.source_type,''))='cash_handoff' then
    raise exception 'CASH_HANDOFF_LEDGER_IS_IMMUTABLE:%',old.id;
  end if;

  if current_user in ('anon','authenticated') then
    raise exception 'LEDGER_UPDATE_SERVER_ONLY:%',old.id;
  end if;

  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION private.assert_accepted_handoff_complete_v1()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public', 'private', 'pg_temp'
AS $function$
declare
  v_item_count integer;
  v_link_count integer;
  v_distinct_payments integer;
  v_bad_payments integer;
  v_item_sum numeric;
  v_ledger_count integer;
begin
  select
    count(*)::integer,
    count(i.pending_payment_id)::integer,
    count(distinct i.pending_payment_id)::integer,
    count(*) filter (
      where p.id is null
         or upper(coalesce(p.status,'')) <> 'ACCEPTED_BY_DISPATCH'
    )::integer,
    coalesce(round(sum(i.amount)::numeric,2),0)
  into
    v_item_count,v_link_count,v_distinct_payments,v_bad_payments,v_item_sum
  from public.cash_handoff_items i
  left join public.arka_pending_payments p on p.id=i.pending_payment_id
  where i.handoff_id=new.id and i.released_at is null;

  if v_item_count <= 0
     or v_item_count <> v_link_count
     or v_item_count <> v_distinct_payments
     or v_bad_payments > 0
     or abs(v_item_sum-new.amount) > 0.01 then
    raise exception
      'DEFERRED_HANDOFF_PAYMENT_CHAIN_FAILED:id=% items=% links=% distinct=% bad=% sum=% amount=%',
      new.id,v_item_count,v_link_count,v_distinct_payments,
      v_bad_payments,v_item_sum,new.amount;
  end if;

  select count(*)::integer into v_ledger_count
  from public.company_budget_ledger l
  where l.id=new.company_ledger_entry_id
    and lower(coalesce(l.source_type,''))='cash_handoff'
    and l.source_id=new.id
    and upper(coalesce(l.direction,''))='IN'
    and abs(l.amount-new.amount) <= 0.01;

  if v_ledger_count <> 1 then
    raise exception 'DEFERRED_HANDOFF_LEDGER_CHAIN_FAILED:%',new.id;
  end if;

  return new;
end;
$function$;
