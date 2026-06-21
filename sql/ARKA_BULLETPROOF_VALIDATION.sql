-- ARKA BULLETPROOF VALIDATION V1
-- Run before migration, after migration, and daily during rollout.

-- 1) Duplicate idempotency keys. Target: 0 rows before creating unique index.
select idempotency_key, count(*) c, array_agg(id order by id) ids
from public.arka_pending_payments
where idempotency_key is not null
group by idempotency_key having count(*) > 1
order by c desc, idempotency_key;

-- 2) Duplicate ledger source pairs. Target: 0 rows before unique index.
select source_type, source_id, count(*) c, array_agg(id order by id) ids
from public.company_budget_ledger
where source_type is not null and source_id is not null
group by source_type, source_id having count(*) > 1
order by c desc, source_type, source_id;

-- 3) Negative handoff items. Target: 0.
select count(*) as negative_handoff_items
from public.cash_handoff_items
where amount < 0;

-- 4) Handoff amount vs item sum mismatch. Target: 0 rows.
select h.id, h.status, h.amount, coalesce(sum(i.amount),0) item_sum, round((h.amount - coalesce(sum(i.amount),0))::numeric,2) diff
from public.cash_handoffs h
left join public.cash_handoff_items i on i.handoff_id = h.id
where h.status in ('PENDING_DISPATCH_APPROVAL','ACCEPTED')
group by h.id, h.status, h.amount
having abs(h.amount - coalesce(sum(i.amount),0)) > 0.01
order by h.id desc;

-- 5) Meal double-settlement. Target: 0 rows.
select p.id, p.amount, p.handoff_note
from public.arka_pending_payments p
where p.type = 'MEAL_PAYMENT'
  and upper(coalesce(p.handoff_note,'')) like 'SETTLED_IN_HANDOFF:%'
  and exists (select 1 from public.cash_handoff_items i where i.pending_payment_id = p.id)
order by p.id desc;

-- 6) Legacy/stale meal rows still open without guarded marker. Review only, no auto-fix.
select id, amount, created_by_pin, created_by_name, status, handoff_note, created_at
from public.arka_pending_payments
where type = 'MEAL_PAYMENT'
  and upper(coalesce(status,'')) in ('PENDING','COLLECTED','PENDING_DISPATCH_APPROVAL','ACCEPTED_BY_DISPATCH','APPROVED','ACCEPTED')
  and coalesce(handoff_note,'') !~* 'MEAL_(DAY|OPEN|CARRY|DEBT):[0-9]{4}-[0-9]{2}-[0-9]{2}'
  and upper(coalesce(handoff_note,'')) not like 'SETTLED_IN_HANDOFF:%'
order by created_at desc;

-- 7) Cancelled empty shells. Should stop increasing after atomic handoff rollout.
select h.id, h.worker_name, h.worker_pin, h.amount, h.submitted_at, count(i.id) items
from public.cash_handoffs h
left join public.cash_handoff_items i on i.handoff_id = h.id
where h.status = 'CANCELLED'
group by h.id, h.worker_name, h.worker_pin, h.amount, h.submitted_at
having count(i.id) = 0
order by h.id desc;

-- 8) Ledger vs summary reconciliation.
select
  (select coalesce(sum(amount),0) from public.company_budget_ledger where upper(direction)='IN') as ledger_in,
  (select coalesce(sum(amount),0) from public.company_budget_ledger where upper(direction)='OUT') as ledger_out,
  (select total_in from public.company_budget_summary where id=1) as summary_in,
  (select total_out from public.company_budget_summary where id=1) as summary_out;
