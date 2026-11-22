-- Worker declarations are evidence. Dispatch alone records receipts and approves
-- expense funding. Existing handovers and customer payments are never rewritten.
create schema if not exists private;

create table if not exists public.worker_handoff_submissions (
  id bigserial primary key,
  handoff_id bigint not null unique references public.cash_handoffs(id) on delete restrict,
  actor_id uuid not null references public.users(id) on delete restrict,
  request_key text not null check (request_key ~ '^[A-Za-z0-9:_-]{12,120}$'),
  payload_hash text not null,
  snapshot_hash text not null,
  physical_cash numeric(14,2) not null check (physical_cash >= 0 and physical_cash <= 10000000),
  expected_cash numeric(14,2) not null check (expected_cash > 0),
  projected_cash numeric(14,2) not null check (projected_cash >= 0),
  difference_amount numeric(14,2) not null,
  difference_reason text not null default '',
  snapshot jsonb not null,
  options jsonb not null,
  created_at timestamptz not null default now(),
  unique(actor_id,request_key)
);

create table if not exists public.worker_handoff_expense_claims (
  id bigserial primary key,
  submission_id bigint not null references public.worker_handoff_submissions(id) on delete restrict,
  handoff_id bigint not null references public.cash_handoffs(id) on delete restrict,
  worker_id uuid not null references public.users(id) on delete restrict,
  client_key uuid not null,
  expense_payment_id bigint not null unique references public.arka_pending_payments(id) on delete restrict,
  amount numeric(14,2) not null check(amount > 0 and amount <= 1000000),
  deduction_amount numeric(14,2) not null check(deduction_amount >= 0 and deduction_amount <= amount),
  meal_already_deducted numeric(14,2) not null default 0 check(meal_already_deducted in (0,3)),
  description text not null,
  spent_on date not null,
  category text not null check(category in ('FOOD','FUEL','SUPPLIES','OTHER')),
  recipient text not null default '',
  funding_source text not null check(funding_source in ('WORKER_COLLECTIONS','DISPATCH_DRAWER','OWN_MONEY')),
  includes_own_meal boolean not null default false,
  status text not null default 'PENDING' check(status in ('PENDING','APPROVED','REJECTED','REIMBURSEMENT_PENDING','REIMBURSED')),
  decision_note text,
  decided_by_id uuid references public.users(id) on delete restrict,
  decided_by_name text,
  decided_at timestamptz,
  expense_ledger_id bigint references public.company_budget_ledger(id) on delete restrict,
  reclassification_ledger_id bigint references public.company_budget_ledger(id) on delete restrict,
  resolution_event_id bigint references public.cash_handoff_receipt_events(id) on delete restrict,
  reimbursement_note text,
  reimbursed_by_id uuid references public.users(id) on delete restrict,
  reimbursed_by_name text,
  reimbursed_at timestamptz,
  created_at timestamptz not null default now(),
  unique(worker_id,client_key),
  check (status <> 'APPROVED' or funding_source <> 'WORKER_COLLECTIONS' or
    (expense_ledger_id is not null and reclassification_ledger_id is not null and
      (deduction_amount = 0 or resolution_event_id is not null))),
  check (status <> 'REIMBURSED' or (funding_source='OWN_MONEY' and expense_ledger_id is not null and reimbursed_by_id is not null and reimbursed_by_id<>worker_id and reimbursed_at is not null))
);
create index if not exists worker_handoff_claims_handoff_idx on public.worker_handoff_expense_claims(handoff_id,id);
create unique index if not exists worker_handoff_claims_original_out_unique on public.worker_handoff_expense_claims(expense_ledger_id) where funding_source='WORKER_COLLECTIONS' and status='APPROVED';

create table if not exists private.worker_handoff_expense_decision_requests (
  id bigserial primary key,
  actor_id uuid not null references public.users(id) on delete restrict,
  request_key text not null,
  claim_id bigint not null references public.worker_handoff_expense_claims(id) on delete restrict,
  payload_hash text not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  unique(actor_id,request_key)
);
alter table public.worker_handoff_submissions enable row level security;
alter table public.worker_handoff_expense_claims enable row level security;
alter table private.worker_handoff_expense_decision_requests enable row level security;
revoke all on public.worker_handoff_submissions,public.worker_handoff_expense_claims,private.worker_handoff_expense_decision_requests from public,anon,authenticated,service_role;
grant select on public.worker_handoff_submissions,public.worker_handoff_expense_claims to service_role;

create or replace function private.worker_handoff_actor_v1(p_actor_id uuid,p_manager boolean default false)
returns public.users language plpgsql security definer set search_path=pg_catalog,public,private as $fn$
declare a public.users%rowtype;
begin
  select * into a from public.users where id=p_actor_id and is_active is true;
  if not found then raise exception 'WHW_AUTH_REQUIRED'; end if;
  if upper(coalesce(a.role,'')) not in ('DISPATCH','MASTER','MASTER USER','MASTER_USER','MASTERUSER','ADMIN','ADMIN_MASTER','OWNER','PRONAR','SUPERADMIN','PUNTOR','PUNETOR','WORKER','BAZIST','BASE','TRANSPORT') then raise exception 'WHW_FORBIDDEN'; end if;
  if p_manager and upper(coalesce(a.role,'')) not in ('DISPATCH','MASTER','MASTER USER','MASTER_USER','MASTERUSER','ADMIN','ADMIN_MASTER','OWNER','PRONAR','SUPERADMIN') then raise exception 'WHW_FORBIDDEN'; end if;
  return a;
end;
$fn$;

create or replace function private.read_worker_handoff_submission_v1(p_actor_id uuid,p_handoff_id bigint)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,private as $fn$
declare a public.users%rowtype; h public.cash_handoffs%rowtype; s public.worker_handoff_submissions%rowtype; manager boolean; claim_rows jsonb;
begin
  a:=private.worker_handoff_actor_v1(p_actor_id,false);
  manager:=upper(coalesce(a.role,'')) in ('DISPATCH','MASTER','MASTER USER','MASTER_USER','MASTERUSER','ADMIN','ADMIN_MASTER','OWNER','PRONAR','SUPERADMIN');
  select * into h from public.cash_handoffs where id=p_handoff_id;
  if not found then raise exception 'WHW_NOT_FOUND'; end if;
  if not manager and h.worker_pin is distinct from a.pin then raise exception 'WHW_FORBIDDEN'; end if;
  select * into s from public.worker_handoff_submissions where handoff_id=h.id;
  if not found then return jsonb_build_object('ok',true,'submission',null,'claims','[]'::jsonb,'canDecide',false); end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',c.id,'handoffId',c.handoff_id,'paymentId',c.expense_payment_id,
    'amount',c.amount,'deductionAmount',c.deduction_amount,'mealAlreadyDeducted',c.meal_already_deducted,'description',c.description,'spentOn',c.spent_on,
    'category',c.category,'recipient',c.recipient,'fundingSource',c.funding_source,'includesOwnMeal',c.includes_own_meal,'status',c.status,
    'decisionNote',c.decision_note,'decidedByName',c.decided_by_name,'decidedAt',c.decided_at,
    'canDecide',manager and a.id<>s.actor_id and c.status='PENDING',
    'canReimburse',manager and a.id<>s.actor_id and c.funding_source='OWN_MONEY' and c.status='REIMBURSEMENT_PENDING',
    'reimbursementNote',c.reimbursement_note,'reimbursedByName',c.reimbursed_by_name,'reimbursedAt',c.reimbursed_at,
    'requiresFundingConfirmation',c.funding_source='WORKER_COLLECTIONS',
    'requiresActualReceipt',c.funding_source='WORKER_COLLECTIONS' and c.deduction_amount>0 and not h.receipt_tracking,
    'expenseLedgerId',c.expense_ledger_id,'reclassificationLedgerId',c.reclassification_ledger_id,'resolutionEventId',c.resolution_event_id) order by c.id),'[]'::jsonb)
  into claim_rows from public.worker_handoff_expense_claims c where c.submission_id=s.id;
  return jsonb_build_object('ok',true,'handoffId',h.id,'canDecide',manager and a.id<>s.actor_id,
    'submission',jsonb_build_object('id',s.id,'handoffId',s.handoff_id,'actorId',s.actor_id,'snapshotHash',s.snapshot_hash,
      'physicalCash',s.physical_cash,'expectedCash',s.expected_cash,'projectedCash',s.projected_cash,'differenceAmount',s.difference_amount,
      'differenceReason',s.difference_reason,'snapshot',s.snapshot,'createdAt',s.created_at),'claims',claim_rows);
