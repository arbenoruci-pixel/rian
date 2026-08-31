begin;

set local lock_timeout = '15s';
set local statement_timeout = '120s';

-- Four Dispatch visits were created successfully, but Blerim's later Pranimi
-- update was rejected before the measurements reached Postgres.  Recover only
-- the four audited UUIDs and abort if any live state changed after the audit.
-- Take the allocator lock first, matching every code-allocation path, before any
-- table lock or incident-private lock to avoid an allocator/order deadlock.
select pg_advisory_xact_lock(
  hashtextextended('transport-code-allocator-v3', 0)
);
select pg_advisory_xact_lock(
  hashtextextended('transport-blerim-measurement-recovery-20260831-v1', 0)
);

lock table
  public.transport_code_pool,
  public.transport_clients
in share row exclusive mode;

-- Disabling one audited AFTER trigger below requires ACCESS EXCLUSIVE.  Taking
-- it before the remaining table locks makes that short trigger pause atomic and
-- prevents any concurrent Transport order write from observing it disabled.
lock table public.transport_orders in access exclusive mode;

lock table
  public.transport_client_locations,
  public.offline_code_leases,
  public.users,
  public.arka_pending_payments,
  public.cash_handoff_items,
  public.transport_receivables,
  public.transport_delivery_events,
  public.transport_order_measurement_audit
in share row exclusive mode;

create temporary table transport_blerim_measurement_recovery_expected_v1 (
  code text primary key,
  code_n bigint not null unique,
  order_id uuid not null unique,
  client_id uuid not null unique,
  expected_updated_at timestamptz not null,
  measurements text[] not null,
  pieces integer not null,
  m2_total numeric(12,2) not null,
  euro_total numeric(12,2) not null
) on commit drop;

insert into transport_blerim_measurement_recovery_expected_v1(
  code,
  code_n,
  order_id,
  client_id,
  expected_updated_at,
  measurements,
  pieces,
  m2_total,
  euro_total
) values
  (
    'T1231', 1231,
    '138dd736-47d0-47c9-a79c-4c58ba67b0be'::uuid,
    '4bfe9777-8929-4f10-94b6-370f08a39868'::uuid,
    '2026-08-30 20:38:17.094+00'::timestamptz,
    array['3.7','3.7','3.7','3.7']::text[],
    4, 14.80, 26.64
  ),
  (
    'T1267', 1267,
    '08d1610a-fc38-48e6-9cd7-498bd0363f3f'::uuid,
    '5862a0c1-f0e3-4010-8b70-7baca43d9572'::uuid,
    '2026-08-30 20:47:30.172371+00'::timestamptz,
    array['5.8','5.8','3.7','2.0','1.0']::text[],
    5, 18.30, 32.94
  ),
  (
    'T1279', 1279,
    'a177d457-a42b-421d-8464-e8c454a4c725'::uuid,
    'ec946533-d1c1-4db9-a5da-0e84a0848879'::uuid,
    '2026-08-30 21:05:18.348169+00'::timestamptz,
    array['3.7','2.0','1.0','1.2','1.2']::text[],
    5, 9.10, 16.38
  ),
  (
    'T1299', 1299,
    'cf51230b-69aa-4618-a7ae-d85d646e102a'::uuid,
    'bfc85d1a-88e8-4fc0-99c5-af30d74ec975'::uuid,
    '2026-08-30 22:02:43.443047+00'::timestamptz,
    array['3.7','4.0']::text[],
    2, 7.70, 13.86
  );

create temporary table transport_blerim_actor_expected_v1
on commit drop
as
select u.id, u.pin, u.name, u.role, u.transport_id, u.tid
from public.users u
where u.id = 'e0f09793-3539-4242-81fe-c725baa615bc'::uuid
  and lower(btrim(u.name)) = 'blerim kosumi'
  and upper(btrim(u.role)) = 'TRANSPORT'
  and u.is_active is true
  and u.transport_id = u.id
  and u.tid = u.id
  and u.pin ~ '^\d{3,12}$';

create temporary table transport_blerim_dispatch_actor_expected_v1
on commit drop
as
select u.id, u.pin, u.name, u.role
from public.users u
where u.id = 'a00a7694-10b5-4108-8710-c947d6948fbd'::uuid
  and lower(btrim(u.name)) = 'shkendie ruhanj'
  and upper(btrim(u.role)) = 'DISPATCH'
  and u.is_active is true
  and u.pin ~ '^\d{3,12}$';

