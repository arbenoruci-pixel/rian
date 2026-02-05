-- TEPIHA USERS (PIN) — create + anon access (cash-only app)
-- Run this in Supabase SQL Editor.

create extension if not exists pgcrypto;

create table if not exists public.tepiha_users (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  role text not null default 'PUNTOR',
  pin text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

-- prevent duplicate PINs
create unique index if not exists tepiha_users_pin_unique on public.tepiha_users (pin);

alter table public.tepiha_users enable row level security;

-- CASH-ONLY: allow anon to manage users (same as other ARKA tables)
-- If you prefer stricter security later, we can switch to auth roles.
create policy if not exists "anon_read_tepiha_users" on public.tepiha_users
for select using (true);

create policy if not exists "anon_insert_tepiha_users" on public.tepiha_users
for insert with check (true);

create policy if not exists "anon_update_tepiha_users" on public.tepiha_users
for update using (true) with check (true);

-- OPTIONAL: seed DISPATCH if missing (PIN 2580 example)
-- NOTE: If the PIN already exists, this will fail due to unique index.
insert into public.tepiha_users (name, role, pin, is_active)
select 'DISPATCH', 'DISPATCH', '2580', true
where not exists (select 1 from public.tepiha_users where role = 'DISPATCH');
