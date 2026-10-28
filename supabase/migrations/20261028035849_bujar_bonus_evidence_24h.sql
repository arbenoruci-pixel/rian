-- Bujar / BASE only. Media lives in private Storage; the database keeps audit metadata.
create schema if not exists private;
create table public.base_bonus_extensions (
  id uuid primary key default gen_random_uuid(),
  order_id bigint not null unique,
  worker_id uuid not null references public.users(id),
  status text not null default 'DRAFT' check(status in ('DRAFT','PENDING','APPROVED','REJECTED','EXPIRED','CANCELLED')),
  shelf text not null,
  created_at timestamptz not null default clock_timestamp(),
  original_deadline timestamptz not null,
  extended_deadline timestamptz not null,
  submitted_at timestamptz,
  reviewed_at timestamptz,
  reviewed_by uuid references public.users(id),
  review_note text not null default '',
  collected_at timestamptz,
  carpet_path text not null,
  message_path text not null,
  carpet_hash text,
  message_hash text,
  cleanup_due_at timestamptz,
  files_deleted_at timestamptz,
  last_cleanup_at timestamptz,
  upload_expires_at timestamptz not null default (clock_timestamp() + interval '2 hours'),
  constraint base_bonus_extension_bujar check(worker_id='19d3ab97-2067-493a-aeb1-8a23572dc5f8'::uuid),
  constraint base_bonus_extension_fixed_24h check(extended_deadline=original_deadline+interval '24 hours'),
  constraint base_bonus_extension_timely check(submitted_at is null or submitted_at<=original_deadline)
);
alter table public.base_bonus_extensions enable row level security;
revoke all on public.base_bonus_extensions from public,anon,authenticated;
grant all on public.base_bonus_extensions to service_role;
create index base_bonus_extension_review_idx on public.base_bonus_extensions(submitted_at) where status='PENDING';
create index base_bonus_extension_cleanup_idx on public.base_bonus_extensions(cleanup_due_at) where cleanup_due_at is not null;
create index base_bonus_extension_reviewer_idx on public.base_bonus_extensions(reviewed_by);
create index base_bonus_extension_worker_idx on public.base_bonus_extensions(worker_id);

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('base-bonus-evidence','base-bonus-evidence',false,2097152,array['image/jpeg']);
-- Existing permissive policies for older buckets must never expose this bucket.
create policy base_bonus_evidence_no_direct_access on storage.objects as restrictive
for all to anon,authenticated using(bucket_id<>'base-bonus-evidence') with check(bucket_id<>'base-bonus-evidence');

create or replace function public.bujar_bonus_evidence_prepare_v1(p_order_id bigint,p_actor_id uuid,p_shelf text)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare o public.orders%rowtype; r public.base_bonus_extensions%rowtype; t timestamptz:=clock_timestamp(); new_id uuid:=gen_random_uuid();
begin
  if p_actor_id<>'19d3ab97-2067-493a-aeb1-8a23572dc5f8'::uuid or not exists(select 1 from public.users where id=p_actor_id and is_active is true and upper(role) in ('PUNTOR','PUNETOR','WORKER','BAZIST','BASE')) then raise exception 'BONUS_EVIDENCE_BUJAR_ONLY'; end if;
  if not (p_shelf ~ '^A([1-9]|[1-4][0-9]|50)$' or p_shelf ~ '^B([1-9]|1[0-9]|20)$' or p_shelf ~ '^FURRA_(POSHT|NALT)_A([1-9]|[1-3][0-9]|40)$') then raise exception 'BONUS_EVIDENCE_SHELF_REQUIRED'; end if;
  select * into o from public.orders where id=p_order_id for update;
  if not found then raise exception 'BONUS_EVIDENCE_ORDER_NOT_FOUND'; end if;
  select * into r from public.base_bonus_extensions where order_id=o.id for update;
  if found and r.status<>'DRAFT' then return to_jsonb(r); end if;
  if o.created_at is null or o.created_at>t or t>o.created_at+interval '72 hours' then raise exception 'BONUS_EVIDENCE_DEADLINE_PASSED'; end if;
  if lower(o.status)<>'gati' or o.ready_at is null then raise exception 'BONUS_EVIDENCE_READY_REQUIRED'; end if;
  if exists(select 1 from public.base_ready_bonuses where order_id=o.id and eligible is true) then raise exception 'BONUS_EVIDENCE_ALREADY_EARNED'; end if;
  if not exists(select 1 from public.base_ready_bonus_config where id=1 and enabled is true and window_hours=72) then raise exception 'BONUS_EVIDENCE_PROGRAM_UNAVAILABLE'; end if;
  if r.id is null then
    insert into public.base_bonus_extensions(id,order_id,worker_id,shelf,original_deadline,extended_deadline,carpet_path,message_path)
    values(new_id,o.id,p_actor_id,p_shelf,o.created_at+interval '72 hours',o.created_at+interval '96 hours',concat(p_actor_id,'/',new_id,'/carpet.jpg'),concat(p_actor_id,'/',new_id,'/message.jpg')) returning * into r;
  else
    update public.base_bonus_extensions set shelf=p_shelf,upload_expires_at=t+interval '2 hours' where id=r.id returning * into r;
  end if;
  return to_jsonb(r);
end $$;

create or replace function public.bujar_bonus_evidence_submit_v1(p_request_id uuid,p_actor_id uuid,p_carpet_hash text,p_message_hash text)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare o public.orders%rowtype; r public.base_bonus_extensions%rowtype; oid bigint; n integer; t timestamptz:=clock_timestamp();
begin
  if p_actor_id<>'19d3ab97-2067-493a-aeb1-8a23572dc5f8'::uuid or not exists(select 1 from public.users where id=p_actor_id and is_active is true) then raise exception 'BONUS_EVIDENCE_BUJAR_ONLY'; end if;
  select order_id into oid from public.base_bonus_extensions where id=p_request_id;
  select * into o from public.orders where id=oid for update;
  select * into r from public.base_bonus_extensions where id=p_request_id for update;
  if r.id is null or r.worker_id<>p_actor_id then raise exception 'BONUS_EVIDENCE_NOT_FOUND'; end if;
  if r.status<>'DRAFT' then return to_jsonb(r); end if;
  if t>r.original_deadline then raise exception 'BONUS_EVIDENCE_DEADLINE_PASSED'; end if;
  if o.id is null or lower(o.status)<>'gati' or o.ready_at is null or o.ready_at>t then raise exception 'BONUS_EVIDENCE_READY_REQUIRED'; end if;
  if p_carpet_hash is null or p_message_hash is null or p_carpet_hash !~ '^[a-f0-9]{64}$' or p_message_hash !~ '^[a-f0-9]{64}$' or p_carpet_hash=p_message_hash then raise exception 'BONUS_EVIDENCE_TWO_PHOTOS_REQUIRED'; end if;
  select count(*) into n from storage.objects where bucket_id='base-bonus-evidence' and name in (r.carpet_path,r.message_path)
    and metadata->>'mimetype'='image/jpeg' and (metadata->>'size')::bigint between 100 and 2097152;
  if n<>2 then raise exception 'BONUS_EVIDENCE_TWO_PHOTOS_REQUIRED'; end if;
  update public.base_bonus_extensions set status='PENDING',submitted_at=t,carpet_hash=p_carpet_hash,message_hash=p_message_hash where id=r.id returning * into r;
  return to_jsonb(r);
end $$;

-- Called only for an order with submitted evidence. Original award paths remain intact for all others.
create or replace function private.bujar_bonus_evidence_reconcile_v1(p_order_id bigint)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  o public.orders%rowtype; r public.base_bonus_extensions%rowtype; u public.users%rowtype;
  b public.base_ready_bonuses%rowtype; pay public.arka_pending_payments%rowtype; bp public.arka_pending_payments%rowtype;
  cfg public.base_ready_bonus_config%rowtype; finished timestamptz; area numeric; amount_due numeric; minutes integer; idem text;
