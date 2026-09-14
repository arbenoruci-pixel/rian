-- Only for this release's verified pre-family snapshot, before any real use.
-- If families were used, retain the overlay and admission guards during UI rollback.
do $restore$
declare f record;
begin
 if exists(select 1 from public.client_family_operations) or exists(select 1 from public.client_family_nodes)
    or exists(select 1 from public.client_family_contacts) then raise exception 'FAMILY_ROLLBACK_REQUIRES_PRESERVING_USED_DATA'; end if;
 for f in select definition from tepiha_before_family_20260914._snapshot_functions where signature in
 ('upsert_client_from_order()','create_transport_order(uuid,bigint,text,text,text,text,text,text,jsonb,text)') loop
   execute f.definition;
 end loop;
end $restore$;
drop trigger zz_client_family_new_master_v1 on public.clients;
drop trigger zz_client_family_new_master_v1 on public.transport_clients;
drop index public.clients_family_phone_v1_idx;
drop index public.transport_clients_family_phone_v1_idx;
drop view public.client_family_directory_v1;
do $drop_functions$
declare f record;
begin
 for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in
 ('client_family_phone_key_v1','client_family_root_v1','client_family_keys_v1','client_family_ensure_node_v1','client_family_snapshot_v1','client_family_phone_owner_v1','client_family_search_v1','client_family_mutate_v1','client_family_new_master_v1') loop
   execute format('drop function %s',f.signature);
 end loop;
end $drop_functions$;
drop table public.client_family_operations;
drop table public.client_family_contacts;
drop table public.client_family_nodes;
do $verify$
begin
 if exists(select 1 from tepiha_before_family_20260914._snapshot_functions f where signature in
 ('upsert_client_from_order()','create_transport_order(uuid,bigint,text,text,text,text,text,text,jsonb,text)')
 and md5(f.definition)<>md5(pg_get_functiondef(f.signature::regprocedure))) then raise exception 'FAMILY_ROLLBACK_FUNCTION_MISMATCH'; end if;
end $verify$;
notify pgrst,'reload schema';
