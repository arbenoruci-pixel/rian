begin;

set local lock_timeout = '15s';
set local statement_timeout = '120s';

-- A third retry storm occurred while the permanent fix was being prepared:
-- T1300, T1311, T1327 and T1328 completed normally; T1301..T1310,
-- T1312..T1326 and T1329..T1330 were reserved without any lifecycle record.
-- Keep this release set exact and abort if any code acquires a real reference.

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

create temporary table dispatch_tcode_cleanup_v3_expected (
  code text primary key,
  code_n bigint not null unique
) on commit drop;

insert into dispatch_tcode_cleanup_v3_expected(code, code_n)
select 'T' || n::text, n
from (
  select n
  from generate_series(1301::bigint, 1310::bigint) as n
  union all
  select n
  from generate_series(1312::bigint, 1326::bigint) as n
  union all
  select n
  from generate_series(1329::bigint, 1330::bigint) as n
) stranded;

create table if not exists public.backup_dispatch_tcode_stranded_cleanup_20260831_v3 (
  code text primary key,
  owner_id text,
  status text,
  created_at timestamptz,
  reserved_at timestamptz,
  backed_up_at timestamptz not null default now()
);

alter table public.backup_dispatch_tcode_stranded_cleanup_20260831_v3
  enable row level security;

revoke all on table public.backup_dispatch_tcode_stranded_cleanup_20260831_v3
  from public, anon, authenticated;

do $dispatch_tcode_cleanup_v3_preflight$
declare
  v_expected_count integer;
  v_pool_count integer;
  v_bad_state_codes text;
  v_blocked_codes text;
  v_protected_count integer;
begin
  select count(*) into v_expected_count
  from dispatch_tcode_cleanup_v3_expected;

  if v_expected_count <> 27 then
    raise exception 'DISPATCH_TCODE_CLEANUP_V3_EXPECTED_SET_CHANGED:%',
      v_expected_count;
  end if;

  select count(*) into v_pool_count
  from dispatch_tcode_cleanup_v3_expected e
  join public.transport_code_pool p on p.code = e.code;

  if v_pool_count <> v_expected_count then
    raise exception 'DISPATCH_TCODE_CLEANUP_V3_POOL_SET_CHANGED:%',
      v_pool_count;
  end if;

  select string_agg(e.code, ',' order by e.code_n)
  into v_bad_state_codes
  from dispatch_tcode_cleanup_v3_expected e
  join public.transport_code_pool p on p.code = e.code
  where p.created_at is null
     or p.created_at < '2026-08-31 05:39:11.315839+00'::timestamptz
     or p.created_at > '2026-08-31 07:11:43.36805+00'::timestamptz
     or not (
       (lower(btrim(p.status)) = 'used' and p.owner_id = '2468')
       or
       (lower(btrim(p.status)) = 'available' and p.owner_id = 'POOL')
     );

  if v_bad_state_codes is not null then
    raise exception 'DISPATCH_TCODE_CLEANUP_V3_STATE_OR_TIME_CHANGED:%',
      v_bad_state_codes;
  end if;

  select string_agg(e.code, ',' order by e.code_n)
  into v_blocked_codes
  from dispatch_tcode_cleanup_v3_expected e
  where public.transport_tcode_has_lifecycle_reference_v2(e.code)
     or exists (
       -- Terminal lease history is also fail-closed for this incident repair.
       select 1
       from public.offline_code_leases l
       where l.scope = 'transport'
         and upper(btrim(l.code)) = e.code
     );

  if v_blocked_codes is not null then
    raise exception 'DISPATCH_TCODE_CLEANUP_V3_REFERENCE_BLOCKERS:%',
      v_blocked_codes;
  end if;

  select count(*) into v_protected_count
  from (values
    ('T1300'::text, 1300::bigint),
    ('T1311'::text, 1311::bigint),
    ('T1327'::text, 1327::bigint),
    ('T1328'::text, 1328::bigint)
  ) as protected(code, code_n)
  where exists (
      select 1
      from public.transport_code_pool p
      where p.code = protected.code
        and lower(btrim(p.status)) = 'used'
        and p.owner_id = '2468'
    )
    and (
      select count(*)
      from public.transport_clients c
      where upper(btrim(coalesce(c.tcode, ''))) = protected.code
         or c.client_code = protected.code_n
    ) = 1
    and (
      select count(*)
      from public.transport_orders o
      where upper(btrim(coalesce(o.code_str, ''))) = protected.code
         or upper(btrim(coalesce(o.client_tcode, ''))) = protected.code
         or o.code_n = protected.code_n
    ) >= 1;

  if v_protected_count <> 4 then
    raise exception 'DISPATCH_TCODE_CLEANUP_V3_PROTECTED_SET_CHANGED:%',
      v_protected_count;
  end if;
