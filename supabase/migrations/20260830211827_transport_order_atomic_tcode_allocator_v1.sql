begin;

set local lock_timeout='15s';
set local statement_timeout='120s';

-- Dispatch used to reserve an online T-code in one HTTP request and create the
-- order in a later request. A lost/unparseable reservation response could leave
-- the pool row marked used even though no client or order was ever created.
--
-- Keep the existing RPC signature so installed PWAs remain compatible. The
-- authenticated service-role Dispatch endpoint may pass NULL/blank
-- p_code_str; the code is then allocated in this same transaction. Supplied
-- codes remain supported for offline leases and older clients that still
-- reserve before create.

alter table public.transport_orders
  add column if not exists transport_create_fingerprint_v1 text;

-- Backfill only already-valid values if this migration is replayed after a
-- partially deployed server build. Invalid/untrusted JSON never becomes an
-- idempotency authority.
update public.transport_orders
set transport_create_fingerprint_v1=lower(btrim(data->>'transport_create_fingerprint_v1'))
where transport_create_fingerprint_v1 is null
  and lower(btrim(coalesce(data->>'transport_create_fingerprint_v1',''))) ~ '^[0-9a-f]{64}$';

do $$
begin
  if not exists(
    select 1 from pg_constraint
    where conrelid='public.transport_orders'::regclass
      and conname='transport_orders_create_fingerprint_v1_check'
  ) then
    alter table public.transport_orders
      add constraint transport_orders_create_fingerprint_v1_check
      check (
        transport_create_fingerprint_v1 is null
        or transport_create_fingerprint_v1 ~ '^[0-9a-f]{64}$'
      );
  end if;
end;
$$;

create or replace function public.transport_order_fingerprint_guard_v1()
returns trigger
language plpgsql
security invoker
set search_path to 'public','pg_temp'
as $$
declare
  v_fingerprint text;
  v_caller_role text:=lower(coalesce(
    nullif(auth.role(),''),
    nullif(current_setting('request.jwt.claim.role',true),''),
    current_user::text,
    ''
  ));
begin
  -- Once present, the trusted create fingerprint is immutable. Preserve both
  -- the column and its JSON mirror when an older/stale full-data UPDATE omits it.
  if tg_op='UPDATE' and old.transport_create_fingerprint_v1 is not null then
    new.transport_create_fingerprint_v1:=old.transport_create_fingerprint_v1;
    new.data:=jsonb_set(
      coalesce(new.data,'{}'::jsonb),
      '{transport_create_fingerprint_v1}',
      to_jsonb(old.transport_create_fingerprint_v1),
      true
    );
    return new;
  end if;

  v_fingerprint:=lower(nullif(btrim(coalesce(
    new.transport_create_fingerprint_v1,
    new.data->>'transport_create_fingerprint_v1',
    ''
  )),''));

  if v_fingerprint is null then
    new.transport_create_fingerprint_v1:=null;
    new.data:=coalesce(new.data,'{}'::jsonb)-'transport_create_fingerprint_v1';
    return new;
  end if;

  if v_caller_role<>'service_role' then
    raise exception using errcode='42501',message='TRANSPORT_CREATE_FINGERPRINT_SERVICE_ROLE_REQUIRED';
  end if;
  if v_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception using errcode='23514',message='TRANSPORT_CREATE_FINGERPRINT_INVALID';
  end if;

  new.transport_create_fingerprint_v1:=v_fingerprint;
  new.data:=jsonb_set(
    coalesce(new.data,'{}'::jsonb),
    '{transport_create_fingerprint_v1}',
    to_jsonb(v_fingerprint),
    true
  );
  return new;
end;
$$;

drop trigger if exists transport_order_fingerprint_guard_v1 on public.transport_orders;
drop trigger if exists trg_zzz_transport_order_fingerprint_guard_v1 on public.transport_orders;
create trigger trg_zzz_transport_order_fingerprint_guard_v1
before insert or update of transport_create_fingerprint_v1,data
on public.transport_orders
for each row execute function public.transport_order_fingerprint_guard_v1();

revoke all on function public.transport_order_fingerprint_guard_v1() from public,anon,authenticated;
grant execute on function public.transport_order_fingerprint_guard_v1() to service_role;

