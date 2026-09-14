CREATE OR REPLACE FUNCTION public.upsert_client_from_order()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_requested_code text;
  v_name text;
  v_phone text;
  v_phone_key text;
  v_photo text;
  v_client public.clients%rowtype;
  v_code_client public.clients%rowtype;
  v_client_name text;
  v_is_draft boolean := false;
  v_original_code bigint := new.code;
begin
  v_is_draft :=
       lower(coalesce(new.data->>'is_pranimi_incomplete_draft','false')) in ('true','1','yes')
    or lower(coalesce(new.data->>'pranimi_db_draft','false')) in ('true','1','yes')
    or lower(coalesce(new.data->'pranimi_code_lifecycle'->>'db_draft','false')) in ('true','1','yes')
    or lower(coalesce(new.data->'draft_lifecycle'->>'db_draft','false')) in ('true','1','yes')
    or lower(trim(coalesce(new.status,''))) in ('draft','incomplete','paplotesuar','pa_plotesuar','pa_plotsuar','e_paplotesuar','e_pa_plotesuar','e_pa_plotsuar','local_draft','pending_draft')
    or lower(trim(coalesce(new.data->>'status',''))) in ('draft','incomplete','paplotesuar','pa_plotesuar','pa_plotsuar','e_paplotesuar','e_pa_plotesuar','e_pa_plotsuar','local_draft','pending_draft');
  if v_is_draft then return new; end if;

  v_requested_code := nullif(trim(coalesce(new.client_code::text,new.data->>'client_code',new.data#>>'{client,code}',new.code::text,new.data->>'code')),'');
  if v_requested_code is null then return new; end if;

  v_name := nullif(trim(coalesce(new.client_name,new.data->>'client_name',new.data#>>'{client,name}',new.data->>'name','PA EMER')),'');
  v_phone := nullif(trim(coalesce(new.client_phone,new.data->>'client_phone',new.data#>>'{client,phone}',new.data->>'phone')),'');
  v_phone_key := public.normalize_kosovo_phone_v1(v_phone);
  v_photo := nullif(trim(coalesce(new.data#>>'{client,photoUrl}',new.data->>'photo_url','')),'');

  if v_phone_key is not null then
    select * into v_client
    from public.clients c
    where public.normalize_kosovo_phone_v1(c.phone)=v_phone_key
    order by c.created_at,c.id limit 1 for update;
  end if;

  if found then
    v_client_name := coalesce(nullif(trim(v_client.full_name),''),nullif(trim(v_client.name),''),nullif(trim(v_client.first_name||' '||v_client.last_name),''),v_name,'PA EMER');
    if public.client_name_is_placeholder_v1(v_client_name) and not public.client_name_is_placeholder_v1(v_name) then
      update public.clients c
      set first_name=coalesce(nullif(trim(v_name),''),c.first_name),full_name=v_name,name=v_name,
          photo_url=coalesce(v_photo,c.photo_url),updated_at=now()
      where c.id=v_client.id
      returning * into v_client;
      v_client_name := coalesce(nullif(trim(v_client.full_name),''),nullif(trim(v_client.name),''),nullif(trim(v_client.first_name||' '||v_client.last_name),''),v_name,'PA EMER');
    end if;

    new.client_id := v_client.id;
    if v_client.code ~ '^[0-9]+$' then
      new.client_code := v_client.code::integer;
      new.code := v_client.code::bigint;
    end if;
    new.client_name := v_client_name;
    new.client_phone := v_client.phone;
  else
    select * into v_code_client from public.clients c where c.code=v_requested_code limit 1 for update;
    if found then
      if v_phone_key is not null and public.normalize_kosovo_phone_v1(v_code_client.phone) is distinct from v_phone_key then
        raise exception 'CLIENT_CODE_COLLISION_DIFFERENT_PHONE code=% existing_phone=% incoming_phone=%',v_requested_code,v_code_client.phone,v_phone;
      end if;
      v_client := v_code_client;
    else
      insert into public.clients(code,first_name,last_name,full_name,name,phone,photo_url,created_at,updated_at)
      values(v_requested_code,coalesce(v_name,'PA EMER'),'',coalesce(v_name,'PA EMER'),coalesce(v_name,'PA EMER'),
             coalesce(v_phone,'PA NUMER '||v_requested_code),coalesce(v_photo,''),now(),now())
      returning * into v_client;
    end if;
    v_client_name := coalesce(nullif(trim(v_client.full_name),''),nullif(trim(v_client.name),''),nullif(trim(v_client.first_name||' '||v_client.last_name),''),v_name,'PA EMER');
    new.client_id := v_client.id;
    if v_client.code ~ '^[0-9]+$' then new.client_code:=v_client.code::integer; new.code:=v_client.code::bigint; end if;
    new.client_name:=v_client_name;
    new.client_phone:=v_client.phone;
  end if;

  new.data := coalesce(new.data,'{}'::jsonb)
    || jsonb_build_object('code',new.code,'client_code',new.client_code,'client_id',new.client_id::text,'client_master_id',new.client_id::text,'client_name',new.client_name,'client_phone',new.client_phone,'name',new.client_name,'phone',new.client_phone)
    || jsonb_build_object('client',coalesce(new.data->'client','{}'::jsonb)||jsonb_build_object('id',new.client_id::text,'code',new.client_code,'name',new.client_name,'phone',new.client_phone))
    || jsonb_build_object('identity_resolution',coalesce(new.data->'identity_resolution','{}'::jsonb)||jsonb_build_object('version','PHONE_AUTHORITY_V1','resolved_at',now(),'original_order_code',v_original_code,'final_client_code',new.client_code));
  if jsonb_typeof(new.data->'order')='object' then
    new.data := jsonb_set(new.data,'{order}',coalesce(new.data->'order','{}'::jsonb)||jsonb_build_object('code',new.code,'client_code',new.client_code,'client_id',new.client_id::text,'client_name',new.client_name,'client_phone',new.client_phone,'name',new.client_name,'phone',new.client_phone,'client',coalesce(new.data->'order'->'client','{}'::jsonb)||jsonb_build_object('id',new.client_id::text,'code',new.client_code,'name',new.client_name,'phone',new.client_phone)),true);
  end if;
  return new;
end;
$function$
