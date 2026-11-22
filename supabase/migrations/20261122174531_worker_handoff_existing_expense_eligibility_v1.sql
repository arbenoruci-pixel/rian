-- Historical accepted expenses are not new requests. A reusable accepted
-- expense must retain its exact active business-expense OUT and no settlement
-- or handover linkage. This migration changes eligibility, never historical data.
create index if not exists worker_handoff_claims_submission_idx on public.worker_handoff_expense_claims(submission_id,id);

-- Same food vocabulary as the existing authoritative food-expense guard,
-- including Albanian breakfast terms. Canonical saved text is checked too.
create or replace function private.worker_handoff_is_food_expense_v1(p_category text,p_description text)
returns boolean language sql immutable security invoker set search_path=pg_catalog as $fn$
  select coalesce(upper(p_category)='FOOD',false)
    or lower(coalesce(p_description,'')) ~ '(^|[^[:alpha:]])(ushqim|buk|buke|bukë|buka|bukes|bukës|drek|dreke|drekë|dark|darke|darkë|mengjes|mëngjes|meal|food)([^[:alpha:]]|$)'
$fn$;

create or replace function private.worker_handoff_food_expense_allowed_v1(p_category text,p_description text,p_created_at timestamptz,p_spent_on date,p_today date,p_is_existing boolean)
returns boolean language sql stable security invoker set search_path=pg_catalog,public,private as $fn$
  select not private.worker_handoff_is_food_expense_v1(p_category,p_description)
    or (
      public.meal_policy_schedule_v1(p_spent_on) is null
      and case when p_is_existing then
        p_created_at is not null and public.meal_policy_schedule_v1((p_created_at at time zone 'Europe/Belgrade')::date) is null
      else public.meal_policy_schedule_v1(p_today) is null end
    )
$fn$;
revoke all on function private.worker_handoff_is_food_expense_v1(text,text),private.worker_handoff_food_expense_allowed_v1(text,text,timestamptz,date,date,boolean) from public,anon,authenticated,service_role;

create or replace function private.worker_handoff_existing_expense_eligible_v1(p_payment_id bigint,p_worker_pin text)
returns boolean language sql stable security definer set search_path=pg_catalog,public,private as $fn$
  select exists(
    select 1 from public.arka_pending_payments p
    where p.id=p_payment_id and p.type='EXPENSE' and p.created_by_pin=p_worker_pin and p.amount>0
      and p.handed_at is null
      and coalesce(p.handoff_note,'') !~* 'SETTLED_IN_HANDOFF|\mHANDOFF[[:space:]]*#?[[:space:]]*[0-9]+'
      and nullif(to_jsonb(p)->>'applied_cycle_id','') is null
      and not exists(select 1 from public.cash_handoff_items i where i.pending_payment_id=p.id and i.released_at is null)
      and not exists(select 1 from public.cash_handoff_expense_decisions d where d.expense_payment_id=p.id and upper(coalesce(d.decision_status,'ACTIVE'))='ACTIVE')
      and not exists(select 1 from public.arka_payment_exclusions e where e.payment_id=p.id and e.cancelled_at is null)
      and not exists(select 1 from public.worker_handoff_expense_claims c where c.expense_payment_id=p.id)
      and (
        (p.status in ('PENDING','COLLECTED','PENDING_DISPATCH_APPROVAL')
          and not exists(select 1 from public.arka_expense_decisions d where d.expense_payment_id=p.id and d.finalized_at is not null)
          and not exists(select 1 from public.arka_expense_decisions d join public.company_budget_ledger l on l.source_type='arka_expense_decision' and l.source_id=d.id where d.expense_payment_id=p.id))
        or
        (p.status in ('ACCEPTED_BY_DISPATCH','APPROVED','ACCEPTED') and exists(
          select 1 from public.arka_expense_decisions d join public.company_budget_ledger l on l.source_type='arka_expense_decision' and l.source_id=d.id
          where d.expense_payment_id=p.id and d.decision_status='ACTIVE'
            and d.decision_type='BUSINESS_EXPENSE' and d.finalized_result='BUSINESS_EXPENSE'
            and d.finalized_at is not null and d.finalized_payment_id=p.id and d.amount_snapshot=p.amount
            and l.direction='OUT' and l.amount=p.amount
            and d.id=(select max(latest.id) from public.arka_expense_decisions latest where latest.expense_payment_id=p.id and latest.finalized_at is not null)
        ))
      )
  )
$fn$;
revoke all on function private.worker_handoff_existing_expense_eligible_v1(bigint,text) from public,anon,authenticated,service_role;

-- Patch the already-deployed preview in place, preserving its contract and all
-- calculation/locking behavior. Submit calls this same preview again under lock.
do $migration$
declare
  definition text;
  validation_anchor text:=$anchor$      if exists(select 1 from public.cash_handoff_expense_decisions d where d.expense_payment_id=ep.id and d.decision_status='ACTIVE') then raise exception 'WHW_EXPENSE_ALREADY_CLAIMED'; end if;$anchor$;
  listing_anchor text:=$anchor$    and not exists(select 1 from public.worker_handoff_expense_claims c where c.expense_payment_id=p.id);$anchor$;
  food_anchor text:=$anchor$    if lower(trim(a.name))='tapin lepaja' and (category='FOOD' or lower(description) ~ '(^|[^[:alpha:]])(ushqim|buk|buke|bukë|buka|bukes|bukës|drek|dreke|drekë|dark|darke|darkë|meal|food)([^[:alpha:]]|$)') then raise exception 'WHW_FOOD_POLICY_REVIEW_REQUIRED'; end if;$anchor$;
begin
  select pg_get_functiondef('private.preview_worker_handoff_v1(uuid,jsonb)'::regprocedure) into definition;
  if position('private.worker_handoff_existing_expense_eligible_v1' in definition)=0 then
    if position(validation_anchor in definition)=0 or position(listing_anchor in definition)=0 or position(food_anchor in definition)=0 then raise exception 'WHW_EXPENSE_ELIGIBILITY_ANCHOR_MISSING'; end if;
    definition:=replace(definition,validation_anchor,validation_anchor||E'\n      if not private.worker_handoff_existing_expense_eligible_v1(existing_id,a.pin) then raise exception ''WHW_EXPENSE_CHANGED''; end if;');
    definition:=replace(definition,listing_anchor,$replacement$    and private.worker_handoff_existing_expense_eligible_v1(p.id,a.pin)
    and private.worker_handoff_food_expense_allowed_v1(null,p.note,p.created_at,(p.created_at at time zone 'Europe/Belgrade')::date,today,true);$replacement$);
    definition:=replace(definition,food_anchor,$replacement$    if not private.worker_handoff_food_expense_allowed_v1(category,description,case when existing_id is not null then ep.created_at else null end,spent_on,today,existing_id is not null) then raise exception 'WHW_DAILY_FOOD_CLOSED'; end if;
    if lower(trim(a.name))='tapin lepaja' and private.worker_handoff_is_food_expense_v1(category,description) then raise exception 'WHW_FOOD_POLICY_REVIEW_REQUIRED'; end if;$replacement$);
    execute definition;
  end if;
end;
$migration$;
