begin;

set local lock_timeout = '15s';
set local statement_timeout = '120s';

-- Exact live audit at 2026-08-31 09:00 UTC found these 26 pool rows in
-- status=used without a client, order, finance/lifecycle reference or lease of
-- any status.  Release only this immutable incident set and fail closed if a
-- legitimate reference appears before the migration runs.
select pg_advisory_xact_lock(
  hashtextextended('transport-code-allocator-v3', 0)
);

lock table
  public.transport_code_pool,
  public.transport_clients,
  public.transport_orders,
  public.offline_code_leases,
  public.arka_pending_payments,
  public.cash_handoff_items,
  public.arka_payment_exclusions,
  public.transport_client_debts,
  public.transport_receivables,
  public.dispatch_tasks,
  public.transport_order_measurement_audit,
  public.transport_keep_one
in share row exclusive mode;

create temporary table transport_stranded_code_release_expected_v4 (
  code text primary key,
  code_n bigint not null unique,
  owner_id text not null,
  created_at timestamptz not null
) on commit drop;

insert into transport_stranded_code_release_expected_v4(
  code,
  code_n,
  owner_id,
  created_at
) values
  ('T989', 989, '1968', '2026-07-05 21:38:32.644598+00'::timestamptz),
  ('T1159', 1159, '2468', '2026-08-21 21:19:31.808597+00'::timestamptz),
  ('T1160', 1160, '2468', '2026-08-21 21:19:37.170439+00'::timestamptz),
  ('T1162', 1162, '1968', '2026-08-22 06:30:05.577786+00'::timestamptz),
  ('T1163', 1163, '1968', '2026-08-22 06:30:07.618302+00'::timestamptz),
  ('T1164', 1164, '1968', '2026-08-22 06:30:09.507936+00'::timestamptz),
  ('T1165', 1165, '1968', '2026-08-22 06:30:29.297825+00'::timestamptz),
  ('T1166', 1166, '1968', '2026-08-22 06:30:30.542096+00'::timestamptz),
  ('T1167', 1167, '1968', '2026-08-22 06:31:30.01308+00'::timestamptz),
  ('T1168', 1168, '1968', '2026-08-22 06:31:45.392391+00'::timestamptz),
  ('T1169', 1169, '1968', '2026-08-22 06:32:46.735294+00'::timestamptz),
  ('T1170', 1170, '1968', '2026-08-22 06:33:43.475465+00'::timestamptz),
  ('T1172', 1172, '2468', '2026-08-25 09:48:19.053994+00'::timestamptz),
  ('T1173', 1173, '2468', '2026-08-25 09:48:43.518489+00'::timestamptz),
  ('T1174', 1174, '2468', '2026-08-25 09:48:53.199217+00'::timestamptz),
  ('T1175', 1175, '2468', '2026-08-25 09:49:01.347112+00'::timestamptz),
  ('T1176', 1176, '2468', '2026-08-25 09:49:24.681723+00'::timestamptz),
  ('T1199', 1199, '2468', '2026-08-27 18:20:47.994371+00'::timestamptz),
  ('T1200', 1200, '2468', '2026-08-27 18:20:50.446888+00'::timestamptz),
  ('T1201', 1201, '2468', '2026-08-27 18:20:51.980983+00'::timestamptz),
  ('T1204', 1204, '2468', '2026-08-27 18:27:39.739641+00'::timestamptz),
  ('T1205', 1205, '2468', '2026-08-27 18:27:42.270796+00'::timestamptz),
  ('T1209', 1209, '2468', '2026-08-27 18:29:54.267162+00'::timestamptz),
  ('T1210', 1210, '2468', '2026-08-27 18:29:55.802992+00'::timestamptz),
  ('T1211', 1211, '2468', '2026-08-27 18:29:57.157734+00'::timestamptz),
  ('T1228', 1228, '2468', '2026-08-30 08:27:51.951553+00'::timestamptz);

create temporary table transport_stranded_code_protected_v4 (
  code text primary key,
  code_n bigint not null unique,
  order_id uuid not null unique,
  client_id uuid not null unique
) on commit drop;

insert into transport_stranded_code_protected_v4(
  code,
  code_n,
  order_id,
  client_id
) values
  (
    'T1231', 1231,
    '138dd736-47d0-47c9-a79c-4c58ba67b0be'::uuid,
    '4bfe9777-8929-4f10-94b6-370f08a39868'::uuid
  ),
  (
    'T1267', 1267,
    '08d1610a-fc38-48e6-9cd7-498bd0363f3f'::uuid,
    '5862a0c1-f0e3-4010-8b70-7baca43d9572'::uuid
  ),
  (
    'T1279', 1279,
    'a177d457-a42b-421d-8464-e8c454a4c725'::uuid,
    'ec946533-d1c1-4db9-a5da-0e84a0848879'::uuid
  ),
  (
    'T1299', 1299,
    'cf51230b-69aa-4618-a7ae-d85d646e102a'::uuid,
    'bfc85d1a-88e8-4fc0-99c5-af30d74ec975'::uuid
  );

