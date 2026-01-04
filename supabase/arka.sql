-- ============================================================
-- TEPIHA — ARKA V2 (CASH ONLY) — Schema + RPC + RLS
-- Drop-in patch: adds new tables/functions WITHOUT touching existing modules.
-- ============================================================

-- Extensions
create extension if not exists pgcrypto;

-- =========================
-- ENUMS
-- =========================
do $$ begin
  create type cash_bucket as enum ('REGISTER', 'COMPANY_SAFE', 'PERSONAL');
exception when duplicate_object then null; end $$;

do $$ begin
  create type cycle_status as enum ('OPEN', 'HANDED', 'RECEIVED');
exception when duplicate_object then null; end $$;

do $$ begin
  create type ledger_type as enum (
    'OPENING_CASH',
    'CARRYOVER_SET',
    'SALE_IN',
    'EXPENSE_OUT',
    'TRANSFER',
    'PAYROLL_OUT',
    'PAYROLL_ADJUST',
    'REVERSAL'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type payroll_kind as enum ('SALARY','ADVANCE','BONUS','PENALTY','ADJUSTMENT');
exception when duplicate_object then null; end $$;

-- =========================
-- WORKERS (PIN + ROLE)
-- =========================
create table if not exists workers (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  pin_hash text not null,
  role text not null default 'WORKER', -- ADMIN / DISPATCH / WORKER
  is_active boolean not null default true,

  base_salary numeric default 0,
  created_at timestamptz not null default now()
);

create index if not exists workers_active_idx on workers(is_active);

-- Helper: set PIN (bcrypt via pgcrypto)
create or replace function workers_v2_set_pin(p_worker_id uuid, p_pin text)
returns void
language plpgsql
security definer
as $$
begin
  update workers
     set pin_hash = crypt(p_pin, gen_salt('bf'))
   where id = p_worker_id;
end;
$$;

-- Verify PIN -> returns worker basic info (or raises)
create or replace function workers_v2_verify_pin(p_pin text)
returns table(id uuid, full_name text, role text)
language plpgsql
security definer
as $$
begin
  return query
  select w.id, w.full_name, w.role
    from workers w
   where w.is_active = true
     and w.pin_hash = crypt(p_pin, w.pin_hash)
   limit 1;

  if not found then
    raise exception 'PIN_INVALID';
  end if;
end;
$$;

-- =========================
-- CASH CYCLES (OPEN → HANDED → RECEIVED)
-- =========================
create table if not exists cash_cycles (
  id uuid primary key default gen_random_uuid(),
  day_key date not null,                 -- Europe/Belgrade local date
  status cycle_status not null default 'OPEN',

  opened_at timestamptz not null default now(),
  opened_by_worker_id uuid references workers(id),
  opening_cash numeric not null default 0,
  opening_source cash_bucket not null,
  opening_person_worker_id uuid references workers(id),
  opening_note text,

  closed_at timestamptz,
  closed_by_worker_id uuid references workers(id),
  carry_cash numeric not null default 0,
  carry_source cash_bucket,
  carry_person_worker_id uuid references workers(id),
  close_note text,

  received_at timestamptz,
  received_by_worker_id uuid references workers(id),
  receive_note text
);

create index if not exists cash_cycles_day_key_idx on cash_cycles(day_key);
create index if not exists cash_cycles_status_idx on cash_cycles(status);

-- =========================
-- CASH LEDGER (AUDIT TRAIL)
-- =========================
create table if not exists cash_ledger (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),

  cycle_id uuid references cash_cycles(id),
  type ledger_type not null,

  amount numeric not null default 0,               -- always positive
  direction text not null check (direction in ('IN','OUT')),

  source_bucket cash_bucket,
  dest_bucket cash_bucket,

  worker_id uuid references workers(id),
  worker_pin_verified boolean not null default false,

  related_order_id uuid,
  related_worker_id uuid references workers(id),

  reason text,
  note text,

  reversed_ledger_id uuid references cash_ledger(id)
);

create index if not exists cash_ledger_cycle_idx on cash_ledger(cycle_id);
create index if not exists cash_ledger_created_at_idx on cash_ledger(created_at);

-- =========================
-- PAYROLL EVENTS
-- =========================
create table if not exists payroll_events (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),

  worker_id uuid not null references workers(id),
  kind payroll_kind not null,

  amount numeric not null,
  is_cash_paid boolean not null default false,

  paid_from_bucket cash_bucket,
  ledger_id uuid references cash_ledger(id),

  created_by_worker_id uuid references workers(id),
  note text
);

