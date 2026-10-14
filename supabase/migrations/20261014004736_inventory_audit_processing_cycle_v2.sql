-- Forward-only repair: no existing customer rows, statuses or audit events change.
-- Keep this timestamp selection contract in sync with lib/inventoryAudit.js.
create or replace function public.inventory_audit_time_v2(v text)
returns timestamptz language plpgsql immutable security invoker
set search_path = '' set timezone = 'UTC' as $$
declare n numeric; parsed timestamptz;
begin
  v := btrim(v);
  if nullif(v,'') is null then return null; end if;
  if v ~ '^[0-9]+([.][0-9]+)?$' then
    n := v::numeric;
    if n > 1000000000000 then n := n / 1000;
    elsif n <= 1000000000 then return null; end if;
    if n > 8640000000000 then return null; end if;
    parsed := to_timestamp(n::double precision);
  else parsed := v::timestamptz; end if;
  if parsed > '1970-01-01'::timestamptz and isfinite(parsed) then return parsed; end if;
  return null;
exception when invalid_datetime_format or datetime_field_overflow or numeric_value_out_of_range then return null;
end $$;
revoke all on function public.inventory_audit_time_v2(text) from public,anon,authenticated;
grant execute on function public.inventory_audit_time_v2(text) to service_role;

create or replace function public.inventory_audit_started_at_v1(p_row jsonb)
returns timestamptz language plpgsql immutable security invoker set search_path = '' as $$
declare
  d jsonb := case when jsonb_typeof(p_row->'data')='object' then p_row->'data' else '{}'::jsonb end;
  nested jsonb := case when jsonb_typeof(d->'data')='object' then d->'data' else '{}'::jsonb end;
  source jsonb; h jsonb; key text; status text; event_time timestamptz;
  latest timestamptz; ready timestamptz := public.inventory_audit_time_v2(p_row->>'ready_at');
  parsed timestamptz; v text;
begin
  if d ? 'inventory_processing_started_at' then
    return public.inventory_audit_time_v2(d->>'inventory_processing_started_at');
  end if;
  foreach source in array array[nested,d] loop
    foreach key in array array['pastrim_delay_started_at','pastrim_started_at','pastrimStartedAt','pastrim_at','base_processing_at','baseProcessingAt'] loop
      latest := greatest(latest,public.inventory_audit_time_v2(source->>key));
    end loop;
    foreach key in array array['kthim','returnInfo'] loop
      if source->key->'active' is distinct from 'false'::jsonb then
        latest := greatest(latest,public.inventory_audit_time_v2(source->key->>'at'));
      end if;
    end loop;
    ready := greatest(ready,public.inventory_audit_time_v2(source->>'ready_at'));
    foreach key in array array['status_history','statusHistory'] loop
      for h in select value from jsonb_array_elements(case when jsonb_typeof(source->key)='array' then source->key else '[]'::jsonb end) loop
        status := lower(coalesce(nullif(btrim(h->>'to'),''),nullif(btrim(h->>'next_status'),''),nullif(btrim(h->>'nextStatus'),''),nullif(btrim(h->>'status'),''),''));
        event_time := greatest(public.inventory_audit_time_v2(h->>'at'),public.inventory_audit_time_v2(h->>'created_at'),public.inventory_audit_time_v2(h->>'ts'));
        if status in ('pastrim','pastrimi','at_base','in_base','base') then latest := greatest(latest,event_time); end if;
        if status in ('gati','ready') then ready := greatest(ready,event_time); end if;
      end loop;
    end loop;
  end loop;
  if ready is not null and (latest is null or ready >= latest) then return null; end if;
  if latest is not null then return latest; end if;
  foreach v in array array[p_row->>'created_at',d->>'created_at',d->>'ts',nested->>'created_at',nested->>'ts'] loop
    parsed := public.inventory_audit_time_v2(v);
    if parsed is not null then return parsed; end if;
  end loop;
  return null;
end $$;
revoke all on function public.inventory_audit_started_at_v1(jsonb) from public,anon,authenticated;
grant execute on function public.inventory_audit_started_at_v1(jsonb) to service_role;

-- Record actual transitions after the existing status guards. This also covers
-- older clients that return Gati orders by changing status alone. Preserve this
-- server-owned value through ALL writes, including privileged/offline RPCs.
create or replace function public.inventory_processing_clock_v2()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare
  d jsonb := case when jsonb_typeof(new.data)='object' then new.data else '{}'::jsonb end;
  stamp jsonb;
  processing constant text[] := array['pastrim','pastrimi','at_base','in_base','base'];
begin
  if tg_op='UPDATE' then
    if lower(btrim(coalesce(new.status,''))) = any(processing)
      and not (lower(btrim(coalesce(old.status,''))) = any(processing)) then
      stamp := to_jsonb(date_trunc('milliseconds',clock_timestamp()));
    else
      stamp := old.data->'inventory_processing_started_at';
    end if;
  end if;
  -- Inserts retain legacy admission-time semantics; clients cannot seed a
  -- forged server clock. Existing rows are deliberately not backfilled.
  d := d - 'inventory_processing_started_at';
  if stamp is not null then d := d || jsonb_build_object('inventory_processing_started_at',stamp); end if;
  if jsonb_typeof(d->'data')='object' then
    d := jsonb_set(d,'{data}',(d->'data')-'inventory_processing_started_at');
    if stamp is not null then d := jsonb_set(d,'{data,inventory_processing_started_at}',stamp); end if;
  end if;
  if d is distinct from coalesce(new.data,'{}'::jsonb) then new.data := d; end if;
  return new;
end $$;
revoke all on function public.inventory_processing_clock_v2() from public,anon,authenticated;
create trigger trg_zzzzz_inventory_processing_clock_v2 before insert or update on public.orders
for each row execute function public.inventory_processing_clock_v2();
create trigger trg_zzzzz_inventory_processing_clock_v2 before insert or update on public.transport_orders
for each row execute function public.inventory_processing_clock_v2();
