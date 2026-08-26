-- Prevent stale mobile/offline payloads from erasing saved Transport measurements.
--
-- A status-only action can arrive with an old copy of transport_orders.data. Before
-- this guard, that full JSON object replaced the current server value and could
-- remove tepiha/staza/pay even though the action only meant to change status.

create table if not exists public.transport_order_measurement_audit (
  id bigint generated always as identity primary key,
  transport_order_id uuid not null,
  code_str text,
  event_type text not null,
  old_status text,
  attempted_status text,
  old_measurement_groups integer not null default 0,
  attempted_measurement_groups integer not null default 0,
  old_data jsonb not null default '{}'::jsonb,
  attempted_data jsonb not null default '{}'::jsonb,
  protected_data jsonb not null default '{}'::jsonb,
  database_role text not null default current_user,
  created_at timestamptz not null default now()
);

alter table public.transport_order_measurement_audit enable row level security;

-- Only the SECURITY DEFINER trigger writes this forensic table. Keep it out of
-- the public API even if project-wide default grants are broad.
revoke all on table public.transport_order_measurement_audit from anon, authenticated;
revoke all on sequence public.transport_order_measurement_audit_id_seq from anon, authenticated;

create index if not exists transport_order_measurement_audit_order_created_idx
  on public.transport_order_measurement_audit (transport_order_id, created_at desc);

create or replace function public.transport_measurement_group_count_v1(p_data jsonb)
returns integer
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_data jsonb := coalesce(p_data, '{}'::jsonb);
  v_tepiha integer := 0;
  v_staza integer := 0;
  v_stairs numeric := 0;
begin
  if jsonb_typeof(v_data->'tepiha') = 'array' then
    v_tepiha := greatest(v_tepiha, jsonb_array_length(v_data->'tepiha'));
  end if;
  if jsonb_typeof(v_data->'tepihaRows') = 'array' then
    v_tepiha := greatest(v_tepiha, jsonb_array_length(v_data->'tepihaRows'));
  end if;
  if jsonb_typeof(v_data->'staza') = 'array' then
    v_staza := greatest(v_staza, jsonb_array_length(v_data->'staza'));
  end if;
  if jsonb_typeof(v_data->'stazaRows') = 'array' then
    v_staza := greatest(v_staza, jsonb_array_length(v_data->'stazaRows'));
  end if;

  begin
    v_stairs := coalesce(nullif(v_data->'shkallore'->>'qty', '')::numeric, 0);
  exception when others then
    v_stairs := 0;
  end;

  return v_tepiha + v_staza + case when v_stairs > 0 then 1 else 0 end;
end;
$$;

create or replace function public.guard_transport_measurement_loss_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old_data jsonb := coalesce(old.data, '{}'::jsonb);
  v_attempted_data jsonb := coalesce(new.data, '{}'::jsonb);
  v_incoming_data jsonb := coalesce(new.data, '{}'::jsonb);
  v_old_groups integer := public.transport_measurement_group_count_v1(v_old_data);
  v_attempted_groups integer := public.transport_measurement_group_count_v1(v_attempted_data);
  v_key text;
  v_allow_clear boolean := lower(coalesce(v_attempted_data->>'measurement_clear_intent', 'false')) = 'true';
begin
  if v_old_groups <= 0 or v_attempted_groups > 0 or v_allow_clear then
    return new;
  end if;

  -- Keep every supported measurement representation. Older app builds used the
  -- *Rows aliases, while current builds use tepiha/staza.
  foreach v_key in array array['tepiha', 'tepihaRows', 'staza', 'stazaRows', 'shkallore'] loop
    if v_old_data ? v_key then
      v_attempted_data := jsonb_set(v_attempted_data, array[v_key], v_old_data->v_key, true);
    end if;
  end loop;

  -- Preserve the server's calculation/payment fields, while allowing a genuine
  -- newer payment patch to add or override individual pay keys.
  if v_old_data ? 'pay' then
    v_attempted_data := jsonb_set(
      v_attempted_data,
      '{pay}',
      coalesce(v_old_data->'pay', '{}'::jsonb) || coalesce(v_attempted_data->'pay', '{}'::jsonb),
      true
    );
  end if;

  foreach v_key in array array['totalM2', 'total_m2', 'm2', 'totalEuro', 'total_eur', 'price_total'] loop
    if v_old_data ? v_key and not (v_attempted_data ? v_key) then
      v_attempted_data := jsonb_set(v_attempted_data, array[v_key], v_old_data->v_key, true);
    end if;
  end loop;

  v_attempted_data := v_attempted_data || jsonb_build_object(
    'measurement_loss_guard_v1', jsonb_build_object(
      'protected_at', now(),
      'reason', 'STALE_FULL_DATA_OVERWRITE_BLOCKED',
      'old_groups', v_old_groups,
      'attempted_groups', v_attempted_groups
    )
  );

  new.data := v_attempted_data;

  insert into public.transport_order_measurement_audit (
    transport_order_id,
    code_str,
    event_type,
    old_status,
    attempted_status,
    old_measurement_groups,
    attempted_measurement_groups,
    old_data,
    attempted_data,
    protected_data
  ) values (
    old.id,
    old.code_str,
    'STALE_MEASUREMENT_CLEAR_BLOCKED',
    old.status,
    new.status,
    v_old_groups,
    v_attempted_groups,
    v_old_data,
    v_incoming_data,
    v_attempted_data
  );

  return new;
end;
$$;

revoke all on function public.guard_transport_measurement_loss_v1() from public;
revoke all on function public.guard_transport_measurement_loss_v1() from anon;
revoke all on function public.guard_transport_measurement_loss_v1() from authenticated;

drop trigger if exists trg_zz_transport_measurement_loss_guard_v1 on public.transport_orders;
create trigger trg_zz_transport_measurement_loss_guard_v1
before update of data on public.transport_orders
for each row
execute function public.guard_transport_measurement_loss_v1();

comment on table public.transport_order_measurement_audit is
  'Server-side audit of blocked attempts to erase saved Transport measurements.';

comment on function public.guard_transport_measurement_loss_v1() is
  'Preserves saved transport measurements when a stale full JSON payload attempts to replace them with an empty set.';