-- The lifecycle helper is intentionally expensive because it searches every
-- authoritative reference surface.  All of those surfaces are write-locked
-- above, so evaluate it exactly once for the immutable 26-code set and reuse
-- this fail-closed snapshot for preflight, UPDATE qualification and postcheck.
create temporary table transport_stranded_code_reference_snapshot_v4 (
  code text primary key,
  has_lifecycle_reference boolean not null,
  has_any_lease boolean not null
) on commit drop;

insert into transport_stranded_code_reference_snapshot_v4(
  code,
  has_lifecycle_reference,
  has_any_lease
)
select
  e.code,
  public.transport_tcode_has_lifecycle_reference_v2(e.code),
  exists (
    -- Terminal leases block reuse too; the normal allocator's lifecycle helper
    -- only needs active leases, while incident recovery must reject every lease.
    select 1
    from public.offline_code_leases l
    where lower(btrim(l.scope)) = 'transport'
      and upper(btrim(l.code)) = e.code
  )
from transport_stranded_code_release_expected_v4 e;

create table if not exists public.backup_transport_stranded_code_release_20260831_v4 (
  code text primary key,
  code_n bigint not null unique,
  owner_id text not null,
  status text not null,
  created_at timestamptz not null,
  reserved_at timestamptz,
  row_before jsonb not null,
  backed_up_at timestamptz not null default now()
);

alter table public.backup_transport_stranded_code_release_20260831_v4
  enable row level security;

revoke all on table public.backup_transport_stranded_code_release_20260831_v4
  from public, anon, authenticated;
grant select on table public.backup_transport_stranded_code_release_20260831_v4
  to service_role;

do $transport_stranded_code_release_preflight_v4$
declare
  v_expected_count integer;
  v_reference_snapshot_count integer;
  v_bad_state text;
  v_reference_blockers text;
  v_protected_count integer;
begin
  select count(*) into v_expected_count
  from transport_stranded_code_release_expected_v4;

  if v_expected_count <> 26 then
    raise exception 'TRANSPORT_STRANDED_RELEASE_V4_EXPECTED_SET_CHANGED:%',
      v_expected_count;
  end if;

  select count(*) into v_reference_snapshot_count
  from transport_stranded_code_reference_snapshot_v4;

  if v_reference_snapshot_count <> v_expected_count then
    raise exception 'TRANSPORT_STRANDED_RELEASE_V4_REFERENCE_SNAPSHOT_INCOMPLETE:%',
      v_reference_snapshot_count;
  end if;

  select string_agg(e.code, ',' order by e.code_n)
  into v_bad_state
  from transport_stranded_code_release_expected_v4 e
  left join public.transport_code_pool p on p.code = e.code
  where p.code is null
     or public.transport_tcode_number_v2(p.code) is distinct from e.code_n
     or p.code <> 'T' || e.code_n::text
     or lower(btrim(coalesce(p.status, ''))) <> 'used'
     or p.owner_id is distinct from e.owner_id
     or p.created_at is distinct from e.created_at
     or p.reserved_at is not null;

  if v_bad_state is not null then
    raise exception 'TRANSPORT_STRANDED_RELEASE_V4_POOL_STATE_CHANGED:%',
      v_bad_state;
  end if;

  select string_agg(e.code, ',' order by e.code_n)
  into v_reference_blockers
  from transport_stranded_code_release_expected_v4 e
  join transport_stranded_code_reference_snapshot_v4 refs
    on refs.code = e.code
  where refs.has_lifecycle_reference
     or refs.has_any_lease;

  if v_reference_blockers is not null then
    raise exception 'TRANSPORT_STRANDED_RELEASE_V4_REFERENCE_BLOCKERS:%',
      v_reference_blockers;
  end if;

  select count(*) into v_protected_count
  from transport_stranded_code_protected_v4 protected
  where exists (
      select 1
      from public.transport_code_pool p
      where p.code = protected.code
        and lower(btrim(p.status)) = 'used'
        and p.reserved_at is null
    )
    and (
      select count(*)
      from public.transport_clients c
      where c.id = protected.client_id
        and upper(btrim(coalesce(c.tcode, ''))) = protected.code
    ) = 1
    and (
      select count(*)
      from public.transport_orders o
      where o.id = protected.order_id
        and o.client_id = protected.client_id
        and o.code_n = protected.code_n
        and upper(btrim(coalesce(o.code_str, ''))) = protected.code
        and upper(btrim(coalesce(o.client_tcode, ''))) = protected.code
    ) = 1;

  if v_protected_count <> 4 then
    raise exception 'TRANSPORT_STRANDED_RELEASE_V4_PROTECTED_SET_CHANGED:%',
      v_protected_count;
  end if;
