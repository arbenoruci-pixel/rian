begin;

create table if not exists public.offline_code_leases (
  lease_token uuid primary key default gen_random_uuid(),
  scope text not null check (scope in ('base','transport')),
  code text not null,
  owner_id text not null,
  device_id text not null,
  draft_session_id text,
  status text not null default 'available' check (status in ('available','assigned','consumed','released','expired')),
  reserved_at timestamptz not null default now(),
  expires_at timestamptz not null,
  assigned_at timestamptz,
  consumed_at timestamptz,
  released_at timestamptz,
  order_id text,
  metadata jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.offline_code_leases enable row level security;
revoke all on table public.offline_code_leases from public, anon, authenticated;

create unique index if not exists offline_code_leases_active_code_uidx
  on public.offline_code_leases(scope, code)
  where status in ('available','assigned');

create index if not exists offline_code_leases_owner_device_idx
  on public.offline_code_leases(scope, owner_id, device_id, status, expires_at);

create index if not exists offline_code_leases_draft_idx
  on public.offline_code_leases(scope, draft_session_id)
  where draft_session_id is not null;

create or replace function public._tepiha_offline_device_is_valid(p_device_id text)
returns boolean
language sql
immutable
as $$
  select btrim(coalesce(p_device_id,'')) ~ '^[A-Za-z0-9._:-]{8,160}$'
$$;

create or replace function public._tepiha_offline_owner_is_valid(p_owner_id text)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  clean text := btrim(coalesce(p_owner_id,''));
  trailing_pin text := '';
begin
  if clean = '' or length(clean) > 160 then return false; end if;
  if public._tepiha_pin_is_valid(clean) then return true; end if;

  if clean ~ '^MAIN_[A-Za-z0-9_:-]+_[0-9]{3,12}$' then
    trailing_pin := regexp_replace(clean, '^.*_([0-9]{3,12})$', '\1');
    if public._tepiha_pin_is_valid(trailing_pin) then return true; end if;
  end if;

  if to_regclass('public.users') is not null and exists (
    select 1 from public.users u
    where coalesce(u.is_active,true)
      and (
        u.id::text = clean
        or coalesce(u.transport_id::text,'') = clean
        or coalesce(u.tid::text,'') = clean
        or btrim(coalesce(u.pin::text,'')) = clean
      )
  ) then return true; end if;

  if to_regclass('public.tepiha_users') is not null and exists (
    select 1 from public.tepiha_users u
    where coalesce(u.is_active,true)
      and (
        u.id::text = clean
        or coalesce(u.transport_id::text,'') = clean
        or coalesce(u.tid::text,'') = clean
        or btrim(coalesce(u.pin::text,'')) = clean
      )
  ) then return true; end if;

  return false;
end;
$$;

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

  perform pg_advisory_xact_lock(hashtextextended('offline-bank:base:'||clean_pin||':'||clean_device,0));

  for r in
    select l.*
    from public.offline_code_leases l
    where l.scope='base'
      and l.status in ('available','assigned')
      and l.expires_at <= now()
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
    and l.device_id=clean_device
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

create or replace function public.bind_base_offline_code_to_draft(
  p_pin text,
  p_device_id text,
  p_code bigint,
  p_lease_token uuid,
  p_draft_session_id text
)
returns jsonb
language plpgsql
security definer
set search_path to 'public','pg_temp'
as $$
declare
  clean_pin text := btrim(coalesce(p_pin,''));
  clean_device text := btrim(coalesce(p_device_id,''));
  sid text := nullif(btrim(coalesce(p_draft_session_id,'')),'');
  l public.offline_code_leases%rowtype;
  placeholder text;
begin
  if not public._tepiha_pin_is_valid(clean_pin) then return jsonb_build_object('ok',false,'reason','PIN_INVALID'); end if;
  if not public._tepiha_offline_device_is_valid(clean_device) then return jsonb_build_object('ok',false,'reason','DEVICE_INVALID'); end if;
  if p_code is null or p_code<1 or p_lease_token is null or sid is null then
    return jsonb_build_object('ok',false,'reason','BIND_KEYS_MISSING');
  end if;

  perform pg_advisory_xact_lock(hashtextextended('offline-bank:base-code:'||p_code::text,0));

  select * into l
  from public.offline_code_leases
  where lease_token=p_lease_token
    and scope='base'
    and code=p_code::text
    and owner_id=clean_pin
    and device_id=clean_device
  for update;

  if not found then return jsonb_build_object('ok',false,'reason','LEASE_NOT_FOUND'); end if;
  if l.status='consumed' and l.draft_session_id=sid then
    return jsonb_build_object('ok',true,'already',true,'status',l.status,'code',p_code,'draft_session_id',sid);
  end if;
  if l.status not in ('available','assigned') then return jsonb_build_object('ok',false,'reason','LEASE_NOT_ACTIVE','status',l.status); end if;
  if l.expires_at<=now() then return jsonb_build_object('ok',false,'reason','LEASE_EXPIRED'); end if;
  if l.status='assigned' and coalesce(l.draft_session_id,'')<>sid then
    return jsonb_build_object('ok',false,'reason','LEASE_ASSIGNED_TO_OTHER_DRAFT','draft_session_id',l.draft_session_id);
  end if;

  placeholder := coalesce(l.metadata->>'pool_placeholder','');
  update public.base_code_pool b
  set draft_session_id=sid,
      draft_has_meaningful_work=true,
      lease_expires_at=greatest(coalesce(b.lease_expires_at,l.expires_at),l.expires_at),
      reserved_at=coalesce(b.reserved_at,now())
  where b.code::text=p_code::text
    and b.status='reserved'
    and b.reserved_by=clean_pin
    and (coalesce(b.draft_session_id,'')=sid or coalesce(b.draft_session_id,'')=placeholder);

  if not found then return jsonb_build_object('ok',false,'reason','POOL_LEASE_IDENTITY_MISMATCH'); end if;

  update public.offline_code_leases
  set status='assigned',
      draft_session_id=sid,
      assigned_at=coalesce(assigned_at,now()),
      updated_at=now()
  where lease_token=p_lease_token;

  return jsonb_build_object(
    'ok',true,'code',p_code,'lease_token',p_lease_token,
    'draft_session_id',sid,'lease_expires_at',l.expires_at,'source','OFFLINE_BANK'
  );
end;
$$;

create or replace function public.finalize_base_offline_code(
  p_pin text,
  p_device_id text,
  p_code bigint,
  p_lease_token uuid,
  p_draft_session_id text,
  p_order_id text,
  p_client_phone text default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public','pg_temp'
as $$
declare
  clean_pin text := btrim(coalesce(p_pin,''));
  clean_device text := btrim(coalesce(p_device_id,''));
  sid text := nullif(btrim(coalesce(p_draft_session_id,'')),'');
  exact_order text := nullif(btrim(coalesce(p_order_id,'')),'');
  l public.offline_code_leases%rowtype;
  actual_code text := '';
  mark_result jsonb;
  bind_result jsonb;
begin
  if not public._tepiha_pin_is_valid(clean_pin) then return jsonb_build_object('ok',false,'reason','PIN_INVALID'); end if;
  if not public._tepiha_offline_device_is_valid(clean_device) then return jsonb_build_object('ok',false,'reason','DEVICE_INVALID'); end if;
  if p_code is null or p_lease_token is null or sid is null or exact_order is null then
    return jsonb_build_object('ok',false,'reason','FINALIZE_KEYS_MISSING');
  end if;

  perform pg_advisory_xact_lock(hashtextextended('offline-bank:base-code:'||p_code::text,0));

  select * into l
  from public.offline_code_leases
  where lease_token=p_lease_token
    and scope='base'
    and code=p_code::text
    and owner_id=clean_pin
    and device_id=clean_device
  for update;

  if not found then return jsonb_build_object('ok',false,'reason','LEASE_NOT_FOUND'); end if;
  if l.status='consumed' and l.order_id=exact_order then
    return jsonb_build_object('ok',true,'already',true,'code',p_code,'order_id',exact_order);
  end if;

  select o.code::text into actual_code
  from public.orders o
  where o.id::text=exact_order
    and coalesce(
      nullif(btrim(to_jsonb(o)->>'local_oid'),''),
      nullif(btrim(to_jsonb(o)->'data'->>'local_oid'),''),
      nullif(btrim(to_jsonb(o)->'data'->'pranimi_code_lifecycle'->>'local_oid'),'')
    )=sid
  limit 1;

  if actual_code='' then return jsonb_build_object('ok',false,'reason','EXACT_FINAL_ORDER_NOT_FOUND'); end if;

  if actual_code<>p_code::text then
    if not exists(select 1 from public.orders o where o.code::text=p_code::text)
       and not exists(select 1 from public.clients c where c.code::text=p_code::text)
    then
      update public.base_code_pool b
      set status='available',owner_id='',reserved_by=null,reserved_at=null,
          lease_expires_at=null,draft_session_id=null,draft_has_meaningful_work=false
      where b.code::text=p_code::text
        and b.status='reserved'
        and b.reserved_by=clean_pin;
    end if;

    update public.offline_code_leases
    set status='released',released_at=now(),order_id=exact_order,updated_at=now(),
        metadata=metadata||jsonb_build_object('superseded_by_code',actual_code,'release_reason','existing_client_code_won')
    where lease_token=p_lease_token;

    return jsonb_build_object('ok',true,'released',true,'reason','EXISTING_CLIENT_CODE_WON','code',p_code,'final_code',actual_code,'order_id',exact_order);
  end if;

  if l.status='available' or coalesce(l.draft_session_id,'')<>sid then
    bind_result := public.bind_base_offline_code_to_draft(clean_pin,clean_device,p_code,p_lease_token,sid);
    if coalesce((bind_result->>'ok')::boolean,false) is not true then return bind_result; end if;
  end if;

  mark_result := public.mark_base_code_used_after_verify(p_code,clean_pin,sid,exact_order,p_client_phone);
  if coalesce((mark_result->>'ok')::boolean,false) is not true then
    return mark_result||jsonb_build_object('offline_lease',true,'lease_token',p_lease_token);
  end if;

  update public.offline_code_leases
  set status='consumed',consumed_at=coalesce(consumed_at,now()),order_id=exact_order,updated_at=now(),
      metadata=metadata||jsonb_build_object('final_code',actual_code)
  where lease_token=p_lease_token;

  return mark_result||jsonb_build_object('offline_lease',true,'lease_token',p_lease_token,'consumed',true);
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

  perform pg_advisory_xact_lock(hashtextextended('offline-bank:transport:'||clean_owner||':'||clean_device,0));

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
    and l.device_id=clean_device
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

create or replace function public.bind_transport_offline_code_to_order(
  p_owner_id text,
  p_device_id text,
  p_code text,
  p_lease_token uuid,
  p_draft_session_id text
)
returns jsonb
language plpgsql
security definer
set search_path to 'public','pg_temp'
as $$
declare
  clean_owner text := btrim(coalesce(p_owner_id,''));
  clean_device text := btrim(coalesce(p_device_id,''));
  clean_code text := upper(btrim(coalesce(p_code,'')));
  sid text := nullif(btrim(coalesce(p_draft_session_id,'')),'');
  l public.offline_code_leases%rowtype;
begin
  if not public._tepiha_offline_owner_is_valid(clean_owner) then return jsonb_build_object('ok',false,'reason','OWNER_INVALID'); end if;
  if not public._tepiha_offline_device_is_valid(clean_device) then return jsonb_build_object('ok',false,'reason','DEVICE_INVALID'); end if;
  if clean_code !~ '^T[0-9]+$' or p_lease_token is null or sid is null then
    return jsonb_build_object('ok',false,'reason','BIND_KEYS_MISSING');
  end if;

  perform pg_advisory_xact_lock(hashtextextended('offline-bank:transport-code:'||clean_code,0));

  select * into l
  from public.offline_code_leases
  where lease_token=p_lease_token
    and scope='transport'
    and upper(code)=clean_code
    and owner_id=clean_owner
    and device_id=clean_device
  for update;

  if not found then return jsonb_build_object('ok',false,'reason','LEASE_NOT_FOUND'); end if;
  if l.status='consumed' and l.draft_session_id=sid then return jsonb_build_object('ok',true,'already',true,'code',clean_code); end if;
  if l.status not in ('available','assigned') then return jsonb_build_object('ok',false,'reason','LEASE_NOT_ACTIVE','status',l.status); end if;
  if l.expires_at<=now() then return jsonb_build_object('ok',false,'reason','LEASE_EXPIRED'); end if;
  if l.status='assigned' and coalesce(l.draft_session_id,'')<>sid then
    return jsonb_build_object('ok',false,'reason','LEASE_ASSIGNED_TO_OTHER_DRAFT','draft_session_id',l.draft_session_id);
  end if;

  if not exists(
    select 1 from public.transport_code_pool p
    where upper(p.code)=clean_code and p.status='used' and p.owner_id=clean_owner
  ) then
    return jsonb_build_object('ok',false,'reason','POOL_LEASE_IDENTITY_MISMATCH');
  end if;

  update public.offline_code_leases
  set status='assigned',draft_session_id=sid,
      assigned_at=coalesce(assigned_at,now()),updated_at=now()
  where lease_token=p_lease_token;

  return jsonb_build_object(
    'ok',true,'code',clean_code,'lease_token',p_lease_token,
    'draft_session_id',sid,'lease_expires_at',l.expires_at,'source','OFFLINE_BANK'
  );
end;
$$;

create or replace function public.release_transport_code_if_unused(p_code text,p_owner_id text default null)
returns boolean
language plpgsql
security definer
set search_path to 'public','pg_temp'
as $$
declare
  v_code text;
begin
  v_code := upper(btrim(coalesce(p_code,'')));
  if v_code !~ '^T[0-9]+$' then return false; end if;

  perform pg_advisory_xact_lock(hashtextextended('transport-code-release:'||v_code,0));

  if exists(select 1 from public.transport_clients c where upper(c.tcode)=v_code)
     or exists(
       select 1 from public.transport_orders o
       where upper(o.code_str)=v_code
          or upper(coalesce(o.client_tcode,''))=v_code
          or upper(coalesce(o.data->>'legacy_order_code',''))=v_code
          or upper(coalesce(o.data->>'legacy_client_tcode',''))=v_code
     )
     or exists(
       select 1 from public.arka_pending_payments ap
       where (ap.type='TRANSPORT' or ap.source_module='TRANSPORT')
         and upper(coalesce(ap.transport_code_str,''))=v_code
     )
  then return false;
  end if;

  update public.transport_code_pool
  set status='available',owner_id='POOL'
  where upper(code)=v_code
    and (p_owner_id is null or owner_id=p_owner_id or owner_id like 'DISPATCH_HOLD_%');

  if found then
    update public.offline_code_leases
    set status='released',released_at=coalesce(released_at,now()),updated_at=now(),
        metadata=metadata||jsonb_build_object('release_reason','release_transport_code_if_unused')
    where scope='transport'
      and upper(code)=v_code
      and status in ('available','assigned');
    return true;
  end if;
  return false;
end;
$$;

create or replace function public.finalize_transport_offline_code(
  p_owner_id text,
  p_device_id text,
  p_code text,
  p_lease_token uuid,
  p_draft_session_id text,
  p_order_id text
)
returns jsonb
language plpgsql
security definer
set search_path to 'public','pg_temp'
as $$
declare
  clean_owner text := btrim(coalesce(p_owner_id,''));
  clean_device text := btrim(coalesce(p_device_id,''));
  clean_code text := upper(btrim(coalesce(p_code,'')));
  sid text := nullif(btrim(coalesce(p_draft_session_id,'')),'');
  exact_order text := nullif(btrim(coalesce(p_order_id,'')),'');
  l public.offline_code_leases%rowtype;
  actual_code text := '';
  released boolean := false;
begin
  if not public._tepiha_offline_owner_is_valid(clean_owner) then return jsonb_build_object('ok',false,'reason','OWNER_INVALID'); end if;
  if not public._tepiha_offline_device_is_valid(clean_device) then return jsonb_build_object('ok',false,'reason','DEVICE_INVALID'); end if;
  if clean_code !~ '^T[0-9]+$' or p_lease_token is null or sid is null or exact_order is null then
    return jsonb_build_object('ok',false,'reason','FINALIZE_KEYS_MISSING');
  end if;

  perform pg_advisory_xact_lock(hashtextextended('offline-bank:transport-code:'||clean_code,0));

  select * into l
  from public.offline_code_leases
  where lease_token=p_lease_token
    and scope='transport'
    and upper(code)=clean_code
    and owner_id=clean_owner
    and device_id=clean_device
  for update;

  if not found then return jsonb_build_object('ok',false,'reason','LEASE_NOT_FOUND'); end if;
  if l.status='consumed' and l.order_id=exact_order then return jsonb_build_object('ok',true,'already',true,'code',clean_code,'order_id',exact_order); end if;

  select upper(coalesce(nullif(o.client_tcode,''),nullif(o.code_str,''))) into actual_code
  from public.transport_orders o
  where o.id::text=exact_order
  limit 1;

  if actual_code='' then return jsonb_build_object('ok',false,'reason','EXACT_FINAL_ORDER_NOT_FOUND'); end if;

  if actual_code<>clean_code then
    released := public.release_transport_code_if_unused(clean_code,clean_owner);
    update public.offline_code_leases
    set status='released',released_at=now(),order_id=exact_order,updated_at=now(),
        metadata=metadata||jsonb_build_object(
          'superseded_by_code',actual_code,
          'release_reason','existing_client_code_won',
          'pool_released',released
        )
    where lease_token=p_lease_token;
    return jsonb_build_object('ok',true,'released',true,'reason','EXISTING_CLIENT_CODE_WON','code',clean_code,'final_code',actual_code,'order_id',exact_order);
  end if;

  update public.offline_code_leases
  set status='consumed',draft_session_id=sid,
      assigned_at=coalesce(assigned_at,now()),
      consumed_at=coalesce(consumed_at,now()),
      order_id=exact_order,updated_at=now(),
      metadata=metadata||jsonb_build_object('final_code',actual_code)
  where lease_token=p_lease_token;

  return jsonb_build_object('ok',true,'consumed',true,'code',clean_code,'final_code',actual_code,'order_id',exact_order,'lease_token',p_lease_token);
end;
$$;

revoke all on function public._tepiha_offline_device_is_valid(text) from public;
revoke all on function public._tepiha_offline_owner_is_valid(text) from public;
revoke all on function public.reserve_base_offline_codes(text,text,integer,integer) from public;
revoke all on function public.bind_base_offline_code_to_draft(text,text,bigint,uuid,text) from public;
revoke all on function public.finalize_base_offline_code(text,text,bigint,uuid,text,text,text) from public;
revoke all on function public.reserve_transport_offline_codes(text,text,integer,integer) from public;
revoke all on function public.bind_transport_offline_code_to_order(text,text,text,uuid,text) from public;
revoke all on function public.finalize_transport_offline_code(text,text,text,uuid,text,text) from public;

grant execute on function public.reserve_base_offline_codes(text,text,integer,integer) to anon,authenticated,service_role;
grant execute on function public.bind_base_offline_code_to_draft(text,text,bigint,uuid,text) to anon,authenticated,service_role;
grant execute on function public.finalize_base_offline_code(text,text,bigint,uuid,text,text,text) to anon,authenticated,service_role;
grant execute on function public.reserve_transport_offline_codes(text,text,integer,integer) to anon,authenticated,service_role;
grant execute on function public.bind_transport_offline_code_to_order(text,text,text,uuid,text) to anon,authenticated,service_role;
grant execute on function public.finalize_transport_offline_code(text,text,text,uuid,text,text) to anon,authenticated,service_role;

commit;
