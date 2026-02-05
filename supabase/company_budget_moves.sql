-- TEPIHA: COMPANY BUDGET (Buxheti i kompanisë)
-- Krijon tabelën company_budget_moves + RLS policies.

create table if not exists public.company_budget_moves (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  type text not null check (type in ('IN','OUT')),
  amount numeric not null check (amount >= 0),
  note text,
  source text,
  meta jsonb not null default '{}'::jsonb
);

create index if not exists idx_company_budget_moves_created_at
  on public.company_budget_moves (created_at desc);

create index if not exists idx_company_budget_moves_source
  on public.company_budget_moves (source);

alter table public.company_budget_moves enable row level security;

-- Policies (anon/auth) – app-i përdor anon key.
drop policy if exists company_budget_select on public.company_budget_moves;
drop policy if exists company_budget_insert on public.company_budget_moves;
drop policy if exists company_budget_update on public.company_budget_moves;
drop policy if exists company_budget_delete on public.company_budget_moves;

create policy company_budget_select
  on public.company_budget_moves
  for select
  to anon, authenticated
  using (true);

create policy company_budget_insert
  on public.company_budget_moves
  for insert
  to anon, authenticated
  with check (true);

create policy company_budget_update
  on public.company_budget_moves
  for update
  to anon, authenticated
  using (true)
  with check (true);

create policy company_budget_delete
  on public.company_budget_moves
  for delete
  to anon, authenticated
  using (true);

grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on public.company_budget_moves to anon, authenticated;
grant usage, select on sequence public.company_budget_moves_id_seq to anon, authenticated;

-- OPTIONAL: Nese don me e pastru krejt buxhetin (reset):
-- truncate table public.company_budget_moves;
