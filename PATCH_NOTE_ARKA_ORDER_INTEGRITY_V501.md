# ARKA / Order Integrity V501

## Root cause fixed
Some UI/offline paths could mark an order as `paid` / `dorzim` before the ARKA transaction was verified in `arka_pending_payments`. If the ARKA transaction later failed, was auto-rejected, or stayed in outbox/dead-letter, DB ended up with orders that looked paid but had no active ARKA row.

## Code changes
- `components/payments/payService.js`
  - Offline queued ARKA transactions no longer return a fake successful paid order.
  - A payment result must include both a verified payment row and an updated order row.
- `app/gati/page.jsx`
  - CASH delivery confirmation now waits for the ARKA transaction first.
  - UI closes only after the server inserts/reuses `arka_pending_payments` and updates the order.
- `lib/arka/arkaEngine.js`
  - Base order payment now verifies the ARKA row after insert/reuse and again after order update.
  - Duplicate reuse remains idempotent by `order_id + amount`.
- `lib/syncEngine.js`
  - Outbox `patch_order_data` / `update` / `set_status` operations are blocked if they try to sync a fully paid CASH order without an active ARKA payment row.
- `lib/arkaCashSync.js`
  - Legacy cash helper no longer reports queued/offline ARKA rows as successful payments.
- `components/payments/PaySheetPortal.jsx`
  - Generic payment sheet no longer queues direct paid-order patches while offline.
- `supabase/sql/dispatch_marrje_date_handoff_fix_20260621.sql`
  - The old auto-reject cleanup now avoids rejecting `dorzim` orders that are already paid/debt=0.

## Optional DB guard
Run `supabase/sql/arka_integrity_guard_v501.sql` after the live DB is clean. It adds active idempotency/lookup indexes and a ledger trigger that recomputes `company_budget_summary` from `company_budget_ledger` after every ledger change.

## Validation
- `node --check` passed for modified `.js` files.
- `npm run build` could not run in this sandbox because dependencies are not installed (`vite: not found`).
