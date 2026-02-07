-- FIX: transport_orders.transport_id missing
-- This eliminates runtime errors like: "column transport_orders.transport_id does not exist"
-- (often caused by old RLS policies or app filters referencing transport_id).

begin;

alter table if exists public.transport_orders
  add column if not exists transport_id text
  generated always as (
    coalesce(
      data->>'transport_id',
      data#>>'{scope,transport_id}'
    )
  ) stored;

create index if not exists transport_orders_transport_id_idx
  on public.transport_orders (transport_id);

commit;
