-- Read-only post-deployment inspection. No PINs, lease tokens or customer data.
select jsonb_build_object(
  'rls_enabled',(select relrowsecurity from pg_class where oid='public.base_code_pool'::regclass),
  'force_rls',(select relforcerowsecurity from pg_class where oid='public.base_code_pool'::regclass),
  'policy_count',(select count(*) from pg_policies where schemaname='public' and tablename='base_code_pool'),
  'browser_table_privileges',(select jsonb_agg(to_jsonb(x)) from (
    select role_name,privilege_name,has_table_privilege(role_name,'public.base_code_pool',privilege_name) as allowed
    from unnest(array['anon','authenticated']) as r(role_name)
    cross join unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']) as p(privilege_name)
  ) x),
  'public_grants',(select count(*) from pg_class c cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
    where c.oid='public.base_code_pool'::regclass and a.grantee=0),
  'server_select',has_table_privilege('service_role','public.base_code_pool','SELECT'),
  'server_bypass_rls',(select rolbypassrls from pg_roles where rolname='service_role'),
  'preserved_rpc_access',(select jsonb_agg(to_jsonb(x) order by x.routine) from (
    select p.proname as routine,p.prosecdef as security_definer,
      has_function_privilege('anon',p.oid,'EXECUTE') as anon_execute,
      has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated_execute
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.prokind='f' and p.proname=any(array[
      'get_or_assign_pranimi_code','verify_pranimi_code_assignment','renew_pranimi_code_assignment',
      'mark_base_code_used_after_verify','release_pranimi_code_assignment',
      'release_pranimi_temp_code_after_existing_client_save','reserve_base_offline_codes',
      'bind_base_offline_code_to_draft','finalize_base_offline_code'
    ])
  ) x),
  'pool_rows',(select count(*) from public.base_code_pool),
  'pool_status_counts',(select jsonb_object_agg(status,row_count) from (select status,count(*) as row_count from public.base_code_pool group by status) c),
  'duplicate_codes',(select count(*)-count(distinct code) from public.base_code_pool)
) as base_code_pool_access_verification;
