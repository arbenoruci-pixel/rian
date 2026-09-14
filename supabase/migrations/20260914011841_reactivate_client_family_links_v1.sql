-- Family membership is an overlay. Original clients, carpet codes, orders and
-- financial rows are never rewritten by merge/unmerge.
begin;
set local lock_timeout='5s';
set local statement_timeout='45s';

-- Match lib/transport/phone.js without changing the legacy global normalizer.
create function public.client_family_phone_key_v1(p_phone text) returns text
language plpgsql immutable set search_path=public,pg_temp as $$
 declare v_raw text:=regexp_replace(coalesce(p_phone,''),'\D','','g');
 v_candidate text; v_country text; v_local text;
 v_explicit boolean:=btrim(coalesce(p_phone,'')) like '+%' or v_raw like '00%';
 begin
  v_candidate:=case when v_raw like '00%' then substr(v_raw,3) else v_raw end;
  foreach v_country in array array['383','389','355','49','43','41'] loop
   if v_candidate like v_country||'%' and (v_explicit or length(v_candidate)-length(v_country)>=8) then
    v_local:=ltrim(substr(v_candidate,length(v_country)+1),'0');
    return case when v_country='383' then v_local else v_country||v_local end;
   end if;
  end loop;
  return ltrim(v_raw,'0');
 end
$$;
create index if not exists clients_family_phone_v1_idx on public.clients(public.client_family_phone_key_v1(phone));
create index if not exists transport_clients_family_phone_v1_idx on public.transport_clients(public.client_family_phone_key_v1(phone));


create table public.client_family_nodes (
  key text primary key,
  base_client_id uuid unique references public.clients(id) on delete restrict,
  transport_client_id uuid unique references public.transport_clients(id) on delete restrict,
  parent_key text references public.client_family_nodes(key) on delete restrict,
  revision bigint not null default 0,
  check (num_nonnulls(base_client_id, transport_client_id)=1),
  check (key=case when base_client_id is not null then 'BASE:'||base_client_id::text else 'TRANSPORT:'||transport_client_id::text end),
  check (parent_key is null or parent_key<>key)
);
create index client_family_parent_idx on public.client_family_nodes(parent_key) where parent_key is not null;
create table public.client_family_contacts (
  id uuid primary key default gen_random_uuid(),
  owner_key text not null references public.client_family_nodes(key) on delete restrict,
  name text not null check (length(btrim(name)) between 1 and 180),
  phone text not null,
  phone_key text not null check (phone_key ~ '^[0-9]{8,15}$'),
  created_at timestamptz not null default now(),
  unique(owner_key,phone_key)
);
create index client_family_contacts_phone_idx on public.client_family_contacts(phone_key);
create table public.client_family_operations (
  request_id uuid primary key,
  actor text not null,
  payload jsonb not null,
  result jsonb not null,
  created_at timestamptz not null default now()
);

alter table public.client_family_nodes enable row level security;
alter table public.client_family_contacts enable row level security;
alter table public.client_family_operations enable row level security;
revoke all on public.client_family_nodes,public.client_family_contacts,public.client_family_operations from public,anon,authenticated;
grant all on public.client_family_nodes,public.client_family_contacts,public.client_family_operations to service_role;

create view public.client_family_directory_v1 with (security_invoker=true) as
select 'BASE:'||c.id::text as key,'BASE'::text as source,c.id as client_id,c.code::text as code,
 coalesce(nullif(c.full_name,''),nullif(c.name,''),nullif(concat_ws(' ',c.first_name,c.last_name),''),'Pa emër') as name,
 c.phone,public.client_family_phone_key_v1(c.phone) as phone_key,c.updated_at
from public.clients c
union all
select 'TRANSPORT:'||c.id::text,'TRANSPORT',c.id,c.tcode,c.name,c.phone,public.client_family_phone_key_v1(c.phone),c.updated_at
from public.transport_clients c;
revoke all on public.client_family_directory_v1 from public,anon,authenticated;
grant select on public.client_family_directory_v1 to service_role;

create function public.client_family_root_v1(p_key text) returns text language sql stable set search_path=public,pg_temp as $$
 with recursive path(key,seen) as (
   select p_key,array[p_key]
   union all
   select n.parent_key,p.seen||n.parent_key from path p join public.client_family_nodes n on n.key=p.key
   where n.parent_key is not null and not n.parent_key=any(p.seen)
 ) select key from path order by cardinality(seen) desc limit 1
