-- TEPIHA — Company Budget (DISPATCH)
-- Creates a small ledger for company OUT movements (expenses + bank transfers).
-- IN cash comes from arka_days.received_amount when DISPATCH accepts a handoff.

create table if not exists public.arka_company_moves (
  id bigserial primary key,
  type text not null default 'EXPENSE' check (type in ('EXPENSE','BANK')),
  amount numeric not null default 0,
  note text,
  created_by text,
  created_at timestamptz not null default now()
);

alter table public.arka_company_moves enable row level security;

-- anonymous (public) access like the rest of the app
do $$ begin
  create policy "arka_company_moves_select" on public.arka_company_moves
    for select to anon using (true);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "arka_company_moves_insert" on public.arka_company_moves
    for insert to anon with check (true);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "arka_company_moves_delete" on public.arka_company_moves
    for delete to anon using (true);
exception when duplicate_object then null; end $$;

grant select, insert, delete on public.arka_company_moves to anon;
grant usage, select on sequence public.arka_company_moves_id_seq to anon;
