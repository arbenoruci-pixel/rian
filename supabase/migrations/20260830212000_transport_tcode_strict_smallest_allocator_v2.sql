begin;

set local lock_timeout = '15s';
set local statement_timeout = '120s';

-- Drain the preceding allocator before snapshotting the legacy sequence and
-- replacing its function. New calls use this same transaction-level lock.
select pg_advisory_xact_lock(
  hashtextextended('transport-code-allocator-v3', 0)
);

-- STRICT_SMALLEST_TRANSPORT_TCODE_V2
--
-- A code is reusable only when the pool explicitly marks it available and no
-- active offline lease or persisted transport lifecycle record references it.
-- Historical numeric gaps and unexplained `used` rows stay closed. When the
-- available pool is empty, a transactional cursor (seeded once from the legacy
-- sequence) finds the first genuinely fresh value. The allocator-wide
-- transaction lock serializes online, atomic-Dispatch and offline-bank claims.

alter table public.transport_code_pool
  add column if not exists reserved_at timestamptz;

create or replace function public.transport_code_pool_reserved_at_guard_v2()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.status = 'available' then
    new.reserved_at := null;
  elsif new.status = 'used' and new.reserved_at is null then
    if tg_op = 'INSERT' then
      new.reserved_at := now();
    elsif old.status is distinct from 'used' then
      new.reserved_at := now();
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_transport_code_pool_reserved_at_guard_v2
  on public.transport_code_pool;
create trigger trg_transport_code_pool_reserved_at_guard_v2
before insert or update of status, reserved_at
on public.transport_code_pool
for each row execute function public.transport_code_pool_reserved_at_guard_v2();

revoke all on function public.transport_code_pool_reserved_at_guard_v2()
  from public, anon, authenticated;
grant execute on function public.transport_code_pool_reserved_at_guard_v2()
  to service_role;

-- Cached PWAs still verify a server reservation by reading this table. Keep
-- that read path, while routing every state change through the guarded RPCs.
alter table public.transport_code_pool enable row level security;

drop policy if exists transport_code_pool_read_v2
  on public.transport_code_pool;
create policy transport_code_pool_read_v2
  on public.transport_code_pool
  for select
  to anon, authenticated
  using (true);

revoke all on table public.transport_code_pool
  from public, anon, authenticated;
grant select on table public.transport_code_pool
  to anon, authenticated;

-- Parse a transport code without ever casting attacker-controlled or corrupt
-- unbounded text. The bigint boundary is checked as text before the cast.
create or replace function public.transport_tcode_number_v2(p_code text)
returns bigint
language plpgsql
immutable
parallel safe
security invoker
set search_path = ''
as $$
declare
  v_code text := pg_catalog.upper(pg_catalog.btrim(coalesce(p_code, '')));
  v_digits text;
  v_number bigint;
begin
  if v_code !~ '^T[0-9]+$' then
    return null;
  end if;

  v_digits := pg_catalog.ltrim(pg_catalog.substr(v_code, 2), '0');
  if v_digits = ''
     or pg_catalog.length(v_digits) > 19
     or (
       pg_catalog.length(v_digits) = 19
       and v_digits collate "C" > '9223372036854775807' collate "C"
     )
  then
    return null;
  end if;

  v_number := v_digits::bigint;
  if v_number <= 0 then
    return null;
  end if;
  return v_number;
end;
$$;

revoke all on function public.transport_tcode_number_v2(text)
  from public, anon, authenticated;
grant execute on function public.transport_tcode_number_v2(text)
  to service_role;

-- Live preflight is expected to be clean. Stop the migration if a malformed
-- historical code exists so it can be audited instead of silently normalized.
do $transport_code_canonical_preflight$
declare
  v_bad_pool_count bigint;
  v_bad_lease_count bigint;
begin
  select count(*)
  into v_bad_pool_count
  from public.transport_code_pool p
  where public.transport_tcode_number_v2(p.code) is null
     or p.code <> 'T' || public.transport_tcode_number_v2(p.code)::text;

  select count(*)
  into v_bad_lease_count
  from public.offline_code_leases l
  where l.scope = 'transport'
    and (
      public.transport_tcode_number_v2(l.code) is null
      or l.code <> 'T' || public.transport_tcode_number_v2(l.code)::text
    );

  if v_bad_pool_count <> 0 or v_bad_lease_count <> 0 then
    raise exception using
      errcode = '23514',
      message = 'TRANSPORT_TCODE_CANONICAL_PREFLIGHT_FAILED',
      detail = pg_catalog.format(
        'pool=%s transport_leases=%s',
        v_bad_pool_count,
        v_bad_lease_count
      );
  end if;
end;
$transport_code_canonical_preflight$;

alter table public.transport_code_pool
  drop constraint if exists transport_code_pool_code_canonical_v2_chk;
alter table public.transport_code_pool
  add constraint transport_code_pool_code_canonical_v2_chk check (
    public.transport_tcode_number_v2(code) is not null
    and code = 'T' || public.transport_tcode_number_v2(code)::text
  );

alter table public.offline_code_leases
  drop constraint if exists offline_transport_code_canonical_v2_chk;
