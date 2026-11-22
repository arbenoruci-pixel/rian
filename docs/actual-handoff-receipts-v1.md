# Actual cash receipts and worker differences

## Accounting contract

`cash_handoffs.amount` is the original net expectation after the handoff's legitimate deductions. It remains unchanged. The additive receipt columns keep physical cash received, amounts resolved without cash, and the remaining worker obligation separately:

`original expectation = actual receipts + audited noncash resolutions + outstanding`

Each positive `RECEIPT` creates exactly one `company_budget_ledger` IN entry with `source_type = cash_handoff_receipt`, then increases the company cash balance by that receipt amount. A zero receipt records that no cash arrived and leaves the entire obligation open. A `RESOLUTION` reduces the obligation with an operator and explanation; it creates no cash ledger entry, no salary deduction and no customer debt change.

The original client payment and handoff item amounts stay intact. Those client payments remain linked and unavailable for another handoff. Their dispatch status completes when the handoff's remaining obligation reaches zero. The handoff stays pending while cash is missing.

An existing bonus allocation changes from RESERVED to RETAINED on the first recorded receipt. The earned bonus has already reduced the original net expectation; a partial cash receipt never reduces it again. The allocation's `updated_at` is set at that first retention and remains unchanged during later receipts or a final noncash resolution. Bonus account reports use this date for tracked handoffs, independently of the later cash completion date.

## Operator flow

Dispatch opens the handoff, enters the cash actually counted, and records an explanation when it is less than the amount remaining. The card displays original net expectation, actual receipts, noncash resolutions and the remaining amount. Dispatch can later receive another amount against the same handoff.

“Sqaro diferencën” requires a positive amount, a written reason and a separate confirmation that no cash was received. It leaves an immutable event with the operator, timestamp, previous balance and resulting balance.

The daily-close screen receives cash through this same flow before physical box counting. Its final close always passes an empty legacy handoff selection. Remaining worker differences do not become company cash or an automatic global cash shortage. A separate physical box discrepancy still requires its own reason.

Approved active device sessions determine the acting user's UUID on the server. Financial write functions are restricted to the service role through the authenticated server boundary. A worker cannot approve a receipt; a dispatch user needs another authorized manager to receive their own handoff. Existing authentication and RLS policies remain enabled.

## Integration contract

`POST /api/handoff-receipts` accepts:

| Action | Required financial fields | Result |
| --- | --- | --- |
| `list` | Optional `targetPin` for an authorized manager | Scoped handoffs, immutable events, stable summary |
| `receive` | `handoffId`, `amount`, `expectedOutstanding`, `requestKey`; explanation for a short receipt | Actual cash receipt and remaining obligation |
| `resolve` | Same fields, a reason in `note`, and `confirmNoCash: true` | Audited resolution without cash |
| `daily-check` | `date`, `countedCash`, `expectedBudget`, `reason`, `note`, `requestKey` | Read-only close preview against the current budget |
| `daily-close` | The exact checked values and request key | Stored final result or an exact retry replay |

The client supplies `expectedActorId` to reject stale account sessions. It cannot supply the server actor's UUID as an authorization override. Unknown body fields are rejected.

`read_cash_handoff_receipts_v1` reads cards and totals from one stable database snapshot. Pending handoffs are complete, with a fail-closed safety bound; settled history is limited to the most recent forty tracked handoffs. Each row includes canonical `worker_id`, `can_receive`, `has_bonus_allocations` and `pending_payment_ids` from active handoff items. Summary totals are independent of the history limit.

`summary.outstandingTotal` includes all remaining pending cash. `summary.receivedToday` includes old accepted handoffs and new positive receipt events on the Belgrade calendar day, and excludes noncash resolutions. This matches the worker account's “today”. The established daily-close report retains its separate 04:00–04:00 operational day.

The receipt panel accepts `actor`, optional `targetPin`, `onChange` and `onSummary`. Inline callbacks do not restart its request effect. It refreshes on focus, visibility, cash changes and a visible-tab interval. `/arka/ditore?handoff=<id>` focuses a handoff; `?worker=<canonical UUID>` filters the worker. No PIN is printed in the UI. Bonus detail remains available even if the worker's current earning flag is disabled.

## Concurrency and retry guarantees

Receipt requests lock their actor/request key, then the handoff and linked source payments. They compare the submitted outstanding amount to the locked current value. A stale second operator refreshes before trying again. Reusing a request key with different financial values fails. Ambiguous client network failures retain the original request key in durable device storage and offer a retry of that exact intent.

### Receipt storage recovery

