CREATE OR REPLACE FUNCTION public.close_arka_day_v2(p_actor_pin text, p_actor_name text, p_date date, p_handoff_ids bigint[] DEFAULT '{}'::bigint[], p_counted_cash numeric DEFAULT NULL::numeric, p_discrepancy_reason text DEFAULT NULL::text, p_discrepancy_note text DEFAULT NULL::text, p_idempotency_key text DEFAULT NULL::text, p_dry_run boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_role text;
  v_actor_name text;
  v_date date := coalesce(p_date,(now() at time zone 'Europe/Belgrade' - interval '4 hours')::date);
  v_today date := (now() at time zone 'Europe/Belgrade' - interval '4 hours')::date;
  v_start timestamptz := (v_date::timestamp + interval '4 hours') at time zone 'Europe/Belgrade';
  v_end timestamptz := ((v_date+1)::timestamp + interval '4 hours') at time zone 'Europe/Belgrade';
  v_ids bigint[] := '{}'::bigint[];
  v_count integer := 0;
  v_selected_total numeric(12,2) := 0;
  v_pending_expenses integer := 0;
  v_balance_before numeric(12,2) := 0;
  v_expected numeric(12,2) := 0;
  v_counted numeric(12,2) := 0;
  v_discrepancy numeric(12,2) := 0;
  v_cycle_id bigint;
  v_existing public.arka_cycles%rowtype;
  v_handoff_id bigint;
  v_accept jsonb;
  v_balance_after_handoffs numeric(12,2);
  v_final_balance numeric(12,2);
  v_discrepancy_ledger_id bigint;
  v_day_in numeric(12,2);
  v_day_out numeric(12,2);
  v_day_handoffs numeric(12,2);
  v_day_expenses numeric(12,2);
  v_day_advances numeric(12,2);
  v_opening numeric(12,2);
  v_reason text := upper(trim(coalesce(p_discrepancy_reason,'')));
  v_note text := trim(coalesce(p_discrepancy_note,''));
  v_key text;
begin
  select upper(coalesce(role,'')),coalesce(nullif(trim(p_actor_name),''),name,trim(p_actor_pin))
  into v_role,v_actor_name
  from public.users
  where pin=trim(coalesce(p_actor_pin,'')) and is_active is true
  limit 1;
  if v_role not in ('DISPATCH','MASTER','MASTER USER','MASTER_USER','MASTERUSER','ADMIN','ADMIN_MASTER','OWNER','PRONAR','SUPERADMIN') then
    raise exception 'DISPATCH_ONLY';
  end if;
  if v_date>v_today then raise exception 'CANNOT_CLOSE_FUTURE_DATE'; end if;
  if p_counted_cash is null or round(p_counted_cash::numeric,2)<0 then raise exception 'INVALID_COUNTED_CASH'; end if;

  select coalesce(array_agg(x order by x),'{}'::bigint[]) into v_ids
  from (select distinct unnest(coalesce(p_handoff_ids,'{}'::bigint[])) x) q
  where x>0;

  select count(*)::int,coalesce(round(sum(amount)::numeric,2),0)
  into v_count,v_selected_total
  from public.cash_handoffs
  where id=any(v_ids) and upper(coalesce(status,''))='PENDING_DISPATCH_APPROVAL';
  if v_count <> cardinality(v_ids) then raise exception 'HANDOFF_SELECTION_CHANGED_OR_INVALID'; end if;

  select count(*)::int into v_pending_expenses
  from public.arka_pending_payments
  where upper(coalesce(type,''))='EXPENSE'
    and upper(coalesce(status,'')) in ('PENDING','PENDING_DISPATCH_APPROVAL');
  if v_pending_expenses>0 then raise exception 'PENDING_EXPENSES_MUST_BE_DECIDED:%',v_pending_expenses; end if;

  insert into public.company_budget_summary(id,current_balance,total_in,total_out,updated_at)
  values(1,0,0,0,now()) on conflict(id) do nothing;
  select round(coalesce(current_balance,0)::numeric,2) into v_balance_before
  from public.company_budget_summary where id=1;

  v_expected := round((v_balance_before+v_selected_total)::numeric,2);
  v_counted := round(p_counted_cash::numeric,2);
  v_discrepancy := round((v_counted-v_expected)::numeric,2);

  if abs(v_discrepancy)>0.01 and (v_reason='' or length(v_note)<4) then
    raise exception 'DISCREPANCY_REASON_AND_NOTE_REQUIRED expected=% counted=% difference=%',v_expected,v_counted,v_discrepancy;
  end if;

  if p_dry_run then
    return jsonb_build_object(
      'ok',true,'dry_run',true,'date',v_date,'budget_before',v_balance_before,
      'selected_handoff_ids',v_ids,'selected_handoffs_total',v_selected_total,
      'expected_cash',v_expected,'counted_cash',v_counted,'discrepancy',v_discrepancy,
      'pending_expenses',v_pending_expenses
    );
  end if;

  perform pg_advisory_xact_lock(hashtext('ARKA_DAILY_CLOSE_V2:'||v_date::text));
  select * into v_existing from public.arka_cycles where cycle_date=v_date for update;
  -- A previous finalization is a report snapshot, not a permanent lock.
  -- Distinct worker handoffs submitted later reopen the same operational-day flow.

  v_key := coalesce(nullif(trim(p_idempotency_key),''),
    'ARKA_DAILY_CLOSE_V2:'||v_date::text||':'||md5(array_to_string(v_ids,',')||':'||v_counted::text));

  if found then
    v_cycle_id := v_existing.id;
    update public.arka_cycles
    set idempotency_key=v_key,
        is_closed=false,
        close_status='CLOSING',
        closed_at=null,
        updated_at=now()
    where id=v_cycle_id;
  else
    insert into public.arka_cycles(
      cycle_date,opening_cash,closing_cash,total_in,total_out,notes,
      opened_by_pin,opened_by_name,closed_by_pin,closed_by_name,is_closed,
      created_at,updated_at,close_status,expected_cash,counted_cash,discrepancy,
      discrepancy_reason,discrepancy_note,budget_balance_before,budget_balance_after,
      accepted_handoffs_total,posted_expenses_total,posted_advances_total,
      selected_handoff_ids,idempotency_key,close_version,closed_at
    ) values (
      v_date,v_balance_before,v_counted,0,0,v_note,
      trim(p_actor_pin),v_actor_name,null,null,false,
      now(),now(),'CLOSING',v_expected,v_counted,v_discrepancy,
      nullif(v_reason,''),nullif(v_note,''),v_balance_before,null,
      0,0,0,v_ids,v_key,'ARKA_DAILY_CLOSE_V2',null
    ) returning id into v_cycle_id;
  end if;

  perform set_config('tepiha.daily_close_context','on',true);

  foreach v_handoff_id in array v_ids loop
    v_accept := public.accept_cash_handoff_atomic(v_handoff_id,trim(p_actor_pin),v_actor_name);
    if coalesce((v_accept->>'ok')::boolean,false) is not true then
      raise exception 'HANDOFF_ACCEPT_FAILED:%',v_handoff_id;
    end if;
  end loop;

  select round(coalesce(current_balance,0)::numeric,2) into v_balance_after_handoffs
  from public.company_budget_summary where id=1 for update;

  v_discrepancy := round((v_counted-v_balance_after_handoffs)::numeric,2);
  if abs(v_discrepancy)>0.01 then
    insert into public.company_budget_ledger(
      direction,amount,category,description,source_type,source_id,related_handoff_id,
      created_by_pin,created_by_name,approved_by_pin,approved_by_name,created_at
    ) values (
      case when v_discrepancy>0 then 'IN' else 'OUT' end,
      abs(v_discrepancy),'DAILY_CASH_DISCREPANCY',
      'MBYLLJA DITORE '||v_date::text||' — PRITEJ '||v_balance_after_handoffs::text||
        '€ — U NUMËRUAN '||v_counted::text||'€ — DIFERENCA '||v_discrepancy::text||
        '€ — ARSYE '||v_reason||' — '||v_note,
      'arka_daily_close',v_cycle_id,null,
      trim(p_actor_pin),v_actor_name,trim(p_actor_pin),v_actor_name,now()
    ) returning id into v_discrepancy_ledger_id;

    update public.company_budget_summary
    set current_balance=v_counted,
        total_in=case when v_discrepancy>0 then round((coalesce(total_in,0)+abs(v_discrepancy))::numeric,2) else total_in end,
        total_out=case when v_discrepancy<0 then round((coalesce(total_out,0)+abs(v_discrepancy))::numeric,2) else total_out end,
        updated_at=now()
    where id=1;
  end if;

  select round(coalesce(current_balance,0)::numeric,2) into v_final_balance
  from public.company_budget_summary where id=1;
  if abs(v_final_balance-v_counted)>0.01 then
    raise exception 'FINAL_BUDGET_DOES_NOT_MATCH_COUNTED_CASH:%:%',v_final_balance,v_counted;
  end if;

  insert into public.arka_daily_close_items(
    cycle_id,item_type,source_table,source_id,worker_pin,worker_name,amount,direction,status_snapshot,included,confirmed,note
  )
  select v_cycle_id,'HANDOFF','cash_handoffs',h.id,h.worker_pin,h.worker_name,round(h.amount::numeric,2),'IN',h.status,true,true,
         case when h.id=any(v_ids) then 'CONFIRMED IN THIS CLOSE' else 'ACCEPTED EARLIER THIS DAY' end
  from public.cash_handoffs h
  where h.decided_at>=v_start and h.decided_at<v_end
    and upper(coalesce(h.status,'')) in ('ACCEPTED','ACCEPTED_BY_DISPATCH')
  on conflict (cycle_id,item_type,source_table,source_id) where source_id is not null do nothing;

  insert into public.arka_daily_close_items(
    cycle_id,item_type,source_table,source_id,worker_pin,worker_name,amount,direction,status_snapshot,included,confirmed,note
  )
  select v_cycle_id,
         case when l.source_type='arka_advance' then 'ADVANCE' else 'EXPENSE' end,
         'company_budget_ledger',l.id,l.created_by_pin,l.created_by_name,round(l.amount::numeric,2),'OUT','POSTED',true,true,l.description
  from public.company_budget_ledger l
  where l.created_at>=v_start and l.created_at<v_end
    and l.direction='OUT'
    and l.source_type in ('arka_expense_decision','arka_advance')
  on conflict (cycle_id,item_type,source_table,source_id) where source_id is not null do nothing;

  if v_discrepancy_ledger_id is not null then
    insert into public.arka_daily_close_items(
      cycle_id,item_type,source_table,source_id,worker_pin,worker_name,amount,direction,status_snapshot,included,confirmed,note
    ) values (
      v_cycle_id,'DISCREPANCY','company_budget_ledger',v_discrepancy_ledger_id,
      trim(p_actor_pin),v_actor_name,abs(v_discrepancy),case when v_discrepancy>0 then 'IN' else 'OUT' end,
      'POSTED',true,true,v_reason||' — '||v_note
    ) on conflict (cycle_id,item_type,source_table,source_id) where source_id is not null do nothing;
  end if;

  select coalesce(round(sum(amount)::numeric,2),0) into v_day_in
  from public.company_budget_ledger where created_at>=v_start and created_at<v_end and direction='IN';
  select coalesce(round(sum(amount)::numeric,2),0) into v_day_out
  from public.company_budget_ledger where created_at>=v_start and created_at<v_end and direction='OUT';
  select coalesce(round(sum(amount)::numeric,2),0) into v_day_handoffs
  from public.company_budget_ledger where created_at>=v_start and created_at<v_end and direction='IN' and source_type='cash_handoff';
  select coalesce(round(sum(amount)::numeric,2),0) into v_day_expenses
  from public.company_budget_ledger where created_at>=v_start and created_at<v_end and direction='OUT' and source_type='arka_expense_decision';
  select coalesce(round(sum(amount)::numeric,2),0) into v_day_advances
  from public.company_budget_ledger where created_at>=v_start and created_at<v_end and direction='OUT' and source_type='arka_advance';
  v_opening := round((v_final_balance-v_day_in+v_day_out)::numeric,2);

  update public.arka_cycles
  set opening_cash=v_opening,
      closing_cash=v_final_balance,
      total_in=v_day_in,
      total_out=v_day_out,
      notes=v_note,
      closed_by_pin=trim(p_actor_pin),
      closed_by_name=v_actor_name,
      is_closed=true,
      updated_at=now(),
      close_status='CLOSED',
      expected_cash=v_balance_after_handoffs,
      counted_cash=v_counted,
      discrepancy=v_discrepancy,
      discrepancy_reason=nullif(v_reason,''),
      discrepancy_note=nullif(v_note,''),
      budget_balance_before=v_balance_before,
      budget_balance_after=v_final_balance,
      accepted_handoffs_total=v_day_handoffs,
      posted_expenses_total=v_day_expenses,
      posted_advances_total=v_day_advances,
      selected_handoff_ids=(
        select coalesce(array_agg(distinct selected_id order by selected_id),'{}'::bigint[])
        from unnest(coalesce(arka_cycles.selected_handoff_ids,'{}'::bigint[]) || v_ids) selected_id
      ),
      discrepancy_ledger_entry_id=v_discrepancy_ledger_id,
      closed_at=now()
  where id=v_cycle_id;

  return jsonb_build_object(
    'ok',true,'already_closed',false,
    'cycle',(select to_jsonb(c) from public.arka_cycles c where c.id=v_cycle_id),
    'items',(select coalesce(jsonb_agg(to_jsonb(i) order by i.id),'[]'::jsonb) from public.arka_daily_close_items i where i.cycle_id=v_cycle_id),
    'budget_balance',v_final_balance
  );
end;
$function$
;

CREATE OR REPLACE FUNCTION public.get_arka_daily_close_preview_v2(p_actor_pin text, p_date date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_role text;
  v_date date := coalesce(p_date,(now() at time zone 'Europe/Belgrade' - interval '4 hours')::date);
  v_today date := (now() at time zone 'Europe/Belgrade' - interval '4 hours')::date;
  v_start timestamptz := (v_date::timestamp + interval '4 hours') at time zone 'Europe/Belgrade';
  v_end timestamptz := ((v_date+1)::timestamp + interval '4 hours') at time zone 'Europe/Belgrade';
  v_balance numeric(12,2);
  v_result jsonb;
begin
  select upper(coalesce(role,'')) into v_role
  from public.users
  where pin=trim(coalesce(p_actor_pin,'')) and is_active is true
  limit 1;
  if v_role not in ('DISPATCH','MASTER','MASTER USER','MASTER_USER','MASTERUSER','ADMIN','ADMIN_MASTER','OWNER','PRONAR','SUPERADMIN') then
    raise exception 'DISPATCH_ONLY';
  end if;

  select round(coalesce(current_balance,0)::numeric,2) into v_balance
  from public.company_budget_summary where id=1;
  v_balance := coalesce(v_balance,0);

  with pending_handoffs as (
    select h.id,h.worker_pin,h.worker_name,round(h.amount::numeric,2) amount,h.status,h.submitted_at,h.note,
           count(i.id)::int item_count
    from public.cash_handoffs h
    left join public.cash_handoff_items i on i.handoff_id=h.id
    where upper(coalesce(h.status,''))='PENDING_DISPATCH_APPROVAL'
    group by h.id
  ),
  pending_expenses as (
    select p.id,round(p.amount::numeric,2) amount,p.status,p.note,p.created_by_pin worker_pin,p.created_by_name worker_name,p.created_at
    from public.arka_pending_payments p
    where upper(coalesce(p.type,''))='EXPENSE'
      and upper(coalesce(p.status,'')) in ('PENDING','PENDING_DISPATCH_APPROVAL')
  ),
  ledger_day as (
    select l.* from public.company_budget_ledger l
    where l.created_at>=v_start and l.created_at<v_end
  ),
  open_cash as (
    select p.*
    from public.arka_pending_payments p
    where upper(coalesce(p.type,'')) in ('IN','TRANSPORT','ORDER')
      and upper(coalesce(p.status,'')) in ('PENDING','COLLECTED')
      and not exists(
        select 1 from public.cash_handoff_items i
        join public.cash_handoffs h on h.id=i.handoff_id
        where i.pending_payment_id=p.id
          and upper(coalesce(h.status,'')) in ('PENDING_DISPATCH_APPROVAL','ACCEPTED','ACCEPTED_BY_DISPATCH')
      )
  ),
  open_cash_workers as (
    select coalesce(p.created_by_pin,p.handed_by_pin,'PA PIN') worker_pin,
           coalesce(max(p.created_by_name),max(p.handed_by_name),'PA EMËR') worker_name,
           count(*)::int payment_count,round(sum(p.amount)::numeric,2) amount
    from open_cash p
    group by coalesce(p.created_by_pin,p.handed_by_pin,'PA PIN')
  )
  select jsonb_build_object(
    'version','ARKA_DAILY_CLOSE_V2',
    'date',v_date,
    'today',v_today,
    'can_close',v_date=v_today and not exists(select 1 from public.arka_cycles c where c.cycle_date=v_date and c.is_closed is true),
    'current_budget',v_balance,
    'expected_after_all_handoffs',round((v_balance+coalesce((select sum(amount) from pending_handoffs),0))::numeric,2),
    'pending_handoffs',coalesce((select jsonb_agg(jsonb_build_object(
      'id',id,'worker_pin',worker_pin,'worker_name',worker_name,'amount',amount,'status',status,
      'submitted_at',submitted_at,'note',note,'item_count',item_count
    ) order by submitted_at,id) from pending_handoffs),'[]'::jsonb),
    'pending_handoffs_total',coalesce((select round(sum(amount)::numeric,2) from pending_handoffs),0),
    'pending_handoffs_count',(select count(*) from pending_handoffs),
    'pending_expenses',coalesce((select jsonb_agg(jsonb_build_object(
      'id',id,'amount',amount,'status',status,'note',note,'worker_pin',worker_pin,'worker_name',worker_name,'created_at',created_at
    ) order by created_at,id) from pending_expenses),'[]'::jsonb),
    'pending_expenses_total',coalesce((select round(sum(amount)::numeric,2) from pending_expenses),0),
    'pending_expenses_count',(select count(*) from pending_expenses),
    'today_ledger',jsonb_build_object(
      'in',coalesce((select round(sum(amount)::numeric,2) from ledger_day where upper(direction)='IN'),0),
      'out',coalesce((select round(sum(amount)::numeric,2) from ledger_day where upper(direction)='OUT'),0),
      'rows',coalesce((select jsonb_agg(jsonb_build_object(
        'id',id,'direction',direction,'amount',amount,'category',category,'description',description,
        'source_type',source_type,'source_id',source_id,'created_at',created_at
      ) order by created_at,id) from ledger_day),'[]'::jsonb)
    ),
    'today_expenses',jsonb_build_object(
      'total',coalesce((select round(sum(amount)::numeric,2) from ledger_day where direction='OUT' and source_type='arka_expense_decision'),0),
      'count',(select count(*) from ledger_day where direction='OUT' and source_type='arka_expense_decision')
    ),
    'today_advances',jsonb_build_object(
      'total',coalesce((select round(sum(amount)::numeric,2) from ledger_day where direction='OUT' and source_type='arka_advance'),0),
      'count',(select count(*) from ledger_day where direction='OUT' and source_type='arka_advance')
    ),
    'open_cash_at_workers',coalesce((select jsonb_agg(jsonb_build_object(
      'worker_pin',worker_pin,'worker_name',worker_name,'payment_count',payment_count,'amount',amount
    ) order by worker_name,worker_pin) from open_cash_workers),'[]'::jsonb),
    'open_cash_at_workers_total',coalesce((select round(sum(amount)::numeric,2) from open_cash_workers),0),
    'closed_cycle',(select to_jsonb(c) from public.arka_cycles c where c.cycle_date=v_date limit 1),
    'last_closed_cycle',(select to_jsonb(c) from public.arka_cycles c where c.is_closed is true order by c.cycle_date desc,c.id desc limit 1),
    'generated_at',now()
  ) into v_result;

  return v_result;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.get_arka_daily_close_preview_v3(p_actor_pin text, p_date date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_date date := coalesce(p_date,(now() at time zone 'Europe/Belgrade' - interval '4 hours')::date);
  v_start timestamptz := (v_date::timestamp + interval '4 hours') at time zone 'Europe/Belgrade';
  v_end timestamptz := ((v_date+1)::timestamp + interval '4 hours') at time zone 'Europe/Belgrade';
  v_result jsonb;
  v_open_rows jsonb := '[]'::jsonb;
  v_open_total numeric(12,2) := 0;
  v_received jsonb := '[]'::jsonb;
  v_closed_items jsonb := '[]'::jsonb;
begin
  v_result := public.get_arka_daily_close_preview_v2(p_actor_pin,v_date);

  with open_cash as (
    select p.*
    from public.arka_pending_payments p
    join public.users u
      on u.pin=coalesce(nullif(trim(p.created_by_pin),''),nullif(trim(p.handed_by_pin),''))
     and u.is_active is true
     and upper(coalesce(u.role,'')) in ('PUNTOR','WORKER','TRANSPORT','DRIVER','SHOFER')
    where upper(coalesce(p.type,'')) in ('IN','TRANSPORT','ORDER')
      and upper(coalesce(p.status,'')) in ('PENDING','COLLECTED')
      and not exists(
        select 1
        from public.cash_handoff_items i
        join public.cash_handoffs h on h.id=i.handoff_id
        where i.pending_payment_id=p.id
          and upper(coalesce(h.status,'')) in ('PENDING_DISPATCH_APPROVAL','ACCEPTED','ACCEPTED_BY_DISPATCH')
      )
  ), grouped as (
    select coalesce(nullif(trim(p.created_by_pin),''),nullif(trim(p.handed_by_pin),''),'PA PIN') worker_pin,
           coalesce(max(u.name),max(p.created_by_name),max(p.handed_by_name),'PA EMËR') worker_name,
           count(*)::int payment_count,
           round(sum(p.amount)::numeric,2) amount
    from open_cash p
    left join public.users u on u.pin=coalesce(nullif(trim(p.created_by_pin),''),nullif(trim(p.handed_by_pin),''))
    group by coalesce(nullif(trim(p.created_by_pin),''),nullif(trim(p.handed_by_pin),''),'PA PIN')
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'worker_pin',worker_pin,'worker_name',worker_name,
           'payment_count',payment_count,'amount',amount
         ) order by worker_name,worker_pin),'[]'::jsonb),
         coalesce(round(sum(amount)::numeric,2),0)
  into v_open_rows,v_open_total
  from grouped;

  select coalesce(jsonb_agg(jsonb_build_object(
           'handoff_id',h.id,'worker_pin',h.worker_pin,'worker_name',h.worker_name,
           'amount',round(h.amount::numeric,2),'accepted_at',h.decided_at,
           'status',h.status,'ledger_entry_id',h.company_ledger_entry_id
         ) order by h.decided_at,h.id),'[]'::jsonb)
  into v_received
  from public.cash_handoffs h
  where h.decided_at>=v_start and h.decided_at<v_end
    and upper(coalesce(h.status,'')) in ('ACCEPTED','ACCEPTED_BY_DISPATCH');

  select coalesce(jsonb_agg(to_jsonb(i) order by i.id),'[]'::jsonb)
  into v_closed_items
  from public.arka_daily_close_items i
  join public.arka_cycles c on c.id=i.cycle_id
  where c.cycle_date=v_date and c.is_closed is true;

  v_result := jsonb_set(v_result,'{version}',to_jsonb('ARKA_DAILY_CLOSE_V3'::text),true);
  v_result := jsonb_set(v_result,'{open_cash_at_workers}',v_open_rows,true);
  v_result := jsonb_set(v_result,'{open_cash_at_workers_total}',to_jsonb(v_open_total),true);
  v_result := jsonb_set(v_result,'{received_today}',v_received,true);
  v_result := jsonb_set(v_result,'{closed_items}',v_closed_items,true);
  v_result := jsonb_set(v_result,'{policy}',jsonb_build_object(
    'handoff_acceptance','DAILY_CLOSE_ONLY',
    'advance_posting','IMMEDIATE_BUDGET_OUT',
    'expense_posting','APPROVED_BUDGET_OUT',
    'physical_cash','AUTHORITATIVE_AT_DAILY_CLOSE'
  ),true);
  return v_result;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.get_arka_daily_close_preview_v4(p_actor_pin text, p_date date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_date date := coalesce(p_date,(now() at time zone 'Europe/Belgrade' - interval '4 hours')::date);
  v_result jsonb;
  v_control jsonb;
begin
  v_result := public.get_arka_daily_close_preview_v3(p_actor_pin,v_date);
  v_control := public.get_dispatch_daily_control_v1(p_actor_pin,v_date);
  return coalesce(v_result,'{}'::jsonb) || jsonb_build_object(
    'version','ARKA_DAILY_CLOSE_V4',
    'business_day_cutoff_hour',4,
    'business_day_label','04:00–04:00',
    'operations',coalesce(v_control->'operations','{}'::jsonb),
    'operations_generated_at',v_control->'generated_at'
  );
end;
$function$
;
