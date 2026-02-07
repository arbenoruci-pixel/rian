-- BASE CODE POOL (numeric) — like TRANSPORT pool
-- Creates a global sequence + pool table and RPCs:
--   reserve_base_code(p_reserved_by text) -> {new_code int}
--   reserve_base_codes_batch(p_reserved_by text, p_count int) -> setof {code int}
--   mark_base_code_used(p_code int, p_used_by text) -> void
--
-- NOTE: This does NOT delete any orders. It only manages code reservation/usage.

create table if not exists public.base_code_pool (
  code int primary key,
  reserved_by text,
  reserved_at timestamptz default now(),
  used_by text,
  used_at timestamptz
);

do $$
begin
  if not exists (select 1 from pg_class where relname = 'base_code_seq') then
    create sequence public.base_code_seq start 1 increment 1;
  end if;
end $$;

create or replace function public.reserve_base_code(p_reserved_by text)
returns json
language plpgsql
security definer
as $$
declare
  v_code int;
begin
  p_reserved_by := coalesce(nullif(trim(p_reserved_by), ''), 'APP');

  v_code := nextval('public.base_code_seq');

  insert into public.base_code_pool(code, reserved_by, reserved_at)
  values (v_code, p_reserved_by, now())
  on conflict (code) do update
    set reserved_by = excluded.reserved_by,
        reserved_at = excluded.reserved_at;

  return json_build_object('new_code', v_code);
end;
$$;

create or replace function public.reserve_base_codes_batch(p_reserved_by text, p_count int)
returns table(code int)
language plpgsql
security definer
as $$
declare
  i int;
  v_code int;
begin
  p_reserved_by := coalesce(nullif(trim(p_reserved_by), ''), 'APP');
  p_count := greatest(1, least(coalesce(p_count, 50), 500));

  for i in 1..p_count loop
    v_code := nextval('public.base_code_seq');

    insert into public.base_code_pool(code, reserved_by, reserved_at)
    values (v_code, p_reserved_by, now())
    on conflict (code) do nothing;

    code := v_code;
    return next;
  end loop;
end;
$$;

create or replace function public.mark_base_code_used(p_code int, p_used_by text)
returns void
language plpgsql
security definer
as $$
begin
  if p_code is null or p_code <= 0 then return; end if;
  p_used_by := coalesce(nullif(trim(p_used_by), ''), 'APP');

  update public.base_code_pool
    set used_by = p_used_by,
        used_at = now()
    where code = p_code;

  -- If code wasn't reserved (edge case), still record it
  insert into public.base_code_pool(code, reserved_by, reserved_at, used_by, used_at)
  values (p_code, p_used_by, now(), p_used_by, now())
  on conflict (code) do update
    set used_by = excluded.used_by,
        used_at = excluded.used_at;
end;
$$;

-- Permissions: grant execute for anon/authenticated (adjust if you use RLS)
grant execute on function public.reserve_base_code(text) to anon, authenticated;
grant execute on function public.reserve_base_codes_batch(text,int) to anon, authenticated;
grant execute on function public.mark_base_code_used(int,text) to anon, authenticated;

-- Optional: allow select for debugging
grant select on public.base_code_pool to anon, authenticated;