$$;
create function public.client_family_keys_v1(p_key text) returns table(key text) language sql stable set search_path=public,pg_temp as $$
 with recursive members(key) as (
   select public.client_family_root_v1(p_key)
   union
   select n.key from public.client_family_nodes n join members m on n.parent_key=m.key
 ) select key from members
$$;
create function public.client_family_ensure_node_v1(p_key text) returns void language plpgsql set search_path=public,pg_temp as $$
 begin
   if not exists(select 1 from public.client_family_directory_v1 where key=p_key) then raise exception 'FAMILY_CLIENT_NOT_FOUND'; end if;
   insert into public.client_family_nodes(key,base_client_id,transport_client_id)
   select d.key,case when d.source='BASE' then d.client_id end,case when d.source='TRANSPORT' then d.client_id end
   from public.client_family_directory_v1 d where d.key=p_key on conflict(key) do nothing;
 end
$$;
create function public.client_family_snapshot_v1(p_key text) returns jsonb language plpgsql stable set search_path=public,pg_temp as $$
 declare v_root text; v_members jsonb; v_contacts jsonb; v_revision bigint;
 begin
   if not exists(select 1 from public.client_family_directory_v1 where key=p_key) then raise exception 'FAMILY_CLIENT_NOT_FOUND'; end if;
   v_root:=public.client_family_root_v1(p_key);
   select coalesce(n.revision,0) into v_revision from public.client_family_nodes n where n.key=v_root;
   select jsonb_agg(jsonb_build_object('key',d.key,'source',d.source,'clientId',d.client_id,'code',d.code,'name',d.name,'phone',d.phone,'parentKey',n.parent_key) order by (d.key=v_root) desc,d.source,d.code,d.key)
   into v_members from public.client_family_directory_v1 d join public.client_family_keys_v1(p_key) k on k.key=d.key left join public.client_family_nodes n on n.key=d.key;
   select coalesce(jsonb_agg(jsonb_build_object('id',c.id,'ownerKey',c.owner_key,'name',c.name,'phone',c.phone) order by c.created_at,c.id),'[]')
   into v_contacts from public.client_family_contacts c join public.client_family_keys_v1(p_key) k on k.key=c.owner_key;
   return jsonb_build_object('rootKey',v_root,'revision',coalesce(v_revision,0),'members',v_members,'contacts',v_contacts);
 end
$$;

-- Resolve added phones only when there is one explicit family. Original phones
-- remain independent unless staff actually linked their client records.
create function public.client_family_phone_owner_v1(p_source text,p_phone text) returns uuid language plpgsql stable set search_path=public,pg_temp as $$
 declare v_phone text:=public.client_family_phone_key_v1(p_phone); v_roots text[]; v_root text; v_id uuid;
 begin
   if length(v_phone)<8 then return null; end if;
   select array_agg(distinct public.client_family_root_v1(x.key)) into v_roots from (
     select owner_key as key from public.client_family_contacts where phone_key=v_phone
     union select d.key from public.client_family_directory_v1 d join public.client_family_nodes n on n.key=d.key where d.phone_key=v_phone
   ) x;
   if coalesce(cardinality(v_roots),0)=0 then return null; end if;
   if cardinality(v_roots)>1 then raise exception 'FAMILY_PHONE_CONFLICT'; end if;
   v_root:=v_roots[1];
   -- Refuse a contact that was subsequently assigned to an unrelated master.
   if exists(select 1 from public.client_family_directory_v1 d where d.phone_key=v_phone and public.client_family_root_v1(d.key)<>v_root) then raise exception 'FAMILY_PHONE_CONFLICT'; end if;
   select d.client_id into v_id from public.client_family_directory_v1 d join public.client_family_keys_v1(v_root) k on k.key=d.key
   where d.source=p_source order by (d.key=v_root) desc,d.key limit 1;
   return v_id;
 end
$$;

