/* TEPIHA — ARKA (CASH ONLY) — RESET + UUID SCHEMA
   Because you do NOT need to keep old data.

   RUN THIS ENTIRE FILE in Supabase SQL Editor.

   What it does:
   - Drops old ARKA tables/functions (including any v2 leftovers) if they exist
   - Creates fresh UUID-based schema:
       arka_days (cycle/day)
       arka_moves (cash in/out)
   - Creates RPCs used by the app:
       arka_open_day_strict, arka_close_day, arka_receive_day, arka_get_history_days
   - Enables RLS with anon select/insert/update (like your dev mode)
*/

-- =========
-- Extensions
-- =========
create extension if not exists "pgcrypto";

-- =========
-- Drop old functions (ignore if missing)
-- =========
drop function if exists public.arka_open_day_strict(text,numeric,text,text,text);
drop function if exists public.arka_close_day(uuid,numeric,text,numeric,text,numeric,text,text);
drop function if exists public.arka_receive_day(uuid,text);
drop function if exists public.arka_get_history_days(integer);

-- v2 leftovers (ignore if missing)
drop function if exists public.arka_v2_get_active_cycle();
drop function if exists public.arka_v2_open_cycle(jsonb);
drop function if exists public.arka_v2_close_cycle(jsonb);
drop function if exists public.arka_v2_receive_cycle(jsonb);

-- =========
-- Drop old tables (ignore if missing)
-- =========
drop table if exists public.arka_moves cascade;
drop table if exists public.arka_days cascade;
drop table if exists public.cash_cycles cascade;
drop table if exists public.cash_moves cascade;

-- =========
-- Create tables (UUID)
-- =========
create table public.arka_days (
  id uuid primary key default gen_random_uuid(),
  day_key text unique not null,              -- 'YYYY-MM-DD'
  opened_at timestamptz not null default now(),
  opened_by text,
  initial_cash numeric not null default 0,

  open_source text default 'COMPANY',        -- COMPANY | PERSONAL | OTHER
  open_person_pin text,                      -- required if PERSONAL

  closed_at timestamptz,
  closed_by text,
  expected_cash numeric,
  cash_counted numeric,
  discrepancy numeric,
  close_note text,

  handoff_status text default 'OPEN',        -- OPEN | HANDED | RECEIVED
  handed_at timestamptz,
  handed_by text,
  received_at timestamptz,
  received_by text,
  received_amount numeric,

  carryover_cash numeric default 0,
  carryover_source text,
  carryover_person_pin text
);

create table public.arka_moves (
  id uuid primary key default gen_random_uuid(),
  day_id uuid references public.arka_days(id) on delete cascade,
  type text not null check (type in ('IN','OUT')),
  amount numeric not null check (amount >= 0),
  note text,
  source text default 'CASH',
  created_by text,
  external_id text unique,
  created_at timestamptz not null default now()
);

create index arka_moves_day_id_idx on public.arka_moves(day_id);

-- =========
-- RLS (dev mode: anon read/write)
-- =========
alter table public.arka_days enable row level security;
alter table public.arka_moves enable row level security;

drop policy if exists anon_read_arka_days on public.arka_days;
drop policy if exists anon_write_arka_days on public.arka_days;
drop policy if exists anon_update_arka_days on public.arka_days;

drop policy if exists anon_read_arka_moves on public.arka_moves;
drop policy if exists anon_write_arka_moves on public.arka_moves;
drop policy if exists anon_update_arka_moves on public.arka_moves;

create policy anon_read_arka_days on public.arka_days for select using (true);
create policy anon_write_arka_days on public.arka_days for insert with check (true);
create policy anon_update_arka_days on public.arka_days for update using (true) with check (true);

create policy anon_read_arka_moves on public.arka_moves for select using (true);
create policy anon_write_arka_moves on public.arka_moves for insert with check (true);
create policy anon_update_arka_moves on public.arka_moves for update using (true) with check (true);

