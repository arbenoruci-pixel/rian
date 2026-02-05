-- TEPIHA TASKS (minimal)
-- Run in Supabase SQL editor.

create table if not exists public.tepiha_tasks (
  id uuid primary key default gen_random_uuid(),
  to_user_id uuid not null,
  from_user_id uuid null,
  type text not null default 'OTHER',
  status text not null default 'SENT',
  title text null,
  body text null,
  related_order_id bigint null,
  order_code bigint null,
  priority text not null default 'MED',
  reject_reason text null,
  outcome text null,
  meta jsonb null,
  responded_at timestamptz null,
  done_at timestamptz null,
  done_note text null,
  created_at timestamptz not null default now()
);

alter table public.tepiha_tasks enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname='public' and tablename='tepiha_tasks' and policyname='tepiha_tasks_read'
  ) then
    create policy tepiha_tasks_read on public.tepiha_tasks for select using (true);
  end if;

  if not exists (
    select 1 from pg_policies where schemaname='public' and tablename='tepiha_tasks' and policyname='tepiha_tasks_write'
  ) then
    create policy tepiha_tasks_write on public.tepiha_tasks for insert with check (true);
  end if;

  if not exists (
    select 1 from pg_policies where schemaname='public' and tablename='tepiha_tasks' and policyname='tepiha_tasks_update'
  ) then
    create policy tepiha_tasks_update on public.tepiha_tasks for update using (true) with check (true);
  end if;
end $$;
