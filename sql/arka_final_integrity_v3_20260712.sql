-- ARKA FINAL INTEGRITY V3 — 2026-07-12
-- Production-safe guards for BASE, TRANSPORT, DISPATCH, handoffs, expenses and budget.

create unique index if not exists ux_cash_handoff_items_pending_payment_once
on public.cash_handoff_items(pending_payment_id)
where pending_payment_id is not null;

create unique index if not exists ux_company_budget_ledger_source_once
on public.company_budget_ledger(source_type,source_id)
where source_id is not null;

-- BUSINESS_EXPENSE is posted to company budget atomically and idempotently.
create or replace function public.finalize_business_or_rejected_expense_decision(
  p_decision_id bigint,
  p_actor_pin text,
  p_actor_name text
) returns jsonb
language plpgsql
security definer
set search_path to 'public','pg_temp'
as $function$
declare
  v_decision public.arka_expense_decisions%rowtype;
  v_expense public.arka_pending_payments%rowtype;
  v_amount numeric;
  v_now timestamptz := now();
  v_mode text;
  v_new_status text;
  v_note_marker text;
  v_ledger_id bigint;
  v_ledger_existed boolean := false;
  v_balance_before numeric;
  v_balance_after numeric;
begin
  if p_decision_id is null then raise exception 'MISSING_DECISION_ID'; end if;
  if nullif(trim(coalesce(p_actor_pin,'')),'') is null then raise exception 'MISSING_ACTOR_PIN'; end if;

  select * into v_decision from public.arka_expense_decisions
  where id=p_decision_id for update;
  if not found then raise exception 'DECISION_NOT_FOUND'; end if;
  if coalesce(v_decision.decision_type,'') not in ('BUSINESS_EXPENSE','REJECTED_OPEN_CASH') then
    raise exception 'UNSUPPORTED_DECISION_TYPE_FOR_THIS_RPC';
  end if;

  select * into v_expense from public.arka_pending_payments
  where id=v_decision.expense_payment_id for update;
  if not found then raise exception 'EXPENSE_PAYMENT_NOT_FOUND'; end if;
  if coalesce(v_expense.type,'')<>'EXPENSE' then raise exception 'ORIGINAL_PAYMENT_NOT_EXPENSE'; end if;

  select exists(select 1 from public.company_budget_ledger
    where source_type='arka_expense_decision' and source_id=v_decision.id)
  into v_ledger_existed;

  if v_decision.finalized_payment_id is not null then
    select id into v_ledger_id from public.company_budget_ledger
    where source_type='arka_expense_decision' and source_id=v_decision.id limit 1;
    return jsonb_build_object('ok',true,'already_finalized',true,
      'mode',v_decision.finalized_result,'decision_id',v_decision.id,
      'expense_payment_id',v_expense.id,'amount',coalesce(v_decision.amount_snapshot,v_expense.amount,0),
      'expense_status',v_expense.status,'finalized_payment_id',v_decision.finalized_payment_id,
      'ledger_id',v_ledger_id);
  end if;

  if coalesce(v_decision.decision_status,'')<>'ACTIVE' then raise exception 'DECISION_NOT_ACTIVE'; end if;
  if coalesce(v_expense.status,'') not in ('PENDING','COLLECTED','PENDING_DISPATCH_APPROVAL') then
    raise exception 'EXPENSE_PAYMENT_NOT_OPEN';
  end if;

  v_amount:=round(coalesce(v_decision.amount_snapshot,v_expense.amount,0)::numeric,2);
  if round(coalesce(v_expense.amount,0)::numeric,2)<>round(coalesce(v_decision.amount_snapshot,0)::numeric,2) then
    raise exception 'EXPENSE_AMOUNT_CHANGED_AFTER_DECISION';
  end if;
  if v_amount<=0 then raise exception 'INVALID_EXPENSE_AMOUNT'; end if;

  if v_decision.decision_type='BUSINESS_EXPENSE' then
    v_mode:='BUSINESS_EXPENSE';
    v_new_status:='ACCEPTED_BY_DISPATCH';
    v_note_marker:='BUSINESS_EXPENSE_DECISION decision_id:'||v_decision.id;

    insert into public.company_budget_summary(id,current_balance,total_in,total_out,updated_at)
    values(1,0,0,0,v_now) on conflict(id) do nothing;
    select current_balance into v_balance_before from public.company_budget_summary where id=1 for update;

    insert into public.company_budget_ledger(
      direction,amount,category,description,source_type,source_id,
      created_by_pin,created_by_name,approved_by_pin,approved_by_name,created_at
    ) values(
      'OUT',v_amount,'BUSINESS_EXPENSE',
      concat('SHPENZIM BIZNESI — ',coalesce(v_expense.created_by_name,v_expense.created_by_pin,'PUNTOR'),' — ',coalesce(v_expense.note,'PA SHENIM')),
      'arka_expense_decision',v_decision.id,
      nullif(trim(coalesce(p_actor_pin,'')),''),nullif(trim(coalesce(p_actor_name,'')),''),
      nullif(trim(coalesce(p_actor_pin,'')),''),nullif(trim(coalesce(p_actor_name,'')),''),v_now
    ) on conflict (source_type,source_id) where source_id is not null do nothing
    returning id into v_ledger_id;

    if not v_ledger_existed and v_ledger_id is not null then
      update public.company_budget_summary
      set current_balance=round((coalesce(current_balance,0)-v_amount)::numeric,2),
          total_out=round((coalesce(total_out,0)+v_amount)::numeric,2),updated_at=v_now
      where id=1;
    end if;
    if v_ledger_id is null then
      select id into v_ledger_id from public.company_budget_ledger
      where source_type='arka_expense_decision' and source_id=v_decision.id limit 1;
    end if;
    select current_balance into v_balance_after from public.company_budget_summary where id=1;
  else
    v_mode:='REJECTED_OPEN_CASH';
    v_new_status:='REJECTED';
    v_note_marker:='REJECTED_OPEN_CASH_DECISION decision_id:'||v_decision.id;
  end if;

  update public.arka_pending_payments
  set status=v_new_status,approved_by_pin=nullif(trim(coalesce(p_actor_pin,'')),''),
      approved_by_name=nullif(trim(coalesce(p_actor_name,'')),''),updated_at=v_now,
      handoff_note=case when nullif(trim(coalesce(handoff_note,'')),'') is null
        then v_note_marker else handoff_note||'; '||v_note_marker end
  where id=v_expense.id;

  update public.arka_expense_decisions
  set finalized_at=v_now,finalized_by_pin=nullif(trim(coalesce(p_actor_pin,'')),''),
      finalized_by_name=nullif(trim(coalesce(p_actor_name,'')),''),finalized_result=v_mode,
      finalized_payment_id=v_expense.id
  where id=v_decision.id;

  return jsonb_build_object('ok',true,'mode',v_mode,'decision_id',v_decision.id,
    'expense_payment_id',v_expense.id,'amount',v_amount,'expense_status',v_new_status,
    'finalized_payment_id',v_expense.id,'ledger_id',v_ledger_id,
    'balance_before',v_balance_before,'balance_after',v_balance_after);
end;
$function$;
