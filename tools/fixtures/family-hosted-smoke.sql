-- Execute inside the same transaction as the candidate migration, then ROLLBACK.
-- Synthetic UUIDs and explicit order IDs avoid advancing production sequences.
do $smoke$
declare
 a uuid:=gen_random_uuid(); b uuid:=gen_random_uuid(); t uuid:=gen_random_uuid(); u uuid:=gen_random_uuid();
 actor_id uuid; ak text; bk text; tk text; uk text; f jsonb; other_f jsonb; payload jsonb; result jsonb;
 order_id uuid:=gen_random_uuid(); base_id bigint:=90000000101; before_a jsonb; before_b jsonb;
begin
 if exists(select 1 from public.clients where code in ('900000101','900000102') or public.normalize_kosovo_phone_v1(phone) in ('38349007101','38349007102','38349007105'))
    or exists(select 1 from public.transport_clients where tcode in ('T900000103','T900000104') or public.normalize_kosovo_phone_v1(phone) in ('38349007103','38349007104','38349007105'))
    or exists(select 1 from public.orders where id between base_id and base_id+5)
 then raise exception 'SMOKE_FIXTURE_COLLISION'; end if;
 select id into actor_id from public.users where upper(role)='ADMIN' and is_active is distinct from false limit 1;
 if actor_id is null then raise exception 'SMOKE_STAFF_NOT_FOUND'; end if;
 insert into public.clients(id,code,first_name,last_name,full_name,name,phone) values(a,'900000101','QA FAMILY','A','QA FAMILY A','QA FAMILY A','049007101'),(b,'900000102','QA FAMILY','B','QA FAMILY B','QA FAMILY B','049007102');
 insert into public.transport_clients(id,tcode,search_code,name,phone) values(t,'T900000103',900000103,'QA FAMILY T','049007103'),(u,'T900000104',900000104,'QA FAMILY U','049007104');
 select to_jsonb(c) into before_a from public.clients c where id=a;
 select to_jsonb(c) into before_b from public.clients c where id=b;
 ak:='BASE:'||a::text; bk:='BASE:'||b::text; tk:='TRANSPORT:'||t::text; uk:='TRANSPORT:'||u::text;
 foreach payload in array array[jsonb_build_object('key',ak,'other',bk),jsonb_build_object('key',tk,'other',uk),jsonb_build_object('key',ak,'other',tk)] loop
   f:=public.client_family_snapshot_v1(payload->>'key'); other_f:=public.client_family_snapshot_v1(payload->>'other');
   perform public.client_family_mutate_v1(jsonb_build_object('action','MERGE','key',payload->>'key','otherKey',payload->>'other','expectedRoot',f->>'rootKey','expectedRevision',f->'revision','otherRoot',other_f->>'rootKey','otherRevision',other_f->'revision','requestId',gen_random_uuid()),actor_id,null);
 end loop;
 f:=public.client_family_snapshot_v1(ak);
 if jsonb_array_length(f->'members')<>4 then raise exception 'SMOKE_MERGE_FAILED'; end if;
 payload:=jsonb_build_object('action','ADD_CONTACTS','key',bk,'expectedRoot',f->>'rootKey','expectedRevision',f->'revision','contacts',jsonb_build_array(jsonb_build_object('name','QA FAMILY CONTACT','phone','049007105')),'requestId',gen_random_uuid());
 result:=public.client_family_mutate_v1(payload,actor_id,null);
 if public.client_family_mutate_v1(payload,actor_id,null)<>result then raise exception 'SMOKE_RETRY_FAILED'; end if;
 if public.client_family_phone_owner_v1('BASE','+38349007105')<>a or public.client_family_phone_owner_v1('TRANSPORT','+38349007105') not in (t,u) then raise exception 'SMOKE_PHONE_RESOLUTION_FAILED'; end if;
 if jsonb_array_length(public.client_family_search_v1('900000102','BASE'))<>1 then raise exception 'SMOKE_ALIAS_SEARCH_FAILED'; end if;
 insert into public.orders(id,client_id,client_code,code,client_name,client_phone,status,data)
 values(base_id,b,900000102,900000102,'QA FAMILY VISITOR','049007105','pranim','{"order":{},"qa_test":"client-family-transaction"}');
 if not exists(select 1 from public.orders where id=base_id and client_id=b and code=900000102 and client_name='QA FAMILY VISITOR' and client_phone='049007105' and data#>>'{order,client,phone}'='049007105') then raise exception 'SMOKE_BASE_VISIT_FAILED'; end if;
 update public.orders set status='pastrim' where id=base_id;
 if not exists(select 1 from public.orders where id=base_id and client_name='QA FAMILY VISITOR' and client_phone='049007105') then raise exception 'SMOKE_BASE_STATUS_FAILED'; end if;
 if (select to_jsonb(c) from public.clients c where id=a)<>before_a or (select to_jsonb(c) from public.clients c where id=b)<>before_b then raise exception 'SMOKE_MASTER_CHANGED'; end if;
 perform set_config('request.jwt.claim.role','service_role',true);
 result:=public.create_transport_order(order_id,null,null,'QA FAMILY VISITOR','049007105','',null,null,jsonb_build_object('transport_tcode_allocation_mode','ATOMIC_DB','transport_create_fingerprint_v1',repeat('a',64),'qa_test','client-family-transaction'),'pickup');
 if (result->>'client_id')::uuid not in(t,u) or (result->>'allocated_in_transaction')::boolean then raise exception 'SMOKE_TRANSPORT_CREATE_FAILED'; end if;
 result:=public.create_transport_order(order_id,null,null,'QA FAMILY VISITOR','049007105','',null,null,jsonb_build_object('transport_tcode_allocation_mode','ATOMIC_DB','transport_create_fingerprint_v1',repeat('a',64),'qa_test','client-family-transaction'),'pickup');
 if (result->>'idempotent')::boolean is distinct from true then raise exception 'SMOKE_TRANSPORT_RETRY_FAILED'; end if;
 if not exists(select 1 from public.transport_orders where id=order_id and client_phone='049007105' and client_name='QA FAMILY VISITOR') then raise exception 'SMOKE_TRANSPORT_CONTACT_FAILED'; end if;
 insert into public.orders(id,client_id,client_code,code,client_name,client_phone,status)
 values(base_id+1,a,900000101,900000101,'QA PRIOR FAMILY VISIT','049007105','pranim');
 f:=public.client_family_snapshot_v1(ak);
 perform public.client_family_mutate_v1(jsonb_build_object('action','UNLINK','key',ak,'otherKey',bk,'expectedRoot',f->>'rootKey','expectedRevision',f->'revision','requestId',gen_random_uuid()),actor_id,null);
 f:=public.client_family_snapshot_v1(bk);
 if jsonb_array_length(f->'members')<>1 or jsonb_array_length(f->'contacts')<>1 then raise exception 'SMOKE_UNLINK_FAILED'; end if;
 update public.orders set status='gati' where id=base_id+1;
 if not exists(select 1 from public.orders where id=base_id+1 and client_id=a and client_phone='049007105') then raise exception 'SMOKE_UNLINK_OLD_VISIT_FAILED'; end if;
 perform public.client_family_mutate_v1(jsonb_build_object('action','REMOVE_CONTACT','key',bk,'contactId',f#>>'{contacts,0,id}','expectedRoot',f->>'rootKey','expectedRevision',f->'revision','requestId',gen_random_uuid()),actor_id,null);
 update public.orders set status='gati' where id=base_id;
 if not exists(select 1 from public.orders where id=base_id and client_id=b and client_phone='049007105') then raise exception 'SMOKE_REMOVED_CONTACT_VISIT_FAILED'; end if;
 if has_table_privilege('anon','public.client_family_contacts','select') or has_function_privilege('anon','public.client_family_mutate_v1(jsonb,uuid,text)','execute') then raise exception 'SMOKE_PUBLIC_ACCESS_FAILED'; end if;
 if not has_function_privilege('anon','public.client_family_phone_key_v1(text)','execute') then raise exception 'SMOKE_LEGACY_INSERT_PERMISSION_FAILED'; end if;
end $smoke$;
