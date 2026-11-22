-- Apply after the wizard frontend and API are live. Historical rows, reads,
-- and receipt updates are unaffected. The core migration defines this guard.
drop trigger if exists zz_guard_worker_handoff_creation_v1 on public.cash_handoffs;
create trigger zz_guard_worker_handoff_creation_v1
before insert on public.cash_handoffs
for each row execute function private.guard_worker_handoff_creation_v1();
