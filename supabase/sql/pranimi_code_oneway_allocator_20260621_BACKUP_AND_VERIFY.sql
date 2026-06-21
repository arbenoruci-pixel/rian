-- PRANIMI ONE-WAY CODE ALLOCATOR V39.1 PRO
-- READ-ONLY BACKUP + PRE/POST VERIFICATION — 2026-06-21
-- This file contains SELECT statements only. It never calls a mutating RPC and
-- never INSERTs/UPDATEs/DELETEs clients, orders, payments, or base_code_pool.

-- A1. Business-row counts: save/export this result before and after migration.
select
  (select count(*) from public.clients) as clients_count,
  (select count(*) from public.orders) as orders_count,
  (select count(*) from public.base_code_pool) as pool_count,
  (select count(*) from public.base_code_pool where status = 'used') as used_pool_count;

-- A2. Pool histogram. Save/export before migration.
select b.status,
       nullif(btrim(coalesce((to_jsonb(b)->>'reserved_by'), '')), '') is null as no_reserved_by,
       count(*) as rows,
       min(b.code) as min_code,
       max(b.code) as max_code
from public.base_code_pool b
group by 1,2
order by 1,2;

-- A3. Full RESERVED snapshot, including optional V39/V39.1 columns safely.
select b.code,
       b.status,
       to_jsonb(b)->>'reserved_by' as reserved_by,
       to_jsonb(b)->>'reserved_at' as reserved_at,
       to_jsonb(b)->>'lease_expires_at' as lease_expires_at,
       to_jsonb(b)->>'draft_session_id' as draft_session_id,
       to_jsonb(b)->>'draft_has_meaningful_work' as draft_has_meaningful_work,
       exists (select 1 from public.orders o where o.code::text = b.code::text) as has_order,
       exists (select 1 from public.clients c where c.code::text = b.code::text) as has_client
from public.base_code_pool b
where b.status = 'reserved'
order by coalesce(to_jsonb(b)->>'reserved_by',''), b.code;

-- A4. Fitim PIN 1126 exact backlog. No rows are changed.
select b.code,
       b.status,
       to_jsonb(b)->>'reserved_by' as reserved_by,
       to_jsonb(b)->>'draft_session_id' as draft_session_id,
       to_jsonb(b)->>'reserved_at' as reserved_at,
       to_jsonb(b)->>'lease_expires_at' as lease_expires_at,
       exists (select 1 from public.orders o where o.code::text = b.code::text) as has_order,
       exists (select 1 from public.clients c where c.code::text = b.code::text) as has_client
from public.base_code_pool b
where regexp_replace(coalesce(to_jsonb(b)->>'reserved_by',''),'[^0-9]','','g') = '1126'
order by b.code;

-- A5. Per-PIN reserved backlog, highlighting order-less/client-less rows.
select regexp_replace(coalesce(to_jsonb(b)->>'reserved_by',''),'[^0-9]','','g') as pin,
       count(*) as reserved_rows,
       count(*) filter (
         where not exists (select 1 from public.orders o where o.code::text=b.code::text)
           and not exists (select 1 from public.clients c where c.code::text=b.code::text)
       ) as unbound_business_rows,
       count(*) filter (where nullif(btrim(coalesce(to_jsonb(b)->>'draft_session_id','')),'') is not null) as draft_bound_rows
from public.base_code_pool b
where b.status='reserved'
group by 1
order by reserved_rows desc, pin;

-- A6. Review gates: each query should return zero rows before applying V39.1.
select b.code, count(*) as duplicate_pool_rows
from public.base_code_pool b
where b.code is not null
group by b.code having count(*) > 1
order by b.code;

select o.code, count(*) as order_rows, array_agg(o.id order by o.id) as order_ids
from public.orders o
where o.code is not null
group by o.code having count(*) > 1
order by o.code;

select btrim(coalesce(to_jsonb(b)->>'reserved_by','')) as pin,
       count(*) as bound_reserved_rows,
       array_agg(b.code order by b.code) as codes,
       array_agg(to_jsonb(b)->>'draft_session_id' order by b.code) as draft_session_ids
from public.base_code_pool b
where b.status='reserved'
  and nullif(btrim(coalesce(to_jsonb(b)->>'reserved_by','')),'') is not null
  and nullif(btrim(coalesce(to_jsonb(b)->>'draft_session_id','')),'') is not null
group by 1 having count(*) > 1
order by 1;

-- B1. After migration: exactly one overload for every allocator/lifecycle RPC.
select p.proname,
       oidvectortypes(p.proargtypes) as identity_args,
       pg_get_function_result(p.oid) as result_type,
       p.prosecdef as security_definer
from pg_proc p
join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public'
  and p.proname = any(array[
    'reserve_base_codes_batch',
    'reserve_base_codes_batch_simple',
    'reserve_or_reuse_base_code_for_pin',
    'get_or_assign_pranimi_code',
    'verify_pranimi_code_assignment',
    'renew_pranimi_code_assignment',
    'mark_base_code_used_after_verify',
    'release_pranimi_code_assignment',
    'release_pranimi_temp_code_after_existing_client_save'
  ])
order by p.proname, identity_args;