begin
  select * into o from public.orders where id=p_order_id for update;
  select * into r from public.base_bonus_extensions where order_id=p_order_id for update;
  if o.id is null or r.id is null then return jsonb_build_object('ok',false,'reason','ORDER_NOT_FOUND'); end if;
  select * into b from public.base_ready_bonuses where order_id=o.id for update;
  if b.id is not null and (b.eligible or b.amount>0 or b.reserved_amount>0 or b.retained_amount>0) then
    return jsonb_build_object('ok',true,'alreadyApplied',true,'activated',b.eligible,'bonus',to_jsonb(b),'order',to_jsonb(o));
  end if;
  if lower(o.status)<>'dorzim' or r.collected_at is null or not coalesce((public.base_ready_payment_state_v2(o.id)->>'fully_paid')::boolean,false) then
    return jsonb_build_object('ok',true,'activated',false,'reason','WAITING_DELIVERY_AND_FULL_PAYMENT','order',to_jsonb(o));
  end if;
  select * into pay from public.arka_pending_payments where order_id=o.id and upper(type)='IN' and upper(source_module)='BASE' and amount>0
    and upper(status) in ('PENDING','COLLECTED','HANDED','PENDING_DISPATCH_APPROVAL','ACCEPTED_BY_DISPATCH','APPROVED','ACCEPTED') order by created_at desc,id desc limit 1;
  if pay.id is null then return jsonb_build_object('ok',true,'activated',false,'reason','BASE_PAYMENT_ROW_NOT_FOUND'); end if;
  finished:=greatest(r.collected_at,pay.created_at);
  if finished>r.original_deadline and r.status='PENDING' then return jsonb_build_object('ok',true,'activated',false,'reason','WAITING_EXTENSION_APPROVAL'); end if;
  if finished>r.original_deadline and (r.status<>'APPROVED' or finished>r.extended_deadline) then return jsonb_build_object('ok',true,'activated',false,'reason','BONUS_EXTENSION_DEADLINE_PASSED'); end if;
  select * into u from public.users where id=r.worker_id and is_active is true;
  select * into cfg from public.base_ready_bonus_config where id=1;
  if u.id is null or not coalesce(cfg.enabled,false) or finished<cfg.effective_from then return jsonb_build_object('ok',true,'activated',false,'reason','BONUS_DISABLED'); end if;
  area:=round(coalesce(public.tepiha_daily_order_m2(o.data,o.m2_total),0)::numeric,2);
  amount_due:=round(area*0.10,2);
  if amount_due<=0 then return jsonb_build_object('ok',true,'activated',false,'reason','BASE_READY_M2_REQUIRED'); end if;
  minutes:=greatest(0,floor(extract(epoch from (finished-o.created_at))/60)::integer);
  idem:=concat('BASE_READY_48H_BONUS:',o.id);
  if b.id is not null then
    -- Only a zero, unsettled result for this same order may be reconciled after a delayed review.
    if b.status<>'INELIGIBLE' or b.arka_payment_id is not null then return jsonb_build_object('ok',true,'activated',false,'reason','EXISTING_BONUS_REQUIRES_REVIEW'); end if;
    update public.base_ready_bonuses set worker_pin=u.pin,worker_name=u.name,worker_role=u.role,m2=area,rate_m2=0.10,amount=amount_due,eligible=true,status='EARNED',remaining_amount=amount_due,
      ready_at=finished,elapsed_minutes=minutes,activated_at=finished,activation_payment_id=pay.id,activation_source='PAYMENT_DIRECT',qualification_source='PAYMENT',qualification_at=finished,payment_id=pay.id,
      reason='ELIGIBLE_BUJAR_EVIDENCE_24H',metadata=coalesce(metadata,'{}')||jsonb_build_object('extension_request_id',r.id,'version','bujar-evidence-24h-v1'),updated_at=clock_timestamp()
    where id=b.id returning * into b;
  else
    insert into public.base_ready_bonuses(order_id,order_code,worker_pin,worker_name,worker_role,m2,rate_m2,amount,entered_at,ready_at,elapsed_minutes,eligible,status,remaining_amount,reserved_amount,retained_amount,idempotency_key,reason,metadata,activated_at,activation_payment_id,activation_source,qualification_source,qualification_at,payment_id,created_at,updated_at)
    values(o.id,o.code,u.pin,u.name,u.role,area,0.10,amount_due,o.created_at,finished,minutes,true,'EARNED',amount_due,0,0,idem,'ELIGIBLE_BUJAR_EVIDENCE_24H',jsonb_build_object('extension_request_id',r.id,'version','bujar-evidence-24h-v1'),finished,pay.id,'PAYMENT_DIRECT','PAYMENT',finished,pay.id,clock_timestamp(),clock_timestamp()) returning * into b;
  end if;
  insert into public.arka_pending_payments(order_id,amount,type,status,note,client_name,client_phone,order_code,created_by_pin,created_by_name,approved_by_pin,approved_by_name,handoff_note,source_module,idempotency_key,created_at,updated_at)
  values(o.id,amount_due,'READY_48H_BONUS','ACCEPTED_BY_DISPATCH',concat('BONUS BAZA 72H + PROVA 24H • #',o.code,' • ',area,' m²'),o.client_name,o.client_phone,o.code,u.pin,u.name,'SYSTEM','BONUS BAZA',concat('READY_BONUS_OPEN:',b.id),'ARKA',idem,finished,clock_timestamp())
  on conflict(idempotency_key) where idempotency_key is not null do nothing returning * into bp;
  if bp.id is null then select * into bp from public.arka_pending_payments where idempotency_key=idem; end if;
  update public.base_ready_bonuses set arka_payment_id=bp.id,updated_at=clock_timestamp() where id=b.id returning * into b;
  return jsonb_build_object('ok',true,'activated',true,'eligible',true,'createdFromPayment',true,'bonus',to_jsonb(b),'bonusPayment',to_jsonb(bp),'order',to_jsonb(o),'reason',b.reason);
end $$;

create or replace function public.bujar_bonus_evidence_review_v1(p_request_id uuid,p_actor_id uuid,p_decision text,p_note text default '')
returns jsonb language plpgsql security invoker set search_path='' as $$
declare r public.base_bonus_extensions%rowtype; oid bigint; t timestamptz:=clock_timestamp();
begin
  if p_actor_id='19d3ab97-2067-493a-aeb1-8a23572dc5f8'::uuid or not exists(select 1 from public.users where id=p_actor_id and is_active is true and upper(role) in ('DISPATCH','ADMIN','ADMIN_MASTER','OWNER','PRONAR','SUPERADMIN')) then raise exception 'BONUS_EVIDENCE_REVIEW_FORBIDDEN'; end if;
  if p_decision not in ('APPROVED','REJECTED') then raise exception 'BONUS_EVIDENCE_DECISION_REQUIRED'; end if;
  if length(coalesce(p_note,''))>500 then raise exception 'BONUS_EVIDENCE_NOTE_TOO_LONG'; end if;
  if p_decision='REJECTED' and length(btrim(coalesce(p_note,'')))<3 then raise exception 'BONUS_EVIDENCE_REJECT_REASON_REQUIRED'; end if;
  select order_id into oid from public.base_bonus_extensions where id=p_request_id;
  perform 1 from public.orders where id=oid for update;
  select * into r from public.base_bonus_extensions where id=p_request_id for update;
  if r.id is null then raise exception 'BONUS_EVIDENCE_NOT_FOUND'; end if;
  if r.status=p_decision then return to_jsonb(r); end if;
  if r.status<>'PENDING' then raise exception 'BONUS_EVIDENCE_REVIEW_CONFLICT'; end if;
  if t>r.extended_deadline+interval '7 days' then raise exception 'BONUS_EVIDENCE_REVIEW_EXPIRED'; end if;
  if p_decision='APPROVED' and (r.submitted_at is null or r.submitted_at>r.original_deadline or r.carpet_hash is null or r.message_hash is null or r.files_deleted_at is not null) then raise exception 'BONUS_EVIDENCE_TWO_PHOTOS_REQUIRED'; end if;
  update public.base_bonus_extensions set status=p_decision,reviewed_at=t,reviewed_by=p_actor_id,review_note=btrim(coalesce(p_note,'')),cleanup_due_at=case when collected_at is not null then t when p_decision='REJECTED' then t+interval '24 hours' else null end where id=r.id returning * into r;
  perform private.bujar_bonus_evidence_reconcile_v1(r.order_id);
  return to_jsonb(r);