create index if not exists payroll_events_worker_idx on payroll_events(worker_id);

-- =========================
-- BALANCES VIEW (derived from ledger)
-- =========================
create or replace view v_cash_balances as
select
  b.bucket,
  coalesce(sum(
    case
      when l.direction='IN'  and l.dest_bucket=b.bucket then l.amount
      when l.direction='OUT' and l.source_bucket=b.bucket then -l.amount
      else 0
    end
  ),0) as balance
from (select unnest(enum_range(NULL::cash_bucket)) as bucket) b
left join cash_ledger l on true
group by b.bucket;

-- ============================================================
-- RPC — CORE GUARDS + OPERATIONS
-- ============================================================

-- Get latest cycle that is OPEN or HANDED (if any)
create or replace function arka_v2_get_active_cycle()
returns table(
  id uuid,
  day_key date,
  status cycle_status,
  opened_at timestamptz,
  closed_at timestamptz,
  received_at timestamptz,
  opening_cash numeric,
  carry_cash numeric
)
language sql
security definer
as $$
  select c.id, c.day_key, c.status, c.opened_at, c.closed_at, c.received_at, c.opening_cash, c.carry_cash
    from cash_cycles c
   where c.status in ('OPEN','HANDED')
   order by c.opened_at desc
   limit 1;
$$;

-- Helper: insert ledger row and return it
create or replace function arka_v2_insert_ledger(
  p_cycle_id uuid,
  p_type ledger_type,
  p_amount numeric,
  p_direction text,
  p_source cash_bucket,
  p_dest cash_bucket,
  p_worker_id uuid,
  p_pin_verified boolean,
  p_related_order_id uuid,
  p_related_worker_id uuid,
  p_reason text,
  p_note text
)
returns cash_ledger
language plpgsql
security definer
as $$
declare
  v_row cash_ledger;
begin
  if p_amount is null or p_amount < 0 then
    raise exception 'AMOUNT_INVALID';
  end if;

  if p_direction not in ('IN','OUT') then
    raise exception 'DIRECTION_INVALID';
  end if;

  insert into cash_ledger(
    cycle_id, type, amount, direction, source_bucket, dest_bucket,
    worker_id, worker_pin_verified, related_order_id, related_worker_id, reason, note
  ) values (
    p_cycle_id, p_type, p_amount, p_direction, p_source, p_dest,
    p_worker_id, coalesce(p_pin_verified,false), p_related_order_id, p_related_worker_id, p_reason, p_note
  )
  returning * into v_row;

  return v_row;
end;
$$;

-- Guard: cannot open new cycle if any HANDED exists unreceived
create or replace function arka_v2_open_cycle(
  p_day_key date,
  p_opened_by uuid,
  p_opening_cash numeric,
  p_opening_source cash_bucket,
  p_opening_person uuid,
  p_note text
)
returns cash_cycles
language plpgsql
security definer
as $$
declare
  v_blocked int;
  v_cycle cash_cycles;
begin
  select count(*) into v_blocked
    from cash_cycles
   where status = 'HANDED';

  if v_blocked > 0 then
    raise exception 'GUARD_HANDED_NOT_RECEIVED';
  end if;

  if p_opening_source = 'PERSONAL' and p_opening_person is null then
    raise exception 'PERSONAL_PIN_REQUIRED';
  end if;

  insert into cash_cycles(
    day_key, status,
    opened_by_worker_id, opening_cash, opening_source, opening_person_worker_id, opening_note
  ) values (
    p_day_key, 'OPEN',
    p_opened_by, coalesce(p_opening_cash,0), p_opening_source, p_opening_person, p_note
  ) returning * into v_cycle;

  -- opening cash enters REGISTER (audit)
  perform arka_v2_insert_ledger(
    v_cycle.id,
    'OPENING_CASH',
    coalesce(p_opening_cash,0),
    'IN',
    null,
    'REGISTER',
    p_opened_by,
    true,
    null,
    null,
    'OPEN_CYCLE',
    p_note
  );

  return v_cycle;
end;
$$;

-- Close cycle -> sets carryover and status=HANDED
create or replace function arka_v2_close_cycle(
  p_cycle_id uuid,
  p_closed_by uuid,
  p_carry_cash numeric,
  p_carry_source cash_bucket,
  p_carry_person uuid,
  p_note text
)
returns cash_cycles
language plpgsql
security definer
as $$
declare
  v_cycle cash_cycles;
