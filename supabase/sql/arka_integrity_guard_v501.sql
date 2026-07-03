-- ARKA / ORDER INTEGRITY GUARD V501
-- Apply after cleaning existing duplicates. Safe to run repeatedly.

begin;

-- One active row per idempotency key. This is the DB backstop for retries,
-- double taps, offline outbox replays, and app background sync races.
create unique index if not exists arka_pending_payments_active_idempotency_uidx
  on public.arka_pending_payments (idempotency_key)
  where idempotency_key is not null
    and status in ('PENDING', 'COLLECTED', 'PENDING_DISPATCH_APPROVAL', 'ACCEPTED_BY_DISPATCH');

-- Fast lookup used by the app/server duplicate guard.
create index if not exists arka_pending_payments_base_active_order_lookup_idx
  on public.arka_pending_payments (order_id, type, source_module, status, amount)
  where order_id is not null
    and type = 'IN'
    and source_module = 'BASE'
    and status in ('PENDING', 'COLLECTED', 'PENDING_DISPATCH_APPROVAL', 'ACCEPTED_BY_DISPATCH');

-- Fast lookup used by transport duplicate guard.
create index if not exists arka_pending_payments_transport_active_lookup_idx
  on public.arka_pending_payments (transport_order_id, type, source_module, status, amount)
  where transport_order_id is not null
    and type = 'TRANSPORT'
    and source_module = 'TRANSPORT'
    and status in ('PENDING', 'COLLECTED', 'PENDING_DISPATCH_APPROVAL', 'ACCEPTED_BY_DISPATCH');

commit;

-- Keep COMPANY_BUDGET_SUMMARY aligned with COMPANY_BUDGET_LEDGER forever.
-- This avoids drift from manual fixes, force payroll close, accepted handoffs, and budget spends.
create or replace function public.recompute_company_budget_summary_v501()
returns void
language plpgsql
security definer
as $$
declare
  v_total_in numeric := 0;
  v_total_out numeric := 0;
  v_balance numeric := 0;
begin
  select
    round(coalesce(sum(case when upper(direction) = 'IN' then coalesce(amount, 0) else 0 end), 0)::numeric, 2),
    round(coalesce(sum(case when upper(direction) = 'OUT' then coalesce(amount, 0) else 0 end), 0)::numeric, 2),
    round(coalesce(sum(case when upper(direction) = 'IN' then coalesce(amount, 0) when upper(direction) = 'OUT' then -coalesce(amount, 0) else 0 end), 0)::numeric, 2)
  into v_total_in, v_total_out, v_balance
  from public.company_budget_ledger;

  insert into public.company_budget_summary (id, total_in, total_out, current_balance, updated_at)
  values (1, v_total_in, v_total_out, v_balance, now())
  on conflict (id) do update
  set total_in = excluded.total_in,
      total_out = excluded.total_out,
      current_balance = excluded.current_balance,
      updated_at = excluded.updated_at;
end;
$$;

create or replace function public.company_budget_ledger_recompute_summary_trigger_v501()
returns trigger
language plpgsql
security definer
as $$
begin
  perform public.recompute_company_budget_summary_v501();
  return coalesce(new, old);
end;
$$;

drop trigger if exists company_budget_ledger_recompute_summary_v501 on public.company_budget_ledger;
create trigger company_budget_ledger_recompute_summary_v501
after insert or update or delete on public.company_budget_ledger
for each statement execute function public.company_budget_ledger_recompute_summary_trigger_v501();

-- One-time recompute after installing the trigger.
select public.recompute_company_budget_summary_v501();
