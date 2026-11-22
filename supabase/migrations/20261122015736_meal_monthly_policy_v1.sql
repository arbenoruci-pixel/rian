-- Dated monthly meal benefit; no employee identities are embedded in this migration.
-- Membership is configured separately by the authorized operator.
create table if not exists public.meal_policy_versions (
  policy_key text primary key check (policy_key ~ '^[A-Za-z0-9_-]{4,80}$'),
  effective_from date not null check (extract(day from effective_from)=1),
  daily_rate numeric(12,2) not null check (daily_rate>=0),
  work_days integer not null check (work_days between 1 and 31),
  monthly_amount numeric(12,2) not null check (monthly_amount=round(daily_rate*work_days,2)),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  unique(effective_from)
);
create table if not exists public.meal_policy_members (
  policy_key text not null references public.meal_policy_versions(policy_key),
  worker_id uuid not null references public.users(id),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  primary key(policy_key,worker_id)
);
create index if not exists meal_policy_members_worker_idx on public.meal_policy_members(worker_id,policy_key);
create table if not exists public.meal_policy_acknowledgements (
  policy_key text not null,
  worker_id uuid not null,
  acknowledged_at timestamptz not null default now(),
  primary key(policy_key,worker_id),
  foreign key(policy_key,worker_id) references public.meal_policy_members(policy_key,worker_id)
);
create table if not exists public.meal_policy_function_backups (
  signature text primary key,
  definition text not null,
  captured_at timestamptz not null default now()
);
alter table public.meal_policy_versions enable row level security;
alter table public.meal_policy_members enable row level security;
alter table public.meal_policy_acknowledgements enable row level security;
alter table public.meal_policy_function_backups enable row level security;
revoke all on public.meal_policy_versions,public.meal_policy_members,public.meal_policy_acknowledgements,public.meal_policy_function_backups from public,anon,authenticated;
grant select on public.meal_policy_versions,public.meal_policy_members,public.meal_policy_acknowledgements to service_role;
grant insert on public.meal_policy_acknowledgements to service_role;

insert into public.meal_policy_versions(policy_key,effective_from,daily_rate,work_days,monthly_amount)
values('meal_monthly_2026_12','2026-12-01',3,26,78)
on conflict(policy_key) do nothing;

create or replace function public.meal_policy_schedule_v1(p_date date)
returns jsonb language sql stable security invoker set search_path=pg_catalog,public as $$
  select jsonb_build_object('policyKey',v.policy_key,'effectiveFrom',v.effective_from,'effectiveAt',v.effective_from::timestamp at time zone 'Europe/Belgrade','dailyRate',v.daily_rate,'workDays',v.work_days,'monthlyAmount',v.monthly_amount,'enabled',v.enabled)
  from public.meal_policy_versions v where v.enabled and v.effective_from<=p_date
  order by v.effective_from desc limit 1;
$$;
create or replace function public.meal_policy_allowance_v1(p_worker_id uuid,p_month date)
returns jsonb language sql stable security invoker set search_path=pg_catalog,public as $$
  select public.meal_policy_schedule_v1(date_trunc('month',p_month)::date)||jsonb_build_object('workerId',p_worker_id)
  from public.meal_policy_members m
  where m.worker_id=p_worker_id and m.enabled
    and m.policy_key=public.meal_policy_schedule_v1(date_trunc('month',p_month)::date)->>'policyKey'
  limit 1;
$$;
create or replace function public.meal_policy_amount_v1(p_worker_id uuid,p_month date,p_legacy numeric default 0)
returns numeric language sql stable security invoker set search_path=pg_catalog,public as $$
  select case when public.meal_policy_schedule_v1(date_trunc('month',p_month)::date) is null
    then round(coalesce(p_legacy,0),2)
    else coalesce((public.meal_policy_allowance_v1(p_worker_id,p_month)->>'monthlyAmount')::numeric,0) end;
$$;
revoke all on function public.meal_policy_schedule_v1(date),public.meal_policy_allowance_v1(uuid,date),public.meal_policy_amount_v1(uuid,date,numeric) from public,anon,authenticated;
grant execute on function public.meal_policy_schedule_v1(date),public.meal_policy_allowance_v1(uuid,date),public.meal_policy_amount_v1(uuid,date,numeric) to service_role;