end;
$fn$;

create or replace function private.worker_handoff_meal_day_v1(p_note text,p_created_at timestamptz)
returns date language plpgsql immutable set search_path=pg_catalog as $fn$
declare d text;
begin
  d:=(regexp_match(coalesce(p_note,''),'MEAL_(DAY|OPEN|CARRY|DEBT):([0-9]{4}-[0-9]{2}-[0-9]{2})'))[2];
  return coalesce(d::date,(p_created_at at time zone 'Europe/Belgrade')::date);
exception when others then return (p_created_at at time zone 'Europe/Belgrade')::date;
end;
$fn$;

create or replace function private.preview_worker_handoff_v1(p_actor_id uuid,p_options jsonb)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,private as $fn$
declare
  a public.users%rowtype; payer public.users%rowtype; ep public.arka_pending_payments%rowtype;
  today date:=(now() at time zone 'Europe/Belgrade')::date;
  o jsonb:=coalesce(p_options,'{}'::jsonb); x jsonb; normalized jsonb:='[]'::jsonb; entry jsonb;
  cash_rows jsonb; bonus_rows jsonb; meal_rows jsonb; existing_expenses jsonb; pending jsonb; payers jsonb;
  result jsonb; version_data jsonb; coverage jsonb; choice text; payer_id uuid;
  cash_ids bigint[]; meal_ids bigint[]; bonus_ids bigint[]; existing_id bigint;
  v_client_key uuid; spent_on date; amount numeric; category text; description text; recipient text; funding text;
  includes_meal boolean; own_meal_count integer:=0; credit numeric; deduction numeric;
  gross numeric:=0; commission numeric:=0; meals numeric:=0; new_meal numeric:=0;
  own_meal_in_handoff numeric:=0; same_day_meals numeric:=0; bonus_available numeric:=0; bonus_deduct numeric:=0;
  expected numeric:=0; claimed numeric:=0; daily_allowed boolean; covered boolean; needs_choice boolean;
  hybrid boolean; rate numeric; n integer; eligible_self boolean; can_submit boolean;
