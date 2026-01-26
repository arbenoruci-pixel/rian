-- TEPIHA: add handoff columns for ARKA days
-- Run in Supabase SQL Editor (public schema)

alter table if exists public.arka_days
  add column if not exists handoff_status text default 'PENDING',
  add column if not exists handoff_ready_at timestamptz,
  add column if not exists handoff_received_at timestamptz,
  add column if not exists handoff_by text,
  add column if not exists handoff_received_by text;

-- Optional: constrain status values
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'arka_days_handoff_status_check'
  ) then
    alter table public.arka_days
      add constraint arka_days_handoff_status_check
      check (handoff_status in ('PENDING','HANDED','RECEIVED'));
  end if;
end$$;
