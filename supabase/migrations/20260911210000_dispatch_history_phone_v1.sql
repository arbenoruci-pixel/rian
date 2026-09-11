-- Resolve an unambiguous archived customer's permanent code inside CREATE's
-- transaction. Advisory phone inspection stays read-only.
create or replace function public.ensure_transport_history_client_v1(p_phone text)
returns uuid language plpgsql set search_path to 'public','pg_temp'
as $function$
declare
  v_phone text := public.normalize_transport_phone_key(p_phone);
  v_lookup jsonb;
  v_candidate jsonb;
  v_code text;
  v_id uuid;
  v_old_id uuid;
  v_pool_status text;
begin
  if length(coalesce(v_phone,'')) < 8 then raise exception 'TRANSPORT_PHONE_INVALID'; end if;
  perform pg_advisory_xact_lock(hashtextextended('transport-phone:'||v_phone,0));
  v_lookup := public.find_transport_client_by_phone_fast(p_phone);
  if v_lookup->>'status' = 'CONFLICT' then raise exception 'TRANSPORT_PHONE_IDENTITY_CONFLICT'; end if;
  if v_lookup->>'status' = 'NOT_FOUND' then return null; end if;
  if v_lookup->>'status' is distinct from 'FOUND' then raise exception 'TRANSPORT_HISTORY_LOOKUP_INVALID'; end if;
  v_candidate := v_lookup->'candidate';
  if v_lookup->>'source_mode' = 'MASTER' then return (v_candidate->>'id')::uuid; end if;
  v_code := upper(btrim(coalesce(v_candidate->>'tcode','')));
  if v_candidate->>'source' is distinct from 'transport_orders'
    or nullif(v_candidate->>'row_id','') is null
    or public.normalize_transport_phone_key(coalesce(v_candidate->>'phone_digits',v_candidate->>'phone','')) is distinct from v_phone
    or v_code !~ '^T[1-9][0-9]*$'
  then raise exception 'TRANSPORT_HISTORY_IDENTITY_INVALID'; end if;

  -- Share the code allocator's locks before adopting the historical code.
  perform pg_advisory_xact_lock(hashtextextended('transport-code-allocator-v3',0));
  perform pg_advisory_xact_lock(hashtextextended('offline-bank:transport-code:'||v_code,0));
  perform pg_advisory_xact_lock(hashtextextended('transport-code-release:'||v_code,0));
  v_old_id := nullif(v_candidate->>'id','')::uuid;
  if exists(select 1 from public.transport_clients c where upper(btrim(c.tcode))=v_code or c.id=v_old_id) then
    raise exception 'TRANSPORT_HISTORY_CODE_OWNER_CONFLICT';
  end if;
  -- A shared code with another phone needs review, never an automatic merge.
  if exists(
    select 1 from public.transport_orders o
    where (upper(btrim(o.client_tcode))=v_code or upper(btrim(o.code_str))=v_code)
      and public.normalize_transport_phone_key(coalesce(nullif(o.client_phone,''),o.data->>'client_phone',o.data->'client'->>'phone','')) is distinct from v_phone
  ) then raise exception 'TRANSPORT_HISTORY_CODE_PHONE_CONFLICT'; end if;
  select status into v_pool_status from public.transport_code_pool where code=v_code for update;
  if v_pool_status is distinct from 'used' then raise exception 'TRANSPORT_HISTORY_CODE_NOT_CLAIMED'; end if;
  if exists(select 1 from public.offline_code_leases l where l.scope='transport' and upper(btrim(l.code))=v_code
    and l.status in ('available','assigned') and l.expires_at>now()) then
    raise exception 'TRANSPORT_HISTORY_CODE_LEASE_CONFLICT';
  end if;

  insert into public.transport_clients(id,tcode,name,phone,phone_digits,address,gps_lat,gps_lng,name_lc,search_code,updated_at)
  values(coalesce(v_old_id,gen_random_uuid()),v_code,
    coalesce(nullif(btrim(v_candidate->>'name'),''),'PA EMER'),p_phone,v_phone,
    v_candidate->>'address',v_candidate->>'gps_lat',v_candidate->>'gps_lng',lower(coalesce(v_candidate->>'name','')),
    left(regexp_replace(v_code,'[^0-9]','','g')||v_phone,15)::bigint,now())
  returning id into v_id;
  return v_id;
end;
$function$;
revoke all on function public.ensure_transport_history_client_v1(text) from public,anon,authenticated;
grant execute on function public.ensure_transport_history_client_v1(text) to service_role;

-- Preserve the reviewed live CREATE implementation and its authorization,
-- reservation, fingerprint, UUID and duplicate-order guards in full.
do $migration$
declare
  v_oid regprocedure;
  v_definition text;
  v_anchor text := E'  select\n    c.id,c.tcode,c.address,c.gps_lat,c.gps_lng,';
begin
  select p.oid::regprocedure into strict v_oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname='create_transport_order';
  v_definition := pg_get_functiondef(v_oid);
  if position('DISPATCH_HISTORY_PHONE_V1' in v_definition)>0 then return; end if;
  if md5(v_definition)<>'5d687b4a862a87bde1a3bfe5d5383860' or position(v_anchor in v_definition)=0 then
    raise exception 'TRANSPORT_CREATE_CHANGED_SINCE_HISTORY_REVIEW';
  end if;
  execute replace(v_definition,v_anchor,
    E'  -- DISPATCH_HISTORY_PHONE_V1: resolve history before considering a new code.\n  if v_caller_role=''service_role'' then\n    perform public.ensure_transport_history_client_v1(p_client_phone);\n  end if;\n\n'||v_anchor);
end;
$migration$;