create function public.client_family_search_v1(p_query text,p_source text default null) returns jsonb language sql stable set search_path=public,pg_temp as $$
 with matches as (
   select d.key from public.client_family_directory_v1 d
   where length(btrim(p_query)) between 1 and 180 and
    (upper(d.code)=upper(btrim(p_query)) or (length(public.client_family_phone_key_v1(p_query))>=8 and d.phone_key=public.client_family_phone_key_v1(p_query)) or position(lower(btrim(p_query)) in lower(d.name))>0)
   union
   select c.owner_key from public.client_family_contacts c
   where length(btrim(p_query)) between 1 and 180 and
    ((length(public.client_family_phone_key_v1(p_query))>=8 and c.phone_key=public.client_family_phone_key_v1(p_query)) or position(lower(btrim(p_query)) in lower(c.name))>0)
 ), roots as (select distinct public.client_family_root_v1(key) as root from matches), chosen as (
   select distinct on(r.root) d.*,r.root from roots r cross join lateral public.client_family_keys_v1(r.root) k
   join public.client_family_directory_v1 d on d.key=k.key
   where p_source is null or d.source=p_source
   order by r.root,(d.key=r.root) desc,d.key
 ) select coalesce(jsonb_agg(jsonb_build_object('key',s.key,'source',s.source,'clientId',s.client_id,'code',s.code,'name',s.name,'phone',s.phone,'family',public.client_family_snapshot_v1(s.key))),'[]')
 from (select * from chosen order by name,key limit 20) s
$$;

-- One transaction owns validation, optimistic concurrency, membership edits and
-- the idempotency receipt. The coarse lock is intentionally limited to these
-- infrequent edits; ordinary order/payment updates never need it.
create function public.client_family_mutate_v1(p_payload jsonb,p_actor uuid default null,p_public_key text default null) returns jsonb language plpgsql set search_path=public,pg_temp as $$
 declare
   v_action text:=p_payload->>'action'; v_key text:=p_payload->>'key';
   v_other text:=p_payload->>'otherKey'; v_root text; v_other_root text;
   v_snapshot jsonb; v_other_snapshot jsonb; v_result jsonb; v_prior public.client_family_operations%rowtype;
   v_request uuid:=(p_payload->>'requestId')::uuid; v_actor text; v_item jsonb; v_phone text; v_name text; v_contact uuid;
 begin
   if p_actor is null then
     if p_public_key is null or p_public_key is distinct from v_key or v_action<>'ADD_CONTACTS' then raise exception 'FAMILY_FORBIDDEN'; end if;
     v_actor:='link:'||p_public_key;
   else
     if not exists(select 1 from public.users where id=p_actor and is_active is distinct from false and upper(role) in ('ADMIN','MASTER','DISPATCH','TRANSPORT','PUNTOR','PRANIMI')) then raise exception 'FAMILY_FORBIDDEN'; end if;
     v_actor:='staff:'||p_actor::text;
   end if;
   if v_request is null then raise exception 'FAMILY_REQUEST_REQUIRED'; end if;
   perform pg_advisory_xact_lock(hashtextextended('client-family-mutations-v1',0));
   select * into v_prior from public.client_family_operations where request_id=v_request;
   if found then
     if v_prior.payload is distinct from p_payload or v_prior.actor<>v_actor then raise exception 'FAMILY_REQUEST_CONFLICT'; end if;
     return v_prior.result;
   end if;
   v_snapshot:=public.client_family_snapshot_v1(v_key); v_root:=v_snapshot->>'rootKey';
   if p_actor is not null and ((p_payload->>'expectedRoot') is distinct from v_root or (p_payload->>'expectedRevision')::bigint is distinct from (v_snapshot->>'revision')::bigint) then raise exception 'FAMILY_STALE'; end if;
   perform public.client_family_ensure_node_v1(v_key);
   perform public.client_family_ensure_node_v1(v_root);
   if v_action='MERGE' then
     if p_actor is null then raise exception 'FAMILY_FORBIDDEN'; end if;
     v_other_snapshot:=public.client_family_snapshot_v1(v_other); v_other_root:=v_other_snapshot->>'rootKey';
     if v_root=v_other_root then raise exception 'FAMILY_ALREADY_LINKED'; end if;
     if (p_payload->>'otherRoot') is distinct from v_other_root or (p_payload->>'otherRevision')::bigint is distinct from (v_other_snapshot->>'revision')::bigint then raise exception 'FAMILY_STALE'; end if;
     if jsonb_array_length(v_snapshot->'members')+jsonb_array_length(v_other_snapshot->'members')>50 then raise exception 'FAMILY_LIMIT'; end if;
     perform public.client_family_ensure_node_v1(v_other_root);
     update public.client_family_nodes set parent_key=v_root,revision=revision+1 where key=v_other_root;
   elsif v_action='UNLINK' then
     if p_actor is null then raise exception 'FAMILY_FORBIDDEN'; end if;
     if v_other=v_root or public.client_family_root_v1(v_other)<>v_root then raise exception 'FAMILY_LINK_INVALID'; end if;
     update public.client_family_nodes set parent_key=null,revision=revision+1 where key=v_other and parent_key is not null;
     if not found then raise exception 'FAMILY_LINK_INVALID'; end if;
   elsif v_action='ADD_CONTACTS' then
     if jsonb_typeof(p_payload->'contacts') is distinct from 'array' or jsonb_array_length(p_payload->'contacts') not between 1 and 10 then raise exception 'FAMILY_CONTACTS_INVALID'; end if;
     for v_item in select value from jsonb_array_elements(p_payload->'contacts') loop
       v_phone:=public.client_family_phone_key_v1(v_item->>'phone'); v_name:=btrim(v_item->>'name');
       if v_phone is null or v_phone !~ '^[0-9]{8,15}$' or jsonb_typeof(v_item->'name') is distinct from 'string' or jsonb_typeof(v_item->'phone') is distinct from 'string' or v_name is null or length(v_name) not between 1 and 180 or length(v_item->>'phone')>80 then raise exception 'FAMILY_CONTACT_INVALID'; end if;
       if exists(select 1 from public.client_family_directory_v1 d where d.phone_key=v_phone and public.client_family_root_v1(d.key)<>v_root)
         or exists(select 1 from public.client_family_contacts c where c.phone_key=v_phone and public.client_family_root_v1(c.owner_key)<>v_root) then raise exception 'FAMILY_PHONE_CONFLICT'; end if;
       -- Repeated submissions and alternate formatting never add the same number twice.
       if not exists(select 1 from public.client_family_contacts c join public.client_family_keys_v1(v_key) k on k.key=c.owner_key where c.phone_key=v_phone)
          and not exists(select 1 from public.client_family_directory_v1 d join public.client_family_keys_v1(v_key) k on k.key=d.key where d.phone_key=v_phone) then
         insert into public.client_family_contacts(owner_key,name,phone,phone_key) values(v_key,v_name,btrim(v_item->>'phone'),v_phone);
       end if;
     end loop;
     if (select count(*) from public.client_family_contacts c join public.client_family_keys_v1(v_key) k on k.key=c.owner_key)>100 then raise exception 'FAMILY_LIMIT'; end if;
   elsif v_action='REMOVE_CONTACT' then
     if p_actor is null then raise exception 'FAMILY_FORBIDDEN'; end if;
     v_contact:=(p_payload->>'contactId')::uuid;
     delete from public.client_family_contacts where id=v_contact and owner_key in(select key from public.client_family_keys_v1(v_key));
     if not found then raise exception 'FAMILY_CONTACT_NOT_FOUND'; end if;
   else raise exception 'FAMILY_ACTION_INVALID'; end if;
   update public.client_family_nodes set revision=revision+1 where key=v_root;
   v_result:=public.client_family_snapshot_v1(v_key);
   insert into public.client_family_operations(request_id,actor,payload,result) values(v_request,v_actor,p_payload,v_result);
   return v_result;
 end
