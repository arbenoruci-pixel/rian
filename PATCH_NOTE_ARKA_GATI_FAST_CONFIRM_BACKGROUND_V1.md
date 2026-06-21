# ARKA GATI Fast Confirm Background V1

Scope: GATI payment confirm UX and ARKA base payment idempotency only.

## Problem
Worker pressed KONFIRMO DORËZIMIN and the app appeared blocked while it waited for ARKA payment, order delivery update, handoff/meal deduction, and DB verification.

## Fix
- GATI now saves a local optimistic delivery state and closes the payment modal immediately after PIN confirmation.
- Worker sees a fast confirmation toast: "U konfirmu. Mund të vazhdosh me klientin tjetër."
- ARKA payment transaction is queued in the existing outbox first, then live/background sync continues.
- Background sync performs ARKA payment + order delivery verification without keeping the worker stuck on the modal.
- If background sync fails, the payment is marked as pending sync/verify and the UI shows a warning instead of losing the action.
- Base ARKA payment now uses deterministic idempotency keys and idempotency-aware duplicate recovery.
- Pending payment insert variants preserve `idempotency_key` when stripping optional legacy columns.

## Files touched
- app/gati/page.jsx
- lib/arka/arkaEngine.js

## Validation
- npm run build passed.
- Existing warnings remain in app/dispatch/page.jsx duplicate style keys and chunk-size warnings; untouched.