create temporary table transport_blerim_location_expected_v1 (
  location_id uuid primary key,
  client_id uuid not null unique,
  source_order_id uuid not null unique,
  address_key text not null,
  expected_updated_at timestamptz not null,
  expected_last_used_at timestamptz not null
) on commit drop;

insert into transport_blerim_location_expected_v1(
  location_id,
  client_id,
  source_order_id,
  address_key,
  expected_updated_at,
  expected_last_used_at
) values
  (
    'c5f85724-0184-4cd0-8b1f-f83eb6e6efdd'::uuid,
    '4bfe9777-8929-4f10-94b6-370f08a39868'::uuid,
    '138dd736-47d0-47c9-a79c-4c58ba67b0be'::uuid,
    'rr emona nr 51',
    '2026-08-30 20:38:17.489856+00'::timestamptz,
    '2026-08-30 20:38:17.094+00'::timestamptz
  ),
  (
    'c9eb2824-115b-47f3-a2dc-198a5ee4f3d4'::uuid,
    '5862a0c1-f0e3-4010-8b70-7baca43d9572'::uuid,
    '08d1610a-fc38-48e6-9cd7-498bd0363f3f'::uuid,
    'mrapa grand store rr rilindja nr 32',
    '2026-08-30 20:47:30.172371+00'::timestamptz,
    '2026-08-30 20:47:30.172371+00'::timestamptz
  ),
  (
    '1e08a659-3184-45bb-aee2-4c36b4eb8281'::uuid,
    'ec946533-d1c1-4db9-a5da-0e84a0848879'::uuid,
    'a177d457-a42b-421d-8464-e8c454a4c725'::uuid,
    'rr deshmoret e kombit',
    '2026-08-30 21:05:18.348169+00'::timestamptz,
    '2026-08-30 21:05:18.348169+00'::timestamptz
  ),
  (
    'dea0370e-8732-4c72-8b3f-c3a641e2542e'::uuid,
    'bfc85d1a-88e8-4fc0-99c5-af30d74ec975'::uuid,
    'cf51230b-69aa-4618-a7ae-d85d646e102a'::uuid,
    'furra mati',
    '2026-08-30 22:02:43.443047+00'::timestamptz,
    '2026-08-30 22:02:43.443047+00'::timestamptz
  );

create table if not exists public.backup_transport_blerim_measurement_recovery_20260831_v1 (
  order_id uuid primary key,
  code text not null unique,
  row_before jsonb not null,
  backed_up_at timestamptz not null default now()
);

alter table public.backup_transport_blerim_measurement_recovery_20260831_v1
  enable row level security;

revoke all on table public.backup_transport_blerim_measurement_recovery_20260831_v1
  from public, anon, authenticated;
grant select on table public.backup_transport_blerim_measurement_recovery_20260831_v1
  to service_role;

create table if not exists public.backup_transport_blerim_location_recovery_20260831_v1 (
  location_id uuid primary key,
  client_id uuid not null unique,
  source_order_id uuid not null unique,
  row_before jsonb not null,
  backed_up_at timestamptz not null default now()
);

alter table public.backup_transport_blerim_location_recovery_20260831_v1
  enable row level security;

revoke all on table public.backup_transport_blerim_location_recovery_20260831_v1
  from public, anon, authenticated;
grant select on table public.backup_transport_blerim_location_recovery_20260831_v1
  to service_role;

do $transport_blerim_measurement_recovery_preflight_v1$
declare
  v_expected_count integer;
  v_bad_orders text;
  v_bad_clients text;
  v_bad_driver integer;
  v_bad_dispatcher integer;
  v_finance_blockers text;
  v_pool_blockers text;
  v_lease_blockers text;
  v_bad_locations text;
  v_capture_trigger_count integer;
