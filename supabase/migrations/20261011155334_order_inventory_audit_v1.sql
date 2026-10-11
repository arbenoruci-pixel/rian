-- Privileged, attributed inventory actions. No existing order is changed here.
create table public.inventory_audit_events (
  operation_id uuid primary key,
  order_table text not null check (order_table in ('orders','transport_orders')),
  order_id text not null,
  actor_id uuid not null,
  actor_name text not null,
  action text not null check (action in ('MOVE_READY','VERIFY')),
  result text not null check (result in ('unverified','seen_in_depot','not_found')),
  note text not null default '',
  previous_status text not null,
  next_status text not null,
  created_at timestamptz not null default clock_timestamp()
);
create index inventory_audit_events_order_history on public.inventory_audit_events(order_table,order_id,created_at desc);
alter table public.inventory_audit_events enable row level security;
revoke all on public.inventory_audit_events from public,anon,authenticated;
grant select,insert on public.inventory_audit_events to service_role;

create function public.inventory_audit_started_at_v1(p_row jsonb)
returns timestamptz language plpgsql immutable security invoker set search_path = '' as $$
declare
  d jsonb := coalesce(p_row->'data'->'data','{}'::jsonb) || coalesce(p_row->'data','{}'::jsonb);
  h jsonb; v text; n numeric; parsed timestamptz;
begin
  select e.value into h from jsonb_array_elements(
    case when jsonb_typeof(d->'status_history')='array' then d->'status_history'
      when jsonb_typeof(d->'statusHistory')='array' then d->'statusHistory' else '[]'::jsonb end
  ) with ordinality e(value,position)
  where lower(coalesce(e.value->>'status',e.value->>'to',e.value->>'next_status',e.value->>'nextStatus',''))
    in ('pastrim','pastrimi','at_base','in_base','base') order by e.position desc limit 1;
  foreach v in array array[d->>'pastrim_delay_started_at',d->>'pastrim_started_at',d->>'pastrimStartedAt',d->>'pastrim_at',
    d->>'base_processing_at',d->>'baseProcessingAt',h->>'at',h->>'created_at',h->>'ts',p_row->>'created_at',d->>'created_at',d->>'ts'] loop
    if nullif(btrim(v),'') is null then continue; end if;
    begin
      if v ~ '^\d+(\.\d+)?$' then
        n := v::numeric;
        if n > 1000000000000 then parsed := to_timestamp((n/1000)::double precision);
        elsif n > 1000000000 then parsed := to_timestamp(n::double precision);
        else continue; end if;
      else parsed := v::timestamptz; end if;
      if parsed > '1970-01-01'::timestamptz and isfinite(parsed) then return parsed; end if;
    exception when invalid_datetime_format or datetime_field_overflow or numeric_value_out_of_range then null;
    end;
  end loop;
  return null;
end $$;
revoke all on function public.inventory_audit_started_at_v1(jsonb) from public,anon,authenticated;
grant execute on function public.inventory_audit_started_at_v1(jsonb) to service_role;