-- Used by the authenticated payroll server before any company-budget debit.
-- Older periods retain their existing payment flow and snapshots.
create or replace function public.get_meal_policy_salary_basis_v1(p_worker_pin text,p_month_key text)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare v_worker public.users%rowtype; v_month date; v_meal numeric; v_gross numeric;
begin
  if p_month_key is null or p_month_key !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then raise exception 'MEAL_POLICY_MONTH_INVALID'; end if;
  v_month:=(p_month_key||'-01')::date;
  if public.meal_policy_schedule_v1(v_month) is null then return jsonb_build_object('scheduled',false); end if;
  select * into v_worker from public.users where pin=trim(p_worker_pin) and is_active;
  if not found then raise exception 'MEAL_POLICY_WORKER_NOT_FOUND'; end if;
  v_meal:=public.meal_policy_amount_v1(v_worker.id,v_month,0);
  v_gross:=round((case when v_worker.pay_salary_enabled is distinct from false then coalesce(v_worker.salary,0) else 0 end + v_meal + case when v_worker.pay_transport_bonus_enabled then coalesce(v_worker.pay_transport_bonus_amount,0) else 0 end)::numeric,2);
  return jsonb_build_object('scheduled',true,'workerId',v_worker.id,'month',p_month_key,'mealAmount',v_meal,'grossFixed',v_gross);
end;
$$;
revoke all on function public.get_meal_policy_salary_basis_v1(text,text) from public,anon,authenticated;
grant execute on function public.get_meal_policy_salary_basis_v1(text,text) to service_role;

create or replace function public.get_meal_policy_state_v1(p_actor_id uuid,p_scope text default 'own',p_target_id uuid default null)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare
  v_role text;
  v_target uuid:=coalesce(p_target_id,p_actor_id);
  v_manager boolean;
  v_today date:=(now() at time zone 'Europe/Belgrade')::date;
begin
  select upper(role) into v_role from public.users where id=p_actor_id and is_active;
  if v_role is null then raise exception 'MEAL_POLICY_ACTOR_NOT_ACTIVE'; end if;
  v_manager:=v_role in ('ADMIN','ADMIN_MASTER','DISPATCH','OWNER','PRONAR','SUPERADMIN','MASTER','MASTER_USER','MASTERUSER');
  if p_scope is null or p_scope not in ('own','team') or (not v_manager and (p_scope='team' or v_target<>p_actor_id)) then raise exception 'MEAL_POLICY_FORBIDDEN'; end if;
  return jsonb_build_object(
    'serverNow',now(),'businessDate',v_today,'actorId',p_actor_id,'targetId',v_target,
    'dailyMealsAllowed',public.meal_policy_schedule_v1(v_today) is null,
    'nextActivationAt',(select min(effective_from::timestamp at time zone 'Europe/Belgrade') from public.meal_policy_versions where enabled and effective_from>v_today),
    'settings',coalesce((select jsonb_agg(jsonb_build_object('policyKey',v.policy_key,'effectiveFrom',v.effective_from,'effectiveAt',v.effective_from::timestamp at time zone 'Europe/Belgrade','dailyRate',v.daily_rate,'workDays',v.work_days,'monthlyAmount',v.monthly_amount,'enabled',v.enabled) order by v.effective_from) from public.meal_policy_versions v where v.enabled),'[]'::jsonb),
    'policies',coalesce((select jsonb_agg(jsonb_build_object('policyKey',m.policy_key,'workerId',m.worker_id,'enabled',m.enabled)) from public.meal_policy_members m join public.meal_policy_versions v using(policy_key) where m.enabled and v.enabled and (p_scope='team' or m.worker_id=v_target)),'[]'::jsonb),
    'acknowledged',coalesce((select jsonb_agg(a.policy_key) from public.meal_policy_acknowledgements a where a.worker_id=p_actor_id),'[]'::jsonb)
  );
