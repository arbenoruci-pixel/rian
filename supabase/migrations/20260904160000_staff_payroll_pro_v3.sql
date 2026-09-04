-- STAFF_PAYROLL_PRO_V3
-- Canonical, device-authenticated worker advances are created through the
-- /api/arka/worker-control endpoint. This wrapper keeps the accounting write
-- atomic, limits elevated Dispatch access to is_master users, and records the
-- advance in the worker history ledger.

create or replace function public.create_worker_advance_pro_v1(
  p_actor_pin text,
  p_actor_name text,
  p_worker_pin text,
  p_amount numeric,
  p_note text default 'AVANS',
  p_idempotency_key text default null
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

  if v_actor.id is null then
    raise exception using message='WORKER_ADVANCE_ACTOR_NOT_FOUND';
  end if;

  if not (
    coalesce(v_actor.is_master,false)
    or upper(coalesce(v_actor.role,'')) in (
      'ADMIN','ADMIN_MASTER','OWNER','PRONAR','SUPERADMIN',
      'MASTER','MASTER USER','MASTER_USER','MASTERUSER'
    )
  ) then
    raise exception using message='WORKER_ADVANCE_MANAGER_ONLY';
  end if;

  select * into v_worker
  from public.users
  where pin=btrim(coalesce(p_worker_pin,'')) and is_active is true
  limit 1;

  if v_worker.id is null then
    raise exception using message='WORKER_ADVANCE_WORKER_NOT_FOUND';
  end if;
  if v_amount<=0 then
    raise exception using message='WORKER_ADVANCE_AMOUNT_INVALID';
  end if;

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
    case when upper(coalesce(v_advance.status,'')) in ('CANCELLED','CANCELED','VOIDED','REJECTED') then 'VOIDED' else 'POSTED' end,
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

  select round(coalesce(sum(amount),0)::numeric,2) into v_active_total
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

revoke all on function public.create_worker_advance_pro_v1(text,text,text,numeric,text,text) from public;
revoke all on function public.create_worker_advance_pro_v1(text,text,text,numeric,text,text) from anon;
revoke all on function public.create_worker_advance_pro_v1(text,text,text,numeric,text,text) from authenticated;
grant execute on function public.create_worker_advance_pro_v1(text,text,text,numeric,text,text) to service_role;

comment on function public.create_worker_advance_pro_v1(text,text,text,numeric,text,text)
is 'STAFF_PAYROLL_PRO_V3: atomic worker advance for authenticated manager API, with budget and worker-history linkage.';

-- Backfill direct ARKA advances that were not already represented by an
-- expense-decision event. Settled rows remain part of history; only status
-- ADVANCE is considered active by payroll and the worker card.
insert into public.worker_history_entries(
  worker_id,worker_pin,worker_name,occurred_at,period_key,
  event_type,event_family,amount,balance_delta,m2,rate,quantity,
  source_module,source_table,source_id,source_ref,description,
  status,quality,idempotency_key,created_by_pin,created_by_name,metadata
)
select
  u.id,u.pin,u.name,coalesce(p.created_at,p.updated_at,now()),
  to_char(coalesce(p.created_at,p.updated_at,now()) at time zone 'Europe/Belgrade','YYYY-MM'),
  'ADVANCE_RECEIVED','PAYMENT',round(p.amount,2),round(-p.amount,2),0,0,1,
  'ARKA','arka_pending_payments',p.id::text,u.pin,
  coalesce(nullif(p.note,''),'Avans i marrë'),
  case when upper(coalesce(p.status,'')) in ('CANCELLED','CANCELED','VOIDED','REJECTED') then 'VOIDED' else 'POSTED' end,
  'EXACT','ARKA_ADVANCE_PAYMENT:'||p.id::text||':RECEIVED',
  coalesce(p.approved_by_pin,p.handed_by_pin),coalesce(p.approved_by_name,p.handed_by_name),
  jsonb_build_object('advance_payment_id',p.id,'advance_status',p.status,'source_module',p.source_module)
from public.arka_pending_payments p
join public.users u on u.pin=p.created_by_pin
where upper(coalesce(p.type,''))='ADVANCE'
  and coalesce(p.amount,0)>0
  and upper(coalesce(p.source_module,''))<>'ARKA_EXPENSE_DECISION'
  and not exists(
    select 1 from public.arka_expense_decisions d
    where d.finalized_payment_id=p.id and d.decision_type='PERSONAL_ADVANCE'
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
  metadata=excluded.metadata,
  updated_at=now();

select public.worker_history_refresh_snapshots_v1();