alter table public.offline_code_leases
  add constraint offline_transport_code_canonical_v2_chk check (
    scope <> 'transport'
    or (
      public.transport_tcode_number_v2(code) is not null
      and code = 'T' || public.transport_tcode_number_v2(code)::text
    )
  );

-- Sequences do not roll back. A failed atomic order after nextval() therefore
-- burned a fresh T-code. This singleton cursor advances in the same transaction
-- as the pool/order insert, so a rollback makes the exact number retryable.
create table if not exists public.transport_code_allocator_state_v2 (
  singleton boolean primary key default true check (singleton),
  next_fresh bigint not null check (next_fresh > 0),
  exhausted boolean not null default false,
  updated_at timestamptz not null default now()
);

alter table public.transport_code_allocator_state_v2 enable row level security;
revoke all on table public.transport_code_allocator_state_v2
  from public, anon, authenticated, service_role;
grant select on table public.transport_code_allocator_state_v2 to service_role;

do $transport_code_cursor_seed$
declare
  v_last_value bigint;
  v_is_called boolean;
  v_next_fresh bigint;
  v_exhausted boolean := false;
  v_increment_by bigint;
  v_min_value bigint;
  v_max_value bigint;
  v_cache_size bigint;
  v_cycle boolean;
begin
  select
    s.increment_by,
    s.min_value,
    s.max_value,
    s.cache_size,
    s.cycle
  into
    v_increment_by,
    v_min_value,
    v_max_value,
    v_cache_size,
    v_cycle
  from pg_catalog.pg_sequences s
  where s.schemaname = 'public'
    and s.sequencename = 'transport_codes_seq';

  if not found
     or v_increment_by <> 1
     or v_min_value < 1
     or v_max_value <> 9223372036854775807
     or v_cache_size <> 1
     or v_cycle
  then
    raise exception using
      errcode = '55000',
      message = 'TRANSPORT_CODE_SEQUENCE_CONFIG_UNSAFE';
  end if;

  select s.last_value, s.is_called
  into v_last_value, v_is_called
  from public.transport_codes_seq s;

  if not found
     or v_last_value < v_min_value
     or v_last_value > v_max_value
     or v_is_called is null
  then
    raise exception using
      errcode = '55000',
      message = 'TRANSPORT_CODE_SEQUENCE_STATE_UNSAFE';
  end if;

  v_next_fresh := case
    when v_is_called and v_last_value < 9223372036854775807
      then v_last_value + 1
    else v_last_value
  end;
  v_exhausted := v_is_called and v_last_value = 9223372036854775807;

  if v_next_fresh <= 0 then
    raise exception using
      errcode = '22003',
      message = 'TRANSPORT_CODE_CURSOR_SEED_INVALID';
  end if;

  insert into public.transport_code_allocator_state_v2(
    singleton,
    next_fresh,
    exhausted,
    updated_at
  ) values (
    true,
    v_next_fresh,
    v_exhausted,
    now()
  )
  on conflict (singleton) do nothing;
end;
$transport_code_cursor_seed$;

-- The sequence is now a read-only legacy seed. No app role needs direct access
-- after cutover, and every allocation goes through the transactional cursor.
revoke all on sequence public.transport_codes_seq
  from public, anon, authenticated, service_role;

-- The legacy offline API accepts PIN, UUID, transport_id, tid and the bridged
-- MAIN_*_<PIN> form. Resolve those aliases to one quota/lock key, while keeping
-- the caller's raw owner on the lease so cached bind/finalize calls remain
-- compatible. Ambiguous identities fail closed instead of sharing a code bank.
create or replace function public.transport_offline_owner_quota_key_v2(
  p_owner_id text
)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_owner text := pg_catalog.btrim(coalesce(p_owner_id, ''));
  v_trailing_pin text := '';
  v_match_count bigint := 0;
  v_user_id text;
begin
  if v_owner = '' or pg_catalog.length(v_owner) > 160 then
    raise exception using
      errcode = '22023',
      message = 'OFFLINE_BANK_OWNER_INVALID';
  end if;

  if v_owner ~ '^MAIN_[A-Za-z0-9_:-]+_[0-9]{3,12}$' then
    v_trailing_pin := pg_catalog.regexp_replace(
      v_owner,
      '^.*_([0-9]{3,12})$',
      '\1'
    );
  end if;

  select pg_catalog.count(distinct u.id), pg_catalog.min(u.id::text)
  into v_match_count, v_user_id
  from public.users u
  where coalesce(u.is_active, true)
    and (
      u.id::text = v_owner
      or coalesce(u.transport_id::text, '') = v_owner
      or coalesce(u.tid::text, '') = v_owner
      or pg_catalog.btrim(coalesce(u.pin::text, '')) = v_owner
      or (
        v_trailing_pin <> ''
        and pg_catalog.btrim(coalesce(u.pin::text, '')) = v_trailing_pin
      )
    );

  if v_match_count > 1 then
    raise exception using
      errcode = '21000',
      message = 'OFFLINE_BANK_OWNER_IDENTITY_AMBIGUOUS';
  end if;
  if v_match_count = 1 then
    return 'users:' || v_user_id;
  end if;

  -- A validator-only alias that cannot be tied to one active canonical user
  -- cannot safely share the per-person cap with its other possible aliases.
  raise exception using
    errcode = 'P0001',
    message = 'OFFLINE_BANK_OWNER_IDENTITY_UNRESOLVED';
