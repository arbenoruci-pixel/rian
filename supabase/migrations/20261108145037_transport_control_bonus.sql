-- Independent transport inspection, paid through the existing atomic bonus/handoff ledger.
create table public.transport_controls (
 id uuid primary key default gen_random_uuid(), order_id uuid not null unique references public.transport_orders(id),
 worker_id uuid not null references public.users(id) check(worker_id='19d3ab97-2067-493a-aeb1-8a23572dc5f8'::uuid),
 status text not null default 'DRAFT' check(status in ('DRAFT','PENDING','RETURNED','APPROVED')),
 attempt_id uuid not null, original_snapshot jsonb not null, proposed_rows jsonb not null,
 physical_count integer not null check(physical_count between 1 and 10000), note text not null default '',
 photos jsonb not null, history jsonb not null default '[]', approved_snapshot jsonb,
 created_at timestamptz not null default clock_timestamp(), updated_at timestamptz not null default clock_timestamp(),
 submitted_at timestamptz, reviewed_at timestamptz, reviewed_by uuid references public.users(id), review_note text not null default '', files_deleted_at timestamptz
);
alter table public.transport_controls enable row level security;
revoke all on public.transport_controls from public,anon,authenticated;
grant all on public.transport_controls to service_role;
create index transport_controls_status_idx on public.transport_controls(status,submitted_at);
create index transport_controls_worker_idx on public.transport_controls(worker_id);
create index transport_controls_reviewer_idx on public.transport_controls(reviewed_by);
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
 values('transport-control-evidence','transport-control-evidence',false,2097152,array['image/jpeg']);
create policy transport_control_no_direct_access on storage.objects as restrictive for all to anon,authenticated
 using(bucket_id<>'transport-control-evidence') with check(bucket_id<>'transport-control-evidence');

alter table public.base_ready_bonuses add column transport_control_id uuid unique references public.transport_controls(id);
alter table public.base_ready_bonuses alter column order_id drop not null;
alter table public.base_ready_bonuses add constraint bonus_exactly_one_source check(num_nonnulls(order_id,transport_control_id)=1);

create function public.transport_control_snapshot_v1(d jsonb) returns jsonb language sql immutable set search_path='' as $$
 select jsonb_build_object('tepiha',coalesce(d->'tepiha',d->'tepihaRows','[]'), 'staza',coalesce(d->'staza',d->'stazaRows','[]'),
  'shkallore',coalesce(d->'shkallore','{"qty":0,"per":0.3}'), 'rate',coalesce((d->'pay'->>'rate')::numeric,1.8), 'pay_m2',(d->'pay'->>'m2')::numeric,'pay_euro',(d->'pay'->>'euro')::numeric,
  'totals',jsonb_build_object('pieces',d->'pieces','cope',d->'cope','m2',d->'m2','m2_total',d->'m2_total','totalM2',d->'totalM2','total_m2',d->'total_m2','total',d->'total','totalEuro',d->'totalEuro','total_eur',d->'total_eur','price_total',d->'price_total'));
$$;
create function public.transport_control_rows_v1(d jsonb) returns jsonb language sql immutable set search_path='' as $$
 select coalesce(jsonb_agg(jsonb_build_array(kind,qty,area) order by kind,pos),'[]') from (
  select 'tepiha'::text kind,ord pos,coalesce((r->>'qty')::numeric,1) qty,coalesce((r->>'m2')::numeric,0) area from jsonb_array_elements(coalesce(d->'tepiha',d->'tepihaRows','[]')) with ordinality t(r,ord)
  union all select 'staza',ord,coalesce((r->>'qty')::numeric,1),coalesce((r->>'m2')::numeric,0) from jsonb_array_elements(coalesce(d->'staza',d->'stazaRows','[]')) with ordinality t(r,ord)
  union all select 'shkallore',1,coalesce((d->'shkallore'->>'qty')::numeric,0),coalesce((d->'shkallore'->>'per')::numeric,0.3) where coalesce((d->'shkallore'->>'qty')::numeric,0)>0
 ) s;
