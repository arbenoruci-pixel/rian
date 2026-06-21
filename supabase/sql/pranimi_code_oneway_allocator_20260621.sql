-- PRANIMI ONE-WAY CODE ALLOCATOR V39.1 PRO — 2026-06-21
-- Apply before the V39.1 frontend.
-- Non-destructive: no clients/orders/payments/USED pool rows are deleted or reset.
-- Fails closed on unsafe live data; run the companion BACKUP_AND_VERIFY SELECTs first.

begin;

alter table public.base_code_pool
  add column if not exists reserved_by text,
  add column if not exists reserved_at timestamptz,
  add column if not exists lease_expires_at timestamptz,
  add column if not exists used_at timestamptz,
  add column if not exists draft_session_id text,
  add column if not exists draft_has_meaningful_work boolean not null default false,
  add column if not exists used_by_pin text,
  add column if not exists used_draft_session_id text,
  add column if not exists used_order_id text;

-- Review gates. The migration never repairs/deduplicates live business data by itself.
do $$
begin
  if exists (
    select 1 from public.base_code_pool
    where code is not null group by code having count(*) > 1
  ) then raise exception 'BASE_CODE_POOL_DUPLICATE_CODES_REVIEW_REQUIRED'; end if;

  if exists (
    select 1 from public.base_code_pool
    where btrim(coalesce(status, '')) not in ('available','reserved','used')
  ) then raise exception 'BASE_CODE_POOL_UNEXPECTED_STATUS_REVIEW_REQUIRED'; end if;

  if exists (
    select 1 from public.base_code_pool
    where status = 'reserved'
      and nullif(btrim(coalesce(reserved_by, '')), '') is not null
      and nullif(btrim(coalesce(draft_session_id, '')), '') is not null
    group by btrim(reserved_by)
    having count(*) > 1
  ) then raise exception 'BASE_CODE_POOL_MULTIPLE_BOUND_DRAFTS_PER_PIN_REVIEW_REQUIRED'; end if;
end;
$$;

alter table public.base_code_pool drop constraint if exists base_code_pool_status_check;
alter table public.base_code_pool
  add constraint base_code_pool_status_check
  check (status in ('available','reserved','used')) not valid;
alter table public.base_code_pool validate constraint base_code_pool_status_check;

create unique index if not exists base_code_pool_code_uidx on public.base_code_pool(code);
create index if not exists base_code_pool_pin_session_idx
  on public.base_code_pool(reserved_by, draft_session_id) where status = 'reserved';
create unique index if not exists base_code_pool_one_bound_draft_per_pin_uidx
  on public.base_code_pool((btrim(reserved_by)))
  where status = 'reserved'
    and nullif(btrim(coalesce(reserved_by, '')), '') is not null
    and nullif(btrim(coalesce(draft_session_id, '')), '') is not null;

create or replace function public._tepiha_pin_is_valid(p_pin text)
returns boolean
language plpgsql security definer set search_path = public
as $$
declare
  clean_pin text := btrim(coalesce(p_pin, ''));
  ok boolean := false;
begin
  if clean_pin !~ '^[0-9]{3,12}$' then return false; end if;

  if to_regclass('public.users') is not null then
    execute $q$
      select exists (
        select 1 from public.users u
        where btrim(u.pin::text) = $1
          and lower(coalesce(
            nullif(btrim(to_jsonb(u)->>'is_active'),''),
            nullif(btrim(to_jsonb(u)->>'active'),''),
            'true'
          )) not in ('false','0','no','off','disabled','inactive')
      )
    $q$ into ok using clean_pin;
  end if;

  if not ok and to_regclass('public.tepiha_users') is not null then
    execute $q$
      select exists (
        select 1 from public.tepiha_users u
        where btrim(u.pin::text) = $1
          and lower(coalesce(
            nullif(btrim(to_jsonb(u)->>'is_active'),''),
            nullif(btrim(to_jsonb(u)->>'active'),''),
            'true'
          )) not in ('false','0','no','off','disabled','inactive')
      )
    $q$ into ok using clean_pin;
  end if;
  return ok;
end;
$$;

