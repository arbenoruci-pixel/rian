-- Run inside BEGIN/ROLLBACK, after installing the candidate migration in that
-- same transaction. Uses synthetic phones, UUIDs and codes only.
create temporary table history_phone_test_results(test text, passed boolean);
create function pg_temp.seed_history_fixture(n integer, phone_value text) returns uuid language plpgsql as $$
declare v_id uuid:=gen_random_uuid(); v_code text:='T'||(1900000000+n)::text;
begin
  if exists(select 1 from public.transport_orders where public.normalize_transport_phone_key(client_phone)=public.normalize_transport_phone_key(phone_value))
    or exists(select 1 from public.transport_clients where public.normalize_transport_phone_key(coalesce(phone_digits,phone,''))=public.normalize_transport_phone_key(phone_value))
  then raise exception 'TEST_PHONE_ALREADY_EXISTS'; end if;
  insert into public.transport_code_pool(code,owner_id,status) values(v_code,'HISTORY_ROLLBACK_TEST','used');
  insert into public.transport_orders(id,code_n,code_str,client_tcode,client_id,client_name,client_phone,status,data)
  values(v_id,1900000000+n,v_code,v_code,null,'HISTORY ROLLBACK TEST',phone_value,'done','{}'::jsonb);
  return v_id;
end; $$;

select set_config('request.jwt.claim.role','service_role',true);
do $tests$
declare
  v_old uuid; v_new uuid:=gen_random_uuid(); v_client uuid; v_result jsonb; v_repeat jsonb;
  v_before jsonb; v_after jsonb; v_lookup jsonb; v_count bigint; v_pool bigint;
  v_payload jsonb:=jsonb_build_object('transport_tcode_allocation_mode','ATOMIC_DB',
    'transport_create_fingerprint_v1',repeat('a',64),'created_by','DISPATCH','created_by_role','DISPATCH',
    'order_origin','DISPATCH','created_by_pin','999999','code_owner','HISTORY_ROLLBACK_TEST','transport_create_actor_id','22222222-2222-4222-8222-222222222222');
