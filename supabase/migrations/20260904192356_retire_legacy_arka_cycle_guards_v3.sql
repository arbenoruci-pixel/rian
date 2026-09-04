-- Retire the obsolete ARKA day open/close gate while preserving financial integrity.
-- Historical cycle tables remain read-only data; active transactions no longer depend on them.

-- 1) Remove any trigger bindings whose sole purpose is the old open/close gate.
do $$
declare
  r record;
begin
  for r in
    select tn.nspname as table_schema, c.relname as table_name, t.tgname
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace tn on tn.oid = c.relnamespace
    join pg_proc p on p.oid = t.tgfoid
    join pg_namespace pn on pn.oid = p.pronamespace
    where not t.tgisinternal
      and pn.nspname = 'public'
      and p.proname in (
        'guard_company_ledger_after_closed_day_v2',
        'guard_dispatch_expense_after_closed_day_v1',
        'guard_closed_arka_cycle_v2',
        'arka_pending_guard_apply',
        'guard_handoff_accept_daily_close_v2'
      )
  loop
    execute format('drop trigger if exists %I on %I.%I', r.tgname, r.table_schema, r.table_name);
  end loop;
end
$$;

-- 2) Keep the cash-handoff integrity guard, but allow the controlled server RPC
--    to accept a handoff without a daily-close session flag.
create or replace function private.guard_cash_handoff_v1()
returns trigger
language plpgsql
set search_path to 'pg_catalog', 'public', 'pg_temp'
as $function$
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

-- 3) Keep payment identity/status integrity, but remove the official-daily-close
--    requirement from the controlled ACCEPTED_BY_DISPATCH transition.
create or replace function private.guard_arka_cash_payment_v1()
returns trigger
language plpgsql
set search_path to 'pg_catalog', 'public', 'pg_temp'
as $function$
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

-- 4) Preserve the deferred integrity check, but stop requiring an arka_cycles
--    record or arka_daily_close_items row.
create or replace function private.assert_accepted_handoff_complete_v1()
returns trigger
language plpgsql
security definer
set search_path to 'pg_catalog', 'public', 'private', 'pg_temp'
as $function$
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

