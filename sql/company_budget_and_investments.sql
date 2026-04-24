-- COMPANY BUDGET + INVESTMENTS
-- Safe, additive patch. Does not drop existing tables.

create table if not exists public.company_budget (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  direction text not null default 'IN' check (upper(direction) in ('IN','OUT')),
  amount numeric(12,2) not null default 0 check (amount >= 0),
  reason text not null default 'MANUAL',
  note text null,
  source text null default 'CASH',
  status text not null default 'ACTIVE',
  worker_pin text null,
  worker_name text null,
  accepted_by_pin text null,
  accepted_by_name text null,
  accepted_at timestamptz null,
  external_id text null,
  created_by_pin text null,
  created_by_name text null
);

create unique index if not exists company_budget_external_id_uidx
  on public.company_budget (external_id)
  where external_id is not null;

create index if not exists company_budget_created_at_idx
  on public.company_budget (created_at desc);

create index if not exists company_budget_reason_idx
  on public.company_budget (reason);

create table if not exists public.investments (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  title text not null,
  total_amount numeric(12,2) not null default 0 check (total_amount >= 0),
  remaining_amount numeric(12,2) not null default 0 check (remaining_amount >= 0),
  monthly_amount numeric(12,2) not null default 0 check (monthly_amount >= 0),
  status text not null default 'ACTIVE',
  created_by_pin text null,
  created_by_name text null
);

create index if not exists investments_created_at_idx
  on public.investments (created_at desc);

create index if not exists investments_status_idx
  on public.investments (status);

alter table public.company_budget enable row level security;
alter table public.investments enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname='public' and tablename='company_budget' and policyname='company_budget_anon_rw'
  ) then
    create policy company_budget_anon_rw on public.company_budget for all to anon using (true) with check (true);
  end if;

  if not exists (
    select 1 from pg_policies where schemaname='public' and tablename='investments' and policyname='investments_anon_rw'
  ) then
    create policy investments_anon_rw on public.investments for all to anon using (true) with check (true);
  end if;
end $$;