end;
$$;

revoke all on function public.transport_offline_owner_quota_key_v2(text)
  from public, anon, authenticated;
grant execute on function public.transport_offline_owner_quota_key_v2(text)
  to service_role;

create or replace function public.transport_tcode_has_lifecycle_reference_v2(
  p_code text,
  p_ignored_active_lease_owner text default null
)
returns boolean
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_code text;
  v_code_n bigint;
begin
  v_code_n := public.transport_tcode_number_v2(p_code);
  if v_code_n is null then
    return true;
  end if;
  v_code := 'T' || v_code_n::text;

  return
    exists (
      select 1
      from public.offline_code_leases l
      where l.scope = 'transport'
        and upper(btrim(l.code)) = v_code
        and l.status in ('available', 'assigned')
        and l.expires_at > now()
        and (
          p_ignored_active_lease_owner is null
          or l.owner_id <> p_ignored_active_lease_owner
        )
    )
    or exists (
      select 1
      from public.transport_clients c
      where upper(btrim(coalesce(c.tcode, ''))) = v_code
         or c.client_code = v_code_n
    )
    or exists (
      select 1
      from public.transport_orders o
      where upper(btrim(coalesce(o.code_str, ''))) = v_code
         or o.code_n = v_code_n
         or upper(btrim(coalesce(o.client_tcode, ''))) = v_code
         or upper(btrim(coalesce(o.data->>'code_str', ''))) = v_code
         or upper(btrim(coalesce(o.data->>'official_order_code', ''))) = v_code
         or upper(btrim(coalesce(o.data->>'order_code', ''))) in (v_code, v_code_n::text)
         or upper(btrim(coalesce(o.data->>'order_tcode', ''))) = v_code
         or upper(btrim(coalesce(o.data->>'client_tcode', ''))) = v_code
         or upper(btrim(coalesce(o.data->>'code', ''))) in (v_code, v_code_n::text)
         or upper(btrim(coalesce(o.data->>'transport_client_tcode', ''))) = v_code
         or upper(btrim(coalesce(o.data->>'legacy_order_code', ''))) in (v_code, v_code_n::text)
         or upper(btrim(coalesce(o.data->>'legacy_client_tcode', ''))) = v_code
         or upper(btrim(coalesce(o.data->>'linked_client_code', ''))) in (v_code, v_code_n::text)
         or upper(btrim(coalesce(o.data->'client'->>'tcode', ''))) = v_code
         or upper(btrim(coalesce(o.data->'client'->>'code_str', ''))) = v_code
         or upper(btrim(coalesce(o.data->'client'->>'code', ''))) in (v_code, v_code_n::text)
         or upper(btrim(coalesce(o.data->'client'->>'order_code', ''))) in (v_code, v_code_n::text)
         or upper(btrim(coalesce(o.data->'client'->>'official_order_code', ''))) = v_code
         or upper(btrim(coalesce(o.data->'client'->>'order_tcode', ''))) = v_code
         or upper(btrim(coalesce(o.data->'client'->>'client_tcode', ''))) = v_code
         or upper(btrim(coalesce(o.data->'client'->>'transport_client_tcode', ''))) = v_code
    )
    or exists (
      select 1
      from public.arka_pending_payments ap
      where (
          upper(coalesce(ap.type, '')) = 'TRANSPORT'
          or upper(coalesce(ap.source_module, '')) = 'TRANSPORT'
        )
        and (
          upper(btrim(coalesce(ap.transport_code_str, ''))) = v_code
          or ap.order_code = v_code_n
        )
    )
    or exists (
      select 1
      from public.cash_handoff_items hi
      where upper(coalesce(hi.source_module, '')) = 'TRANSPORT'
        and (
          upper(btrim(coalesce(hi.transport_code_str, ''))) = v_code
          or hi.order_code = v_code_n
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
          upper(btrim(coalesce(pe.transport_code_snapshot, ''))) = v_code
          or upper(btrim(coalesce(pe.order_code_snapshot, ''))) in (v_code, v_code_n::text)
        )
    )
    or exists (
      select 1
      from public.transport_client_debts d
      where upper(btrim(coalesce(d.client_tcode, ''))) = v_code
    )
    or exists (
      select 1
      from public.transport_receivables r
      where upper(btrim(coalesce(r.client_tcode, ''))) = v_code
    )
    or exists (
      select 1
      from public.dispatch_tasks t
      where upper(btrim(coalesce(t.code, ''))) = v_code
    )
    or exists (
      select 1
      from public.transport_order_measurement_audit a
      where upper(btrim(coalesce(a.code_str, ''))) = v_code
    )
    or exists (
      select 1
      from public.transport_keep_one k
      where upper(btrim(coalesce(k.code_str, ''))) = v_code
         or upper(btrim(coalesce(k.client_tcode, ''))) = v_code
         or k.code_n = v_code_n
         or exists (
           select 1
           from jsonb_each_text(
             case
               when jsonb_typeof(k.data) = 'object' then k.data
               else '{}'::jsonb
             end
           ) as value_pair(key, value)
           where upper(btrim(value_pair.value)) in (v_code, v_code_n::text)
         )
    );
