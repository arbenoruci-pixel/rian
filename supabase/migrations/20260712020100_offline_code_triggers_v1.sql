begin;

create or replace function public.offline_base_code_lease_before_write()
returns trigger
language plpgsql
security definer
set search_path to 'public','pg_temp'
as $$
declare
  v_code text := nullif(btrim(coalesce(new.code::text,'')),'');
  v_data jsonb := coalesce(new.data,'{}'::jsonb);
  v_life jsonb := coalesce(v_data->'pranimi_code_lifecycle','{}'::jsonb);
  v_draft text := coalesce(
    nullif(btrim(coalesce(new.local_oid,'')),''),
    nullif(btrim(v_data->>'local_oid'),''),
    nullif(btrim(v_life->>'local_oid'),''),
    nullif(btrim(v_life->>'draft_id'),'')
  );
  v_payload_pin text := coalesce(
    nullif(btrim(v_life->>'pin'),''),
    nullif(btrim(v_life->>'code_lifecycle_pin'),''),
    nullif(btrim(v_life->>'created_by_pin'),''),
    nullif(btrim(v_data->>'created_by_pin'),''),
    nullif(btrim(v_data->>'worker_pin'),'')
  );
  v_lease public.offline_code_leases%rowtype;
  v_placeholder text := '';
begin
  if v_code is null or v_draft is null then return new; end if;

  select l.* into v_lease
  from public.offline_code_leases l
  where l.scope='base'
    and l.code=v_code
    and (
      l.status in ('available','assigned')
      or (l.status='consumed' and l.draft_session_id=v_draft)
    )
  order by case when l.draft_session_id=v_draft then 0 else 1 end,l.reserved_at desc
  limit 1
  for update;

  if not found then return new; end if;
  if v_lease.status='consumed' then return new; end if;
  if v_lease.expires_at<=now() then
    raise exception using errcode='P0001',message='OFFLINE_BASE_CODE_LEASE_EXPIRED';
  end if;
  if v_payload_pin is null or v_payload_pin<>v_lease.owner_id then
    raise exception using errcode='P0001',message='OFFLINE_BASE_CODE_LEASE_OWNER_MISMATCH';
  end if;
  if v_lease.status='assigned' and coalesce(v_lease.draft_session_id,'')<>v_draft then
    raise exception using errcode='P0001',message='OFFLINE_BASE_CODE_LEASE_DRAFT_CONFLICT';
  end if;

  v_placeholder := coalesce(v_lease.metadata->>'pool_placeholder','');
  update public.base_code_pool b
  set draft_session_id=v_draft,
      draft_has_meaningful_work=true,
      lease_expires_at=greatest(coalesce(b.lease_expires_at,v_lease.expires_at),v_lease.expires_at),
      reserved_at=coalesce(b.reserved_at,now()),
      owner_id=v_lease.owner_id,
      reserved_by=v_lease.owner_id
  where b.code::text=v_code
    and b.status='reserved'
    and b.reserved_by=v_lease.owner_id
    and (
      coalesce(b.draft_session_id,'')=v_draft
      or coalesce(b.draft_session_id,'')=v_placeholder
    );

  if not found then
    raise exception using errcode='P0001',message='OFFLINE_BASE_CODE_POOL_LEASE_IDENTITY_MISMATCH';
  end if;

  update public.offline_code_leases l
  set status='assigned',
      draft_session_id=v_draft,
      assigned_at=coalesce(l.assigned_at,now()),
      updated_at=now()
  where l.lease_token=v_lease.lease_token;

  -- The lease token may arrive in an older outbox payload. It is removed before
  -- the customer order is stored; only non-secret diagnostics remain.
  v_data := v_data - 'offline_code_lease';
  v_life := v_life - 'offline_code_lease' - 'offline_code_lease_token';
  v_life := v_life || jsonb_build_object(
    'offline_code_bank',true,
    'offline_code_scope','base',
    'offline_code_owner_id',v_lease.owner_id,
    'offline_code_device_id',v_lease.device_id,
    'offline_code_bound_at',now(),
    'local_oid',v_draft,
    'pin',v_lease.owner_id,
    'online',false
  );
  new.data := v_data || jsonb_build_object('pranimi_code_lifecycle',v_life);
  return new;
end;
$$;

