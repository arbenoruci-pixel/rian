-- BASE/PRANIMI automatic safe refill, 2026-11-06.
-- Applied migration: 20261106164204_base_code_pool_automatic_safe_refill_v1.
-- Incident: finite pool ended at 1433; all 20 available rows already belonged
-- to clients. Safe availability was zero. Expired reservations were referenced
-- or meaningful and were intentionally left untouched.
-- Online allocation reproduced NO_BASE_CODES_AVAILABLE before this repair.
-- Verified after repair: 100 safe codes 1434..1533; 10 active actors obtained
-- distinct verified codes; same-draft retries retained their code; another
-- draft received another code; offline bank returned 10 stable leases.
-- All test reservations/lease changes were rolled back and checksummed.
-- No frontend API/signature/authentication change and no scheduled job required.
-- Apply once through the migration runner. Existing RPC body hashes are checked
-- to prevent overwriting unrelated changes. Original definitions are backed up
-- privately; the helper is not executable by browser roles.

set local lock_timeout = '5s';
set local statement_timeout = '30s';

create table private.base_code_refill_function_backup_v1 (
  routine_identity text primary key,
  original_definition text not null,
  original_body_hash text not null,
  recorded_at timestamptz not null default now()
);
alter table private.base_code_refill_function_backup_v1 enable row level security;
revoke all on table private.base_code_refill_function_backup_v1 from public, anon, authenticated, service_role;

insert into private.base_code_refill_function_backup_v1(routine_identity,original_definition,original_body_hash)
select p.oid::regprocedure::text,pg_get_functiondef(p.oid),md5(p.prosrc)
from pg_proc p
where p.oid in (
  'public.get_or_assign_pranimi_code(text,text,integer)'::regprocedure,
  'public.reserve_base_offline_codes(text,text,integer,integer)'::regprocedure
);

create function private.ensure_base_code_pool_capacity_v1(p_minimum integer default 20,p_target integer default 100)
returns integer
language plpgsql
security invoker
set search_path = pg_catalog
as $refill$
declare
  minimum_count integer := greatest(1,least(coalesce(p_minimum,20),100));
  target_count integer := greatest(minimum_count,least(coalesce(p_target,100),200));
  safe_count integer := 0;
  inserted_count integer := 0;
  changed integer := 0;
  attempts integer := 0;
  candidate bigint;
  pool_high_water bigint;
  sequence_high_water bigint;
begin
  -- All new online/offline allocations use this same transaction lock.
  perform pg_advisory_xact_lock(hashtext('tepiha_pranimi_code_allocator_v39_1'));

  select count(*) into safe_count
  from public.base_code_pool b
  where b.status='available'
    and b.code ~ '^[0-9]+$'
    and b.code::bigint>0
    and not exists(select 1 from public.orders o where btrim(o.code::text)=b.code)
    and not exists(select 1 from public.clients c where btrim(c.code::text)=b.code)
    and not exists(select 1 from public.offline_code_leases l where l.scope='base' and l.code=b.code and l.status in ('available','assigned'));

  if safe_count >= minimum_count then return 0; end if;

  -- Continue the BASE sequence; never jump to imported/test client IDs.
  -- Never move a sequence backward, including after restore/manual refill.
  select coalesce(max(case when b.code ~ '^[0-9]+$' then b.code::bigint end),0)
    into pool_high_water from public.base_code_pool b;
  select s.last_value into sequence_high_water from public.base_codes_seq s;
  if pool_high_water > sequence_high_water then
    perform setval('public.base_codes_seq'::regclass,pool_high_water,true);
  end if;

  while safe_count + inserted_count < target_count loop
    attempts := attempts + 1;
    if attempts > 10000 then
      raise exception using errcode='P0001',message='BASE_CODE_REFILL_SCAN_LIMIT';
    end if;
    candidate := nextval('public.base_codes_seq'::regclass);

    -- Existing clients, orders, leases and every pool status retain their code.
    if candidate > 0
       and not exists(select 1 from public.base_code_pool b where b.code=candidate::text)
       and not exists(select 1 from public.orders o where btrim(o.code::text)=candidate::text)
       and not exists(select 1 from public.clients c where btrim(c.code::text)=candidate::text)
       and not exists(select 1 from public.offline_code_leases l where l.scope='base' and l.code=candidate::text)
    then
      insert into public.base_code_pool(code,owner_id,status)
      values(candidate::text,'','available')
      on conflict (code) do nothing;
      get diagnostics changed = row_count;
      inserted_count := inserted_count + changed;
    end if;
  end loop;
  return inserted_count;
end;
$refill$;
revoke all on function private.ensure_base_code_pool_capacity_v1(integer,integer) from public, anon, authenticated, service_role;
comment on function private.ensure_base_code_pool_capacity_v1(integer,integer) is 'Internal invoker-only safe BASE pool refill. Called by existing authorized allocators; no cron, no client/order recycling.';

do $patch$
declare
  definition text;
  body_hash text;
  marker text;
begin
  select pg_get_functiondef(p.oid),md5(p.prosrc) into definition,body_hash
  from pg_proc p where p.oid='public.get_or_assign_pranimi_code(text,text,integer)'::regprocedure;
  if body_hash <> '7434213a28ab6b5532656e9dc944a46e' then
    raise exception 'ONLINE_ALLOCATOR_CHANGED_REVIEW_REQUIRED';
  end if;
  marker := '  perform public.release_expired_base_reservations();';
  if position(marker in definition)=0 then raise exception 'ONLINE_REFILL_INSERTION_POINT_MISSING'; end if;
  definition := replace(definition,marker,marker || E'\n  perform private.ensure_base_code_pool_capacity_v1(20,100);');
  execute definition;

  select pg_get_functiondef(p.oid),md5(p.prosrc) into definition,body_hash
  from pg_proc p where p.oid='public.reserve_base_offline_codes(text,text,integer,integer)'::regprocedure;
  if body_hash <> 'f3904a7deba26855da4e3131a1cc7522' then
    raise exception 'OFFLINE_ALLOCATOR_CHANGED_REVIEW_REQUIRED';
  end if;
  marker := '  perform pg_advisory_xact_lock(hashtextextended(''offline-bank:base:''||clean_pin,0));';
  if position(marker in definition)=0 then raise exception 'OFFLINE_REFILL_INSERTION_POINT_MISSING'; end if;
  -- Run after both existing input validations, before owner/row locks.
  definition := replace(definition,marker,E'  perform private.ensure_base_code_pool_capacity_v1(20,100);\n' || marker);
  execute definition;
end;
$patch$;

-- Restore service immediately. These are new unused identities only.
select private.ensure_base_code_pool_capacity_v1(20,100) as newly_available_codes;

-- Regression checks (run in rollback-only subtransactions; no real orders).
-- 1. For every valid active actor, call get_or_assign_pranimi_code with a
--    unique test draft; require verified=true and unique codes across actors.
-- 2. Retry the exact actor/draft and require the same code.
-- 3. A different draft for the same actor must receive a different code.
-- 4. No returned code may already belong to clients or orders.
-- 5. reserve_base_offline_codes with a test device must return 10 leases;
--    retrying that device must retain the same codes and tokens.
-- 6. Roll back all test reservations and device transfers. Compare full-row
--    checksums of base_code_pool and offline_code_leases before/after.
-- 7. Verify the helper is inaccessible to anon/authenticated, both RPCs call
--    the helper, and legacy allocators remain disabled.