$$;

-- No browser role may call mutation or read family phone lists directly.
do $$ declare f record; begin
 for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'client_family_%_v1' loop
  execute format('revoke all on function %s from public,anon,authenticated',f.sig);
  execute format('grant execute on function %s to service_role',f.sig);
 end loop;
end $$;

-- This pure text normalizer reads no records. Browser roles need it when
-- Postgres maintains the phone expression indexes on legacy master inserts.
grant execute on function public.client_family_phone_key_v1(text) to anon,authenticated;

-- Integrity check for old/offline admission clients too. A newly created master in
-- the other module joins an explicitly established family by its registered phone.
-- Master creation shares the family edit lock; ordinary order/payment updates do not.
create function public.client_family_new_master_v1() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
 declare v_source text:=case when tg_table_name='clients' then 'BASE' else 'TRANSPORT' end;
 v_phone text:=public.client_family_phone_key_v1(new.phone); v_roots text[]; v_root text; v_key text;
 begin
  if coalesce(length(v_phone),0)<8 then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended('client-family-mutations-v1',0));
  select array_agg(distinct public.client_family_root_v1(x.key)) into v_roots from (
    select owner_key as key from public.client_family_contacts where phone_key=v_phone
    union select d.key from public.client_family_directory_v1 d join public.client_family_nodes n on n.key=d.key where d.phone_key=v_phone
  ) x;
  if coalesce(cardinality(v_roots),0)=0 then return new; end if;
  if cardinality(v_roots)>1 then raise exception 'FAMILY_PHONE_CONFLICT'; end if;
  v_root:=v_roots[1]; v_key:=v_source||':'||new.id::text;
  if exists(select 1 from public.client_family_directory_v1 d join public.client_family_keys_v1(v_root) k on k.key=d.key where d.source=v_source) then
    raise exception 'FAMILY_PHONE_ALREADY_LINKED';
  end if;
  if (select count(*) from public.client_family_keys_v1(v_root))>=50 then raise exception 'FAMILY_LIMIT'; end if;
  perform public.client_family_ensure_node_v1(v_key);
  update public.client_family_nodes set parent_key=v_root where key=v_key;
  update public.client_family_nodes set revision=revision+1 where key=v_root;
  return new;
 end