create or replace function public.offline_base_code_lease_after_write()
returns trigger
language plpgsql
security definer
set search_path to 'public','pg_temp'
as $$
declare
  v_code text := nullif(btrim(coalesce(new.code::text,'')),'');
  v_data jsonb := coalesce(new.data,'{}'::jsonb);
  v_life jsonb := coalesce(v_data->'pranimi_code_lifecycle','{}'::jsonb);
  v_draft text := coalesce(
    nullif(btrim(coalesce(new.local_oid,'')),''),
    nullif(btrim(v_data->>'local_oid'),''),
    nullif(btrim(v_life->>'local_oid'),''),
    nullif(btrim(v_life->>'draft_id'),'')
  );
  v_lease public.offline_code_leases%rowtype;
  v_result jsonb;
begin
  if v_code is null or v_draft is null then return new; end if;

  select l.* into v_lease
  from public.offline_code_leases l
  where l.scope='base'
    and l.code=v_code
    and l.draft_session_id=v_draft
    and l.status in ('assigned','consumed')
  order by l.reserved_at desc
  limit 1
  for update;

  if not found or v_lease.status='consumed' then return new; end if;

  v_result := public.mark_base_code_used_after_verify(
    v_code::bigint,
    v_lease.owner_id,
    v_draft,
    new.id::text,
    new.client_phone
  );

  if coalesce((v_result->>'ok')::boolean,false) is not true then
    raise exception using errcode='P0001',
      message='OFFLINE_BASE_CODE_FINALIZE_FAILED:'||coalesce(v_result->>'reason','UNKNOWN');
  end if;

  update public.offline_code_leases l
  set status='consumed',
      consumed_at=coalesce(l.consumed_at,now()),
      order_id=new.id::text,
      updated_at=now(),
      metadata=l.metadata||jsonb_build_object('finalized_by','orders_trigger','final_code',v_code)
  where l.lease_token=v_lease.lease_token;

  return new;
end;
$$;

create or replace function public.offline_transport_code_lease_before_write()
returns trigger
language plpgsql
security definer
set search_path to 'public','pg_temp'
as $$
declare
  v_data jsonb := coalesce(new.data,'{}'::jsonb);
  v_draft text := coalesce(
    nullif(btrim(v_data->>'local_oid'),''),
    nullif(btrim(v_data->>'order_id'),''),
    nullif(btrim(v_data->>'public_order_id'),''),
    new.id::text
  );
  v_code_str text := upper(btrim(coalesce(new.code_str,'')));
  v_client_tcode text := upper(btrim(coalesce(new.client_tcode,'')));
  v_transport_id text := nullif(btrim(v_data->>'transport_id'),'');
  v_transport_pin text := nullif(btrim(v_data->>'transport_pin'),'');
  v_driver_pin text := nullif(btrim(v_data->>'driver_pin'),'');
  v_created_pin text := nullif(btrim(v_data->>'created_by_pin'),'');
  v_lease public.offline_code_leases%rowtype;
begin
  if v_draft is null then return new; end if;

  select l.* into v_lease
  from public.offline_code_leases l
  where l.scope='transport'
    and (
      upper(l.code)=v_code_str
      or upper(l.code)=v_client_tcode
      or l.draft_session_id=v_draft
    )
    and (
      l.status in ('available','assigned')
      or (l.status in ('consumed','released') and l.draft_session_id=v_draft)
    )
  order by case when l.draft_session_id=v_draft then 0 else 1 end,l.reserved_at desc
  limit 1
  for update;

  if not found then return new; end if;
  if v_lease.status in ('consumed','released') then return new; end if;
  if v_lease.expires_at<=now() then
    raise exception using errcode='P0001',message='OFFLINE_TRANSPORT_CODE_LEASE_EXPIRED';
  end if;
  if not (
    v_lease.owner_id=coalesce(v_transport_id,'')
    or v_lease.owner_id=coalesce(v_transport_pin,'')
    or v_lease.owner_id=coalesce(v_driver_pin,'')
    or v_lease.owner_id=coalesce(v_created_pin,'')
  ) then
    raise exception using errcode='P0001',message='OFFLINE_TRANSPORT_CODE_LEASE_OWNER_MISMATCH';
  end if;
  if v_lease.status='assigned' and coalesce(v_lease.draft_session_id,'')<>v_draft then
    raise exception using errcode='P0001',message='OFFLINE_TRANSPORT_CODE_LEASE_DRAFT_CONFLICT';
  end if;

  if not exists(
    select 1 from public.transport_code_pool p
    where upper(p.code)=upper(v_lease.code)
      and p.status='used'
      and p.owner_id=v_lease.owner_id
  ) then
    raise exception using errcode='P0001',message='OFFLINE_TRANSPORT_CODE_POOL_LEASE_IDENTITY_MISMATCH';
  end if;

  update public.offline_code_leases l
  set status='assigned',
      draft_session_id=v_draft,
      assigned_at=coalesce(l.assigned_at,now()),
      updated_at=now()
  where l.lease_token=v_lease.lease_token;

  v_data := v_data - 'offline_code_lease';
  v_data := v_data || jsonb_build_object(
    'offline_code_bank',true,
    'offline_code_scope','transport',
    'offline_code_owner_id',v_lease.owner_id,
    'offline_code_device_id',v_lease.device_id,
    'offline_code_bound_at',now()
  );
  new.data := v_data;
  return new;