begin
  a:=private.worker_handoff_actor_v1(p_actor_id,false);
  if jsonb_typeof(o)<>'object' or exists(select 1 from jsonb_object_keys(o) k where k not in ('mealChoice','mealPayerId','expenses')) then raise exception 'WHW_OPTIONS_INVALID'; end if;
  if o ? 'expenses' and jsonb_typeof(o->'expenses')<>'array' then raise exception 'WHW_OPTIONS_INVALID'; end if;
  if jsonb_array_length(coalesce(o->'expenses','[]'::jsonb))>20 then raise exception 'WHW_OPTIONS_INVALID'; end if;
  choice:=nullif(o->>'mealChoice','');
  if choice is not null and choice not in ('self','other','none','existing','monthly') then raise exception 'WHW_OPTIONS_INVALID'; end if;
  begin payer_id:=nullif(o->>'mealPayerId','')::uuid; exception when others then raise exception 'WHW_MEAL_PAYER_INVALID'; end;
  daily_allowed:=public.meal_policy_schedule_v1(today) is null;
  hybrid:=coalesce((to_jsonb(a)->>'is_hybrid_transport')::boolean,false);
  rate:=greatest(0,coalesce((to_jsonb(a)->>'commission_rate_m2')::numeric,0));

  select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'code',coalesce(p.transport_code_str,p.order_code::text),
      'clientName',p.client_name,'amount',p.amount,'collectedAt',p.created_at,'sourceModule',coalesce(p.source_module,'BASE'),
      'commission',case when hybrid and (p.type='TRANSPORT' or upper(coalesce(p.source_module,''))='TRANSPORT' or p.transport_order_id is not null or upper(coalesce(p.transport_code_str,'')) like 'T%')
        then p.amount-round(greatest(0,p.amount-least(p.amount,greatest(0,coalesce(p.transport_m2,0))*rate)),2) else 0 end,
      'updatedAt',p.updated_at) order by p.id),'[]'::jsonb),
    coalesce(array_agg(p.id order by p.id),'{}'::bigint[])
  into cash_rows,cash_ids
  from public.arka_pending_payments p
  where p.created_by_pin=a.pin and (nullif(trim(p.handed_by_pin),'') is null or p.handed_by_pin=a.pin)
    and p.status in ('PENDING','COLLECTED') and p.amount>0
    and p.type in ('IN','TRANSPORT')
    and not exists(select 1 from public.cash_handoff_items i where i.pending_payment_id=p.id and i.released_at is null)
    and not exists(select 1 from public.arka_payment_exclusions e where e.payment_id=p.id and e.cancelled_at is null);
  n:=jsonb_array_length(cash_rows);
  if n>500 then raise exception 'WHW_TOO_MANY_PAYMENTS'; end if;
  select coalesce(sum((value->>'amount')::numeric),0),coalesce(sum((value->>'commission')::numeric),0)
    into gross,commission from jsonb_array_elements(cash_rows);
  eligible_self:=exists(select 1 from public.arka_pending_payments p where p.created_by_pin=a.pin and p.type='IN'
    and coalesce(p.source_module,'BASE')<>'TRANSPORT' and p.status not in ('REJECTED','REFUZUAR','VOIDED','CANCELLED','CANCELED')
    and p.amount>0 and (p.created_at at time zone 'Europe/Belgrade')::date=today);

  select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'amount',p.amount,'day',private.worker_handoff_meal_day_v1(p.handoff_note,p.created_at),
      'note',p.handoff_note,'updatedAt',p.updated_at) order by p.id),'[]'::jsonb),coalesce(array_agg(p.id order by p.id),'{}'::bigint[]),coalesce(sum(p.amount),0)
  into meal_rows,meal_ids,meals from public.arka_pending_payments p
  where p.created_by_pin=a.pin and p.type='MEAL_PAYMENT' and p.amount>0
    and p.status in ('PENDING','COLLECTED','PENDING_DISPATCH_APPROVAL','ACCEPTED_BY_DISPATCH','APPROVED','ACCEPTED')
    and coalesce(p.handoff_note,'') ~ 'MEAL_(DAY|OPEN|CARRY|DEBT):[0-9]{4}-[0-9]{2}-[0-9]{2}'
    and coalesce(p.handoff_note,'') !~ '^SETTLED_IN_HANDOFF:';
  select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'type',p.type,'note',p.handoff_note,'createdBy',p.created_by_pin) order by p.id),'[]'::jsonb)
  into coverage from public.arka_pending_payments p
  where p.type in ('MEAL_PAYMENT','MEAL_COVERED') and p.status not in ('REJECTED','REFUZUAR','VOIDED','CANCELLED','CANCELED')
    and private.worker_handoff_meal_day_v1(p.handoff_note,p.created_at)=today
    and ((p.type='MEAL_COVERED' and p.created_by_pin=a.pin)
      or (p.type='MEAL_PAYMENT' and p.created_by_pin=a.pin and
        a.pin=any(string_to_array(coalesce((regexp_match(p.handoff_note,'MEAL_TARGETS:([^|;[:space:]]+)'))[1],a.pin),','))));
  covered:=jsonb_array_length(coverage)>0;
  needs_choice:=daily_allowed and eligible_self and not covered and choice is null;
  if not daily_allowed and choice in ('self','other') then raise exception 'WHW_MEAL_POLICY_CHANGED'; end if;
  if daily_allowed and choice='monthly' then raise exception 'WHW_MEAL_POLICY_CHANGED'; end if;
  if choice='existing' and not covered then raise exception 'WHW_MEAL_ALREADY_COVERED'; end if;
  if choice in ('self','other') and covered then raise exception 'WHW_MEAL_ALREADY_COVERED'; end if;
  if choice='self' and not eligible_self then raise exception 'WHW_MEAL_NOT_ELIGIBLE'; end if;
  if choice='self' then new_meal:=3; end if;
  if choice='other' then
    select * into payer from public.users where id=payer_id and is_active is true;
    if not found or payer.id=a.id or upper(coalesce(payer.role,'')) not in ('DISPATCH','MASTER','MASTER USER','MASTER_USER','MASTERUSER','ADMIN','ADMIN_MASTER','OWNER','PRONAR','SUPERADMIN','PUNTOR','PUNETOR','WORKER','BAZIST','BASE','TRANSPORT') then raise exception 'WHW_MEAL_PAYER_INVALID'; end if;
  elsif payer_id is not null then raise exception 'WHW_MEAL_PAYER_INVALID'; end if;
  select coalesce(sum(p.amount),0)+new_meal into same_day_meals from public.arka_pending_payments p
    where p.id=any(meal_ids) and private.worker_handoff_meal_day_v1(p.handoff_note,p.created_at)=today;
  if new_meal=3 or exists(select 1 from public.arka_pending_payments p where p.id=any(meal_ids) and p.amount=3
      and private.worker_handoff_meal_day_v1(p.handoff_note,p.created_at)=today
      and string_to_array(coalesce((regexp_match(p.handoff_note,'MEAL_TARGETS:([^|;[:space:]]+)'))[1],a.pin),',')=array[a.pin]) then own_meal_in_handoff:=3; end if;

  select coalesce(jsonb_agg(jsonb_build_object('bonusId',b.id,'paymentId',b.arka_payment_id,
      'kind',case when b.transport_control_id is null then 'BASE' else 'TRANSPORT' end,'amount',b.amount,
      'remainingAmount',b.remaining_amount,'reservedAmount',b.reserved_amount,'updatedAt',b.updated_at) order by b.id),'[]'::jsonb),
    coalesce(array_agg(b.arka_payment_id order by b.id),'{}'::bigint[]),coalesce(sum(b.remaining_amount),0)
  into bonus_rows,bonus_ids,bonus_available from public.base_ready_bonuses b join public.arka_pending_payments p on p.id=b.arka_payment_id
  where b.worker_pin=a.pin and p.created_by_pin=a.pin and p.type='READY_48H_BONUS'
    and b.eligible is true and b.remaining_amount>0.005 and b.status not in ('VOIDED','REVIEW_REQUIRED','INELIGIBLE');
  bonus_deduct:=least(bonus_available,greatest(0,gross-commission-meals-new_meal-0.01));
  expected:=round(greatest(0,gross-commission-meals-new_meal-bonus_deduct),2);

  for x in select value from jsonb_array_elements(coalesce(o->'expenses','[]'::jsonb)) loop
    if jsonb_typeof(x)<>'object' or exists(select 1 from jsonb_object_keys(x) k where k not in ('clientKey','existingPaymentId','amount','description','spentOn','category','recipient','fundingSource','includesOwnMeal')) then raise exception 'WHW_EXPENSE_INVALID'; end if;
    begin
      v_client_key:=(x->>'clientKey')::uuid;
      existing_id:=nullif(x->>'existingPaymentId','')::bigint;
      amount:=(x->>'amount')::numeric;
      spent_on:=(x->>'spentOn')::date;
    exception when others then raise exception 'WHW_EXPENSE_INVALID'; end;
    if v_client_key is null or amount is null or amount::text in ('NaN','Infinity','-Infinity') or amount<=0 or amount>1000000 or amount<>round(amount,2)
      or spent_on is null or (x->>'spentOn') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' or spent_on>today or spent_on<date '2020-01-01'
      or (existing_id is not null and existing_id<=0) then raise exception 'WHW_EXPENSE_INVALID'; end if;
    category:=x->>'category'; funding:=x->>'fundingSource'; description:=trim(coalesce(x->>'description','')); recipient:=trim(coalesce(x->>'recipient',''));
    if x ? 'includesOwnMeal' and jsonb_typeof(x->'includesOwnMeal')<>'boolean' then raise exception 'WHW_EXPENSE_INVALID'; end if;
    includes_meal:=coalesce((x->>'includesOwnMeal')::boolean,false);
    if category not in ('FOOD','FUEL','SUPPLIES','OTHER') or category is null or funding not in ('WORKER_COLLECTIONS','DISPATCH_DRAWER','OWN_MONEY') or funding is null
      or length(description)<2 or length(description)>500 or length(recipient)>160 then raise exception 'WHW_EXPENSE_INVALID'; end if;
    if exists(select 1 from jsonb_array_elements(normalized) q where q->>'clientKey'=v_client_key::text or (existing_id is not null and (q->>'existingPaymentId')::bigint=existing_id))
      or exists(select 1 from public.worker_handoff_expense_claims c where (c.worker_id=a.id and c.client_key=v_client_key) or (existing_id is not null and c.expense_payment_id=existing_id)) then raise exception 'WHW_EXPENSE_ALREADY_CLAIMED'; end if;
    if existing_id is not null then
      select * into ep from public.arka_pending_payments where id=existing_id;
      if not found or ep.type<>'EXPENSE' or ep.created_by_pin is distinct from a.pin or ep.amount<>amount
        or ep.status not in ('PENDING','COLLECTED','PENDING_DISPATCH_APPROVAL','ACCEPTED_BY_DISPATCH','APPROVED','ACCEPTED') then raise exception 'WHW_EXPENSE_CHANGED'; end if;
      if exists(select 1 from public.cash_handoff_expense_decisions d where d.expense_payment_id=ep.id and d.decision_status='ACTIVE') then raise exception 'WHW_EXPENSE_ALREADY_CLAIMED'; end if;
      if funding='OWN_MONEY' and (ep.status not in ('PENDING','COLLECTED','PENDING_DISPATCH_APPROVAL')
        or exists(select 1 from public.arka_expense_decisions d where d.expense_payment_id=ep.id and d.finalized_at is not null)) then raise exception 'WHW_EXPENSE_ALREADY_POSTED'; end if;
      description:=left(trim(ep.note),500);
    end if;
    -- Existing expense descriptions are canonical. Apply the worker policy
    -- after loading them so a caller cannot disguise a saved food expense.
    if lower(trim(a.name))='tapin lepaja' and (category='FOOD' or lower(description) ~ '(^|[^[:alpha:]])(ushqim|buk|buke|bukë|buka|bukes|bukës|drek|dreke|drekë|dark|darke|darkë|meal|food)([^[:alpha:]]|$)') then raise exception 'WHW_FOOD_POLICY_REVIEW_REQUIRED'; end if;
    credit:=0;
    if includes_meal then
      own_meal_count:=own_meal_count+1;
      if category<>'FOOD' or funding<>'WORKER_COLLECTIONS' or spent_on<>today or not daily_allowed or own_meal_in_handoff<>3 or same_day_meals<>3 or amount<3 or own_meal_count>1
        or (existing_id is not null and (ep.created_at at time zone 'Europe/Belgrade')::date is distinct from today) then raise exception 'WHW_MEAL_EXPENSE_OVERLAP'; end if;
      credit:=3;
    end if;
    deduction:=case when funding='WORKER_COLLECTIONS' then amount-credit else 0 end;
    claimed:=claimed+deduction;
    entry:=jsonb_build_object('clientKey',v_client_key,'existingPaymentId',existing_id,'amount',amount,'description',description,'spentOn',spent_on,
      'category',category,'recipient',recipient,'fundingSource',funding,'includesOwnMeal',includes_meal,'deductionAmount',deduction,'mealAlreadyDeducted',credit,
      'existingStatus',case when existing_id is not null then ep.status else null end,'existingUpdatedAt',case when existing_id is not null then ep.updated_at else null end);
    normalized:=normalized||jsonb_build_array(entry);
  end loop;
  if claimed>expected then raise exception 'WHW_EXPENSES_EXCEED_CASH'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('paymentId',p.id,'amount',p.amount,'description',p.note,'spentOn',(p.created_at at time zone 'Europe/Belgrade')::date,
    'status',p.status,'ledgerPosted',exists(select 1 from public.arka_expense_decisions d join public.company_budget_ledger l on l.source_type='arka_expense_decision' and l.source_id=d.id where d.expense_payment_id=p.id and l.direction='OUT')) order by p.id desc),'[]'::jsonb)
  into existing_expenses from public.arka_pending_payments p where p.created_by_pin=a.pin and p.type='EXPENSE'
    and p.status in ('PENDING','COLLECTED','PENDING_DISPATCH_APPROVAL','ACCEPTED_BY_DISPATCH','APPROVED','ACCEPTED')
    and not exists(select 1 from public.worker_handoff_expense_claims c where c.expense_payment_id=p.id);
  select coalesce(jsonb_agg(jsonb_build_object('id',h.id,'amount',h.amount,'outstandingAmount',case when h.receipt_tracking then h.receipt_outstanding_amount else h.amount end,'submittedAt',h.submitted_at) order by h.id),'[]'::jsonb)
    into pending from public.cash_handoffs h where h.worker_pin=a.pin and h.status='PENDING_DISPATCH_APPROVAL';
  select coalesce(jsonb_agg(jsonb_build_object('id',u.id,'name',u.name) order by u.name),'[]'::jsonb) into payers from public.users u
    where u.is_active is true and u.id<>a.id and upper(coalesce(u.role,'')) in ('DISPATCH','MASTER','MASTER USER','MASTER_USER','MASTERUSER','ADMIN','ADMIN_MASTER','OWNER','PRONAR','SUPERADMIN','PUNTOR','PUNETOR','WORKER','BAZIST','BASE','TRANSPORT');
  can_submit:=n>0 and gross-commission-meals-new_meal>0 and not needs_choice;
  result:=jsonb_build_object('ok',true,'actorId',a.id,'businessDate',today,'mealPayers',payers,
    'mealPolicy',jsonb_build_object('dailyAllowed',daily_allowed,'choice',choice,'payerId',payer_id,'mealAmount',new_meal,'existingMealTotal',meals,'requiresDecision',needs_choice,'coveredToday',covered,'eligibleSelf',eligible_self),
    'payments',cash_rows,'bonuses',bonus_rows,'meals',meal_rows,'existingExpenses',existing_expenses,'expenses',normalized,
    'totals',jsonb_build_object('grossCash',gross,'commission',commission,'mealDeduction',meals+new_meal,'bonusDeduction',bonus_deduct,'bonusRemaining',bonus_available-bonus_deduct,'expectedCash',expected,'claimedCollectionExpenses',claimed,'projectedCash',expected-claimed),
    'pendingHandoffs',pending,'canSubmit',can_submit,'warnings',case when n=0 then jsonb_build_array('NO_READY_PAYMENTS') when needs_choice then jsonb_build_array('MEAL_CHOICE_REQUIRED') else '[]'::jsonb end);
  version_data:=jsonb_build_object('actorId',a.id,'businessDate',today,'role',a.role,'hybrid',hybrid,'commissionRate',rate,'mealPolicy',result->'mealPolicy','coverage',coverage,
    'payments',cash_rows,'bonuses',bonus_rows,'meals',meal_rows,'expenses',normalized,'totals',result->'totals');
  return result||jsonb_build_object('snapshotHash',md5(version_data::text));