end;
$transport_stranded_code_release_preflight_v4$;

insert into public.backup_transport_stranded_code_release_20260831_v4(
  code,
  code_n,
  owner_id,
  status,
  created_at,
  reserved_at,
  row_before
)
select
  p.code,
  e.code_n,
  p.owner_id,
  p.status,
  p.created_at,
  p.reserved_at,
  to_jsonb(p)
from transport_stranded_code_release_expected_v4 e
join public.transport_code_pool p on p.code = e.code
on conflict (code) do nothing;

do $transport_stranded_code_release_apply_v4$
declare
  v_backup_count integer;
  v_updated integer;
  v_postcheck_count integer;
  v_reference_blockers text;
  v_protected_count integer;
begin
  select count(*) into v_backup_count
  from transport_stranded_code_release_expected_v4 e
  join public.transport_code_pool p on p.code = e.code
  join public.backup_transport_stranded_code_release_20260831_v4 b
    on b.code = e.code
   and b.code_n = e.code_n
   and b.owner_id = e.owner_id
   and lower(btrim(b.status)) = 'used'
   and b.created_at = e.created_at
   and b.reserved_at is null
   and b.row_before = to_jsonb(p);

  if v_backup_count <> 26 then
    raise exception 'TRANSPORT_STRANDED_RELEASE_V4_BACKUP_INCOMPLETE:%',
      v_backup_count;
  end if;

  update public.transport_code_pool p
  set status = 'available',
      owner_id = 'POOL',
      reserved_at = null
  from transport_stranded_code_release_expected_v4 e
  join transport_stranded_code_reference_snapshot_v4 refs
    on refs.code = e.code
  where p.code = e.code
    and public.transport_tcode_number_v2(p.code) = e.code_n
    and lower(btrim(p.status)) = 'used'
    and p.owner_id = e.owner_id
    and p.created_at = e.created_at
    and p.reserved_at is null
    and not refs.has_lifecycle_reference
    and not refs.has_any_lease;

  get diagnostics v_updated = row_count;

  if v_updated <> 26 then
    raise exception 'TRANSPORT_STRANDED_RELEASE_V4_UPDATE_COUNT_CHANGED:%',
      v_updated;
  end if;

  select count(*) into v_postcheck_count
  from transport_stranded_code_release_expected_v4 e
  join public.transport_code_pool p on p.code = e.code
  where p.code = 'T' || e.code_n::text
    and lower(btrim(p.status)) = 'available'
    and p.owner_id = 'POOL'
    and p.created_at = e.created_at
    and p.reserved_at is null;

  if v_postcheck_count <> 26 then
    raise exception 'TRANSPORT_STRANDED_RELEASE_V4_POSTCHECK_FAILED:%',
      v_postcheck_count;
  end if;

  select string_agg(e.code, ',' order by e.code_n)
  into v_reference_blockers
  from transport_stranded_code_release_expected_v4 e
  join transport_stranded_code_reference_snapshot_v4 refs
    on refs.code = e.code
  where refs.has_lifecycle_reference
     or refs.has_any_lease;

  if v_reference_blockers is not null then
    raise exception 'TRANSPORT_STRANDED_RELEASE_V4_POST_REFERENCE_BLOCKERS:%',
      v_reference_blockers;
  end if;

  select count(*) into v_protected_count
  from transport_stranded_code_protected_v4 protected
  where exists (
      select 1
      from public.transport_code_pool p
      where p.code = protected.code
        and lower(btrim(p.status)) = 'used'
        and p.reserved_at is null
    )
    and exists (
      select 1
      from public.transport_clients c
      where c.id = protected.client_id
        and upper(btrim(coalesce(c.tcode, ''))) = protected.code
    )
    and exists (
      select 1
      from public.transport_orders o
      where o.id = protected.order_id
        and o.client_id = protected.client_id
        and o.code_n = protected.code_n
        and upper(btrim(coalesce(o.code_str, ''))) = protected.code
        and upper(btrim(coalesce(o.client_tcode, ''))) = protected.code
    );

  if v_protected_count <> 4 then
    raise exception 'TRANSPORT_STRANDED_RELEASE_V4_PROTECTED_POSTCHECK_FAILED:%',
      v_protected_count;
  end if;
end;
$transport_stranded_code_release_apply_v4$;

commit;
