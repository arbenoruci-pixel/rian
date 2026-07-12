begin;

-- Corrective hardening: the first offline-bank migration scoped the allocation
-- count to owner + device. The business rule is ten exclusive codes per user.
-- These owner-level advisory locks and counts prevent a second device ID from
-- reserving another batch for the same PIN.

create or replace function public.reserve_base_offline_codes(
  p_pin text,
  p_device_id text,
  p_target integer default 10,
  p_lease_hours integer default 720
)
returns table(
  code bigint,
  lease_token uuid,
  lease_expires_at timestamptz,
  lease_status text,
  draft_session_id text,
  owner_id text,
  device_id text
)
language plpgsql
security definer
set search_path to 'public','pg_temp'
as $$
declare
  clean_pin text := btrim(coalesce(p_pin,''));
  clean_device text := btrim(coalesce(p_device_id,''));
  wanted integer := least(greatest(coalesce(p_target,10),1),10);
  lease_hours integer := least(greatest(coalesce(p_lease_hours,720),24),2160);
  active_count integer := 0;
  need_count integer := 0;
  r record;
  token uuid;
  placeholder text;
  new_expiry timestamptz := now() + make_interval(hours => lease_hours);
begin
  if not public._tepiha_pin_is_valid(clean_pin) then
    raise exception using errcode='P0001', message='OFFLINE_BANK_PIN_INVALID';
  end if;
  if not public._tepiha_offline_device_is_valid(clean_device) then
    raise exception using errcode='P0001', message='OFFLINE_BANK_DEVICE_INVALID';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('offline-bank:base:'||clean_pin,0));

  for r in
    select l.*
    from public.offline_code_leases l
    where l.scope='base'
      and l.status in ('available','assigned')
      and l.expires_at<=now()
    for update
  loop
    if exists(select 1 from public.orders o where o.code::text=r.code)
       or exists(select 1 from public.clients c where c.code::text=r.code)
    then
      update public.offline_code_leases as l
      set status='consumed',
          consumed_at=coalesce(l.consumed_at,now()),
          updated_at=now(),
          metadata=l.metadata||jsonb_build_object('expiry_reconciled','referenced_code')
      where l.lease_token=r.lease_token;
    else
      update public.base_code_pool b
      set status='available',
          owner_id='',
          reserved_by=null,
          reserved_at=null,
          lease_expires_at=null,
          draft_session_id=null,
          draft_has_meaningful_work=false
      where b.code::text=r.code
        and b.status='reserved'
        and b.reserved_by=r.owner_id;

      update public.offline_code_leases as l
      set status='expired',
          released_at=now(),
          updated_at=now(),
          metadata=l.metadata||jsonb_build_object('expired_reason','lease_timeout')
      where l.lease_token=r.lease_token;
    end if;
  end loop;

  update public.offline_code_leases as l
  set expires_at=new_expiry,updated_at=now()
  where l.scope='base'
    and l.owner_id=clean_pin
    and l.device_id=clean_device
    and l.status in ('available','assigned')
    and l.expires_at>now();

  update public.base_code_pool b
  set lease_expires_at=new_expiry
  where b.status='reserved'
    and b.reserved_by=clean_pin
    and exists (
      select 1 from public.offline_code_leases l
      where l.scope='base'
        and l.code=b.code::text
        and l.owner_id=clean_pin
        and l.device_id=clean_device
        and l.status in ('available','assigned')
        and l.expires_at>now()
    );

  select count(*) into active_count
  from public.offline_code_leases l
  where l.scope='base'
    and l.owner_id=clean_pin
    and l.status in ('available','assigned')
    and l.expires_at>now();

  need_count := greatest(wanted-active_count,0);

  for r in
    select b.code
    from public.base_code_pool b
    where b.status='available'
      and b.code ~ '^[0-9]+$'
      and b.code::bigint>0
      and not exists(select 1 from public.orders o where o.code::text=b.code::text)
      and not exists(select 1 from public.clients c where c.code::text=b.code::text)
    order by b.code::bigint
    limit need_count
    for update skip locked
  loop
    token := gen_random_uuid();
    placeholder := 'offline_bank:'||substr(md5(clean_device||':'||token::text),1,20)||':'||r.code::text;

    update public.base_code_pool b
    set status='reserved',
        owner_id=clean_pin,
        reserved_by=clean_pin,
        reserved_at=now(),
        lease_expires_at=new_expiry,
        draft_session_id=placeholder,
        draft_has_meaningful_work=false
    where b.code::text=r.code::text
      and b.status='available';

    if found then
      insert into public.offline_code_leases(
        lease_token,scope,code,owner_id,device_id,status,reserved_at,expires_at,metadata
      ) values (
        token,'base',r.code::text,clean_pin,clean_device,'available',now(),new_expiry,
        jsonb_build_object('pool_placeholder',placeholder,'allocator_version','offline-bank-v1')
      );
    end if;
  end loop;

  return query
  select l.code::bigint,l.lease_token,l.expires_at,l.status,
         l.draft_session_id,l.owner_id,l.device_id
  from public.offline_code_leases l
  where l.scope='base'
    and l.owner_id=clean_pin
    and l.device_id=clean_device
    and l.status in ('available','assigned')
    and l.expires_at>now()
  order by l.code::bigint;
end;
$$;

