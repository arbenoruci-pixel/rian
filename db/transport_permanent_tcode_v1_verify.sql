-- TRANSPORT PERMANENT T-CODE V1 — READ ONLY VERIFICATION
-- Safe to run in Supabase SQL Editor.

with duplicate_visits as (
  select client_tcode, visit_nr, count(*)
  from public.transport_orders
  where client_tcode is not null and visit_nr is not null
  group by client_tcode, visit_nr
  having count(*) > 1
), pool_orphans as (
  select p.code
  from public.transport_code_pool p
  where p.status='used'
    and not exists(select 1 from public.transport_clients c where upper(c.tcode)=upper(p.code))
    and not exists(
      select 1 from public.transport_orders o
      where upper(o.code_str)=upper(p.code)
         or upper(coalesce(o.client_tcode,''))=upper(p.code)
         or upper(coalesce(o.data->>'legacy_order_code',''))=upper(p.code)
         or upper(coalesce(o.data->>'legacy_client_tcode',''))=upper(p.code)
    )
    and not exists(
      select 1 from public.arka_pending_payments ap
      where (ap.type='TRANSPORT' or ap.source_module='TRANSPORT')
        and upper(coalesce(ap.transport_code_str,''))=upper(p.code)
    )
), linked_mismatches as (
  select o.id
  from public.transport_orders o
  join public.transport_clients c on c.id=o.client_id
  where upper(coalesce(o.client_tcode,''))<>upper(c.tcode)
), code_mismatches as (
  select id
  from public.transport_orders
  where code_n<>nullif(regexp_replace(code_str,'\D','','g'),'')::bigint
)
select jsonb_build_object(
  'orders_total',(select count(*) from public.transport_orders),
  'clients_total',(select count(*) from public.transport_clients),
  'linked_orders',(select count(*) from public.transport_orders where client_id is not null),
  'unlinked_orders',(select count(*) from public.transport_orders where client_id is null),
  'latest_unlinked_at',(select max(created_at) from public.transport_orders where client_id is null),
  'linked_tcode_mismatches',(select count(*) from linked_mismatches),
  'linked_without_visit',(select count(*) from public.transport_orders where client_id is not null and visit_nr is null),
  'duplicate_visit_groups',(select count(*) from duplicate_visits),
  'code_n_mismatches',(select count(*) from code_mismatches),
  'orders_missing_t_prefix',(
    select count(*) from public.transport_orders
    where code_str !~ '^T[0-9]+$'
       or (client_tcode is not null and client_tcode !~ '^T[0-9]+$')
  ),
  'client_tcodes_missing_t_prefix',(
    select count(*) from public.transport_clients where tcode !~ '^T[0-9]+$'
  ),
  'pool_used',(select count(*) from public.transport_code_pool where status='used'),
  'pool_available',(select count(*) from public.transport_code_pool where status='available'),
  'pool_orphan_used',(select count(*) from pool_orphans),
  'smallest_available_tcode',(
    select 'T'||min(nullif(regexp_replace(code,'\D','','g'),'')::bigint)::text
    from public.transport_code_pool where status='available'
  ),
  'largest_available_tcode',(
    select 'T'||max(nullif(regexp_replace(code,'\D','','g'),'')::bigint)::text
    from public.transport_code_pool where status='available'
  ),
  'transport_code_sequence',(select last_value from public.transport_codes_seq),
  'latest_order_at',(select max(created_at) from public.transport_orders),
  'defaults',(
    select jsonb_object_agg(column_name,column_default)
    from information_schema.columns
    where table_schema='public' and table_name='transport_orders'
      and column_name in ('code_n','code_str')
  )
) as transport_permanent_tcode_verification;
