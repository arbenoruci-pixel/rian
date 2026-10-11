-- Retain audit metadata through legacy SECURITY DEFINER/offline write paths.
create or replace function public.preserve_inventory_audit_v1() returns trigger language plpgsql security invoker set search_path = '' as $$
declare k text; d jsonb := coalesce(new.data,'{}'::jsonb);
begin
  if current_user = 'service_role' then return new; end if;
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

-- Prefer the most recent processing cycle; admission remains the fallback.
create or replace function public.inventory_audit_started_at_v1(p_row jsonb)
returns timestamptz language plpgsql immutable security invoker set search_path = '' as $$
declare
  d jsonb := coalesce(p_row->'data'->'data','{}'::jsonb) || coalesce(p_row->'data','{}'::jsonb);
  h jsonb; v text; n numeric; parsed timestamptz; latest timestamptz; candidate integer := 0;
begin
  select e.value into h from jsonb_array_elements(
    case when jsonb_typeof(d->'status_history')='array' then d->'status_history'
      when jsonb_typeof(d->'statusHistory')='array' then d->'statusHistory' else '[]'::jsonb end
  ) with ordinality e(value,position)
  where lower(coalesce(e.value->>'status',e.value->>'to',e.value->>'next_status',e.value->>'nextStatus',''))
    in ('pastrim','pastrimi','at_base','in_base','base') order by e.position desc limit 1;
  foreach v in array array[d->>'pastrim_delay_started_at',d->>'pastrim_started_at',d->>'pastrimStartedAt',d->>'pastrim_at',
    d->>'base_processing_at',d->>'baseProcessingAt',h->>'at',h->>'created_at',h->>'ts',p_row->>'created_at',d->>'created_at',d->>'ts'] loop
    candidate := candidate + 1;
    if candidate=10 and latest is not null then return latest; end if;
    if nullif(btrim(v),'') is null then continue; end if;
    begin
      if v ~ '^\d+(\.\d+)?$' then
        n := v::numeric;
        if n > 1000000000000 then parsed := to_timestamp((n/1000)::double precision);
        elsif n > 1000000000 then parsed := to_timestamp(n::double precision);
        else continue; end if;
      else parsed := v::timestamptz; end if;
      if parsed > '1970-01-01'::timestamptz and isfinite(parsed) then
        if candidate > 9 then return parsed; end if;
        latest := greatest(latest,parsed);
      end if;
    exception when invalid_datetime_format or datetime_field_overflow or numeric_value_out_of_range then null;
    end;
  end loop;
  return latest;
end $$;
