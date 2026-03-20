begin;

create table if not exists public.company_budget_ledger (
  id bigserial primary key,
  direction text not null check (direction in ('IN','OUT')),
  amount numeric(14,2) not null check (amount >= 0),
  category text not null,
  description text not null,
  source_type text null,
  source_id bigint null,
  related_handoff_id bigint null,
  created_by_pin text null,
  created_by_name text null,
  approved_by_pin text null,
  approved_by_name text null,
  created_at timestamptz not null default now()
);

create table if not exists public.cash_handoffs (
  id bigserial primary key,
  worker_pin text not null,
  worker_name text null,
  amount numeric(14,2) not null check (amount > 0),
  status text not null default 'PENDING_DISPATCH_APPROVAL'
    check (status in ('PENDING_DISPATCH_APPROVAL','ACCEPTED','REJECTED','CANCELLED')),
  note text null,
  submitted_at timestamptz not null default now(),
  decided_at timestamptz null,
  dispatch_pin text null,
  dispatch_name text null,
  dispatch_note text null,
  company_ledger_entry_id bigint null references public.company_budget_ledger(id) on delete set null
);

create table if not exists public.cash_handoff_items (
  id bigserial primary key,
  handoff_id bigint not null references public.cash_handoffs(id) on delete cascade,
  pending_payment_id bigint null references public.arka_pending_payments(id) on delete set null,
  order_id bigint null references public.orders(id) on delete set null,
  order_code bigint null,
  amount numeric(14,2) not null check (amount >= 0),
  created_at timestamptz not null default now()
);

create table if not exists public.owners (
  id bigserial primary key,
  owner_pin text null unique,
  owner_name text not null,
  share_percent numeric(7,4) not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.owner_investments (
  id bigserial primary key,
  owner_id bigint not null references public.owners(id) on delete cascade,
  investment_type text not null default 'INITIAL' check (investment_type in ('INITIAL','ADDITIONAL')),
  amount numeric(14,2) not null check (amount > 0),
  description text not null,
  invested_at timestamptz not null default now(),
  created_by_pin text null,
  created_by_name text null
);

create table if not exists public.owner_investment_repayments (
  id bigserial primary key,
  owner_id bigint not null references public.owners(id) on delete cascade,
  amount numeric(14,2) not null check (amount > 0),
  description text not null,
  company_ledger_entry_id bigint null references public.company_budget_ledger(id) on delete set null,
  created_at timestamptz not null default now(),
  created_by_pin text null,
  created_by_name text null
);

create table if not exists public.owner_profit_transfers (
  id bigserial primary key,
  owner_id bigint not null references public.owners(id) on delete cascade,
  amount numeric(14,2) not null check (amount > 0),
  description text not null,
  company_ledger_entry_id bigint null references public.company_budget_ledger(id) on delete set null,
  created_at timestamptz not null default now(),
  created_by_pin text null,
  created_by_name text null
);

create index if not exists idx_company_budget_ledger_created_at on public.company_budget_ledger(created_at desc);
create index if not exists idx_cash_handoffs_status on public.cash_handoffs(status);
create index if not exists idx_cash_handoffs_worker_pin on public.cash_handoffs(worker_pin);
create index if not exists idx_cash_handoff_items_handoff_id on public.cash_handoff_items(handoff_id);
create index if not exists idx_owner_investments_owner_id on public.owner_investments(owner_id);
create index if not exists idx_owner_investment_repayments_owner_id on public.owner_investment_repayments(owner_id);
create index if not exists idx_owner_profit_transfers_owner_id on public.owner_profit_transfers(owner_id);

insert into public.company_budget_summary (id, current_balance, total_in, total_out)
select 1, 0, 0, 0
where not exists (select 1 from public.company_budget_summary where id = 1);

create or replace view public.owner_finance_summary as
select
  o.id as owner_id,
  o.owner_name,
  o.owner_pin,
  o.share_percent,
  coalesce(inv.total_invested, 0)::numeric(14,2) as total_invested,
  coalesce(rep.total_repaid, 0)::numeric(14,2) as total_repaid,
  (coalesce(inv.total_invested, 0) - coalesce(rep.total_repaid, 0))::numeric(14,2) as remaining_investment,
  coalesce(pro.total_profit_received, 0)::numeric(14,2) as total_profit_received
from public.owners o
left join (
  select owner_id, sum(amount) as total_invested
  from public.owner_investments
  group by owner_id
) inv on inv.owner_id = o.id
left join (
  select owner_id, sum(amount) as total_repaid
  from public.owner_investment_repayments
  group by owner_id
) rep on rep.owner_id = o.id
left join (
  select owner_id, sum(amount) as total_profit_received
  from public.owner_profit_transfers
  group by owner_id
) pro on pro.owner_id = o.id;

alter table public.company_budget_ledger enable row level security;
alter table public.cash_handoffs enable row level security;
alter table public.cash_handoff_items enable row level security;
alter table public.owners enable row level security;
alter table public.owner_investments enable row level security;
alter table public.owner_investment_repayments enable row level security;
alter table public.owner_profit_transfers enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array[
    'company_budget_ledger',
    'cash_handoffs',
    'cash_handoff_items',
    'owners',
    'owner_investments',
    'owner_investment_repayments',
    'owner_profit_transfers'
  ]
  loop
    if not exists (
      select 1 from pg_policies where schemaname='public' and tablename=t and policyname=t||'_all_anon'
    ) then
      execute format('create policy %I on public.%I for all to anon, authenticated using (true) with check (true)', t||'_all_anon', t);
    end if;
  end loop;
end $$;

commit;