create or replace function public.release_transport_code_if_unused(
  p_code text,
  p_owner_id text default null
)
returns boolean
language plpgsql
security definer
set search_path to 'public','pg_temp'
as $$
declare
  v_code text;
  v_code_n bigint;
  v_active_lease_owner text;
begin
  v_code := upper(btrim(coalesce(p_code,'')));
  if v_code !~ '^T[0-9]+$' then return false; end if;
  v_code := 'T'||(regexp_replace(v_code,'\D','','g')::bigint)::text;
  v_code_n := regexp_replace(v_code,'\D','','g')::bigint;

  perform pg_advisory_xact_lock(hashtextextended('transport-code-release:'||v_code,0));

  -- A caller without the matching owner may not release an active offline lease.
  -- Matching owners are allowed because the offline lifecycle deliberately uses
  -- this RPC to release a superseded lease.
  select l.owner_id into v_active_lease_owner
  from public.offline_code_leases l
  where l.scope='transport'
    and upper(l.code)=v_code
    and l.status in ('available','assigned')
    and l.expires_at>now()
  order by l.reserved_at desc
  limit 1
  for update;

  if v_active_lease_owner is not null
     and (p_owner_id is null or btrim(p_owner_id)<>v_active_lease_owner)
  then
    return false;
  end if;

  if exists(
       select 1
       from public.transport_clients c
       where upper(coalesce(c.tcode,''))=v_code
          or c.client_code=v_code_n
     )
     or exists(
       select 1
       from public.transport_orders o
       where upper(coalesce(o.code_str,''))=v_code
          or o.code_n=v_code_n
          or upper(coalesce(o.client_tcode,''))=v_code
          or upper(btrim(coalesce(o.data->>'code_str','')))=v_code
          or upper(btrim(coalesce(o.data->>'official_order_code','')))=v_code
          or upper(btrim(coalesce(o.data->>'order_code',''))) in (v_code,v_code_n::text)
          or upper(btrim(coalesce(o.data->>'order_tcode','')))=v_code
          or upper(btrim(coalesce(o.data->>'client_tcode','')))=v_code
          or upper(btrim(coalesce(o.data->>'code',''))) in (v_code,v_code_n::text)
          or upper(btrim(coalesce(o.data->>'transport_client_tcode','')))=v_code
          or upper(btrim(coalesce(o.data->>'legacy_order_code',''))) in (v_code,v_code_n::text)
          or upper(coalesce(o.data->>'legacy_client_tcode',''))=v_code
          or upper(btrim(coalesce(o.data->>'linked_client_code',''))) in (v_code,v_code_n::text)
          or upper(btrim(coalesce(o.data->'client'->>'tcode','')))=v_code
          or upper(btrim(coalesce(o.data->'client'->>'code_str','')))=v_code
          or upper(btrim(coalesce(o.data->'client'->>'code',''))) in (v_code,v_code_n::text)
          or upper(btrim(coalesce(o.data->'client'->>'order_code',''))) in (v_code,v_code_n::text)
          or upper(btrim(coalesce(o.data->'client'->>'official_order_code','')))=v_code
          or upper(btrim(coalesce(o.data->'client'->>'order_tcode','')))=v_code
          or upper(btrim(coalesce(o.data->'client'->>'client_tcode','')))=v_code
          or upper(btrim(coalesce(o.data->'client'->>'transport_client_tcode','')))=v_code
     )
     or exists(
       select 1
       from public.arka_pending_payments ap
       where (upper(coalesce(ap.type,''))='TRANSPORT'
              or upper(coalesce(ap.source_module,''))='TRANSPORT')
         and (
           upper(coalesce(ap.transport_code_str,''))=v_code
           or ap.order_code=v_code_n
         )
     )
     or exists(
       select 1
       from public.cash_handoff_items hi
       where upper(coalesce(hi.source_module,''))='TRANSPORT'
         and (
           upper(btrim(coalesce(hi.transport_code_str,'')))=v_code
           or hi.order_code=v_code_n
         )
     )
     or exists(
       select 1
       from public.arka_payment_exclusions pe
       where (
           upper(coalesce(pe.type_snapshot,''))='TRANSPORT'
           or upper(coalesce(pe.source_module_snapshot,''))='TRANSPORT'
         )
         and (
           upper(btrim(coalesce(pe.transport_code_snapshot,'')))=v_code
           or upper(btrim(coalesce(pe.order_code_snapshot,''))) in (v_code,v_code_n::text)
         )
     )
     or exists(
       select 1
       from public.transport_client_debts d
       where upper(btrim(coalesce(d.client_tcode,'')))=v_code
     )
     or exists(
       select 1
       from public.transport_receivables r
       where upper(btrim(coalesce(r.client_tcode,'')))=v_code
     )
     or exists(
       select 1
       from public.dispatch_tasks t
       where upper(btrim(coalesce(t.code,'')))=v_code
     )
     or exists(
       select 1
       from public.transport_order_measurement_audit a
       where upper(btrim(coalesce(a.code_str,'')))=v_code
     )
     or exists(
       select 1
       from public.transport_keep_one k
       where upper(btrim(coalesce(k.code_str,'')))=v_code
          or upper(btrim(coalesce(k.client_tcode,'')))=v_code
          or k.code_n=v_code_n
          or exists(
            select 1
            from jsonb_each_text(
              case
                when jsonb_typeof(k.data)='object' then k.data
                else '{}'::jsonb
              end
            ) as value_pair(key,value)
            where upper(btrim(value_pair.value)) in (v_code,v_code_n::text)
          )
     )
  then
    return false;
  end if;

  update public.transport_code_pool p
  set status='available',owner_id='POOL'
  where upper(p.code)=v_code
    and p.status='used'
    and (
      p_owner_id is null
      or p.owner_id=btrim(p_owner_id)
      or p.owner_id like 'DISPATCH_HOLD_%'
    );

  if not found then return false; end if;

  update public.offline_code_leases l
  set status='released',
      released_at=coalesce(l.released_at,now()),
      updated_at=now(),
      metadata=coalesce(l.metadata,'{}'::jsonb)
        || jsonb_build_object('release_reason','release_transport_code_if_unused')
  where l.scope='transport'
    and upper(l.code)=v_code
    and l.status in ('available','assigned')
    and (p_owner_id is null or l.owner_id=btrim(p_owner_id));

  return true;