create or replace function public.release_expired_base_reservations()
returns integer
language plpgsql security definer set search_path = public
as $$
declare changed integer := 0;
begin
  update public.base_code_pool b
  set status = 'available', reserved_by = null, reserved_at = null,
      lease_expires_at = null, draft_session_id = null,
      draft_has_meaningful_work = false
  where b.status = 'reserved'
    and b.lease_expires_at is not null and b.lease_expires_at < now()
    and not exists (select 1 from public.orders o where o.code::text = b.code::text)
    and not exists (select 1 from public.clients c where c.code::text = b.code::text);
  get diagnostics changed = row_count;
  return changed;
end;
$$;

-- Remove every historical overload of allocation/lifecycle RPC names first.
-- This is what makes the migration rerunnable and prevents PostgREST from selecting
-- an older compatible signature after V39.1 is applied.
do $$
declare r record;
begin
  for r in
    select n.nspname, p.proname, oidvectortypes(p.proargtypes) as identity_args
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = any(array[
        'reserve_base_codes_batch',
        'reserve_base_codes_batch_simple',
        'reserve_or_reuse_base_code_for_pin',
        'get_or_assign_pranimi_code',
        'verify_pranimi_code_assignment',
        'renew_pranimi_code_assignment',
        'mark_base_code_used_after_verify',
        'release_pranimi_code_assignment',
        'release_pranimi_temp_code_after_existing_client_save'
      ])
  loop
    execute format('drop function %I.%I(%s)', r.nspname, r.proname, r.identity_args);
  end loop;
end;
$$;

-- Legacy allocation entry points remain callable only to fail closed. They never mutate.
create function public.reserve_base_codes_batch(
  p_pin text, p_n integer default 1, p_lease_minutes integer default 30
) returns table(code bigint)
language plpgsql security definer set search_path = public
as $$
begin
  if coalesce(p_n,0) <= 0 then return; end if;
  raise exception 'PRANIMI_LEGACY_ALLOCATOR_DISABLED_USE_GET_OR_ASSIGN' using errcode='0A000';
end;
$$;

create function public.reserve_base_codes_batch_simple(p_pin text, p_count integer default 1)
returns table(code bigint)
language plpgsql security definer set search_path = public
as $$
begin
  if coalesce(p_count,0) <= 0 then return; end if;
  raise exception 'PRANIMI_LEGACY_ALLOCATOR_DISABLED_USE_GET_OR_ASSIGN' using errcode='0A000';
end;
$$;

create function public.reserve_or_reuse_base_code_for_pin(
  p_pin text, p_lease_minutes integer default 30
) returns table(code bigint)
language plpgsql security definer set search_path = public
as $$
begin
  raise exception 'PRANIMI_LEGACY_ALLOCATOR_DISABLED_USE_GET_OR_ASSIGN' using errcode='0A000';
end;
$$;

-- Return shape changed from V39; drop the exact signature before recreating.
create function public.get_or_assign_pranimi_code(
  p_pin text,
  p_draft_session_id text,
  p_lease_minutes integer default 30
) returns table(
  code bigint,
  status text,
  reserved_by text,
  draft_session_id text,
  lease_expires_at timestamptz,
  verified boolean
)
language plpgsql security definer set search_path = public
as $$
declare
  clean_pin text := btrim(coalesce(p_pin, ''));
  sid text := nullif(btrim(coalesce(p_draft_session_id, '')), '');
  lease_minutes integer := greatest(1, least(coalesce(p_lease_minutes,30),10080));
  picked public.base_code_pool%rowtype;
  other_bound public.base_code_pool%rowtype;
