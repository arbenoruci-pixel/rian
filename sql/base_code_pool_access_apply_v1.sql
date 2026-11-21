-- Deploy the approved-device status endpoint and its Pranimi/Pastrimi callers first.
-- Apply as one transaction (the migration runner supplies the transaction).
-- This changes access metadata only. No client, order, code or lease row is changed.
-- Existing PIN-gated allocator/offline RPC contracts and EXECUTE grants stay intact.

set local lock_timeout = '5s';
set local statement_timeout = '30s';

alter table public.base_code_pool enable row level security;
revoke all privileges on table public.base_code_pool from public, anon, authenticated;

do $verify$
declare
  browser_role text;
  table_privilege text;
begin
  if not (select relrowsecurity from pg_class where oid='public.base_code_pool'::regclass) then
    raise exception 'BASE_POOL_RLS_NOT_ENABLED';
  end if;

  foreach browser_role in array array['anon','authenticated'] loop
    foreach table_privilege in array array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'] loop
      if has_table_privilege(browser_role,'public.base_code_pool',table_privilege) then
        raise exception 'BASE_POOL_BROWSER_PRIVILEGE_REMAINS: % %',browser_role,table_privilege;
      end if;
    end loop;
    if has_any_column_privilege(browser_role,'public.base_code_pool','SELECT,INSERT,UPDATE,REFERENCES') then
      raise exception 'BASE_POOL_BROWSER_COLUMN_PRIVILEGE_REMAINS: %',browser_role;
    end if;
  end loop;

  if not has_table_privilege('service_role','public.base_code_pool','SELECT')
     or not (select rolbypassrls from pg_roles where rolname='service_role') then
    raise exception 'BASE_POOL_SERVER_ACCESS_MISSING';
  end if;
end;
$verify$;
