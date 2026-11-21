-- Transaction-only rehearsal. Execute this whole file in one SQL request as
-- postgres. It creates a session-local pg_temp function, never a permanent helper.
-- All business fixtures AND permission changes are rolled back in a subtransaction
-- before the result is returned. It can run before or after the live migration.
-- No customer/order is inserted. No real user's PIN/device bank is used.
-- Global allocator lock + brief table locks keep comparison/fixture selection stable.
-- Abort instead of triggering refill: sequence nextval/setval does not roll back.
-- Preconditions also prevent allocator cleanup from touching real expired rows.

set local lock_timeout = '3s';
set local statement_timeout = '20s';

create or replace function pg_temp.test_base_code_pool_access_v1()
returns jsonb
language plpgsql
security invoker
as $test$
declare
  original_rls boolean;
  original_force boolean;
  original_acl text;
  original_acl_canonical text;
  pool_before text;
  leases_before text;
  users_before text;
  sequence_before text;
  fixture_user uuid := gen_random_uuid();
  fixture_pin text;
  fixture_device text := 'rls_rollback_' || gen_random_uuid()::text;
  draft_a text := 'rls_rollback_a_' || gen_random_uuid()::text;
  draft_b text := 'rls_rollback_b_' || gen_random_uuid()::text;
  draft_c text := 'rls_rollback_c_' || gen_random_uuid()::text;
  absent_order text := gen_random_uuid()::text;
  fixture_codes bigint[];
  minimum_existing bigint;
  allocation record;
  offline_allocation record;
  offline_retry record;
  verdict jsonb;
  role_name text;
  privilege_name text;
  passed integer := 0;
