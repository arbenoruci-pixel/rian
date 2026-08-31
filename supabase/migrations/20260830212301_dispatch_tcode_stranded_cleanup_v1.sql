begin;

set local lock_timeout = '15s';
set local statement_timeout = '120s';

-- A failed client-side verification loop reserved one T-code per tap while no
-- client/order was created. This repair is intentionally limited to the exact
-- live-audited incident range. Three codes in the same range completed normally
-- and are protected below: T1237, T1267 and T1279.

-- Serialize with both the legacy allocator and the new atomic create path.
select pg_advisory_xact_lock(
  hashtextextended('transport-code-allocator-v3', 0)
);

-- Keep the reference audit and pool update on one stable snapshot. Reads remain
-- available while these short-lived locks block competing lifecycle writes.
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

create temporary table dispatch_tcode_cleanup_expected (
  code text primary key,
  code_n bigint not null unique
) on commit drop;

insert into dispatch_tcode_cleanup_expected(code, code_n)
select 'T' || n::text, n
from generate_series(1233::bigint, 1288::bigint) as n
where n not in (1237, 1267, 1279);

create table if not exists public.backup_dispatch_tcode_stranded_cleanup_20260830_v1 (
  code text primary key,
  owner_id text,
  status text,
  created_at timestamptz,
  backed_up_at timestamptz not null default now()
);

alter table public.backup_dispatch_tcode_stranded_cleanup_20260830_v1
  enable row level security;

revoke all on table public.backup_dispatch_tcode_stranded_cleanup_20260830_v1
  from public, anon, authenticated;

do $$
declare
  v_expected_count integer;
  v_pool_count integer;
  v_bad_state_codes text;
  v_blocked_codes text;
  v_protected_count integer;