begin
  select count(*) into v_expected_count
  from transport_blerim_measurement_recovery_expected_v1;

  if v_expected_count <> 4 then
    raise exception 'TRANSPORT_BLERIM_RECOVERY_EXPECTED_SET_CHANGED:%',
      v_expected_count;
  end if;

  select string_agg(e.code, ',' order by e.code_n)
  into v_bad_orders
  from transport_blerim_measurement_recovery_expected_v1 e
  left join public.transport_orders o on o.id = e.order_id
  where o.id is null
     or o.code_n is distinct from e.code_n
     or upper(btrim(coalesce(o.code_str, ''))) <> e.code
     or upper(btrim(coalesce(o.client_tcode, ''))) <> e.code
     or o.client_id is distinct from e.client_id
     or o.visit_nr is distinct from 1
     or lower(btrim(coalesce(o.status, ''))) <> 'assigned'
     or o.updated_at is distinct from e.expected_updated_at
     or coalesce(public.transport_measurement_group_count_v1(o.data), 0) <> 0
     -- Fail closed on the exact audited empty Dispatch plan.  Do not coerce a
     -- missing, null, string or wrong-shaped value into an apparently empty one.
     or jsonb_typeof(o.data) is distinct from 'object'
     or jsonb_typeof(o.data->'pickup_plan') is distinct from 'object'
     or o.data->'pickup_plan'->'version' is distinct from '"DISPATCH_PICKUP_PLAN_V2"'::jsonb
     or o.data->'pickup_plan'->'items' is distinct from '[]'::jsonb
     or o.data->'pickup_plan'->'measurements_m2' is distinct from '[]'::jsonb
     or o.data->'pickup_plan'->'pieces' is distinct from '0'::jsonb
     or o.data->'pickup_plan'->'m2_total' is distinct from '0'::jsonb
     or o.data->'pickup_plan'->'source_text' is distinct from '""'::jsonb
     or o.data->'planned_tepiha' is distinct from '[]'::jsonb
     or o.data->'planned_pieces' is distinct from '0'::jsonb
     or o.data->'planned_m2_total' is distinct from '0'::jsonb
     or o.data->'pickup_measurements_text' is distinct from '""'::jsonb
     or (o.data ? 'pay' and o.data->'pay' is not null and o.data->'pay' <> 'null'::jsonb)
     or coalesce(o.transport_id, '') <> 'e0f09793-3539-4242-81fe-c725baa615bc'
     or coalesce(o.data->>'transport_id', '') <> 'e0f09793-3539-4242-81fe-c725baa615bc'
     or coalesce(o.data->>'assigned_driver_id', '') <> 'e0f09793-3539-4242-81fe-c725baa615bc'
     or coalesce(o.data->>'driver_pin', '') <> (
       select a.pin from transport_blerim_actor_expected_v1 a
     )
     or lower(btrim(coalesce(o.data->>'driver_name', ''))) <> 'blerim kosumi';

  if v_bad_orders is not null then
    raise exception 'TRANSPORT_BLERIM_RECOVERY_ORDER_STATE_CHANGED:%',
      v_bad_orders;
  end if;

  select string_agg(e.code, ',' order by e.code_n)
  into v_bad_clients
  from transport_blerim_measurement_recovery_expected_v1 e
  where (
      select count(*)
      from public.transport_clients c
      where c.id = e.client_id
        and upper(btrim(coalesce(c.tcode, ''))) = e.code
    ) <> 1
    or (
      select count(*)
      from public.transport_clients c
      where upper(btrim(coalesce(c.tcode, ''))) = e.code
    ) <> 1
    or (
      select count(*)
      from public.transport_orders o
      where o.id = e.order_id
        and o.client_id = e.client_id
        and o.code_n = e.code_n
        and upper(btrim(coalesce(o.code_str, ''))) = e.code
        and upper(btrim(coalesce(o.client_tcode, ''))) = e.code
    ) <> 1
    -- A second order reusing any representation of the incident code would
    -- make this recovery ambiguous even if the canonical UUID still matched.
    or (
      select count(*)
      from public.transport_orders o
      where o.code_n = e.code_n
    ) <> 1
    or (
      select count(*)
      from public.transport_orders o
      where upper(btrim(coalesce(o.code_str, ''))) = e.code
    ) <> 1
    or (
      select count(*)
      from public.transport_orders o
      where upper(btrim(coalesce(o.client_tcode, ''))) = e.code
    ) <> 1;

  if v_bad_clients is not null then
    raise exception 'TRANSPORT_BLERIM_RECOVERY_CLIENT_IDENTITY_CHANGED:%',
      v_bad_clients;
  end if;

  select count(*) into v_bad_driver
  from transport_blerim_actor_expected_v1;

  if v_bad_driver <> 1 then
    raise exception 'TRANSPORT_BLERIM_RECOVERY_DRIVER_IDENTITY_CHANGED:%',
      v_bad_driver;
  end if;

  select count(*) into v_bad_dispatcher
  from transport_blerim_dispatch_actor_expected_v1;

  if v_bad_dispatcher <> 1 then
    raise exception 'TRANSPORT_BLERIM_RECOVERY_DISPATCH_IDENTITY_CHANGED:%',
      v_bad_dispatcher;
  end if;

  select string_agg(e.code, ',' order by e.code_n)
  into v_finance_blockers
  from transport_blerim_measurement_recovery_expected_v1 e
  where exists (
      select 1 from public.arka_pending_payments p
      where p.transport_order_id = e.order_id
    )
    or exists (
      select 1 from public.cash_handoff_items h
      where h.transport_order_id = e.order_id
    )
    or exists (
      select 1 from public.transport_receivables r
      where r.transport_order_id = e.order_id
    )
    or exists (
      select 1 from public.transport_delivery_events d
      where d.transport_order_id = e.order_id
    )
    or exists (
      select 1 from public.transport_order_measurement_audit a
      where a.transport_order_id = e.order_id
    );

  if v_finance_blockers is not null then
    raise exception 'TRANSPORT_BLERIM_RECOVERY_LIFECYCLE_CHANGED:%',
      v_finance_blockers;
  end if;

  select string_agg(e.code, ',' order by e.code_n)
  into v_pool_blockers
  from transport_blerim_measurement_recovery_expected_v1 e
  left join public.transport_code_pool p on p.code = e.code
  where p.code is null
     or lower(btrim(coalesce(p.status, ''))) <> 'used'
     or p.reserved_at is not null
     or p.owner_id is distinct from case
       when e.code = 'T1231' then (
         select a.pin from transport_blerim_dispatch_actor_expected_v1 a
       )
       else (select a.pin from transport_blerim_actor_expected_v1 a)
     end;

  if v_pool_blockers is not null then
    raise exception 'TRANSPORT_BLERIM_RECOVERY_POOL_STATE_CHANGED:%',
      v_pool_blockers;
  end if;

  select string_agg(e.code, ',' order by e.code_n)
  into v_lease_blockers
  from transport_blerim_measurement_recovery_expected_v1 e
  where exists (
    select 1
    from public.offline_code_leases l
    join public.transport_orders o on o.id = e.order_id
    where lower(btrim(l.scope)) = 'transport'
      and (
        upper(btrim(l.code)) = e.code
        or nullif(btrim(l.draft_session_id), '') = coalesce(
          nullif(btrim(o.data->>'local_oid'), ''),
          nullif(btrim(o.data->>'order_id'), ''),
          nullif(btrim(o.data->>'public_order_id'), ''),
          o.id::text
        )
        or nullif(btrim(l.order_id), '') = o.id::text
      )
  );

  if v_lease_blockers is not null then
    raise exception 'TRANSPORT_BLERIM_RECOVERY_LEASE_STATE_CHANGED:%',
      v_lease_blockers;
  end if;

  select string_agg(e.source_order_id::text, ',' order by e.source_order_id)
  into v_bad_locations
  from transport_blerim_location_expected_v1 e
  left join public.transport_client_locations l on l.id = e.location_id
  where l.id is null
     or l.client_id is distinct from e.client_id
     or l.source_order_id is distinct from e.source_order_id
     or l.address_key is distinct from e.address_key
     or l.updated_at is distinct from e.expected_updated_at
     or l.last_used_at is distinct from e.expected_last_used_at;

  if v_bad_locations is not null or (
    select count(*)
    from public.transport_client_locations l
    join transport_blerim_measurement_recovery_expected_v1 e
      on e.client_id = l.client_id
  ) <> 4 then
    raise exception 'TRANSPORT_BLERIM_RECOVERY_LOCATION_STATE_CHANGED:%',
      coalesce(v_bad_locations, 'CARDINALITY');
  end if;

  select count(*) into v_capture_trigger_count
  from pg_catalog.pg_trigger t
  join pg_catalog.pg_class c on c.oid = t.tgrelid
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname = 'transport_orders'
    and t.tgname = 'trg_capture_transport_order_location'
    and not t.tgisinternal
    and t.tgenabled = 'O';

  if v_capture_trigger_count <> 1 then
    raise exception 'TRANSPORT_BLERIM_RECOVERY_LOCATION_TRIGGER_CHANGED:%',
      v_capture_trigger_count;
  end if;
