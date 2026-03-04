-- TEPIHA: Server-side CODE LEASES (BASE + TRANSPORT)
-- Goal: eliminate iOS "split brain" between Safari and PWA by keeping the active lease on the server.
-- Safe to run multiple times.

-- =====================
-- 1) TABLES
-- =====================

create table if not exists public.base_code_leases (
  id uuid primary key default gen_random_uuid(),
  reserved_by text not null,
  code integer not null,
  expires_at timestamptz not null,
  used_at timestamptz null,
  created_at timestamptz not null default now()
);

create index if not exists base_code_leases_reserved_by_idx
  on public.base_code_leases (reserved_by);

create index if not exists base_code_leases_active_idx
  on public.base_code_leases (reserved_by, expires_at)
  where used_at is null;

-- Only 1 "active" lease per reserved_by (we clean expired leases in the RPC).
create unique index if not exists base_code_leases_one_active_per_user
  on public.base_code_leases (reserved_by)
  where used_at is null;


create table if not exists public.transport_code_leases (
  id uuid primary key default gen_random_uuid(),
  reserved_by text not null,
  code text not null,
  expires_at timestamptz not null,
  used_at timestamptz null,
  created_at timestamptz not null default now()
);

create index if not exists transport_code_leases_reserved_by_idx
  on public.transport_code_leases (reserved_by);

create index if not exists transport_code_leases_active_idx
  on public.transport_code_leases (reserved_by, expires_at)
  where used_at is null;

create unique index if not exists transport_code_leases_one_active_per_user
  on public.transport_code_leases (reserved_by)
  where used_at is null;


-- =====================
-- 2) RPC: GET OR RESERVE LEASE
-- =====================

create or replace function public.get_or_reserve_base_code_lease(p_reserved_by text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code integer;
begin
  -- cleanup expired (keep history rows for audit)
  update public.base_code_leases
     set used_at = coalesce(used_at, now())
   where reserved_by = p_reserved_by
     and used_at is null
     and expires_at < now();

  select code into v_code
    from public.base_code_leases
   where reserved_by = p_reserved_by
     and used_at is null
     and expires_at >= now()
   order by expires_at desc
   limit 1;

  if v_code is not null then
    return v_code;
  end if;

  -- reserve new base code (existing RPC)
  select public.reserve_base_code(p_reserved_by) into v_code;

  insert into public.base_code_leases(reserved_by, code, expires_at)
  values (p_reserved_by, v_code, now() + interval '2 hours')
  on conflict (reserved_by) where used_at is null
  do update set
    code = excluded.code,
    expires_at = excluded.expires_at,
    used_at = null;

  return v_code;
end;
$$;


create or replace function public.get_or_reserve_transport_code_lease(p_reserved_by text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text;
  v_out json;
begin
  update public.transport_code_leases
     set used_at = coalesce(used_at, now())
   where reserved_by = p_reserved_by
     and used_at is null
     and expires_at < now();

  select code into v_code
    from public.transport_code_leases
   where reserved_by = p_reserved_by
     and used_at is null
     and expires_at >= now()
   order by expires_at desc
   limit 1;

  if v_code is not null then
    return v_code;
  end if;

  -- reserve new transport code (existing RPC can return text or json)
  begin
    select public.reserve_transport_code(p_reserved_by) into v_code;
  exception when undefined_function then
    -- some deployments return json {new_code: 'T123'}
    select public.reserve_transport_code(p_reserved_by) into v_out;
    v_code := coalesce(v_out->>'new_code', v_out->>'code');
  end;

  if v_code is null or length(trim(v_code)) = 0 then
    raise exception 'No transport code returned by reserve_transport_code()';
  end if;

  insert into public.transport_code_leases(reserved_by, code, expires_at)
  values (p_reserved_by, v_code, now() + interval '2 hours')
  on conflict (reserved_by) where used_at is null
  do update set
    code = excluded.code,
    expires_at = excluded.expires_at,
    used_at = null;

  return v_code;
end;
$$;


-- =====================
-- 3) RPC: CLOSE LEASE (after meaningful save)
-- =====================

create or replace function public.close_base_code_lease(p_reserved_by text, p_code integer)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.base_code_leases
     set used_at = now()
   where reserved_by = p_reserved_by
     and code = p_code
     and used_at is null;
end;
$$;

create or replace function public.close_transport_code_lease(p_reserved_by text, p_code text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.transport_code_leases
     set used_at = now()
   where reserved_by = p_reserved_by
     and code = p_code
     and used_at is null;
end;
$$;


-- =====================
-- 4) GRANTS
-- =====================

grant usage on schema public to anon, authenticated;
grant select, insert, update on public.base_code_leases to anon, authenticated;
grant select, insert, update on public.transport_code_leases to anon, authenticated;

grant execute on function public.get_or_reserve_base_code_lease(text) to anon, authenticated;
grant execute on function public.get_or_reserve_transport_code_lease(text) to anon, authenticated;
grant execute on function public.close_base_code_lease(text, integer) to anon, authenticated;
grant execute on function public.close_transport_code_lease(text, text) to anon, authenticated;
