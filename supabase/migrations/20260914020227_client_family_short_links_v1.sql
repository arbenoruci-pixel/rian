-- Opaque public links keep the signed family payload out of customer messages.
-- Only a SHA-256 digest is stored; access stays behind the approved staff API.
begin;
set local lock_timeout='5s';
create table public.client_family_short_links (
  token_hash text primary key check (token_hash ~ '^[a-f0-9]{64}$'),
  source text not null check (source in ('BASE','TRANSPORT')),
  order_id text not null,
  client_id uuid not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
alter table public.client_family_short_links enable row level security;
revoke all on public.client_family_short_links from public, anon, authenticated;
grant select, insert on public.client_family_short_links to service_role;
notify pgrst,'reload schema';
commit;
