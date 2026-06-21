# Dispatch Marrje Date + Handoff Ledger Fix V38

## Root cause
- `app/marrje-sot/page.jsx` used `updated_at` as a fallback event date and also queried today by `updated_at`.
- Metadata cleanup/recovery updated old orders on 2026-06-20, so old orders appeared as today's Marrje/Dorzim.
- That caused false pending ARKA rows for worker PIN 2020, including payments 1617 and 1618.
- `accept_cash_handoff_atomic` created the ledger row but did not write `cash_handoffs.company_ledger_entry_id`, leaving accepted handoff 260 half-linked in the UI.

## Fix
- Marrje/Dorzim date logic now uses only real event timestamps: `picked_up_at`, `delivered_at`, `completed_at`, `done_at` and JSON equivalents.
- Removed `updated_at` from Marrje DB date filters.
- Removed `updated_at` and `Date.now()` as DB event-date fallbacks.
- Hardened `accept_cash_handoff_atomic` to write `company_ledger_entry_id` on accept and repair older accepted handoffs when re-run.
- Added SQL script: `supabase/sql/dispatch_marrje_date_handoff_fix_20260621.sql`.
- Added verification script: `npm run test:dispatch-date`.

## Incident DB fixes in SQL script
- Backfills accepted handoff ledger links.
- Links handoff 260 to ledger 282.
- Marks false pending payments 1617 and 1618 as `REJECTED` without deleting rows.
