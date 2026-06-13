# ARKA Dispatch Accept Direct RPC V1

## Problem
Dispatch `PRANO CASH` could show `ARKA_NETWORK_UNREACHABLE` on mobile/PWA and leave the handoff in `PENDING_DISPATCH_APPROVAL`. The payment/handoff data was valid, but the accept path depended on `/api/arka/transaction`; when that HTTP request timed out or was unreachable, the accept never committed.

## Fix
- Added direct client-side Supabase RPC path for Dispatch accept.
- `acceptDispatchHandoff()` now calls `accept_cash_handoff_atomic` directly first.
- It still verifies DB commit before showing success:
  - handoff status `ACCEPTED`
  - linked payments `ACCEPTED_BY_DISPATCH`
  - exactly one ledger row
  - ledger amount matches handoff amount
- Keeps legacy `/api/arka/transaction` fallback for older DBs.

## SQL required
Run `ARKA_ACCEPT_CASH_HANDOFF_ATOMIC_RPC_V1.sql` in Supabase SQL Editor before testing.

## Files touched
- `lib/corporateFinance.js`
- `ARKA_ACCEPT_CASH_HANDOFF_ATOMIC_RPC_V1.sql`
