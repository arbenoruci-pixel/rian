-- TEPIHA — COMPANY BUDGET (BUXHETI I KOMPANISE)
--
-- QELLIMI
-- 1) Krijon tabelen public.company_budget_moves (me UUID id).
-- 2) Sinkronizon AUTOMATIKISHT ARKEN me buxhetin:
--    cdo INSERT ne public.arka_cycle_moves -> kopjohet ne company_budget_moves.
--
-- SHENIM
-- - Nuk perdorim sequences fare.
-- - ID eshte UUID (gen_random_uuid()).

-- 0) UUID extension (per gen_random_uuid)
create extension if not exists pgcrypto;

-- 1) Tabela kryesore e buxhetit
create table if not exists public.company_budget_moves (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  direction text not null check (direction in ('IN','OUT')),
  amount numeric not null check (amount >= 0),
  reason text,
  note text,
  source text not null default 'MANUAL',
  external_id text,
  ref jsonb not null default '{}'::jsonb
);

-- Ndalon dublikatat nga sinkronizimi (idempotent)
create unique index if not exists company_budget_moves_external_id_unique
  on public.company_budget_moves (external_id)
  where external_id is not null;

create index if not exists idx_company_budget_moves_created_at
  on public.company_budget_moves (created_at desc);

-- 2) View per totalet
create or replace view public.company_budget_summary as
select
  coalesce(sum(case when direction='IN' then amount end), 0) as in_total,
  coalesce(sum(case when direction='OUT' then amount end), 0) as out_total,
  coalesce(sum(case when direction='IN' then amount else -amount end), 0) as balance,
  max(created_at) as last_move_at
from public.company_budget_moves;

-- 3) Trigger: ARKA -> BUXHET
--    Cdo levizje cash (arka_cycle_moves) futet edhe ne company_budget_moves.
--    (Nese arka_cycle_moves s'ekziston, ky seksion do deshtoje -
--     prandaj SIGUROHU qe ARKA eshte krijuar me pare.)

create or replace function public.sync_arka_move_to_company_budget()
returns trigger
language plpgsql
as $$
declare
  v_type text;
  v_ext text;
  v_id text;
  v_cycle text;
  v_note text;
  v_amount numeric;
begin
  -- lexim robust (pa u lidh ne emra kolona shtese)
  v_type := coalesce(to_jsonb(new)->>'type', '');
  v_id := coalesce(to_jsonb(new)->>'id', '');
  v_cycle := coalesce(to_jsonb(new)->>'cycle_id', '');
  v_note := to_jsonb(new)->>'note';
  v_ext := nullif(to_jsonb(new)->>'external_id', '');

  begin
    v_amount := (to_jsonb(new)->>'amount')::numeric;
  exception when others then
    v_amount := 0;
  end;

  if v_ext is null then
    v_ext := 'arka_move_' || v_id;
  end if;

  insert into public.company_budget_moves(
    direction,
    amount,
    reason,
    note,
    source,
    external_id,
    ref
  )
  values(
    case when upper(v_type)='OUT' then 'OUT' else 'IN' end,
    v_amount,
    case when upper(v_type)='OUT' then 'ARKA CASH OUT' else 'ARKA CASH IN' end,
    v_note,
    'ARKA',
    v_ext,
    jsonb_build_object('cycle_id', v_cycle, 'arka_move_id', v_id)
  )
  on conflict (external_id) do nothing;

  return new;
end;
$$;

drop trigger if exists trg_sync_arka_move_to_company_budget on public.arka_cycle_moves;
create trigger trg_sync_arka_move_to_company_budget
after insert on public.arka_cycle_moves
for each row
execute function public.sync_arka_move_to_company_budget();

-- 4) RLS / POLICIES (ANON) — per web app pa login.
alter table public.company_budget_moves enable row level security;

drop policy if exists "cbm_select_anon" on public.company_budget_moves;
drop policy if exists "cbm_insert_anon" on public.company_budget_moves;
drop policy if exists "cbm_update_anon" on public.company_budget_moves;
drop policy if exists "cbm_delete_anon" on public.company_budget_moves;

create policy "cbm_select_anon" on public.company_budget_moves
for select using (true);

create policy "cbm_insert_anon" on public.company_budget_moves
for insert with check (true);

create policy "cbm_update_anon" on public.company_budget_moves
for update using (true) with check (true);

create policy "cbm_delete_anon" on public.company_budget_moves
for delete using (true);

grant select, insert, update, delete on public.company_budget_moves to anon;
grant select on public.company_budget_summary to anon;
