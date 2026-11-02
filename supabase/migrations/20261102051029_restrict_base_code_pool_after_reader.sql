-- Apply only after the approved-device /api/base-code-status reader is deployed.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
do $$
declare columns text;
begin
  if exists(select 1 from pg_policies where schemaname='public' and tablename='base_code_pool') then
    raise exception 'Unexpected base_code_pool policy drift: review before applying';
  end if;
  select string_agg(quote_ident(attname), ', ' order by attnum) into columns
  from pg_attribute where attrelid='public.base_code_pool'::regclass and attnum>0 and not attisdropped;
  execute format('revoke all (%s) on public.base_code_pool from public, anon, authenticated', columns);
end $$;
alter table public.base_code_pool enable row level security;
revoke all on table public.base_code_pool from public, anon, authenticated;
commit;
