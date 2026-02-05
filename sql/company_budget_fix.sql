-- TEPIHA — COMPANY BUDGET FIX (UUID + REF COLUMN + AUTO MIRROR FROM ARKA)
-- Run this in Supabase SQL Editor.

-- 0) Extensions
create extension if not exists pgcrypto;

-- 1) Table: company_budget_moves
create table if not exists public.company_budget_moves (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),

  -- IN / OUT
  direction text not null check (upper(direction) in ('IN','OUT')),
  amount numeric(12,2) not null check (amount >= 0),

  -- What / why
  reason text not null default '',
  note text not null default '',

  -- Source system
  source text not null default 'MANUAL',

  -- Optional operator info
  created_by text,
  created_by_name text,
  created_by_pin text,

  -- Optional grouping
  ref_day_id text,
  ref_type text,

  -- Idempotency (prevents duplicates)
  external_id text,

  -- Flexible reference payload (fix for "column ref does not exist")
  ref jsonb not null default '{}'::jsonb
);

-- 1.1) Ensure external_id unique (if present)
-- (partial unique: allows many NULLs)
create unique index if not exists company_budget_moves_external_id_uq
  on public.company_budget_moves (external_id)
  where external_id is not null;

-- 1.2) Useful indexes
create index if not exists idx_company_budget_moves_created_at
  on public.company_budget_moves (created_at desc);
create index if not exists idx_company_budget_moves_direction
  on public.company_budget_moves (direction);
create index if not exists idx_company_budget_moves_source
  on public.company_budget_moves (source);

-- 2) RLS policies (simple anon access like other TEPIHA tables)
alter table public.company_budget_moves enable row level security;

do $$
begin
  -- SELECT
  if not exists (
    select 1 from pg_policies
    where schemaname='public'
      and tablename='company_budget_moves'
      and policyname='company_budget_moves_select_anon'
  ) then
    create policy company_budget_moves_select_anon
      on public.company_budget_moves
      for select
      to anon
      using (true);
  end if;

  -- INSERT
  if not exists (
    select 1 from pg_policies
    where schemaname='public'
      and tablename='company_budget_moves'
      and policyname='company_budget_moves_insert_anon'
  ) then
    create policy company_budget_moves_insert_anon
      on public.company_budget_moves
      for insert
      to anon
      with check (true);
  end if;

  -- UPDATE (needed for edits/reversals)
  if not exists (
    select 1 from pg_policies
    where schemaname='public'
      and tablename='company_budget_moves'
      and policyname='company_budget_moves_update_anon'
  ) then
    create policy company_budget_moves_update_anon
      on public.company_budget_moves
      for update
      to anon
      using (true)
      with check (true);
  end if;
end $$;

-- 3) AUTO MIRROR from ARKA (every arka_cycle_moves insert -> company_budget_moves)
-- Assumes arka_cycle_moves has: id (uuid or bigint), created_at, type ('in'/'out'), amount, note, cycle_id.

create or replace function public.mirror_arka_move_to_company_budget()
returns trigger
language plpgsql
security definer
as $$
begin
  insert into public.company_budget_moves (
    created_at,
    direction,
    amount,
    reason,
    note,
    source,
    external_id,
    ref
  ) values (
    coalesce(new.created_at, now()),
    case when lower(new.type)='in' then 'IN' else 'OUT' end,
    new.amount,
    case when lower(new.type)='in' then 'ARKA CASH IN' else 'ARKA CASH OUT' end,
    coalesce(new.note, ''),
    'ARKA',
    'arka_move_' || new.id::text,
    jsonb_build_object(
      'cycle_id', new.cycle_id,
      'arka_move_id', new.id
    )
  )
  on conflict (external_id) do nothing;

  return new;
end $$;

-- Drop/recreate trigger safely
do $$
begin
  if exists (
    select 1 from pg_trigger where tgname='trg_mirror_arka_move_to_company_budget'
  ) then
    drop trigger trg_mirror_arka_move_to_company_budget on public.arka_cycle_moves;
  end if;
end $$;

create trigger trg_mirror_arka_move_to_company_budget
after insert on public.arka_cycle_moves
for each row
execute function public.mirror_arka_move_to_company_budget();

-- 4) Optional: Backfill (run once) — mirror existing arka moves into company budget
insert into public.company_budget_moves (
  created_at, direction, amount, reason, note, source, external_id, ref
)
select
  coalesce(m.created_at, now()),
  case when lower(m.type)='in' then 'IN' else 'OUT' end,
  m.amount,
  case when lower(m.type)='in' then 'ARKA CASH IN' else 'ARKA CASH OUT' end,
  coalesce(m.note,''),
  'ARKA',
  'arka_move_' || m.id::text,
  jsonb_build_object('cycle_id', m.cycle_id, 'arka_move_id', m.id)
from public.arka_cycle_moves m
on conflict (external_id) do nothing;
