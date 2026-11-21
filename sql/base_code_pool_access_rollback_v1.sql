-- Emergency compatibility rollback for base_code_pool_access_apply_v1.sql.
-- Observed pre-change state: RLS=false, FORCE RLS=false; no policies or column
-- grants; ALL table privileges for postgres, anon, authenticated and service_role;
-- no PUBLIC grant. The forward change only alters RLS and anon/auth/PUBLIC grants.
-- Run this database rollback BEFORE rolling the application back to the old build.
-- This temporarily restores the previous public-table exposure. No business row,
-- payment, code assignment, device approval, offline lease or RPC is restored/edited.
-- Apply as one transaction. Review before use after any later permission change.

set local lock_timeout = '5s';
set local statement_timeout = '30s';

alter table public.base_code_pool disable row level security;
grant all privileges on table public.base_code_pool to anon, authenticated;

do $verify$
declare
  browser_role text;
  table_privilege text;
begin
  if (select relrowsecurity from pg_class where oid='public.base_code_pool'::regclass) then
    raise exception 'BASE_POOL_ROLLBACK_VERIFICATION_FAILED';
  end if;
  foreach browser_role in array array['anon','authenticated'] loop
    foreach table_privilege in array array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'] loop
      if not has_table_privilege(browser_role,'public.base_code_pool',table_privilege) then
        raise exception 'BASE_POOL_ROLLBACK_PRIVILEGE_MISSING: % %',browser_role,table_privilege;
      end if;
    end loop;
  end loop;
end;
$verify$;
