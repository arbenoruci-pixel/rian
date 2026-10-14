-- Physical confirmation is explicit and attributed; installing this migration
-- never moves or verifies any customer order.
alter table public.inventory_audit_events drop constraint inventory_audit_events_action_check;
alter table public.inventory_audit_events add constraint inventory_audit_events_action_check
  check (action in ('MOVE_READY','VERIFY','FOUND_READY'));

create or replace function public.inventory_audit_write_v1(
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
    or p_action not in ('MOVE_READY','VERIFY','FOUND_READY') or p_action is null
    or p_result not in ('unverified','seen_in_depot','not_found') or p_result is null
    or p_operation_id is null or length(coalesce(p_note,''))>500 then raise exception 'AUDIT_REQUEST_INVALID'; end if;
  if p_action='MOVE_READY' and p_result <> 'unverified' then raise exception 'AUDIT_RESULT_INVALID'; end if;
  if p_action='FOUND_READY' and p_result <> 'seen_in_depot' then raise exception 'AUDIT_RESULT_INVALID'; end if;
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
  if p_action in ('MOVE_READY','FOUND_READY') then
    if old_status not in ('pastrim','pastrimi','at_base','in_base','base') then raise exception 'AUDIT_STATUS_CHANGED'; end if;
    -- Bulk correction waits >96 hours. FOUND_READY is an individual physical
    -- attestation by the authenticated Admin/Dispatch actor and records found.
    if p_action='MOVE_READY' then
      started := public.inventory_audit_started_at_v1(current_row);
      if started is null then raise exception 'AUDIT_DATE_UNKNOWN'; end if;
      if started >= at_time - interval '96 hours' then raise exception 'AUDIT_NOT_OVER_FOUR_DAYS'; end if;
    end if;
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
    if p_action in ('MOVE_READY','FOUND_READY') then
      update public.orders set status='gati',ready_at=at_time,data=d,updated_at=at_time where id=p_order_id::bigint returning to_jsonb(orders.*) into next_row;
    else
      update public.orders set data=d,updated_at=at_time where id=p_order_id::bigint returning to_jsonb(orders.*) into next_row;
    end if;
  else
    if p_action in ('MOVE_READY','FOUND_READY') then
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
