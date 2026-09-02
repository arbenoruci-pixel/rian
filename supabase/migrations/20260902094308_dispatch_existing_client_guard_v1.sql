begin;

-- Authoritative Dispatch phone inspection. The browser reaches this function
-- only through the approved-device API, so customer history stays server-only.
create or replace function public.inspect_dispatch_transport_phone(p_phone text)
returns jsonb
language sql
stable
security invoker
set search_path to 'public','pg_temp'
as $$
  with client_lookup as (
    select public.find_transport_client_by_phone_fast(p_phone) as payload
  ),
  wanted as (
    select public.normalize_transport_phone_key(p_phone) as phone_key
  ),
  active_order as (
    select jsonb_build_object(
      'id',o.id,
      'client_id',o.client_id,
      'client_tcode',o.client_tcode,
      'code_str',o.code_str,
      'client_name',o.client_name,
      'client_phone',o.client_phone,
      'status',o.status,
      'visit_nr',o.visit_nr,
      'created_at',o.created_at,
      'updated_at',o.updated_at
    ) as payload
    from public.transport_orders o
    cross join wanted w
    where length(w.phone_key)>=8
      and public.normalize_transport_phone_key(coalesce(
        o.client_phone,
        o.data->>'client_phone',
        o.data->'client'->>'phone',
        ''
      ))=w.phone_key
      and lower(btrim(coalesce(nullif(o.status,''),o.data->>'status',''))) in (
        '','new','inbox','pending','scheduled','draft','pranim','dispatched','assigned','accepted'
      )
    order by coalesce(o.updated_at,o.created_at) desc nulls last,o.id
    limit 1
  )
  select coalesce(c.payload,'{}'::jsonb)
    || jsonb_build_object(
      'active_order',(select a.payload from active_order a),
      'checked_at',now()
    )
  from client_lookup c;
$$;

revoke all on function public.inspect_dispatch_transport_phone(text) from public,anon,authenticated;
grant execute on function public.inspect_dispatch_transport_phone(text) to service_role;

-- The API UUID remains the first idempotency key. This trigger adds the
-- business-level guard that was missing: separate UUIDs for one active
-- Dispatch phone cannot create simultaneous pre-pickup visits.
create or replace function public.guard_dispatch_active_phone_order_v1()
returns trigger
language plpgsql
security invoker
set search_path to 'public','pg_temp'
as $$
declare
  v_phone_key text;
  v_existing public.transport_orders%rowtype;
begin
  if upper(btrim(coalesce(new.data->>'created_by_role',''))) <> 'DISPATCH'
     or upper(btrim(coalesce(new.data->>'order_origin',''))) <> 'DISPATCH'
     or lower(btrim(coalesce(nullif(new.status,''),new.data->>'status',''))) not in (
       '','new','inbox','pending','scheduled','draft','pranim','dispatched','assigned','accepted'
     )
  then
    return new;
  end if;

  v_phone_key:=public.normalize_transport_phone_key(coalesce(
    new.client_phone,
    new.data->>'client_phone',
    new.data->'client'->>'phone',
    ''
  ));
  if length(v_phone_key)<8 then return new; end if;

  -- create_transport_order already owns this lock. Re-acquiring it is safe and
  -- also protects any future direct insert path that carries trusted metadata.
  perform pg_advisory_xact_lock(hashtextextended('transport-phone:'||v_phone_key,0));

  select * into v_existing
  from public.transport_orders o
  where o.id<>new.id
    and public.normalize_transport_phone_key(coalesce(
      o.client_phone,
      o.data->>'client_phone',
      o.data->'client'->>'phone',
      ''
    ))=v_phone_key
    and lower(btrim(coalesce(nullif(o.status,''),o.data->>'status',''))) in (
      '','new','inbox','pending','scheduled','draft','pranim','dispatched','assigned','accepted'
    )
  order by coalesce(o.updated_at,o.created_at) desc nulls last,o.id
  limit 1;

  if found then
    raise exception using
      errcode='23505',
      message='DISPATCH_ACTIVE_ORDER_EXISTS',
      detail=jsonb_build_object(
        'order_id',v_existing.id,
        'client_id',v_existing.client_id,
        'client_tcode',v_existing.client_tcode,
        'code_str',v_existing.code_str,
        'visit_nr',v_existing.visit_nr,
        'status',v_existing.status
      )::text,
      hint='OPEN_EXISTING_ORDER';
  end if;

  return new;
end;
$$;

drop trigger if exists transport_orders_dispatch_active_phone_guard_v1
  on public.transport_orders;
create trigger transport_orders_dispatch_active_phone_guard_v1
before insert on public.transport_orders
for each row execute function public.guard_dispatch_active_phone_order_v1();

revoke all on function public.guard_dispatch_active_phone_order_v1() from public,anon,authenticated;
grant execute on function public.guard_dispatch_active_phone_order_v1() to service_role;

comment on function public.inspect_dispatch_transport_phone(text) is
  'Approved-device Dispatch lookup for permanent client T-code and current active order.';
comment on function public.guard_dispatch_active_phone_order_v1() is
  'Serializes Dispatch creates by normalized phone and blocks concurrent active duplicate UUIDs.';

