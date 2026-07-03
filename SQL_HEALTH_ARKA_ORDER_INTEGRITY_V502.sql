-- ARKA / ORDER INTEGRITY HEALTH SCAN V502
-- READ ONLY

with duplicate_active_payments as (
  select
    'duplicate_active_payments'::text as check_name,
    count(*)::int as issue_count,
    coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) as sample
  from (
    select
      case
        when transport_order_id is not null then 'TRANSPORT:' || transport_order_id::text
        when order_id is not null then 'ORDER:' || order_id::text
        else 'NO_KEY'
      end as payment_key,
      round(amount::numeric, 2) as amount,
      type,
      count(*) as rows_count,
      array_agg(id order by created_at) as ids
    from public.arka_pending_payments
    where type in ('IN', 'TRANSPORT')
      and status not in ('VOIDED', 'REJECTED')
      and amount > 0
      and (order_id is not null or transport_order_id is not null)
    group by 1, 2, 3
    having count(*) > 1
    limit 20
  ) x
),

handoff_ledger_mismatch as (
  select
    'handoff_ledger_mismatch'::text as check_name,
    count(*)::int as issue_count,
    coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) as sample
  from (
    select
      h.id as handoff_id,
      h.amount as handoff_amount,
      l.id as ledger_id,
      l.amount as ledger_amount,
      round((coalesce(h.amount,0) - coalesce(l.amount,0))::numeric, 2) as difference,
      h.worker_pin,
      h.worker_name,
      l.source_type
    from public.cash_handoffs h
    left join public.company_budget_ledger l on l.id = h.company_ledger_entry_id
    where h.status = 'ACCEPTED'
      and (
        l.id is null
        or round(coalesce(h.amount,0)::numeric, 2) <> round(coalesce(l.amount,0)::numeric, 2)
        or l.source_type not in ('cash_handoff', 'master_cash_reconcile')
        or l.source_id::int <> h.id
      )
    order by h.decided_at desc
    limit 20
  ) x
),

budget_summary_mismatch as (
  select
    'budget_summary_mismatch'::text as check_name,
    case
      when abs(round((s.total_in - calc.ledger_total_in)::numeric, 2)) > 0
        or abs(round((s.total_out - calc.ledger_total_out)::numeric, 2)) > 0
        or abs(round((s.current_balance - calc.ledger_balance)::numeric, 2)) > 0
      then 1 else 0
    end as issue_count,
    jsonb_build_array(jsonb_build_object(
      'summary_total_in', s.total_in,
      'ledger_total_in', calc.ledger_total_in,
      'total_in_diff', round((s.total_in - calc.ledger_total_in)::numeric, 2),
      'summary_total_out', s.total_out,
      'ledger_total_out', calc.ledger_total_out,
      'total_out_diff', round((s.total_out - calc.ledger_total_out)::numeric, 2),
      'summary_current_balance', s.current_balance,
      'ledger_balance', calc.ledger_balance,
      'balance_diff', round((s.current_balance - calc.ledger_balance)::numeric, 2)
    )) as sample
  from public.company_budget_summary s
  cross join (
    select
      round(sum(case when direction = 'IN' then coalesce(amount,0) else 0 end)::numeric, 2) as ledger_total_in,
      round(sum(case when direction = 'OUT' then coalesce(amount,0) else 0 end)::numeric, 2) as ledger_total_out,
      round(sum(case when direction = 'IN' then coalesce(amount,0) when direction = 'OUT' then -coalesce(amount,0) else 0 end)::numeric, 2) as ledger_balance
    from public.company_budget_ledger
  ) calc
  where s.id = 1
),

arka_payment_but_order_unpaid as (
  select
    'arka_payment_but_order_unpaid'::text as check_name,
    count(*)::int as issue_count,
    coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) as sample
  from (
    select
      p.id as payment_id,
      p.order_id,
      p.order_code,
      p.amount,
      p.status as payment_status,
      p.client_name,
      o.status as order_status,
      o.data->'pay'->>'paid' as data_pay_paid,
      o.data->'pay'->>'debt' as data_pay_debt,
      p.created_at
    from public.arka_pending_payments p
    join public.orders o on o.id = p.order_id
    where p.type = 'IN'
      and p.status not in ('VOIDED', 'REJECTED')
      and coalesce((o.data->'pay'->>'paid')::numeric, 0) = 0
      and coalesce((o.data->'pay'->>'debt')::numeric, 0) > 0
    order by p.created_at desc
    limit 20
  ) x
),

paid_order_without_arka_payment as (
  select
    'paid_order_without_arka_payment'::text as check_name,
    count(*)::int as issue_count,
    coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) as sample
  from (
    select
      o.id as order_id,
      o.code as order_code,
      o.client_name,
      o.client_phone,
      o.status,
      o.price_total,
      o.data->'pay'->>'paid' as data_pay_paid,
      o.data->'pay'->>'debt' as data_pay_debt,
      o.data->'pay'->>'method' as pay_method,
      o.data->>'delivered_by' as delivered_by,
      o.delivered_at,
      o.updated_at
    from public.orders o
    where coalesce((o.data->'pay'->>'paid')::numeric, 0) > 0
      and coalesce((o.data->'pay'->>'debt')::numeric, 0) = 0
      and not exists (
        select 1 from public.arka_pending_payments p
        where p.order_id = o.id and p.status not in ('VOIDED', 'REJECTED')
      )
      and lower(coalesce(o.client_name, '')) not ilike '%test%'
      and lower(coalesce(o.client_name, '')) not ilike '%lis oruci%'
      and lower(coalesce(o.client_name, '')) not ilike '%ofline%'
      and lower(coalesce(o.client_name, '')) not ilike '%xxxx%'
      and lower(coalesce(o.client_name, '')) not ilike '%pa numer%'
      and coalesce(o.price_total, 0) > 0
    order by o.updated_at desc
    limit 20
  ) x
)

select * from duplicate_active_payments
union all select * from handoff_ledger_mismatch
union all select * from budget_summary_mismatch
union all select * from arka_payment_but_order_unpaid
union all select * from paid_order_without_arka_payment
order by issue_count desc, check_name;