`handoff-receipt-durable-storage-v1` fixes receipt confirmation failing when the small localStorage quota is full. Existing localStorage intents stay readable. A new intent can instead be saved in a receipt-specific IndexedDB store, verified after transaction completion before any financial POST. Reloading the app recovers the original actor, handoff, amount, outstanding snapshot, note and request key. Memory or session-only storage never authorizes a receipt.

The receipt modal checks saved confirmations before enabling a fresh acceptance. After an uncertain response it offers the exact stored action again. A changed account cannot submit the previous account's pending action, and cleanup only removes the matching intent. Local in-flight protection and Web Locks where available prevent overlapping confirmations from the same browser. Server-side receipt locks and idempotency remain authoritative.

If persistent storage cannot be written or an earlier intent cannot be checked, the screen gives a storage-specific message and keeps acceptance blocked. “Riprovo kontrollin” repeats the read without sending cash. This release does not clear browser data, customer drafts, authentication, or offline queues. It requires no database migration and preserves the December food policy and the reviewed worker handoff wizard.

`node tools/verify-handoff-receipt-storage.mjs` reproduces quota and storage failures, reload recovery, lost server replies, account changes and conditional cleanup using synthetic data. Production receipts are never submitted by these tests.

Daily-close requests store a payload hash and full result in an append-only request table. Exact retries return that saved result before checking the current budget, including when the first close posted a discrepancy and its response was lost. The established day advisory lock is acquired before the shared cash-balance lock. Fresh closes reject changes to the balance since the server preview.

Legacy accept, reject, source-payment reopen and item-release paths are guarded once a handoff has any receipt history. Old cached clients cannot post a full legacy handoff credit, reverse its retained bonuses or make its client payments collectable again.

## Rollout and safe rollback

Apply `20261122015736_meal_monthly_policy_v1.sql` before `20261122015743_actual_handoff_receipts_v1.sql`. The receipt migration captures the full pre-change definitions of the four cash guards, daily preview, daily close, worker finance snapshot and payroll preview in `private.handoff_receipts_v1_previous_functions`. The table has RLS enabled and no public, anonymous, authenticated or service-role access. Those definitions include the preceding meal-policy overlay.

To pause fresh receipt, noncash-resolution and new daily-close writes while investigating, an authorized operator can run:

```sql
update public.cash_handoff_receipt_settings set enabled=false where id=1;
```

Reads and exact successful-request replays remain available. Read-only daily checking also remains available. Re-enable after verification:

```sql
update public.cash_handoff_receipt_settings set enabled=true where id=1;
```

Once any receipt or close request has been recorded, preserve these tables and columns, their events, budget entries, immutable guards and reporting overlays. Do not restore the old cash guards, remove the receipt columns or erase the event/request tables. A frontend rollback can be deployed while keeping this additive database layer. An old client will be blocked from bulk accepting or rejecting a tracked handoff; use the corrected receipt screen again to complete its remaining obligation.

If a defect is found after a real receipt, correct the workflow forward while retaining the original event and ledger audit. The noncash resolution action is for a documented change to an outstanding worker obligation. It does not reverse cash already received. No general cash reversal is added by this release.

Function backups support forensic comparison and a carefully reviewed pre-use rollback. Restoration before any receipt data exists must still preserve the active meal overlay and current security grants. After usage, restore only an individually reviewed nonfinancial function when compatible with the receipt schema. Never run a blanket backup restore. The meal-policy rollback must likewise retain the receipt overlays on the shared finance and payroll functions.

## Verification

`node tools/verify-handoff-receipts.mjs` uses synthetic fixtures in isolated PGlite. It applies both migrations in order, reruns the receipt migration, and verifies backups, actual partial/exact/final cash, zero receipts, immutable noncash resolutions, original expectation preservation, legacy history, old-client guards, bonus retention once, stable retention dates, service-role access, actor/scope validation, rejection of stale competing requests, durable lost-response close replay, receipt-day reporting, payroll remaining balances and physical box totals.

`node tools/verify-handoff-receipt-ui.mjs` exercises the real component and client against a synthetic HTTP ledger: blank amount entry, a reply lost after commit, durable same-key retry, no duplicate cash, canonical focus, bonus detail, refresh after another operator's receipt, self-approval prevention, explicit noncash confirmation and account-change clearing.

PGlite queues requests in one process. The competing-request checks exercise the stale-state and idempotency branches; PostgreSQL row/advisory lock behavior is enforced in the migration and reviewed in lock order. Production writes and real worker amounts are not used by these tests.
