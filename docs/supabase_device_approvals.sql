-- TEPIHA — Device approvals (master-controlled)
-- Run this in Supabase SQL editor.

-- 1) Extend users table (if needed)
alter table if exists public.tepiha_users
  add column if not exists is_master boolean not null default false,
  add column if not exists is_active boolean not null default true;

-- 2) Devices table
create table if not exists public.tepiha_user_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.tepiha_users(id) on delete cascade,
  device_id text not null,
  label text,
  is_approved boolean not null default false,
  created_at timestamptz not null default now(),
  approved_at timestamptz,
  approved_by uuid references public.tepiha_users(id)
);

-- Unique per (user, device)
create unique index if not exists tepiha_user_devices_user_device_uq
  on public.tepiha_user_devices(user_id, device_id);

-- 3) RLS
alter table public.tepiha_user_devices enable row level security;

-- For now, app uses SERVICE ROLE on /api routes for admin operations.
-- So we can keep RLS strict (deny anon).
drop policy if exists "deny anon" on public.tepiha_user_devices;
create policy "deny anon" on public.tepiha_user_devices
  for all to anon
  using (false)
  with check (false);

-- 4) Mark your master admin (change pin)
-- Example:
-- update public.tepiha_users set is_master=true where pin='2380' and role='ADMIN';
