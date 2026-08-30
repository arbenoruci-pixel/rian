-- Atomic, audited edits for an existing BASE client selected in PRANIMI.
-- The browser never calls this function directly: the device-authenticated
-- /api/client-profile route invokes it with the service role.

create table if not exists public.base_client_profile_update_audit (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete restrict,
  client_code text not null,
  actor_user_id uuid not null references public.users(id) on delete restrict,
  actor_name text,
  actor_role text,
  idempotency_key text not null unique,
  expected_updated_at timestamptz not null,
  request_payload jsonb not null,
  changed_fields text[] not null default '{}'::text[],
  before_profile jsonb not null,
  after_profile jsonb not null,
  created_at timestamptz not null default now(),
  constraint base_client_profile_audit_idempotency_key_ck
    check (length(btrim(idempotency_key)) between 1 and 240),
  constraint base_client_profile_audit_request_object_ck
    check (jsonb_typeof(request_payload) = 'object'),
  constraint base_client_profile_audit_before_object_ck
    check (jsonb_typeof(before_profile) = 'object'),
  constraint base_client_profile_audit_after_object_ck
    check (jsonb_typeof(after_profile) = 'object')
);

create index if not exists idx_base_client_profile_audit_client_created
  on public.base_client_profile_update_audit(client_id, created_at desc);
create index if not exists idx_base_client_profile_audit_actor_created
  on public.base_client_profile_update_audit(actor_user_id, created_at desc);

alter table public.base_client_profile_update_audit enable row level security;

revoke all on table public.base_client_profile_update_audit
  from public, anon, authenticated, service_role;
grant select on table public.base_client_profile_update_audit to service_role;

