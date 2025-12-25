-- TABLE: tepiha_users
-- Run in Supabase SQL Editor.

create table if not exists public.tepiha_users (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  role text not null check (role in ('ADMIN','DISPATCH','PUNTOR','TRANSPORT')),
  pin text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

-- Simple mode (no Supabase Auth in this app):
-- Keep RLS disabled so the public anon key can read/write.
-- If you want RLS, you MUST implement proper auth.

-- OPTIONAL: seed default admin
insert into public.tepiha_users (name, role, pin)
select 'ADMIN','ADMIN','0000'
where not exists (select 1 from public.tepiha_users);