-- B2. V39.1 columns and protective indexes exist.
select c.column_name,c.data_type,c.is_nullable,c.column_default
from information_schema.columns c
where c.table_schema='public' and c.table_name='base_code_pool'
  and c.column_name = any(array[
    'reserved_by','reserved_at','lease_expires_at','used_at','draft_session_id',
    'draft_has_meaningful_work','used_by_pin','used_draft_session_id','used_order_id'
  ])
order by c.column_name;

select indexname,indexdef
from pg_indexes
where schemaname='public' and tablename='base_code_pool'
  and indexname in (
    'base_code_pool_code_uidx',
    'base_code_pool_pin_session_idx',
    'base_code_pool_one_bound_draft_per_pin_uidx'
  )
order by indexname;

-- B3. Legacy allocation RPCs must not be executable by app roles.
select p.proname,
       oidvectortypes(p.proargtypes) as identity_args,
       has_function_privilege('anon',p.oid,'EXECUTE') as anon_can_execute,
       has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated_can_execute
from pg_proc p
join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public'
  and p.proname in ('reserve_base_codes_batch','reserve_base_codes_batch_simple','reserve_or_reuse_base_code_for_pin')
order by p.proname;

-- B4. Official lifecycle RPCs must be executable by app roles.
select p.proname,
       oidvectortypes(p.proargtypes) as identity_args,
       has_function_privilege('anon',p.oid,'EXECUTE') as anon_can_execute,
       has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated_can_execute
from pg_proc p
join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public'
  and p.proname in (
    'get_or_assign_pranimi_code','verify_pranimi_code_assignment','renew_pranimi_code_assignment',
    'mark_base_code_used_after_verify','release_pranimi_code_assignment',
    'release_pranimi_temp_code_after_existing_client_save'
  )
order by p.proname;

-- B5. Used rows retain provenance when consumed by V39.1; legacy used rows stay untouched.
select
  count(*) as used_rows,
  count(*) filter (where nullif(btrim(coalesce(to_jsonb(b)->>'used_order_id','')),'') is not null) as v39_1_provenance_rows,
  count(*) filter (where nullif(btrim(coalesce(to_jsonb(b)->>'used_order_id','')),'') is null) as legacy_used_rows,
  count(*) filter (where nullif(btrim(coalesce(to_jsonb(b)->>'reserved_by','')),'') is null) as used_without_reserved_by
from public.base_code_pool b
where b.status='used';

-- B6. Invariants after live tests: each query should return zero rows.
select b.code,b.status,to_jsonb(b)->>'reserved_by' as reserved_by,
       to_jsonb(b)->>'draft_session_id' as draft_session_id,o.id as order_id,to_jsonb(o)->>'status' as order_status
from public.base_code_pool b
join public.orders o on o.code::text=b.code::text
where b.status='reserved'
  and coalesce(nullif(lower(btrim(to_jsonb(o)->>'status')),''),lower(btrim(to_jsonb(o)->'data'->>'status')),'') not in
      ('draft','incomplete','paplotesuar','pa_plotesuar','pa_plotsuar','e_paplotesuar','e_pa_plotesuar','e_pa_plotsuar','local_draft','pending_draft')
order by b.code;

select b.code,to_jsonb(b)->>'used_order_id' as used_order_id,
       to_jsonb(b)->>'used_by_pin' as used_by_pin,
       to_jsonb(b)->>'used_draft_session_id' as used_draft_session_id
from public.base_code_pool b
where b.status='used'
  and nullif(btrim(coalesce(to_jsonb(b)->>'used_order_id','')),'') is not null
  and not exists (
    select 1 from public.orders o
    where o.id::text=to_jsonb(b)->>'used_order_id' and o.code::text=b.code::text
  )
order by b.code;

-- B7. LIVE-SCHEMA SAFETY GATE: inspect every non-internal trigger that could
-- mutate Pranimi orders or base-code lifecycle. Export these definitions before
-- migration. If an unknown trigger writes base_code_pool/status='used', STOP and
-- review it; V39.1 deliberately does not drop unknown live business logic.
select
  ns.nspname as table_schema,
  cls.relname as table_name,
  trg.tgname as trigger_name,
  trg.tgenabled as trigger_enabled,
  pns.nspname as function_schema,
  proc.proname as function_name,
  pg_get_triggerdef(trg.oid, true) as trigger_definition,
  pg_get_functiondef(proc.oid) as trigger_function_definition
from pg_trigger trg
join pg_class cls on cls.oid=trg.tgrelid
join pg_namespace ns on ns.oid=cls.relnamespace
join pg_proc proc on proc.oid=trg.tgfoid
join pg_namespace pns on pns.oid=proc.pronamespace
where not trg.tgisinternal
  and ns.nspname='public'
  and cls.relname in ('base_code_pool','orders','clients')
order by cls.relname,trg.tgname;

-- B8. Search all user-defined functions that mention base_code_pool. This catches
-- old writers whose names differ from the known allocator RPCs. Review every row
-- before deployment; do not blindly drop a function from this report.
select
  n.nspname as function_schema,
  p.proname as function_name,
  pg_get_function_identity_arguments(p.oid) as identity_args,
  p.prosecdef as security_definer,
  pg_get_functiondef(p.oid) as function_definition
from pg_proc p
join pg_namespace n on n.oid=p.pronamespace
where p.prokind='f'
  and n.nspname not in ('pg_catalog','information_schema')
  and pg_get_functiondef(p.oid) ilike '%base_code_pool%'
order by n.nspname,p.proname,identity_args;

