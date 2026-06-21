-- PRANIMI BASE CODE HARDENING — 2026-06-20
-- Safe to run more than once.
-- 1) standardizes lease columns used by the active Vite runtime
-- 2) releases expired reservations
-- 3) auto-mints numeric codes when the pool is empty
-- 4) reserves a batch atomically under a DB advisory lock

begin;

alter table public.base_code_pool
  add column if not exists reserved_by text,
  add column if not exists reserved_at timestamptz,
  add column if not exists lease_expires_at timestamptz;

create unique index if not exists base_code_pool_code_uidx
  on public.base_code_pool (code);

create or replace function public.release_expired_base_reservations()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  changed integer := 0;
begin
  update public.base_code_pool
  set status = 'available',
      reserved_by = null,
      reserved_at = null,
      lease_expires_at = null
  where status = 'reserved'
    and lease_expires_at is not null
    and lease_expires_at < now();

  get diagnostics changed = row_count;
  return changed;
end;
$$;

create or replace function public.reserve_base_codes_batch(
  p_pin text,
  p_n integer default 20,
  p_lease_minutes integer default 180
)
returns table(code bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  wanted integer := greatest(0, least(coalesce(p_n, 20), 100));
  lease_minutes integer := greatest(1, least(coalesce(p_lease_minutes, 180), 10080));
  available_count integer := 0;
  missing_count integer := 0;
  max_known_code bigint := 0;
  clean_pin text := regexp_replace(coalesce(p_pin, ''), '[^0-9]', '', 'g');
  pin_is_valid boolean := false;
  has_is_active boolean := false;
begin
  if clean_pin is null or length(clean_pin) < 3 or length(clean_pin) > 12 then
    raise exception 'PIN_REQUIRED' using errcode = '22023';
  end if;

  -- The application has two compatible worker-table names across deployments.
  -- Validate either one without making this migration fail when one table or its
  -- optional `is_active` column is absent.
  if to_regclass('public.users') is not null then
    select exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'users' and column_name = 'is_active'
    ) into has_is_active;

    if has_is_active then
      execute 'select exists (select 1 from public.users where pin::text = $1 and coalesce(is_active, true) = true)'
        into pin_is_valid using clean_pin;
    else
      execute 'select exists (select 1 from public.users where pin::text = $1)'
        into pin_is_valid using clean_pin;
    end if;
  end if;

  if not pin_is_valid and to_regclass('public.tepiha_users') is not null then
    select exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'tepiha_users' and column_name = 'is_active'
    ) into has_is_active;

    if has_is_active then
      execute 'select exists (select 1 from public.tepiha_users where pin::text = $1 and coalesce(is_active, true) = true)'
        into pin_is_valid using clean_pin;
    else
      execute 'select exists (select 1 from public.tepiha_users where pin::text = $1)'
        into pin_is_valid using clean_pin;
    end if;
  end if;

  if not pin_is_valid then
    raise exception 'PIN_NOT_FOUND_OR_DISABLED' using errcode = '28000';
  end if;

  if wanted = 0 then
    return;
  end if;

  perform pg_advisory_xact_lock(hashtext('tepiha_base_code_pool_allocator_v2'));
  perform public.release_expired_base_reservations();

  select count(*)::integer
    into available_count
  from public.base_code_pool
  where status = 'available';

  missing_count := greatest(0, wanted - available_count);

  if missing_count > 0 then
    select greatest(
      coalesce((
        select max(case
          when b.code::text ~ '^[0-9]{1,6}$'
           and lpad(b.code::text, 6, '0') < '900000'
          then b.code::text::bigint
        end)
        from public.base_code_pool b
        where b.code is not null
      ), 0),
      coalesce((
        select max(case
          when o.code::text ~ '^[0-9]{1,6}$'
           and lpad(o.code::text, 6, '0') < '900000'
          then o.code::text::bigint
        end)
        from public.orders o
        where o.code is not null
      ), 0),
      coalesce((
        select max(case
          when c.code::text ~ '^[0-9]{1,6}$'
           and lpad(c.code::text, 6, '0') < '900000'
          then c.code::text::bigint
        end)
        from public.clients c
        where c.code is not null
      ), 0)
    ) into max_known_code;

    insert into public.base_code_pool (code, status, reserved_by, reserved_at, lease_expires_at)
    select max_known_code + gs, 'available', null, null, null
    from generate_series(1, missing_count + 20) as gs
    on conflict (code) do nothing;
  end if;

  return query
  with picked as (
    select b.code
    from public.base_code_pool b
    where b.status = 'available'
    order by b.code asc
    limit wanted
    for update skip locked
  )
  update public.base_code_pool b
  set status = 'reserved',
      reserved_by = clean_pin,
      reserved_at = now(),
      lease_expires_at = now() + make_interval(mins => lease_minutes)
  from picked
  where b.code = picked.code
    and b.status = 'available'
  returning b.code::bigint;
end;
$$;

create or replace function public.reserve_base_codes_batch_simple(
  p_pin text,
  p_count integer default 20
)
returns table(code bigint)
language sql
security definer
set search_path = public
as $$
  select * from public.reserve_base_codes_batch(p_pin, p_count, 180);
$$;

grant execute on function public.release_expired_base_reservations() to anon, authenticated, service_role;
grant execute on function public.reserve_base_codes_batch(text, integer, integer) to anon, authenticated, service_role;
grant execute on function public.reserve_base_codes_batch_simple(text, integer) to anon, authenticated, service_role;

commit;
