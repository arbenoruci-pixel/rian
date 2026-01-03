-- ARKA SCHEMA (Supabase)
-- Run in Supabase SQL editor.
-- This is minimal and safe. You can extend later.

-- 1) DAYS (open/close)
create table if not exists public.arka_days (
  id bigserial primary key,
  opened_at timestamptz not null default now(),
  opened_by text,
  initial_cash numeric not null default 0,
  closed_at timestamptz,
  closed_by text
);

-- 2) MOVES (cash in/out)
create table if not exists public.arka_moves (
  id bigserial primary key,
  day_id bigint references public.arka_days(id) on delete set null,
  type text not null check (type in ('IN','OUT')),
  amount numeric not null check (amount >= 0),
  note text,
  source text default 'CASH',
  created_by text,
  created_at timestamptz not null default now()
);

-- 3) STAFF (who exists in the system)
create table if not exists public.arka_staff (
  id bigserial primary key,
  name text not null,
  role text not null default 'PUNTOR',
  is_admin boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- 4) DEBTS (owes/owed)
create table if not exists public.arka_debts (
  id bigserial primary key,
  direction text not null check (direction in ('OWED_BY_US','OWED_TO_US')),
  party text not null,
  amount numeric not null default 0,
  note text,
  status text not null default 'OPEN' check (status in ('OPEN','PAID')),
  created_at timestamptz not null default now()
);

-- 5) OWNERS + MONTH CLOSE
create table if not exists public.arka_owners (
  id bigserial primary key,
  name text not null,
  percent numeric not null default 50,
  created_at timestamptz not null default now()
);

create table if not exists public.arka_month_closes (
  id bigserial primary key,
  month text not null, -- '2025-12'
  total_revenue numeric not null default 0,
  total_expenses numeric not null default 0,
  payroll numeric not null default 0,
  debt_reserve numeric not null default 0,
  remaining numeric not null default 0,
  distribution jsonb,
  created_at timestamptz not null default now()
);

-- ---------------- RLS (simple anon read/write) ----------------
-- If you already use auth, tighten these policies later.
alter table public.arka_days enable row level security;
alter table public.arka_moves enable row level security;
alter table public.arka_staff enable row level security;
alter table public.arka_debts enable row level security;
alter table public.arka_owners enable row level security;
alter table public.arka_month_closes enable row level security;

-- anon can read/write (for now)
create policy if not exists "anon_read_arka_days" on public.arka_days for select using (true);
create policy if not exists "anon_write_arka_days" on public.arka_days for insert with check (true);
create policy if not exists "anon_update_arka_days" on public.arka_days for update using (true) with check (true);

create policy if not exists "anon_read_arka_moves" on public.arka_moves for select using (true);
create policy if not exists "anon_write_arka_moves" on public.arka_moves for insert with check (true);
create policy if not exists "anon_update_arka_moves" on public.arka_moves for update using (true) with check (true);

create policy if not exists "anon_read_arka_staff" on public.arka_staff for select using (true);
create policy if not exists "anon_write_arka_staff" on public.arka_staff for insert with check (true);
create policy if not exists "anon_update_arka_staff" on public.arka_staff for update using (true) with check (true);
create policy if not exists "anon_delete_arka_staff" on public.arka_staff for delete using (true);

create policy if not exists "anon_read_arka_debts" on public.arka_debts for select using (true);
create policy if not exists "anon_write_arka_debts" on public.arka_debts for insert with check (true);
create policy if not exists "anon_update_arka_debts" on public.arka_debts for update using (true) with check (true);
create policy if not exists "anon_delete_arka_debts" on public.arka_debts for delete using (true);

create policy if not exists "anon_read_arka_owners" on public.arka_owners for select using (true);
create policy if not exists "anon_write_arka_owners" on public.arka_owners for insert with check (true);
create policy if not exists "anon_update_arka_owners" on public.arka_owners for update using (true) with check (true);
create policy if not exists "anon_delete_arka_owners" on public.arka_owners for delete using (true);

create policy if not exists "anon_read_arka_month_closes" on public.arka_month_closes for select using (true);
create policy if not exists "anon_write_arka_month_closes" on public.arka_month_closes for insert with check (true);
create policy if not exists "anon_update_arka_month_closes" on public.arka_month_closes for update using (true) with check (true);
create policy if not exists "anon_delete_arka_month_closes" on public.arka_month_closes for delete using (true);