-- =========
-- RPC: OPEN (with DISPATCH guard)
-- =========
create or replace function public.arka_open_day_strict(
  p_day_key text,
  p_initial_cash numeric,
  p_opened_by text,
  p_open_source text default 'COMPANY',
  p_open_person_pin text default null
)
returns public.arka_days
language plpgsql
as $$
declare
  v_pending uuid;
  v_existing public.arka_days%rowtype;
  v public.arka_days%rowtype;
begin
  -- block if any HANDED not RECEIVED exists
  select d.id into v_pending
  from public.arka_days d
  where d.handoff_status = 'HANDED'
    and d.received_at is null
  order by d.closed_at desc nulls last
  limit 1;

  if v_pending is not null then
    raise exception 'DISPATCH_PENDING: pending day % needs DISPATCH receive', v_pending;
  end if;

  select * into v_existing
  from public.arka_days
  where day_key = p_day_key
  limit 1;

  if v_existing.id is not null and v_existing.closed_at is null then
    return v_existing;
  end if;

  if v_existing.id is not null then
    update public.arka_days
      set opened_at = now(),
          opened_by = p_opened_by,
          initial_cash = p_initial_cash,
          open_source = p_open_source,
          open_person_pin = case when p_open_source='PERSONAL' then p_open_person_pin else null end,
          closed_at = null,
          closed_by = null,
          expected_cash = null,
          cash_counted = null,
          discrepancy = null,
          close_note = null,
          handoff_status = 'OPEN',
          handed_at = null,
          handed_by = null,
          received_at = null,
          received_by = null,
          received_amount = null
    where id = v_existing.id
    returning * into v;

    return v;
  end if;

  insert into public.arka_days(day_key, initial_cash, opened_by, open_source, open_person_pin, handoff_status)
  values (p_day_key, p_initial_cash, p_opened_by, p_open_source,
          case when p_open_source='PERSONAL' then p_open_person_pin else null end,
          'OPEN')
  returning * into v;

  return v;
end $$;

-- =========
-- RPC: CLOSE -> HANDED
-- =========
create or replace function public.arka_close_day(
  p_day_id uuid,
  p_cash_counted numeric,
  p_closed_by text,
  p_expected_cash numeric default null,
  p_close_note text default null,
  p_carryover_cash numeric default 0,
  p_carryover_source text default null,
  p_carryover_person_pin text default null
)
returns public.arka_days
language plpgsql
as $$
declare
  v public.arka_days%rowtype;
begin
  update public.arka_days
  set closed_at = now(),
      closed_by = p_closed_by,
      expected_cash = p_expected_cash,
      cash_counted = p_cash_counted,
      discrepancy = case when p_expected_cash is null then null else (p_cash_counted - p_expected_cash) end,
      close_note = p_close_note,
      handoff_status = 'HANDED',
      handed_at = now(),
      handed_by = p_closed_by,
      carryover_cash = coalesce(p_carryover_cash,0),
      carryover_source = p_carryover_source,
      carryover_person_pin = case when p_carryover_source='PERSONAL' then p_carryover_person_pin else null end
  where id = p_day_id
  returning * into v;

  return v;
end $$;

-- =========
-- RPC: DISPATCH RECEIVE
-- =========
create or replace function public.arka_receive_day(
  p_day_id uuid,
  p_received_by text
)
returns public.arka_days
language plpgsql
as $$
declare
  v public.arka_days%rowtype;
begin
  update public.arka_days
  set handoff_status = 'RECEIVED',
      received_at = now(),
      received_by = p_received_by,
      received_amount = greatest(coalesce(cash_counted,0) - coalesce(carryover_cash,0), 0)
  where id = p_day_id
  returning * into v;

  return v;
end $$;

-- =========
-- RPC: HISTORY
-- =========
create or replace function public.arka_get_history_days(p_days integer default 30)
returns setof public.arka_days
language sql
as $$
  select *
  from public.arka_days
  order by opened_at desc
  limit greatest(coalesce(p_days,30),1);
$$;

-- =========
-- Ask PostgREST to reload schema (best effort)
-- =========
do $$
begin
  perform pg_notify('pgrst', 'reload schema');
exception when others then
  null;
end $$;
