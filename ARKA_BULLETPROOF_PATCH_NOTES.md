# ARKA Bulletproof Hardening V1

## Scope
This patch hardens the ARKA payment, handoff, meal deduction, and offline retry pipeline. It is a source-code + SQL-migration package. No live DB SQL was executed in the sandbox.

## What changed

### 1. Payment / `Load failed` resilience
- Added `lib/arka/arkaNetwork.js` as the low-level ARKA POST transport.
- Added `AbortController` timeout for `/api/arka/transaction`.
- Added retry only for network-layer failures such as `Load failed`, `Failed to fetch`, abort/timeout, and no-response cases.
- Server JSON errors are not auto-retried.
- ARKA transactions now carry/derive a deterministic `idempotencyKey` / `idempotency_key`.
- If retries fail or the device is offline, the ARKA transaction is queued as `arka_transaction` in the existing IndexedDB outbox.
- `syncEngine` now knows how to flush `arka_transaction` ops back through `/api/arka/transaction`.
- GATI payment UI maps raw network failures to a clearer message and supports the queued-payment success path.

### 2. Atomic meal creation path
- Added new action: `CREATE_MEAL_DISTRIBUTION`.
- `createMealDistributionEntry()` now calls the server engine once instead of creating one `MEAL_PAYMENT` plus N `MEAL_COVERED` rows from the UI loop.
- Server engine calls additive RPC `create_meal_distribution_atomic`.
- The old N+1 meal creation behavior is removed from the live client flow.

### 3. Atomic handoff submit with meals
- `submitWorkerCashToDispatch()` now forces RPC mode for all handoffs, including meal handoffs.
- `submitHandoffViaRpc()` sends `meal_payment_ids` to the RPC.
- `submitHandoff()` no longer routes to JS fallback only because meals exist.
- JS fallback remains only behind explicit emergency flag `ARKA_ALLOW_JS_HANDOFF_FALLBACK=1` or payload flag.
- This is intended to stop new `CANCELLED` shells from normal meal handoff flows.

### 4. Negative meal item landmine removed
- `toHandoffItem()` now throws if a `MEAL_PAYMENT` row ever reaches handoff item generation.
- The previous latent branch that could return `-Math.abs(rawAmount)` was removed.
- Meal deduction is expected to be spread across positive client/transport items by the atomic RPC.

### 5. SQL package included
- `sql/ARKA_BULLETPROOF_SQL_MIGRATION.sql`
  - backup tables
  - idempotency unique index proposal
  - ledger source unique index proposal
  - `create_meal_distribution_atomic`
  - extended `submit_cash_handoff_atomic(..., meal_payment_ids bigint[])`
- `sql/ARKA_BULLETPROOF_SQL_ROLLBACK.sql`
- `sql/ARKA_BULLETPROOF_VALIDATION.sql`

## Critical rollout order
1. Run `sql/ARKA_BULLETPROOF_VALIDATION.sql` first.
2. If duplicate idempotency keys or duplicate ledger source pairs appear, stop and review. Do not create the unique indexes until duplicates are resolved.
3. Apply `sql/ARKA_BULLETPROOF_SQL_MIGRATION.sql` in Supabase SQL editor.
4. Deploy the app patch.
5. Run validation SQL again.
6. Test GATI payment, meal creation, worker handoff with meal, dispatch accept, payroll preview.

## Important notes
- This patch does not delete or rewrite old legacy meal rows.
- Old legacy `MEAL_PAYMENT` rows without guarded markers remain excluded from automatic deduction.
- New meal rows use guarded markers: `MEAL_DAY`, `MEAL_OPEN`, `MEAL_BY`, `MEAL_FOR`, `MEAL_TARGETS`.
- If the new RPC migration is not applied before app deploy, meal creation and meal handoff will return clear RPC-required errors instead of silently falling to non-atomic JS behavior.

## Files touched
See `FILES_TOUCHED_ARKA_BULLETPROOF_V1.txt`.