begin
  if not public._tepiha_pin_is_valid(clean_pin) then
    raise exception 'PIN_NOT_FOUND_OR_DISABLED' using errcode='28000';
  end if;
  if sid is null then raise exception 'DRAFT_SESSION_REQUIRED' using errcode='22023'; end if;

  perform pg_advisory_xact_lock(hashtext('tepiha_pranimi_code_allocator_v39_1'));
  perform public.release_expired_base_reservations();

  -- Idempotent reopen/retry of the exact same assignment.
  select b.* into picked from public.base_code_pool b
  where b.status='reserved' and btrim(coalesce(b.reserved_by,''))=clean_pin
    and b.draft_session_id=sid
    and (b.lease_expires_at is null or b.lease_expires_at > now())
  order by b.code limit 1 for update;
  if found then
    update public.base_code_pool b
    set reserved_at=coalesce(b.reserved_at,now()),
        lease_expires_at=now()+make_interval(mins=>lease_minutes)
    where b.code=picked.code returning b.* into picked;
    return query select picked.code::bigint,picked.status,picked.reserved_by,picked.draft_session_id,picked.lease_expires_at,true;
    return;
  end if;

  -- A different live draft on another tab/device remains authoritative.
  select b.* into other_bound from public.base_code_pool b
  where b.status='reserved' and btrim(coalesce(b.reserved_by,''))=clean_pin
    and b.draft_session_id is not null and b.draft_session_id<>sid
    and (b.lease_expires_at is null or b.lease_expires_at > now())
  order by b.reserved_at desc nulls last,b.code limit 1 for update;
  if found then
    raise exception 'PIN_ACTIVE_DRAFT_EXISTS' using errcode='P0001',
      detail=jsonb_build_object('code',other_bound.code,'draft_session_id',other_bound.draft_session_id,'has_meaningful_work',coalesce(other_bound.draft_has_meaningful_work,false))::text;
  end if;

  -- Drain one legacy unbound reservation for this PIN (e.g. Fitim's backlog).
  update public.base_code_pool b
  set draft_session_id=sid, reserved_at=coalesce(b.reserved_at,now()),
      lease_expires_at=now()+make_interval(mins=>lease_minutes),
      draft_has_meaningful_work=false
  where b.code=(
    select b2.code from public.base_code_pool b2
    where b2.status='reserved' and btrim(coalesce(b2.reserved_by,''))=clean_pin
      and b2.draft_session_id is null
      and (b2.lease_expires_at is null or b2.lease_expires_at > now())
      and not exists(select 1 from public.orders o where o.code::text=b2.code::text)
      and not exists(select 1 from public.clients c where c.code::text=b2.code::text)
    order by b2.code limit 1 for update skip locked
  ) returning b.* into picked;
  if found then
    return query select picked.code::bigint,picked.status,picked.reserved_by,picked.draft_session_id,picked.lease_expires_at,true;
    return;
  end if;

  -- Reserve exactly one existing safe pool row. Never mint max(code)+1 here.
  update public.base_code_pool b
  set status='reserved',reserved_by=clean_pin,draft_session_id=sid,
      reserved_at=now(),lease_expires_at=now()+make_interval(mins=>lease_minutes),
      draft_has_meaningful_work=false,used_at=null,used_by_pin=null,
      used_draft_session_id=null,used_order_id=null
  where b.code=(
    select b2.code from public.base_code_pool b2
    where b2.status='available'
      and not exists(select 1 from public.orders o where o.code::text=b2.code::text)
      and not exists(select 1 from public.clients c where c.code::text=b2.code::text)
    order by b2.code limit 1 for update skip locked
  ) returning b.* into picked;
  if picked.code is null then raise exception 'NO_BASE_CODES_AVAILABLE' using errcode='P0001'; end if;
  return query select picked.code::bigint,picked.status,picked.reserved_by,picked.draft_session_id,picked.lease_expires_at,true;
end;
$$;

create function public.verify_pranimi_code_assignment(
  p_code bigint,p_pin text,p_draft_session_id text,p_extend_lease_minutes integer default 0
) returns jsonb
language plpgsql security definer set search_path=public
as $$
declare
  clean_pin text:=btrim(coalesce(p_pin,''));
  sid text:=nullif(btrim(coalesce(p_draft_session_id,'')),'');
  row_pool public.base_code_pool%rowtype;
  foreign_order_id text:=null;
  extend_minutes integer:=greatest(0,least(coalesce(p_extend_lease_minutes,0),10080));
begin
  if not public._tepiha_pin_is_valid(clean_pin) then return jsonb_build_object('ok',false,'displayable',false,'reason','PIN_NOT_FOUND_OR_DISABLED'); end if;
  if p_code is null or sid is null then return jsonb_build_object('ok',false,'displayable',false,'reason','CODE_OR_DRAFT_MISSING'); end if;
  perform pg_advisory_xact_lock(hashtext('tepiha_pranimi_code_allocator_v39_1'));
  select b.* into row_pool from public.base_code_pool b where b.code::text=p_code::text for update;
  if not found then return jsonb_build_object('ok',false,'displayable',false,'reason','POOL_ROW_MISSING'); end if;

  if row_pool.status='used'
    and btrim(coalesce(row_pool.used_by_pin,''))=clean_pin
    and coalesce(row_pool.used_draft_session_id,'')=sid
    and nullif(btrim(coalesce(row_pool.used_order_id,'')),'') is not null then
    return jsonb_build_object('ok',true,'displayable',false,'verified',true,'terminal',true,
      'reason','DRAFT_ALREADY_FINALIZED','code',row_pool.code,'status',row_pool.status,'order_id',row_pool.used_order_id);
  end if;

  if row_pool.status<>'reserved' then return jsonb_build_object('ok',false,'displayable',false,'reason','STATUS_NOT_RESERVED','status',row_pool.status); end if;
  if btrim(coalesce(row_pool.reserved_by,''))<>clean_pin then return jsonb_build_object('ok',false,'displayable',false,'reason','RESERVED_BY_OTHER_PIN'); end if;
  if coalesce(row_pool.draft_session_id,'')<>sid then return jsonb_build_object('ok',false,'displayable',false,'reason','DRAFT_SESSION_MISMATCH'); end if;
  if row_pool.lease_expires_at is not null and row_pool.lease_expires_at<=now() then return jsonb_build_object('ok',false,'displayable',false,'reason','LEASE_EXPIRED'); end if;

  select o.id::text into foreign_order_id from public.orders o
  where o.code::text=p_code::text
    and coalesce(nullif(btrim(to_jsonb(o)->>'local_oid'),''),nullif(btrim(to_jsonb(o)->'data'->>'local_oid'),''),nullif(btrim(to_jsonb(o)->'data'->'pranimi_code_lifecycle'->>'local_oid'),'')) is distinct from sid
  limit 1;
  if foreign_order_id is not null then return jsonb_build_object('ok',false,'displayable',false,'reason','FOREIGN_ORDER_CONFLICT','order_id',foreign_order_id); end if;

  if extend_minutes>0 then
    update public.base_code_pool b set lease_expires_at=now()+make_interval(mins=>extend_minutes),reserved_at=coalesce(b.reserved_at,now())
    where b.code::text=p_code::text returning b.* into row_pool;
  end if;
  return jsonb_build_object('ok',true,'displayable',true,'verified',true,'reason','DB_VERIFIED','code',row_pool.code,
    'status',row_pool.status,'reserved_by',row_pool.reserved_by,'draft_session_id',row_pool.draft_session_id,'lease_expires_at',row_pool.lease_expires_at);
end;
$$;

create function public.renew_pranimi_code_assignment(
  p_code bigint,p_pin text,p_draft_session_id text,p_meaningful boolean default false,p_lease_minutes integer default 30
) returns jsonb
language plpgsql security definer set search_path=public
as $$
declare verdict jsonb; row_pool public.base_code_pool%rowtype; lease_minutes integer:=greatest(1,least(coalesce(p_lease_minutes,30),10080));
begin
  verdict:=public.verify_pranimi_code_assignment(p_code,p_pin,p_draft_session_id,0);
  if coalesce((verdict->>'ok')::boolean,false) is not true or coalesce((verdict->>'terminal')::boolean,false) is true then return verdict; end if;
  update public.base_code_pool b
  set lease_expires_at=now()+make_interval(mins=>lease_minutes),reserved_at=coalesce(b.reserved_at,now()),
      draft_has_meaningful_work=b.draft_has_meaningful_work or coalesce(p_meaningful,false)
  where b.code::text=p_code::text and b.status='reserved'
    and btrim(coalesce(b.reserved_by,''))=btrim(coalesce(p_pin,''))
    and b.draft_session_id=btrim(coalesce(p_draft_session_id,''))
  returning b.* into row_pool;
  if not found then return jsonb_build_object('ok',false,'reason','RENEW_NO_MATCH'); end if;
  return jsonb_build_object('ok',true,'code',row_pool.code,'status',row_pool.status,'reserved_by',row_pool.reserved_by,
    'draft_session_id',row_pool.draft_session_id,'lease_expires_at',row_pool.lease_expires_at,'meaningful',row_pool.draft_has_meaningful_work);
end;
$$;

-- Drop both legacy V39 and V39.1 signatures so rerunning this migration is safe.
create function public.mark_base_code_used_after_verify(
  p_code bigint,p_pin text,p_draft_session_id text,p_order_id text,p_client_phone text default null
) returns jsonb
language plpgsql security definer set search_path=public
as $$
declare
  clean_pin text:=btrim(coalesce(p_pin,'')); sid text:=nullif(btrim(coalesce(p_draft_session_id,'')),'');
  exact_order_id text:=null; order_phone text:=''; expected_phone text:=regexp_replace(coalesce(p_client_phone,''),'[^0-9]','','g');
  row_pool public.base_code_pool%rowtype;
begin
  if not public._tepiha_pin_is_valid(clean_pin) then return jsonb_build_object('ok',false,'reason','PIN_NOT_FOUND_OR_DISABLED'); end if;
  if p_code is null or sid is null or nullif(btrim(coalesce(p_order_id,'')),'') is null then return jsonb_build_object('ok',false,'reason','CONSUME_VERIFY_KEYS_MISSING'); end if;
  perform pg_advisory_xact_lock(hashtext('tepiha_pranimi_code_allocator_v39_1'));

  select o.id::text,regexp_replace(coalesce(to_jsonb(o)->>'client_phone',to_jsonb(o)->'data'->>'client_phone',to_jsonb(o)->'data'->'client'->>'phone',''),'[^0-9]','','g')
  into exact_order_id,order_phone from public.orders o
  where o.id::text=btrim(p_order_id) and o.code::text=p_code::text
    and coalesce(nullif(btrim(to_jsonb(o)->>'local_oid'),''),nullif(btrim(to_jsonb(o)->'data'->>'local_oid'),''),nullif(btrim(to_jsonb(o)->'data'->'pranimi_code_lifecycle'->>'local_oid'),''))=sid
    and coalesce(nullif(lower(btrim(to_jsonb(o)->>'status')),''),lower(btrim(to_jsonb(o)->'data'->>'status')),'') not in
      ('draft','incomplete','paplotesuar','pa_plotesuar','pa_plotsuar','e_paplotesuar','e_pa_plotesuar','e_pa_plotsuar','local_draft','pending_draft')
  limit 1;
  if exact_order_id is null then return jsonb_build_object('ok',false,'reason','EXACT_FINAL_ORDER_NOT_FOUND'); end if;
  if expected_phone<>'' and order_phone<>expected_phone then return jsonb_build_object('ok',false,'reason','ORDER_PHONE_MISMATCH','order_id',exact_order_id); end if;
  if exists(select 1 from public.orders o where o.code::text=p_code::text and o.id::text<>exact_order_id) then
    return jsonb_build_object('ok',false,'reason','DUPLICATE_ORDER_CODE_REVIEW_REQUIRED','order_id',exact_order_id);
  end if;

  select b.* into row_pool from public.base_code_pool b where b.code::text=p_code::text for update;
  if not found then return jsonb_build_object('ok',false,'reason','POOL_ROW_MISSING'); end if;
  if row_pool.status='used' then
    if row_pool.used_order_id=exact_order_id and btrim(coalesce(row_pool.used_by_pin,''))=clean_pin and row_pool.used_draft_session_id=sid then
      return jsonb_build_object('ok',true,'already',true,'burned',false,'code',p_code,'order_id',exact_order_id);
    end if;
    return jsonb_build_object('ok',false,'reason','USED_PROVENANCE_MISMATCH','used_order_id',row_pool.used_order_id,'used_by_pin',row_pool.used_by_pin,'used_draft_session_id',row_pool.used_draft_session_id);
  end if;
  if row_pool.status<>'reserved' then return jsonb_build_object('ok',false,'reason','STATUS_NOT_RESERVED','status',row_pool.status); end if;
  if btrim(coalesce(row_pool.reserved_by,''))<>clean_pin then return jsonb_build_object('ok',false,'reason','RESERVED_BY_OTHER_PIN'); end if;
  if coalesce(row_pool.draft_session_id,'')<>sid then return jsonb_build_object('ok',false,'reason','DRAFT_SESSION_MISMATCH'); end if;

  update public.base_code_pool b set status='used',reserved_by=null,reserved_at=null,lease_expires_at=null,draft_session_id=null,
    draft_has_meaningful_work=false,used_at=now(),used_by_pin=clean_pin,used_draft_session_id=sid,used_order_id=exact_order_id
  where b.code::text=p_code::text;
  return jsonb_build_object('ok',true,'already',false,'burned',true,'code',p_code,'order_id',exact_order_id);
end;
$$;

create function public.release_pranimi_code_assignment(
  p_code bigint,p_pin text,p_draft_session_id text,p_reason text default null
) returns jsonb
language plpgsql security definer set search_path=public
as $$
declare clean_pin text:=btrim(coalesce(p_pin,'')); sid text:=nullif(btrim(coalesce(p_draft_session_id,'')),''); changed integer:=0;
begin
  if not public._tepiha_pin_is_valid(clean_pin) then return jsonb_build_object('ok',false,'reason','PIN_NOT_FOUND_OR_DISABLED'); end if;
  if p_code is null or sid is null then return jsonb_build_object('ok',false,'reason','CODE_OR_DRAFT_MISSING'); end if;
  perform pg_advisory_xact_lock(hashtext('tepiha_pranimi_code_allocator_v39_1'));
  if exists(select 1 from public.orders o where o.code::text=p_code::text) then return jsonb_build_object('ok',false,'reason','ORDER_EXISTS_FOR_CODE'); end if;
  if exists(select 1 from public.clients c where c.code::text=p_code::text) then return jsonb_build_object('ok',false,'reason','CLIENT_EXISTS_FOR_CODE'); end if;
  update public.base_code_pool b set status='available',reserved_by=null,reserved_at=null,lease_expires_at=null,draft_session_id=null,draft_has_meaningful_work=false
  where b.code::text=p_code::text and b.status='reserved' and btrim(coalesce(b.reserved_by,''))=clean_pin and b.draft_session_id=sid;
  get diagnostics changed=row_count;
  if changed<>1 then return jsonb_build_object('ok',false,'reason','ASSIGNMENT_NOT_OWNED_OR_NOT_RESERVED'); end if;
  return jsonb_build_object('ok',true,'released',true,'code',p_code,'reason_note',p_reason);
end;
$$;

create function public.release_pranimi_temp_code_after_existing_client_save(
  p_temp_code bigint,p_final_code bigint,p_pin text,p_draft_session_id text,p_order_id text
) returns jsonb
language plpgsql security definer set search_path=public
as $$
declare clean_pin text:=btrim(coalesce(p_pin,'')); sid text:=nullif(btrim(coalesce(p_draft_session_id,'')),''); exact_order_id text:=null; row_pool public.base_code_pool%rowtype;
begin
  if not public._tepiha_pin_is_valid(clean_pin) then return jsonb_build_object('ok',false,'reason','PIN_NOT_FOUND_OR_DISABLED'); end if;
  if p_temp_code is null or p_final_code is null or p_temp_code=p_final_code or sid is null or nullif(btrim(coalesce(p_order_id,'')),'') is null then return jsonb_build_object('ok',false,'reason','TEMP_RELEASE_VERIFY_KEYS_INVALID'); end if;
  perform pg_advisory_xact_lock(hashtext('tepiha_pranimi_code_allocator_v39_1'));
  select o.id::text into exact_order_id from public.orders o
  where o.id::text=btrim(p_order_id) and o.code::text=p_final_code::text
    and coalesce(nullif(btrim(to_jsonb(o)->>'local_oid'),''),nullif(btrim(to_jsonb(o)->'data'->>'local_oid'),''),nullif(btrim(to_jsonb(o)->'data'->'pranimi_code_lifecycle'->>'local_oid'),''))=sid
    and coalesce(nullif(lower(btrim(to_jsonb(o)->>'status')),''),lower(btrim(to_jsonb(o)->'data'->>'status')),'') not in
      ('draft','incomplete','paplotesuar','pa_plotesuar','pa_plotsuar','e_paplotesuar','e_pa_plotesuar','e_pa_plotsuar','local_draft','pending_draft')
  limit 1;
  if exact_order_id is null then return jsonb_build_object('ok',false,'reason','EXACT_FINAL_EXISTING_CLIENT_ORDER_NOT_FOUND'); end if;
  if exists(select 1 from public.orders o where o.code::text=p_temp_code::text) then return jsonb_build_object('ok',false,'reason','ORDER_EXISTS_FOR_TEMP_CODE'); end if;
  if exists(select 1 from public.clients c where c.code::text=p_temp_code::text) then return jsonb_build_object('ok',false,'reason','CLIENT_EXISTS_FOR_TEMP_CODE_REVIEW_REQUIRED'); end if;
  select b.* into row_pool from public.base_code_pool b where b.code::text=p_temp_code::text for update;
  if not found then return jsonb_build_object('ok',false,'reason','TEMP_POOL_ROW_MISSING'); end if;
  if row_pool.status<>'reserved' then return jsonb_build_object('ok',false,'reason','TEMP_STATUS_NOT_RESERVED'); end if;
  if btrim(coalesce(row_pool.reserved_by,''))<>clean_pin then return jsonb_build_object('ok',false,'reason','TEMP_RESERVED_BY_OTHER_PIN'); end if;
  if coalesce(row_pool.draft_session_id,'')<>sid then return jsonb_build_object('ok',false,'reason','TEMP_DRAFT_SESSION_MISMATCH'); end if;
  update public.base_code_pool b set status='available',reserved_by=null,reserved_at=null,lease_expires_at=null,draft_session_id=null,draft_has_meaningful_work=false
  where b.code::text=p_temp_code::text and b.status='reserved' and btrim(coalesce(b.reserved_by,''))=clean_pin and b.draft_session_id=sid;
  if not found then return jsonb_build_object('ok',false,'reason','TEMP_ASSIGNMENT_RELEASE_NOT_CONFIRMED'); end if;
  return jsonb_build_object('ok',true,'released',true,'temp_code',p_temp_code,'final_code',p_final_code,'order_id',exact_order_id);
end;
$$;

-- New functions receive EXECUTE for PUBLIC by default in PostgreSQL. Remove it.
-- Legacy stubs and internal helpers stay inaccessible to app roles; only the six
-- official one-way lifecycle RPCs are exposed.
revoke all on function public._tepiha_pin_is_valid(text) from public,anon,authenticated;
revoke all on function public.release_expired_base_reservations() from public,anon,authenticated;
revoke all on function public.reserve_base_codes_batch(text,integer,integer) from public,anon,authenticated;
revoke all on function public.reserve_base_codes_batch_simple(text,integer) from public,anon,authenticated;
revoke all on function public.reserve_or_reuse_base_code_for_pin(text,integer) from public,anon,authenticated;
revoke all on function public.get_or_assign_pranimi_code(text,text,integer) from public,anon,authenticated;
revoke all on function public.verify_pranimi_code_assignment(bigint,text,text,integer) from public,anon,authenticated;
revoke all on function public.renew_pranimi_code_assignment(bigint,text,text,boolean,integer) from public,anon,authenticated;
revoke all on function public.mark_base_code_used_after_verify(bigint,text,text,text,text) from public,anon,authenticated;
revoke all on function public.release_pranimi_code_assignment(bigint,text,text,text) from public,anon,authenticated;
revoke all on function public.release_pranimi_temp_code_after_existing_client_save(bigint,bigint,text,text,text) from public,anon,authenticated;

grant execute on function public.get_or_assign_pranimi_code(text,text,integer) to anon,authenticated,service_role;
grant execute on function public.verify_pranimi_code_assignment(bigint,text,text,integer) to anon,authenticated,service_role;
grant execute on function public.renew_pranimi_code_assignment(bigint,text,text,boolean,integer) to anon,authenticated,service_role;
grant execute on function public.mark_base_code_used_after_verify(bigint,text,text,text,text) to anon,authenticated,service_role;
grant execute on function public.release_pranimi_code_assignment(bigint,text,text,text) to anon,authenticated,service_role;
grant execute on function public.release_pranimi_temp_code_after_existing_client_save(bigint,bigint,text,text,text) to anon,authenticated,service_role;

commit;