create function public.inventory_audit_write_v1(
  p_table text,p_order_id text,p_actor_id uuid,p_action text,p_result text,
  p_expected_updated_at timestamptz,p_operation_id uuid,p_note text default ''
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  actor record; prior public.inventory_audit_events%rowtype;
  current_row jsonb; next_row jsonb; d jsonb; a jsonb; legacy jsonb;
  prior_audit_setting text := current_setting('tepiha.inventory_audit_operation',true);
  old_status text; next_status text; started timestamptz; at_time timestamptz := clock_timestamp();
begin
  if current_user <> 'service_role' then raise exception 'AUDIT_SERVICE_REQUIRED'; end if;
  select id,name,role into actor from public.users where id=p_actor_id and is_active is true;
  if not found or upper(btrim(actor.role)) not in ('SUPERADMIN','OWNER','PRONAR','ADMIN_MASTER','ADMIN','DISPATCH','MASTER') then
    raise exception 'AUDIT_FORBIDDEN';
  end if;
  if p_table not in ('orders','transport_orders') or p_table is null
    or p_action not in ('MOVE_READY','VERIFY') or p_action is null
    or p_result not in ('unverified','seen_in_depot','not_found') or p_result is null
    or p_operation_id is null or length(coalesce(p_note,''))>500 then raise exception 'AUDIT_REQUEST_INVALID'; end if;
  if p_action='MOVE_READY' and p_result <> 'unverified' then raise exception 'AUDIT_RESULT_INVALID'; end if;
  -- The operation lock and row lock make retries and concurrent devices deterministic.
  perform pg_advisory_xact_lock(hashtextextended('inventory-audit:' || p_operation_id::text,0));
  if p_table='orders' then
    if p_order_id !~ '^[1-9][0-9]{0,15}$' then raise exception 'AUDIT_ID_INVALID'; end if;
    select to_jsonb(o) into current_row from public.orders o where o.id=p_order_id::bigint for update;
  else
    select to_jsonb(o) into current_row from public.transport_orders o where o.id=p_order_id::uuid for update;
  end if;
  if current_row is null then raise exception 'AUDIT_ORDER_NOT_FOUND'; end if;
  select * into prior from public.inventory_audit_events where operation_id=p_operation_id;
  if found then
    if prior.order_table<>p_table or prior.order_id<>p_order_id or prior.actor_id<>p_actor_id
      or prior.action<>p_action or prior.result<>p_result or prior.note<>coalesce(p_note,'') then raise exception 'AUDIT_OPERATION_CONFLICT'; end if;
    return jsonb_build_object('row',current_row,'replayed',true);
  end if;
  if (current_row->>'updated_at')::timestamptz is distinct from p_expected_updated_at then raise exception 'AUDIT_STALE'; end if;
  old_status := lower(btrim(coalesce(current_row->>'status','')));
  next_status := old_status;
  d := case when jsonb_typeof(current_row->'data')='object' then current_row->'data' else '{}'::jsonb end;
  if p_action='MOVE_READY' then
    if old_status not in ('pastrim','pastrimi','at_base','in_base','base') then raise exception 'AUDIT_STATUS_CHANGED'; end if;
    started := public.inventory_audit_started_at_v1(current_row);
    if started is null then raise exception 'AUDIT_DATE_UNKNOWN'; end if;
    if started >= at_time - interval '96 hours' then raise exception 'AUDIT_NOT_OVER_FOUR_DAYS'; end if;
    next_status := 'gati';
    d := d || jsonb_build_object('status','gati','state','gati','ready_at',at_time);
    if jsonb_typeof(d->'data')='object' then
      d := jsonb_set(d,'{data}',(d->'data') || jsonb_build_object('status','gati','state','gati','ready_at',at_time));
    end if;
  elsif old_status not in ('gati','ready') then raise exception 'AUDIT_STATUS_CHANGED'; end if;

  a := jsonb_build_object('version',1,'operation_id',p_operation_id,'action',p_action,'result',p_result,
    'at',at_time,'by_id',p_actor_id,'by_name',coalesce(actor.name,actor.role),'note',coalesce(p_note,''),'previous_status',old_status);
  legacy := coalesce(d->'audit','{}'::jsonb) || jsonb_build_object('status',p_result,'audited_at',at_time,'audited_by_name',coalesce(actor.name,actor.role),
    'note',coalesce(p_note,''),'last_event',jsonb_build_object('id',p_operation_id,'status',p_result,'at',at_time,
    'by_name',coalesce(actor.name,actor.role),'note',coalesce(p_note,'')));
  d := d || jsonb_build_object('inventory_audit',a,'audit',legacy);
  if jsonb_typeof(d->'data')='object' then d := jsonb_set(d,'{data}',(d->'data') || jsonb_build_object('inventory_audit',a,'audit',legacy)); end if;
  perform set_config('tepiha.inventory_audit_operation',p_operation_id::text,true);
  if p_table='orders' then
    if p_action='MOVE_READY' then
      update public.orders set status='gati',ready_at=at_time,data=d,updated_at=at_time where id=p_order_id::bigint returning to_jsonb(orders.*) into next_row;
    else
      update public.orders set data=d,updated_at=at_time where id=p_order_id::bigint returning to_jsonb(orders.*) into next_row;
    end if;
  else
    if p_action='MOVE_READY' then
      update public.transport_orders set status='gati',ready_at=at_time,data=d,updated_at=at_time where id=p_order_id::uuid returning to_jsonb(transport_orders.*) into next_row;
    else
      update public.transport_orders set data=d,updated_at=at_time where id=p_order_id::uuid returning to_jsonb(transport_orders.*) into next_row;
    end if;
  end if;
  perform set_config('tepiha.inventory_audit_operation',coalesce(prior_audit_setting,''),true);
  -- An existing status trigger may reject/redirect a transition. Roll back that
  -- entire item instead of acknowledging a different outcome to the auditor.
  if next_row->>'status' is distinct from next_status then raise exception 'AUDIT_STATUS_CONFLICT'; end if;
  insert into public.inventory_audit_events(operation_id,order_table,order_id,actor_id,actor_name,action,result,note,previous_status,next_status)
    values(p_operation_id,p_table,p_order_id,p_actor_id,coalesce(actor.name,actor.role),p_action,p_result,coalesce(p_note,''),old_status,next_status);
  return jsonb_build_object('row',next_row,'replayed',false);
end $$;
revoke all on function public.inventory_audit_write_v1(text,text,uuid,text,text,timestamptz,uuid,text) from public,anon,authenticated;
grant execute on function public.inventory_audit_write_v1(text,text,uuid,text,text,timestamptz,uuid,text) to service_role;

-- Older/offline clients can keep saving ordinary fields, but cannot forge or
-- erase a server-confirmed audit with a stale full-data overwrite.
create function public.preserve_inventory_audit_v1() returns trigger language plpgsql security invoker set search_path = '' as $$
declare k text; d jsonb := coalesce(new.data,'{}'::jsonb);
begin
  if current_user in ('service_role','postgres','supabase_admin') then return new; end if;
  if tg_op='INSERT' then
    new.data := d - 'inventory_audit';
    if jsonb_typeof(new.data->'data')='object' then new.data := jsonb_set(new.data,'{data}',(new.data->'data')-'inventory_audit'); end if;
    return new;
  end if;
  foreach k in array array['inventory_audit','audit'] loop
    if k='audit' and not (coalesce(old.data,'{}'::jsonb) ? 'inventory_audit') then continue; end if;
    if coalesce(old.data,'{}'::jsonb) ? k then d := jsonb_set(d,array[k],old.data->k,true); else d := d-k; end if;
    if jsonb_typeof(d->'data')='object' then
      if coalesce(old.data,'{}'::jsonb) ? k then d := jsonb_set(d,array['data',k],old.data->k,true);
      else d := jsonb_set(d,'{data}',(d->'data')-k); end if;
    end if;
  end loop;
  new.data := d;
  return new;
end $$;
revoke all on function public.preserve_inventory_audit_v1() from public,anon,authenticated;
create trigger trg_zzzz_inventory_audit_preserve_v1 before insert or update of data on public.orders for each row execute function public.preserve_inventory_audit_v1();
create trigger trg_zzzz_inventory_audit_preserve_v1 before insert or update of data on public.transport_orders for each row execute function public.preserve_inventory_audit_v1();

-- Existing payment reconciliation runs on ANY data edit. Do not let a physical
-- inventory check create/activate a historical payment bonus. The skip is scoped
-- to this service-role RPC operation and its new, protected audit marker; all
-- ordinary payment, ready and offline writes retain their existing triggers.
do $$
declare trigger_name text; definition text;
begin
  foreach trigger_name in array array['trg_base_ready_bonus_on_full_payment_v2','trg_base_ready_bonus_order_payment_v3'] loop
    select pg_get_triggerdef(t.oid) into definition from pg_trigger t
      where t.tgrelid='public.orders'::regclass and t.tgname=trigger_name;
    if definition is not null then
      if position(' FOR EACH ROW EXECUTE FUNCTION ' in definition)=0 then
        raise exception 'AUDIT_UNEXPECTED_BONUS_TRIGGER: %',trigger_name;
      end if;
      execute format('drop trigger %I on public.orders',trigger_name);
      execute replace(definition,' FOR EACH ROW EXECUTE FUNCTION ',
        ' FOR EACH ROW WHEN (NOT coalesce(current_user = ''service_role'' AND NEW.data #>> ''{inventory_audit,operation_id}'' = current_setting(''tepiha.inventory_audit_operation'',true) AND OLD.data #>> ''{inventory_audit,operation_id}'' IS DISTINCT FROM NEW.data #>> ''{inventory_audit,operation_id}'',false)) EXECUTE FUNCTION ');
    end if;
  end loop;
end $$;