begin
  v_old:=pg_temp.seed_history_fixture(1,'+38344999001');
  select to_jsonb(o) into v_before from public.transport_orders o where id=v_old;
  select count(*) into v_pool from public.transport_code_pool;
  v_lookup:=public.inspect_dispatch_transport_phone('044 999 001');
  if v_lookup->>'status' is distinct from 'FOUND' or v_lookup->>'source_mode' is distinct from 'ORDER_HISTORY'
    or v_lookup->'candidate'->>'id' is not null or v_lookup->'candidate'->>'tcode' is distinct from 'T1900000001'
  then raise exception 'HISTORY_PRECHECK_FIXTURE_WRONG:%',v_lookup; end if;
  if exists(select 1 from public.transport_clients where tcode='T1900000001') then raise exception 'INSPECTION_WROTE_CLIENT'; end if;
  insert into history_phone_test_results values('history inspection stays read-only',true);

  v_result:=public.create_transport_order(v_new,null,null,'HISTORY ROLLBACK TEST','+38344999001','TEST ADDRESS',null,null,v_payload,'inbox');
  if v_result->>'success' is distinct from 'true' or v_result->>'client_tcode' is distinct from 'T1900000001'
    or v_result->>'allocated_in_transaction' is distinct from 'false' or v_result->>'client_id' is null
  then raise exception 'HISTORY_CREATE_FAILED:%',v_result; end if;
  v_client:=(v_result->>'client_id')::uuid;
  select count(*) into v_count from public.transport_code_pool;
  if v_count<>v_pool then raise exception 'HISTORY_CONSUMED_NEW_CODE'; end if;
  select to_jsonb(o) into v_after from public.transport_orders o where id=v_old;
  if v_after is distinct from v_before then raise exception 'ARCHIVED_ORDER_CHANGED'; end if;
  insert into history_phone_test_results values('atomic CREATE restores master and preserves historical code/archive',true);

  v_repeat:=public.create_transport_order(v_new,null,null,'HISTORY ROLLBACK TEST','044999001','TEST ADDRESS',null,null,v_payload,'inbox');
  if v_repeat->>'idempotent' is distinct from 'true' or v_repeat->>'client_id' is distinct from v_result->>'client_id'
  then raise exception 'HISTORY_REPLAY_FAILED'; end if;
  if public.ensure_transport_history_client_v1('00383 44 999 001') is distinct from v_client then raise exception 'HISTORY_REPLAY_NEW_CLIENT'; end if;
  v_lookup:=public.inspect_dispatch_transport_phone('+38344999001');
  if v_lookup->>'source_mode' is distinct from 'MASTER' or v_lookup->'active_order'->>'id' is distinct from v_new::text then raise exception 'HISTORY_MASTER_LOOKUP_FAILED'; end if;
  insert into history_phone_test_results values('repeat UUID and phone variants keep one client/code/active order',true);
  begin
    perform public.create_transport_order(gen_random_uuid(),null,null,'TEST','+38344999001','TEST',null,null,v_payload,'inbox');
    raise exception 'EXPECTED_DUPLICATE_REJECTION';
  exception when others then
    if sqlerrm not like '%DISPATCH_ACTIVE_ORDER_EXISTS%' then raise; end if;
  end;
  insert into history_phone_test_results values('second UUID cannot create another active visit',true);

  v_old:=pg_temp.seed_history_fixture(2,'+38344999002');
  begin
    perform public.create_transport_order(gen_random_uuid(),null,null,'TEST','+38344999002','TEST',null,null,v_payload,'inbox');
    raise exception 'SIMULATED_TRANSACTION_ABORT';
  exception when raise_exception then
    if sqlerrm<>'SIMULATED_TRANSACTION_ABORT' then raise; end if;
  end;
  if exists(select 1 from public.transport_clients where tcode='T1900000002')
    or (select count(*) from public.transport_orders where code_str='T1900000002')<>1
  then raise exception 'FAILED_CREATE_LEFT_MASTER_OR_ORDER'; end if;
  insert into history_phone_test_results values('failed transaction retains no restored client or new order',true);

  v_old:=pg_temp.seed_history_fixture(3,'+38344999003');
  insert into public.transport_orders(id,code_n,code_str,client_tcode,client_name,client_phone,status,data)
  values(gen_random_uuid(),1900000003,'T1900000003','T1900000003','CONFLICT TEST','+38344999004','done','{}'::jsonb);
  begin
    perform public.ensure_transport_history_client_v1('+38344999003');
    raise exception 'EXPECTED_HISTORY_PHONE_CONFLICT';
  exception when raise_exception then
    if sqlerrm<>'TRANSPORT_HISTORY_CODE_PHONE_CONFLICT' then raise; end if;
  end;
  if exists(select 1 from public.transport_clients where tcode='T1900000003') then raise exception 'CONFLICT_MERGED_CLIENT'; end if;
  insert into history_phone_test_results values('shared historical code across phones is rejected',true);

  v_old:=pg_temp.seed_history_fixture(5,'+38344999005');
  insert into public.transport_clients(tcode,name,phone,search_code) values('T1900000005','OTHER OWNER TEST','+38344999006',190000000599006);
  begin
    perform public.ensure_transport_history_client_v1('+38344999005');
    raise exception 'EXPECTED_HISTORY_OWNER_CONFLICT';
  exception when raise_exception then
    if sqlerrm<>'TRANSPORT_HISTORY_CODE_OWNER_CONFLICT' then raise; end if;
  end;
  insert into history_phone_test_results values('another canonical code owner is protected',true);

  if public.ensure_transport_history_client_v1('+38344999009') is not null then raise exception 'UNKNOWN_PHONE_CREATED_MASTER'; end if;
  if has_function_privilege('anon','public.ensure_transport_history_client_v1(text)','EXECUTE')
    or has_function_privilege('authenticated','public.ensure_transport_history_client_v1(text)','EXECUTE')
    or not has_function_privilege('service_role','public.ensure_transport_history_client_v1(text)','EXECUTE')
  then raise exception 'HISTORY_HELPER_ACL_WRONG'; end if;
  insert into history_phone_test_results values('unknown phone stays new; recovery helper is service-only',true);
end;
$tests$;
select * from history_phone_test_results;
