# ARKA / Order Integrity Guard V2 — 2026-07-03

## Root causes found

1. **Paid CASH order could be written before ARKA payment existed**
   - `app/gati/page.jsx` could close delivery UI while ARKA sync was still running in background.
   - `components/payments/payService.js` queued optimistic `patch_order_data` when ARKA was offline/queued.
   - `components/payments/PaySheetPortal.jsx` allowed offline cash payment patching from the sheet.
   - `lib/syncEngine.js`, `app/api/sync/route.js`, and `app/api/offline-sync/route.js` accepted paid/dorzim order patches without forcing an ARKA row first.

2. **Duplicate payment detection was too narrow**
   - The old duplicate lookup checked mainly `PENDING` statuses.
   - Accepted/collected rows could still let another active row be created for the same order.

3. **Budget summary drifted from ledger**
   - `lib/arka/arkaEngine.js` used incremental deltas for `company_budget_summary`.
   - Manual fixes, retries, or concurrent writes could leave `current_balance` different from `company_budget_ledger`.

4. **Historical auto-reject migration was dangerous if rerun**
   - `supabase/sql/dispatch_marrje_date_handoff_fix_20260621.sql` had auto-reject logic for old false pending rows.
   - V501 safety condition now prevents rejection when linked order is `dorzim` and already paid/debt=0.

## Files changed

- `app/gati/page.jsx`
- `components/payments/payService.js`
- `components/payments/PaySheetPortal.jsx`
- `lib/arkaCashSync.js`
- `lib/syncEngine.js`
- `app/api/sync/route.js`
- `app/api/offline-sync/route.js`
- `lib/arka/arkaEngine.js`
- `package.json`, `package-lock.json` version bump
- `supabase/sql/arka_integrity_guard_v501.sql`
- `supabase/sql/dispatch_marrje_date_handoff_fix_20260621.sql`
- Patch notes / health SQL files included in root

## What changed

### 1) CASH paid order guard

Before any base order is marked fully paid CASH and delivered/dorzim, the app now:

1. Resolves the order.
2. Reads desired paid/debt/method/status.
3. Sums existing active `arka_pending_payments` rows for the order.
4. Creates/reuses the missing `BASE_ORDER_PAYMENT` through the normal ARKA engine before the order write proceeds.
5. Uses stable idempotency key:
   `BASE_ORDER_PAYMENT:<orderId>:<amount>:<actorPin>`
6. Throws if actor PIN is missing. This blocks silent DB corruption instead of creating a paid order without ARKA.

Covered paths:

- Gati fast delivery
- Pay sheet cash payment
- Browser/client outbox sync
- `/api/sync` server route
- `/api/offline-sync` server route
- Numeric `local_oid` duplicate/update path
- Insert/upsert retry path after resolving the inserted order

### 2) Offline queued CASH is no longer marked paid optimistically

If ARKA is offline/queued, the UI now keeps the order from being marked paid/dorzim until ARKA confirms. The user sees an error/message and can retry when the network returns.

### 3) Duplicate protection now includes accepted active statuses

Active duplicate lookup now includes:

- `PENDING`
- `COLLECTED`
- `PENDING_DISPATCH_APPROVAL`
- `ACCEPTED_BY_DISPATCH`

This prevents duplicate rows after a payment has already moved forward.

### 4) Budget summary is recalculated from ledger

`updateSummaryDelta()` now treats `company_budget_ledger` as source of truth and recalculates:

- `total_in`
- `total_out`
- `current_balance`

If a full ledger scan fails because of schema/RLS state, it falls back to delta mode, and verification still catches mismatches.

### 5) Accept handoff verification now checks balance too

`verifyCompanyBudgetSummaryBalanced()` now compares:

- summary total in vs ledger total in
- summary total out vs ledger total out
- summary current balance vs ledger balance

Previously it could miss `current_balance` drift.

## Validation run

Syntax checks passed:

```bash
node --check components/payments/payService.js
node --check lib/arkaCashSync.js
node --check lib/syncEngine.js
node --check lib/arka/arkaEngine.js
node --check app/api/sync/route.js
node --check app/api/offline-sync/route.js
```

`npm build` was not run because dependencies are not installed in the uploaded zip environment.

## DB status before code patch work finished

Final DB health scan from Supabase showed:

```text
duplicate_active_payments: 0
handoff_ledger_mismatch: 0
budget_summary_mismatch: 0
arka_payment_but_order_unpaid: 0
```

## Recommended deploy order

1. Deploy this code.
2. Make sure `supabase/sql/arka_integrity_guard_v501.sql` has been applied once.
3. After deploy, run `SQL_HEALTH_ARKA_ORDER_INTEGRITY_V502.sql`.
4. Do not manually update ARKA rows unless a health scan points to a specific mismatch.