end;
$transport_blerim_measurement_recovery_preflight_v1$;

insert into public.backup_transport_blerim_measurement_recovery_20260831_v1(
  order_id,
  code,
  row_before
)
select o.id, e.code, to_jsonb(o)
from transport_blerim_measurement_recovery_expected_v1 e
join public.transport_orders o on o.id = e.order_id
on conflict (order_id) do nothing;

insert into public.backup_transport_blerim_location_recovery_20260831_v1(
  location_id,
  client_id,
  source_order_id,
  row_before
)
select l.id, l.client_id, l.source_order_id, to_jsonb(l)
from transport_blerim_location_expected_v1 e
join public.transport_client_locations l on l.id = e.location_id
on conflict (location_id) do nothing;

-- An earlier failed/manual run may already have inserted a backup row.  Before
-- any trigger is paused or business row is changed, prove every persisted
-- snapshot is exactly the currently locked row, not merely the same UUID/code.
do $transport_blerim_backup_exact_precheck_v1$
declare
  v_order_backup_count integer;
  v_location_backup_count integer;
begin
  select count(*) into v_order_backup_count
  from transport_blerim_measurement_recovery_expected_v1 e
  join public.transport_orders o on o.id = e.order_id
  join public.backup_transport_blerim_measurement_recovery_20260831_v1 b
    on b.order_id = e.order_id
   and b.code = e.code
   and b.row_before = to_jsonb(o);

  if v_order_backup_count <> 4 then
    raise exception 'TRANSPORT_BLERIM_RECOVERY_BACKUP_NOT_EXACT:%',
      v_order_backup_count;
  end if;

  select count(*) into v_location_backup_count
  from transport_blerim_location_expected_v1 e
  join public.transport_client_locations l on l.id = e.location_id
  join public.backup_transport_blerim_location_recovery_20260831_v1 b
    on b.location_id = e.location_id
   and b.client_id = e.client_id
   and b.source_order_id = e.source_order_id
   and b.row_before = to_jsonb(l);

  if v_location_backup_count <> 4 then
    raise exception 'TRANSPORT_BLERIM_RECOVERY_LOCATION_BACKUP_NOT_EXACT:%',
      v_location_backup_count;
  end if;
