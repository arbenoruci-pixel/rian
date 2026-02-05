-- TRANSPORT CLIENTS (DEDICATED)
-- Run in Supabase SQL Editor once.

create table if not exists public.transport_clients (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  phone text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by_pin text,
  created_by_name text,
  last_by_pin text,
  last_by_name text
);

create unique index if not exists transport_clients_phone_uniq on public.transport_clients (phone);

alter table public.transport_clients enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname='public' and tablename='transport_clients' and policyname='transport_clients_select'
  ) then
    create policy transport_clients_select on public.transport_clients
      for select to anon using (true);
  end if;

  if not exists (
    select 1 from pg_policies where schemaname='public' and tablename='transport_clients' and policyname='transport_clients_insert'
  ) then
    create policy transport_clients_insert on public.transport_clients
      for insert to anon with check (true);
  end if;

  if not exists (
    select 1 from pg_policies where schemaname='public' and tablename='transport_clients' and policyname='transport_clients_update'
  ) then
    create policy transport_clients_update on public.transport_clients
      for update to anon using (true) with check (true);
  end if;
end $$;
