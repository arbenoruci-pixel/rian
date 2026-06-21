-- ARKA BULLETPROOF HARDENING ROLLBACK V1
-- Does not delete live data. Drops additive indexes and the new meal RPC.
-- To fully rollback submit_cash_handoff_atomic, re-apply the previous function body
-- from sql/submit_cash_handoff_atomic.sql in the prior commit.

drop index concurrently if exists public.arka_pending_payments_idemp_uidx;
drop index concurrently if exists public.company_budget_ledger_source_uidx;
drop function if exists public.create_meal_distribution_atomic(text,text,text,text,text,text,text,numeric,jsonb,text,text);

-- Optional emergency compatibility: re-apply the previous submit_cash_handoff_atomic
-- function body from the last known-good release if the extended signature is not desired.