create or replace function public.reserve_transport_offline_codes(
  p_owner_id text,
  p_device_id text,
  p_target integer default 10,
  p_lease_hours integer default 720
)
returns table(
  code text,
  lease_token uuid,
  lease_expires_at timestamptz,
  lease_status text,
  draft_session_id text,
  owner_id text,
  device_id text
)
language plpgsql
security definer
set search_path to 'public','pg_temp'
as $$
declare
  clean_owner text := btrim(coalesce(p_owner_id,''));
  clean_device text := btrim(coalesce(p_device_id,''));
  wanted integer := least(greatest(coalesce(p_target,10),1),10);
  lease_hours integer := least(greatest(coalesce(p_lease_hours,720),24),2160);
  active_count integer := 0;
  need_count integer := 0;
  r record;
  token uuid;
  new_expiry timestamptz := now() + make_interval(hours => lease_hours);
begin
  if not public._tepiha_offline_owner_is_valid(clean_owner) then
    raise exception using errcode='P0001', message='OFFLINE_BANK_OWNER_INVALID';
  end if;
  if not public._tepiha_offline_device_is_valid(clean_device) then
    raise exception using errcode='P0001', message='OFFLINE_BANK_DEVICE_INVALID';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('offline-bank:transport:'||clean_owner,0));

  for r in
    select l.*
    from public.offline_code_leases l
    where l.scope='transport'
      and l.status in ('available','assigned')
      and l.expires_at<=now()
    for update
  loop
    if exists(select 1 from public.transport_clients c where upper(c.tcode)=upper(r.code))
       or exists(
         select 1 from public.transport_orders o
         where upper(o.code_str)=upper(r.code)
            or upper(coalesce(o.client_tcode,''))=upper(r.code)
            or upper(coalesce(o.data->>'legacy_order_code',''))=upper(r.code)
            or upper(coalesce(o.data->>'legacy_client_tcode',''))=upper(r.code)
       )
       or exists(
         select 1 from public.arka_pending_payments ap
         where (ap.type='TRANSPORT' or ap.source_module='TRANSPORT')
           and upper(coalesce(ap.transport_code_str,''))=upper(r.code)
       )
    then
      update public.offline_code_leases as l
      set status='consumed',
          consumed_at=coalesce(l.consumed_at,now()),
          updated_at=now(),
          metadata=l.metadata||jsonb_build_object('expiry_reconciled','referenced_code')
      where l.lease_token=r.lease_token;
    else
      update public.transport_code_pool p
      set status='available',owner_id='POOL'
      where upper(p.code)=upper(r.code)
        and p.status='used'
        and p.owner_id=r.owner_id;

      update public.offline_code_leases as l
      set status='expired',released_at=now(),updated_at=now(),
          metadata=l.metadata||jsonb_build_object('expired_reason','lease_timeout')
      where l.lease_token=r.lease_token;
    end if;
  end loop;

  update public.offline_code_leases as l
  set expires_at=new_expiry,updated_at=now()
  where l.scope='transport'
    and l.owner_id=clean_owner
    and l.device_id=clean_device
    and l.status in ('available','assigned')
    and l.expires_at>now();

  select count(*) into active_count
  from public.offline_code_leases l
  where l.scope='transport'
    and l.owner_id=clean_owner
    and l.status in ('available','assigned')
    and l.expires_at>now();

  need_count := greatest(wanted-active_count,0);

  for r in
    select p.code
    from public.transport_code_pool p
    where p.status='available'
      and p.code ~ '^T[0-9]+$'
      and not exists(select 1 from public.transport_clients c where upper(c.tcode)=upper(p.code))
      and not exists(
        select 1 from public.transport_orders o
        where upper(o.code_str)=upper(p.code)
           or upper(coalesce(o.client_tcode,''))=upper(p.code)
           or upper(coalesce(o.data->>'legacy_order_code',''))=upper(p.code)
           or upper(coalesce(o.data->>'legacy_client_tcode',''))=upper(p.code)
      )
      and not exists(
        select 1 from public.arka_pending_payments ap
        where (ap.type='TRANSPORT' or ap.source_module='TRANSPORT')
          and upper(coalesce(ap.transport_code_str,''))=upper(p.code)
      )
    order by regexp_replace(p.code,'\D','','g')::bigint
    limit need_count
    for update skip locked
  loop
    token := gen_random_uuid();

    update public.transport_code_pool p
    set status='used',owner_id=clean_owner
    where upper(p.code)=upper(r.code)
      and p.status='available';

    if found then
      insert into public.offline_code_leases(
        lease_token,scope,code,owner_id,device_id,status,reserved_at,expires_at,metadata
      ) values (
        token,'transport',upper(r.code),clean_owner,clean_device,'available',now(),new_expiry,
        jsonb_build_object('allocator_version','offline-bank-v1')
      );
    end if;
  end loop;

  return query
  select upper(l.code),l.lease_token,l.expires_at,l.status,
         l.draft_session_id,l.owner_id,l.device_id
  from public.offline_code_leases l
  where l.scope='transport'
    and l.owner_id=clean_owner
    and l.device_id=clean_device
    and l.status in ('available','assigned')
    and l.expires_at>now()
  order by regexp_replace(l.code,'\D','','g')::bigint;
end;
$$;

commit;
