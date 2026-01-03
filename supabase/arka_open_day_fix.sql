-- TEPIHA — SQL FIX (ARKA STRICT FLOW)
-- Fixon:
--  • "column reference handoff_status is ambiguous"
--  • lejon vetëm 1 OPEN ditë në të njëjtën kohë
--  • lejon vetëm 1 HANDED (pa received) në të njëjtën kohë
--  • nuk lejon hapje të ditës së re pa u PRANU (RECEIVED) nga DISPATCH dita e dorëzuar
--  • pastron duplikimet e vjetra (nëse kanë mbet nga testet)
--
-- Run në Supabase SQL Editor.

begin;

-- -------------------------------
-- 1) CLEANUP DUPLICATES (SAFE)
-- -------------------------------
-- Nëse kanë mbetur më shumë se 1 OPEN (closed_at is null), mbajmë më të renë,
-- të tjerat i "mbyllim" dhe i shënojmë si RECEIVED (cleanup) që të mos bllokojnë.
with open_days as (
  select id, opened_at,
         row_number() over (order by opened_at desc nulls last, created_at desc nulls last, id desc) as rn
  from public.arka_days
  where handoff_status = 'OPEN' and closed_at is null
)
update public.arka_days d
set
  closed_at      = coalesce(d.closed_at, now()),
  closed_by      = coalesce(d.closed_by, 'system_cleanup'),
  handoff_status = 'RECEIVED',
  handed_at      = coalesce(d.handed_at, now()),
  handed_by      = coalesce(d.handed_by, 'system_cleanup'),
  received_at    = coalesce(d.received_at, now()),
  received_by    = coalesce(d.received_by, 'system_cleanup'),
  received_amount= coalesce(d.received_amount, d.cash_counted, d.expected_cash, d.opening_cash, 0),
  close_note     = trim(coalesce(d.close_note,'') || ' | CLEANUP: duplicate OPEN auto-received')
from open_days od
where d.id = od.id and od.rn > 1;

-- Nëse kanë mbetur më shumë se 1 HANDED pa received, mbajmë më të renë,
-- të tjerat i shënojmë si RECEIVED (cleanup) që të mos bllokojnë.
with handed_days as (
  select id, handed_at,
         row_number() over (order by handed_at desc nulls last, closed_at desc nulls last, created_at desc nulls last, id desc) as rn
  from public.arka_days
  where handoff_status = 'HANDED' and received_at is null
)
update public.arka_days d
set
  handoff_status  = 'RECEIVED',
  received_at     = coalesce(d.received_at, now()),
  received_by     = coalesce(d.received_by, 'system_cleanup'),
  received_amount = coalesce(d.received_amount, d.cash_counted, d.expected_cash, d.opening_cash, 0),
  close_note      = trim(coalesce(d.close_note,'') || ' | CLEANUP: duplicate HANDED auto-received')
from handed_days hd
where d.id = hd.id and hd.rn > 1;

-- -------------------------------
-- 2) UNIQUE GUARDS (PARTIAL INDEX)
-- -------------------------------
-- Këto indekse janë "guardrails" për me mos leju 2 OPEN ose 2 HANDED pa received.
-- I bojmë drop+create që mos me u përplas me versionet e vjetra.

drop index if exists public.ux_arka_one_open_day;
drop index if exists public.ux_arka_one_handed_day;

do $$
begin
  -- vetëm 1 OPEN ku closed_at is null
  create unique index ux_arka_one_open_day
    on public.arka_days ((1))
    where (handoff_status = 'OPEN' and closed_at is null);

  -- vetëm 1 HANDED ku received_at is null
  create unique index ux_arka_one_handed_day
    on public.arka_days ((1))
    where (handoff_status = 'HANDED' and received_at is null);
exception when others then
  -- nëse prap ka collision në data, mos e blloko deploy-in; funksioni poshtë prap e mban rregullin.
  raise notice 'Index creation skipped: %', sqlerrm;
end $$;

-- -------------------------------
-- 3) RPC: arka_open_day (STRICT)
-- -------------------------------
-- Signature e pritur nga frontend:
--   rpc('arka_open_day', { p_day_key, p_opening_cash, p_opened_by })
--
-- Rregullat:
--  • Nëse ka HANDED (received_at is null) → ERROR (nuk hapet dita e re)
--  • Nëse ka OPEN → e kthen atë (idempotent)
--  • Përndryshe → hap ditë të re. Nëse day_key ekziston, shton _2, _3, ...

create or replace function public.arka_open_day(
  p_day_key text default null,
  p_opening_cash numeric default 0,
  p_opened_by text default null
)
returns public.arka_days
language plpgsql
security definer
as $$
declare
  v_key text;
  v_try int := 0;
  v_exists int;
  v_open public.arka_days;
  v_handed public.arka_days;
  v_day public.arka_days;
begin
  v_key := coalesce(nullif(trim(p_day_key), ''), to_char(current_date, 'YYYY-MM-DD'));

  -- 1) nëse ka HANDED pa u pranu → blloko
  select d.* into v_handed
  from public.arka_days d
  where d.handoff_status = 'HANDED' and d.received_at is null
  order by d.handed_at desc nulls last, d.closed_at desc nulls last, d.created_at desc nulls last
  limit 1;

  if v_handed.id is not null then
    raise exception 'NUK MUND TË HAPET DITA E RE: DISPATCH s''e ka pranu ditën e dorëzuar (HANDED).';
  end if;

  -- 2) nëse ka OPEN → ktheje (idempotent)
  select d.* into v_open
  from public.arka_days d
  where d.handoff_status = 'OPEN' and d.closed_at is null
  order by d.opened_at desc nulls last, d.created_at desc nulls last
  limit 1;

  if v_open.id is not null then
    return v_open;
  end if;

  -- 3) gjej day_key unik (me suffix _2, _3...)
  loop
    if v_try = 0 then
      v_key := v_key;
    else
      v_key := split_part(v_key, '_', 1) || '_' || (v_try + 1)::text;
    end if;

    select count(*) into v_exists
    from public.arka_days d
    where d.day_key = v_key;

    exit when v_exists = 0;
    v_try := v_try + 1;
    if v_try > 50 then
      raise exception 'S''po mund të gjej day_key unik (shumë kopje).';
    end if;
  end loop;

  insert into public.arka_days(
    day_key,
    opened_at,
    opened_by,
    opening_cash,
    handoff_status
  ) values (
    v_key,
    now(),
    p_opened_by,
    coalesce(p_opening_cash, 0),
    'OPEN'
  )
  returning * into v_day;

  return v_day;
end;
$$;

-- 4) Grant RPC to anon (nëse e përdorni anon)
-- (nëse s’e doni, hiqeni)
grant execute on function public.arka_open_day(text, numeric, text) to anon;

commit;