end;
$$;

revoke all on function public.transport_tcode_has_lifecycle_reference_v2(text, text)
  from public, anon, authenticated;
grant execute on function public.transport_tcode_has_lifecycle_reference_v2(text, text)
  to service_role;

-- All release callers use one outer per-code lock before the historical
-- release advisory, lease row and pool row. This removes the lease/pool lock
-- inversion between finalize, direct release and offline expiry reconciliation.
create or replace function public.release_transport_code_if_unused(
  p_code text,
  p_owner_id text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_code text;
  v_code_n bigint;
  v_active_lease_owner text;
begin
  v_code_n := public.transport_tcode_number_v2(p_code);
  if v_code_n is null then
    return false;
  end if;
  v_code := 'T' || v_code_n::text;

  perform pg_advisory_xact_lock(
    hashtextextended('offline-bank:transport-code:' || v_code, 0)
  );
  perform pg_advisory_xact_lock(
    hashtextextended('transport-code-release:' || v_code, 0)
  );

  select l.owner_id
  into v_active_lease_owner
  from public.offline_code_leases l
  where l.scope = 'transport'
    and l.code = v_code
    and l.status in ('available', 'assigned')
    and l.expires_at > now()
  order by l.reserved_at desc
  limit 1
  for update;

  if v_active_lease_owner is not null
     and (
       p_owner_id is null
       or btrim(p_owner_id) <> v_active_lease_owner
     )
  then
    return false;
  end if;

  if public.transport_tcode_has_lifecycle_reference_v2(
    v_code,
    v_active_lease_owner
  ) then
    return false;
  end if;

  update public.transport_code_pool p
  set status = 'available',
      owner_id = 'POOL',
      reserved_at = null
  where p.code = v_code
    and p.status = 'used'
    and (
      (
        v_active_lease_owner is not null
        and p.owner_id = v_active_lease_owner
      )
      or (
        v_active_lease_owner is null
        and (
          p_owner_id is null
          or p.owner_id = btrim(p_owner_id)
          or p.owner_id like 'DISPATCH_HOLD_%'
        )
      )
    );

  if not found then
    return false;
  end if;

  update public.offline_code_leases l
  set status = 'released',
      released_at = coalesce(l.released_at, now()),
      updated_at = now(),
      metadata = coalesce(l.metadata, '{}'::jsonb)
        || jsonb_build_object(
          'release_reason',
          'release_transport_code_if_unused'
        )
  where l.scope = 'transport'
    and l.code = v_code
    and l.status in ('available', 'assigned')
    and (
      p_owner_id is null
      or l.owner_id = btrim(p_owner_id)
    );

  return true;
end;
$$;

revoke all on function public.release_transport_code_if_unused(text, text)
  from public, anon, authenticated;
grant execute on function public.release_transport_code_if_unused(text, text)
  to anon, authenticated, service_role;

-- The legacy transport-order triggers previously locked a lease row before
-- entering the release advisory. Expiry reconciliation takes the advisory
-- first, so the opposite order could deadlock. Both triggers now discover a
-- candidate without a row lock, take the canonical per-code locks, then recheck
-- and lock that exact lease.
create or replace function public.offline_transport_code_lease_before_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_data jsonb := coalesce(new.data, '{}'::jsonb);
  v_draft text := coalesce(
    nullif(btrim(v_data->>'local_oid'), ''),
    nullif(btrim(v_data->>'order_id'), ''),
    nullif(btrim(v_data->>'public_order_id'), ''),
    new.id::text
  );
  v_code_str text := upper(btrim(coalesce(new.code_str, '')));
  v_client_tcode text := upper(btrim(coalesce(new.client_tcode, '')));
  v_transport_id text := nullif(btrim(v_data->>'transport_id'), '');
  v_transport_pin text := nullif(btrim(v_data->>'transport_pin'), '');
  v_driver_pin text := nullif(btrim(v_data->>'driver_pin'), '');
  v_created_pin text := nullif(btrim(v_data->>'created_by_pin'), '');
  v_candidate_token uuid;
  v_candidate_code text;
  v_candidate_code_n bigint;
  v_lease public.offline_code_leases%rowtype;
begin
  if v_draft is null then
    return new;
  end if;

  select l.lease_token, l.code
  into v_candidate_token, v_candidate_code
  from public.offline_code_leases l
  where l.scope = 'transport'
    and (
      upper(l.code) = v_code_str
      or upper(l.code) = v_client_tcode
      or l.draft_session_id = v_draft
    )
    and (
      l.status in ('available', 'assigned')
      or (
        l.status in ('consumed', 'released')
        and l.draft_session_id = v_draft
      )
    )
  order by
    case when l.draft_session_id = v_draft then 0 else 1 end,
    l.reserved_at desc
  limit 1;

  if not found then
    return new;
  end if;

  v_candidate_code := upper(btrim(coalesce(v_candidate_code, '')));
  v_candidate_code_n := public.transport_tcode_number_v2(v_candidate_code);
  if v_candidate_code_n is null
     or v_candidate_code <> 'T' || v_candidate_code_n::text
  then
    raise exception using
      errcode = '23514',
      message = 'OFFLINE_TRANSPORT_CODE_LEASE_NONCANONICAL';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'offline-bank:transport-code:' || v_candidate_code,
      0
    )
  );
  perform pg_advisory_xact_lock(
    hashtextextended('transport-code-release:' || v_candidate_code, 0)
  );

  select l.*
  into v_lease
  from public.offline_code_leases l
  where l.lease_token = v_candidate_token
    and l.scope = 'transport'
    and (
      upper(l.code) = v_code_str
      or upper(l.code) = v_client_tcode
      or l.draft_session_id = v_draft
    )
    and (
      l.status in ('available', 'assigned')
      or (
        l.status in ('consumed', 'released')
        and l.draft_session_id = v_draft
      )
    )
  for update;

  if not found then
    return new;
  end if;
  if upper(btrim(v_lease.code)) <> v_candidate_code then
    raise exception using
      errcode = '40001',
      message = 'OFFLINE_TRANSPORT_CODE_LEASE_CHANGED';
  end if;
  if v_lease.status in ('consumed', 'released') then
    return new;
  end if;
  if v_lease.expires_at <= now() then
    raise exception using
      errcode = 'P0001',
      message = 'OFFLINE_TRANSPORT_CODE_LEASE_EXPIRED';
  end if;
  if not (
    v_lease.owner_id = coalesce(v_transport_id, '')
    or v_lease.owner_id = coalesce(v_transport_pin, '')
    or v_lease.owner_id = coalesce(v_driver_pin, '')
    or v_lease.owner_id = coalesce(v_created_pin, '')
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'OFFLINE_TRANSPORT_CODE_LEASE_OWNER_MISMATCH';
  end if;
  if v_lease.status = 'assigned'
     and coalesce(v_lease.draft_session_id, '') <> v_draft
  then
    raise exception using
      errcode = 'P0001',
      message = 'OFFLINE_TRANSPORT_CODE_LEASE_DRAFT_CONFLICT';
  end if;

  if not exists (
    select 1
    from public.transport_code_pool p
    where p.code = v_candidate_code
      and p.status = 'used'
      and p.owner_id = v_lease.owner_id
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'OFFLINE_TRANSPORT_CODE_POOL_LEASE_IDENTITY_MISMATCH';
  end if;

  update public.offline_code_leases l
  set status = 'assigned',
      draft_session_id = v_draft,
      assigned_at = coalesce(l.assigned_at, now()),
      updated_at = now()
  where l.lease_token = v_lease.lease_token;

  v_data := v_data - 'offline_code_lease';
  v_data := v_data || jsonb_build_object(
    'offline_code_bank', true,
    'offline_code_scope', 'transport',
    'offline_code_owner_id', v_lease.owner_id,
    'offline_code_device_id', v_lease.device_id,
    'offline_code_bound_at', now()
  );
  new.data := v_data;
  return new;
end;
$$;

create or replace function public.offline_transport_code_lease_after_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_data jsonb := coalesce(new.data, '{}'::jsonb);
  v_draft text := coalesce(
    nullif(btrim(v_data->>'local_oid'), ''),
    nullif(btrim(v_data->>'order_id'), ''),
    nullif(btrim(v_data->>'public_order_id'), ''),
    new.id::text
  );
  v_code_str text := upper(btrim(coalesce(new.code_str, '')));
  v_client_tcode text := upper(btrim(coalesce(new.client_tcode, '')));
  v_candidate_token uuid;
  v_candidate_code text;
  v_candidate_code_n bigint;
  v_lease public.offline_code_leases%rowtype;
  v_released boolean := false;
begin
  if v_draft is null then
    return new;
  end if;

  select l.lease_token, l.code
  into v_candidate_token, v_candidate_code
  from public.offline_code_leases l
  where l.scope = 'transport'
    and l.draft_session_id = v_draft
    and l.status in ('assigned', 'consumed', 'released')
  order by l.reserved_at desc
  limit 1;

  if not found then
    return new;
  end if;

  v_candidate_code := upper(btrim(coalesce(v_candidate_code, '')));
  v_candidate_code_n := public.transport_tcode_number_v2(v_candidate_code);
  if v_candidate_code_n is null
     or v_candidate_code <> 'T' || v_candidate_code_n::text
  then
    raise exception using
      errcode = '23514',
      message = 'OFFLINE_TRANSPORT_CODE_LEASE_NONCANONICAL';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'offline-bank:transport-code:' || v_candidate_code,
      0
    )
  );
  perform pg_advisory_xact_lock(
    hashtextextended('transport-code-release:' || v_candidate_code, 0)
  );

  select l.*
  into v_lease
  from public.offline_code_leases l
  where l.lease_token = v_candidate_token
    and l.scope = 'transport'
    and l.draft_session_id = v_draft
    and l.status in ('assigned', 'consumed', 'released')
  for update;

  if not found or v_lease.status in ('consumed', 'released') then
    return new;
  end if;
  if upper(btrim(v_lease.code)) <> v_candidate_code then
    raise exception using
      errcode = '40001',
      message = 'OFFLINE_TRANSPORT_CODE_LEASE_CHANGED';
  end if;

  if v_client_tcode = v_candidate_code then
    update public.offline_code_leases l
    set status = 'consumed',
        consumed_at = coalesce(l.consumed_at, now()),
        order_id = new.id::text,
        updated_at = now(),
        metadata = l.metadata || jsonb_build_object(
          'finalized_by', 'transport_orders_trigger',
          'final_code', v_client_tcode
        )
    where l.lease_token = v_lease.lease_token;
    return new;
  end if;

  if v_code_str <> v_candidate_code
     and v_client_tcode <> v_candidate_code
  then
    v_released := public.release_transport_code_if_unused(
      v_candidate_code,
      v_lease.owner_id
    );
    if not v_released then
      raise exception using
        errcode = 'P0001',
        message = 'OFFLINE_TRANSPORT_SUPERSEDED_CODE_RELEASE_FAILED';
    end if;

    update public.offline_code_leases l
    set status = 'released',
        released_at = coalesce(l.released_at, now()),
        order_id = new.id::text,
        updated_at = now(),
        metadata = l.metadata || jsonb_build_object(
          'finalized_by', 'transport_orders_trigger',
          'final_code', v_client_tcode,
          'superseded_code', v_candidate_code,
          'release_reason', 'existing_client_code_won'
        )
    where l.lease_token = v_lease.lease_token;
  end if;

  return new;