begin
  select count(*) into v_expected_count
  from dispatch_tcode_cleanup_expected;

  if v_expected_count <> 53 then
    raise exception 'DISPATCH_TCODE_CLEANUP_EXPECTED_SET_CHANGED:%', v_expected_count;
  end if;

  select count(*) into v_pool_count
  from dispatch_tcode_cleanup_expected e
  join public.transport_code_pool p
    on upper(btrim(p.code)) = e.code;

  if v_pool_count <> 53 then
    raise exception 'DISPATCH_TCODE_CLEANUP_POOL_SET_CHANGED:%', v_pool_count;
  end if;

  select string_agg(e.code, ',' order by e.code_n)
  into v_bad_state_codes
  from dispatch_tcode_cleanup_expected e
  join public.transport_code_pool p
    on upper(btrim(p.code)) = e.code
  where p.created_at is null
     or p.created_at < '2026-08-30 20:39:29.378363+00'::timestamptz
     or p.created_at > '2026-08-30 21:09:23.234633+00'::timestamptz
     or not (
       (lower(btrim(p.status)) = 'used' and p.owner_id = '2468')
       or
       (lower(btrim(p.status)) = 'available' and p.owner_id = 'POOL')
     );

  if v_bad_state_codes is not null then
    raise exception 'DISPATCH_TCODE_CLEANUP_STATE_OR_TIME_CHANGED:%', v_bad_state_codes;
  end if;

  select string_agg(e.code, ',' order by e.code_n)
  into v_blocked_codes
  from dispatch_tcode_cleanup_expected e
  where exists (
      select 1
      from public.transport_clients c
      where upper(btrim(coalesce(c.tcode, ''))) = e.code
         or c.client_code = e.code_n
    )
    or exists (
      select 1
      from public.transport_orders o
      where upper(btrim(coalesce(o.code_str, ''))) = e.code
         or upper(btrim(coalesce(o.client_tcode, ''))) = e.code
         or o.code_n = e.code_n
         or upper(btrim(coalesce(o.data->>'code_str', ''))) = e.code
         or upper(btrim(coalesce(o.data->>'official_order_code', ''))) = e.code
         or upper(btrim(coalesce(o.data->>'order_code', ''))) in (e.code, e.code_n::text)
         or upper(btrim(coalesce(o.data->>'order_tcode', ''))) = e.code
         or upper(btrim(coalesce(o.data->>'client_tcode', ''))) = e.code
         or upper(btrim(coalesce(o.data->>'code', ''))) in (e.code, e.code_n::text)
         or upper(btrim(coalesce(o.data->>'transport_client_tcode', ''))) = e.code
         or upper(btrim(coalesce(o.data->>'legacy_order_code', ''))) in (e.code, e.code_n::text)
         or upper(btrim(coalesce(o.data->>'legacy_client_tcode', ''))) = e.code
         or upper(btrim(coalesce(o.data->>'linked_client_code', ''))) in (e.code, e.code_n::text)
         or upper(btrim(coalesce(o.data->'client'->>'tcode', ''))) = e.code
         or upper(btrim(coalesce(o.data->'client'->>'code_str', ''))) = e.code
         or upper(btrim(coalesce(o.data->'client'->>'code', ''))) in (e.code, e.code_n::text)
         or upper(btrim(coalesce(o.data->'client'->>'order_code', ''))) in (e.code, e.code_n::text)
         or upper(btrim(coalesce(o.data->'client'->>'official_order_code', ''))) = e.code
         or upper(btrim(coalesce(o.data->'client'->>'order_tcode', ''))) = e.code
         or upper(btrim(coalesce(o.data->'client'->>'client_tcode', ''))) = e.code
         or upper(btrim(coalesce(o.data->'client'->>'transport_client_tcode', ''))) = e.code
    )
    -- Any lease history is treated as a blocker, including terminal leases.
    or exists (
      select 1
      from public.offline_code_leases l
      where l.scope = 'transport'
        and upper(btrim(l.code)) = e.code
    )
    or exists (
      select 1
      from public.arka_pending_payments ap
      where (
          upper(coalesce(ap.type, '')) = 'TRANSPORT'
          or upper(coalesce(ap.source_module, '')) = 'TRANSPORT'
        )
        and (
          upper(btrim(coalesce(ap.transport_code_str, ''))) = e.code
          or ap.order_code = e.code_n
        )
    )
    or exists (
      select 1
      from public.cash_handoff_items hi
      where upper(coalesce(hi.source_module, '')) = 'TRANSPORT'
        and (
          upper(btrim(coalesce(hi.transport_code_str, ''))) = e.code
          or hi.order_code = e.code_n
        )
    )
    or exists (
      select 1
      from public.arka_payment_exclusions pe
      where (
          upper(coalesce(pe.type_snapshot, '')) = 'TRANSPORT'
          or upper(coalesce(pe.source_module_snapshot, '')) = 'TRANSPORT'
        )
        and (
          upper(btrim(coalesce(pe.transport_code_snapshot, ''))) = e.code
          or upper(btrim(coalesce(pe.order_code_snapshot, ''))) in (e.code, e.code_n::text)
        )
    )
    or exists (
      select 1
      from public.transport_client_debts d
      where upper(btrim(coalesce(d.client_tcode, ''))) = e.code
    )
    or exists (
      select 1
      from public.transport_receivables r
      where upper(btrim(coalesce(r.client_tcode, ''))) = e.code
    )
    or exists (
      select 1
      from public.dispatch_tasks t
      where upper(btrim(coalesce(t.code, ''))) = e.code
    )
    or exists (
      select 1
      from public.transport_order_measurement_audit a
      where upper(btrim(coalesce(a.code_str, ''))) = e.code
    )
    or exists (
      select 1
      from public.transport_keep_one k
      where upper(btrim(coalesce(k.code_str, ''))) = e.code
         or upper(btrim(coalesce(k.client_tcode, ''))) = e.code
         or k.code_n = e.code_n
         or exists (
           select 1
           from jsonb_each_text(
             case
               when jsonb_typeof(k.data) = 'object' then k.data
               else '{}'::jsonb
             end
           ) as value_pair(key, value)
           where upper(btrim(value_pair.value)) in (e.code, e.code_n::text)
         )
    );

  if v_blocked_codes is not null then
    raise exception 'DISPATCH_TCODE_CLEANUP_REFERENCE_BLOCKERS:%', v_blocked_codes;
  end if;

  select count(*) into v_protected_count
  from (values
    ('T1237'::text, 1237::bigint),
    ('T1267'::text, 1267::bigint),
    ('T1279'::text, 1279::bigint)
  ) as protected(code, code_n)
  where exists (
      select 1
      from public.transport_code_pool p
      where upper(btrim(p.code)) = protected.code
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

  if v_protected_count <> 3 then
    raise exception 'DISPATCH_TCODE_CLEANUP_PROTECTED_SET_CHANGED:%', v_protected_count;
  end if;
end;
$$;

insert into public.backup_dispatch_tcode_stranded_cleanup_20260830_v1(
  code,
  owner_id,
  status,
  created_at
)
select
  upper(btrim(p.code)),
  p.owner_id,
  p.status,
  p.created_at
from dispatch_tcode_cleanup_expected e
join public.transport_code_pool p
  on upper(btrim(p.code)) = e.code
on conflict (code) do nothing;

do $$
declare
  v_backup_count integer;
  v_to_update integer;
  v_updated integer;
  v_postcheck_count integer;
  v_protected_count integer;
begin
  select count(*) into v_backup_count
  from dispatch_tcode_cleanup_expected e
  join public.backup_dispatch_tcode_stranded_cleanup_20260830_v1 b
    on upper(btrim(b.code)) = e.code;

  if v_backup_count <> 53 then
    raise exception 'DISPATCH_TCODE_CLEANUP_BACKUP_INCOMPLETE:%', v_backup_count;
  end if;

  select count(*) into v_to_update
  from dispatch_tcode_cleanup_expected e
  join public.transport_code_pool p
    on upper(btrim(p.code)) = e.code
  where lower(btrim(p.status)) = 'used'
    and p.owner_id = '2468';

  update public.transport_code_pool p
  set status = 'available',
      owner_id = 'POOL'
  from dispatch_tcode_cleanup_expected e
  where upper(btrim(p.code)) = e.code
    and lower(btrim(p.status)) = 'used'
    and p.owner_id = '2468'
    and p.created_at between
      '2026-08-30 20:39:29.378363+00'::timestamptz
      and '2026-08-30 21:09:23.234633+00'::timestamptz;

  get diagnostics v_updated = row_count;

  if v_updated <> v_to_update then
    raise exception 'DISPATCH_TCODE_CLEANUP_UPDATE_COUNT_CHANGED:%/%', v_updated, v_to_update;
  end if;

  select count(*) into v_postcheck_count
  from dispatch_tcode_cleanup_expected e
  join public.transport_code_pool p
    on upper(btrim(p.code)) = e.code
  where lower(btrim(p.status)) = 'available'
    and p.owner_id = 'POOL';

  if v_postcheck_count <> 53 then
    raise exception 'DISPATCH_TCODE_CLEANUP_POSTCHECK_FAILED:%', v_postcheck_count;
  end if;

  select count(*) into v_protected_count
  from (values
    ('T1237'::text, 1237::bigint),
    ('T1267'::text, 1267::bigint),
    ('T1279'::text, 1279::bigint)
  ) as protected(code, code_n)
  where exists (
      select 1
      from public.transport_code_pool p
      where upper(btrim(p.code)) = protected.code
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

  if v_protected_count <> 3 then
    raise exception 'DISPATCH_TCODE_CLEANUP_PROTECTED_POSTCHECK_FAILED:%', v_protected_count;
  end if;
end;
$$;

commit;