end;
$transport_blerim_backup_exact_precheck_v1$;

-- The order UPDATE changes no address/location data.  Pause exactly the
-- location-capture trigger while transport_orders is ACCESS EXCLUSIVE locked so
-- its automatic last_used_at touch cannot alter these four client locations.
alter table public.transport_orders
  disable trigger trg_capture_transport_order_location;

do $transport_blerim_measurement_recovery_apply_v1$
declare
  v_backup_count integer;
  v_updated integer;
  v_postcheck_failures text;
  v_unrelated_change text;
begin
  select count(*) into v_backup_count
  from transport_blerim_measurement_recovery_expected_v1 e
  join public.transport_orders o on o.id = e.order_id
  join public.backup_transport_blerim_measurement_recovery_20260831_v1 b
    on b.order_id = e.order_id
   and b.code = e.code
   and b.row_before = to_jsonb(o);

  if v_backup_count <> 4 then
    raise exception 'TRANSPORT_BLERIM_RECOVERY_BACKUP_INCOMPLETE:%',
      v_backup_count;
  end if;

  with prepared as (
    select
      e.*,
      (
        select jsonb_agg(
          jsonb_build_object(
            'id', 't' || m.ordinality::text,
            'm2', m.value::numeric,
            'qty', 1,
            'photoUrl', ''
          )
          order by m.ordinality
        )
        from unnest(e.measurements) with ordinality as m(value, ordinality)
      ) as actual_rows,
      (
        select jsonb_agg(
          jsonb_build_object(
            'id', 'planned_' || m.ordinality::text,
            'type', 'tepih',
            'qty', 1,
            'm2', m.value::numeric,
            'planned', true,
            'source', 'DISPATCH'
          )
          order by m.ordinality
        )
        from unnest(e.measurements) with ordinality as m(value, ordinality)
      ) as planned_rows
    from transport_blerim_measurement_recovery_expected_v1 e
  ), updated as (
    update public.transport_orders o
    set status = 'pickup',
        updated_at = now(),
        data = coalesce(o.data, '{}'::jsonb) || jsonb_build_object(
          'status', 'pickup',
          'tepiha', p.actual_rows,
          'staza', '[]'::jsonb,
          'shkallore', jsonb_build_object('qty', 0, 'per', 0.3),
          'pieces', p.pieces,
          'm2_total', p.m2_total,
          'price_total', p.euro_total,
          'totals', jsonb_build_object(
            'm2', p.m2_total,
            'total', p.euro_total,
            'euro', p.euro_total,
            'pieces', p.pieces
          ),
          'pay', jsonb_build_object(
            'm2', p.m2_total,
            'euro', p.euro_total,
            'total', p.euro_total,
            'paid', 0,
            'rate', 1.8,
            'pieces', p.pieces,
            'arkaRecordedPaid', 0,
            'debt', p.euro_total
          ),
          'price_per_m2', 1.8,
          'clientPaid', 0,
          'paid', 0,
          'debt', p.euro_total,
          'isPaid', false,
          'pickup_plan', coalesce(o.data->'pickup_plan', '{}'::jsonb)
            || jsonb_build_object(
              'version', 'DISPATCH_PICKUP_PLAN_V2',
              'pieces', p.pieces,
              'measurements_m2', to_jsonb(p.measurements::numeric[]),
              'm2_total', p.m2_total,
              'items', p.planned_rows,
              'source_text', array_to_string(p.measurements, ', ')
            ),
          'planned_tepiha', p.planned_rows,
          'planned_pieces', p.pieces,
          'planned_m2_total', p.m2_total,
          'pickup_measurements_text', array_to_string(p.measurements, ', '),
          'pickup_at', now(),
          'accepted_at', now(),
          'started_at', now(),
          'accepted_by_pin', (
            select a.pin from transport_blerim_actor_expected_v1 a
          ),
          'accepted_by_name', 'blerim kosumi',
          'measurement_recovery_v1', jsonb_build_object(
            'reason', 'PRANIMI_POOL_PERMISSION_FAILURE',
            'source', 'BLERIM_REPORTED_MEASUREMENTS',
            'recovered_at', now()
          )
        )
    from prepared p
    where o.id = p.order_id
      and o.code_n = p.code_n
      and o.client_id = p.client_id
      and lower(btrim(o.status)) = 'assigned'
      and o.updated_at = p.expected_updated_at
      and public.transport_measurement_group_count_v1(o.data) = 0
    returning o.id
  )
  select count(*) into v_updated from updated;

  if v_updated <> 4 then
    raise exception 'TRANSPORT_BLERIM_RECOVERY_UPDATE_COUNT_CHANGED:%',
      v_updated;
  end if;

  select string_agg(e.code, ',' order by e.code_n)
  into v_postcheck_failures
  from transport_blerim_measurement_recovery_expected_v1 e
  join public.transport_orders o on o.id = e.order_id
  where lower(btrim(coalesce(o.status, ''))) <> 'pickup'
     or lower(btrim(coalesce(o.data->>'status', ''))) <> 'pickup'
     or public.transport_measurement_group_count_v1(o.data) <> e.pieces
     or coalesce(jsonb_array_length(
          case when jsonb_typeof(o.data->'tepiha') = 'array'
            then o.data->'tepiha' else '[]'::jsonb end
        ), 0) <> e.pieces
     or coalesce(jsonb_array_length(
          case when jsonb_typeof(o.data->'pickup_plan'->'items') = 'array'
            then o.data->'pickup_plan'->'items' else '[]'::jsonb end
        ), 0) <> e.pieces
     or coalesce(jsonb_array_length(
          case when jsonb_typeof(o.data->'planned_tepiha') = 'array'
            then o.data->'planned_tepiha' else '[]'::jsonb end
        ), 0) <> e.pieces
     or (o.data->'pay'->>'m2')::numeric is distinct from e.m2_total
     or (o.data->'pay'->>'euro')::numeric is distinct from e.euro_total
     or (o.data->'pay'->>'total')::numeric is distinct from e.euro_total
     or (o.data->'pay'->>'paid')::numeric is distinct from 0::numeric
     or (o.data->'pay'->>'rate')::numeric is distinct from 1.8::numeric
     or (o.data->'pay'->>'pieces')::integer is distinct from e.pieces
     or (o.data->'pay'->>'arkaRecordedPaid')::numeric is distinct from 0::numeric
     or (o.data->'pay'->>'debt')::numeric is distinct from e.euro_total
     or (o.data->>'pieces')::integer is distinct from e.pieces
     or (o.data->>'m2_total')::numeric is distinct from e.m2_total
     or (o.data->>'price_total')::numeric is distinct from e.euro_total
     or (o.data->'totals'->>'m2')::numeric is distinct from e.m2_total
     or (o.data->'totals'->>'total')::numeric is distinct from e.euro_total
     or (o.data->'totals'->>'euro')::numeric is distinct from e.euro_total
     or (o.data->'totals'->>'pieces')::integer is distinct from e.pieces
     or (o.data->>'price_per_m2')::numeric is distinct from 1.8::numeric
     or (o.data->>'clientPaid')::numeric is distinct from 0::numeric
     or (o.data->>'paid')::numeric is distinct from 0::numeric
     or (o.data->>'debt')::numeric is distinct from e.euro_total
     or (o.data->>'isPaid')::boolean is distinct from false
     or o.data->'staza' is distinct from '[]'::jsonb
     or (o.data->'shkallore'->>'qty')::integer is distinct from 0
     or (o.data->'shkallore'->>'per')::numeric is distinct from 0.3::numeric
     or (o.data->'pickup_plan'->>'m2_total')::numeric is distinct from e.m2_total
     or (o.data->'pickup_plan'->>'pieces')::integer is distinct from e.pieces
     or (o.data->>'planned_m2_total')::numeric is distinct from e.m2_total
     or (o.data->>'planned_pieces')::integer is distinct from e.pieces
     or coalesce(o.data->>'assigned_driver_id', '') <> 'e0f09793-3539-4242-81fe-c725baa615bc'
     or coalesce(o.data->>'driver_pin', '') <> (
       select a.pin from transport_blerim_actor_expected_v1 a
     )
     or o.data->>'pickup_at' is null
     or o.data->>'accepted_at' is null
     or o.data->>'started_at' is null
     or exists (
       select 1
       from unnest(e.measurements) with ordinality expected(value, ordinality)
       left join lateral (
         select stored.value as row_value
         from jsonb_array_elements(
           case when jsonb_typeof(o.data->'tepiha') = 'array'
             then o.data->'tepiha' else '[]'::jsonb end
         ) with ordinality stored(value, ordinality)
         where stored.ordinality = expected.ordinality
       ) found_row on true
       where found_row.row_value is null
          or (found_row.row_value->>'m2')::numeric is distinct from expected.value::numeric
          or (found_row.row_value->>'qty')::numeric is distinct from 1::numeric
     )
     or exists (
       select 1
       from unnest(e.measurements) with ordinality expected(value, ordinality)
       left join lateral (
         select stored.value as row_value
         from jsonb_array_elements(
           case when jsonb_typeof(o.data->'pickup_plan'->'items') = 'array'
             then o.data->'pickup_plan'->'items' else '[]'::jsonb end
         ) with ordinality stored(value, ordinality)
         where stored.ordinality = expected.ordinality
       ) found_row on true
       where found_row.row_value is null
          or (found_row.row_value->>'m2')::numeric is distinct from expected.value::numeric
          or (found_row.row_value->>'qty')::numeric is distinct from 1::numeric
     );

  if v_postcheck_failures is not null then
    raise exception 'TRANSPORT_BLERIM_RECOVERY_POSTCHECK_FAILED:%',
      v_postcheck_failures;
  end if;

  select string_agg(e.code, ',' order by e.code_n)
  into v_unrelated_change
  from transport_blerim_measurement_recovery_expected_v1 e
  join public.transport_orders o on o.id = e.order_id
  join public.backup_transport_blerim_measurement_recovery_20260831_v1 b
    on b.order_id = e.order_id
  where (
      o.data - array[
        'status','tepiha','staza','shkallore','pieces','m2_total','price_total',
        'totals','pay','price_per_m2','clientPaid','paid','debt','isPaid',
        'pickup_plan','planned_tepiha','planned_pieces',
        'planned_m2_total','pickup_measurements_text','pickup_at','accepted_at',
        'started_at','accepted_by_pin','accepted_by_name','measurement_recovery_v1'
      ]::text[]
    ) is distinct from (
      (b.row_before->'data') - array[
        'status','tepiha','staza','shkallore','pieces','m2_total','price_total',
        'totals','pay','price_per_m2','clientPaid','paid','debt','isPaid',
        'pickup_plan','planned_tepiha','planned_pieces',
        'planned_m2_total','pickup_measurements_text','pickup_at','accepted_at',
        'started_at','accepted_by_pin','accepted_by_name','measurement_recovery_v1'
      ]::text[]
    )
    or o.code_n is distinct from (b.row_before->>'code_n')::bigint
    or o.code_str is distinct from b.row_before->>'code_str'
    or o.client_tcode is distinct from b.row_before->>'client_tcode'
    or o.client_id is distinct from (b.row_before->>'client_id')::uuid
    or o.created_at is distinct from (b.row_before->>'created_at')::timestamptz
    -- Apart from status/data/updated_at, every physical column must remain
    -- byte-for-byte JSON equivalent to the locked incident backup.
    or (to_jsonb(o) - array['status','data','updated_at']::text[])
       is distinct from
       (b.row_before - array['status','data','updated_at']::text[])
    or (
      (o.data->'pickup_plan') - array[
        'version','pieces','measurements_m2','m2_total','items','source_text'
      ]::text[]
    ) is distinct from (
      (b.row_before->'data'->'pickup_plan') - array[
        'version','pieces','measurements_m2','m2_total','items','source_text'
      ]::text[]
    );

  if v_unrelated_change is not null then
    raise exception 'TRANSPORT_BLERIM_RECOVERY_UNRELATED_DATA_CHANGED:%',
      v_unrelated_change;
  end if;
