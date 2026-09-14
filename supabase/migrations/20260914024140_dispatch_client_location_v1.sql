-- Customer-submitted locations are separate from staff addresses and financial records.
-- Only the server may read/append them after validating a personal link or staff device.
create table public.client_family_locations (
  request_id uuid primary key,
  source text not null check (source in ('BASE', 'TRANSPORT')),
  order_id text not null check (length(order_id) between 1 and 50),
  client_id uuid not null,
  address text not null default '' check (length(address) <= 300),
  latitude double precision,
  longitude double precision,
  created_at timestamptz not null default clock_timestamp(),
  check ((latitude is null and longitude is null and length(trim(address)) > 0)
    or (latitude is not null and longitude is not null
      and latitude between -90 and 90 and longitude between -180 and 180))
);
create index client_family_locations_visit_latest
  on public.client_family_locations(source, client_id, order_id, created_at desc);
alter table public.client_family_locations enable row level security;
revoke all on public.client_family_locations from public, anon, authenticated, service_role;
grant select, insert on public.client_family_locations to service_role;
