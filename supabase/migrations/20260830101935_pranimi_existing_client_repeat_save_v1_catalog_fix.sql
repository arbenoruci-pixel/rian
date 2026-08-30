-- Forward-only repair for the trigger function applied immediately before this
-- migration. COALESCE is SQL syntax and cannot be schema-qualified.

create or replace function public.prevent_code_reuse_different_client()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_code text := nullif(pg_catalog.btrim(coalesce(new.code::text, '')), '');
  v_name text := public.norm_client_name(new.client_name);
  v_phone_key text := public.normalize_kosovo_phone_v1(new.client_phone);
  v_client_id uuid := new.client_id;
  v_payload_client_id text;
  v_code_owner public.clients%rowtype;
  v_code_owner_found boolean := false;
  v_incoming_client public.clients%rowtype;
  v_incoming_client_found boolean := false;
  v_owner_phone_key text;
  v_conflict public.orders%rowtype;
begin
  if coalesce(pg_catalog.current_setting('tepiha.client_identity_repair', true), '') = 'on' then
    return new;
  end if;

  if v_code is null then
    return new;
  end if;

  if v_client_id is null then
    v_payload_client_id := nullif(pg_catalog.btrim(coalesce(
      new.data->>'client_id',
      new.data->>'client_master_id',
      new.data#>>'{client,id}',
      new.data#>>'{order,client_id}',
      new.data#>>'{order,client,id}',
      ''
    )), '');
    if v_payload_client_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
      v_client_id := v_payload_client_id::uuid;
    end if;
  end if;

  if v_phone_key is null then
    v_phone_key := public.normalize_kosovo_phone_v1(coalesce(
      new.data->>'client_phone',
      new.data#>>'{client,phone}',
      new.data#>>'{order,client_phone}',
      new.data#>>'{order,client,phone}'
    ));
  end if;

  select c.*
  into v_code_owner
  from public.clients c
  where c.code = v_code
  order by c.created_at, c.id
  limit 1;
  v_code_owner_found := found;

  if v_client_id is not null then
    select c.*
    into v_incoming_client
    from public.clients c
    where c.id = v_client_id
    limit 1;
    v_incoming_client_found := found;

    if v_incoming_client_found
       and nullif(pg_catalog.btrim(coalesce(v_incoming_client.code, '')), '') is distinct from v_code then
      raise exception using
        errcode = '23514',
        message = pg_catalog.format(
          'Kodi %s nuk përputhet me klientin canonical',
          v_code
        );
    end if;
  end if;

  if v_code_owner_found then
    v_owner_phone_key := public.normalize_kosovo_phone_v1(v_code_owner.phone);

    if v_client_id is not null and v_client_id is distinct from v_code_owner.id then
      raise exception using
        errcode = '23514',
        message = pg_catalog.format(
          'Kodi %s tashmë i takon klientit tjetër canonical',
          v_code
        );
    end if;

    if v_client_id is null
       and v_phone_key is not null
       and v_owner_phone_key is not null
       and v_phone_key is distinct from v_owner_phone_key then
      raise exception using
        errcode = '23514',
        message = pg_catalog.format(
          'Kodi %s tashmë është i lidhur me telefon tjetër',
          v_code
        );
    end if;

    if v_client_id is null and v_phone_key is not null and v_phone_key = v_owner_phone_key then
      v_client_id := v_code_owner.id;
    end if;
  end if;

  select o.*
  into v_conflict
  from public.orders o
  where o.code = new.code
    and o.id is distinct from new.id
    and (
      nullif(pg_catalog.btrim(coalesce(new.local_oid, '')), '') is null
      or o.local_oid is distinct from new.local_oid
    )
    and not (
      (v_client_id is not null and o.client_id = v_client_id)
      or (
        v_phone_key is not null
        and (v_client_id is null or o.client_id is null)
        and public.normalize_kosovo_phone_v1(o.client_phone) = v_phone_key
      )
      or (
        v_code_owner_found
        and v_client_id = v_code_owner.id
        and (o.client_id is null or o.client_id = v_code_owner.id)
        and (
          public.normalize_kosovo_phone_v1(o.client_phone) is null
          or public.normalize_kosovo_phone_v1(o.client_phone) = v_owner_phone_key
        )
      )
      or (
        v_client_id is null
        and v_phone_key is null
        and o.client_id is null
        and public.normalize_kosovo_phone_v1(o.client_phone) is null
        and public.norm_client_name(o.client_name) is not distinct from v_name
      )
    )
  limit 1;

  if found then
    raise exception using
      errcode = '23514',
      message = pg_catalog.format(
        'Kodi %s tashmë është i lidhur me klient tjetër: %s',
        v_code,
        coalesce(v_conflict.client_name, 'PA EMËR')
      );
  end if;

  return new;
end;
$$;

comment on function public.prevent_code_reuse_different_client() is
  'Identity-aware BASE permanent-code guard: UUID, then canonical phone, then legacy name fallback.';