begin
  select * into v_cycle from cash_cycles where id = p_cycle_id for update;
  if not found then raise exception 'CYCLE_NOT_FOUND'; end if;

  if v_cycle.status <> 'OPEN' then
    raise exception 'CYCLE_NOT_OPEN';
  end if;

  if p_carry_source = 'PERSONAL' and p_carry_person is null then
    raise exception 'PERSONAL_PIN_REQUIRED';
  end if;

  update cash_cycles
     set closed_at = now(),
         closed_by_worker_id = p_closed_by,
         carry_cash = coalesce(p_carry_cash,0),
         carry_source = p_carry_source,
         carry_person_worker_id = p_carry_person,
         close_note = p_note,
         status = 'HANDED'
   where id = p_cycle_id
   returning * into v_cycle;

  -- carryover is a "declared left in drawer" audit marker
  perform arka_v2_insert_ledger(
    v_cycle.id,
    'CARRYOVER_SET',
    coalesce(p_carry_cash,0),
    'IN',
    null,
    'REGISTER',
    p_closed_by,
    true,
    null,
    null,
    'CLOSE_CYCLE',
    p_note
  );

  return v_cycle;
end;
$$;

-- Receive from dispatch -> status=RECEIVED, optional TRANSFER REGISTER->COMPANY_SAFE
create or replace function arka_v2_receive_cycle(
  p_cycle_id uuid,
  p_received_by uuid,
  p_note text,
  p_do_transfer boolean,
  p_transfer_amount numeric
)
returns cash_cycles
language plpgsql
security definer
as $$
declare
  v_cycle cash_cycles;
  v_amount numeric;
begin
  select * into v_cycle from cash_cycles where id = p_cycle_id for update;
  if not found then raise exception 'CYCLE_NOT_FOUND'; end if;

  if v_cycle.status <> 'HANDED' then
    raise exception 'CYCLE_NOT_HANDED';
  end if;

  update cash_cycles
     set received_at = now(),
         received_by_worker_id = p_received_by,
         receive_note = p_note,
         status = 'RECEIVED'
   where id = p_cycle_id
   returning * into v_cycle;

  if coalesce(p_do_transfer,false) = true then
    v_amount := coalesce(p_transfer_amount,0);

    if v_amount <= 0 then
      raise exception 'TRANSFER_AMOUNT_REQUIRED';
    end if;

    perform arka_v2_insert_ledger(
      v_cycle.id,
      'TRANSFER',
      v_amount,
      'OUT',
      'REGISTER',
      'COMPANY_SAFE',
      p_received_by,
      true,
      null,
      null,
      'DISPATCH_RECEIVE_TRANSFER',
      p_note
    );

    perform arka_v2_insert_ledger(
      v_cycle.id,
      'TRANSFER',
      v_amount,
      'IN',
      'REGISTER',
      'COMPANY_SAFE',
      p_received_by,
      true,
      null,
      null,
      'DISPATCH_RECEIVE_TRANSFER',
      p_note
    );
  end if;

  return v_cycle;
end;
$$;

-- Add expense (OUT from bucket)
create or replace function arka_v2_add_expense(
  p_cycle_id uuid,
  p_amount numeric,
  p_from_bucket cash_bucket,
  p_worker_id uuid,
  p_reason text,
  p_note text
)
returns cash_ledger
language plpgsql
security definer
as $$
begin
  if p_amount is null or p_amount <= 0 then raise exception 'AMOUNT_INVALID'; end if;
  if p_from_bucket not in ('REGISTER','COMPANY_SAFE') then raise exception 'BUCKET_INVALID'; end if;

  return arka_v2_insert_ledger(
    p_cycle_id,
    'EXPENSE_OUT',
    p_amount,
    'OUT',
    p_from_bucket,
    null,
    p_worker_id,
    true,
    null,
    null,
    p_reason,
    p_note
  );
end;
$$;

-- Add sale/payment IN to REGISTER (or safe if needed)
create or replace function arka_v2_add_sale_in(
  p_cycle_id uuid,
  p_amount numeric,
  p_to_bucket cash_bucket,
  p_worker_id uuid,
  p_related_order_id uuid,
  p_note text
)
returns cash_ledger
language plpgsql
security definer
as $$
begin
  if p_amount is null or p_amount <= 0 then raise exception 'AMOUNT_INVALID'; end if;

  return arka_v2_insert_ledger(
    p_cycle_id,
    'SALE_IN',
    p_amount,
    'IN',
    null,
    coalesce(p_to_bucket,'REGISTER'),
    p_worker_id,
    true,
    p_related_order_id,
    null,
    'SALE',
    p_note
  );