end;
$fn$;

create or replace function private.submit_worker_handoff_v1(
  p_actor_id uuid,p_snapshot_hash text,p_request_key text,p_options jsonb,p_physical_cash numeric,p_difference_reason text
) returns jsonb language plpgsql security definer set search_path=pg_catalog,public,private as $fn$
declare
  a public.users%rowtype; payer public.users%rowtype; s public.worker_handoff_submissions%rowtype;
  preview jsonb; checked jsonb; submitted jsonb; meal_result jsonb; x jsonb; result jsonb;
  payload_hash text; previous_context text; cash_ids bigint[]; meal_ids bigint[]; bonus_ids bigint[];
  h_id bigint; payment_id bigint; payer_id uuid; expected numeric; projected numeric; difference numeric; choice text;
  target jsonb; today date; reason text:=trim(coalesce(p_difference_reason,''));
begin
  a:=private.worker_handoff_actor_v1(p_actor_id,false);
  if p_request_key is null or p_request_key!~'^[A-Za-z0-9:_-]{12,120}$' or p_snapshot_hash is null or p_snapshot_hash!~'^[a-f0-9]{32}$' then raise exception 'WHW_OPTIONS_INVALID'; end if;
  if p_physical_cash is null or p_physical_cash::text in ('NaN','Infinity','-Infinity') or p_physical_cash<0 or p_physical_cash>10000000 or p_physical_cash<>round(p_physical_cash,2) then raise exception 'WHW_AMOUNT_INVALID'; end if;
  if length(reason)>1000 then raise exception 'WHW_DIFFERENCE_REASON_REQUIRED'; end if;
  payload_hash:=md5(jsonb_build_array(p_snapshot_hash,coalesce(p_options,'{}'::jsonb),p_physical_cash,reason)::text);
  perform pg_advisory_xact_lock(hashtext('WHW_REQUEST:'||a.id::text||':'||p_request_key));
  select * into s from public.worker_handoff_submissions where actor_id=a.id and request_key=p_request_key;
  if found then
    if s.payload_hash<>payload_hash then raise exception 'WHW_IDEMPOTENCY_CONFLICT'; end if;
    return private.read_worker_handoff_submission_v1(a.id,s.handoff_id)||jsonb_build_object('replayed',true);
  end if;
  preview:=private.preview_worker_handoff_v1(a.id,p_options);
  if preview->>'snapshotHash'<>p_snapshot_hash then raise exception 'WHW_SNAPSHOT_CHANGED'; end if;
  payer_id:=nullif(preview->'mealPolicy'->>'payerId','')::uuid;
  -- Lock identities in one order, including another worker who paid the meal.
  perform 1 from public.users u where u.id=a.id or u.id=payer_id order by u.id for update;
  select coalesce(array_agg((v->>'id')::bigint),'{}'::bigint[]) into cash_ids from jsonb_array_elements(preview->'payments') v;
  select coalesce(array_agg((v->>'id')::bigint),'{}'::bigint[]) into meal_ids from jsonb_array_elements(preview->'meals') v;
  select coalesce(array_agg((v->>'paymentId')::bigint),'{}'::bigint[]) into bonus_ids from jsonb_array_elements(preview->'bonuses') v;
  perform 1 from public.arka_pending_payments p where p.id=any(cash_ids||meal_ids||bonus_ids)
    or p.id in (select (v->>'existingPaymentId')::bigint from jsonb_array_elements(preview->'expenses') v where v->>'existingPaymentId' is not null)
    order by p.id for update;
  perform 1 from public.base_ready_bonuses b where b.arka_payment_id=any(bonus_ids) order by b.id for update;
  checked:=private.preview_worker_handoff_v1(a.id,p_options);
  if checked->>'snapshotHash'<>p_snapshot_hash then raise exception 'WHW_SNAPSHOT_CHANGED'; end if;
  if coalesce((checked->'mealPolicy'->>'requiresDecision')::boolean,false) then raise exception 'WHW_MEAL_CHOICE_REQUIRED'; end if;
  if coalesce((checked->>'canSubmit')::boolean,false) is not true then raise exception 'WHW_NO_READY_PAYMENTS'; end if;
  expected:=(checked->'totals'->>'expectedCash')::numeric;
  projected:=(checked->'totals'->>'projectedCash')::numeric;
  difference:=p_physical_cash-projected;
  if difference<>0 and length(reason)<4 then raise exception 'WHW_DIFFERENCE_REASON_REQUIRED'; end if;
  today:=(checked->>'businessDate')::date;
  choice:=checked->'mealPolicy'->>'choice';
  previous_context:=current_setting('tepiha.worker_handoff_context',true);
  perform set_config('tepiha.worker_handoff_context','on',true);
  if choice in ('self','other') then
    if choice='self' then payer:=a; else select * into payer from public.users where id=payer_id and is_active is true; end if;
    if payer.id is null then raise exception 'WHW_MEAL_PAYER_INVALID'; end if;
    target:=jsonb_build_array(jsonb_build_object('pin',a.pin,'name',a.name,'role',a.role));
    -- The surrounding request is idempotent. Passing NULL avoids the old
    -- function's broad payer/day replay accidentally covering different people.
    meal_result:=public.create_meal_distribution_atomic(a.pin,a.name,a.role,payer.pin,payer.name,payer.role,today::text,3,target,'USHQIM NË DORËZIM',null);
    if coalesce((meal_result->>'ok')::boolean,false) is not true then raise exception 'WHW_MEAL_POLICY_CHANGED'; end if;
    if not exists(select 1 from public.arka_pending_payments p where p.type='MEAL_COVERED' and p.created_by_pin=a.pin
      and private.worker_handoff_meal_day_v1(p.handoff_note,p.created_at)=today and p.status not in ('REJECTED','REFUZUAR','VOIDED','CANCELLED','CANCELED')) then raise exception 'WHW_MEAL_POLICY_CHANGED'; end if;
    select coalesce(array_agg(p.id order by p.id),'{}'::bigint[]) into meal_ids from public.arka_pending_payments p
      where p.created_by_pin=a.pin and p.type='MEAL_PAYMENT' and p.amount>0
        and p.status in ('PENDING','COLLECTED','PENDING_DISPATCH_APPROVAL','ACCEPTED_BY_DISPATCH','APPROVED','ACCEPTED')
        and coalesce(p.handoff_note,'') ~ 'MEAL_(DAY|OPEN|CARRY|DEBT):[0-9]{4}-[0-9]{2}-[0-9]{2}'
        and coalesce(p.handoff_note,'') !~ '^SETTLED_IN_HANDOFF:';
  end if;
  submitted:=public.submit_cash_handoff_with_ready_bonus_v1(a.pin,a.name,a.role,cash_ids,expected,
    'WIZARD: deklarimi fizik pret numërimin e dispatch-it.',p_request_key,meal_ids,bonus_ids);
  if coalesce((submitted->>'ok')::boolean,false) is not true then raise exception 'WHW_SNAPSHOT_CHANGED'; end if;
  h_id:=(submitted->'handoff'->>'id')::bigint;
  if (submitted->'handoff'->>'worker_pin') is distinct from a.pin or (submitted->'handoff'->>'amount')::numeric<>expected
    or coalesce((submitted->>'alreadySubmitted')::boolean,false) then raise exception 'WHW_SNAPSHOT_CHANGED'; end if;
  insert into public.worker_handoff_submissions(handoff_id,actor_id,request_key,payload_hash,snapshot_hash,physical_cash,expected_cash,projected_cash,difference_amount,difference_reason,snapshot,options)
  values(h_id,a.id,p_request_key,payload_hash,p_snapshot_hash,p_physical_cash,expected,projected,difference,reason,
    checked||jsonb_build_object('committedMealPaymentIds',to_jsonb(meal_ids),'committedBonusAllocations',submitted->'readyBonusAllocations'),coalesce(p_options,'{}'::jsonb)) returning * into s;
  for x in select value from jsonb_array_elements(checked->'expenses') loop
    payment_id:=nullif(x->>'existingPaymentId','')::bigint;
    if payment_id is null then
      insert into public.arka_pending_payments(amount,type,status,note,created_by_pin,created_by_name,source_module,idempotency_key,handoff_note,created_at,updated_at)
      values((x->>'amount')::numeric,'EXPENSE','PENDING',x->>'description',a.pin,a.name,'ARKA',
        'WHW_EXPENSE:'||a.id::text||':'||(x->>'clientKey'),
        'WHW_PENDING_REVIEW:'||s.id::text||'|SPENT_ON:'||(x->>'spentOn')||'|FUNDING_SOURCE:'||(x->>'fundingSource'),now(),now()) returning id into payment_id;
    end if;
    insert into public.worker_handoff_expense_claims(submission_id,handoff_id,worker_id,client_key,expense_payment_id,amount,deduction_amount,meal_already_deducted,description,spent_on,category,recipient,funding_source,includes_own_meal)
    values(s.id,h_id,a.id,(x->>'clientKey')::uuid,payment_id,(x->>'amount')::numeric,(x->>'deductionAmount')::numeric,(x->>'mealAlreadyDeducted')::numeric,
      x->>'description',(x->>'spentOn')::date,x->>'category',x->>'recipient',x->>'fundingSource',(x->>'includesOwnMeal')::boolean);
  end loop;
  perform set_config('tepiha.worker_handoff_context',coalesce(previous_context,''),true);
  result:=private.read_worker_handoff_submission_v1(a.id,h_id);
  return result||jsonb_build_object('replayed',false);
