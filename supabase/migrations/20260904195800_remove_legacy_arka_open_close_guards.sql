-- Retire legacy daily ARKA open/close guards from the active transaction path.
-- Historical arka_cycles / arka_daily_close data is preserved.

drop trigger if exists trg_guard_company_ledger_after_closed_day_v2 on public.company_budget_ledger;
drop trigger if exists trg_guard_dispatch_expense_after_closed_day_v1 on public.arka_pending_payments;
drop trigger if exists trg_guard_closed_arka_cycle_v2 on public.arka_cycles;

comment on function public.guard_company_ledger_after_closed_day_v2() is 'LEGACY/RETIRED: daily ARKA open-close guard; trigger removed 2026-09-04.';
comment on function public.guard_dispatch_expense_after_closed_day_v1() is 'LEGACY/RETIRED: daily ARKA open-close guard; trigger removed 2026-09-04.';
comment on function public.guard_closed_arka_cycle_v2() is 'LEGACY/RETIRED: daily ARKA open-close guard; trigger removed 2026-09-04.';
