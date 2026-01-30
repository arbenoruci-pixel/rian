-- PATCH: Support BORXH flow for cash payments made while ARKA was CLOSED.
-- We use status='OWED' to mean: "cash is still in worker's hand (PIN)".

-- 1) Make sure column types are text (already are in the extended schema).
-- 2) Add helpful index for quick lookups by PIN.
-- 3) Migrate legacy BORXH records that were stored as REJECTED.

-- INDEX
create index if not exists arka_pending_payments_pin_status_idx
  on public.arka_pending_payments (created_by_pin, status, created_at);

-- MIGRATION (legacy)
-- If you previously used REJECTED to represent BORXH, convert them to OWED.
update public.arka_pending_payments
set status = 'OWED'
where status = 'REJECTED'
  and coalesce(created_by_pin,'') <> ''
  and upper(coalesce(method,'CASH')) = 'CASH';

-- NOTE:
-- Allowed statuses now used by the app:
-- PENDING (waiting confirmation on ARKA open)
-- APPLIED (accepted into INCOME)
-- OWED   (marked as BORXH, worker must hand money later)