end;
$fn$;

create or replace function private.decide_worker_handoff_expense_v1(
  p_actor_id uuid,p_claim_id bigint,p_approve boolean,p_note text,p_request_key text
) returns jsonb language plpgsql security definer set search_path=pg_catalog,public,private as $fn$
declare
  a public.users%rowtype; h public.cash_handoffs%rowtype; c public.worker_handoff_expense_claims%rowtype;
  ep public.arka_pending_payments%rowtype; l public.company_budget_ledger%rowtype;
  prior private.worker_handoff_expense_decision_requests%rowtype;
  result jsonb; resolved jsonb; view_data jsonb; payload_hash text; previous_context text;
  note text:=trim(coalesce(p_note,'')); out_id bigint; correction_id bigint; event_id bigint; new_status text;
begin
  a:=private.worker_handoff_actor_v1(p_actor_id,true);
  if p_claim_id is null or p_claim_id<=0 or p_approve is null or p_request_key is null or p_request_key!~'^[A-Za-z0-9:_-]{12,120}$' then raise exception 'WHW_OPTIONS_INVALID'; end if;
  if length(note)<4 or length(note)>1000 then raise exception 'WHW_DIFFERENCE_REASON_REQUIRED'; end if;
  payload_hash:=md5(jsonb_build_array(p_claim_id,p_approve,note)::text);
  perform pg_advisory_xact_lock(hashtext('WHW_DECISION:'||a.id::text||':'||p_request_key));
  select * into prior from private.worker_handoff_expense_decision_requests where actor_id=a.id and request_key=p_request_key;
  if found then
    if prior.payload_hash<>payload_hash or prior.claim_id<>p_claim_id then raise exception 'WHW_IDEMPOTENCY_CONFLICT'; end if;
    return prior.result||jsonb_build_object('replayed',true);
  end if;
  select * into c from public.worker_handoff_expense_claims where id=p_claim_id;
  if not found then raise exception 'WHW_NOT_FOUND'; end if;
  if c.worker_id=a.id then raise exception 'WHW_SELF_APPROVAL'; end if;
  -- Match receipt lock order: handover, then expense/payment, then allocation.
  select * into h from public.cash_handoffs where id=c.handoff_id for update;
  select * into c from public.worker_handoff_expense_claims where id=p_claim_id for update;
  if c.status<>'PENDING' then raise exception 'WHW_CLAIM_NOT_PENDING'; end if;
  select * into ep from public.arka_pending_payments where id=c.expense_payment_id for update;
  if not found or ep.type<>'EXPENSE' or ep.amount<>c.amount or ep.created_by_pin is distinct from h.worker_pin then raise exception 'WHW_EXPENSE_CHANGED'; end if;
  if h.status not in ('PENDING_DISPATCH_APPROVAL','ACCEPTED') then raise exception 'WHW_CLAIM_STATE_CHANGED'; end if;
  if p_approve and c.funding_source='WORKER_COLLECTIONS' and c.deduction_amount>0 then
    if not h.receipt_tracking then raise exception 'WHW_ACTUAL_RECEIPT_REQUIRED'; end if;
    if h.status<>'PENDING_DISPATCH_APPROVAL' or h.receipt_outstanding_amount<c.deduction_amount then raise exception 'WHW_INSUFFICIENT_OUTSTANDING'; end if;
  end if;
  previous_context:=current_setting('tepiha.worker_handoff_context',true);
  perform set_config('tepiha.worker_handoff_context','on',true);
  if not p_approve then
    -- Rejecting a funding claim does not undo an older approved company expense.
    if ep.status in ('PENDING','COLLECTED','PENDING_DISPATCH_APPROVAL') then
      perform public.resolve_arka_expense_v2(a.pin,a.name,ep.id,'REJECTED_OPEN_CASH',null,null,'WHW: '||note);
    end if;
    new_status:='REJECTED';
  elsif c.funding_source='OWN_MONEY' then
    -- Acknowledgement is noncash. Separate it from undecided expenses so it
    -- cannot block the daily close; explicit reimbursement is another action.
    if ep.status not in ('PENDING','COLLECTED','PENDING_DISPATCH_APPROVAL')
      or exists(select 1 from public.arka_expense_decisions d where d.expense_payment_id=ep.id and d.finalized_at is not null) then raise exception 'WHW_EXPENSE_ALREADY_POSTED'; end if;
    update public.arka_pending_payments set status='REIMBURSEMENT_PENDING',updated_at=now(),
      handoff_note=concat_ws(' | ',nullif(handoff_note,''),'WHW_REIMBURSEMENT_PENDING:'||c.id::text) where id=ep.id;
    new_status:='REIMBURSEMENT_PENDING';
  else
    resolved:=public.resolve_arka_expense_v2(a.pin,a.name,ep.id,'BUSINESS_EXPENSE',null,null,
      'WHW FUNDING CONFIRMED '||c.funding_source||': '||note);
    if coalesce((resolved->>'ok')::boolean,false) is not true then raise exception 'WHW_CLAIM_STATE_CHANGED'; end if;
    select ledger.* into l from public.company_budget_ledger ledger join public.arka_expense_decisions d
      on ledger.source_type='arka_expense_decision' and ledger.source_id=d.id
      where d.expense_payment_id=ep.id and d.finalized_result='BUSINESS_EXPENSE' and d.decision_status='ACTIVE'
        and ledger.direction='OUT' and ledger.amount=c.amount order by d.id desc limit 1;
    if not found then raise exception 'WHW_EXPENSE_LEDGER_MISSING'; end if;
    out_id:=l.id;
    if c.funding_source='WORKER_COLLECTIONS' then
      if exists(select 1 from public.worker_handoff_expense_claims prior_claim where prior_claim.id<>c.id and prior_claim.expense_ledger_id=out_id and prior_claim.status='APPROVED') then raise exception 'WHW_EXPENSE_ALREADY_CLAIMED'; end if;
      -- Reverse the drawer classification, preserving the expense itself. This
      -- is not a physical receipt and is excluded from actual-receipt metrics.
      insert into public.company_budget_ledger(direction,amount,category,description,source_type,source_id,related_handoff_id,created_by_pin,created_by_name,approved_by_pin,approved_by_name)
      values('IN',c.amount,'EXPENSE_FUNDING_RECLASSIFICATION',
        'RIKLASIFIKIM: shpenzimi #'||ep.id||' u pagua nga arkëtimet e punëtorit; kthim i daljes së arkës #'||out_id,
        'worker_handoff_expense_reclass',c.id,h.id,a.pin,a.name,a.pin,a.name) returning id into correction_id;
      update public.company_budget_summary set current_balance=current_balance+c.amount,total_in=total_in+c.amount,updated_at=now() where id=1;
      if c.deduction_amount>0 then
        resolved:=private.record_cash_handoff_receipt_v1(a.id,h.id,'RESOLUTION',c.deduction_amount,h.receipt_outstanding_amount,
          'APPROVED_COLLECTION_EXPENSE','Shpenzimi #'||ep.id||' • '||c.description||' • '||note,'WHW_CLAIM:'||c.id::text||':RESOLUTION');
        event_id:=(resolved->'event'->>'id')::bigint;
      end if;
    end if;
    new_status:='APPROVED';
  end if;
  update public.worker_handoff_expense_claims set status=new_status,decision_note=note,decided_by_id=a.id,decided_by_name=a.name,decided_at=now(),
    expense_ledger_id=out_id,reclassification_ledger_id=correction_id,resolution_event_id=event_id where id=c.id;
  view_data:=private.read_worker_handoff_submission_v1(a.id,h.id);
  select value into result from jsonb_array_elements(view_data->'claims') where (value->>'id')::bigint=c.id;
  result:=jsonb_build_object('ok',true,'replayed',false,'handoffId',h.id,'claim',result);
  insert into private.worker_handoff_expense_decision_requests(actor_id,request_key,claim_id,payload_hash,result)
  values(a.id,p_request_key,c.id,payload_hash,result);
  perform set_config('tepiha.worker_handoff_context',coalesce(previous_context,''),true);
  return result;
