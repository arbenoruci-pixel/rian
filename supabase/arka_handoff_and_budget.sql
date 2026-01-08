-- ARKA: handoff + company budget fields
-- Safe to run multiple times.

alter table if exists public.arka_days
  add column if not exists expected_cash numeric,
  add column if not exists cash_counted numeric,
  add column if not exists discrepancy numeric,
  add column if not exists close_note text,
  add column if not exists reopened_by text,
  add column if not exists reopened_at timestamptz,
  add column if not exists handoff_status text,
  add column if not exists handoff_ready_at timestamptz,
  add column if not exists handed_by text,
  add column if not exists handed_at timestamptz,
  add column if not exists received_by text,
  add column if not exists received_at timestamptz,
  add column if not exists received_amount numeric;

-- Optional: normalize values for existing closed days
update public.arka_days
set handoff_status = coalesce(handoff_status, case when closed_at is null then 'OPEN' else 'PENDING' end)
where handoff_status is null;

create index if not exists arka_days_handoff_status_idx on public.arka_days(handoff_status);