create or replace function public.update_base_client_profile_v1(
  p_client_id uuid,
  p_expected_code bigint,
  p_expected_updated_at timestamptz,
  p_new_name text,
  p_new_canonical_phone text,
  p_photo_url text,
  p_actor_user_id uuid,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_client public.clients%rowtype;
  v_after public.clients%rowtype;
  v_actor public.users%rowtype;
  v_existing_audit public.base_client_profile_update_audit%rowtype;
  v_audit_id uuid;
  v_name text := regexp_replace(btrim(coalesce(p_new_name, '')), '\s+', ' ', 'g');
  v_name_parts text[];
  v_first_name text;
  v_last_name text;
  v_phone_key text := public.normalize_kosovo_phone_v1(p_new_canonical_phone);
  v_phone_local_key text;
  v_canonical_phone text;
  v_old_phone_key text;
  v_old_phone_local_key text;
  v_photo_url text;
  v_idempotency_key text := btrim(coalesce(p_idempotency_key, ''));
  v_request jsonb;
  v_before_json jsonb;
  v_after_json jsonb;
  v_changed_fields text[] := '{}'::text[];
  v_now timestamptz := clock_timestamp();
begin
  if p_client_id is null then
    raise exception 'BASE_CLIENT_ID_REQUIRED';
  end if;
  if p_expected_code is null or p_expected_code <= 0 then
    raise exception 'BASE_CLIENT_EXPECTED_CODE_REQUIRED';
  end if;
  if p_expected_updated_at is null then
    raise exception 'BASE_CLIENT_EXPECTED_UPDATED_AT_REQUIRED';
  end if;
  if p_actor_user_id is null then
    raise exception 'BASE_CLIENT_ACTOR_REQUIRED';
  end if;
  if v_idempotency_key = '' then
    raise exception 'BASE_CLIENT_IDEMPOTENCY_KEY_REQUIRED';
  end if;
  if length(v_idempotency_key) > 240 then
    raise exception 'BASE_CLIENT_IDEMPOTENCY_KEY_TOO_LONG';
  end if;

  if p_new_name is null or v_name = '' then
    raise exception 'BASE_CLIENT_NAME_REQUIRED';
  end if;
  if length(v_name) > 180 then
    raise exception 'BASE_CLIENT_NAME_TOO_LONG';
  end if;
  if p_new_name ~ '[[:cntrl:]]' then
    raise exception 'BASE_CLIENT_NAME_INVALID';
  end if;

  -- NULL means "preserve the existing no-phone/placeholder identity". An
  -- explicitly supplied value must be a real canonical Kosovo phone.
  if p_new_canonical_phone is not null then
    if btrim(p_new_canonical_phone) = ''
       or v_phone_key is null
       or v_phone_key !~ '^383[0-9]{8}$' then
      raise exception 'BASE_CLIENT_PHONE_INVALID';
    end if;
    v_phone_local_key := right(v_phone_key, 8);
    v_canonical_phone := '+' || v_phone_key;
  end if;

  if p_photo_url is null then
    v_photo_url := null;
  else
    v_photo_url := btrim(p_photo_url);
    if length(v_photo_url) > 4000 then
      raise exception 'BASE_CLIENT_PHOTO_URL_TOO_LONG';
    end if;
    if v_photo_url ~ '[[:cntrl:]]'
       or (v_photo_url <> '' and v_photo_url !~* '^https?://[^[:space:]]+$') then
      raise exception 'BASE_CLIENT_PHOTO_URL_INVALID';
    end if;
    v_photo_url := nullif(v_photo_url, '');
  end if;

  v_name_parts := regexp_split_to_array(v_name, '\s+');
  if cardinality(v_name_parts) <= 1 then
    v_first_name := v_name;
    v_last_name := '';
  else
    v_first_name := array_to_string(v_name_parts[1:cardinality(v_name_parts) - 1], ' ');
    v_last_name := v_name_parts[cardinality(v_name_parts)];
  end if;

  v_request := jsonb_build_object(
    'clientId', p_client_id,
    'expectedCode', p_expected_code,
    'expectedUpdatedAt', p_expected_updated_at,
    'name', v_name,
    'newCanonicalPhone', v_canonical_phone,
    'photoUrl', v_photo_url
  );

  -- Serialize retries before inspecting the audit record. A committed retry
  -- returns the original result even though clients.updated_at has advanced.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('base-client-profile-update:' || v_idempotency_key, 0)
  );

  select * into v_existing_audit
  from public.base_client_profile_update_audit
  where idempotency_key = v_idempotency_key
  limit 1;

  if found then
    if v_existing_audit.request_payload is distinct from v_request then
      raise exception 'BASE_CLIENT_PROFILE_IDEMPOTENCY_CONFLICT';
    end if;
    return jsonb_build_object(
      'ok', true,
      'idempotent', true,
      'idempotency_key', v_idempotency_key,
      'audit_id', v_existing_audit.id,
      'changed_fields', to_jsonb(v_existing_audit.changed_fields),
      'client', v_existing_audit.after_profile
    );
  end if;

  select * into v_actor
  from public.users
  where id = p_actor_user_id
    and is_active is true
  limit 1;
  if not found then
    raise exception 'BASE_CLIENT_ACTOR_INVALID_OR_DISABLED';
  end if;

  -- Exact UUID is the authority. Code and updated_at are independent stale/
  -- identity guards and are never changed by this function.
  select * into v_client
  from public.clients
  where id = p_client_id
  for update;
  if not found then
    raise exception 'BASE_CLIENT_NOT_FOUND';
  end if;
  if v_client.code::text !~ '^[0-9]+$'
     or v_client.code::text::numeric is distinct from p_expected_code::numeric then
    raise exception 'BASE_CLIENT_CODE_MISMATCH';
  end if;
  if v_client.updated_at is distinct from p_expected_updated_at then
    raise exception 'BASE_CLIENT_PROFILE_STALE_UPDATED_AT';
  end if;

  v_old_phone_key := public.normalize_kosovo_phone_v1(v_client.phone);
  v_old_phone_local_key := case
    when v_old_phone_key is null then null
    else right(v_old_phone_key, 8)
  end;

  if p_new_canonical_phone is null then
    v_phone_key := v_client.phone_digits;
    v_phone_local_key := v_old_phone_local_key;
    v_canonical_phone := v_client.phone;
  end if;

  -- The normalized phone is a cross-module financial identity. Fail closed
  -- when changing it could orphan balances, TRANSPORT identity, or legacy
  -- unlinked history. A manager can repair those links explicitly first.
  if p_new_canonical_phone is not null
     and v_old_phone_key is distinct from v_phone_key then
    if exists (
      select 1
      from public.clients c
      where c.id <> p_client_id
        and public.normalize_kosovo_phone_v1(
          coalesce(nullif(btrim(c.phone_digits), ''), c.phone)
        ) = v_phone_key
    ) then
      raise exception 'BASE_CLIENT_PHONE_CONFLICT';
    end if;

    if exists (
      select 1
      from public.client_balances b
      where public.normalize_kosovo_phone_v1(b.phone) = v_phone_key
         or (
           v_old_phone_key is not null
           and public.normalize_kosovo_phone_v1(b.phone) = v_old_phone_key
         )
    ) then
      raise exception 'BASE_CLIENT_PHONE_FINANCIAL_LINK_CONFLICT';
    end if;

    if exists (
      select 1
      from public.transport_clients tc
      where public.normalize_transport_phone_key(
        coalesce(nullif(btrim(tc.phone_digits), ''), tc.phone, '')
      ) = v_phone_local_key
         or (
           v_old_phone_local_key is not null
           and public.normalize_transport_phone_key(
             coalesce(nullif(btrim(tc.phone_digits), ''), tc.phone, '')
           ) = v_old_phone_local_key
         )
    ) then
      raise exception 'BASE_CLIENT_PHONE_TRANSPORT_LINK_CONFLICT';
    end if;

    if exists (
      select 1
      from public.orders o
      where o.client_id is null
        and (
          public.normalize_kosovo_phone_v1(o.client_phone) = v_phone_key
          or (
            v_old_phone_key is not null
            and public.normalize_kosovo_phone_v1(o.client_phone) = v_old_phone_key
          )
        )
    ) then
      raise exception 'BASE_CLIENT_PHONE_UNLINKED_BASE_HISTORY_CONFLICT';
    end if;

    if exists (
      select 1
      from public.transport_orders transport_order
      where transport_order.client_id is null
        and (
          public.normalize_transport_phone_key(
            coalesce(transport_order.client_phone, '')
          ) = v_phone_local_key
          or (
            v_old_phone_local_key is not null
            and public.normalize_transport_phone_key(
              coalesce(transport_order.client_phone, '')
            ) = v_old_phone_local_key
          )
        )
    ) then
      raise exception 'BASE_CLIENT_PHONE_UNLINKED_TRANSPORT_HISTORY_CONFLICT';
    end if;
  end if;

  v_before_json := jsonb_build_object(
    'id', v_client.id,
    'code', v_client.code,
    'name', coalesce(v_client.name, v_client.full_name),
    'full_name', v_client.full_name,
    'first_name', v_client.first_name,
    'last_name', v_client.last_name,
    'phone', v_client.phone,
    'phone_digits', v_client.phone_digits,
    'photo_url', v_client.photo_url,
    'updated_at', v_client.updated_at
  );

  if v_client.name is distinct from v_name
     or v_client.full_name is distinct from v_name
     or v_client.first_name is distinct from v_first_name
     or v_client.last_name is distinct from v_last_name then
    v_changed_fields := array_append(v_changed_fields, 'name');
  end if;
  if v_client.phone is distinct from v_canonical_phone
     or v_client.phone_digits is distinct from v_phone_key then
    v_changed_fields := array_append(v_changed_fields, 'phone');
  end if;
  if p_photo_url is not null and v_client.photo_url is distinct from v_photo_url then
    v_changed_fields := array_append(v_changed_fields, 'photo_url');
  end if;

  if cardinality(v_changed_fields) > 0 then
    -- The pre-existing guard intentionally blocks a simultaneous name + phone
    -- rewrite. This tightly scoped service-only RPC performs that exact repair
    -- atomically after exact-id, stale, collision, and linkage validation.
    perform pg_catalog.set_config('tepiha.client_identity_repair', 'on', true);
    begin
      update public.clients
      set name = v_name,
          full_name = v_name,
          first_name = v_first_name,
          last_name = v_last_name,
          phone = v_canonical_phone,
          photo_url = case
            when p_photo_url is null then photo_url
            else v_photo_url
          end,
          updated_at = v_now
      where id = p_client_id
      returning * into v_after;
    exception
      when unique_violation then
        raise exception 'BASE_CLIENT_PHONE_CONFLICT';
    end;
  else
    v_after := v_client;
  end if;

  if v_after.id is distinct from p_client_id
     or v_after.code is distinct from v_client.code then
    raise exception 'BASE_CLIENT_CODE_IMMUTABILITY_FAILED';
  end if;

  v_after_json := jsonb_build_object(
    'id', v_after.id,
    'code', v_after.code,
    'name', coalesce(v_after.name, v_after.full_name),
    'full_name', v_after.full_name,
    'first_name', v_after.first_name,
    'last_name', v_after.last_name,
    'phone', v_after.phone,
    'phone_digits', v_after.phone_digits,
    'photo_url', v_after.photo_url,
    'updated_at', v_after.updated_at
  );

  insert into public.base_client_profile_update_audit (
    client_id,
    client_code,
    actor_user_id,
    actor_name,
    actor_role,
    idempotency_key,
    expected_updated_at,
    request_payload,
    changed_fields,
    before_profile,
    after_profile
  ) values (
    v_client.id,
    v_client.code,
    v_actor.id,
    v_actor.name,
    v_actor.role,
    v_idempotency_key,
    p_expected_updated_at,
    v_request,
    v_changed_fields,
    v_before_json,
    v_after_json
  )
  returning id into v_audit_id;

  return jsonb_build_object(
    'ok', true,
    'idempotent', false,
    'idempotency_key', v_idempotency_key,
    'audit_id', v_audit_id,
    'changed_fields', to_jsonb(v_changed_fields),
    'client', v_after_json
  );
end;
$$;

revoke all on function public.update_base_client_profile_v1(
  uuid, bigint, timestamptz, text, text, text, uuid, text
) from public, anon, authenticated, service_role;
grant execute on function public.update_base_client_profile_v1(
  uuid, bigint, timestamptz, text, text, text, uuid, text
) to service_role;
