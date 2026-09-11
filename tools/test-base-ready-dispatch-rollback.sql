-- Run inside BEGIN + candidate function + this test + ROLLBACK only.
-- Each case gets a fresh synthetic order so production reopen guards stay active.
create temporary table ready_test_results(test text, passed boolean) on commit drop;
create function pg_temp.ready_fixture(n int, package_status text default 'final_ready') returns text language plpgsql as $$
declare test_id bigint:=90000000001104+n;
begin
  insert into public.orders(id,code,local_oid,status,client_name,client_phone,created_at,m2_total,price_total,paid,paid_cash,data)
  values(test_id,9001104+n,'codex-ready-role-test-20260911-'||n,'pastrim','CODEX ROLLBACK TEST','',now()-interval '1 hour',10,13,0,0,
    jsonb_build_object('paketimi_v1',jsonb_build_object('status',package_status),'pay',jsonb_build_object('euro',13,'paid',0,'debt',13),'items','[]'::jsonb));
  return test_id::text;
end $$;
do $$
declare u record; r jsonb; prior jsonb; p text; caught boolean; n int:=0; ref text;
begin
  for u in select distinct on(role) pin,role from users where is_active is true and role in ('PUNTOR','PUNETOR','WORKER','BAZIST','BASE','DISPATCH','ADMIN','ADMIN_MASTER','OWNER','PRONAR','SUPERADMIN') order by role,pin loop
    n:=n+1;ref:=pg_temp.ready_fixture(n);
    r:=mark_base_order_ready_with_bonus_v1(ref,u.pin,array['A1'],null,now()-interval '10 minutes','test-ready-'||n);
    if (r->>'ok') is distinct from 'true' or (r#>>'{order,status}') is distinct from 'gati' or (r#>>'{order,data,ready_by_role}') is distinct from u.role or (r->>'alreadyApplied') is distinct from 'false' then raise exception 'TEST_ROLE_STAGE_FAILED:%:%',u.role,r;end if;
    prior:=r->'order';
    r:=mark_base_order_ready_with_bonus_v1('codex-ready-role-test-20260911-'||n,u.pin,array['A2'],'changed on retry',now(),'test-ready-'||n);
    if (r->>'alreadyApplied') is distinct from 'true' or (r->'order') is distinct from prior then raise exception 'TEST_RETRY_MUTATED_ORDER:%',u.role;end if;
    insert into ready_test_results values('role '||u.role||' / numeric+local ID / immutable retry',true);
  end loop;
  if n<2 then raise exception 'TEST_ROLE_MATRIX_TOO_SMALL';end if;
  select pin into p from users where is_active is true and role='DISPATCH' limit 1;
  if p is null then raise exception 'TEST_DISPATCH_MISSING';end if;
  ref:=pg_temp.ready_fixture(50);caught:=false;
  begin perform mark_base_order_ready_with_bonus_v1(ref,p,array[]::text[]); exception when others then if sqlerrm='BASE_READY_RACK_REQUIRED' then caught:=true;else raise;end if;end;
  if not caught then raise exception 'TEST_RACK_GUARD_FAILED';end if;
  ref:=pg_temp.ready_fixture(51,'in_progress');caught:=false;
  begin perform mark_base_order_ready_with_bonus_v1(ref,p,array['A1']); exception when others then if sqlerrm='BASE_READY_PAKETIMI_NOT_FINAL' then caught:=true;else raise;end if;end;
  if not caught then raise exception 'TEST_PACKAGING_GUARD_FAILED';end if;
  caught:=false;
  begin perform mark_base_order_ready_with_bonus_v1(ref,'CODEX_NO_SUCH_PIN',array['A1']); exception when others then if sqlerrm='BASE_READY_WORKER_NOT_FOUND' then caught:=true;else raise;end if;end;
  if not caught then raise exception 'TEST_UNKNOWN_ACTOR_ALLOWED';end if;
  select pin into p from users where is_active is true and role='TRANSPORT' limit 1;
  if p is not null then
    caught:=false;
    begin perform mark_base_order_ready_with_bonus_v1(ref,p,array['A1']); exception when others then if sqlerrm like 'BASE_READY_WORKER_ROLE_NOT_ALLOWED:%' then caught:=true;else raise;end if;end;
    if not caught then raise exception 'TEST_TRANSPORT_ROLE_GUARD_FAILED';end if;
  end if;
  if exists(select 1 from base_ready_bonuses where order_id between 90000000001104 and 90000000001200) or exists(select 1 from arka_pending_payments where order_id between 90000000001104 and 90000000001200) then raise exception 'TEST_STAGING_CREATED_MONEY';end if;
  insert into ready_test_results values('rack / packaging / unknown actor / transport denial / no bonus or payment writes',true);
end $$;
select * from ready_test_results;
