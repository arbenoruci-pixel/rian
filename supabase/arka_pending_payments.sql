-- ARKA: PENDING CASH PAYMENTS (WAITING)
-- Allows CASH payments to be recorded even when there is no OPEN cycle.
-- CashClient will force confirmation when a new cycle is opened.

create table if not exists public.arka_pending_payments (
  id uuid primary key default gen_random_uuid(),
  external_id text unique not null,
  status text not null default 'PENDING', -- PENDING | APPLIED | REJECTED
  type text not null default 'IN',        -- IN | OUT
  method text not null default 'CASH',
  amount numeric not null,
  order_id text null,
  order_code text null,
  client_name text null,
  note text null,
  created_by_pin text null,
  created_by_name text null,
  created_at timestamptz not null default now(),

  applied_at timestamptz null,
  applied_cycle_id uuid null,
  approved_by_pin text null,
  approved_by_name text null,
  approved_by_role text null,

  rejected_at timestamptz null,
  rejected_by_pin text null,
  rejected_by_name text null,
  rejected_by_role text null,
  reject_note text null
);

create index if not exists arka_pending_payments_status_idx on public.arka_pending_payments(status, created_at);

alter table public.arka_pending_payments enable row level security;

-- NOTE: keep it permissive like other ARKA tables (adjust later if you want strict role-based RLS)
drop policy if exists "anon_select_arka_pending" on public.arka_pending_payments;
drop policy if exists "anon_insert_arka_pending" on public.arka_pending_payments;
drop policy if exists "anon_update_arka_pending" on public.arka_pending_payments;

create policy "anon_select_arka_pending" on public.arka_pending_payments
for select to anon using (true);

create policy "anon_insert_arka_pending" on public.arka_pending_payments
for insert to anon with check (true);

create policy "anon_update_arka_pending" on public.arka_pending_payments
for update to anon using (true) with check (true);