begin
  if current_user<>'postgres' then raise exception 'RLS_TEST_REQUIRES_POSTGRES_SESSION'; end if;
  if not pg_try_advisory_xact_lock(hashtext('tepiha_pranimi_code_allocator_v39_1')) then
    raise exception 'RLS_TEST_ALLOCATOR_BUSY_RETRY_WHEN_IDLE';
  end if;
  lock table public.base_code_pool in access exclusive mode;
  lock table public.offline_code_leases,public.users in share row exclusive mode;

  select relrowsecurity,relforcerowsecurity,relacl::text
    into original_rls,original_force,original_acl
    from pg_class where oid='public.base_code_pool'::regclass;
  select jsonb_agg(to_jsonb(a) order by a.grantor,a.grantee,a.privilege_type,a.is_grantable)::text
    into original_acl_canonical
    from pg_class c cross join lateral aclexplode(c.relacl) a
    where c.oid='public.base_code_pool'::regclass;
  select md5(coalesce(string_agg(md5(to_jsonb(b)::text),'' order by b.code),'')) into pool_before from public.base_code_pool b;
  select md5(coalesce(string_agg(md5(to_jsonb(l)::text),'' order by l.lease_token),'')) into leases_before from public.offline_code_leases l;
  select md5(coalesce(string_agg(md5(to_jsonb(u)::text),'' order by u.id),'')) into users_before from public.users u;
  select jsonb_build_object('last_value',s.last_value,'log_cnt',s.log_cnt,'is_called',s.is_called)::text into sequence_before from public.base_codes_seq s;

  if (select count(*) from public.base_code_pool b
      where b.status='available' and b.code ~ '^[0-9]+$' and b.code::bigint>0
        and not exists(select 1 from public.orders o where btrim(o.code::text)=b.code)
        and not exists(select 1 from public.clients c where btrim(c.code::text)=b.code)
        and not exists(select 1 from public.offline_code_leases l where l.scope='base' and l.code=b.code and l.status in ('available','assigned'))
     ) < 20 then
    raise exception 'RLS_TEST_REFILL_WOULD_CHANGE_NONTRANSACTIONAL_SEQUENCE';
  end if;
  if exists(select 1 from public.offline_code_leases where scope='base' and status in ('available','assigned') and expires_at<=now()) then
    raise exception 'RLS_TEST_REAL_EXPIRED_OFFLINE_LEASES_PRESENT';
  end if;
  if exists(select 1 from public.base_code_pool b
    where b.status='reserved' and not b.draft_has_meaningful_work and b.lease_expires_at<now()
      and b.code ~ '^[0-9]+$' and b.code::bigint>0
      and not exists(select 1 from public.orders o where o.code::text=b.code)
      and not exists(select 1 from public.clients c where c.code::text=b.code)) then
    raise exception 'RLS_TEST_REAL_EXPIRED_RESERVATIONS_PRESENT';
  end if;

  select min(b.code::bigint) into minimum_existing from public.base_code_pool b
  where b.status='available' and b.code ~ '^[0-9]+$' and b.code::bigint>0
    and not exists(select 1 from public.orders o where o.code::text=b.code)
    and not exists(select 1 from public.clients c where c.code::text=b.code);
  select array_agg(code order by code) into fixture_codes from (
    select g.code from generate_series(1,least(minimum_existing-1,100000)) g(code)
    where not exists(select 1 from public.base_code_pool b where b.code=g.code::text)
      and not exists(select 1 from public.orders o where o.code::text=g.code::text)
      and not exists(select 1 from public.clients c where c.code::text=g.code::text)
      and not exists(select 1 from public.offline_code_leases l where l.scope='base' and l.code=g.code::text)
    order by g.code limit 3
  ) gaps;
  if coalesce(array_length(fixture_codes,1),0)<>3 then
    raise exception 'RLS_TEST_THREE_UNUSED_FIXTURE_CODE_GAPS_REQUIRED';
  end if;

  loop
    fixture_pin := (900000000000 + floor(random()*99999999999))::bigint::text;
    exit when not exists(select 1 from public.users where pin=fixture_pin)
      and not exists(select 1 from private.staff_pin_aliases where alias_pin=fixture_pin)
      and not exists(select 1 from public.offline_code_leases where owner_id=fixture_pin)
      and not exists(select 1 from public.base_code_pool where owner_id=fixture_pin or reserved_by=fixture_pin or used_by_pin=fixture_pin);
  end loop;

  begin
    insert into public.users(id,pin,name,role,is_active,transport_id)
    values(fixture_user,fixture_pin,'RLS rollback-only test','WORKER',true,null);
    insert into public.base_code_pool(code,owner_id,status)
    select code::text,'','available' from unnest(fixture_codes) code;

    alter table public.base_code_pool enable row level security;
    revoke all privileges on table public.base_code_pool from public,anon,authenticated;

    foreach role_name in array array['anon','authenticated'] loop
      execute format('set local role %I',role_name);
      foreach privilege_name in array array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'] loop
        if has_table_privilege(current_user,'public.base_code_pool',privilege_name) then
          raise exception 'RLS_TEST_BROWSER_PRIVILEGE_ALLOWED: % %',role_name,privilege_name;
        end if;
      end loop;
      begin
        perform 1 from public.base_code_pool limit 1;
        raise exception 'RLS_TEST_DIRECT_SELECT_ALLOWED';
      exception when insufficient_privilege then null;
      end;
      begin
        update public.base_code_pool set status=status where false;
        raise exception 'RLS_TEST_DIRECT_UPDATE_ALLOWED';
      exception when insufficient_privilege then null;
      end;
      begin
        delete from public.base_code_pool where false;
        raise exception 'RLS_TEST_DIRECT_DELETE_ALLOWED';
      exception when insufficient_privilege then null;
      end;
      begin
        insert into public.base_code_pool(code,owner_id,status) select '1','','available' where false;
        raise exception 'RLS_TEST_DIRECT_INSERT_ALLOWED';
      exception when insufficient_privilege then null;
      end;
      execute 'reset role';
      passed := passed+4;
    end loop;

    execute 'set local role anon';
    select * into allocation from public.get_or_assign_pranimi_code(fixture_pin,draft_a,30);
    if allocation.code<>fixture_codes[1] or allocation.verified is not true then raise exception 'RLS_TEST_FIRST_ALLOCATION_FAILED'; end if;
    select * into allocation from public.get_or_assign_pranimi_code(fixture_pin,draft_a,30);
    if allocation.code<>fixture_codes[1] or allocation.verified is not true then raise exception 'RLS_TEST_RETRY_CHANGED_CODE'; end if;
    select * into allocation from public.get_or_assign_pranimi_code(fixture_pin,draft_b,30);
    if allocation.code<>fixture_codes[2] or allocation.verified is not true then raise exception 'RLS_TEST_SECOND_DRAFT_ALLOCATION_FAILED'; end if;
    verdict := public.verify_pranimi_code_assignment(fixture_codes[1],fixture_pin,draft_a,0);
    if coalesce((verdict->>'ok')::boolean,false) is not true then raise exception 'RLS_TEST_VERIFY_FAILED'; end if;
    verdict := public.verify_pranimi_code_assignment(fixture_codes[1],fixture_pin,draft_b,0);
    if coalesce((verdict->>'ok')::boolean,false) is true then raise exception 'RLS_TEST_WRONG_DRAFT_ACCEPTED'; end if;
    verdict := public.renew_pranimi_code_assignment(fixture_codes[1],fixture_pin,draft_a,true,60);
    if coalesce((verdict->>'ok')::boolean,false) is not true or (verdict->>'meaningful')::boolean is not true then raise exception 'RLS_TEST_RENEW_FAILED'; end if;
    passed := passed+6;

    select * into offline_allocation from public.reserve_base_offline_codes(fixture_pin,fixture_device,1,720);
    if offline_allocation.code<>fixture_codes[3] or offline_allocation.lease_token is null then raise exception 'RLS_TEST_OFFLINE_RESERVE_FAILED'; end if;
    select * into offline_retry from public.reserve_base_offline_codes(fixture_pin,fixture_device,1,720);
    if offline_retry.code is distinct from offline_allocation.code or offline_retry.lease_token is distinct from offline_allocation.lease_token then raise exception 'RLS_TEST_OFFLINE_RETRY_CHANGED_LEASE'; end if;
    verdict := public.bind_base_offline_code_to_draft(fixture_pin,fixture_device,fixture_codes[3],offline_allocation.lease_token,draft_c);
    if coalesce((verdict->>'ok')::boolean,false) is not true then raise exception 'RLS_TEST_OFFLINE_BIND_FAILED'; end if;
    verdict := public.bind_base_offline_code_to_draft(fixture_pin,fixture_device||'_wrong',fixture_codes[3],offline_allocation.lease_token,draft_c);
    if coalesce((verdict->>'ok')::boolean,false) is true then raise exception 'RLS_TEST_WRONG_DEVICE_ACCEPTED'; end if;
    verdict := public.mark_base_code_used_after_verify(fixture_codes[1],fixture_pin,draft_a,absent_order,null);
    if verdict->>'reason' is distinct from 'EXACT_FINAL_ORDER_NOT_FOUND' then raise exception 'RLS_TEST_MISSING_ORDER_NOT_REJECTED'; end if;
    verdict := public.finalize_base_offline_code(fixture_pin,fixture_device,fixture_codes[3],offline_allocation.lease_token,draft_c,absent_order,null);
    if verdict->>'reason' is distinct from 'EXACT_FINAL_ORDER_NOT_FOUND' then raise exception 'RLS_TEST_OFFLINE_MISSING_ORDER_NOT_REJECTED'; end if;
    execute 'reset role';
    passed := passed+6;

    execute 'set local role authenticated';
    verdict := public.verify_pranimi_code_assignment(fixture_codes[1],fixture_pin,draft_a,0);
    if coalesce((verdict->>'ok')::boolean,false) is not true then raise exception 'RLS_TEST_AUTHENTICATED_RPC_FAILED'; end if;
    verdict := public.release_pranimi_code_assignment(fixture_codes[2],fixture_pin,draft_b,'rollback-only test');
    if coalesce((verdict->>'released')::boolean,false) is not true then raise exception 'RLS_TEST_RELEASE_FAILED'; end if;
    execute 'reset role';
    execute 'set local role service_role';
    if (select count(*) from public.base_code_pool where code=any(fixture_codes::text[]))<>3 then raise exception 'RLS_TEST_SERVER_STATUS_READ_FAILED'; end if;
    execute 'reset role';
    passed := passed+3;

    -- Exercise the documented emergency rollback without making it visible outside
    -- this transaction. Reapplying protection must also keep all fixtures readable
    -- for the server and leave allocator function grants untouched.
    alter table public.base_code_pool disable row level security;
    grant all privileges on table public.base_code_pool to anon,authenticated;
    if original_rls is false and (select jsonb_agg(to_jsonb(a) order by a.grantor,a.grantee,a.privilege_type,a.is_grantable)::text
      from pg_class c cross join lateral aclexplode(c.relacl) a
      where c.oid='public.base_code_pool'::regclass) is distinct from original_acl_canonical then
      raise exception 'RLS_TEST_EMERGENCY_ROLLBACK_ACL_DIFFERS_FROM_BASELINE';
    end if;
    execute 'set local role anon';
    if (select count(*) from public.base_code_pool where code=any(fixture_codes::text[]))<>3 then raise exception 'RLS_TEST_ROLLBACK_READ_FAILED'; end if;
    execute 'reset role';
    alter table public.base_code_pool enable row level security;
    revoke all privileges on table public.base_code_pool from public,anon,authenticated;
    passed := passed+1;

    if (select md5(coalesce(string_agg(md5(to_jsonb(b)::text),'' order by b.code),'')) from public.base_code_pool b where not(b.code=any(fixture_codes::text[]))) is distinct from pool_before then raise exception 'RLS_TEST_CHANGED_REAL_POOL_ROW'; end if;
    if (select md5(coalesce(string_agg(md5(to_jsonb(l)::text),'' order by l.lease_token),'')) from public.offline_code_leases l where owner_id<>fixture_pin) is distinct from leases_before then raise exception 'RLS_TEST_CHANGED_REAL_OFFLINE_LEASE'; end if;
    if (select jsonb_build_object('last_value',s.last_value,'log_cnt',s.log_cnt,'is_called',s.is_called)::text from public.base_codes_seq s) is distinct from sequence_before then raise exception 'RLS_TEST_SEQUENCE_CHANGED'; end if;

    raise exception using errcode='ZX001',message='ROLL_BACK_ONLY_THE_TEST_SUBTRANSACTION';
  exception when sqlstate 'ZX001' then
    null;
  end;

  if (select relrowsecurity from pg_class where oid='public.base_code_pool'::regclass) is distinct from original_rls
    or (select relforcerowsecurity from pg_class where oid='public.base_code_pool'::regclass) is distinct from original_force
    or (select relacl::text from pg_class where oid='public.base_code_pool'::regclass) is distinct from original_acl then
    raise exception 'RLS_TEST_ACCESS_METADATA_NOT_RESTORED';
  end if;
  if (select md5(coalesce(string_agg(md5(to_jsonb(b)::text),'' order by b.code),'')) from public.base_code_pool b) is distinct from pool_before then raise exception 'RLS_TEST_POOL_NOT_RESTORED'; end if;
  if (select md5(coalesce(string_agg(md5(to_jsonb(l)::text),'' order by l.lease_token),'')) from public.offline_code_leases l) is distinct from leases_before then raise exception 'RLS_TEST_LEASES_NOT_RESTORED'; end if;
  if (select md5(coalesce(string_agg(md5(to_jsonb(u)::text),'' order by u.id),'')) from public.users u) is distinct from users_before then raise exception 'RLS_TEST_USER_NOT_RESTORED'; end if;
  if (select jsonb_build_object('last_value',s.last_value,'log_cnt',s.log_cnt,'is_called',s.is_called)::text from public.base_codes_seq s) is distinct from sequence_before then raise exception 'RLS_TEST_SEQUENCE_NOT_PRESERVED'; end if;

  return jsonb_build_object('ok',true,'functional_checks',passed,
    'pool_rows_unchanged',true,'offline_leases_unchanged',true,'users_unchanged',true,
    'sequence_unchanged',true,'access_metadata_restored',true,
    'synthetic_fixtures_rolled_back',true,'emergency_rollback_rehearsed',true,
    'successful_order_insert_tested',false);
end;
$test$;

select pg_temp.test_base_code_pool_access_v1() as rollback_test_result;