end;
$dispatch_tcode_cleanup_v3_preflight$;

insert into public.backup_dispatch_tcode_stranded_cleanup_20260831_v3(
  code,
  owner_id,
  status,
  created_at,
  reserved_at
)
select
  p.code,
  p.owner_id,
  p.status,
  p.created_at,
  p.reserved_at
from dispatch_tcode_cleanup_v3_expected e
join public.transport_code_pool p on p.code = e.code
on conflict (code) do nothing;

do $dispatch_tcode_cleanup_v3_apply$
declare
  v_backup_count integer;
  v_to_update integer;
  v_updated integer;
  v_postcheck_count integer;
  v_protected_count integer;
begin
  select count(*) into v_backup_count
  from dispatch_tcode_cleanup_v3_expected e
  join public.backup_dispatch_tcode_stranded_cleanup_20260831_v3 b
    on b.code = e.code;

  if v_backup_count <> 27 then
    raise exception 'DISPATCH_TCODE_CLEANUP_V3_BACKUP_INCOMPLETE:%',
      v_backup_count;
  end if;

  select count(*) into v_to_update
  from dispatch_tcode_cleanup_v3_expected e
  join public.transport_code_pool p on p.code = e.code
  where lower(btrim(p.status)) = 'used'
    and p.owner_id = '2468';

  update public.transport_code_pool p
  set status = 'available',
      owner_id = 'POOL',
      reserved_at = null
  from dispatch_tcode_cleanup_v3_expected e
  where p.code = e.code
    and lower(btrim(p.status)) = 'used'
    and p.owner_id = '2468'
    and p.created_at between
      '2026-08-31 05:39:11.315839+00'::timestamptz
      and '2026-08-31 07:11:43.36805+00'::timestamptz;

  get diagnostics v_updated = row_count;

  if v_updated <> v_to_update then
    raise exception 'DISPATCH_TCODE_CLEANUP_V3_UPDATE_COUNT_CHANGED:%/%',
      v_updated, v_to_update;
  end if;

  select count(*) into v_postcheck_count
  from dispatch_tcode_cleanup_v3_expected e
  join public.transport_code_pool p on p.code = e.code
  where lower(btrim(p.status)) = 'available'
    and p.owner_id = 'POOL'
    and p.reserved_at is null;

  if v_postcheck_count <> 27 then
    raise exception 'DISPATCH_TCODE_CLEANUP_V3_POSTCHECK_FAILED:%',
      v_postcheck_count;
  end if;

  select count(*) into v_protected_count
  from (values
    ('T1300'::text, 1300::bigint),
    ('T1311'::text, 1311::bigint),
    ('T1327'::text, 1327::bigint),
    ('T1328'::text, 1328::bigint)
  ) as protected(code, code_n)
  where exists (
      select 1
      from public.transport_code_pool p
      where p.code = protected.code
        and lower(btrim(p.status)) = 'used'
        and p.owner_id = '2468'
    )
    and exists (
      select 1
      from public.transport_clients c
      where upper(btrim(coalesce(c.tcode, ''))) = protected.code
         or c.client_code = protected.code_n
    )
    and exists (
      select 1
      from public.transport_orders o
      where upper(btrim(coalesce(o.code_str, ''))) = protected.code
         or upper(btrim(coalesce(o.client_tcode, ''))) = protected.code
         or o.code_n = protected.code_n
    );

  if v_protected_count <> 4 then
    raise exception 'DISPATCH_TCODE_CLEANUP_V3_PROTECTED_POSTCHECK_FAILED:%',
      v_protected_count;
  end if;
end;
$dispatch_tcode_cleanup_v3_apply$;

commit;