end;
$$;

create or replace function public.create_transport_order(
  p_id uuid,
  p_code_n bigint,
  p_code_str text,
  p_client_name text,
  p_client_phone text,
  p_address text,
  p_gps_lat text,
  p_gps_lng text,
  p_data jsonb,
  p_status text
)
returns jsonb
language plpgsql
security invoker
set search_path to 'public','pg_temp'
as $$
declare
  v_client_id uuid;
  v_client_tcode text;
  v_order_code text;
  v_supplied_code text;
  v_phone_digits text;
  v_existing_phone_digits text;
  v_search_code bigint;
  v_data jsonb;
  v_order public.transport_orders%rowtype;
  v_address text;
  v_location_gps_lat text;
  v_location_gps_lng text;
  v_existing_gps_lat text;
  v_existing_gps_lng text;
  v_master_address text;
  v_master_gps_lat text;
  v_master_gps_lng text;
  v_existing_location boolean := false;
  v_client_was_new boolean := false;
  v_gps_explicit boolean := false;
  v_client_match_count integer := 0;
  v_owner text;
  v_reserved_codes jsonb;
  v_atomic_allocation_requested boolean := false;
  v_allocated_in_transaction boolean := false;
  v_superseded_code_released boolean := false;
  v_request_fingerprint text;
  v_existing_fingerprint text;
  v_existing_order_code text;
  v_caller_role text;
  v_supplied_pool_status text;
  v_supplied_pool_owner text;
  v_supplied_claim_valid boolean := false;
  v_offline_lease_token_text text;
  v_offline_lease_owner text;
  v_offline_lease_device text;
  v_offline_lease_draft text;