end;
$$;
create or replace function public.acknowledge_meal_policy_v1(p_actor_id uuid,p_policy_key text)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare v_at timestamptz;
begin
  if not exists(select 1 from public.users u join public.meal_policy_members m on m.worker_id=u.id join public.meal_policy_versions v using(policy_key) where u.id=p_actor_id and u.is_active and m.enabled and v.enabled and v.policy_key=p_policy_key and v.effective_from<=(now() at time zone 'Europe/Belgrade')::date) then raise exception 'MEAL_POLICY_NOT_ELIGIBLE_OR_NOT_ACTIVE'; end if;
  insert into public.meal_policy_acknowledgements(policy_key,worker_id) values(p_policy_key,p_actor_id) on conflict do nothing;
  select acknowledged_at into v_at from public.meal_policy_acknowledgements where policy_key=p_policy_key and worker_id=p_actor_id;
  return jsonb_build_object('policyKey',p_policy_key,'acknowledgedAt',v_at);
end;
$$;
revoke all on function public.get_meal_policy_state_v1(uuid,text,uuid),public.acknowledge_meal_policy_v1(uuid,text) from public,anon,authenticated;
grant execute on function public.get_meal_policy_state_v1(uuid,text,uuid),public.acknowledge_meal_policy_v1(uuid,text) to service_role;

-- Trigger enforcement also covers old clients, direct writes and delayed queue replay.
-- Existing meal settlements may update their status/settlement markers without recreating cash.
create or replace function public.guard_daily_meal_policy_v1()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_day date;v_old_day date;v_mark text;v_closed boolean;v_old_settlement text;v_new_settlement text;
begin
  if upper(coalesce(new.type,'')) not in ('MEAL_PAYMENT','MEAL_COVERED') then
    if tg_op='INSERT' then return new; end if;
    if upper(coalesce(old.type,'')) not in ('MEAL_PAYMENT','MEAL_COVERED') then return new; end if;
  end if;
  v_mark:=(regexp_match(coalesce(new.handoff_note,'')||' '||coalesce(new.note,''),'MEAL_(DAY|OPEN|CARRY|DEBT):([0-9]{4}-[0-9]{2}-[0-9]{2})'))[2];
  v_day:=coalesce(v_mark::date,(coalesce(new.created_at,now()) at time zone 'Europe/Belgrade')::date);
  v_closed:=public.meal_policy_schedule_v1((clock_timestamp() at time zone 'Europe/Belgrade')::date) is not null or public.meal_policy_schedule_v1(v_day) is not null;
  if not v_closed then return new; end if;
  if tg_op='INSERT' then raise exception 'DAILY_MEALS_REPLACED_BY_MONTHLY_ALLOWANCE'; end if;
  v_old_settlement:=(regexp_match(coalesce(old.handoff_note,''),'SETTLED_IN_HANDOFF:([^|;[:space:]]+)'))[1];
  v_new_settlement:=(regexp_match(coalesce(new.handoff_note,''),'SETTLED_IN_HANDOFF:([^|;[:space:]]+)'))[1];
  if v_old_settlement is not null and v_new_settlement is distinct from v_old_settlement then raise exception 'SETTLED_MEAL_CANNOT_BE_REOPENED'; end if;
  -- The legacy atomic RPC replaces the note with a settlement ID. Keep its
  -- original day/targets so an older carry claim stays traceable after payment.
  if v_old_settlement is null and v_new_settlement is not null and nullif(old.handoff_note,'') is not null and strpos(new.handoff_note,old.handoff_note)=0 then
    new.handoff_note:=new.handoff_note||' | '||old.handoff_note;
    v_mark:=(regexp_match(coalesce(new.handoff_note,'')||' '||coalesce(new.note,''),'MEAL_(DAY|OPEN|CARRY|DEBT):([0-9]{4}-[0-9]{2}-[0-9]{2})'))[2];
    v_day:=coalesce(v_mark::date,(coalesce(new.created_at,now()) at time zone 'Europe/Belgrade')::date);
  end if;
  v_mark:=(regexp_match(coalesce(old.handoff_note,'')||' '||coalesce(old.note,''),'MEAL_(DAY|OPEN|CARRY|DEBT):([0-9]{4}-[0-9]{2}-[0-9]{2})'))[2];
  v_old_day:=coalesce(v_mark::date,(coalesce(old.created_at,now()) at time zone 'Europe/Belgrade')::date);
  if new.type is distinct from old.type or new.amount is distinct from old.amount or new.created_by_pin is distinct from old.created_by_pin or new.created_by_name is distinct from old.created_by_name or new.created_at is distinct from old.created_at or v_day is distinct from v_old_day then
    raise exception 'DAILY_MEALS_REPLACED_BY_MONTHLY_ALLOWANCE';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_daily_meal_policy_v1() from public,anon,authenticated;
