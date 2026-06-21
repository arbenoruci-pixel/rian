# PRANIMI ONE-WAY CODE ALLOCATOR — V39.1 PRO AUDIT

Date: 2026-06-21
Package version: `2.0.53-pranimi-one-way-code-allocator-v39-1-pro-audit`

## Verdict

The submitted V39 ZIP was **not safe to deploy as final**. Its root-cause direction was correct, but multiple parallel or fail-open paths remained. V39.1 closes those paths and keeps real clients/orders/used codes intact.

No live Supabase data was changed during this audit. The migration is additive/fail-closed and contains no business-row deletes or mass cleanup.

## Critical defects confirmed in submitted V39

1. `lib/baseCodes.js` still contained a local pool/batch system (`POOL_TARGET=20`, `fillPoolToTarget`) and an online-error path that could fall into another allocator.
2. `app/pranimi/page.jsx` still called `ensureUniqueBaseCodeForSave` during final save, allowing a second code decision after the draft already had a code.
3. The old `markCodeUsed` path could queue/return a success-like result when DB consumption was unconfirmed.
4. Offline restore explicitly trusted local code state (`OFFLINE_TRUST_LOCAL`).
5. Compatibility helpers directly mutated `base_code_pool` with progressively weaker ownership checks.
6. The server allocator still tried several RPC signatures, including `owner_id`, then direct PostgREST pool writes and pool seeding/highest-code logic.
7. Browser-side cleanup still had direct client/order DELETE fallbacks.
8. Existing-client selection could paint a historical code before exact DB verification.
9. A terminal finalized-draft error overwrote its symbolic `error.code` with the numeric carpet code, allowing the UI to misclassify it as retryable.
10. Meaningful drafts could disappear from the draft list merely because their old code was stale/used/missing.

## V39.1 architecture

`PIN -> active draft/session -> lib/pranimiCodeAllocator.js -> exact DB RPC -> one assigned code -> exact final order -> exact consume/release -> local acknowledgement`

- One central browser service: `lib/pranimiCodeAllocator.js`.
- One allocation mutation: `get_or_assign_pranimi_code(pin, draft_session_id, lease)`.
- One code per PIN + active draft.
- No batch reservation, no `max(code)+1`, no client-side pool seeding, no UUID/owner-id alias.
- A local code is displayable offline only when an unexpired exact DB proof exists for the same PIN, draft and code.
- Ambiguous timeout/network results retain the same binding and never try a second allocator.
- Final save retries the same code; local binding clears only after exact lifecycle confirmation.
- Existing clients keep their historical code only after exact `clients.id + code` verification; the temporary draft assignment is released only after exact final order verification.

## Exact files/functions changed

- `lib/baseCodes.js`
  - `warmBasePool` / `ensureBasePool` — housekeeping only; reserve count is always zero.
  - `getOrAssignPranimiCodeInDb` — sole allocation DB adapter.
  - `verifyPranimiCodeAssignmentInDb`
  - `renewPranimiCodeAssignmentInDb`
  - `consumePranimiCodeAssignmentInDb`
  - `releasePranimiCodeAssignmentInDb`
  - exact existing-client verify/temp-release adapters.
  - old allocator exports removed entirely.
- `lib/pranimiCodeAllocator.js`
  - `createPranimiCodeAllocatorCore`
  - `verifyAssignedCode`, `getOrAllocateInternal`, `adoptAndVerifyForDraft`
  - `consumeForDraft`, `releaseForDraft`, `finalizeExistingClientDraft`
  - `acknowledgeFinalizedDraft`, memoized browser binding.
- `lib/baseCodeAllocatorServer.js`
  - `reserveBaseCodesForPin` now accepts only numeric PIN, exact draft/session and `count=1`; one RPC attempt only.
- `lib/pranimiCodeReserveServer.js`
  - strict facade; no `owner_id` alias.
- `lib/codeLease.js`
  - read/housekeeping facade only; no allocation/consume/release exports.
- `app/pranimi/page.jsx`
  - `tryReserveCodeInBackground`
  - `verifyRestoredDraftCodeOrAllocate`
  - `applyClientMatchChoice`
  - final-save lifecycle (`finalizeCodeLifecycleForVerifiedOrder`, `finishSuccess`)
  - draft retention (`filterDraftSummariesAgainstDb`, `shouldDraftSummaryRender`)
  - direct browser client/order delete fallback removed.
- `supabase/sql/pranimi_code_oneway_allocator_20260621.sql`
  - review gates, one-bound-draft index, overload removal, strict allocator/verify/renew/consume/release RPCs, explicit privileges.
- `supabase/sql/pranimi_code_oneway_allocator_20260621_BACKUP_AND_VERIFY.sql`
  - read-only pre/post checks, Fitim PIN 1126 inspection, duplicate/invariant checks, live trigger/function inventory.
- `tools/verify-pranimi-code-allocator.mjs`
- `tools/verify-pranimi-code-reservation.mjs`
- `package.json`, `package-lock.json`

## DB/data protection

- No clients, orders, payments or used pool rows are deleted by the migration.
- Existing `used / NO_RESERVED_BY` rows remain untouched.
- Existing duplicate/unexpected live state causes the migration to stop for review.
- Unknown live triggers/functions are not blindly dropped. The companion verification SQL lists every trigger on `orders`, `clients`, `base_code_pool` and every user function mentioning `base_code_pool`.
- Historical files `base_codes_reservation_hardening_20260620.sql` and `fix_reserve_base_codes_batch.sql` are superseded. **Do not apply them after V39.1.**

## Required deployment order

1. Run/export every SELECT in `..._BACKUP_AND_VERIFY.sql` against live Supabase.
2. Review B7/B8. If an unknown live trigger/function writes `base_code_pool` or marks codes used, stop and review it before deployment.
3. Apply `pranimi_code_oneway_allocator_20260621.sql` once.
4. Rerun the post-migration verification SELECTs. Confirm one overload per RPC, legacy RPC execute privileges are false, official privileges are true, and invariant queries return zero rows.
5. Deploy the V39.1 frontend ZIP.
6. Test Fitim PIN `1126`: open/reopen the same draft, confirm exactly one bound reservation; final-save once; verify the exact order/code and used provenance.
7. Test another worker through the same flow.

## Validation performed

- `node --check`: all touched JS/MJS files PASS.
- TypeScript JSX parser: `app/pranimi/page.jsx` PASS with zero parse diagnostics.
- `node tools/verify-pranimi-code-allocator.mjs`: PASS.
- `node tools/verify-pranimi-code-reservation.mjs`: PASS.
- `node tools/verify-pranimi-final-lifecycle.mjs`: PASS.
- SQL delimiter/transaction/static structure checks: PASS.
- Companion verification SQL static read-only check: PASS.
- Repository sweep: no Pranimi component-level reserve RPC, no JS direct `base_code_pool` write, no old allocator import/call, no `max(code)+1` path.

## Honest limitations

- No connection to the live Supabase was available; live trigger/schema/data results remain mandatory before deploy.
- `node_modules` is intentionally absent, so a full Vite production build was not run in this environment.
- Order insert and code consume are two DB transactions. The UI reports success only after exact order verification and exact consume/release confirmation. A single monolithic order-save RPC was not introduced without a verified live order schema, to avoid risking real customer data.