begin
  if p_id is null then p_id:=gen_random_uuid(); end if;

  v_phone_digits:=public.normalize_transport_phone_key(p_client_phone);
  if length(v_phone_digits)<8 then
    raise exception using errcode='23514',message='TRANSPORT_PHONE_INVALID';
  end if;

  v_supplied_code:=upper(btrim(coalesce(p_code_str,'')));
  if v_supplied_code !~ '^T[0-9]{1,18}$' then
    v_supplied_code:=null;
  else
    v_supplied_code:='T'||(regexp_replace(v_supplied_code,'\D','','g')::bigint)::text;
    if v_supplied_code='T0' then v_supplied_code:=null; end if;
  end if;

  if v_supplied_code is not null
     and p_code_n is not null
     and p_code_n<>regexp_replace(v_supplied_code,'\D','','g')::bigint
  then
    raise exception using errcode='23514',message='TRANSPORT_CODE_PAIR_MISMATCH';
  end if;

  v_owner:=coalesce(
    nullif(btrim(coalesce(p_data->>'code_owner','')),''),
    nullif(btrim(coalesce(p_data->>'transport_pin','')),''),
    nullif(btrim(coalesce(p_data->>'driver_pin','')),''),
    nullif(btrim(coalesce(p_data->>'created_by_pin','')),''),
    'ATOMIC_CREATE'
  );
  v_atomic_allocation_requested:=
    upper(btrim(coalesce(p_data->>'transport_tcode_allocation_mode','')))='ATOMIC_DB';
  v_request_fingerprint:=lower(nullif(btrim(coalesce(p_data->>'transport_create_fingerprint_v1','')),''));
  v_caller_role:=lower(coalesce(
    nullif(auth.role(),''),
    nullif(current_setting('request.jwt.claim.role',true),''),
    current_user::text,
    ''
  ));

  -- Client-supplied JSON flags are audit metadata, not authorization. Only the
  -- approved-device server endpoint uses the service-role key and may create a
  -- genuinely new Dispatch client without a supplied T-code.
  if v_supplied_code is null and v_atomic_allocation_requested then
    if v_caller_role<>'service_role' then
      raise exception using errcode='42501',message='TRANSPORT_ATOMIC_TCODE_SERVICE_ROLE_REQUIRED';
    end if;
    if v_request_fingerprint is null or v_request_fingerprint !~ '^[0-9a-f]{64}$' then
      raise exception using errcode='23514',message='TRANSPORT_CREATE_FINGERPRINT_REQUIRED';
    end if;
  end if;

  -- The UUID is the retry identity. Lock it before the phone lock so two
  -- concurrent requests that accidentally reuse one UUID with different phones
  -- cannot race to a generic primary-key failure or bypass the identity checks.
  perform pg_advisory_xact_lock(hashtextextended('transport-order:'||p_id::text,0));

  -- Fast idempotency path with an identity guard. A UUID may never be reused for
  -- another phone, even if a client retries with stale local state.
  select * into v_order
  from public.transport_orders
  where id=p_id;

  if found then
    v_existing_phone_digits:=public.normalize_transport_phone_key(coalesce(
      v_order.client_phone,
      v_order.data->>'client_phone',
      v_order.data->'client'->>'phone',
      ''
    ));
    if v_existing_phone_digits is distinct from v_phone_digits then
      if v_supplied_code is not null then
        v_existing_order_code:=upper(btrim(coalesce(v_order.client_tcode,v_order.code_str,'')));
        if v_supplied_code<>v_existing_order_code then
          v_superseded_code_released:=public.release_transport_code_if_unused(v_supplied_code,v_owner);
        end if;
      end if;
      return jsonb_build_object(
        'success',false,
        'error','TRANSPORT_ORDER_IDEMPOTENCY_PHONE_CONFLICT',
        'order_id',v_order.id,
        'superseded_code_released',v_superseded_code_released
      );
    end if;
    v_existing_fingerprint:=lower(nullif(btrim(coalesce(
      v_order.transport_create_fingerprint_v1,
      v_order.data->>'transport_create_fingerprint_v1',
      ''
    )),''));
    if v_request_fingerprint is not null or v_existing_fingerprint is not null then
      if v_request_fingerprint is distinct from v_existing_fingerprint then
        if v_supplied_code is not null then
          v_existing_order_code:=upper(btrim(coalesce(v_order.client_tcode,v_order.code_str,'')));
          if v_supplied_code<>v_existing_order_code then
            v_superseded_code_released:=public.release_transport_code_if_unused(v_supplied_code,v_owner);
          end if;
        end if;
        return jsonb_build_object(
          'success',false,
          'error','TRANSPORT_ORDER_IDEMPOTENCY_FINGERPRINT_CONFLICT',
          'order_id',v_order.id,
          'superseded_code_released',v_superseded_code_released
        );
      end if;
    end if;
    if v_supplied_code is not null then
      v_existing_order_code:=upper(btrim(coalesce(v_order.client_tcode,v_order.code_str,'')));
      if v_supplied_code<>v_existing_order_code then
        v_superseded_code_released:=public.release_transport_code_if_unused(v_supplied_code,v_owner);
      end if;
    end if;
    return jsonb_build_object(
      'success',true,
      'order_id',v_order.id,
      'client_id',v_order.client_id,
      'code_str',v_order.code_str,
      'client_tcode',v_order.client_tcode,
      'visit_nr',v_order.visit_nr,
      'idempotent',true,
      'allocated_in_transaction',false,
      'superseded_code_released',v_superseded_code_released
    );
  end if;

  -- Serializes all creates for the same normalized phone. Recheck the UUID after
  -- taking the lock so simultaneous retries return the committed row.
  perform pg_advisory_xact_lock(hashtextextended('transport-phone:'||v_phone_digits,0));

  select * into v_order
  from public.transport_orders
  where id=p_id;

  if found then
    v_existing_phone_digits:=public.normalize_transport_phone_key(coalesce(
      v_order.client_phone,
      v_order.data->>'client_phone',
      v_order.data->'client'->>'phone',
      ''
    ));
    if v_existing_phone_digits is distinct from v_phone_digits then
      if v_supplied_code is not null then
        v_existing_order_code:=upper(btrim(coalesce(v_order.client_tcode,v_order.code_str,'')));
        if v_supplied_code<>v_existing_order_code then
          v_superseded_code_released:=public.release_transport_code_if_unused(v_supplied_code,v_owner);
        end if;
      end if;
      return jsonb_build_object(
        'success',false,
        'error','TRANSPORT_ORDER_IDEMPOTENCY_PHONE_CONFLICT',
        'order_id',v_order.id,
        'superseded_code_released',v_superseded_code_released
      );
    end if;
    v_existing_fingerprint:=lower(nullif(btrim(coalesce(
      v_order.transport_create_fingerprint_v1,
      v_order.data->>'transport_create_fingerprint_v1',
      ''
    )),''));
    if v_request_fingerprint is not null or v_existing_fingerprint is not null then
      if v_request_fingerprint is distinct from v_existing_fingerprint then
        if v_supplied_code is not null then
          v_existing_order_code:=upper(btrim(coalesce(v_order.client_tcode,v_order.code_str,'')));
          if v_supplied_code<>v_existing_order_code then
            v_superseded_code_released:=public.release_transport_code_if_unused(v_supplied_code,v_owner);
          end if;
        end if;
        return jsonb_build_object(
          'success',false,
          'error','TRANSPORT_ORDER_IDEMPOTENCY_FINGERPRINT_CONFLICT',
          'order_id',v_order.id,
          'superseded_code_released',v_superseded_code_released
        );
      end if;
    end if;
    if v_supplied_code is not null then
      v_existing_order_code:=upper(btrim(coalesce(v_order.client_tcode,v_order.code_str,'')));
      if v_supplied_code<>v_existing_order_code then
        v_superseded_code_released:=public.release_transport_code_if_unused(v_supplied_code,v_owner);
      end if;
    end if;
    return jsonb_build_object(
      'success',true,
      'order_id',v_order.id,
      'client_id',v_order.client_id,
      'code_str',v_order.code_str,
      'client_tcode',v_order.client_tcode,
      'visit_nr',v_order.visit_nr,
      'idempotent',true,
      'allocated_in_transaction',false,
      'superseded_code_released',v_superseded_code_released
    );
  end if;

  select
    c.id,c.tcode,c.address,c.gps_lat,c.gps_lng,
    count(*) over()::integer
  into
    v_client_id,v_client_tcode,v_master_address,v_master_gps_lat,v_master_gps_lng,
    v_client_match_count
  from public.transport_clients c
  where public.normalize_transport_phone_key(coalesce(c.phone_digits,c.phone,''))=v_phone_digits
  order by c.updated_at desc nulls last,c.id
  limit 1;

  if v_client_match_count>1 then
    raise exception using errcode='23505',message='TRANSPORT_PHONE_IDENTITY_CONFLICT';
  end if;

  v_address:=nullif(btrim(p_address),'');
  v_gps_explicit:=lower(coalesce(p_data->>'location_gps_explicit','false')) in ('1','true','yes');

  if v_client_id is null then
    v_client_was_new:=true;
    v_order_code:=v_supplied_code;

    if v_order_code is not null then
      -- A supplied code for a genuinely new phone must already be a real pool
      -- claim. Serialize it with allocator/cleanup, then lock and verify the
      -- exact pool row. A stale or guessed T-code cannot create a new client.
      perform pg_advisory_xact_lock(
        hashtextextended('transport-code-allocator-v3',0)
      );
      perform pg_advisory_xact_lock(
        hashtextextended('offline-bank:transport-code:'||v_order_code,0)
      );
      perform pg_advisory_xact_lock(
        hashtextextended('transport-code-release:'||v_order_code,0)
      );

      select p.status,p.owner_id
      into v_supplied_pool_status,v_supplied_pool_owner
      from public.transport_code_pool p
      where p.code=v_order_code
      for update;

      v_supplied_claim_valid:=found
        and v_supplied_pool_status='used'
        and v_supplied_pool_owner=v_owner;

      if not v_supplied_claim_valid then
        v_offline_lease_token_text:=lower(nullif(btrim(coalesce(
          p_data->'offline_code_lease'->>'lease_token',
          p_data->'pranimi_code_lifecycle'->'offline_code_lease'->>'lease_token',
          ''
        )),''));
        v_offline_lease_owner:=nullif(btrim(coalesce(
          p_data->'offline_code_lease'->>'owner_id',
          p_data->'pranimi_code_lifecycle'->'offline_code_lease'->>'owner_id',
          ''
        )), '');
        v_offline_lease_device:=nullif(btrim(coalesce(
          p_data->'offline_code_lease'->>'device_id',
          p_data->'pranimi_code_lifecycle'->'offline_code_lease'->>'device_id',
          ''
        )), '');
        v_offline_lease_draft:=nullif(btrim(coalesce(
          p_data->'offline_code_lease'->>'draft_session_id',
          p_data->'pranimi_code_lifecycle'->'offline_code_lease'->>'draft_session_id',
          p_data->>'local_oid',
          p_data->>'order_id',
          p_data->>'public_order_id',
          p_id::text
        )), '');

        if v_supplied_pool_status='used'
           and v_offline_lease_token_text ~
             '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
           and v_offline_lease_owner is not null
           and v_offline_lease_device is not null
           and v_offline_lease_draft is not null
        then
          select exists(
            select 1
            from public.offline_code_leases l
            where l.lease_token=v_offline_lease_token_text::uuid
              and l.scope='transport'
              and upper(btrim(l.code))=v_order_code
              and l.owner_id=v_offline_lease_owner
              and l.owner_id=v_supplied_pool_owner
              and l.device_id=v_offline_lease_device
              and l.status in ('available','assigned')
              and l.expires_at>now()
              and (
                l.draft_session_id is null
                or l.draft_session_id=v_offline_lease_draft
              )
          ) into v_supplied_claim_valid;
        end if;
      end if;

      if not v_supplied_claim_valid then
        raise exception using
          errcode='P0001',
          message='TRANSPORT_SUPPLIED_TCODE_CLAIM_INVALID';
      end if;
    end if;

    if v_order_code is null then
      if not v_atomic_allocation_requested then
        raise exception using errcode='23514',message='TRANSPORT_TCODE_REQUIRED_FOR_NEW_CLIENT';
      end if;
      -- The allocator runs in this RPC transaction. Its pool UPDATE/INSERT is
      -- rolled back automatically if client or order creation later fails.
      v_reserved_codes:=public.reserve_transport_codes_batch(v_owner,1);
      v_order_code:=upper(btrim(coalesce(v_reserved_codes->>0,'')));
      if v_order_code !~ '^T[0-9]+$' then
        raise exception using errcode='P0001',message='TRANSPORT_ATOMIC_TCODE_ALLOCATION_FAILED';
      end if;
      v_order_code:='T'||(regexp_replace(v_order_code,'\D','','g')::bigint)::text;
      v_allocated_in_transaction:=true;
    end if;

    v_client_tcode:=v_order_code;
    v_search_code:=left(regexp_replace(v_client_tcode,'\D','','g')||v_phone_digits,15)::bigint;

    insert into public.transport_clients(
      name,phone,address,gps_lat,gps_lng,phone_digits,name_lc,search_code,tcode,updated_at
    ) values (
      coalesce(nullif(btrim(p_client_name),''),'PA EMER'),
      p_client_phone,
      v_address,
      nullif(btrim(p_gps_lat),''),
      nullif(btrim(p_gps_lng),''),
      regexp_replace(coalesce(p_client_phone,''),'\D','','g'),
      lower(coalesce(p_client_name,'')),
      v_search_code,
      v_client_tcode,
      now()
    ) returning id into v_client_id;

    v_master_address:=v_address;
    v_master_gps_lat:=nullif(btrim(p_gps_lat),'');
    v_master_gps_lng:=nullif(btrim(p_gps_lng),'');
  else
    if v_client_tcode is null or v_client_tcode !~ '^T[0-9]+$' then
      raise exception using errcode='23514',message='TRANSPORT_CLIENT_TCODE_REQUIRED';
    end if;
    v_client_tcode:='T'||(regexp_replace(v_client_tcode,'\D','','g')::bigint)::text;
    -- Existing clients always use their permanent master code. A temporary
    -- supplied reservation is released below after the order exists.
    v_order_code:=v_client_tcode;
    update public.transport_clients
    set name=coalesce(nullif(btrim(p_client_name),''),name),updated_at=now()
    where id=v_client_id;
  end if;

  v_location_gps_lat:=nullif(btrim(p_gps_lat),'');
  v_location_gps_lng:=nullif(btrim(p_gps_lng),'');

  if v_address is not null then
    select l.gps_lat,l.gps_lng
    into v_existing_gps_lat,v_existing_gps_lng
    from public.transport_client_locations l
    where l.client_id=v_client_id
      and l.address_key=public.normalize_transport_address_key(v_address)
    limit 1;
    v_existing_location:=found;

    if v_existing_location then
      if not v_gps_explicit then
        v_location_gps_lat:=coalesce(v_existing_gps_lat,v_location_gps_lat);
        v_location_gps_lng:=coalesce(v_existing_gps_lng,v_location_gps_lng);
      end if;
    elsif not v_client_was_new
      and public.normalize_transport_address_key(v_address)
        <> public.normalize_transport_address_key(v_master_address)
      and v_location_gps_lat is not null
      and v_location_gps_lng is not null
      and v_master_gps_lat is not null
      and v_master_gps_lng is not null
      and v_location_gps_lat=v_master_gps_lat
      and v_location_gps_lng=v_master_gps_lng
      and not v_gps_explicit
    then
      v_location_gps_lat:=null;
      v_location_gps_lng:=null;
    end if;

    insert into public.transport_client_locations(
      client_id,address,gps_lat,gps_lng,source_order_id,last_used_at,is_active
    ) values (
      v_client_id,v_address,v_location_gps_lat,v_location_gps_lng,null,now(),true
    )
    on conflict (client_id,address_key) do update
    set gps_lat=case
          when v_gps_explicit then coalesce(excluded.gps_lat,transport_client_locations.gps_lat)
          else coalesce(transport_client_locations.gps_lat,excluded.gps_lat)
        end,
        gps_lng=case
          when v_gps_explicit then coalesce(excluded.gps_lng,transport_client_locations.gps_lng)
          else coalesce(transport_client_locations.gps_lng,excluded.gps_lng)
        end,
        last_used_at=now(),
        is_active=true;

    select l.gps_lat,l.gps_lng
    into v_location_gps_lat,v_location_gps_lng
    from public.transport_client_locations l
    where l.client_id=v_client_id
      and l.address_key=public.normalize_transport_address_key(v_address)
    limit 1;
  end if;

  v_data:=(coalesce(p_data,'{}'::jsonb)-'location_gps_explicit')
    || jsonb_build_object(
      'client_id',v_client_id::text,
      'code_str',v_order_code,
      'code',v_order_code,
      'order_code',v_order_code,
      'official_order_code',v_order_code,
      'order_tcode',v_order_code,
      'client_tcode',v_client_tcode,
      'transport_client_tcode',v_client_tcode,
      'order_id',p_id::text,
      'public_order_id',p_id::text,
      'tcode_allocation',case
        when v_allocated_in_transaction then 'ATOMIC_CREATE'
        when v_client_was_new then 'SUPPLIED_CODE'
        else 'EXISTING_CLIENT'
      end
    )
    || case
      when v_supplied_code is not null and v_supplied_code<>v_client_tcode
        then jsonb_build_object('superseded_reserved_tcode',v_supplied_code)
      else '{}'::jsonb
    end
    || case when v_address is not null then jsonb_build_object('address',v_address) else '{}'::jsonb end
    || jsonb_build_object('gps_lat',v_location_gps_lat,'gps_lng',v_location_gps_lng)
    || jsonb_build_object(
      'client',
      coalesce(p_data->'client','{}'::jsonb)
        || jsonb_build_object(
          'id',v_client_id::text,
          'tcode',v_client_tcode,
          'code_str',v_order_code,
          'code',v_client_tcode,
          'order_code',v_order_code,
          'official_order_code',v_order_code,
          'order_tcode',v_order_code,
          'client_tcode',v_client_tcode,
          'transport_client_tcode',v_client_tcode
        )
        || case when v_address is not null then jsonb_build_object('address',v_address) else '{}'::jsonb end
        || jsonb_build_object('gps',jsonb_build_object('lat',v_location_gps_lat,'lng',v_location_gps_lng))
    );

  insert into public.transport_orders(
    id,code_n,code_str,client_tcode,client_id,client_name,client_phone,
    transport_create_fingerprint_v1,data,status
  ) values (
    p_id,
    regexp_replace(v_order_code,'\D','','g')::bigint,
    v_order_code,
    v_client_tcode,
    v_client_id,
    p_client_name,
    p_client_phone,
    v_request_fingerprint,
    v_data,
    coalesce(nullif(p_status,''),'pickup')
  ) returning * into v_order;

  if v_address is not null then
    update public.transport_client_locations
    set source_order_id=p_id,last_used_at=now(),is_active=true
    where client_id=v_client_id
      and address_key=public.normalize_transport_address_key(v_address);
  end if;

  if v_supplied_code is not null and v_supplied_code<>v_client_tcode then
    v_superseded_code_released:=public.release_transport_code_if_unused(v_supplied_code,v_owner);
  end if;

  return jsonb_build_object(
    'success',true,
    'order_id',v_order.id,
    'client_id',v_order.client_id,
    'code_str',v_order.code_str,
    'client_tcode',v_order.client_tcode,
    'visit_nr',v_order.visit_nr,
    'idempotent',false,
    'allocated_in_transaction',v_allocated_in_transaction,
    'superseded_code_released',v_superseded_code_released
  );
end;
$$;

-- Function execution is explicit. The create RPC stays SECURITY INVOKER, so it
-- does not gain privileges beyond the caller's existing table/RLS permissions.
revoke all on function public.create_transport_order(uuid,bigint,text,text,text,text,text,text,jsonb,text) from public;
grant execute on function public.create_transport_order(uuid,bigint,text,text,text,text,text,text,jsonb,text) to anon,authenticated,service_role;

revoke all on function public.reserve_transport_codes_batch(text,integer) from public;
grant execute on function public.reserve_transport_codes_batch(text,integer) to anon,authenticated,service_role;

revoke all on function public.release_transport_code_if_unused(text,text) from public;
grant execute on function public.release_transport_code_if_unused(text,text) to anon,authenticated,service_role;

notify pgrst,'reload schema';

commit;
