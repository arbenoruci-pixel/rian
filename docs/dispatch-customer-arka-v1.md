# Dispatch, customer care and personal cash handoff — release review 2026-09-08

Base: `794afee26eab03aab704bfbeb1c7e9d61cb290d7`. Local branch: `fix/dispatch-customer-arka-prepared-20260908`.

The user authorized deployment after the preparation review. Migration `20260908144609_dispatch_customer_care_and_safe_edit` is applied and verified on the existing production database. Release target: https://tepiha.vercel.app. Deployment status and source commit are verified separately in Vercel after the source push. No real payment or customer mutation was performed during testing.

## Changes and evidence

- Dispatch's HTTP deadlines now include reading the response body. Previously the abort timer stopped when headers arrived, leaving a stalled body unbounded. Atomic creation retains its existing 35-second server allowance, durable UUID, reconciliation and one retry. A missing device cookie can be repaired once; explicit device/role denial remains denied.
- Driver choices load from the existing cache immediately. Network requests have deadlines; list refreshes cannot overlap or erase the last successful list after a failure. The page presents a retry message. Invalidating a phone number clears its stale busy state.
- Ordinary edits keep the current worker, driver and lifecycle. Choosing a different driver is explicit. A server-authorized `EDIT_ORDER` operation reads current data and sends the order/client changes to one transaction, guarded by exact `updated_at` timestamps. Ordinary edits do not invoke status-transition triggers; any unexpected trigger rewrite of status, ownership or measurements rolls back the whole edit. The generated database `transport_id` column follows `data.transport_id`. Old installed clients using the former two-write edit must update before editing.
- Dispatch can edit carpet/runner quantities and areas and staircase measurements on active, unpaid Transport visits. Totals use the existing price; existing row photos, worker metadata and unrelated order data are preserved, including legacy measurement rows and total aliases. Already-paid visits require financial review for measurement/amount corrections; both order JSON and the cash ledger guard this restriction. Ordinary notes/address/name edits remain available on active visits.
- Internal customer notes, optional 1–5 ratings, issue categories and a reversible “Mos e merr përsëri” warning follow the permanent Transport client across visits. Only managers can set/clear the warning. The warning is advisory and visible in customer care; it is not an automatic ban on order creation. Feedback is append-only and retries with the same ID/payload cannot duplicate it.
- Drivers can add feedback for their assigned order after verified payment, or skip immediately. Feedback does not call the payment endpoint and cannot alter cash/ledger state. Dispatch can view and add customer-care entries through the phone match, order editor and Transport client profile.
- Master/Dispatch “Arka ime · Dorëzo paratë” uses their own cash snapshot throughout cache loading, refresh and post-handoff refresh. Switching between manager and personal views remounts loaders to prevent a delayed manager response from contaminating the personal view. Bonus lookup permits non-worker accounts while existing cash ownership, amounts, idempotency and verification remain in place.

## Validation completed

- `npm run build`: PASS, including all 66 configured test commands, Vite production compilation and PWA generation.
- New regression suites: `tools/verify-dispatch-customer-arka-v1.mjs` and `tools/verify-dispatch-request-recovery-v1.mjs`. They run within the existing Dispatch release build gate.
- Covered: missing driver list; assigned/accepted/pickup/pastrim/gati/loaded/delivery status preservation; explicit reassignment; stale edit rejection; server actor restrictions; corrected totals and retained photos; paid-measurement guard; repeated feedback; customer/order identity conflict; unrelated driver denial; flag clearing; repeat-visit history; master/Dispatch personal view selection; stalled response bodies; lost response reconciliation; network retry UUID reuse; one-time missing-cookie repair; explicit 403 denial.
- Existing Home/GATI exact-open, repeat-visit, payment intent, device approval and Arka integrity gates passed.
- `git diff --check`: PASS. Vite reports no circular dependencies. It retains its existing large-bundle warning.

The application tests use synthetic data and an in-memory database adapter. The final full build passed again after review fixes; log: `/tmp/rian-release-build-20260908.log`.

`tools/verify-dispatch-customer-arka-db.sql` also passed against the actual PostgreSQL transaction and existing triggers as `service_role`. It tested assigned/pastrim/gati/loaded/delivery preservation, generated driver identity, measurements, stale order and client timestamps, atomic rollback after a trigger rejects an edit, duplicate feedback and invalid ratings. Its synthetic clients/orders/feedback and trigger writes were rolled back; follow-up queries confirmed zero retained fixtures and feedback. A separate read-only rejection test confirmed the cash ledger blocks measurement edits before any write.

Verified database access: feedback RLS enabled; anonymous feedback reads and authenticated direct inserts denied; anonymous/authenticated direct edit RPC execution denied; server role access allowed. Read-only inspection confirmed the existing handoff RPC's role-independent submission path. Earlier runtime log requests timed out and no matching recent incident rows were returned; the intermittent phone freeze was not reproduced on an installed phone.

## Installed-phone acceptance checks

Follow-up from the installed-phone screenshot: the staff detail route still contained its old handoff button inside a `display:none` section, while the replacement shared cash card only showed the balance. `arka-visible-handoff-v2` places the action directly beside the visible balance. Own staff details enter `/arka?personal=1`; the personal cash page opens its existing handoff flow from the same card. Viewing another person's account cannot initiate a handoff. The rendered-component regression uses the reported €18.33 + €7.15 carryover and checks visible navigation, wizard wiring, and zero/busy/duplicate guards. Payment amounts and submission RPCs are unchanged.

1. Cold open with retained cache; confirm the new PWA identity contains `dispatch-customer-arka-v1`; weak-network creation and same-intent retry.
2. Edit an assigned/working order without changing its worker/status; edit dimensions; check the same amount in Dispatch and Transport.
3. Repeat-client warning/history; driver's payment → rating or skip; master and Dispatch personal cash handoff → one pending approval with the correct owner and amount.
4. HOME→GATI with an old cached visit, a repeat client with a newer GATI visit, and a normal exact open. Confirm newest applicable visit by permanent code.

The remote browser could not open the local synthetic preview (`ERR_BLOCKED_BY_CLIENT`). The public production login screen is accessible. No authenticated visual or physical-phone pass is claimed. A local synthetic preview is available with `node tools/preview-customer-care.mjs`; it uses no production connections.
