-- FIX: reserve_base_codes_batch must use base_code_pool.code (no b.id column)
-- Replace the broken function that references b.id.

create or replace function public.reserve_base_codes_batch(
  p_pin text,
  p_n integer default 20,
  p_lease_minutes integer default 180
)
returns table(code bigint)
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  -- optional: release expired reservations if you have this helper
  begin
    perform public.release_expired_base_reservations();
  exception when undefined_function then
    -- ignore
    null;
  end;

  return query
  with picked as (
    select b.code
    from public.base_code_pool b
    where b.status = 'available'
    order by b.code asc
    limit greatest(coalesce(p_n,20),0)
    for update skip locked
  )
  update public.base_code_pool b
  set
    status = 'reserved',
    reserved_by = p_pin,
    reserved_at = now(),
    lease_expires_at = now() + make_interval(mins => greatest(coalesce(p_lease_minutes,180),1))
  from picked
  where b.code = picked.code
  returning b.code::bigint;

end;
$$;