end;
$fn$;

create or replace function private.reimburse_worker_handoff_expense_v1(
  p_actor_id uuid,p_claim_id bigint,p_amount numeric,p_note text,p_request_key text
) returns jsonb language plpgsql security definer set search_path=pg_catalog,public,private as $fn$
declare
  a public.users%rowtype; h public.cash_handoffs%rowtype; c public.worker_handoff_expense_claims%rowtype;
  ep public.arka_pending_payments%rowtype; prior private.worker_handoff_expense_decision_requests%rowtype;
  result jsonb; resolved jsonb; view_data jsonb; payload_hash text; previous_context text;
  note text:=trim(coalesce(p_note,'')); out_id bigint;
begin
  a:=private.worker_handoff_actor_v1(p_actor_id,true);
  if p_claim_id is null or p_claim_id<=0 or p_request_key is null or p_request_key!~'^[A-Za-z0-9:_-]{12,120}$' then raise exception 'WHW_OPTIONS_INVALID'; end if;
  if p_amount is null or p_amount::text in ('NaN','Infinity','-Infinity') or p_amount<=0 or p_amount>1000000 or p_amount<>round(p_amount,2) then raise exception 'WHW_AMOUNT_INVALID'; end if;
  if length(note)<4 or length(note)>1000 then raise exception 'WHW_DIFFERENCE_REASON_REQUIRED'; end if;
  payload_hash:=md5(jsonb_build_array('REIMBURSE',p_claim_id,p_amount,note)::text);
  perform pg_advisory_xact_lock(hashtext('WHW_DECISION:'||a.id::text||':'||p_request_key));
  select * into prior from private.worker_handoff_expense_decision_requests where actor_id=a.id and request_key=p_request_key;
  if found then
    if prior.payload_hash<>payload_hash or prior.claim_id<>p_claim_id then raise exception 'WHW_IDEMPOTENCY_CONFLICT'; end if;
    return prior.result||jsonb_build_object('replayed',true);
  end if;
  select * into c from public.worker_handoff_expense_claims where id=p_claim_id;
  if not found then raise exception 'WHW_NOT_FOUND'; end if;
  if c.worker_id=a.id then raise exception 'WHW_SELF_APPROVAL'; end if;
  select * into h from public.cash_handoffs where id=c.handoff_id for update;
  select * into c from public.worker_handoff_expense_claims where id=p_claim_id for update;
  if c.funding_source<>'OWN_MONEY' or c.status<>'REIMBURSEMENT_PENDING' then raise exception 'WHW_REIMBURSEMENT_NOT_PENDING'; end if;
  if p_amount<>c.amount then raise exception 'WHW_REIMBURSEMENT_AMOUNT_MISMATCH'; end if;
  select * into ep from public.arka_pending_payments where id=c.expense_payment_id for update;
  if not found or ep.type<>'EXPENSE' or ep.amount<>c.amount or ep.created_by_pin is distinct from h.worker_pin or ep.status<>'REIMBURSEMENT_PENDING' then raise exception 'WHW_EXPENSE_CHANGED'; end if;
  if exists(select 1 from public.arka_expense_decisions d where d.expense_payment_id=ep.id and d.finalized_at is not null) then raise exception 'WHW_EXPENSE_ALREADY_POSTED'; end if;
  previous_context:=current_setting('tepiha.worker_handoff_context',true);
  perform set_config('tepiha.worker_handoff_context','on',true);
  -- Re-enter the existing authorized business-expense engine inside the same
  -- transaction. It posts the real reimbursement exactly once as drawer OUT.
  update public.arka_pending_payments set status='PENDING',updated_at=now(),
    handoff_note=concat_ws(' | ',nullif(handoff_note,''),'WHW_REIMBURSEMENT_PAID:'||c.id::text) where id=ep.id;
  resolved:=public.resolve_arka_expense_v2(a.pin,a.name,ep.id,'BUSINESS_EXPENSE',null,null,'WHW REIMBURSEMENT PAID: '||note);
  if coalesce((resolved->>'ok')::boolean,false) is not true then raise exception 'WHW_CLAIM_STATE_CHANGED'; end if;
  select l.id into out_id from public.company_budget_ledger l join public.arka_expense_decisions d on l.source_type='arka_expense_decision' and l.source_id=d.id
    where d.expense_payment_id=ep.id and d.decision_status='ACTIVE' and d.finalized_result='BUSINESS_EXPENSE' and l.direction='OUT' and l.amount=c.amount order by d.id desc limit 1;
  if out_id is null then raise exception 'WHW_EXPENSE_LEDGER_MISSING'; end if;
  update public.worker_handoff_expense_claims set status='REIMBURSED',expense_ledger_id=out_id,reimbursement_note=note,
    reimbursed_by_id=a.id,reimbursed_by_name=a.name,reimbursed_at=now() where id=c.id;
  view_data:=private.read_worker_handoff_submission_v1(a.id,h.id);
  select value into result from jsonb_array_elements(view_data->'claims') where (value->>'id')::bigint=c.id;
  result:=jsonb_build_object('ok',true,'replayed',false,'handoffId',h.id,'claim',result);
  insert into private.worker_handoff_expense_decision_requests(actor_id,request_key,claim_id,payload_hash,result)
  values(a.id,p_request_key,c.id,payload_hash,result);
  perform set_config('tepiha.worker_handoff_context',coalesce(previous_context,''),true);
  return result;
end;
$fn$;

-- New evidence is immutable. The existing receipt engine remains the only way
-- to change a submitted handover; cached legacy clients cannot credit its total.
create or replace function private.guard_worker_handoff_creation_v1()
returns trigger language plpgsql set search_path=pg_catalog as $fn$
begin
  if current_user<>'postgres' or current_setting('tepiha.worker_handoff_context',true) is distinct from 'on' then raise exception 'WHW_USE_WIZARD'; end if;
  return new;
end;
$fn$;
-- Install this creation guard only after the wizard frontend is live; see the
-- separately deployable worker_handoff_require_wizard_v1 migration.