$$;
revoke all on function public.client_family_new_master_v1() from public,anon,authenticated;
create trigger zz_client_family_new_master_v1 after insert on public.clients for each row execute function public.client_family_new_master_v1();
create trigger zz_client_family_new_master_v1 after insert on public.transport_clients for each row execute function public.client_family_new_master_v1();

-- Use the existing atomic allocator and UUID retry rules. Only the authenticated
-- server path consults family contacts. The submitted name/phone remain on the
-- visit, while master names are preserved for linked family records.
do $patch$
declare v_sql text; v_old text; v_new text;
begin
 v_sql:=pg_get_functiondef('public.create_transport_order(uuid,bigint,text,text,text,text,text,text,jsonb,text)'::regprocedure);
 if position('  v_client_match_count integer := 0;' in v_sql)=0 or position('if v_client_match_count>1 then' in v_sql)=0 or position('    perform public.ensure_transport_history_client_v1(p_client_phone);' in v_sql)=0 then raise exception 'FAMILY_CREATE_TRANSPORT_ANCHOR_CHANGED'; end if;
 v_sql:=replace(v_sql,'if v_client_match_count>1 then','if v_client_match_count>1 and (v_caller_role<>''service_role'' or public.client_family_phone_owner_v1(''TRANSPORT'',p_client_phone) is null) then');
 v_sql:=replace(v_sql,'  v_client_match_count integer := 0;','  v_client_match_count integer := 0;'||chr(10)||'  v_family_resolved boolean := false;');
 v_sql:=replace(v_sql,'if v_caller_role=''service_role'' then'||chr(10)||'    perform public.ensure_transport_history_client_v1(p_client_phone);','if v_caller_role=''service_role'' and public.client_family_phone_owner_v1(''TRANSPORT'',p_client_phone) is null then'||chr(10)||'    perform public.ensure_transport_history_client_v1(p_client_phone);');
 v_old:='  v_address:=nullif(btrim(p_address),'''');';
 v_new:=$block$
  -- CLIENT_FAMILY_ATOMIC_RESOLUTION_V1
  if v_caller_role='service_role' then
    declare v_family_client uuid;
    begin
      v_family_client:=public.client_family_phone_owner_v1('TRANSPORT',p_client_phone);
      v_family_resolved:=v_family_client is not null;
      if v_family_client is not null then
        select c.id,c.tcode,c.address,c.gps_lat,c.gps_lng into v_client_id,v_client_tcode,v_master_address,v_master_gps_lat,v_master_gps_lng
        from public.transport_clients c where c.id=v_family_client;
      end if;
    end;
  end if;
  v_address:=nullif(btrim(p_address),'');$block$;
 if position(v_old in v_sql)=0 then raise exception 'FAMILY_CREATE_TRANSPORT_ANCHOR_CHANGED'; end if;
 v_sql:=replace(v_sql,v_old,v_new);
 v_old:='    where id=v_client_id;';
 v_new:=$block$    where id=v_client_id
      and not v_family_resolved;$block$;
 -- This WHERE belongs only to the existing master-name update.
 if (length(v_sql)-length(replace(v_sql,v_old,'')))/length(v_old)<>1 then raise exception 'FAMILY_MASTER_NAME_ANCHOR_CHANGED'; end if;
 v_sql:=replace(v_sql,v_old,v_new);
 execute v_sql;
end $patch$;
-- The live Base order trigger historically resolves only the master phone and
-- overwrites the visit contact. Resolve explicit families before that legacy
-- path, keeping a selected alias and the exact contact for this visit.
do $base_patch$
declare v_sql text; v_old text; v_new text;
begin
 v_sql:=pg_get_functiondef('public.upsert_client_from_order()'::regprocedure);
 -- Use the complete, unique phone-normalization line as the guarded anchor.
 v_old:='  v_phone_key := public.normalize_kosovo_phone_v1(v_phone);';
 if (length(v_sql)-length(replace(v_sql,v_old,'')))/length(v_old)<>1
    or position('  if v_is_draft then return new; end if;' in v_sql)=0
    or position('  v_original_code bigint := new.code;' in v_sql)=0 then
   raise exception 'FAMILY_BASE_ORDER_ANCHOR_CHANGED';
 end if;
 v_new:=v_old||$block$
  -- CLIENT_FAMILY_BASE_ORDER_RESOLUTION_V1
  declare v_family_id uuid; v_selected_id uuid; v_selected_code text; v_key text; v_preserve_visit boolean:=false;
  begin
    -- A later unlink/contact removal must not block payment/status updates to
    -- an already persisted visit whose exact identity has not changed.
    if tg_op='UPDATE' then
      v_preserve_visit:=new.client_id is not distinct from old.client_id
        and new.code is not distinct from old.code
        and new.client_code is not distinct from old.client_code
        and new.client_name is not distinct from old.client_name
        and new.client_phone is not distinct from old.client_phone
        and exists(select 1 from public.client_family_nodes where key='BASE:'||old.client_id::text);
    end if;
    if v_preserve_visit then v_family_id:=old.client_id;
    else v_family_id:=public.client_family_phone_owner_v1('BASE',v_phone); end if;
    if v_family_id is not null then
      v_key:='BASE:'||v_family_id::text;
      v_selected_id:=new.client_id;
      if v_selected_id is null then
        select c.id into v_selected_id from public.clients c where c.code=v_requested_code;
      end if;
      v_selected_id:=coalesce(v_selected_id,v_family_id);
      if not exists(select 1 from public.client_family_keys_v1(v_key) k where k.key='BASE:'||v_selected_id::text) then
        raise exception 'FAMILY_SELECTED_CLIENT_CONFLICT';
      end if;
      select c.code into v_selected_code from public.clients c where c.id=v_selected_id;
      if v_selected_code is null or v_selected_code !~ '^[0-9]+$' then raise exception 'FAMILY_CLIENT_CODE_INVALID'; end if;
      new.client_id:=v_selected_id;
      new.client_code:=v_selected_code::integer;
      new.code:=v_selected_code::bigint;
      new.client_name:=coalesce(v_name,'PA EMER');
      new.client_phone:=v_phone;
      new.data:=coalesce(new.data,'{}'::jsonb)
        || jsonb_build_object('code',new.code,'client_code',new.client_code,'client_id',new.client_id::text,'client_master_id',new.client_id::text,'client_name',new.client_name,'client_phone',new.client_phone,'name',new.client_name,'phone',new.client_phone)
        || jsonb_build_object('client',coalesce(new.data->'client','{}'::jsonb)||jsonb_build_object('id',new.client_id::text,'code',new.client_code,'name',new.client_name,'phone',new.client_phone))
        || jsonb_build_object('identity_resolution',coalesce(new.data->'identity_resolution','{}'::jsonb)||jsonb_build_object('version','CLIENT_FAMILY_V1','resolved_at',now(),'original_order_code',v_original_code,'final_client_code',new.client_code));
      if jsonb_typeof(new.data->'order')='object' then
        new.data:=jsonb_set(new.data,'{order}',coalesce(new.data->'order','{}'::jsonb)||jsonb_build_object('code',new.code,'client_code',new.client_code,'client_id',new.client_id::text,'client_name',new.client_name,'client_phone',new.client_phone,'name',new.client_name,'phone',new.client_phone,'client',coalesce(new.data->'order'->'client','{}'::jsonb)||jsonb_build_object('id',new.client_id::text,'code',new.client_code,'name',new.client_name,'phone',new.client_phone)),true);
      end if;
      return new;
    end if;
  end;
$block$;
 execute replace(v_sql,v_old,v_new);
end $base_patch$;
notify pgrst,'reload schema';
commit;
