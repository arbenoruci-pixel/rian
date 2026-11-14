-- Transport push is isolated from order/payment writes. Browser roles have no
-- access to subscriptions, delivery records, worker RPCs, or Vault secrets.
create extension if not exists pg_net;

create table public.transport_push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  endpoint_hash text not null unique,
  user_id uuid not null references public.users(id) on delete cascade,
  device_id text not null,
  subscription jsonb not null,
  enabled boolean not null default true,
  updated_at timestamptz not null default now(),
  last_test_at timestamptz
);
create index transport_push_subscriptions_user on public.transport_push_subscriptions(user_id) where enabled;
create index transport_push_subscriptions_device on public.transport_push_subscriptions(device_id);
alter table public.transport_push_subscriptions enable row level security;
revoke all on public.transport_push_subscriptions from public, anon, authenticated;
grant select, insert, update, delete on public.transport_push_subscriptions to service_role;

create table public.transport_push_deliveries (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null,
  order_id uuid references public.transport_orders(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  subscription_id uuid not null references public.transport_push_subscriptions(id) on delete cascade,
  kind text not null check (kind in ('assignment','test')),
  state text not null default 'pending' check (state in ('pending','sending','sent','cancelled','failed')),
  attempts int not null default 0,
  next_attempt_at timestamptz not null default now(),
  lease_id uuid,
  lease_until timestamptz,
  error_code text,
  created_at timestamptz not null default now(),
  unique(event_id, subscription_id)
);
create index transport_push_due on public.transport_push_deliveries(next_attempt_at) where state in ('pending','sending');
create index transport_push_order on public.transport_push_deliveries(order_id);
create index transport_push_user on public.transport_push_deliveries(user_id);
create index transport_push_subscription on public.transport_push_deliveries(subscription_id);
alter table public.transport_push_deliveries enable row level security;
revoke all on public.transport_push_deliveries from public, anon, authenticated;
grant select, insert, update, delete on public.transport_push_deliveries to service_role;

-- Only this restricted helper can read the encrypted configuration. These
-- device-authenticated sessions do not use Supabase Auth/auth.uid().
create or replace function private.transport_push_config_v1() returns jsonb
language sql security definer set search_path = '' as $$
  select decrypted_secret::jsonb from vault.decrypted_secrets where name='tepiha_transport_push_v1' limit 1;
$$;
revoke all on function private.transport_push_config_v1() from public, anon, authenticated;
grant usage on schema private to service_role;
grant execute on function private.transport_push_config_v1() to service_role;

create or replace function public.transport_push_worker_config_v1() returns jsonb
language sql security invoker set search_path = '' as $$ select private.transport_push_config_v1(); $$;
revoke all on function public.transport_push_worker_config_v1() from public, anon, authenticated;
grant execute on function public.transport_push_worker_config_v1() to service_role;

create or replace function private.transport_push_wake_v1() returns void
language plpgsql security definer set search_path = '' as $$
declare cfg jsonb;
begin
  if not exists(select 1 from public.transport_push_deliveries where state in ('pending','sending')
    and attempts < 5 and next_attempt_at <= now() and (lease_until is null or lease_until < now())
    and created_at > now()-interval '12 hours') then return; end if;
  cfg := private.transport_push_config_v1();
  if cfg is null or cfg->>'enabled' <> 'true' then return; end if;
  perform net.http_post(url:=cfg->>'workerUrl',
    headers:=jsonb_build_object('Content-Type','application/json','x-tepiha-push-key',cfg->>'workerToken'),
    body:='{}'::jsonb, timeout_milliseconds:=5000);
exception when others then
  -- Retain the durable pending rows; the bounded retry job will wake again.
  raise warning 'transport_push_wake_failed: %', sqlstate;
end; $$;
revoke all on function private.transport_push_wake_v1() from public, anon, authenticated;
grant execute on function private.transport_push_wake_v1() to service_role;

create or replace function private.transport_push_assignment_v1() returns trigger
language plpgsql security definer set search_path = '' as $$
declare driver text; previous text; event uuid := gen_random_uuid();
begin
  driver := coalesce(nullif(new.transport_id,''),new.data->>'assigned_driver_id');
  if driver is null or lower(coalesce(new.status,'')) not in ('assigned','dispatched') then return new; end if;
  if tg_op='UPDATE' then
    previous := coalesce(nullif(old.transport_id,''),old.data->>'assigned_driver_id');
    if driver is not distinct from previous then return new; end if;
  end if;
  -- Compare as text so a historical PIN cannot abort an order transaction.
  insert into public.transport_push_deliveries(event_id,order_id,user_id,subscription_id,kind)
  select event,new.id,s.user_id,s.id,'assignment'
  from public.transport_push_subscriptions s
  join public.users u on u.id=s.user_id
  join public.tepiha_user_devices d on d.device_id=s.device_id and d.user_id=s.user_id and d.is_approved=true
  where s.user_id::text=driver and s.enabled and u.is_active is distinct from false
    and (upper(u.role)='TRANSPORT' or u.is_hybrid_transport=true);
  perform private.transport_push_wake_v1();
  return new;
exception when others then
  -- A notification failure must never reject a real business order.
  raise warning 'transport_push_assignment_failed: %', sqlstate;
  return new;
end; $$;
revoke all on function private.transport_push_assignment_v1() from public, anon, authenticated;
create trigger transport_push_assignment_v1 after insert or update on public.transport_orders
for each row execute function private.transport_push_assignment_v1();

create or replace function public.transport_push_manage_v1(
  p_action text,p_user_id uuid,p_device_id text,p_subscription jsonb default null,p_endpoint_hash text default null
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare sub public.transport_push_subscriptions%rowtype; cfg jsonb;
begin
  if not exists(select 1 from public.tepiha_user_devices d join public.users u on u.id=d.user_id
    where d.device_id=p_device_id and d.user_id=p_user_id and d.is_approved=true and u.is_active is distinct from false)
    then raise exception 'PUSH_SESSION_CHANGED'; end if;
  if p_action='DISABLE' then
    update public.transport_push_subscriptions set enabled=false,updated_at=now() where device_id=p_device_id;
    return jsonb_build_object('enabled',false);
  end if;
  if not exists(select 1 from public.users where id=p_user_id and (upper(role)='TRANSPORT' or is_hybrid_transport=true))
    then raise exception 'PUSH_DRIVER_REQUIRED'; end if;
  cfg:=private.transport_push_config_v1();
  if cfg is null or cfg->>'enabled'<>'true' then raise exception 'PUSH_UNAVAILABLE'; end if;
  if p_action='SUBSCRIBE' then
    if p_subscription is null or p_endpoint_hash is null or length(p_endpoint_hash)<>64 then raise exception 'PUSH_SUBSCRIPTION_INVALID'; end if;
    -- Rebinding the same browser cancels its previous user's queued messages.
    update public.transport_push_subscriptions set enabled=false,updated_at=now()
      where device_id=p_device_id and endpoint_hash<>p_endpoint_hash;
    insert into public.transport_push_subscriptions(endpoint_hash,user_id,device_id,subscription)
      values(p_endpoint_hash,p_user_id,p_device_id,p_subscription)
      on conflict(endpoint_hash) do update set user_id=excluded.user_id,device_id=excluded.device_id,
        subscription=excluded.subscription,enabled=true,updated_at=now()
      returning * into sub;
  else
    select * into sub from public.transport_push_subscriptions where device_id=p_device_id and user_id=p_user_id and enabled order by updated_at desc limit 1;
  end if;
  if p_action='TEST' then
    if sub.id is null then raise exception 'PUSH_NOT_ENABLED'; end if;
    update public.transport_push_subscriptions set last_test_at=now()
      where id=sub.id and (last_test_at is null or last_test_at<now()-interval '1 minute');
    if not found then raise exception 'PUSH_TEST_RATE_LIMIT'; end if;
    insert into public.transport_push_deliveries(event_id,user_id,subscription_id,kind)
      values(gen_random_uuid(),p_user_id,sub.id,'test');
    perform private.transport_push_wake_v1();
  elsif p_action not in ('STATUS','SUBSCRIBE') then raise exception 'PUSH_ACTION_INVALID'; end if;
  return jsonb_build_object('enabled',sub.id is not null,'publicKey',cfg->>'publicKey',
    'endpointHash',sub.endpoint_hash,'testQueued',p_action='TEST');
end; $$;
revoke all on function public.transport_push_manage_v1(text,uuid,text,jsonb,text) from public,anon,authenticated;
grant execute on function public.transport_push_manage_v1(text,uuid,text,jsonb,text) to service_role;

create or replace function public.transport_push_claim_v1(p_lease uuid) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare result jsonb;
begin
  update public.transport_push_deliveries q set state='cancelled',lease_until=null
  where state in ('pending','sending') and (q.created_at<now()-interval '12 hours' or (q.attempts>=5 and q.lease_until<now())
    or not exists(select 1 from public.transport_push_subscriptions s
      join public.users u on u.id=s.user_id
      join public.tepiha_user_devices d on d.device_id=s.device_id and d.user_id=s.user_id and d.is_approved=true
      where s.id=q.subscription_id and s.user_id=q.user_id and s.enabled and u.is_active is distinct from false
        and (upper(u.role)='TRANSPORT' or u.is_hybrid_transport=true))
    or (q.kind='assignment' and not exists(select 1 from public.transport_orders o where o.id=q.order_id
      and coalesce(nullif(o.transport_id,''),o.data->>'assigned_driver_id')=q.user_id::text
      and lower(o.status) in ('assigned','dispatched'))));
  with candidates as (
    select id from public.transport_push_deliveries where state in ('pending','sending') and attempts<5
    and next_attempt_at<=now() and (lease_until is null or lease_until<now())
    order by created_at for update skip locked limit 10
  ), claimed as (
    update public.transport_push_deliveries q set state='sending',attempts=attempts+1,
      lease_id=p_lease,lease_until=now()+interval '2 minutes'
    from candidates c where q.id=c.id returning q.*
  ) select coalesce(jsonb_agg(jsonb_build_object('id',q.id,'eventId',q.event_id,'orderId',q.order_id,
      'userId',q.user_id,'kind',q.kind,'subscription',s.subscription)),'[]'::jsonb) into result
    from claimed q join public.transport_push_subscriptions s on s.id=q.subscription_id;
  return result;
end; $$;
revoke all on function public.transport_push_claim_v1(uuid) from public,anon,authenticated;
grant execute on function public.transport_push_claim_v1(uuid) to service_role;

create or replace function public.transport_push_finish_v1(p_id uuid,p_lease uuid,p_status int) returns void
language plpgsql security invoker set search_path = '' as $$
declare q public.transport_push_deliveries%rowtype;
begin
  select * into q from public.transport_push_deliveries where id=p_id and lease_id=p_lease and state='sending' for update;
  if q.id is null then return; end if;
  if p_status in (404,410) then update public.transport_push_subscriptions set enabled=false where id=q.subscription_id; end if;
  update public.transport_push_deliveries set state=case
    when p_status between 200 and 299 then 'sent'
    when p_status in (0,408,429) or p_status>=500 then case when attempts<5 then 'pending' else 'failed' end
    else 'failed' end,
    error_code=case when p_status between 200 and 299 then null else 'HTTP_'||p_status::text end,
    next_attempt_at=now()+make_interval(secs=>least(1800,60*(2^attempts)::int)),lease_until=null
    where id=q.id;
end; $$;
revoke all on function public.transport_push_finish_v1(uuid,uuid,int) from public,anon,authenticated;
grant execute on function public.transport_push_finish_v1(uuid,uuid,int) to service_role;

-- No Vercel polling/cron. Supabase only invokes the worker when work is due.
select cron.schedule('tepiha_transport_push_retry_v1','*/2 * * * *',
  $$select private.transport_push_wake_v1(); delete from public.transport_push_deliveries where created_at<now()-interval '7 days';$$);