create or replace function private.guard_worker_handoff_evidence_v1()
returns trigger language plpgsql set search_path=pg_catalog,public,private as $fn$
declare s public.worker_handoff_submissions%rowtype;
begin
  if tg_op='DELETE' then raise exception 'WHW_IMMUTABLE'; end if;
  if current_user<>'postgres' or current_setting('tepiha.worker_handoff_context',true) is distinct from 'on' then raise exception 'WHW_IMMUTABLE'; end if;
  if tg_table_name='worker_handoff_submissions' then
    if tg_op<>'INSERT' then raise exception 'WHW_IMMUTABLE'; end if;
    if not exists(select 1 from public.cash_handoffs h join public.users u on u.pin=h.worker_pin where h.id=new.handoff_id and u.id=new.actor_id
      and h.status='PENDING_DISPATCH_APPROVAL' and h.amount=new.expected_cash and not h.receipt_tracking and h.company_ledger_entry_id is null) then raise exception 'WHW_CLAIM_STATE_CHANGED'; end if;
  elsif tg_table_name='worker_handoff_expense_claims' then
    select * into s from public.worker_handoff_submissions where id=new.submission_id;
    if not found or new.worker_id<>s.actor_id or new.handoff_id<>s.handoff_id then raise exception 'WHW_CLAIM_STATE_CHANGED'; end if;
    if tg_op='UPDATE' and old.status='PENDING' then
      if new.status not in ('APPROVED','REJECTED','REIMBURSEMENT_PENDING')
        or (to_jsonb(new)-array['status','decision_note','decided_by_id','decided_by_name','decided_at','expense_ledger_id','reclassification_ledger_id','resolution_event_id']::text[])
           is distinct from (to_jsonb(old)-array['status','decision_note','decided_by_id','decided_by_name','decided_at','expense_ledger_id','reclassification_ledger_id','resolution_event_id']::text[])
        or new.decided_by_id is null or new.decided_by_id=new.worker_id then raise exception 'WHW_IMMUTABLE'; end if;
    elsif tg_op='UPDATE' and old.status='REIMBURSEMENT_PENDING' then
      if new.status<>'REIMBURSED' or new.funding_source<>'OWN_MONEY' or new.reimbursed_by_id is null or new.reimbursed_by_id=new.worker_id
        or (to_jsonb(new)-array['status','expense_ledger_id','reimbursement_note','reimbursed_by_id','reimbursed_by_name','reimbursed_at']::text[])
           is distinct from (to_jsonb(old)-array['status','expense_ledger_id','reimbursement_note','reimbursed_by_id','reimbursed_by_name','reimbursed_at']::text[])
        or not exists(select 1 from public.company_budget_ledger l join public.arka_expense_decisions d on l.source_type='arka_expense_decision' and l.source_id=d.id
          where l.id=new.expense_ledger_id and d.expense_payment_id=new.expense_payment_id and d.finalized_result='BUSINESS_EXPENSE' and d.decision_status='ACTIVE' and l.direction='OUT' and l.amount=new.amount) then raise exception 'WHW_IMMUTABLE'; end if;
    elsif tg_op='UPDATE' then raise exception 'WHW_IMMUTABLE';
    elsif new.status<>'PENDING' or new.decided_at is not null or new.expense_ledger_id is not null or new.reclassification_ledger_id is not null or new.resolution_event_id is not null or new.reimbursed_at is not null or new.reimbursed_by_id is not null or new.reimbursement_note is not null then raise exception 'WHW_IMMUTABLE'; end if;
    if new.status='APPROVED' and new.funding_source='WORKER_COLLECTIONS' then
      if not exists(select 1 from public.company_budget_ledger l join public.arka_expense_decisions d on l.source_type='arka_expense_decision' and l.source_id=d.id
        where l.id=new.expense_ledger_id and d.expense_payment_id=new.expense_payment_id and l.direction='OUT' and l.amount=new.amount)
        or not exists(select 1 from public.company_budget_ledger l where l.id=new.reclassification_ledger_id and l.source_type='worker_handoff_expense_reclass' and l.source_id=new.id and l.related_handoff_id=new.handoff_id and l.direction='IN' and l.amount=new.amount)
        or (new.deduction_amount>0 and not exists(select 1 from public.cash_handoff_receipt_events e where e.id=new.resolution_event_id and e.handoff_id=new.handoff_id and e.event_kind='RESOLUTION' and e.amount=new.deduction_amount and e.reason='APPROVED_COLLECTION_EXPENSE')) then raise exception 'WHW_CLAIM_STATE_CHANGED'; end if;
    end if;
  elsif tg_table_name='worker_handoff_expense_decision_requests' and tg_op<>'INSERT' then raise exception 'WHW_IMMUTABLE'; end if;
  return new;
end;
$fn$;
drop trigger if exists guard_worker_handoff_submission_v1 on public.worker_handoff_submissions;
create trigger guard_worker_handoff_submission_v1 before insert or update or delete on public.worker_handoff_submissions for each row execute function private.guard_worker_handoff_evidence_v1();
drop trigger if exists guard_worker_handoff_claim_v1 on public.worker_handoff_expense_claims;
create trigger guard_worker_handoff_claim_v1 before insert or update or delete on public.worker_handoff_expense_claims for each row execute function private.guard_worker_handoff_evidence_v1();
drop trigger if exists guard_worker_handoff_decision_request_v1 on private.worker_handoff_expense_decision_requests;
create trigger guard_worker_handoff_decision_request_v1 before insert or update or delete on private.worker_handoff_expense_decision_requests for each row execute function private.guard_worker_handoff_evidence_v1();

create or replace function private.guard_worker_handoff_legacy_paths_v1()
returns trigger language plpgsql security definer set search_path=pg_catalog,public,private as $fn$
declare
  claim public.worker_handoff_expense_claims%rowtype;
  trusted_backend boolean:=coalesce(current_setting('role',true),'none') in ('none','postgres','service_role');