end;
$$;

revoke all on function public.offline_transport_code_lease_before_write()
  from public, anon, authenticated;
revoke all on function public.offline_transport_code_lease_after_write()
  from public, anon, authenticated;
grant execute on function public.offline_transport_code_lease_before_write()
  to service_role;
grant execute on function public.offline_transport_code_lease_after_write()
  to service_role;

create or replace function public.reserve_transport_codes_batch(
  p_owner_id text,
  p_n integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner text := coalesce(nullif(btrim(p_owner_id), ''), 'UNKNOWN_USER');
  -- The public legacy signature is intentionally one-code-only. Without an
  -- immutable request id, a multi-code response cannot be retried safely.
  v_wanted constant integer := 1;
  v_codes text[] := array[]::text[];
  v_pool_code text;
  v_pool_code_n bigint;
  v_code text;
  v_candidate text;
  v_fresh_n bigint;
  v_cursor_exhausted boolean;
  v_guard integer;
begin
  -- Every allocator that can claim a transport pool row takes this same lock.
  -- Waiting for the candidate row preserves strict numeric ordering.
  perform pg_advisory_xact_lock(
    hashtextextended('transport-code-allocator-v3', 0)
  );

  while coalesce(array_length(v_codes, 1), 0) < v_wanted loop
    v_pool_code := null;
    v_pool_code_n := null;
    v_fresh_n := null;
    v_candidate := null;
    v_guard := 0;

    -- Find the first safe number at/after the transactional fresh frontier.
    -- Collision skips also roll back if the surrounding order fails.
    loop
      v_guard := v_guard + 1;
      if v_guard > 10000 then
        raise exception using
          errcode = 'P0001',
          message = 'TRANSPORT_CODE_ALLOCATOR_EXHAUSTED';
      end if;

      select s.next_fresh, s.exhausted
      into v_fresh_n, v_cursor_exhausted
      from public.transport_code_allocator_state_v2 s
      where s.singleton
      for update;

      if not found then
        raise exception using
          errcode = 'P0001',
          message = 'TRANSPORT_CODE_CURSOR_STATE_MISSING';
      end if;

      if v_cursor_exhausted then
        v_fresh_n := null;
        exit;
      end if;

      v_candidate := 'T' || v_fresh_n::text;

      if exists (
          select 1
          from public.transport_code_pool p
          where public.transport_tcode_number_v2(p.code) = v_fresh_n
        )
        or public.transport_tcode_has_lifecycle_reference_v2(v_candidate)
      then
        if v_fresh_n = 9223372036854775807 then
          update public.transport_code_allocator_state_v2 s
          set exhausted = true,
              updated_at = now()
          where s.singleton
            and s.next_fresh = v_fresh_n
            and not s.exhausted;
        else
          update public.transport_code_allocator_state_v2 s
          set next_fresh = v_fresh_n + 1,
              updated_at = now()
          where s.singleton
            and s.next_fresh = v_fresh_n
            and not s.exhausted;
        end if;

        if not found then
          raise exception using
            errcode = '40001',
            message = 'TRANSPORT_CODE_CURSOR_ADVANCE_RACE';
        end if;
        continue;
      end if;

      exit;
    end loop;

    -- Compare the safe fresh frontier with the smallest explicitly released
    -- row. This chooses the global numeric minimum of the two proven-safe sets.
    select p.code, parsed.code_n
    into v_pool_code, v_pool_code_n
    from public.transport_code_pool p
    cross join lateral (
      select public.transport_tcode_number_v2(p.code) as code_n
    ) parsed
    where p.status = 'available'
      and p.owner_id = 'POOL'
      and p.reserved_at is null
      and parsed.code_n is not null
      and p.code = 'T' || parsed.code_n::text
      and not public.transport_tcode_has_lifecycle_reference_v2(p.code)
    order by parsed.code_n asc, p.code asc
    limit 1
    for update;

    if v_pool_code is not null
       and (v_fresh_n is null or v_pool_code_n <= v_fresh_n)
    then
      v_code := 'T' || v_pool_code_n::text;

      update public.transport_code_pool p
      set status = 'used',
          owner_id = v_owner,
          reserved_at = now()
      where p.code = v_pool_code
        and p.status = 'available';

      if not found then
        raise exception using
          errcode = '40001',
          message = 'TRANSPORT_SMALLEST_AVAILABLE_CLAIM_RACE';
      end if;

      v_codes := array_append(v_codes, v_code);
      continue;
    end if;

    if v_fresh_n is null then
      raise exception using
        errcode = 'P0001',
        message = 'TRANSPORT_CODE_ALLOCATOR_EXHAUSTED';
    end if;

    if v_fresh_n = 9223372036854775807 then
      update public.transport_code_allocator_state_v2 s
      set exhausted = true,
          updated_at = now()
      where s.singleton
        and s.next_fresh = v_fresh_n
        and not s.exhausted;
    else
      update public.transport_code_allocator_state_v2 s
      set next_fresh = v_fresh_n + 1,
          updated_at = now()
      where s.singleton
        and s.next_fresh = v_fresh_n
        and not s.exhausted;
    end if;

    if not found then
      raise exception using
        errcode = '40001',
        message = 'TRANSPORT_CODE_CURSOR_CLAIM_RACE';
    end if;

    insert into public.transport_code_pool(
      code,
      owner_id,
      status,
      reserved_at
    ) values (
      v_candidate,
      v_owner,
      'used',
      now()
    );

    v_codes := array_append(v_codes, v_candidate);
  end loop;

  return to_jsonb(v_codes);
end;
$$;

revoke all on function public.reserve_transport_codes_batch(text, integer)
  from public;
grant execute on function public.reserve_transport_codes_batch(text, integer)
  to anon, authenticated, service_role;

create or replace function public.reserve_transport_offline_codes(
  p_owner_id text,
  p_device_id text,
  p_target integer default 10,
  p_lease_hours integer default 720
)
returns table(
  code text,
  lease_token uuid,
  lease_expires_at timestamptz,
  lease_status text,
  draft_session_id text,
  owner_id text,
  device_id text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  clean_owner text := btrim(coalesce(p_owner_id, ''));
  clean_device text := btrim(coalesce(p_device_id, ''));
  owner_quota_key text;
  wanted integer := least(greatest(coalesce(p_target, 10), 1), 10);
  lease_hours integer := least(greatest(coalesce(p_lease_hours, 720), 24), 2160);
  owner_active_count integer := 0;
  raw_owner_active_count integer := 0;
  need_count integer := 0;
  reserve_index integer := 0;
  reserved_code text;
  lease_code text;
  lease_code_n bigint;
  pool_release_count integer := 0;
  r record;
  locked_lease public.offline_code_leases%rowtype;
  token uuid;
  new_expiry timestamptz := now() + make_interval(hours => lease_hours);
begin
  if not public._tepiha_offline_owner_is_valid(clean_owner) then
    raise exception using errcode = 'P0001', message = 'OFFLINE_BANK_OWNER_INVALID';
  end if;
  if not public._tepiha_offline_device_is_valid(clean_device) then
    raise exception using errcode = 'P0001', message = 'OFFLINE_BANK_DEVICE_INVALID';
  end if;

  owner_quota_key := public.transport_offline_owner_quota_key_v2(clean_owner);

  perform pg_advisory_xact_lock(
    hashtextextended('offline-bank:transport-owner-v2:' || owner_quota_key, 0)
  );
  perform pg_advisory_xact_lock(
    hashtextextended('transport-code-allocator-v3', 0)
  );

  for r in
    select l.lease_token, l.code
    from public.offline_code_leases l
    where l.scope = 'transport'
      and l.status in ('available', 'assigned')
      and l.expires_at <= now()
    order by l.lease_token
  loop
    lease_code := upper(btrim(coalesce(r.code, '')));
    lease_code_n := public.transport_tcode_number_v2(lease_code);
    if lease_code_n is null
       or lease_code <> 'T' || lease_code_n::text
    then
      raise exception using
        errcode = '23514',
        message = 'OFFLINE_TRANSPORT_LEASE_CODE_INVALID';
    end if;

    -- Match bind/finalize's outer per-code lock, then serialize every release
    -- path before taking the lease and pool row locks.
    perform pg_advisory_xact_lock(
      hashtextextended('offline-bank:transport-code:' || lease_code, 0)
    );
    perform pg_advisory_xact_lock(
      hashtextextended('transport-code-release:' || lease_code, 0)
    );

    select l.*
    into locked_lease
    from public.offline_code_leases l
    where l.lease_token = r.lease_token
      and l.scope = 'transport'
      and l.status in ('available', 'assigned')
      and l.expires_at <= now()
    for update;

    if not found then
      continue;
    end if;

    if upper(btrim(locked_lease.code)) <> lease_code then
      raise exception using
        errcode = '40001',
        message = 'OFFLINE_TRANSPORT_LEASE_CODE_CHANGED';
    end if;

    if public.transport_tcode_has_lifecycle_reference_v2(lease_code) then
      update public.offline_code_leases l
      set status = 'consumed',
          consumed_at = coalesce(l.consumed_at, now()),
          updated_at = now(),
          metadata = l.metadata || jsonb_build_object(
            'expiry_reconciled', 'referenced_code',
            'allocator_version', 'strict-smallest-v2'
          )
      where l.lease_token = locked_lease.lease_token;
    else
      update public.transport_code_pool p
      set status = 'available',
          owner_id = 'POOL',
          reserved_at = null
      where p.code = lease_code
        and p.status = 'used'
        and p.owner_id = locked_lease.owner_id;

      get diagnostics pool_release_count = row_count;

      if pool_release_count = 0 and not exists (
        select 1
        from public.transport_code_pool p
        where p.code = lease_code
          and p.status = 'available'
          and p.owner_id = 'POOL'
      ) then
        raise exception using
          errcode = 'P0001',
          message = 'OFFLINE_TRANSPORT_POOL_RELEASE_STATE_MISMATCH';
      end if;

      update public.offline_code_leases l
      set status = 'expired',
          released_at = coalesce(l.released_at, now()),
          updated_at = now(),
          metadata = l.metadata || jsonb_build_object(
            'expired_reason', 'lease_timeout',
            'allocator_version', 'strict-smallest-v2'
          )
      where l.lease_token = locked_lease.lease_token;
    end if;
  end loop;

  -- Active leases remain pinned to their original device. Owner/device strings
  -- are not an authenticated handoff authority, and another offline device may
  -- already have consumed an apparently unassigned lease locally.
  update public.offline_code_leases l
  set expires_at = new_expiry,
      updated_at = now()
  where l.scope = 'transport'
    and l.owner_id = clean_owner
    and l.device_id = clean_device
    and l.status in ('available', 'assigned')
    and l.expires_at > now();

  select count(*)
  into owner_active_count
  from public.offline_code_leases l
  where l.scope = 'transport'
    and l.status in ('available', 'assigned')
    and l.expires_at > now()
    and public.transport_offline_owner_quota_key_v2(l.owner_id) = owner_quota_key;

  if owner_active_count > 10 then
    raise exception using
      errcode = 'P0001',
      message = 'OFFLINE_TRANSPORT_OWNER_CAP_ALREADY_EXCEEDED';
  end if;

  select count(*)
  into raw_owner_active_count
  from public.offline_code_leases l
  where l.scope = 'transport'
    and l.owner_id = clean_owner
    and l.status in ('available', 'assigned')
    and l.expires_at > now();

  if owner_active_count > 0 and raw_owner_active_count = 0 then
    raise exception using
      errcode = 'P0001',
      message = 'OFFLINE_BANK_OWNER_ALIAS_MISMATCH';
  end if;

  need_count := greatest(wanted - owner_active_count, 0);

  if need_count > 0 then
    for reserve_index in 1..need_count loop
      select value as code
      into reserved_code
      from jsonb_array_elements_text(
        public.reserve_transport_codes_batch(clean_owner, 1)
      ) as reserved(value)
      limit 1;

      reserved_code := upper(btrim(coalesce(reserved_code, '')));
      lease_code_n := public.transport_tcode_number_v2(reserved_code);
      if lease_code_n is null
         or reserved_code <> 'T' || lease_code_n::text
      then
        raise exception using
          errcode = '23514',
          message = 'OFFLINE_TRANSPORT_RESERVE_RESPONSE_INVALID';
      end if;

      token := gen_random_uuid();

      insert into public.offline_code_leases(
        lease_token,
        scope,
        code,
        owner_id,
        device_id,
        status,
        reserved_at,
        expires_at,
        metadata
      ) values (
        token,
        'transport',
        reserved_code,
        clean_owner,
        clean_device,
        'available',
        now(),
        new_expiry,
        jsonb_build_object('allocator_version', 'strict-smallest-v2')
      );
    end loop;
  end if;

  -- Refuse to return malformed historical rows. Returning a normalized alias
  -- for a differently stored row could let two clients believe they own T<n>.
  if exists (
    select 1
    from public.offline_code_leases l
    where l.scope = 'transport'
      and l.owner_id = clean_owner
      and l.device_id = clean_device
      and l.status in ('available', 'assigned')
      and l.expires_at > now()
      and (
        public.transport_tcode_number_v2(l.code) is null
        or upper(btrim(l.code)) <>
          'T' || public.transport_tcode_number_v2(l.code)::text
      )
  ) then
    raise exception using
      errcode = '23514',
      message = 'OFFLINE_TRANSPORT_LEASE_CODE_NONCANONICAL';
  end if;

  return query
  select
    'T' || public.transport_tcode_number_v2(l.code)::text,
    l.lease_token,
    l.expires_at,
    l.status,
    l.draft_session_id,
    l.owner_id,
    l.device_id
  from public.offline_code_leases l
  where l.scope = 'transport'
    and l.owner_id = clean_owner
    and l.device_id = clean_device
    and l.status in ('available', 'assigned')
    and l.expires_at > now()
  order by public.transport_tcode_number_v2(l.code) asc;
end;
$$;

revoke all on function public.reserve_transport_offline_codes(text, text, integer, integer)
  from public;
grant execute on function public.reserve_transport_offline_codes(text, text, integer, integer)
  to anon, authenticated, service_role;

notify pgrst, 'reload schema';

commit;
