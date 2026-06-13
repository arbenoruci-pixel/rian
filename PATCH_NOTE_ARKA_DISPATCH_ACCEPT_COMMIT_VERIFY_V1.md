# ARKA Dispatch Accept Commit Verify Hotfix V1

## Problem found
Dispatch Accept could show success in the UI even when the handoff was not actually committed in the database.
Live test confirmed Handoff #225 stayed `PENDING_DISPATCH_APPROVAL`, payments stayed `PENDING_DISPATCH_APPROVAL`, and no `company_budget_ledger` row was created, while the UI said accepted.

## Root cause
`acceptDispatchHandoff()` trusted the ARKA transaction response and allowed offline/network queued results to be treated like success. The server-side accept path also required `accept_cash_handoff_atomic` RPC and did not use its existing JS fallback when the RPC was missing.

## Fix
- Disabled offline queue success for Dispatch Accept.
- Added client-side commit verification before the UI can report success.
- Added server-side verification after accept:
  - handoff status must be `ACCEPTED`
  - handoff amount must equal item sum
  - related payments must be `ACCEPTED_BY_DISPATCH`
  - exactly one ledger row must exist for `source_type='cash_handoff'` + `source_id=handoff_id`
  - ledger amount must match handoff amount
  - company budget summary must reconcile with ledger totals
- Restored safe JS fallback when `accept_cash_handoff_atomic` RPC is missing.

## Files touched
- `lib/corporateFinance.js`
- `lib/arka/arkaEngine.js`

## Validation
- `npm ci --ignore-scripts` passed.
- `npm run build` passed.
- Existing Vite warnings remain from `app/dispatch/page.jsx` duplicate style keys and chunk size warnings; this patch did not touch Dispatch UI module.