end;
$transport_blerim_measurement_recovery_apply_v1$;

alter table public.transport_orders
  enable trigger trg_capture_transport_order_location;

do $transport_blerim_location_postcheck_v1$
declare
  v_backup_count integer;
  v_changed_locations text;
  v_capture_trigger_count integer;
begin
  select count(*) into v_backup_count
  from transport_blerim_location_expected_v1 e
  join public.transport_client_locations l on l.id = e.location_id
  join public.backup_transport_blerim_location_recovery_20260831_v1 b
    on b.location_id = e.location_id
   and b.client_id = e.client_id
   and b.source_order_id = e.source_order_id
   and b.row_before = to_jsonb(l);

  if v_backup_count <> 4 then
    raise exception 'TRANSPORT_BLERIM_RECOVERY_LOCATION_BACKUP_INCOMPLETE:%',
      v_backup_count;
  end if;

  select string_agg(e.source_order_id::text, ',' order by e.source_order_id)
  into v_changed_locations
  from transport_blerim_location_expected_v1 e
  join public.backup_transport_blerim_location_recovery_20260831_v1 b
    on b.location_id = e.location_id
  left join public.transport_client_locations l on l.id = e.location_id
  where l.id is null
     or to_jsonb(l) is distinct from b.row_before;

  if v_changed_locations is not null or (
    select count(*)
    from public.transport_client_locations l
    join transport_blerim_measurement_recovery_expected_v1 e
      on e.client_id = l.client_id
  ) <> 4 then
    raise exception 'TRANSPORT_BLERIM_RECOVERY_LOCATION_SIDE_EFFECT:%',
      coalesce(v_changed_locations, 'CARDINALITY');
  end if;

  select count(*) into v_capture_trigger_count
  from pg_catalog.pg_trigger t
  join pg_catalog.pg_class c on c.oid = t.tgrelid
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname = 'transport_orders'
    and t.tgname = 'trg_capture_transport_order_location'
    and not t.tgisinternal
    and t.tgenabled = 'O';

  if v_capture_trigger_count <> 1 then
    raise exception 'TRANSPORT_BLERIM_RECOVERY_LOCATION_TRIGGER_NOT_RESTORED:%',
      v_capture_trigger_count;
  end if;
end;
$transport_blerim_location_postcheck_v1$;

commit;
