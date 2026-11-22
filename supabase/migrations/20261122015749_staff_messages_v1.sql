-- Internal staff messages. Access is mediated by the approved-device server API.
-- No staff identities or production messages are seeded by this migration.
begin;

create table if not exists public.staff_messages (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references public.users(id) on delete restrict,
  sender_name text not null,
  sender_role text not null,
  title text not null check (char_length(btrim(title)) between 1 and 120),
  body text not null check (char_length(btrim(body)) between 1 and 4000),
  audience text not null default 'SELECTED' check (audience in ('SELECTED','ALL_WORKERS')),
  request_key uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  unique (sender_id, request_key)
);
create index if not exists staff_messages_sender_created_idx on public.staff_messages(sender_id, created_at desc, id desc);

create table if not exists public.staff_message_recipients (
  message_id uuid not null references public.staff_messages(id) on delete restrict,
  recipient_id uuid not null references public.users(id) on delete restrict,
  recipient_name text not null,
  read_at timestamptz,
  acknowledged_at timestamptz,
  primary key (message_id, recipient_id),
  check (acknowledged_at is null or read_at is not null)
);
create index if not exists staff_message_recipients_inbox_idx on public.staff_message_recipients(recipient_id, message_id);
create index if not exists staff_message_recipients_unread_idx on public.staff_message_recipients(recipient_id) where read_at is null;

alter table public.staff_messages enable row level security;
alter table public.staff_message_recipients enable row level security;
revoke all on public.staff_messages, public.staff_message_recipients from public, anon, authenticated;
grant select, insert on public.staff_messages to service_role;
grant select, insert, update on public.staff_message_recipients to service_role;

create or replace function public.staff_message_send_v1(
  p_actor_id uuid, p_recipient_ids uuid[], p_title text, p_body text, p_request_key uuid, p_all_workers boolean default false
) returns jsonb
language plpgsql security invoker set search_path = public, pg_temp
as $function$
declare
  v_actor public.users%rowtype;
  v_ids uuid[];
  v_existing_ids uuid[];
  v_message public.staff_messages%rowtype;
  v_count integer;