begin
  -- Inspection runs as owner so unrelated legacy writes do not need SELECT on
  -- private worker evidence. Only the service backend can enter a protected
  -- mutation path. Creation/evidence/receipt guards separately check the actual
  -- effective postgres role; no public function exposes a context setter.
  if tg_table_name='cash_handoffs' then
    if exists(select 1 from public.worker_handoff_submissions s where s.handoff_id=old.id) then
      if tg_op='DELETE' then raise exception 'WHW_IMMUTABLE'; end if;
      if new.amount is distinct from old.amount or new.worker_pin is distinct from old.worker_pin or new.worker_name is distinct from old.worker_name then raise exception 'WHW_IMMUTABLE'; end if;
      if to_jsonb(new) is distinct from to_jsonb(old) and (not new.receipt_tracking or not trusted_backend or current_setting('tepiha.handoff_receipt_context',true) is distinct from 'on') then raise exception 'WHW_USE_ACTUAL_RECEIPT'; end if;
    end if;
  elsif tg_table_name='cash_handoff_items' then
    if exists(select 1 from public.worker_handoff_submissions s where s.handoff_id=case when tg_op='DELETE' then old.handoff_id else new.handoff_id end)
      or (tg_op='UPDATE' and exists(select 1 from public.worker_handoff_submissions s where s.handoff_id=old.handoff_id)) then raise exception 'WHW_IMMUTABLE'; end if;
  elsif tg_table_name='company_budget_ledger' then
    if tg_op='INSERT' and new.source_type='cash_handoff' and exists(select 1 from public.worker_handoff_submissions s where s.handoff_id=new.source_id) then raise exception 'WHW_USE_ACTUAL_RECEIPT'; end if;
    if tg_op<>'INSERT' and exists(select 1 from public.worker_handoff_expense_claims c where c.expense_ledger_id=old.id or c.reclassification_ledger_id=old.id) then raise exception 'WHW_IMMUTABLE'; end if;
    if (tg_op<>'INSERT' and old.source_type='worker_handoff_expense_reclass') or (tg_op<>'DELETE' and new.source_type='worker_handoff_expense_reclass') then
      if tg_op<>'INSERT' or not trusted_backend or current_setting('tepiha.worker_handoff_context',true) is distinct from 'on' then raise exception 'WHW_IMMUTABLE'; end if;
      select * into claim from public.worker_handoff_expense_claims c where c.id=new.source_id;
      if not found or claim.status<>'PENDING' or claim.funding_source<>'WORKER_COLLECTIONS' or new.direction<>'IN' or new.amount<>claim.amount or new.related_handoff_id is distinct from claim.handoff_id then raise exception 'WHW_CLAIM_STATE_CHANGED'; end if;
    end if;
  elsif tg_table_name='arka_pending_payments' then
    if exists(select 1 from public.worker_handoff_expense_claims c where c.expense_payment_id=old.id) then
      if tg_op='DELETE' then raise exception 'WHW_IMMUTABLE'; end if;
      if new.amount is distinct from old.amount or new.type is distinct from old.type or new.created_by_pin is distinct from old.created_by_pin
        or new.created_by_name is distinct from old.created_by_name or new.created_at is distinct from old.created_at or new.idempotency_key is distinct from old.idempotency_key then raise exception 'WHW_IMMUTABLE'; end if;
      if not trusted_backend or current_setting('tepiha.worker_handoff_context',true) is distinct from 'on' then raise exception 'WHW_USE_EXPENSE_REVIEW'; end if;
    end if;
  elsif tg_table_name='arka_expense_decisions' then
    if exists(select 1 from public.worker_handoff_expense_claims c where c.expense_payment_id=case when tg_op='DELETE' then old.expense_payment_id else new.expense_payment_id end)
      or (tg_op='UPDATE' and exists(select 1 from public.worker_handoff_expense_claims c where c.expense_payment_id=old.expense_payment_id)) then
      if tg_op='DELETE' or not trusted_backend or current_setting('tepiha.worker_handoff_context',true) is distinct from 'on' then raise exception 'WHW_USE_EXPENSE_REVIEW'; end if;
      if tg_op='UPDATE' and exists(select 1 from public.worker_handoff_expense_claims c where c.expense_payment_id=old.expense_payment_id and c.status not in ('PENDING','REIMBURSEMENT_PENDING')) then raise exception 'WHW_IMMUTABLE'; end if;
    end if;
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end;
$fn$;
drop trigger if exists zz_guard_worker_handoff_legacy_v1 on public.cash_handoffs;
create trigger zz_guard_worker_handoff_legacy_v1 before update or delete on public.cash_handoffs for each row execute function private.guard_worker_handoff_legacy_paths_v1();
drop trigger if exists zz_guard_worker_handoff_items_v1 on public.cash_handoff_items;
create trigger zz_guard_worker_handoff_items_v1 before insert or update or delete on public.cash_handoff_items for each row execute function private.guard_worker_handoff_legacy_paths_v1();
drop trigger if exists zz_guard_worker_handoff_ledger_v1 on public.company_budget_ledger;
create trigger zz_guard_worker_handoff_ledger_v1 before insert or update or delete on public.company_budget_ledger for each row execute function private.guard_worker_handoff_legacy_paths_v1();
drop trigger if exists zz_guard_worker_handoff_expense_payment_v1 on public.arka_pending_payments;
create trigger zz_guard_worker_handoff_expense_payment_v1 before update or delete on public.arka_pending_payments for each row execute function private.guard_worker_handoff_legacy_paths_v1();
drop trigger if exists zz_guard_worker_handoff_expense_decision_v1 on public.arka_expense_decisions;
create trigger zz_guard_worker_handoff_expense_decision_v1 before insert or update or delete on public.arka_expense_decisions for each row execute function private.guard_worker_handoff_legacy_paths_v1();
create unique index if not exists worker_handoff_expense_reclass_unique on public.company_budget_ledger(source_id) where source_type='worker_handoff_expense_reclass';

-- Serialize new coverage from both the wizard and older meal clients. A duplicate
-- beneficiary/day rolls the entire meal transaction back, including its payer row.
create or replace function private.guard_worker_handoff_meal_coverage_v1()
returns trigger language plpgsql security definer set search_path=pg_catalog,public,private as $fn$
declare day date;
begin
  if new.type<>'MEAL_COVERED' or new.status in ('REJECTED','REFUZUAR','VOIDED','CANCELLED','CANCELED') then return new; end if;
  day:=private.worker_handoff_meal_day_v1(new.handoff_note,new.created_at);
  perform pg_advisory_xact_lock(hashtext('WHW_MEAL_COVERAGE:'||coalesce(new.created_by_pin,'')||':'||day::text));
  if exists(select 1 from public.arka_pending_payments p where p.type='MEAL_COVERED' and p.created_by_pin=new.created_by_pin
    and p.status not in ('REJECTED','REFUZUAR','VOIDED','CANCELLED','CANCELED') and private.worker_handoff_meal_day_v1(p.handoff_note,p.created_at)=day) then raise exception 'WHW_MEAL_ALREADY_COVERED'; end if;
  return new;
end;
$fn$;
drop trigger if exists zz_guard_worker_handoff_meal_coverage_v1 on public.arka_pending_payments;
create trigger zz_guard_worker_handoff_meal_coverage_v1 before insert on public.arka_pending_payments for each row execute function private.guard_worker_handoff_meal_coverage_v1();

create or replace function public.preview_worker_handoff_v1(p_actor_id uuid,p_options jsonb)
returns jsonb language sql stable security invoker set search_path=pg_catalog,private as $fn$ select private.preview_worker_handoff_v1(p_actor_id,p_options) $fn$;
create or replace function public.submit_worker_handoff_v1(p_actor_id uuid,p_snapshot_hash text,p_request_key text,p_options jsonb,p_physical_cash numeric,p_difference_reason text)
returns jsonb language sql security invoker set search_path=pg_catalog,private as $fn$ select private.submit_worker_handoff_v1(p_actor_id,p_snapshot_hash,p_request_key,p_options,p_physical_cash,p_difference_reason) $fn$;
create or replace function public.read_worker_handoff_submission_v1(p_actor_id uuid,p_handoff_id bigint)
returns jsonb language sql stable security invoker set search_path=pg_catalog,private as $fn$ select private.read_worker_handoff_submission_v1(p_actor_id,p_handoff_id) $fn$;
create or replace function public.decide_worker_handoff_expense_v1(p_actor_id uuid,p_claim_id bigint,p_approve boolean,p_note text,p_request_key text)
returns jsonb language sql security invoker set search_path=pg_catalog,private as $fn$ select private.decide_worker_handoff_expense_v1(p_actor_id,p_claim_id,p_approve,p_note,p_request_key) $fn$;
create or replace function public.reimburse_worker_handoff_expense_v1(p_actor_id uuid,p_claim_id bigint,p_amount numeric,p_note text,p_request_key text)
returns jsonb language sql security invoker set search_path=pg_catalog,private as $fn$ select private.reimburse_worker_handoff_expense_v1(p_actor_id,p_claim_id,p_amount,p_note,p_request_key) $fn$;

revoke all on function private.worker_handoff_actor_v1(uuid,boolean),private.worker_handoff_meal_day_v1(text,timestamptz),private.guard_worker_handoff_creation_v1(),private.guard_worker_handoff_evidence_v1(),private.guard_worker_handoff_legacy_paths_v1(),private.guard_worker_handoff_meal_coverage_v1() from public,anon,authenticated,service_role;
revoke all on function private.preview_worker_handoff_v1(uuid,jsonb),private.submit_worker_handoff_v1(uuid,text,text,jsonb,numeric,text),private.read_worker_handoff_submission_v1(uuid,bigint),private.decide_worker_handoff_expense_v1(uuid,bigint,boolean,text,text),private.reimburse_worker_handoff_expense_v1(uuid,bigint,numeric,text,text),
  public.preview_worker_handoff_v1(uuid,jsonb),public.submit_worker_handoff_v1(uuid,text,text,jsonb,numeric,text),public.read_worker_handoff_submission_v1(uuid,bigint),public.decide_worker_handoff_expense_v1(uuid,bigint,boolean,text,text),public.reimburse_worker_handoff_expense_v1(uuid,bigint,numeric,text,text) from public,anon,authenticated;
grant usage on schema private to service_role;
grant execute on function private.preview_worker_handoff_v1(uuid,jsonb),private.submit_worker_handoff_v1(uuid,text,text,jsonb,numeric,text),private.read_worker_handoff_submission_v1(uuid,bigint),private.decide_worker_handoff_expense_v1(uuid,bigint,boolean,text,text),private.reimburse_worker_handoff_expense_v1(uuid,bigint,numeric,text,text),
  public.preview_worker_handoff_v1(uuid,jsonb),public.submit_worker_handoff_v1(uuid,text,text,jsonb,numeric,text),public.read_worker_handoff_submission_v1(uuid,bigint),public.decide_worker_handoff_expense_v1(uuid,bigint,boolean,text,text),public.reimburse_worker_handoff_expense_v1(uuid,bigint,numeric,text,text) to service_role;
