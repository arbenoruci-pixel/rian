-- TEPIHA — COMPANY BUDGET (BUXHETI I KOMPANIS)
-- Run this in Supabase SQL Editor.
--
-- Qëllimi: ledger IN/OUT që e përdor aplikacioni (lib/companyBudgetDb.js).
--
-- Kjo script:
--  - krijon/ndreq tabelën public.company_budget_moves
--  - siguron që id është UUID (pa sequence)
--  - shton kolonat që aplikacioni i pret
--  - shton unique external_id për mos me dupliku sinkronizimet

-- 1) UUID helper (gen_random_uuid)
create extension if not exists pgcrypto;

-- 2) Create table if missing (minimal)
create table if not exists public.company_budget_moves (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  direction text,
  amount numeric,
  reason text,
  note text,
  source text,
  created_by uuid,
  created_by_name text,
  created_by_pin text,
  ref_day_id uuid,
  ref_type text,
  external_id text
);

-- 3) Ensure required columns exist (safe for older schemas)
alter table public.company_budget_moves
  alter column id set default gen_random_uuid();

alter table public.company_budget_moves add column if not exists created_at timestamptz not null default now();
alter table public.company_budget_moves add column if not exists direction text;
alter table public.company_budget_moves add column if not exists amount numeric;
alter table public.company_budget_moves add column if not exists reason text;
alter table public.company_budget_moves add column if not exists note text;
alter table public.company_budget_moves add column if not exists source text;
alter table public.company_budget_moves add column if not exists created_by uuid;
alter table public.company_budget_moves add column if not exists created_by_name text;
alter table public.company_budget_moves add column if not exists created_by_pin text;
alter table public.company_budget_moves add column if not exists ref_day_id uuid;
alter table public.company_budget_moves add column if not exists ref_type text;
alter table public.company_budget_moves add column if not exists external_id text;

-- 4) Unique external_id (idempotent syncing)
create unique index if not exists company_budget_moves_external_id_uq
  on public.company_budget_moves (external_id)
  where external_id is not null and external_id <> '';

-- 5) Basic indexes
create index if not exists idx_company_budget_moves_created_at
  on public.company_budget_moves (created_at);
create index if not exists idx_company_budget_moves_direction
  on public.company_budget_moves (direction);

-- 6) RLS (simple, for development)
alter table public.company_budget_moves enable row level security;

do $$
begin
  -- Policies might not exist; ignore errors.
  begin execute 'drop policy "company_budget_moves_select" on public.company_budget_moves'; exception when undefined_object then null; end;
  begin execute 'drop policy "company_budget_moves_insert" on public.company_budget_moves'; exception when undefined_object then null; end;
  begin execute 'drop policy "company_budget_moves_update" on public.company_budget_moves'; exception when undefined_object then null; end;
  begin execute 'drop policy "company_budget_moves_delete" on public.company_budget_moves'; exception when undefined_object then null; end;
end $$;

create policy company_budget_moves_select on public.company_budget_moves
  for select
  using (true);

create policy company_budget_moves_insert on public.company_budget_moves
  for insert
  with check (true);

create policy company_budget_moves_update on public.company_budget_moves
  for update
  using (true)
  with check (true);

create policy company_budget_moves_delete on public.company_budget_moves
  for delete
  using (true);

grant select, insert, update, delete on public.company_budget_moves to anon, authenticated;
