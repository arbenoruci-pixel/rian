-- TEPIHA — ARKA: Expenses + Company Budget (flat)
-- Safe to run multiple times.

-- =========================
-- 1) EXPENSES
-- =========================

create table if not exists public.arka_expenses (
  id uuid primary key default gen_random_uuid(),
  day_key text not null,
  amount numeric not null check (amount > 0),
  paid_from text not null check (paid_from in ('CASH_TODAY','COMPANY_BUDGET','PERSONAL')),
  category text not null default 'TË TJERA',
  note text,
  personal_pin text,
  created_by text,
  created_at timestamptz not null default now()
);

create index if not exists arka_expenses_day_key_idx on public.arka_expenses(day_key);
create index if not exists arka_expenses_created_at_idx on public.arka_expenses(created_at desc);

alter table public.arka_expenses enable row level security;

do $$ begin
  create policy "arka_expenses_select_anon" on public.arka_expenses
    for select to anon using (true);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "arka_expenses_insert_anon" on public.arka_expenses
    for insert to anon with check (true);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "arka_expenses_update_anon" on public.arka_expenses
    for update to anon using (true) with check (true);
exception when duplicate_object then null; end $$;

grant select, insert, update on table public.arka_expenses to anon;

-- =========================
-- 2) COMPANY BUDGET MOVES
-- =========================

create table if not exists public.arka_company_moves (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('IN','OUT')),
  amount numeric not null check (amount > 0),
  note text,
  created_by text,
  created_at timestamptz not null default now()
);

create index if not exists arka_company_moves_created_at_idx on public.arka_company_moves(created_at desc);

alter table public.arka_company_moves enable row level security;

do $$ begin
  create policy "arka_company_moves_select_anon" on public.arka_company_moves
    for select to anon using (true);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "arka_company_moves_insert_anon" on public.arka_company_moves
    for insert to anon with check (true);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "arka_company_moves_update_anon" on public.arka_company_moves
    for update to anon using (true) with check (true);
exception when duplicate_object then null; end $$;

grant select, insert, update on table public.arka_company_moves to anon;