end $$;

create or replace function private.bujar_bonus_evidence_collected_v1()
returns trigger language plpgsql security definer set search_path='' as $$
declare r public.base_bonus_extensions%rowtype; t timestamptz:=clock_timestamp();
begin
  select * into r from public.base_bonus_extensions where order_id=new.id for update;
  if r.id is null then return new; end if;
  if new.status='dorzim' and old.status is distinct from 'dorzim' then
    update public.base_bonus_extensions set collected_at=coalesce(collected_at,t),status=case when status='DRAFT' then 'CANCELLED' else status end,
      cleanup_due_at=case when status='PENDING' then null else t end where id=r.id;
  elsif lower(coalesce(new.status,'')) in ('anuluar','cancelled','canceled','deleted','void') then
    update public.base_bonus_extensions set status='CANCELLED',cleanup_due_at=t where id=r.id;
  end if;
  return new;
end $$;
create trigger trg_00_bujar_bonus_evidence_collected after update of status on public.orders for each row execute function private.bujar_bonus_evidence_collected_v1();

create or replace function public.bujar_bonus_evidence_cleanup_list_v1(p_request_id uuid default null,p_order_id bigint default null)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare result jsonb; t timestamptz:=clock_timestamp();
begin
  update public.base_bonus_extensions set status='EXPIRED',cleanup_due_at=t
  where ((status='DRAFT' and original_deadline<t) or (status='PENDING' and extended_deadline+interval '7 days'<t))
    and (p_request_id is null or id=p_request_id) and (p_order_id is null or order_id=p_order_id);
  -- Approved but never collected evidence has a bounded retention too.
  update public.base_bonus_extensions set cleanup_due_at=t where status='APPROVED' and cleanup_due_at is null and extended_deadline+interval '7 days'<t
    and (p_request_id is null or id=p_request_id) and (p_order_id is null or order_id=p_order_id);
  select coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) into result from (
    select id,carpet_path,message_path from public.base_bonus_extensions
    where cleanup_due_at<=t and status<>'PENDING'
      and (files_deleted_at is null or last_cleanup_at<upload_expires_at)
      and (p_request_id is null or id=p_request_id) and (p_order_id is null or order_id=p_order_id)
    order by cleanup_due_at limit 50
  ) x;
  return result;
end $$;
create or replace function public.bujar_bonus_evidence_cleanup_done_v1(p_request_id uuid)
returns jsonb language plpgsql security invoker set search_path='' as $$
begin
  update public.base_bonus_extensions set files_deleted_at=coalesce(files_deleted_at,clock_timestamp()),last_cleanup_at=clock_timestamp() where id=p_request_id and cleanup_due_at<=clock_timestamp() and status<>'PENDING';
  return jsonb_build_object('ok',found);
end $$;

revoke all on function public.bujar_bonus_evidence_prepare_v1(bigint,uuid,text),public.bujar_bonus_evidence_submit_v1(uuid,uuid,text,text),public.bujar_bonus_evidence_review_v1(uuid,uuid,text,text),public.bujar_bonus_evidence_cleanup_list_v1(uuid,bigint),public.bujar_bonus_evidence_cleanup_done_v1(uuid) from public,anon,authenticated;
grant execute on function public.bujar_bonus_evidence_prepare_v1(bigint,uuid,text),public.bujar_bonus_evidence_submit_v1(uuid,uuid,text,text),public.bujar_bonus_evidence_review_v1(uuid,uuid,text,text),public.bujar_bonus_evidence_cleanup_list_v1(uuid,bigint),public.bujar_bonus_evidence_cleanup_done_v1(uuid) to service_role;
revoke all on function private.bujar_bonus_evidence_reconcile_v1(bigint),private.bujar_bonus_evidence_collected_v1() from public,anon,authenticated;
grant usage on schema private to service_role;
grant execute on function private.bujar_bonus_evidence_reconcile_v1(bigint) to service_role;