drop trigger if exists guard_daily_meal_policy_v1 on public.arka_pending_payments;
create trigger guard_daily_meal_policy_v1 before insert or update on public.arka_pending_payments for each row execute function public.guard_daily_meal_policy_v1();

-- Patch only known allowance anchors; preserve the current finance/auth implementation.
-- The backups are not exposed through the Data API and are retained for rollback.
do $migration$
declare v_signature text;v_before text;v_after text;v_anchor text;
begin
  foreach v_signature in array array['public.get_worker_compensation_profile_v1(text,text)','public.save_worker_compensation_profile_v1(text,text,text,jsonb,text)','public.get_worker_finance_snapshot_v1(text,text,date)','public.preview_monthly_payroll_close(text)'] loop
    select pg_get_functiondef(v_signature::regprocedure) into v_before;
    if strpos(v_before,'MEAL_POLICY_DATED_V1')>0 then continue; end if;
    insert into public.meal_policy_function_backups(signature,definition) values(v_signature,v_before) on conflict do nothing;
    v_after:=v_before;
    if v_signature='public.get_worker_compensation_profile_v1(text,text)' then
      v_anchor:=$a$'meal_enabled',v_worker.pay_meal_enabled,$a$;
      if strpos(v_after,v_anchor)=0 then raise exception 'MEAL_POLICY_PROFILE_ANCHOR_CHANGED'; end if;
      v_after:=replace(v_after,v_anchor,$b$'legacy_meal_enabled',v_worker.pay_meal_enabled,
    'legacy_meal_amount',round(coalesce(v_worker.pay_meal_amount,0)::numeric,2),
    'meal_policy',public.meal_policy_allowance_v1(v_worker.id,(now() at time zone 'Europe/Belgrade')::date),
    'meal_enabled',case when public.meal_policy_schedule_v1((now() at time zone 'Europe/Belgrade')::date) is null then v_worker.pay_meal_enabled else public.meal_policy_allowance_v1(v_worker.id,(now() at time zone 'Europe/Belgrade')::date) is not null end,$b$);
      v_anchor:=$a$'meal_amount',round(coalesce(v_worker.pay_meal_amount,0)::numeric,2),$a$;
      if strpos(v_after,v_anchor)=0 then raise exception 'MEAL_POLICY_PROFILE_AMOUNT_ANCHOR_CHANGED'; end if;
      v_after:=replace(v_after,v_anchor,$b$'meal_amount',public.meal_policy_amount_v1(v_worker.id,(now() at time zone 'Europe/Belgrade')::date,case when v_worker.pay_meal_enabled then coalesce(v_worker.pay_meal_amount,0) else 0 end),$b$);
    elsif v_signature='public.save_worker_compensation_profile_v1(text,text,text,jsonb,text)' then
      v_anchor:=$a$  v_meal := greatest(0,round(coalesce(nullif(p_profile->>'meal_amount','')::numeric,v_before.pay_meal_amount,0)::numeric,2));$a$;
      if strpos(v_after,v_anchor)=0 then raise exception 'MEAL_POLICY_SAVE_PROFILE_ANCHOR_CHANGED'; end if;
      v_after:=replace(v_after,v_anchor,v_anchor||$b$
  if public.meal_policy_schedule_v1((clock_timestamp() at time zone 'Europe/Belgrade')::date) is not null then
    if (v_meal_enabled is distinct from v_before.pay_meal_enabled or v_meal is distinct from coalesce(v_before.pay_meal_amount,0))
       and (v_meal_enabled is distinct from (public.meal_policy_allowance_v1(v_before.id,(now() at time zone 'Europe/Belgrade')::date) is not null)
            or v_meal is distinct from public.meal_policy_amount_v1(v_before.id,(now() at time zone 'Europe/Belgrade')::date,0)) then
      raise exception 'MEAL_POLICY_PROFILE_MANAGED_BY_SCHEDULE';
    end if;
    v_meal_enabled:=v_before.pay_meal_enabled;
    v_meal:=coalesce(v_before.pay_meal_amount,0);
  end if;
$b$);
    elsif v_signature='public.get_worker_finance_snapshot_v1(text,text,date)' then
      v_anchor:=$a$case when v_worker.pay_meal_enabled then round(coalesce(v_worker.pay_meal_amount,0)::numeric,2) else 0 end$a$;
      if strpos(v_after,v_anchor)=0 then raise exception 'MEAL_POLICY_SNAPSHOT_ANCHOR_CHANGED'; end if;
      v_after:=replace(v_after,v_anchor,$b$public.meal_policy_amount_v1(v_worker.id,v_date,case when v_worker.pay_meal_enabled then round(coalesce(v_worker.pay_meal_amount,0)::numeric,2) else 0 end)$b$);
      v_anchor:=$a$case when v_worker.pay_meal_enabled then coalesce(v_worker.pay_meal_amount,0) else 0 end$a$;
      v_after:=replace(v_after,v_anchor,$b$public.meal_policy_amount_v1(v_worker.id,v_date,case when v_worker.pay_meal_enabled then coalesce(v_worker.pay_meal_amount,0) else 0 end)$b$);
      v_anchor:=$a$'profile',public.get_worker_compensation_profile_v1(p_actor_pin,p_worker_pin),$a$;
      if strpos(v_after,v_anchor)=0 then raise exception 'MEAL_POLICY_SNAPSHOT_PROFILE_ANCHOR_CHANGED'; end if;
      v_after:=replace(v_after,v_anchor,$b$'profile',public.get_worker_compensation_profile_v1(p_actor_pin,p_worker_pin)||jsonb_build_object('meal_amount',public.meal_policy_amount_v1(v_worker.id,v_date,case when v_worker.pay_meal_enabled then coalesce(v_worker.pay_meal_amount,0) else 0 end),'meal_enabled',case when public.meal_policy_schedule_v1(v_date) is null then v_worker.pay_meal_enabled else public.meal_policy_allowance_v1(v_worker.id,v_date) is not null end,'meal_policy',public.meal_policy_allowance_v1(v_worker.id,v_date)),$b$);
    else
      v_anchor:=$a$coalesce(u.salary, 0)::numeric AS salary_base,$a$;
      if strpos(v_after,v_anchor)=0 then raise exception 'MEAL_POLICY_MONTH_CLOSE_ANCHOR_CHANGED'; end if;
      v_after:=replace(v_after,v_anchor,$b$(case when public.meal_policy_schedule_v1((v_month_key||'-01')::date) is not null and u.pay_salary_enabled is false then 0 else coalesce(u.salary, 0) end)::numeric AS salary_base,
      public.meal_policy_amount_v1(u.id,(v_month_key||'-01')::date,0) AS meal_allowance,
      (case when public.meal_policy_schedule_v1((v_month_key||'-01')::date) is not null and u.pay_transport_bonus_enabled then coalesce(u.pay_transport_bonus_amount,0) else 0 end)::numeric AS fixed_transport_allowance,$b$);
      v_anchor:=$a$ew.salary_base,$a$;
      if strpos(v_after,v_anchor)=0 then raise exception 'MEAL_POLICY_MONTH_ROW_ANCHOR_CHANGED'; end if;
      v_after:=replace(v_after,v_anchor,$b$ew.salary_base,ew.meal_allowance,ew.fixed_transport_allowance,$b$);
      v_anchor:=$a$wc.salary_base - greatest(0, wc.auto_advance + wc.manual_advance)$a$;
      if strpos(v_after,v_anchor)=0 then raise exception 'MEAL_POLICY_MONTH_NET_ANCHOR_CHANGED'; end if;
      v_after:=replace(v_after,v_anchor,$b$wc.salary_base + wc.meal_allowance + wc.fixed_transport_allowance - greatest(0, wc.auto_advance + wc.manual_advance)$b$);
      v_after:=replace(v_after,$a$'salary_base', fr.salary_base,$a$,$b$'salary_base', fr.salary_base,'meal_allowance',fr.meal_allowance,'fixed_transport_allowance',fr.fixed_transport_allowance,$b$);
    end if;
    v_after:=replace(v_after,'AS $function$',E'AS $function$\n-- MEAL_POLICY_DATED_V1');
    if strpos(v_after,'MEAL_POLICY_DATED_V1')=0 then raise exception 'MEAL_POLICY_FUNCTION_DELIMITER_CHANGED'; end if;
    execute v_after;
  end loop;
end;
$migration$;
