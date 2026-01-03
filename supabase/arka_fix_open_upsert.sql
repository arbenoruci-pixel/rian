-- Fix duplicate day_key on OPEN: make arka_open_day_strict UPSERT by day_key
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
  v public.arka_days%rowtype;
begin
  -- Block if any HANDED not RECEIVED exists
  select d.id into v_pending
  from public.arka_days d
  where d.handoff_status = 'HANDED'
    and d.received_at is null
  order by d.closed_at desc nulls last
  limit 1;

  if v_pending is not null then
    raise exception 'DISPATCH_PENDING: pending day % needs DISPATCH receive', v_pending;
  end if;

  insert into public.arka_days(
    day_key, initial_cash, opened_by, open_source, open_person_pin,
    opened_at, handoff_status,
    closed_at, closed_by, expected_cash, cash_counted, discrepancy, close_note,
    handed_at, handed_by, received_at, received_by, received_amount,
    carryover_cash, carryover_source, carryover_person_pin
  )
  values (
    p_day_key,
    coalesce(p_initial_cash,0),
    p_opened_by,
    p_open_source,
    case when p_open_source='PERSONAL' then p_open_person_pin else null end,
    now(),
    'OPEN',
    null, null, null, null, null, null,
    null, null, null, null, null,
    0, null, null
  )
  on conflict (day_key) do update
    set opened_at = now(),
        opened_by = excluded.opened_by,
        initial_cash = excluded.initial_cash,
        open_source = excluded.open_source,
        open_person_pin = excluded.open_person_pin,
        handoff_status = 'OPEN',
        closed_at = null,
        closed_by = null,
        expected_cash = null,
        cash_counted = null,
        discrepancy = null,
        close_note = null,
        handed_at = null,
        handed_by = null,
        received_at = null,
        received_by = null,
        received_amount = null
  returning * into v;

  return v;
end $$;

do $$
begin
  perform pg_notify('pgrst', 'reload schema');
exception when others then
  null;
end $$;
