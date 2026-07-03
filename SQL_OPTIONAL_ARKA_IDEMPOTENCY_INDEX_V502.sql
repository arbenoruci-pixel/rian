-- OPTIONAL DB HARDENING V502
-- Run only after confirming no duplicate idempotency keys exist.
-- This does not fix old data; it prevents future active duplicate inserts with same idempotency key.

create unique index if not exists arka_pending_payments_active_idempotency_key_uidx
on public.arka_pending_payments (idempotency_key)
where idempotency_key is not null
  and status not in ('VOIDED', 'REJECTED');