end;
$$;

-- Payroll cash out (OUT from REGISTER or COMPANY_SAFE) + payroll_events row
create or replace function arka_v2_payroll_cash_out(
  p_cycle_id uuid,
  p_target_worker uuid,
  p_kind payroll_kind,
  p_amount numeric,
  p_from_bucket cash_bucket,
  p_created_by uuid,
  p_note text
)
returns payroll_events
language plpgsql
security definer
as $$
declare
  v_ledger cash_ledger;
  v_evt payroll_events;
begin
  if p_amount is null or p_amount <= 0 then raise exception 'AMOUNT_INVALID'; end if;
  if p_from_bucket not in ('REGISTER','COMPANY_SAFE') then raise exception 'BUCKET_INVALID'; end if;

  v_ledger := arka_v2_insert_ledger(
    p_cycle_id,
    'PAYROLL_OUT',
    p_amount,
    'OUT',
    p_from_bucket,
    null,
    p_created_by,
    true,
    null,
    p_target_worker,
    p_kind::text,
    p_note
  );

  insert into payroll_events(
    worker_id, kind, amount, is_cash_paid, paid_from_bucket, ledger_id, created_by_worker_id, note
  ) values (
    p_target_worker, p_kind, p_amount, true, p_from_bucket, v_ledger.id, p_created_by, p_note
  ) returning * into v_evt;

  return v_evt;
end;
$$;

-- Payroll adjustment (no cash movement) — logs payroll_events only + ledger PAYROLL_ADJUST (direction IN to REGISTER with amount 0)
create or replace function arka_v2_payroll_adjustment(
  p_cycle_id uuid,
  p_target_worker uuid,
  p_kind payroll_kind,
  p_amount numeric,
  p_created_by uuid,
  p_note text
)
returns payroll_events
language plpgsql
security definer
as $$
declare
  v_evt payroll_events;
begin
  if p_amount is null or p_amount = 0 then raise exception 'AMOUNT_INVALID'; end if;

  insert into payroll_events(
    worker_id, kind, amount, is_cash_paid, created_by_worker_id, note
  ) values (
    p_target_worker, p_kind, p_amount, false, p_created_by, p_note
  ) returning * into v_evt;

  -- optional ledger marker (0 cash) for audit grouping
  perform arka_v2_insert_ledger(
    p_cycle_id,
    'PAYROLL_ADJUST',
    abs(p_amount),
    'IN',
    null,
    'REGISTER',
    p_created_by,
    true,
    null,
    p_target_worker,
    'ADJUST',
    p_note
  );

  return v_evt;
end;
$$;

-- ============================================================
-- RLS (permissive anon policies — PIN logic enforced in app/RPC)
-- ============================================================
alter table workers enable row level security;
alter table cash_cycles enable row level security;
alter table cash_ledger enable row level security;
alter table payroll_events enable row level security;

do $$ begin
  create policy "anon_read_workers_v2" on workers for select to anon using (true);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "anon_rw_cash_cycles_v2" on cash_cycles for all to anon using (true) with check (true);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "anon_rw_cash_ledger_v2" on cash_ledger for all to anon using (true) with check (true);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "anon_rw_payroll_events_v2" on payroll_events for all to anon using (true) with check (true);
exception when duplicate_object then null; end $$;

-- Allow anon to execute RPCs
grant execute on function workers_v2_verify_pin(text) to anon;
grant execute on function workers_v2_set_pin(uuid,text) to anon;
grant execute on function arka_v2_get_active_cycle() to anon;
grant execute on function arka_v2_open_cycle(date,uuid,numeric,cash_bucket,uuid,text) to anon;
grant execute on function arka_v2_close_cycle(uuid,uuid,numeric,cash_bucket,uuid,text) to anon;
grant execute on function arka_v2_receive_cycle(uuid,uuid,text,boolean,numeric) to anon;
grant execute on function arka_v2_add_expense(uuid,numeric,cash_bucket,uuid,text,text) to anon;
grant execute on function arka_v2_add_sale_in(uuid,numeric,cash_bucket,uuid,uuid,text) to anon;
grant execute on function arka_v2_payroll_cash_out(uuid,uuid,payroll_kind,numeric,cash_bucket,uuid,text) to anon;
grant execute on function arka_v2_payroll_adjustment(uuid,uuid,payroll_kind,numeric,uuid,text) to anon;