begin
  select * into v_actor from public.users where id=p_actor_id and is_active is true for share;
  if not found or upper(trim(coalesce(v_actor.role,''))) not in ('SUPERADMIN','OWNER','PRONAR','ADMIN_MASTER','ADMIN','DISPATCH','MASTER','MASTER USER','MASTER_USER','MASTERUSER') then
    raise exception 'STAFF_MESSAGE_FORBIDDEN';
  end if;
  if p_request_key is null or p_title is null or p_body is null or p_all_workers is null
     or char_length(btrim(p_title)) not between 1 and 120
     or char_length(btrim(p_body)) not between 1 and 4000 then
    raise exception 'STAFF_MESSAGE_BODY_INVALID';
  end if;
  if p_all_workers then
    if coalesce(cardinality(p_recipient_ids),0)>0 then raise exception 'STAFF_MESSAGE_BODY_INVALID'; end if;
  else
    if p_recipient_ids is null or cardinality(p_recipient_ids)=0
       or cardinality(p_recipient_ids)>100 or array_position(p_recipient_ids,null) is not null then
      raise exception 'STAFF_MESSAGE_RECIPIENT_INVALID';
    end if;
    select array_agg(distinct x order by x) into v_ids from unnest(p_recipient_ids) x;
  end if;

  -- Serializes duplicate request keys and the per-sender send bound in one transaction.
  perform pg_advisory_xact_lock(hashtextextended('staff_messages_sender:'||p_actor_id::text,0));
  select * into v_message from public.staff_messages where sender_id=p_actor_id and request_key=p_request_key;
  if found then
    select array_agg(recipient_id order by recipient_id) into v_existing_ids
      from public.staff_message_recipients where message_id=v_message.id;
    if v_message.title<>btrim(p_title) or v_message.body<>btrim(p_body)
       or v_message.audience<>(case when p_all_workers then 'ALL_WORKERS' else 'SELECTED' end)
       or (not p_all_workers and v_existing_ids is distinct from v_ids) then
      raise exception 'STAFF_MESSAGE_IDEMPOTENCY_CONFLICT';
    end if;
    return jsonb_build_object('messageId',v_message.id,'createdAt',v_message.created_at,'recipientCount',cardinality(v_existing_ids),'alreadySent',true);
  end if;

  if p_all_workers then
    select array_agg(id order by id) into v_ids from (
      select id from public.users where id<>p_actor_id and is_active is true
        and upper(trim(coalesce(role,''))) in ('PUNTOR','PUNETOR','WORKER','BAZIST','BASE','TRANSPORT','DISPATCH')
      order by id for share
    ) eligible;
    if coalesce(cardinality(v_ids),0) not between 1 and 100 then raise exception 'STAFF_MESSAGE_RECIPIENT_INVALID'; end if;
  end if;
  perform 1 from public.users where id=any(v_ids) for share;
  select count(*) into v_count from public.users
    where id=any(v_ids) and id<>p_actor_id and is_active is true
      and upper(trim(coalesce(role,''))) in ('PUNTOR','PUNETOR','WORKER','BAZIST','BASE','TRANSPORT','DISPATCH');
  if v_count<>cardinality(v_ids) then raise exception 'STAFF_MESSAGE_RECIPIENT_INVALID'; end if;
  select count(*) into v_count from public.staff_messages
    where sender_id=p_actor_id and created_at>clock_timestamp()-interval '1 hour';
  if v_count>=30 then raise exception 'STAFF_MESSAGE_RATE_LIMIT'; end if;

  insert into public.staff_messages(sender_id,sender_name,sender_role,title,body,audience,request_key)
    values(p_actor_id,coalesce(nullif(btrim(v_actor.name),''),'Dispatch'),upper(trim(v_actor.role)),btrim(p_title),btrim(p_body),case when p_all_workers then 'ALL_WORKERS' else 'SELECTED' end,p_request_key)
    returning * into v_message;
  insert into public.staff_message_recipients(message_id,recipient_id,recipient_name)
    select v_message.id,u.id,coalesce(nullif(btrim(u.name),''),'Punëtor') from public.users u where u.id=any(v_ids);
  return jsonb_build_object('messageId',v_message.id,'createdAt',v_message.created_at,'recipientCount',cardinality(v_ids),'alreadySent',false);
end;
$function$;

create or replace function public.staff_messages_read_v1(
  p_actor_id uuid, p_mode text default 'inbox', p_before_at timestamptz default null,
  p_before_id uuid default null, p_limit integer default 30
) returns jsonb
language plpgsql security invoker set search_path = public, pg_temp
as $function$
declare
  v_role text;
  v_unread integer;
  v_items jsonb;
  v_next jsonb;
  v_limit integer := greatest(1,least(coalesce(p_limit,30),50));
