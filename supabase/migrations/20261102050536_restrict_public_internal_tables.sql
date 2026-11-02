-- These six tables can be hardened without deploying a new application reader.
-- The tables were reported by Security Advisor as rls_disabled_in_public.
-- No business rows, allocator functions, or existing service_role grants change.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

do $$
begin
  if exists (
    select 1 from pg_policies where schemaname = 'public'
      and tablename in ('transport_keep_one','app_meta','transport_client_debts',
        'app_runtime_switches','system_counters','tepiha_counters')
  ) then raise exception 'Unexpected policy drift: review before applying'; end if;
end $$;

alter table public.transport_keep_one enable row level security;
alter table public.app_meta enable row level security;
alter table public.transport_client_debts enable row level security;
alter table public.app_runtime_switches enable row level security;
alter table public.system_counters enable row level security;
alter table public.tepiha_counters enable row level security;

revoke all on table public.transport_keep_one, public.app_meta,
  public.transport_client_debts, public.app_runtime_switches,
  public.system_counters, public.tepiha_counters
  from public, anon, authenticated;

-- Table-level REVOKE does not remove a pre-existing column ACL.
do $$
declare target record;
begin
  for target in
    select c.relname, string_agg(quote_ident(a.attname), ', ' order by a.attnum) as columns
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    join pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped
    where n.nspname='public' and c.relname in
      ('transport_keep_one','app_meta','transport_client_debts','app_runtime_switches',
       'system_counters','tepiha_counters')
    group by c.relname
  loop
    execute format('revoke all (%s) on public.%I from public, anon, authenticated', target.columns, target.relname);
  end loop;
end $$;

-- Pranimi only needs this non-sensitive cache epoch. Do not expose value/notes,
-- other metadata keys, or any write privileges to browser roles.
grant select (key, db_epoch) on public.app_meta to anon, authenticated;
create policy app_meta_global_epoch_read on public.app_meta
  for select to anon, authenticated using (key = 'global');

commit;
