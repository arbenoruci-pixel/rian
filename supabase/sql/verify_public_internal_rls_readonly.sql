-- Safe on production: no DML, no fixture rows, no business function execution.
begin read only;
set local statement_timeout = '15s';
do $$
declare t text; r text; operation text;
begin
  foreach t in array array['transport_keep_one','app_meta','transport_client_debts',
    'app_runtime_switches','system_counters','tepiha_counters','base_code_pool'] loop
    if not (select relrowsecurity from pg_class where oid=format('public.%I',t)::regclass) then
      raise exception 'RLS missing: %',t;
    end if;
    foreach operation in array array['SELECT','INSERT','UPDATE','DELETE'] loop
      if not has_table_privilege('service_role',format('public.%I',t),operation) then
        raise exception 'Service privilege missing: % %',t,operation;
      end if;
    end loop;
    foreach r in array array['anon','authenticated'] loop
      foreach operation in array array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] loop
        if has_table_privilege(r,format('public.%I',t),operation) then
          raise exception 'Unexpected direct table privilege: % % %',r,t,operation;
        end if;
      end loop;
      execute format('set local role %I',r);
      begin
        execute format('select * from public.%I limit 0',t);
        raise exception 'Unrestricted SELECT unexpectedly succeeded: % %',r,t;
      exception when insufficient_privilege then null;
      end;
      if t='app_meta' then
        perform db_epoch from public.app_meta where key='global';
        if exists(select key from public.app_meta where key<>'global') then
          raise exception 'Non-global metadata exposed to %',r;
        end if;
      end if;
      reset role;
    end loop;
  end loop;
  set local role service_role;
  perform 1 from public.base_code_pool limit 0;
  perform 1 from public.transport_client_debts limit 0;
  perform 1 from public.transport_keep_one limit 0;
  reset role;
end $$;
select 'PASS' as authorization_checks,
  (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
   where n.nspname='public' and c.relkind in ('r','p') and not c.relrowsecurity) as public_tables_without_rls;
rollback;