-- Forensic backup before repairing the T1233 timeout/retry incident.
create table if not exists public.backup_dispatch_t1233_duplicate_cleanup_20260902_v1
as select * from public.transport_orders with no data;
alter table public.backup_dispatch_t1233_duplicate_cleanup_20260902_v1 enable row level security;
revoke all on table public.backup_dispatch_t1233_duplicate_cleanup_20260902_v1 from public,anon,authenticated;

do $$
declare
  v_duplicate_ids uuid[]:=array[
    '1d987222-92ab-4121-ac49-f4d93b87e7f8'::uuid,
    '9889fb01-1a6b-4aed-9416-958b4a55b65f'::uuid
  ];
  v_client_id uuid:='f0c76b4b-2e2d-4af4-b689-e9cbacaad73f'::uuid;
  v_count integer;
  v_changed integer;
  v_dependencies integer;
  v_now timestamptz:=now();
begin
  select count(*) into v_count
  from public.transport_orders o
  where o.id='af25205f-d76e-4510-b71a-3dedbe4889b4'::uuid
    and o.client_id=v_client_id
    and o.client_tcode='T1233'
    and o.code_str='T1233'
    and o.visit_nr=1
    and lower(o.status)='assigned';
  if v_count<>1 then
    raise exception 'T1233_CANONICAL_VISIT_PRECONDITION_FAILED';
  end if;

  select count(*) into v_count
  from public.transport_orders o
  where o.id=any(v_duplicate_ids)
    and o.client_id=v_client_id
    and o.client_tcode='T1233'
    and o.code_str='T1233'
    and o.visit_nr in (2,3)
    and lower(o.status)='assigned';
  if v_count<>2 then
    raise exception 'T1233_DUPLICATE_VISIT_PRECONDITION_FAILED:%',v_count;
  end if;

  select
    (select count(*) from public.transport_receivables where transport_order_id=any(v_duplicate_ids))
    +(select count(*) from public.transport_payment_batches where current_transport_order_id=any(v_duplicate_ids))
    +(select count(*) from public.transport_delivery_events where transport_order_id=any(v_duplicate_ids))
    +(select count(*) from public.arka_pending_payments where transport_order_id=any(v_duplicate_ids))
    +(select count(*) from public.cash_handoff_items where transport_order_id=any(v_duplicate_ids))
    +(select count(*) from public.transport_order_measurement_audit where transport_order_id=any(v_duplicate_ids))
  into v_dependencies;
  if v_dependencies<>0 then
    raise exception 'T1233_DUPLICATE_HAS_DEPENDENCIES:%',v_dependencies;
  end if;

  if not exists (
    select 1 from public.backup_dispatch_t1233_duplicate_cleanup_20260902_v1
  ) then
    insert into public.backup_dispatch_t1233_duplicate_cleanup_20260902_v1
    select * from public.transport_orders where id=any(v_duplicate_ids);
  end if;

  select count(*) into v_count
  from public.backup_dispatch_t1233_duplicate_cleanup_20260902_v1
  where id=any(v_duplicate_ids);
  if v_count<>2 then
    raise exception 'T1233_BACKUP_VERIFY_FAILED:%',v_count;
  end if;

  update public.transport_orders o
  set status='cancelled',
      updated_at=v_now,
      data=coalesce(o.data,'{}'::jsonb)||jsonb_build_object(
        'status','cancelled',
        'cancelled',true,
        'canceled',true,
        'cancelled_at',v_now,
        'canceled_at',v_now,
        'cancellation_reason','DUPLIKATË NGA DISPATCH TIMEOUT/RETRY — MBAHET VIZITA 1',
        'cancel_reason','DUPLIKATË NGA DISPATCH TIMEOUT/RETRY — MBAHET VIZITA 1',
        'cancelled_by','SYSTEM_RECOVERY',
        'cancellation_source','DISPATCH_DUPLICATE_RECOVERY',
        'dispatch_removed',true,
        'dispatch_hidden',true,
        'dispatch_removed_at',v_now,
        'dispatch_removed_by','SYSTEM_RECOVERY',
        'dispatch_removed_reason','DUPLIKATË NGA DISPATCH TIMEOUT/RETRY — MBAHET VIZITA 1'
      )
  where o.id=any(v_duplicate_ids)
    and lower(o.status)='assigned';
  get diagnostics v_changed=row_count;
  if v_changed<>2 then
    raise exception 'T1233_DUPLICATE_UPDATE_FAILED:%',v_changed;
  end if;

  select count(*) into v_count
  from public.transport_orders o
  where o.client_id=v_client_id
    and lower(btrim(coalesce(nullif(o.status,''),o.data->>'status',''))) in (
      '','new','inbox','pending','scheduled','draft','pranim','dispatched','assigned','accepted'
    );
  if v_count<>1 then
    raise exception 'T1233_ACTIVE_VISIT_VERIFY_FAILED:%',v_count;
  end if;

  if not exists (
    select 1 from public.transport_clients c
    where c.id=v_client_id and c.tcode='T1233'
  ) or not exists (
    select 1 from public.transport_code_pool p
    where p.code='T1233' and p.status='used'
  ) then
    raise exception 'T1233_PERMANENT_CODE_VERIFY_FAILED';
  end if;
end;
$$;

notify pgrst,'reload schema';

commit;
