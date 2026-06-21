# ARKA Bulletproof V1 Test / Validation Log

## Automated validation in sandbox

- `npm ci --ignore-scripts`: OK
- `node --check` OK for:
  - `lib/arka/arkaNetwork.js`
  - `lib/arka/arkaClient.js`
  - `lib/arka/arkaConstants.js`
  - `lib/syncEngine.js`
  - `components/payments/payService.js`
  - `lib/arkaService.js`
  - `lib/arka/arkaEngine.js`
  - `lib/corporateFinance.js`
- `grep -R -- "-Math.abs(rawAmount)" lib/arka/arkaEngine.js`: no branch found.
- `npm run build`: OK, `BUILD_EXIT: 0`.

Existing warnings remained:
- duplicate style keys in `app/dispatch/page.jsx`
- Vite dynamic/static import chunk warnings
- large chunk warning

## Manual/live tests required after SQL migration + deploy

1. Exact client payment.
2. Partial client payment.
3. Overpay/change calculation.
4. Network failure during payment: should queue locally, no raw `Load failed`.
5. Retry/flush after reconnect: exactly one `arka_pending_payments` row.
6. Payment recorded but order close fails: retry closes order without second payment.
7. Worker handoff with no meal.
8. Worker handoff with own meal today.
9. Worker handoff after 3 days of open own meals.
10. Worker A pays meal for worker B.
11. Worker B attempts to claim meal again same day: blocked.
12. Worker A pays for multiple workers.
13. Legacy stale meal row without marker is not auto-deducted.
14. Dispatch accepts handoff once.
15. Re-accept handoff does not duplicate ledger.
16. Dispatch rejects handoff and restores payments.
17. Payroll with advance.
18. Payroll with meals already settled in handoff.
19. Ledger vs summary reconciliation.
20. Offline/PWA payment queue flush after reconnect.

## Rollback
- JS rollback: revert this patch.
- DB rollback: run `sql/ARKA_BULLETPROOF_SQL_ROLLBACK.sql` and re-apply previous `submit_cash_handoff_atomic` body if needed.
- Emergency fallback: set server env `ARKA_ALLOW_JS_HANDOFF_FALLBACK=1` only if the new handoff RPC fails and handoffs must continue temporarily.
