-- Execute after the migration. All fixtures and trigger writes are rolled back.
-- Uses synthetic clients/orders only; no cash writes or real customer mutations.
begin;
set local statement_timeout = '15s';
set local lock_timeout = '3s';
set local role service_role;
do $$
declare
  c public.transport_clients%rowtype;
  o public.transport_orders%rowtype;
  d jsonb;
  saved jsonb;
  old_client jsonb;
  fid uuid := gen_random_uuid();
  actor_id uuid;
  code text := 'T2000000000';
  stage text;
begin
  if exists (select 1 from public.transport_clients where tcode = code)
    or exists (select 1 from public.transport_orders where code_str = code) then
    raise exception 'TEST_CODE_ALREADY_IN_USE';
  end if;
  select id into strict actor_id from public.users where is_active is not false order by id limit 1;
  insert into public.transport_clients(id,name,search_code,tcode,phone,updated_at)
    values(gen_random_uuid(),'__DISPATCH_ROLLBACK_TEST__',substring(code from 2)::bigint,code,'999'||floor(random()*1000000000000000)::text,clock_timestamp()) returning * into c;
  d := jsonb_build_object('client',jsonb_build_object('id',c.id,'name',c.name),
    'transport_id',actor_id,'worker_pin','TEST_ONLY','status','pastrim',
    'tepiha',jsonb_build_array(jsonb_build_object('id','carpet1','m2',6,'qty',2,'photoUrl','/fixture.jpg')),
    'staza','[]'::jsonb,'shkallore',jsonb_build_object('qty',0,'per',0.3),
    'pay',jsonb_build_object('m2',12,'euro',21.6,'paid',0,'rate',1.8),
    'dispatch_edit',jsonb_build_object('measurements_changed',true));
  insert into public.transport_orders(id,client_id,client_name,code_str,client_tcode,status,data,updated_at)
    values(gen_random_uuid(),c.id,c.name,code,code,'pastrim',d,clock_timestamp()) returning * into o;
  foreach stage in array array['assigned','pastrim','gati','loaded','delivery'] loop
    update public.transport_orders set status=stage,data=jsonb_set(data,'{status}',to_jsonb(stage)),updated_at=clock_timestamp()
      where id=o.id returning * into o;
    select * into c from public.transport_clients where id=c.id;
    d := o.data || jsonb_build_object('note','Updated fixture note');
    saved := public.edit_dispatch_order_v1(o.id,o.updated_at,c.id,c.updated_at,
      jsonb_build_object('name',c.name,'address',null),d,stage);
    if saved->>'status' <> stage or saved->>'transport_id' <> actor_id::text
      or saved->'data'->>'worker_pin' <> 'TEST_ONLY'
      or saved->'data'->'pay' is distinct from d->'pay'
      or saved->'data'->'tepiha' is distinct from d->'tepiha' then
      raise exception 'EDIT_PRESERVATION_FAILED';
    end if;
  end loop;
  select * into o from public.transport_orders where id=o.id;
  select * into c from public.transport_clients where id=c.id;
  old_client := to_jsonb(c);
  begin
    perform public.edit_dispatch_order_v1(o.id,o.updated_at-interval '1 second',c.id,c.updated_at,
      jsonb_build_object('name','MUST NOT SAVE'),o.data,o.status);
    raise exception 'STALE_EDIT_WAS_NOT_REJECTED';
  exception when raise_exception then
    if sqlerrm <> 'DISPATCH_EDIT_CONFLICT' then raise; end if;
  end;
  if (select to_jsonb(x) from public.transport_clients x where x.id=c.id) is distinct from old_client then
    raise exception 'STALE_EDIT_CHANGED_CLIENT';
  end if;
  begin
    perform public.edit_dispatch_order_v1(o.id,o.updated_at,c.id,c.updated_at-interval '1 second',
      jsonb_build_object('name','MUST NOT SAVE'),o.data,o.status);
    raise exception 'STALE_CLIENT_WAS_NOT_REJECTED';
  exception when raise_exception then
    if sqlerrm <> 'DISPATCH_EDIT_CONFLICT' then raise; end if;
  end;
  -- The existing measurement-loss trigger restores an attempted empty overwrite.
  -- The RPC must reject that silent rewrite and roll its earlier client update back.
  begin
    perform public.edit_dispatch_order_v1(o.id,o.updated_at,c.id,c.updated_at,
      jsonb_build_object('name','MUST ROLL BACK'),
      o.data || '{"tepiha":[],"staza":[],"shkallore":{"qty":0,"per":0.3}}'::jsonb,o.status);
    raise exception 'TRIGGER_REWRITE_WAS_NOT_REJECTED';
  exception when raise_exception then
    if sqlerrm <> 'DISPATCH_EDIT_CONFLICT' then raise; end if;
  end;
  if (select to_jsonb(x) from public.transport_clients x where x.id=c.id) is distinct from old_client then
    raise exception 'TRIGGER_REJECTION_CHANGED_CLIENT';
  end if;
  insert into public.transport_customer_feedback(id,client_id,order_id,rating,note,no_pickup,created_by,author_name,author_role)
    values(fid,c.id,o.id,2,'Synthetic rollback test',true,actor_id,'Test','DISPATCH');
  begin
    insert into public.transport_customer_feedback(id,client_id,rating,created_by,author_name,author_role)
      values(fid,c.id,3,actor_id,'Test','DISPATCH');
    raise exception 'DUPLICATE_FEEDBACK_NOT_REJECTED';
  exception when unique_violation then null;
  end;
  begin
    insert into public.transport_customer_feedback(id,client_id,rating,created_by,author_name,author_role)
      values(gen_random_uuid(),c.id,6,actor_id,'Test','DISPATCH');
    raise exception 'INVALID_RATING_NOT_REJECTED';
  exception when check_violation then null;
  end;
end;
$$;
rollback;
select 'PASS: service role edits, lifecycle/owner/measurements, stale order/client, trigger rollback, feedback uniqueness and rating constraints; all fixtures rolled back' as result;