begin
  select upper(trim(coalesce(role,''))) into v_role from public.users where id=p_actor_id and is_active is true;
  if not found or v_role not in ('SUPERADMIN','OWNER','PRONAR','ADMIN_MASTER','ADMIN','DISPATCH','MASTER','MASTER USER','MASTER_USER','MASTERUSER','PUNTOR','PUNETOR','WORKER','BAZIST','BASE','TRANSPORT') then
    raise exception 'STAFF_MESSAGE_FORBIDDEN';
  end if;
  if p_mode is null or p_mode not in ('inbox','sent','badge') or (p_before_at is null)<>(p_before_id is null) then raise exception 'STAFF_MESSAGE_BODY_INVALID'; end if;
  if p_mode='sent' and v_role not in ('SUPERADMIN','OWNER','PRONAR','ADMIN_MASTER','ADMIN','DISPATCH','MASTER','MASTER USER','MASTER_USER','MASTERUSER') then
    raise exception 'STAFF_MESSAGE_FORBIDDEN';
  end if;
  select count(*)::integer into v_unread from public.staff_message_recipients where recipient_id=p_actor_id and read_at is null;
  if p_mode='badge' then return jsonb_build_object('unreadCount',v_unread); end if;

  if p_mode='inbox' then
    with picked as (
      select m.id,m.title,m.body,m.created_at,m.sender_name,m.sender_role,r.read_at,r.acknowledged_at
      from public.staff_message_recipients r join public.staff_messages m on m.id=r.message_id
      where r.recipient_id=p_actor_id and (p_before_at is null or (m.created_at,m.id)<(p_before_at,p_before_id))
      order by m.created_at desc,m.id desc limit v_limit+1
    ), limited as (select * from picked order by created_at desc,id desc limit v_limit)
    select coalesce((select jsonb_agg(jsonb_build_object(
      'id',id,'title',title,'body',body,'createdAt',created_at,'senderName',sender_name,'senderRole',sender_role,
      'readAt',read_at,'acknowledgedAt',acknowledged_at
    ) order by created_at desc,id desc) from limited),'[]'::jsonb),
    case when (select count(*) from picked)>v_limit then
      (select jsonb_build_object('at',created_at,'id',id) from limited order by created_at,id limit 1) else null end
    into v_items,v_next;
  else
    with picked as (
      select m.* from public.staff_messages m
      where m.sender_id=p_actor_id and (p_before_at is null or (m.created_at,m.id)<(p_before_at,p_before_id))
      order by m.created_at desc,m.id desc limit v_limit+1
    ), limited as (select * from picked order by created_at desc,id desc limit v_limit)
    select coalesce((select jsonb_agg(jsonb_build_object(
      'id',m.id,'title',m.title,'body',m.body,'createdAt',m.created_at,'senderName',m.sender_name,'senderRole',m.sender_role,
      'recipients',(select coalesce(jsonb_agg(jsonb_build_object('id',r.recipient_id,'name',r.recipient_name,'readAt',r.read_at,'acknowledgedAt',r.acknowledged_at) order by r.recipient_name,r.recipient_id),'[]'::jsonb) from public.staff_message_recipients r where r.message_id=m.id)
    ) order by m.created_at desc,m.id desc) from limited m),'[]'::jsonb),
    case when (select count(*) from picked)>v_limit then
      (select jsonb_build_object('at',created_at,'id',id) from limited order by created_at,id limit 1) else null end
    into v_items,v_next;
  end if;
  return jsonb_build_object('items',v_items,'nextCursor',v_next,'unreadCount',v_unread);
end;
$function$;

create or replace function public.staff_message_read_receipt_v1(p_actor_id uuid,p_message_id uuid,p_acknowledge boolean default false)
returns jsonb language plpgsql security invoker set search_path = public, pg_temp
as $function$
declare v_result jsonb;
begin
  if not exists(select 1 from public.users where id=p_actor_id and is_active is true
    and upper(trim(coalesce(role,''))) in ('SUPERADMIN','OWNER','PRONAR','ADMIN_MASTER','ADMIN','DISPATCH','MASTER','MASTER USER','MASTER_USER','MASTERUSER','PUNTOR','PUNETOR','WORKER','BAZIST','BASE','TRANSPORT')) then
    raise exception 'STAFF_MESSAGE_FORBIDDEN';
  end if;
  update public.staff_message_recipients
    set read_at=coalesce(read_at,clock_timestamp()),
      acknowledged_at=case when p_acknowledge is true then coalesce(acknowledged_at,clock_timestamp()) else acknowledged_at end
    where message_id=p_message_id and recipient_id=p_actor_id
    returning jsonb_build_object('messageId',message_id,'readAt',read_at,'acknowledgedAt',acknowledged_at) into v_result;
  if v_result is null then raise exception 'STAFF_MESSAGE_NOT_FOUND'; end if;
  return v_result || jsonb_build_object('unreadCount',(select count(*)::integer from public.staff_message_recipients where recipient_id=p_actor_id and read_at is null));
end;
$function$;

revoke all on function public.staff_message_send_v1(uuid,uuid[],text,text,uuid,boolean) from public,anon,authenticated;
revoke all on function public.staff_messages_read_v1(uuid,text,timestamptz,uuid,integer) from public,anon,authenticated;
revoke all on function public.staff_message_read_receipt_v1(uuid,uuid,boolean) from public,anon,authenticated;
grant execute on function public.staff_message_send_v1(uuid,uuid[],text,text,uuid,boolean) to service_role;
grant execute on function public.staff_messages_read_v1(uuid,text,timestamptz,uuid,integer) to service_role;
grant execute on function public.staff_message_read_receipt_v1(uuid,uuid,boolean) to service_role;

commit;
