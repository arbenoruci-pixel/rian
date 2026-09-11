-- Stage GATI for operational roles. Bonus qualification remains owned by payment.
create or replace function public.mark_base_order_ready_with_bonus_v1(
  p_order_ref text, p_worker_pin text, p_ready_slots text[] default array[]::text[],
  p_ready_note text default null, p_ready_at timestamptz default null, p_idempotency_key text default null
) returns jsonb language plpgsql security definer set search_path to 'public','pg_temp'
as $function$
declare
  v_order public.orders%rowtype;
  v_worker public.users%rowtype;
  v_ready_at timestamptz := coalesce(p_ready_at,now());
  v_slots text[] := coalesce(p_ready_slots,array[]::text[]);
  v_location text;
  v_note text;
  v_data jsonb;
begin
  if nullif(btrim(coalesce(p_order_ref,'')),'') is null then raise exception 'BASE_READY_ORDER_REF_REQUIRED'; end if;
  if nullif(btrim(coalesce(p_worker_pin,'')),'') is null then raise exception 'BASE_READY_WORKER_PIN_REQUIRED'; end if;
  select * into v_worker from public.users where pin=btrim(p_worker_pin) and is_active is true limit 1;
  if not found then raise exception 'BASE_READY_WORKER_NOT_FOUND'; end if;
  -- BASE_READY_DISPATCH_TRANSITION_V1: staging permission is independent of earning a bonus.
  if upper(coalesce(v_worker.role,'')) not in ('PUNTOR','PUNETOR','WORKER','BAZIST','BASE','DISPATCH','ADMIN','ADMIN_MASTER','OWNER','PRONAR','SUPERADMIN') then
    raise exception 'BASE_READY_WORKER_ROLE_NOT_ALLOWED:%',coalesce(v_worker.role,'EMPTY');
  end if;
  if btrim(p_order_ref) ~ '^[0-9]+$' then
    select * into v_order from public.orders where id=btrim(p_order_ref)::bigint for update;
  else
    select * into v_order from public.orders where local_oid=btrim(p_order_ref) for update;
  end if;
  if not found then raise exception 'BASE_READY_ORDER_NOT_FOUND'; end if;
  if lower(coalesce(v_order.status,'')) not in ('pastrim','gati') then raise exception 'BASE_READY_STATUS_NOT_PASTRIM:%',coalesce(v_order.status,'EMPTY'); end if;
  -- A lost response or another device retry keeps the original time, worker and rack.
  if lower(v_order.status)='gati' then
    return jsonb_build_object('ok',true,'alreadyApplied',true,'qualificationSource','DELIVERY_PAYMENT','reason','WAITING_DELIVERY_PAYMENT_72H','order',to_jsonb(v_order),'bonus',null,'summary',null);
  end if;
  if coalesce(array_length(v_slots,1),0)<=0 then raise exception 'BASE_READY_RACK_REQUIRED'; end if;
  if lower(coalesce(v_order.data->'paketimi_v1'->>'status',''))<>'final_ready' then raise exception 'BASE_READY_PAKETIMI_NOT_FINAL'; end if;
  if v_ready_at>now()+interval '5 minutes' or v_ready_at<now()-interval '7 days' or v_ready_at<v_order.created_at-interval '5 minutes' then v_ready_at:=now(); end if;
  v_location:=array_to_string(v_slots,', ');
  v_note:=nullif(btrim(coalesce(p_ready_note,'')),'');
  v_data:=coalesce(v_order.data,'{}'::jsonb)||jsonb_build_object(
    'status','gati','state','gati','ready_at',v_ready_at,
    'ready_note',case when v_note is null then concat('📍 [',v_location,']') else concat('📍 [',v_location,'] ',v_note) end,
    'ready_note_text',coalesce(v_note,''),'ready_location',v_location,'ready_slots',to_jsonb(v_slots),
    'ready_by_pin',v_worker.pin,'ready_by_name',v_worker.name,'ready_by_role',v_worker.role,
    'bonus_state','WAITING_DELIVERY_PAYMENT_72H'
  );
  update public.orders set status='gati',ready_at=v_ready_at,data=v_data,updated_at=now() where id=v_order.id returning * into v_order;
  return jsonb_build_object('ok',true,'alreadyApplied',false,'qualificationSource','DELIVERY_PAYMENT','reason','WAITING_DELIVERY_PAYMENT_72H','order',to_jsonb(v_order),'bonus',null,'summary',null);
end;
$function$;