$$;
create function public.transport_control_prepare_v1(p_order_id uuid,p_actor_id uuid,p_attempt_id uuid,p_expected jsonb,p_rows jsonb,p_count integer,p_note text,p_hashes jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare o public.transport_orders%rowtype; c public.transport_controls%rowtype; row jsonb; photo jsonb; manifest jsonb:='[]'; n integer:=0; pieces integer:=0; q numeric; a numeric; snapshot jsonb;
begin
 if p_actor_id<>'19d3ab97-2067-493a-aeb1-8a23572dc5f8'::uuid or not exists(select 1 from public.users where id=p_actor_id and is_active is true) then raise exception 'CONTROL_BUJAR_ONLY'; end if;
 if p_attempt_id is null then raise exception 'CONTROL_ATTEMPT_REQUIRED'; end if;
 select * into o from public.transport_orders where id=p_order_id for update;
 if not found then raise exception 'CONTROL_ORDER_NOT_FOUND'; end if;
 select * into c from public.transport_controls where order_id=o.id for update;
 if c.status in ('PENDING','APPROVED') then return to_jsonb(c); end if;
 if c.attempt_id=p_attempt_id then return to_jsonb(c); end if;
 if o.status not in ('pastrim','gati') then raise exception 'CONTROL_ORDER_NOT_AT_BASE'; end if;
 snapshot:=public.transport_control_snapshot_v1(o.data);
 if snapshot is distinct from p_expected then raise exception 'CONTROL_ORDER_CHANGED'; end if;
 if jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows) not between 1 and 100 then raise exception 'CONTROL_ITEMS_REQUIRED'; end if;
 for row in select value from jsonb_array_elements(p_rows) loop
  q:=(row->>'qty')::numeric; a:=(row->>'m2')::numeric;
  if q is null or q<>trunc(q) or q not between 1 and 100 or a is null or a<=0 or a>500 or row->>'kind' not in ('tepiha','staza','shkallore') or nullif(row->>'id','') is null then raise exception 'CONTROL_MEASUREMENTS_INVALID'; end if;
  pieces:=pieces+q::integer;
 end loop;
 if (select count(distinct value->>'id') from jsonb_array_elements(p_rows))<>jsonb_array_length(p_rows) or (select count(*) from jsonb_array_elements(p_rows) where value->>'kind'='shkallore')>1 then raise exception 'CONTROL_MEASUREMENTS_INVALID'; end if;
 if p_count is null or p_count<>pieces then raise exception 'CONTROL_COUNT_MISMATCH'; end if;
 if jsonb_typeof(p_hashes)<>'array' or jsonb_array_length(p_hashes) not between 1 and 6 then raise exception 'CONTROL_PHOTOS_REQUIRED'; end if;
 if (select count(distinct value#>>'{}') from jsonb_array_elements(p_hashes))<>jsonb_array_length(p_hashes) then raise exception 'CONTROL_DUPLICATE_PHOTO'; end if;
 if c.id is null then c.id:=gen_random_uuid(); end if;
 for photo in select value from jsonb_array_elements(p_hashes) loop
  if (photo#>>'{}') !~ '^[a-f0-9]{64}$' then raise exception 'CONTROL_PHOTO_INVALID'; end if;
  manifest:=manifest||jsonb_build_array(jsonb_build_object('path',concat(p_actor_id,'/',c.id,'/',p_attempt_id,'/',n,'.jpg'),'hash',photo#>>'{}')); n:=n+1;
 end loop;
 if length(coalesce(p_note,''))>500 then raise exception 'CONTROL_NOTE_INVALID'; end if;
 if c.order_id is null then
  insert into public.transport_controls(id,order_id,worker_id,attempt_id,original_snapshot,proposed_rows,physical_count,note,photos)
   values(c.id,o.id,p_actor_id,p_attempt_id,snapshot,p_rows,p_count,coalesce(p_note,''),manifest) returning * into c;
 else
  update public.transport_controls set history=history||jsonb_build_array(to_jsonb(c)-'history'),status='DRAFT',attempt_id=p_attempt_id,original_snapshot=snapshot,proposed_rows=p_rows,physical_count=p_count,note=coalesce(p_note,''),photos=manifest,submitted_at=null,reviewed_at=null,reviewed_by=null,review_note='',updated_at=clock_timestamp(),files_deleted_at=null
   where id=c.id returning * into c;
 end if;
 return to_jsonb(c);
end $$;

create function public.transport_control_submit_v1(p_control_id uuid,p_actor_id uuid,p_attempt_id uuid)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare c public.transport_controls%rowtype; o public.transport_orders%rowtype; ph jsonb;
begin
 select * into c from public.transport_controls where id=p_control_id;
 if c.id is null then raise exception 'CONTROL_NOT_FOUND'; end if;
 select * into o from public.transport_orders where id=c.order_id for update;
 select * into c from public.transport_controls where id=p_control_id for update;
 if c.worker_id<>p_actor_id or not exists(select 1 from public.users where id=p_actor_id and is_active is true) then raise exception 'CONTROL_FORBIDDEN'; end if;
 if c.attempt_id<>p_attempt_id then raise exception 'CONTROL_ATTEMPT_CHANGED'; end if;
 if c.status in ('PENDING','APPROVED') then return to_jsonb(c); end if;
 if c.status<>'DRAFT' then raise exception 'CONTROL_REVIEW_CONFLICT'; end if;
 if o.status not in ('pastrim','gati') or public.transport_control_snapshot_v1(o.data) is distinct from c.original_snapshot then raise exception 'CONTROL_ORDER_CHANGED'; end if;
 for ph in select value from jsonb_array_elements(c.photos) order by value->>'hash' loop
  perform pg_advisory_xact_lock(hashtextextended(ph->>'hash',0));
  if not exists(select 1 from storage.objects where bucket_id='transport-control-evidence' and name=ph->>'path') then raise exception 'CONTROL_PHOTOS_REQUIRED'; end if;
  if exists(select 1 from public.transport_controls x where x.id<>c.id and (x.photos @> jsonb_build_array(jsonb_build_object('hash',ph->>'hash')) or exists(select 1 from jsonb_array_elements(x.history) h where h->'photos' @> jsonb_build_array(jsonb_build_object('hash',ph->>'hash'))))) then raise exception 'CONTROL_DUPLICATE_PHOTO'; end if;
 end loop;
 update public.transport_controls set status='PENDING',submitted_at=clock_timestamp(),updated_at=clock_timestamp() where id=c.id returning * into c;
 return to_jsonb(c);
end $$;

create function public.transport_control_review_v1(p_control_id uuid,p_actor_id uuid,p_attempt_id uuid,p_decision text,p_note text default '')
returns jsonb language plpgsql security invoker set search_path='' as $$
declare c public.transport_controls%rowtype; o public.transport_orders%rowtype; u public.users%rowtype; reviewer public.users%rowtype; b public.base_ready_bonuses%rowtype; pid bigint; d jsonb; items jsonb; stairs jsonb; area numeric; price numeric; changed boolean; t timestamptz:=clock_timestamp();
begin
 select * into reviewer from public.users where id=p_actor_id and is_active is true;
 if reviewer.id is null or reviewer.id='19d3ab97-2067-493a-aeb1-8a23572dc5f8'::uuid or upper(reviewer.role) not in ('DISPATCH','ADMIN','ADMIN_MASTER','OWNER','PRONAR','SUPERADMIN') then raise exception 'CONTROL_REVIEW_FORBIDDEN'; end if;
 if p_decision not in ('APPROVED','RETURNED') then raise exception 'CONTROL_DECISION_INVALID'; end if;
 select * into c from public.transport_controls where id=p_control_id;
 if c.id is null then raise exception 'CONTROL_NOT_FOUND'; end if;
 select * into o from public.transport_orders where id=c.order_id for update;
 select * into c from public.transport_controls where id=p_control_id for update;
 if c.attempt_id<>p_attempt_id then raise exception 'CONTROL_ATTEMPT_CHANGED'; end if;
 if c.status=p_decision then return to_jsonb(c); end if;
 if c.status<>'PENDING' then raise exception 'CONTROL_REVIEW_CONFLICT'; end if;
 if p_decision='RETURNED' then
  if length(btrim(coalesce(p_note,'')))<3 then raise exception 'CONTROL_REASON_REQUIRED'; end if;
  update public.transport_controls set status='RETURNED',reviewed_at=t,reviewed_by=p_actor_id,review_note=left(p_note,500),updated_at=t where id=c.id returning * into c;
  return to_jsonb(c);
 end if;
 if o.status not in ('pastrim','gati') or public.transport_control_snapshot_v1(o.data) is distinct from c.original_snapshot then raise exception 'CONTROL_ORDER_CHANGED'; end if;
 d:=coalesce(o.data,'{}');
 select coalesce(jsonb_agg(jsonb_build_object('id',r->>'id','m2',r->>'m2','qty',r->>'qty') order by pos),'[]') into items from jsonb_array_elements(c.proposed_rows) with ordinality x(r,pos) where r->>'kind'='tepiha'; d:=jsonb_set(d,'{tepiha}',items);
 select coalesce(jsonb_agg(jsonb_build_object('id',r->>'id','m2',r->>'m2','qty',r->>'qty') order by pos),'[]') into items from jsonb_array_elements(c.proposed_rows) with ordinality x(r,pos) where r->>'kind'='staza'; d:=jsonb_set(d,'{staza}',items);
 select jsonb_build_object('qty',(r->>'qty')::numeric,'per',(r->>'m2')::numeric) into stairs from jsonb_array_elements(c.proposed_rows) r where r->>'kind'='shkallore'; d:=jsonb_set(d,'{shkallore}',coalesce(stairs,'{"qty":0,"per":0.3}'));
 changed:=public.transport_control_rows_v1(d) is distinct from public.transport_control_rows_v1(o.data);
 if changed and length(btrim(c.note))<3 then raise exception 'CONTROL_REASON_REQUIRED'; end if;
 if changed then
  if coalesce((o.data->'pay'->>'paid')::numeric,0)>0 or exists(select 1 from public.arka_pending_payments where transport_order_id=o.id and type='TRANSPORT' and status<>'VOIDED') then raise exception 'CONTROL_PAID_ORDER_REVIEW_REQUIRED'; end if;
  select round(sum((r->>'qty')::numeric*(r->>'m2')::numeric),2) into area from jsonb_array_elements(c.proposed_rows) r;
  price:=round(area*(c.original_snapshot->>'rate')::numeric,2);
  d:=d-'tepihaRows'-'stazaRows';
  d:=d||jsonb_build_object('pieces',c.physical_count,'cope',c.physical_count,'m2',area,'m2_total',area,'totalM2',area,'total_m2',area,'total',price,'totalEuro',price,'total_eur',price,'price_total',price,
   'pay',coalesce(o.data->'pay','{}')||jsonb_build_object('m2',area,'euro',price,'debt',price), 'transport_control_id',c.id);
  update public.transport_orders set data=d,updated_at=t where id=o.id returning * into o;
 end if;
 update public.transport_controls set status='APPROVED',approved_snapshot=public.transport_control_snapshot_v1(o.data),reviewed_at=t,reviewed_by=p_actor_id,review_note=left(coalesce(p_note,''),500),updated_at=t where id=c.id returning * into c;
 select * into u from public.users where id=c.worker_id and is_active is true;
 if u.id is null then raise exception 'CONTROL_WORKER_INACTIVE'; end if;
 insert into public.base_ready_bonuses(order_id,transport_control_id,worker_pin,worker_name,worker_role,m2,rate_m2,amount,entered_at,ready_at,eligible,status,remaining_amount,reserved_amount,retained_amount,idempotency_key,reason,metadata,activated_at,activation_source,qualification_source,qualification_at)
 values(null,c.id,u.pin,u.name,u.role,0,0,0.50,c.created_at,t,true,'EARNED',0.50,0,0,concat('TRANSPORT_CONTROL:',c.id),'TRANSPORT_CONTROL_APPROVED',jsonb_build_object('source_module','TRANSPORT_CONTROL','transport_order_id',o.id,'transport_code',o.code_str),t,'DISPATCH_CONTROL','TRANSPORT_CONTROL',t)
 returning * into b;
 insert into public.arka_pending_payments(order_id,transport_order_id,transport_code_str,amount,type,status,note,client_name,created_by_pin,created_by_name,approved_by_pin,approved_by_name,handoff_note,source_module,idempotency_key,created_at,updated_at)
 values(null,o.id,o.code_str,0.50,'READY_48H_BONUS','ACCEPTED_BY_DISPATCH',concat('KONTROLL TRANSPORTI • ',o.code_str,' • 0.50 €'),o.client_name,u.pin,u.name,reviewer.pin,reviewer.name,concat('READY_BONUS_OPEN:',b.id),'TRANSPORT_CONTROL',concat('TRANSPORT_CONTROL:',c.id),t,t) returning id into pid;
 update public.base_ready_bonuses set arka_payment_id=pid where id=b.id;
 return to_jsonb(c);
end $$;

-- Keep the existing BASE branch intact. A real approved inspection is required for fixed bonuses.
create or replace function public.enforce_bujar_only_base_bonus_v1() returns trigger language plpgsql security definer set search_path='public','pg_temp' as $$
declare v_bujar_pin text;
begin
 select pin into v_bujar_pin from public.users where id='19d3ab97-2067-493a-aeb1-8a23572dc5f8' and is_active is true limit 1;
 if coalesce(new.worker_pin,'')<>coalesce(v_bujar_pin,'__NO_BUJAR__') then
  new.eligible:=false;new.amount:=0;new.remaining_amount:=0;new.reserved_amount:=0;new.retained_amount:=0;new.status:='INELIGIBLE';new.reason:='WORKER_NOT_EXCLUSIVE_BUJAR';
 elsif new.transport_control_id is not null then
  if new.order_id is not null or not exists(select 1 from public.transport_controls where id=new.transport_control_id and status='APPROVED' and worker_id='19d3ab97-2067-493a-aeb1-8a23572dc5f8') then raise exception 'CONTROL_APPROVAL_REQUIRED'; end if;
  new.worker_name:='bujar oruqi';new.m2:=0;new.rate_m2:=0;new.amount:=0.50;
  new.remaining_amount:=greatest(0,0.50-coalesce(new.reserved_amount,0)-coalesce(new.retained_amount,0));
 else
  new.worker_name:='bujar oruqi';new.rate_m2:=0.10;
  if coalesce(new.eligible,false) then new.amount:=round(coalesce(new.m2,0)*0.10,2);new.remaining_amount:=greatest(0,new.amount-coalesce(new.reserved_amount,0)-coalesce(new.retained_amount,0)); end if;
 end if;
 return new;
end $$;

create function public.transport_control_guard_v1() returns trigger language plpgsql security definer set search_path='' as $$
declare area numeric; price numeric; pieces numeric; k text; expected numeric; actual numeric;
begin
 if not exists(select 1 from public.transport_controls where order_id=old.id and status='APPROVED') then return new; end if;
 if public.transport_control_rows_v1(new.data) is distinct from public.transport_control_rows_v1(old.data)
  or coalesce((new.data->'pay'->>'rate')::numeric,1.8)<>coalesce((old.data->'pay'->>'rate')::numeric,1.8) then raise exception 'CONTROL_APPROVED_MEASUREMENTS_LOCKED'; end if;
 select round(sum((r->>1)::numeric*(r->>2)::numeric),2),sum((r->>1)::numeric) into area,pieces from jsonb_array_elements(public.transport_control_rows_v1(old.data)) r;
 price:=round(area*coalesce((old.data->'pay'->>'rate')::numeric,1.8),2);
 -- Payment screens may normalize numeric strings or populate equivalent totals.
 -- Keep the approved financial values while permitting those normal updates.
 foreach k in array array['m2','euro'] loop
  expected:=coalesce((old.data->'pay'->>k)::numeric,case when k='m2' then area else price end);
  actual:=coalesce((new.data->'pay'->>k)::numeric,expected);
  if actual<>expected then raise exception 'CONTROL_APPROVED_MEASUREMENTS_LOCKED'; end if;
  if old.data->'pay' ? k and not (coalesce(new.data->'pay','{}') ? k) then new.data:=jsonb_set(new.data,'{pay}',coalesce(new.data->'pay','{}')||jsonb_build_object(k,old.data->'pay'->k)); end if;
 end loop;
 foreach k in array array['pieces','cope','m2','m2_total','totalM2','total_m2','total','totalEuro','total_eur','price_total'] loop
  expected:=coalesce((old.data->>k)::numeric,case when k in ('pieces','cope') then pieces when k in ('m2','m2_total','totalM2','total_m2') then area else price end);
  actual:=coalesce((new.data->>k)::numeric,expected);
  if actual<>expected then raise exception 'CONTROL_APPROVED_MEASUREMENTS_LOCKED'; end if;
  if old.data ? k and not (new.data ? k) then new.data:=jsonb_set(new.data,array[k],old.data->k); end if;
 end loop;
 return new;
end $$;
create trigger trg_zzzzzz_transport_control_guard before update of data on public.transport_orders for each row execute function public.transport_control_guard_v1();
revoke all on function public.transport_control_prepare_v1(uuid,uuid,uuid,jsonb,jsonb,integer,text,jsonb), public.transport_control_submit_v1(uuid,uuid,uuid), public.transport_control_review_v1(uuid,uuid,uuid,text,text), public.transport_control_guard_v1() from public,anon,authenticated;
grant execute on function public.transport_control_prepare_v1(uuid,uuid,uuid,jsonb,jsonb,integer,text,jsonb), public.transport_control_submit_v1(uuid,uuid,uuid), public.transport_control_review_v1(uuid,uuid,uuid,text,text) to service_role;
