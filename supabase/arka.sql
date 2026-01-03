/* TEPIHA — ARKA (CASH ONLY) — NON-V2 CONSOLIDATED SQL
   Run in Supabase SQL Editor.

   Tables:
   - arka_days  (OPEN → HANDED → RECEIVED)
   - arka_moves (IN/OUT)

   RPC:
   - arka_open_day_strict(day_key, initial_cash, opened_by, open_source, open_person_pin)
   - arka_close_day(day_id, cash_counted, closed_by, expected_cash, close_note, carryover_*)
   - arka_receive_day(day_id, received_by)
   - arka_get_history_days(days)
*/

create table if not exists public.arka_days (
  id bigserial primary key,
  day_key text,
  opened_at timestamptz not null default now(),
  opened_by text,
  initial_cash numeric not null default 0,

  open_source text default 'COMPANY',
  open_person_pin text,

  closed_at timestamptz,
  closed_by text,
  expected_cash numeric,
  cash_counted numeric,
  discrepancy numeric,
  close_note text,

  handoff_status text default 'OPEN',
  handed_at timestamptz,
  handed_by text,
  received_at timestamptz,
  received_by text,
  received_amount numeric,

  carryover_cash numeric default 0,
  carryover_source text,
  carryover_person_pin text
);

alter table public.arka_days add column if not exists day_key text;

update public.arka_days
set day_key = coalesce(day_key, to_char(opened_at::date,'YYYY-MM-DD'))
where day_key is null;

create unique index if not exists arka_days_day_key_uq on public.arka_days(day_key);

create table if not exists public.arka_moves (
  id bigserial primary key,
  day_id bigint references public.arka_days(id) on delete set null,
  type text not null check (type in ('IN','OUT')),
  amount numeric not null check (amount >= 0),
  note text,
  source text default 'CASH',
  created_by text,
  external_id text,
  created_at timestamptz not null default now()
);

create index if not exists arka_moves_day_id_idx on public.arka_moves(day_id);
create index if not exists arka_moves_ext_id_idx on public.arka_moves(external_id);

alter table public.arka_days enable row level security;
alter table public.arka_moves enable row level security;

do $$ begin
  create policy "anon_read_arka_days" on public.arka_days for select using (true);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "anon_write_arka_days" on public.arka_days for insert with check (true);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "anon_update_arka_days" on public.arka_days for update using (true) with check (true);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "anon_read_arka_moves" on public.arka_moves for select using (true);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "anon_write_arka_moves" on public.arka_moves for insert with check (true);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "anon_update_arka_moves" on public.arka_moves for update using (true) with check (true);
exception when duplicate_object then null; end $$;

create or replace function public.arka_open_day_strict(
  p_day_key text,
  p_initial_cash numeric,
  p_opened_by text,
  p_open_source text default 'COMPANY',
  p_open_person_pin text default null
)
returns table (
  id bigint,
  day_key text,
  opened_at timestamptz,
  opened_by text,
  initial_cash numeric,
  handoff_status text
)
language plpgsql
as $$
declare
  v_pending bigint;
  v_existing public.arka_days%rowtype;
begin
  select d.id into v_pending
  from public.arka_days d
  where d.handoff_status = 'HANDED'
    and d.received_at is null
  order by d.closed_at desc nulls last
  limit 1;

  if v_pending is not null then
    raise exception 'DISPATCH_PENDING: pending day id % needs DISPATCH receive', v_pending;
  end if;

  select * into v_existing
  from public.arka_days
  where day_key = p_day_key
  limit 1;

  if v_existing.id is not null and v_existing.closed_at is null then
    return query
    select v_existing.id, v_existing.day_key, v_existing.opened_at, v_existing.opened_by, v_existing.initial_cash, v_existing.handoff_status;
    return;
  end if;

  if v_existing.id is not null then
    update public.arka_days
      set closed_at = null,
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
          received_amount = null,
          initial_cash = p_initial_cash,
          opened_by = p_opened_by,
          open_source = p_open_source,
          open_person_pin = p_open_person_pin
    where id = v_existing.id;

    return query
    select v_existing.id, p_day_key, (select opened_at from public.arka_days where id=v_existing.id), p_opened_by, p_initial_cash, 'OPEN';
    return;
  end if;

  insert into public.arka_days(day_key, initial_cash, opened_by, open_source, open_person_pin, handoff_status)
  values (p_day_key, p_initial_cash, p_opened_by, p_open_source, p_open_person_pin, 'OPEN')
  returning public.arka_days.id, public.arka_days.day_key, public.arka_days.opened_at, public.arka_days.opened_by, public.arka_days.initial_cash, public.arka_days.handoff_status
  into id, day_key, opened_at, opened_by, initial_cash, handoff_status;

  return query select id, day_key, opened_at, opened_by, initial_cash, handoff_status;
end $$;

create or replace function public.arka_close_day(
  p_day_id bigint,
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
      carryover_person_pin = p_carryover_person_pin
  where id = p_day_id
  returning * into v;

  return v;
end $$;

create or replace function public.arka_receive_day(
  p_day_id bigint,
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

create or replace function public.arka_get_history_days(p_days integer default 30)
returns setof public.arka_days
language sql
as $$
  select *
  from public.arka_days
  order by opened_at desc
  limit greatest(coalesce(p_days,30),1);
$$;

do $$
begin
  perform pg_notify('pgrst', 'reload schema');
exception when others then
  null;
end $$;