CREATE OR REPLACE FUNCTION public.apply_base_ready_bonus_after_payment_v3(p_order_id bigint, p_payment_id bigint DEFAULT NULL::bigint, p_paid_at timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_order public.orders%rowtype;
  v_config public.base_ready_bonus_config%rowtype;
  v_existing public.base_ready_bonuses%rowtype;
  v_bonus public.base_ready_bonuses%rowtype;
  v_payment public.arka_pending_payments%rowtype;
  v_bonus_payment public.arka_pending_payments%rowtype;
  v_worker public.users%rowtype;
  v_state jsonb;
  v_fully_paid boolean := false;
  v_now timestamptz := now();
  v_paid_at timestamptz;
  v_m2 numeric := 0;
  v_amount numeric := 0;
  v_elapsed_minutes integer := 0;
  v_eligible boolean := false;
  v_reason text := '';
  v_idem text := '';
  v_summary jsonb;
  v_created_by_this_payment boolean := false;
begin

  -- Submitted evidence is reconciled atomically; legacy/other orders keep their existing policy.
  if exists(select 1 from public.base_bonus_extensions where order_id=p_order_id and status<>'DRAFT') then
    return private.bujar_bonus_evidence_reconcile_v1(p_order_id);
  end if;
  select *
  into v_order
  from public.orders
  where id=p_order_id
  for update;

  if not found then
    return jsonb_build_object('ok',false,'createdFromPayment',false,'reason','ORDER_NOT_FOUND','order_id',p_order_id);
  end if;

  select *
  into v_existing
  from public.base_ready_bonuses
  where order_id=v_order.id
  for update;

  if found and v_existing.status <> 'WAITING_PAYMENT' then
    v_created_by_this_payment := p_payment_id is not null
      and v_existing.activation_payment_id = p_payment_id
      and v_existing.activation_source = 'PAYMENT_DIRECT';
    v_summary := public.get_base_ready_bonus_summary_v1(
      v_existing.worker_pin,
      v_existing.worker_pin,
      (coalesce(v_existing.activated_at,v_existing.ready_at) at time zone 'Europe/Belgrade')::date
    );
    return jsonb_build_object(
      'ok',true,
      'createdFromPayment',v_created_by_this_payment,
      'activated',v_existing.eligible,
      'alreadyApplied',true,
      'reason',case when v_created_by_this_payment then 'BONUS_CREATED_BY_THIS_PAYMENT' else 'ORDER_ALREADY_HAS_BONUS' end,
      'order',to_jsonb(v_order),
      'bonus',to_jsonb(v_existing),
      'summary',v_summary
    );
  end if;

  v_state := public.base_ready_payment_state_v2(v_order.id);
  v_fully_paid := coalesce((v_state->>'fully_paid')::boolean,false);
  if not v_fully_paid then
    return jsonb_build_object(
      'ok',true,
      'createdFromPayment',false,
      'reason','WAITING_FULL_PAYMENT',
      'order_id',v_order.id,
      'payment_state',v_state
    );
  end if;

  if p_payment_id is not null then
    select *
    into v_payment
    from public.arka_pending_payments
    where id=p_payment_id
      and order_id=v_order.id
      and upper(coalesce(type,''))='IN'
      and upper(coalesce(source_module,''))='BASE'
    limit 1;
  end if;

  if p_payment_id is null or v_payment.id is null then
    select *
    into v_payment
    from public.arka_pending_payments
    where order_id=v_order.id
      and upper(coalesce(type,''))='IN'
      and upper(coalesce(source_module,''))='BASE'
      and coalesce(amount,0)>0
      and upper(coalesce(status,'')) in ('PENDING','COLLECTED','PENDING_DISPATCH_APPROVAL','ACCEPTED_BY_DISPATCH','HANDED')
    order by created_at desc,id desc
    limit 1;
  end if;

  if v_payment.id is null then
    return jsonb_build_object(
      'ok',true,
      'createdFromPayment',false,
      'reason','BASE_PAYMENT_ROW_NOT_FOUND',
      'order_id',v_order.id,
      'payment_state',v_state
    );
  end if;

  v_paid_at := coalesce(v_payment.created_at,p_paid_at,v_now);

  if v_existing.id is not null and v_existing.status='WAITING_PAYMENT' then
    v_idem := v_existing.idempotency_key;
    begin
      insert into public.arka_pending_payments (
        order_id,amount,type,status,note,client_name,client_phone,order_code,
        created_by_pin,created_by_name,approved_by_pin,approved_by_name,
        handoff_note,source_module,idempotency_key,created_at,updated_at
      ) values (
        v_order.id,v_existing.amount,'READY_48H_BONUS','ACCEPTED_BY_DISPATCH',
        concat('BONUS 48H ',to_char(v_existing.amount,'FM999999990.00'),'€ • #',v_order.code,' • ',coalesce(v_order.client_name,''),' • ',to_char(v_existing.m2,'FM999999990.00'),' m² × ',to_char(v_existing.rate_m2,'FM999999990.00'),'€'),
        v_order.client_name,v_order.client_phone,v_order.code,
        v_existing.worker_pin,v_existing.worker_name,'SYSTEM','BONUS 48H AUTO',
        concat('READY_BONUS_OPEN:',v_existing.id),'ARKA',v_idem,
        coalesce(v_existing.ready_at,v_now),v_now
      )
      returning * into v_bonus_payment;
    exception when unique_violation then
      select *
      into v_bonus_payment
      from public.arka_pending_payments
      where idempotency_key=v_idem
      limit 1;
    end;

    update public.base_ready_bonuses
    set status='EARNED',
        arka_payment_id=v_bonus_payment.id,
        activated_at=coalesce(activated_at,ready_at,v_now),
        activation_payment_id=coalesce(activation_payment_id,v_payment.id),
        activation_source='GATI',
        reason=case when reason like 'ELIGIBLE%' then 'ELIGIBLE_WITHIN_48H_GATI' else reason end,
        metadata=coalesce(metadata,'{}'::jsonb) || jsonb_build_object(
          'version','base-ready-ready-or-payment-v3',
          'activation_source','GATI',
          'payment_trigger_seen',true
        ),
        updated_at=v_now
    where id=v_existing.id
    returning * into v_bonus;

    v_summary := public.get_base_ready_bonus_summary_v1(
      v_bonus.worker_pin,
      v_bonus.worker_pin,
      (v_bonus.activated_at at time zone 'Europe/Belgrade')::date
    );

    return jsonb_build_object(
      'ok',true,
      'createdFromPayment',false,
      'alreadyApplied',false,
      'activated',true,
      'reason','GATI_BONUS_COMPAT_ACTIVATED',
      'order',to_jsonb(v_order),
      'bonus',to_jsonb(v_bonus),
      'bonusPayment',to_jsonb(v_bonus_payment),
      'payment',to_jsonb(v_payment),
      'payment_state',v_state,
      'summary',v_summary
    );
  end if;

  select *
  into v_worker
  from public.users
  where pin=btrim(coalesce(v_payment.created_by_pin,''))
    and is_active is true
    and upper(coalesce(role,'')) in ('PUNTOR','PUNETOR','WORKER','BAZIST','BASE')
  limit 1;

  if not found then
    select *
    into v_worker
    from public.users
    where pin=btrim(coalesce(v_order.data ->> 'ready_by_pin',''))
      and is_active is true
      and upper(coalesce(role,'')) in ('PUNTOR','PUNETOR','WORKER','BAZIST','BASE')
    limit 1;
  end if;

  if v_worker.id is null then
    return jsonb_build_object(
      'ok',true,
      'createdFromPayment',false,
      'reason','PAYMENT_ACTOR_NOT_BASE_WORKER',
      'order_id',v_order.id,
      'payment_id',v_payment.id,
      'payment_state',v_state
    );
  end if;

  select *
  into v_config
  from public.base_ready_bonus_config
  where id=1
  for share;

  if not found then
    raise exception 'BASE_READY_BONUS_CONFIG_MISSING';
  end if;

  v_m2 := round(coalesce(public.tepiha_daily_order_m2(v_order.data,v_order.m2_total),0)::numeric,2);
  if v_m2 <= 0 then
    return jsonb_build_object('ok',true,'createdFromPayment',false,'reason','BASE_READY_M2_REQUIRED','order_id',v_order.id);
  end if;

  v_elapsed_minutes := greatest(0,floor(extract(epoch from (v_paid_at-v_order.created_at))/60)::integer);
  v_eligible := coalesce(v_config.enabled,false)
    and v_paid_at >= v_config.effective_from
    and v_elapsed_minutes <= floor(v_config.window_hours*60)::integer;

  if not coalesce(v_config.enabled,false) then
    v_reason := 'BONUS_DISABLED';
  elsif v_paid_at < v_config.effective_from then
    v_reason := 'BEFORE_EFFECTIVE_FROM';
  elsif v_elapsed_minutes > floor(v_config.window_hours*60)::integer then
    v_reason := 'OVER_48_HOURS_AT_PAYMENT';
  else
    v_reason := 'ELIGIBLE_DIRECT_FULL_PAYMENT_WITHIN_48H';
  end if;

  v_amount := case when v_eligible then round(v_m2*v_config.rate_m2,2) else 0 end;
  v_idem := concat('BASE_READY_48H_BONUS:',v_order.id);

  insert into public.base_ready_bonuses (
    order_id,order_code,worker_pin,worker_name,worker_role,m2,rate_m2,amount,
    entered_at,ready_at,elapsed_minutes,eligible,status,remaining_amount,reserved_amount,
    retained_amount,arka_payment_id,idempotency_key,reason,metadata,
    activated_at,activation_payment_id,activation_source,created_at,updated_at
  ) values (
    v_order.id,v_order.code,v_worker.pin,v_worker.name,v_worker.role,v_m2,v_config.rate_m2,v_amount,
    v_order.created_at,v_paid_at,v_elapsed_minutes,v_eligible,
    case when v_eligible then 'EARNED' else 'INELIGIBLE' end,
    v_amount,0,0,null,v_idem,v_reason,
    jsonb_build_object(
      'source','PAYMENT_DIRECT',
      'version','base-ready-ready-or-payment-v3',
      'payment_id',v_payment.id,
      'payment_actor_pin',v_payment.created_by_pin,
      'completion_event','FULL_PAYMENT'
    ),
    case when v_eligible then v_paid_at else null end,
    v_payment.id,
    case when v_eligible then 'PAYMENT_DIRECT' else 'PAYMENT_DIRECT_INELIGIBLE' end,
    v_now,v_now
  )
  returning * into v_bonus;

  if v_eligible and v_amount>0 then
    begin
      insert into public.arka_pending_payments (
        order_id,amount,type,status,note,client_name,client_phone,order_code,
        created_by_pin,created_by_name,approved_by_pin,approved_by_name,
        handoff_note,source_module,idempotency_key,created_at,updated_at
      ) values (
        v_order.id,v_amount,'READY_48H_BONUS','ACCEPTED_BY_DISPATCH',
        concat('BONUS 48H NGA PAGESA ',to_char(v_amount,'FM999999990.00'),'€ • #',v_order.code,' • ',coalesce(v_order.client_name,''),' • ',to_char(v_m2,'FM999999990.00'),' m² × ',to_char(v_config.rate_m2,'FM999999990.00'),'€ • ',to_char(v_elapsed_minutes::numeric/60,'FM999999990.00'),'h'),
        v_order.client_name,v_order.client_phone,v_order.code,
        v_worker.pin,v_worker.name,'SYSTEM','BONUS 48H AUTO',
        concat('READY_BONUS_OPEN:',v_bonus.id),'ARKA',v_idem,
        v_paid_at,v_now
      )
      returning * into v_bonus_payment;
    exception when unique_violation then
      select *
      into v_bonus_payment
      from public.arka_pending_payments
      where idempotency_key=v_idem
      limit 1;
    end;

    update public.base_ready_bonuses
    set arka_payment_id=v_bonus_payment.id,
        updated_at=v_now
    where id=v_bonus.id
    returning * into v_bonus;
  end if;

  v_summary := public.get_base_ready_bonus_summary_v1(
    v_worker.pin,
    v_worker.pin,
    (coalesce(v_bonus.activated_at,v_bonus.ready_at) at time zone 'Europe/Belgrade')::date
  );

  return jsonb_build_object(
    'ok',true,
    'createdFromPayment',v_eligible,
    'alreadyApplied',false,
    'activated',v_eligible,
    'reason',v_reason,
    'order',to_jsonb(v_order),
    'bonus',to_jsonb(v_bonus),
    'bonusPayment',case when v_bonus_payment.id is null then null else to_jsonb(v_bonus_payment) end,
    'payment',to_jsonb(v_payment),
    'payment_state',v_state,
    'summary',v_summary
  );
end;
$function$
;

CREATE OR REPLACE FUNCTION public.activate_base_ready_bonus_on_full_payment_v2(p_order_id bigint, p_actor_pin text, p_payment_id bigint, p_paid_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_idempotency_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_order public.orders%rowtype;
  v_payment public.arka_pending_payments%rowtype;
  v_actor public.users%rowtype;
  v_config public.base_ready_bonus_config%rowtype;
  v_existing public.base_ready_bonuses%rowtype;
  v_bonus public.base_ready_bonuses%rowtype;
  v_bonus_payment public.arka_pending_payments%rowtype;
  v_data jsonb;
  v_ready_at timestamptz;
  v_activated_at timestamptz;
  v_total numeric := 0;
  v_paid numeric := 0;
  v_m2 numeric := 0;
  v_amount numeric := 0;
  v_elapsed_minutes integer := 0;
  v_eligible boolean := false;
  v_reason text := '';
  v_idem text := '';
  v_summary jsonb := null;
begin

  -- Submitted evidence is reconciled atomically; legacy/other orders keep their existing policy.
  if exists(select 1 from public.base_bonus_extensions where order_id=p_order_id and status<>'DRAFT') then
    return private.bujar_bonus_evidence_reconcile_v1(p_order_id);
  end if;
  if coalesce(p_order_id,0) <= 0 then
    raise exception 'BASE_PAYMENT_BONUS_ORDER_ID_REQUIRED';
  end if;
  if nullif(btrim(coalesce(p_actor_pin,'')),'') is null then
    raise exception 'BASE_PAYMENT_BONUS_ACTOR_PIN_REQUIRED';
  end if;
  if coalesce(p_payment_id,0) <= 0 then
    raise exception 'BASE_PAYMENT_BONUS_PAYMENT_ID_REQUIRED';
  end if;

  select * into v_order
  from public.orders
  where id = p_order_id
  for update;
  if not found then
    raise exception 'BASE_PAYMENT_BONUS_ORDER_NOT_FOUND';
  end if;

  select * into v_payment
  from public.arka_pending_payments
  where id = p_payment_id
  for update;
  if not found then
    raise exception 'BASE_PAYMENT_BONUS_PAYMENT_NOT_FOUND';
  end if;

  if v_payment.order_id is distinct from v_order.id
     or upper(coalesce(v_payment.type,'')) <> 'IN'
     or upper(coalesce(v_payment.source_module,'')) <> 'BASE'
     or coalesce(v_payment.amount,0) <= 0
     or upper(coalesce(v_payment.status,'')) not in ('PENDING','COLLECTED','PENDING_DISPATCH_APPROVAL','ACCEPTED_BY_DISPATCH','HANDED') then
    raise exception 'BASE_PAYMENT_BONUS_PAYMENT_INVALID';
  end if;

  if btrim(coalesce(v_payment.created_by_pin,'')) <> btrim(p_actor_pin) then
    raise exception 'BASE_PAYMENT_BONUS_PAYMENT_ACTOR_MISMATCH';
  end if;

  select * into v_actor
  from public.users
  where pin = btrim(p_actor_pin)
    and is_active is true
  limit 1;
  if not found then
    raise exception 'BASE_PAYMENT_BONUS_ACTOR_NOT_FOUND';
  end if;

  if upper(coalesce(v_actor.role,'')) not in ('PUNTOR','PUNETOR','WORKER','BAZIST','BASE') then
    return jsonb_build_object(
      'ok',true,
      'activated',false,
      'eligible',false,
      'reason','PAYMENT_ACTOR_NOT_BASE_WORKER',
      'order',to_jsonb(v_order),
      'payment',to_jsonb(v_payment)
    );
  end if;

  select * into v_existing
  from public.base_ready_bonuses
  where order_id = v_order.id
  limit 1
  for update;
  if found then
    v_summary := public.get_base_ready_bonus_summary_v1(
      v_existing.worker_pin,
      v_existing.worker_pin,
      (coalesce(v_existing.activated_at,v_existing.ready_at) at time zone 'Europe/Belgrade')::date
    );
    return jsonb_build_object(
      'ok',true,
      'activated',true,
      'alreadyApplied',true,
      'eligible',v_existing.eligible,
      'reason',v_existing.reason,
      'order',to_jsonb(v_order),
      'payment',to_jsonb(v_payment),
      'bonus',to_jsonb(v_existing),
      'summary',v_summary
    );
  end if;

  v_data := coalesce(v_order.data,'{}'::jsonb);

  v_total := round(greatest(
    coalesce(v_order.price_total,0),
    coalesce(v_order.total,0),
    case when coalesce(v_data#>>'{pay,euro}','') ~ '^-?[0-9]+(\.[0-9]+)?$' then (v_data#>>'{pay,euro}')::numeric else 0 end,
    case when coalesce(v_data#>>'{pay,total}','') ~ '^-?[0-9]+(\.[0-9]+)?$' then (v_data#>>'{pay,total}')::numeric else 0 end,
    case when coalesce(v_data->>'price_total','') ~ '^-?[0-9]+(\.[0-9]+)?$' then (v_data->>'price_total')::numeric else 0 end,
    case when coalesce(v_data->>'total','') ~ '^-?[0-9]+(\.[0-9]+)?$' then (v_data->>'total')::numeric else 0 end
  ),2);

  v_paid := round(greatest(
    coalesce(v_order.paid,0),
    coalesce(v_order.paid_cash,0),
    case when coalesce(v_data#>>'{pay,paid}','') ~ '^-?[0-9]+(\.[0-9]+)?$' then (v_data#>>'{pay,paid}')::numeric else 0 end,
    case when coalesce(v_data#>>'{pay,arkaRecordedPaid}','') ~ '^-?[0-9]+(\.[0-9]+)?$' then (v_data#>>'{pay,arkaRecordedPaid}')::numeric else 0 end,
    case when coalesce(v_data->>'clientPaid','') ~ '^-?[0-9]+(\.[0-9]+)?$' then (v_data->>'clientPaid')::numeric else 0 end,
    case when coalesce(v_data->>'paid','') ~ '^-?[0-9]+(\.[0-9]+)?$' then (v_data->>'paid')::numeric else 0 end
  ),2);

  if v_total <= 0 then
    return jsonb_build_object(
      'ok',true,'activated',false,'eligible',false,
      'reason','ORDER_TOTAL_MISSING','order',to_jsonb(v_order),'payment',to_jsonb(v_payment)
    );
  end if;

  if v_paid < v_total - 0.01 then
    return jsonb_build_object(
      'ok',true,'activated',false,'eligible',false,
      'reason','ORDER_NOT_FULLY_PAID',
      'paid',v_paid,'total',v_total,
      'order',to_jsonb(v_order),'payment',to_jsonb(v_payment)
    );
  end if;

  v_ready_at := v_order.ready_at;
  if v_ready_at is null and nullif(v_data->>'ready_at','') is not null then
    begin
      v_ready_at := (v_data->>'ready_at')::timestamptz;
    exception when others then
      v_ready_at := null;
    end;
  end if;

  if v_ready_at is null then
    return jsonb_build_object(
      'ok',true,'activated',false,'eligible',false,
      'reason','ORDER_NOT_READY',
      'order',to_jsonb(v_order),'payment',to_jsonb(v_payment)
    );
  end if;

  select * into v_config
  from public.base_ready_bonus_config
  where id = 1
  for share;
  if not found then
    raise exception 'BASE_PAYMENT_BONUS_CONFIG_MISSING';
  end if;

  v_m2 := round(coalesce(public.tepiha_daily_order_m2(v_data,v_order.m2_total),0)::numeric,2);
  if v_m2 <= 0 then
    return jsonb_build_object(
      'ok',true,'activated',false,'eligible',false,
      'reason','ORDER_M2_MISSING',
      'order',to_jsonb(v_order),'payment',to_jsonb(v_payment)
    );
  end if;

  v_elapsed_minutes := greatest(0,floor(extract(epoch from (v_ready_at-v_order.created_at))/60)::integer);
  v_activated_at := coalesce(p_paid_at,v_payment.created_at,now());
  v_eligible := coalesce(v_config.enabled,false)
    and v_ready_at >= v_config.effective_from
    and v_elapsed_minutes <= floor(v_config.window_hours*60)::integer;

  if not coalesce(v_config.enabled,false) then
    v_reason := 'BONUS_DISABLED';
  elsif v_ready_at < v_config.effective_from then
    v_reason := 'READY_BEFORE_EFFECTIVE_FROM';
  elsif v_elapsed_minutes > floor(v_config.window_hours*60)::integer then
    v_reason := 'OVER_48_HOURS';
  else
    v_reason := 'ELIGIBLE_READY_WITHIN_48H_AND_FULLY_PAID';
  end if;

  v_amount := case when v_eligible then round(v_m2*v_config.rate_m2,2) else 0 end;
  v_idem := coalesce(
    nullif(btrim(coalesce(p_idempotency_key,'')),''),
    concat('BASE_READY_48H_PAYMENT:',v_order.id)
  );

  begin
    insert into public.base_ready_bonuses(
      order_id,order_code,worker_pin,worker_name,worker_role,m2,rate_m2,amount,
      entered_at,ready_at,elapsed_minutes,eligible,status,remaining_amount,reserved_amount,
      retained_amount,payment_id,activated_at,activation_source,idempotency_key,reason,metadata,
      created_at,updated_at
    ) values (
      v_order.id,v_order.code,v_actor.pin,v_actor.name,v_actor.role,v_m2,v_config.rate_m2,v_amount,
      v_order.created_at,v_ready_at,v_elapsed_minutes,v_eligible,
      case when v_eligible then 'EARNED' else 'INELIGIBLE' end,
      v_amount,0,0,v_payment.id,v_activated_at,'BASE_FULL_PAYMENT',v_idem,v_reason,
      jsonb_build_object(
        'version','base-payment-48h-bonus-v2',
        'activation_source','BASE_FULL_PAYMENT',
        'payment_id',v_payment.id,
        'payment_amount',v_payment.amount,
        'payment_actor_pin',v_actor.pin,
        'payment_actor_name',v_actor.name,
        'paid_at',v_activated_at
      ),
      now(),now()
    ) returning * into v_bonus;
  exception when unique_violation then
    select * into v_bonus
    from public.base_ready_bonuses
    where order_id = v_order.id
    limit 1;
  end;

  if v_bonus.eligible and v_bonus.amount > 0 and v_bonus.arka_payment_id is null then
    begin
      insert into public.arka_pending_payments(
        order_id,amount,type,status,note,client_name,client_phone,order_code,
        created_by_pin,created_by_name,approved_by_pin,approved_by_name,
        handoff_note,source_module,idempotency_key,created_at,updated_at
      ) values (
        v_order.id,v_bonus.amount,'READY_48H_BONUS','ACCEPTED_BY_DISPATCH',
        concat(
          'BONUS 48H NGA PAGESA ',to_char(v_bonus.amount,'FM999999990.00'),'€ • #',v_order.code,
          ' • ',coalesce(v_order.client_name,''),' • ',to_char(v_bonus.m2,'FM999999990.00'),' m² × ',
          to_char(v_bonus.rate_m2,'FM999999990.00'),'€ • GATI ',
          to_char(v_bonus.elapsed_minutes::numeric/60,'FM999999990.00'),'h'
        ),
        v_order.client_name,v_order.client_phone,v_order.code,
        v_actor.pin,v_actor.name,'SYSTEM','BONUS 48H AUTO NGA PAGESA',
        concat('READY_BONUS_OPEN:',v_bonus.id),'ARKA',v_idem,now(),now()
      ) returning * into v_bonus_payment;
    exception when unique_violation then
      select * into v_bonus_payment
      from public.arka_pending_payments
      where idempotency_key = v_idem
      limit 1;
    end;

    update public.base_ready_bonuses
    set arka_payment_id=v_bonus_payment.id,updated_at=now()
    where id=v_bonus.id
    returning * into v_bonus;
  end if;

  v_data := v_data || jsonb_build_object(
    'base_ready_bonus_v2',jsonb_build_object(
      'version','base-payment-48h-bonus-v2',
      'state',case when v_bonus.eligible then 'ACTIVATED' else 'INELIGIBLE' end,
      'worker_pin',v_actor.pin,
      'worker_name',v_actor.name,
      'payment_id',v_payment.id,
      'activated_at',v_activated_at,
      'ready_at',v_ready_at,
      'entered_at',v_order.created_at,
      'elapsed_minutes',v_elapsed_minutes,
      'm2',v_m2,
      'rate_m2',v_config.rate_m2,
      'amount',v_amount,
      'eligible',v_eligible,
      'reason',v_reason,
      'idempotency_key',v_idem
    )
  );

  update public.orders
  set data=v_data,updated_at=now()
  where id=v_order.id
  returning * into v_order;

  v_summary := public.get_base_ready_bonus_summary_v1(
    v_actor.pin,v_actor.pin,(v_activated_at at time zone 'Europe/Belgrade')::date
  );

  return jsonb_build_object(
    'ok',true,
    'activated',true,
    'alreadyApplied',false,
    'eligible',v_bonus.eligible,
    'reason',v_bonus.reason,
    'order',to_jsonb(v_order),
    'payment',to_jsonb(v_payment),
    'bonus',to_jsonb(v_bonus),
    'summary',v_summary
  );
end;
$function$
;

CREATE OR REPLACE FUNCTION public.award_base_ready_bonus_from_payment_v2(p_payment_id bigint, p_actor_pin text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_payment public.arka_pending_payments%rowtype;
  v_order public.orders%rowtype;
  v_worker public.users%rowtype;
  v_config public.base_ready_bonus_config%rowtype;
  v_existing public.base_ready_bonuses%rowtype;
  v_bonus public.base_ready_bonuses%rowtype;
  v_bonus_payment public.arka_pending_payments%rowtype;
  v_actor_pin text;
  v_event_at timestamptz;
  v_elapsed_minutes integer := 0;
  v_m2 numeric := 0;
  v_amount numeric := 0;
  v_idem text;
  v_summary jsonb;
  v_order_data jsonb;
begin

  -- Submitted evidence is reconciled atomically; legacy/other orders keep their existing policy.
  if exists(select 1 from public.base_bonus_extensions where order_id=(select order_id from public.arka_pending_payments where id=p_payment_id) and status<>'DRAFT') then
    return private.bujar_bonus_evidence_reconcile_v1((select order_id from public.arka_pending_payments where id=p_payment_id));
  end if;
  if coalesce(p_payment_id,0) <= 0 then
    raise exception 'BASE_BONUS_PAYMENT_ID_REQUIRED';
  end if;

  select * into v_payment
  from public.arka_pending_payments p
  where p.id = p_payment_id
  for update;
  if not found then raise exception 'BASE_BONUS_PAYMENT_NOT_FOUND'; end if;

  if upper(coalesce(v_payment.type,'')) <> 'IN'
     or upper(coalesce(v_payment.source_module,'')) <> 'BASE'
     or coalesce(v_payment.order_id,0) <= 0
     or coalesce(v_payment.amount,0) <= 0
     or upper(coalesce(v_payment.status,'')) not in ('PENDING','COLLECTED','HANDED','PENDING_DISPATCH_APPROVAL','ACCEPTED_BY_DISPATCH','APPROVED','ACCEPTED') then
    return jsonb_build_object('ok',true,'awarded',false,'reason','PAYMENT_NOT_ELIGIBLE_BASE_CASH');
  end if;

  v_actor_pin := btrim(coalesce(nullif(p_actor_pin,''), v_payment.created_by_pin, v_payment.handed_by_pin, ''));
  if v_actor_pin = '' then
    return jsonb_build_object('ok',true,'awarded',false,'reason','PAYMENT_WORKER_PIN_MISSING');
  end if;
  if nullif(btrim(coalesce(p_actor_pin,'')),'') is not null
     and nullif(btrim(coalesce(v_payment.created_by_pin,'')),'') is not null
     and btrim(p_actor_pin) <> btrim(v_payment.created_by_pin) then
    raise exception 'BASE_BONUS_PAYMENT_ACTOR_MISMATCH';
  end if;

  select * into v_worker
  from public.users u
  where btrim(coalesce(u.pin,'')) = v_actor_pin
    and u.is_active is true
  limit 1;
  if not found then
    return jsonb_build_object('ok',true,'awarded',false,'reason','PAYMENT_WORKER_NOT_ACTIVE');
  end if;
  if upper(coalesce(v_worker.role,'')) not in ('PUNTOR','PUNETOR','WORKER','BAZIST','BASE') then
    return jsonb_build_object('ok',true,'awarded',false,'reason','PAYMENT_WORKER_ROLE_NOT_BASE');
  end if;

  select * into v_order
  from public.orders o
  where o.id = v_payment.order_id
  for update;
  if not found then raise exception 'BASE_BONUS_ORDER_NOT_FOUND'; end if;

  select * into v_existing
  from public.base_ready_bonuses b
  where b.order_id = v_order.id
  limit 1;
  if found then
    v_summary := public.get_base_ready_bonus_summary_v1(v_worker.pin, v_worker.pin, (coalesce(v_existing.qualification_at,v_existing.ready_at) at time zone 'Europe/Belgrade')::date);
    return jsonb_build_object('ok',true,'awarded',false,'alreadyApplied',true,'reason','ORDER_BONUS_ALREADY_EXISTS','bonus',to_jsonb(v_existing),'summary',v_summary);
  end if;

  if not public.base_order_is_fully_paid_v2(v_order.data, v_order.price_total, v_order.paid, v_order.paid_cash) then
    return jsonb_build_object('ok',true,'awarded',false,'reason','PAYMENT_PARTIAL_ORDER_NOT_FULLY_PAID');
  end if;

  select * into v_config
  from public.base_ready_bonus_config c
  where c.id = 1
  for share;
  if not found then raise exception 'BASE_READY_BONUS_CONFIG_MISSING'; end if;
  if not coalesce(v_config.enabled,false) then
    return jsonb_build_object('ok',true,'awarded',false,'reason','BONUS_DISABLED');
  end if;

  v_event_at := coalesce(v_payment.created_at, now());
  v_elapsed_minutes := greatest(0, floor(extract(epoch from (v_event_at - v_order.created_at))/60)::integer);
  if v_event_at < v_config.effective_from then
    return jsonb_build_object('ok',true,'awarded',false,'reason','BEFORE_EFFECTIVE_FROM','elapsed_minutes',v_elapsed_minutes);
  end if;
  if v_elapsed_minutes > floor(v_config.window_hours * 60)::integer then
    return jsonb_build_object('ok',true,'awarded',false,'reason','PAYMENT_OVER_48_HOURS','elapsed_minutes',v_elapsed_minutes);
  end if;

  v_m2 := round(coalesce(public.tepiha_daily_order_m2(v_order.data, v_order.m2_total),0)::numeric,2);
  if v_m2 <= 0 then
    return jsonb_build_object('ok',true,'awarded',false,'reason','BASE_READY_M2_REQUIRED');
  end if;

  v_amount := round(v_m2 * v_config.rate_m2,2);
  if v_amount <= 0 then
    return jsonb_build_object('ok',true,'awarded',false,'reason','BONUS_AMOUNT_ZERO');
  end if;
  v_idem := concat('BASE_READY_48H_BONUS:',v_order.id);

  begin
    insert into public.base_ready_bonuses (
      order_id,order_code,worker_pin,worker_name,worker_role,m2,rate_m2,amount,
      entered_at,ready_at,elapsed_minutes,eligible,status,remaining_amount,reserved_amount,
      retained_amount,arka_payment_id,idempotency_key,reason,metadata,created_at,updated_at,
      qualification_source,qualification_at,payment_id
    ) values (
      v_order.id,v_order.code,v_worker.pin,v_worker.name,v_worker.role,v_m2,v_config.rate_m2,v_amount,
      v_order.created_at,v_event_at,v_elapsed_minutes,true,'EARNED',v_amount,0,0,null,
      v_idem,'ELIGIBLE_FULL_PAYMENT_WITHIN_48H',
      jsonb_build_object(
        'source','BASE_PAYMENT',
        'version','base-ready-or-payment-bonus-v2',
        'payment_id',v_payment.id,
        'payment_at',v_event_at,
        'earned_at',v_event_at,
        'payment_amount',v_payment.amount,
        'first_qualifying_action','PAYMENT'
      ),now(),now(),'PAYMENT',v_event_at,v_payment.id
    ) returning * into v_bonus;
  exception when unique_violation then
    select * into v_bonus from public.base_ready_bonuses where order_id=v_order.id limit 1;
    v_summary := public.get_base_ready_bonus_summary_v1(v_worker.pin, v_worker.pin, (coalesce(v_bonus.qualification_at,v_bonus.ready_at) at time zone 'Europe/Belgrade')::date);
    return jsonb_build_object('ok',true,'awarded',false,'alreadyApplied',true,'reason','ORDER_BONUS_ALREADY_EXISTS','bonus',to_jsonb(v_bonus),'summary',v_summary);
  end;

  begin
    insert into public.arka_pending_payments (
      order_id,amount,type,status,note,client_name,client_phone,order_code,
      created_by_pin,created_by_name,approved_by_pin,approved_by_name,
      handoff_note,source_module,idempotency_key,created_at,updated_at
    ) values (
      v_order.id,v_amount,'READY_48H_BONUS','ACCEPTED_BY_DISPATCH',
      concat('BONUS 48H NGA PAGESA ',to_char(v_amount,'FM999999990.00'),'€ • #',v_order.code,' • ',coalesce(v_order.client_name,''),' • ',to_char(v_m2,'FM999999990.00'),' m² × ',to_char(v_config.rate_m2,'FM999999990.00'),'€ • ',to_char(v_elapsed_minutes::numeric/60,'FM999999990.00'),'h'),
      v_order.client_name,v_order.client_phone,v_order.code,
      v_worker.pin,v_worker.name,'SYSTEM','BONUS 48H AUTO NGA PAGESA',
      concat('READY_BONUS_OPEN:',v_bonus.id),'ARKA',v_idem,now(),now()
    ) returning * into v_bonus_payment;
  exception when unique_violation then
    select * into v_bonus_payment
    from public.arka_pending_payments p
    where p.idempotency_key = v_idem
    limit 1;
  end;

  update public.base_ready_bonuses
  set arka_payment_id=v_bonus_payment.id,updated_at=now()
  where id=v_bonus.id
  returning * into v_bonus;

  v_order_data := coalesce(v_order.data,'{}'::jsonb) || jsonb_build_object(
    'base_ready_bonus_v2',jsonb_build_object(
      'worker_pin',v_worker.pin,
      'worker_name',v_worker.name,
      'm2',v_m2,
      'rate_m2',v_config.rate_m2,
      'amount',v_amount,
      'qualification_source','PAYMENT',
      'qualification_at',v_event_at,
      'payment_id',v_payment.id,
      'elapsed_minutes',v_elapsed_minutes,
      'eligible',true,
      'reason','ELIGIBLE_FULL_PAYMENT_WITHIN_48H',
      'version','base-ready-or-payment-bonus-v2'
    )
  );
  update public.orders set data=v_order_data,updated_at=now() where id=v_order.id;

  v_summary := public.get_base_ready_bonus_summary_v1(v_worker.pin, v_worker.pin, (v_event_at at time zone 'Europe/Belgrade')::date);
  return jsonb_build_object(
    'ok',true,
    'awarded',true,
    'alreadyApplied',false,
    'reason','ELIGIBLE_FULL_PAYMENT_WITHIN_48H',
    'bonus',to_jsonb(v_bonus),
    'summary',v_summary
  );
end;
$function$
;

CREATE OR REPLACE FUNCTION public.get_base_bonus_opportunities_v1(p_actor_pin text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor public.users%rowtype;
  v_config public.base_ready_bonus_config%rowtype;
  v_result jsonb;
begin
  select * into v_actor
  from public.users
  where pin=pg_catalog.btrim(coalesce(p_actor_pin,'')) and is_active is true
  limit 1;
  if not found then raise exception 'BONUS_ACTOR_NOT_FOUND'; end if;
  if pg_catalog.upper(coalesce(v_actor.role,'')) not in (
    'PUNTOR','PUNETOR','WORKER','BAZIST','BASE','DISPATCH','ADMIN','ADMIN_MASTER',
    'MASTER','MASTER USER','OWNER','PRONAR','SUPERADMIN'
  ) then raise exception 'BONUS_ACCESS_DENIED'; end if;

  select * into v_config from public.base_ready_bonus_config where id=1;
  if not found then raise exception 'BASE_READY_BONUS_CONFIG_MISSING'; end if;

  with candidates as (
    select
      o.id as order_id,o.code as order_code,o.client_name,o.client_phone,
      pg_catalog.lower(coalesce(o.status,'')) as status,
      pg_catalog.round(coalesce(public.tepiha_daily_order_m2(o.data,o.m2_total),0)::numeric,2) as m2,
      pg_catalog.round(greatest(
        coalesce(o.price_total,0),coalesce(o.total,0),
        case when coalesce(o.data#>>'{pay,euro}','') ~ '^-?[0-9]+(\.[0-9]+)?$'
          then (o.data#>>'{pay,euro}')::numeric else 0 end
      ),2) as total,
      pg_catalog.round(greatest(
        coalesce(o.paid,0),coalesce(o.paid_cash,0),
        case when coalesce(o.data#>>'{pay,paid}','') ~ '^-?[0-9]+(\.[0-9]+)?$'
          then (o.data#>>'{pay,paid}')::numeric else 0 end,
        case when coalesce(o.data->>'clientPaid','') ~ '^-?[0-9]+(\.[0-9]+)?$'
          then (o.data->>'clientPaid')::numeric else 0 end
      ),2) as paid,
      o.created_at,o.ready_at,
      pg_catalog.round(greatest(0,
        extract(epoch from (((case when ext.status='APPROVED' then ext.extended_deadline else o.created_at + pg_catalog.make_interval(hours => v_config.window_hours::int) end))-pg_catalog.now()))/3600
      )::numeric,2) as hours_left,
      (case when ext.status='APPROVED' then ext.extended_deadline else o.created_at + pg_catalog.make_interval(hours => v_config.window_hours::int) end) as deadline_at,
      pg_catalog.round(coalesce(public.tepiha_daily_order_m2(o.data,o.m2_total),0)::numeric * coalesce(v_config.rate_m2,0),2) as potential_bonus,
      b.id as bonus_id,b.eligible as bonus_eligible,b.status as bonus_status,b.worker_pin as bonus_worker_pin
    from public.orders o
    left join public.base_bonus_extensions ext on ext.order_id=o.id and ext.worker_id='19d3ab97-2067-493a-aeb1-8a23572dc5f8'::uuid
    left join public.base_ready_bonuses b on b.order_id=o.id
    where coalesce(v_config.enabled,false)
      and (case when ext.status='APPROVED' then ext.extended_deadline else o.created_at + pg_catalog.make_interval(hours => v_config.window_hours::int) end) > pg_catalog.now()
      and pg_catalog.lower(coalesce(o.status,'')) in ('pranim','pastrim','gati')
      and not public.base_order_is_fully_paid_v2(o.data,o.price_total,o.paid,o.paid_cash)
      and coalesce(public.tepiha_daily_order_m2(o.data,o.m2_total),0) > 0
  )
  select pg_catalog.jsonb_build_object(
    'ok',true,'generated_at',pg_catalog.now(),
    'viewer',pg_catalog.jsonb_build_object('user_id',v_actor.id,'pin',v_actor.pin,'name',v_actor.name),
    'config',pg_catalog.jsonb_build_object(
      'enabled',v_config.enabled,'window_hours',v_config.window_hours,
      'rate_m2',v_config.rate_m2,'effective_from',v_config.effective_from
    ),
    'rows',coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'order_id',order_id,'order_code',order_code,'client_name',client_name,'client_phone',client_phone,
      'status',status,'m2',m2,'total',total,'paid',paid,'debt',pg_catalog.round(greatest(0,total-paid),2),
      'created_at',created_at,'ready_at',ready_at,'hours_left',hours_left,'deadline_at',deadline_at,
      'potential_bonus',potential_bonus,'bonus_id',bonus_id,'bonus_eligible',bonus_eligible,
      'bonus_status',bonus_status,'bonus_worker_pin',bonus_worker_pin
    ) order by hours_left asc,order_code asc),'[]'::jsonb)
  ) into v_result from candidates;
  return v_result;
end;
$function$
;