-- 5) Dispatch is an authorized payroll manager.
create or replace function public.create_worker_advance_pro_v1(
  p_actor_pin text,
  p_actor_name text,
  p_worker_pin text,
  p_amount numeric,
  p_note text default 'AVANS'::text,
  p_idempotency_key text default null::text
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_actor public.users%rowtype;
  v_worker public.users%rowtype;
  v_amount numeric(12,2) := round(coalesce(p_amount,0)::numeric,2);
  v_key text;
  v_result jsonb;
  v_advance_id bigint;
  v_advance public.arka_pending_payments%rowtype;
  v_active_total numeric(12,2);
begin
  select * into v_actor
  from public.users
  where pin=btrim(coalesce(p_actor_pin,'')) and is_active is true
  limit 1;

  if v_actor.id is null then raise exception using message='WORKER_ADVANCE_ACTOR_NOT_FOUND'; end if;
  if not (
    coalesce(v_actor.is_master,false)
    or upper(coalesce(v_actor.role,'')) in (
      'DISPATCH','ADMIN','ADMIN_MASTER','OWNER','PRONAR','SUPERADMIN',
      'MASTER','MASTER USER','MASTER_USER','MASTERUSER'
    )
  ) then raise exception using message='WORKER_ADVANCE_MANAGER_ONLY'; end if;

  select * into v_worker
  from public.users
  where pin=btrim(coalesce(p_worker_pin,'')) and is_active is true
  limit 1;
  if v_worker.id is null then raise exception using message='WORKER_ADVANCE_WORKER_NOT_FOUND'; end if;
  if v_amount<=0 then raise exception using message='WORKER_ADVANCE_AMOUNT_INVALID'; end if;

  v_key := coalesce(
    nullif(btrim(coalesce(p_idempotency_key,'')),''),
    'WORKER_ADVANCE_PRO_V1:'||v_worker.pin||':'||v_amount::text||':'||md5(coalesce(p_note,'AVANS'))
  );

  v_result := public.create_arka_advance_atomic_v2(
    v_actor.pin,
    coalesce(nullif(btrim(coalesce(p_actor_name,'')),''),v_actor.name,v_actor.pin),
    v_worker.pin,
    v_worker.name,
    v_amount,
    coalesce(nullif(btrim(coalesce(p_note,'')),''),'AVANS'),
    v_key
  );

  begin
    v_advance_id := nullif(v_result#>>'{advance,id}','')::bigint;
  exception when others then
    v_advance_id := null;
  end;

  if v_advance_id is null then
    select id into v_advance_id
    from public.arka_pending_payments
    where idempotency_key=v_key
    limit 1;
  end if;

  select * into v_advance
  from public.arka_pending_payments
  where id=v_advance_id;

  if v_advance.id is null then
    raise exception using message='WORKER_ADVANCE_WRITE_NOT_VERIFIED';
  end if;

  insert into public.worker_history_entries(
    worker_id,worker_pin,worker_name,occurred_at,period_key,
    event_type,event_family,amount,balance_delta,m2,rate,quantity,
    source_module,source_table,source_id,source_ref,description,
    status,quality,idempotency_key,created_by_pin,created_by_name,metadata
  ) values (
    v_worker.id,v_worker.pin,v_worker.name,coalesce(v_advance.created_at,now()),
    to_char(coalesce(v_advance.created_at,now()) at time zone 'Europe/Belgrade','YYYY-MM'),
    'ADVANCE_RECEIVED','PAYMENT',round(v_advance.amount,2),round(-v_advance.amount,2),0,0,1,
    'ARKA','arka_pending_payments',v_advance.id::text,v_worker.pin,
    coalesce(nullif(v_advance.note,''),'Avans i marrë'),
    case when upper(coalesce(v_advance.status,'')) in ('CANCELLED','CANCELED','VOIDED','REJECTED')
         then 'VOIDED' else 'POSTED' end,
    'EXACT','ARKA_ADVANCE_PAYMENT:'||v_advance.id::text||':RECEIVED',
    v_actor.pin,coalesce(v_actor.name,v_actor.pin),
    jsonb_build_object(
      'advance_payment_id',v_advance.id,
      'advance_status',v_advance.status,
      'idempotency_key',v_key,
      'approved_by_pin',v_advance.approved_by_pin,
      'approved_by_name',v_advance.approved_by_name,
      'source_module',v_advance.source_module
    )
  )
  on conflict(idempotency_key) do update set
    worker_id=excluded.worker_id,
    worker_pin=excluded.worker_pin,
    worker_name=excluded.worker_name,
    occurred_at=excluded.occurred_at,
    period_key=excluded.period_key,
    amount=excluded.amount,
    balance_delta=excluded.balance_delta,
    description=excluded.description,
    status=excluded.status,
    created_by_pin=excluded.created_by_pin,
    created_by_name=excluded.created_by_name,
    metadata=excluded.metadata,
    updated_at=now();

  perform public.worker_history_refresh_snapshots_v1();

  select round(coalesce(sum(amount),0)::numeric,2)
  into v_active_total
  from public.arka_pending_payments
  where created_by_pin=v_worker.pin
    and upper(coalesce(type,''))='ADVANCE'
    and upper(coalesce(status,''))='ADVANCE';

  return coalesce(v_result,'{}'::jsonb) || jsonb_build_object(
    'ok',true,
    'version','WORKER_ADVANCE_PRO_V1',
    'worker',jsonb_build_object('id',v_worker.id,'pin',v_worker.pin,'name',v_worker.name),
    'advance_payment_id',v_advance.id,
    'amount',round(v_advance.amount,2),
    'active_advance_total',coalesce(v_active_total,0),
    'company_balance',(select current_balance from public.company_budget_summary where id=1)
  );
end;
$function$;

-- 6) New expenses are ordinary ARKA transactions; they are no longer tagged as
--    daily-close operations.
create or replace function public.create_and_resolve_arka_expense_v2(
  p_actor_pin text,
  p_actor_name text,
  p_amount numeric,
  p_note text,
  p_resolution text default 'BUSINESS_EXPENSE'::text,
  p_beneficiary_pin text default null::text,
  p_beneficiary_name text default null::text,
  p_idempotency_key text default null::text
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_role text;
  v_actor_name text;
  v_amount numeric(12,2) := round(coalesce(p_amount,0)::numeric,2);
  v_note text := trim(coalesce(p_note,''));
  v_resolution text := upper(trim(coalesce(p_resolution,'BUSINESS_EXPENSE')));
  v_key text;
  v_expense_id bigint;
  v_existing public.arka_pending_payments%rowtype;
  v_result jsonb;
begin
  if nullif(trim(coalesce(p_actor_pin,'')),'') is null then raise exception 'MISSING_ACTOR_PIN'; end if;
  if v_amount<=0 then raise exception 'INVALID_EXPENSE_AMOUNT'; end if;
  if length(v_note)<2 then raise exception 'EXPENSE_NOTE_REQUIRED'; end if;
  if v_resolution not in ('BUSINESS_EXPENSE','PERSONAL_ADVANCE') then
    raise exception 'INVALID_NEW_EXPENSE_RESOLUTION';
  end if;

  select upper(coalesce(role,'')),
         coalesce(nullif(trim(p_actor_name),''),name,trim(p_actor_pin))
  into v_role,v_actor_name
  from public.users
  where pin=trim(p_actor_pin) and is_active is true
  limit 1;

  if v_role not in (
    'DISPATCH','MASTER','MASTER USER','MASTER_USER','MASTERUSER',
    'ADMIN','ADMIN_MASTER','OWNER','PRONAR','SUPERADMIN'
  ) then
    raise exception 'DISPATCH_ONLY';
  end if;

  v_key := coalesce(
    nullif(trim(coalesce(p_idempotency_key,'')),''),
    'ARKA_EXPENSE_V3:'||trim(p_actor_pin)||':'||
      md5(v_amount::text||':'||v_note||':'||v_resolution)
  );
  perform pg_advisory_xact_lock(hashtext(v_key));

  select * into v_existing
  from public.arka_pending_payments
  where idempotency_key=v_key
  limit 1;

  if found then
    v_result := public.resolve_arka_expense_v2(
      trim(p_actor_pin),v_actor_name,v_existing.id,v_resolution,
      p_beneficiary_pin,p_beneficiary_name,'RIPROVIM IDEMPOTENT NGA ARKA'
    );
    return jsonb_build_object(
      'ok',true,
      'already_exists',true,
      'expense_payment_id',v_existing.id,
      'resolution_result',v_result
    );
  end if;

  insert into public.arka_pending_payments(
    amount,type,status,note,created_by_pin,created_by_name,source_module,
    idempotency_key,created_at,updated_at
  ) values (
    v_amount,'EXPENSE','PENDING',
    v_note||E'\nARKA_EXPENSE_REQUEST_V3 type='||v_resolution,
    trim(p_actor_pin),v_actor_name,'ARKA',
    v_key,now(),now()
  ) returning id into v_expense_id;

  v_result := public.resolve_arka_expense_v2(
    trim(p_actor_pin),v_actor_name,v_expense_id,v_resolution,
    p_beneficiary_pin,p_beneficiary_name,'SHTUAR DHE VENDOSUR NGA ARKA'
  );

  return jsonb_build_object(
    'ok',true,
    'already_exists',false,
    'expense_payment_id',v_expense_id,
    'amount',v_amount,
    'resolution',v_resolution,
    'budget_balance',(select current_balance from public.company_budget_summary where id=1),
    'resolution_result',v_result
  );
end;
$function$;

-- 7) Delete obsolete trigger functions after their bindings are gone.
drop function if exists public.guard_handoff_accept_daily_close_v2();
drop function if exists public.guard_company_ledger_after_closed_day_v2();
drop function if exists public.guard_dispatch_expense_after_closed_day_v1();
drop function if exists public.guard_closed_arka_cycle_v2();
drop function if exists public.arka_pending_guard_apply();

-- 8) Retire open/close RPCs from every API role. Historical rows remain intact.
revoke all on function public.arka_open_cycle_safe(date) from public, anon, authenticated, service_role;
revoke all on function public.close_arka_day_v2(text,text,date,bigint[],numeric,text,text,text,boolean) from public, anon, authenticated, service_role;
revoke all on function public.get_arka_daily_close_preview_v2(text,date) from public, anon, authenticated, service_role;
revoke all on function public.get_arka_daily_close_preview_v3(text,date) from public, anon, authenticated, service_role;
revoke all on function public.get_arka_daily_close_preview_v4(text,date) from public, anon, authenticated, service_role;
revoke all on function public.add_arka_closed_day_expense_v1(text,text,date,numeric,text,text) from public, anon, authenticated, service_role;

-- Controlled active write paths.
grant execute on function public.create_worker_advance_pro_v1(text,text,text,numeric,text,text) to service_role;
grant execute on function public.create_arka_advance_atomic_v2(text,text,text,text,numeric,text,text) to service_role;
grant execute on function public.accept_cash_handoff_atomic(bigint,text,text) to service_role;

comment on function public.create_worker_advance_pro_v1(text,text,text,numeric,text,text)
  is 'Active payroll advance path. Authorized roles include DISPATCH and admin roles; independent of arka day cycles.';
comment on function public.accept_cash_handoff_atomic(bigint,text,text)
  is 'Active direct dispatch handoff acceptance path. Preserves item/payment/ledger integrity without daily-close cycles.';