end;
$$;

create or replace function public.offline_transport_code_lease_after_write()
returns trigger
language plpgsql
security definer
set search_path to 'public','pg_temp'
as $$
declare
  v_data jsonb := coalesce(new.data,'{}'::jsonb);
  v_draft text := coalesce(
    nullif(btrim(v_data->>'local_oid'),''),
    nullif(btrim(v_data->>'order_id'),''),
    nullif(btrim(v_data->>'public_order_id'),''),
    new.id::text
  );
  v_code_str text := upper(btrim(coalesce(new.code_str,'')));
  v_client_tcode text := upper(btrim(coalesce(new.client_tcode,'')));
  v_lease public.offline_code_leases%rowtype;
  v_released boolean := false;
begin
  if v_draft is null then return new; end if;

  select l.* into v_lease
  from public.offline_code_leases l
  where l.scope='transport'
    and l.draft_session_id=v_draft
    and l.status in ('assigned','consumed','released')
  order by l.reserved_at desc
  limit 1
  for update;

  if not found or v_lease.status in ('consumed','released') then return new; end if;

  if v_client_tcode=upper(v_lease.code) then
    update public.offline_code_leases l
    set status='consumed',
        consumed_at=coalesce(l.consumed_at,now()),
        order_id=new.id::text,
        updated_at=now(),
        metadata=l.metadata||jsonb_build_object(
          'finalized_by','transport_orders_trigger',
          'final_code',v_client_tcode
        )
    where l.lease_token=v_lease.lease_token;
    return new;
  end if;

  -- Existing-client canonicalization can temporarily insert the reserved code as
  -- code_str while client_tcode already holds the historic permanent T-code. Wait
  -- for the reconciliation UPDATE, then release the now-unreferenced temp code.
  if v_code_str<>upper(v_lease.code) and v_client_tcode<>upper(v_lease.code) then
    v_released := public.release_transport_code_if_unused(v_lease.code,v_lease.owner_id);
    if not v_released then
      raise exception using errcode='P0001',message='OFFLINE_TRANSPORT_SUPERSEDED_CODE_RELEASE_FAILED';
    end if;

    update public.offline_code_leases l
    set status='released',
        released_at=coalesce(l.released_at,now()),
        order_id=new.id::text,
        updated_at=now(),
        metadata=l.metadata||jsonb_build_object(
          'finalized_by','transport_orders_trigger',
          'final_code',v_client_tcode,
          'superseded_code',v_lease.code,
          'release_reason','existing_client_code_won'
        )
    where l.lease_token=v_lease.lease_token;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_00_offline_base_code_lease_before on public.orders;
create trigger trg_00_offline_base_code_lease_before
before insert or update of code,local_oid,data on public.orders
for each row execute function public.offline_base_code_lease_before_write();

drop trigger if exists trg_zz_offline_base_code_lease_after on public.orders;
create trigger trg_zz_offline_base_code_lease_after
after insert or update of code,local_oid,data on public.orders
for each row execute function public.offline_base_code_lease_after_write();

drop trigger if exists trg_00_offline_transport_code_lease_before on public.transport_orders;
create trigger trg_00_offline_transport_code_lease_before
before insert or update of code_str,client_tcode,data on public.transport_orders
for each row execute function public.offline_transport_code_lease_before_write();

drop trigger if exists trg_zz_offline_transport_code_lease_after on public.transport_orders;
create trigger trg_zz_offline_transport_code_lease_after
after insert or update of code_str,client_tcode,data on public.transport_orders
for each row execute function public.offline_transport_code_lease_after_write();

revoke all on function public.offline_base_code_lease_before_write() from public;
revoke all on function public.offline_base_code_lease_after_write() from public;
revoke all on function public.offline_transport_code_lease_before_write() from public;
revoke all on function public.offline_transport_code_lease_after_write() from public;

commit;
