# Worker handover wizard v1

## Purpose and financial meaning

The worker reviews server-selected customer cash, commission, Base/Transport bonuses, meals, and itemized expenses, then declares the cash they counted. Dispatch records its own actual receipt and separately reviews expense funding. These events retain independent audit records.

The migration is additive. It does not alter an existing handover, customer payment amount, historical receipt, bonus allocation, or company ledger entry. In particular, it contains no correction for the historical handovers that motivated this work.

Four amounts have distinct meanings:

| Field | Meaning |
| --- | --- |
| `totals.grossCash` | Selected positive customer `IN` / `TRANSPORT` payments belonging to the authenticated worker. |
| `totals.expectedCash` | Gross cash after the existing commission, meal, and bonus calculation. This becomes the original `cash_handoffs.amount`. |
| `totals.projectedCash` | Expected cash less claimed expenses funded from those customer collections, accounting for an exactly verified own-meal overlap. Claims remain pending. |
| `submission.physicalCash` | The worker's manually entered cash count. It creates no receipt or company cash credit. |

`differenceAmount = physicalCash - projectedCash`. A difference requires an explanation of at least four characters. Dispatch's existing actual-receipt engine remains the authority for cash received and outstanding cash.

## Deployment order

1. Apply `20261122172226_worker_handoff_wizard_v1.sql`, then `20261122174531_worker_handoff_existing_expense_eligibility_v1.sql`. The core adds protected evidence, RPCs, and wizard-record guards; the correction narrows historical expense reuse and enforces the existing monthly food policy in the wizard. Existing submission clients continue operating during frontend deployment.
2. Deploy the wizard frontend and `/api/worker-handoff` route. Verify its authenticated preview and worker/manager flows.
3. Apply `20261122173237_worker_handoff_require_wizard_v1.sql`. It installs the creation trigger requiring the private wizard transaction context. Cached legacy clients attempting a new handover receive `WHW_USE_WIZARD` and must reopen Arka.

All files were created with `npx --yes supabase@2.81.2 migration new`. The `require_wizard` migration affects new inserts only. Apply it last in the production rollout even though the separate eligibility correction has a later filename timestamp. Historical reads and actual receipt updates continue to use their existing paths. A frontend rollback must account for the mandatory wizard guard; never remove evidence or receipt protection to make a legacy client accept a wizard handover.

### Manual rollout rollback with no financial-data changes

If the core migration is present and the new frontend has not been activated, leave the core migration in place and keep the previous frontend. The mandatory creation trigger is not installed yet.

If the frontend must be rolled back after the second migration, an authorized database operator can remove **only** the mandatory creation trigger:

```sql
drop trigger if exists zz_guard_worker_handoff_creation_v1 on public.cash_handoffs;
```

This is a schema-only compatibility rollback: it changes no handover, expense, receipt, balance, or bonus record. Keep all core functions, tables, and evidence/receipt guards in place. Already-created wizard handovers still require actual receipt and audited expense actions; an old client must not finalize them through legacy full acceptance. Restore the new frontend and reapply the second migration to reinstate mandatory wizard creation. Do not reset a database, reverse a ledger entry, delete evidence, or remove the core migration as part of a frontend rollback.

Prerequisites are the existing receipt engine, meal policy, Base/Transport bonus allocations, atomic legacy handover functions, and standalone business-expense decision functions. The local SQL harness loads real exported function definitions and synthetic data; it does not connect to production.

## Authentication and database access

The HTTP route authenticates the session and supplies the actor UUID from that session. Browser-supplied worker names, PINs, rates, payment IDs, bonus IDs, or calculated totals do not determine the submitted cash. `expectedActorId` detects a changed browser session.

Public RPC wrappers are security invoker functions. Their private implementations are security definer functions with a fixed search path and explicit schema-qualified relations. Only `service_role` receives execution rights. The private implementations additionally verify that the actor is active and has an allowed worker or manager role. Manager actions reject the worker's own actor ID.

New evidence tables have RLS enabled and no browser policies. Service receives read access for the API's batched existence flag; mutation occurs through the private functions. Worker reads require ownership; manager reads allow operational review. A historical handover with no wizard submission returns `submission: null` and an empty claim list.

Private transaction contexts are scoped to the transaction. No public context-setting helper is installed. Creation and evidence-write guards independently require effective `postgres`. The legacy inspection trigger runs as its owner so unrelated historical writes do not need access to protected evidence, and it checks the actual session role plus the applicable private transaction context for protected changes. The existing receipt engine retains its own effective-role/context checks.

## RPC contract

### Options

```json
{
  "mealChoice": "none",
  "mealPayerId": null,
  "expenses": [
    {
      "clientKey": "c8ca1b59-ea33-4abf-a1b3-3311b98c5219",
      "existingPaymentId": null,
      "amount": 12,
      "description": "Supplies receipt",
      "spentOn": "2026-11-21",
      "category": "SUPPLIES",
      "recipient": "Supplier",
      "fundingSource": "WORKER_COLLECTIONS",
      "includesOwnMeal": false
    }
  ]
}
```

`mealChoice` is `self`, `other`, `none`, `existing`, or `monthly`. An initial preview may omit it; an eligible uncovered worker must choose before committing. `other` requires a different active worker's UUID. The payer list contains UUIDs and names, and excludes PINs.

Expense categories are `FOOD`, `FUEL`, `SUPPLIES`, and `OTHER`; funding sources are described below. Each expense uses a stable client-generated UUID. A request permits at most 20 expenses. Amounts are positive, have at most two decimals, and are bounded at €1,000,000. Description length is 2–500 characters, recipient length is at most 160, and `spentOn` is an ISO date from 2020 through the current business date. Unknown fields and duplicate references fail validation.

### Preview

`preview_worker_handoff_v1(p_actor_id uuid, p_options jsonb)` is read-only. It returns:

```text
ok, actorId, snapshotHash, businessDate, mealPayers,
mealPolicy { dailyAllowed, choice, payerId, mealAmount, existingMealTotal,
             requiresDecision, coveredToday, eligibleSelf },
payments [{ id, code, clientName, amount, collectedAt, sourceModule,
            commission, updatedAt }],
bonuses [{ bonusId, paymentId, kind, amount, remainingAmount,
           reservedAmount, updatedAt }],
meals [{ id, amount, day, note, updatedAt }],
existingExpenses [{ paymentId, amount, description, spentOn, status, ledgerPosted }],
expenses [{ ...normalized input, deductionAmount, mealAlreadyDeducted,
            existingStatus, existingUpdatedAt }],
totals { grossCash, commission, mealDeduction, bonusDeduction, bonusRemaining,
         expectedCash, claimedCollectionExpenses, projectedCash },
pendingHandoffs [{ id, amount, outstandingAmount, submittedAt }],
canSubmit, warnings
```

Cash selection is a strict type allowlist, requires the worker's ownership and ready status, and excludes active handover membership, exclusions, and reassigned payments. Earlier pending handovers are shown separately and never become newly selected customer cash. A preview permits at most 500 payments.

Existing expense selection uses one private eligibility predicate for both the displayed list and submitted IDs. An accepted status alone cannot authorize reuse. Accepted rows require the latest finalized standalone decision to be an active business expense with an exact original OUT linked to that payment. Genuine pending requests require no finalized decision or posted ledger entry. A settlement marker anywhere in the handover note, a handover reference, `handed_at`, an applied cycle, active handover membership/expense decision, exclusion, or prior wizard claim makes the expense unavailable. Older ambiguous accepted history is preserved and requires separate review; it cannot create another deduction or OUT through this wizard.

Hybrid commission uses the existing atomic engine's per-payment net rounding, including half-cent cases. Bonus deductions use only eligible remaining amounts and preserve the legacy minimum €0.01 handover amount when a bonus would consume all available cash. No negative handover or invented payout is created.

The hash includes relevant worker configuration, selected payment/bonus/meal state, meal coverage, normalized expense evidence, and calculated totals. Display-only payer and pending-handover lists do not affect the hash.

### Submit

```text
submit_worker_handoff_v1(
  p_actor_id uuid, p_snapshot_hash text, p_request_key text,
  p_options jsonb, p_physical_cash numeric, p_difference_reason text
)
```

The private function:

1. Checks a prior actor/request key before recalculation. An exact retry returns the original result; changed content fails.
2. Recomputes the preview, checks its hash, locks the worker/payer identities and relevant payment/bonus rows in a consistent order, then recomputes and checks the hash again.
3. Creates any chosen self/other-paid meal through the existing atomic meal function. Beneficiary/day serialization prevents repeated coverage, including competing legacy meal calls.
4. Calls the existing atomic bonus/meal handover engine with server-selected IDs and the calculated expected cash.
5. Stores immutable preview evidence and the worker's cash declaration. New expense payments are created as pending requests; existing expense payments are linked once.

Everything commits or rolls back together. Worker submission reserves the existing bonus allocation and creates pending evidence. It writes no company ledger entry and no receipt event.

The result is `{ok, replayed, handoffId, submission, claims, canDecide}`. `submission` contains `id`, `handoffId`, `actorId`, `snapshotHash`, `physicalCash`, `expectedCash`, `projectedCash`, `differenceAmount`, `differenceReason`, `snapshot`, and `createdAt`. The stored snapshot additionally identifies committed meal rows and bonus allocations.

The browser persists a request intent before posting and reuses it after a timeout or lost response. A request key is 12–120 characters from letters, digits, colon, underscore, and hyphen. The same key with different financial content is an error.

### Read and expense decisions

`read_worker_handoff_submission_v1(p_actor_id uuid, p_handoff_id bigint)` returns the immutable submission plus current claims. A claim contains:

```text
id, handoffId, paymentId, amount, deductionAmount, mealAlreadyDeducted,
description, spentOn, category, recipient, fundingSource, includesOwnMeal,
status, decisionNote, decidedByName, decidedAt,
canDecide, requiresFundingConfirmation, requiresActualReceipt,
canReimburse, reimbursementNote, reimbursedByName, reimbursedAt,
expenseLedgerId, reclassificationLedgerId, resolutionEventId
```

`decide_worker_handoff_expense_v1(p_actor_id uuid, p_claim_id bigint, p_approve boolean, p_note text, p_request_key text)` requires a different authorized manager, a pending claim, and a 4–1000 character note. The API additionally requires explicit funding confirmation for approval. It returns `{ok, replayed, handoffId, claim}`.

Claim states are `PENDING`, `APPROVED`, `REJECTED`, `REIMBURSEMENT_PENDING`, and `REIMBURSED`. A review request key is logged with its exact payload and result. Replays do not post another ledger entry or resolution; a different key cannot decide an already decided claim again.

## Expense funding and cash conservation

| Funding source | Projection and manager action |
| --- | --- |
| `WORKER_COLLECTIONS` | Reduces projected worker cash while pending. Approval recognizes the business expense, reverses its drawer classification once, and links a noncash handover resolution for the verified deduction. |
| `DISPATCH_DRAWER` | Does not reduce projected worker cash. Approval uses the existing business-expense engine; an existing posted expense remains a single OUT. |
| `OWN_MONEY` | Does not reduce projected worker cash. Approval acknowledges a reimbursement payable without moving company cash. A separate explicit repayment action posts the real drawer OUT. |

A positive collections-funded offset requires dispatch to first record the actual receipt, including an explicit zero receipt if zero cash arrived. This establishes receipt tracking through the existing authorized receipt workflow. Approval never inserts a synthetic receipt to satisfy that prerequisite. The remaining balance must cover the deduction; already received cash cannot be offset again.

The collection-funded expense uses a linked pair:

- The business expense has its original `arka_expense_decision` OUT, created if necessary.
- A `worker_handoff_expense_reclass` IN for the **full original expense amount** reverses the assumption that the expense was paid from the drawer. This preserves the business expense and identifies the funding correction explicitly.
- A `RESOLUTION` event for `deductionAmount` explains the worker's retained collection cash. It is noncash and creates no receipt credit.

Actual cash totals must continue to use `cash_handoff_receipt_events` of kind `RECEIPT`. The reclassification IN is an accounting correction, and the company ledger's gross IN total includes it; it must not be described as money physically handed over.

Example: drawer €500, client cash €100, retained bonus €10, own meal €3, and supplies €12.

| Funding | Cash reaching dispatch | Ledger treatment | Final drawer |
| --- | ---: | --- | ---: |
| Worker collections | €75 | Actual receipt +75; expense −12 and funding correction +12 cancel in the drawer. | €575 |
| Dispatch drawer | €87 | Expense −12; actual receipt +87. | €575 |
| Worker personal money, before repayment | €87 | Actual receipt +87; acknowledgment has no cash movement. | €587 |
| Worker personal money, after repayment | €87 | Separate actual reimbursement −12. | €575 |

For collection-funded expenses already posted as OUT, approving the funding correction restores that previously removed amount once. Unique expense-payment and original-OUT links prevent reuse. Expense approval does not alter the original handover amount or its client-payment amounts.

## Personal-money reimbursement

Acknowledgment moves the underlying expense payment to `REIMBURSEMENT_PENDING`, preserving its amount and worker identity. This supported text status is outside the daily-close undecided-expense set. The immutable claim remains visible for reimbursement review. Neither the company balance nor receipt/outstanding totals change on acknowledgment.

```text
reimburse_worker_handoff_expense_v1(
  p_actor_id uuid, p_claim_id bigint, p_amount numeric,
  p_note text, p_request_key text
)
```

The API requires an explicit `confirmPaid: true`. The database requires an authorized manager different from the worker, source `OWN_MONEY`, status `REIMBURSEMENT_PENDING`, and the exact full amount. It invokes the existing business-expense engine in the same transaction, verifies the corresponding OUT, and marks the claim `REIMBURSED`. Initial approval fields remain immutable; repayment has its own note, person, time, and linked `expenseLedgerId`. The same repayment request returns the stored result. A changed amount, repeated decision under a fresh key, or self reimbursement is rejected.

Partial repayments are outside this version. An expense that already has a finalized company payment cannot be newly treated as an unpaid personal-money claim; it requires separate review of its existing payment evidence. Reimbursement does not change the worker's handover obligation and never creates a handover receipt or resolution.

## Meal policy and overlap

The server uses `meal_policy_schedule_v1` and the Belgrade date. From the existing December policy cutoff, the wizard cannot create a new daily self/other meal deduction. Earlier valid unsettled meal rows remain carried according to the existing engine. Other-paid coverage is created atomically with its payer's matching meal obligation.

The same cutoff also rejects every **new food expense** in the wizard, across customer collections, drawer funds, and personal money. Food is recognized by the FOOD category or the canonical food-word vocabulary already used by the database guard, including Albanian breakfast terms; selecting OTHER or supplying a prior `spentOn` date cannot bypass the rule. Preview and submit return `WHW_DAILY_FOOD_CLOSED`. Genuinely earlier existing food expenses remain eligible only when their canonical creation date and declared expense date precede the applicable policy and the historical eligibility checks above pass. Existing monthly membership and payroll calculations are unchanged.

`includesOwnMeal: true` credits €3 only with exact proof: a FOOD expense funded from worker collections, spent today, daily policy active, and this handover includes exactly one same-day €3 self meal. For an existing expense, its canonical creation date in Belgrade must also be today; changing the submitted `spentOn` cannot turn an older expense into an automatic overlap credit. The existing meal row must target only the worker; grouped coverage and same-day meal totals above €3 are ambiguous and fail closed. Only one claim per handover can use the credit.

The worker must explicitly answer whether a food expense paid from collections includes their own meal. Neither answer is preselected. The API requires the resulting boolean field for this category and funding source.

For a €12 food receipt including a verified €3 self meal, `amount = 12`, `mealAlreadyDeducted = 3`, and `deductionAmount = 9`. The expense's full original OUT12 is corrected once, while only RESOLUTION9 explains additional retained cash. Gross100 − bonus10 − meal3 gives expected87; projected87 − expense9 gives physical78. Recording actual78 and approving the expense adds exactly78 to the drawer.

The existing restricted-worker food policy is preserved. The wizard does not infer whether a meal paid for other people, an earlier day, or an ambiguous grouped allocation overlaps a new receipt.

## Immutability and historical compatibility

Submissions cannot be edited or deleted. Claims permit only their defined audited state transitions. Expense payment identity and amount are protected once linked. Related standalone expense decisions cannot bypass wizard review. Linked original OUT entries, funding corrections, and receipt events retain their evidence links.

Cached legacy acceptance is blocked for wizard handovers even before the first receipt. Handovers and membership items cannot be rewritten to avoid actual counting. Historical records with no wizard evidence are unaffected by these guards. The separate mandatory creation trigger prevents new handovers through legacy paths after rollout.

## Verification

Run the actual SQL/HTTP harness and wizard UI checks:

```sh
node tools/verify-worker-handoff-wizard.mjs
node tools/verify-worker-handoff-wizard-ui.mjs
node tools/verify-worker-handoff-submission-ui.mjs
```

The financial harness loads exported production function definitions into local PostgreSQL/PGlite and uses synthetic workers, clients, expenses, bonuses, and dates. It checks cash conservation, manual physical declaration, exact retries, stale previews, scoped reads, expense uniqueness, actual-receipt prerequisites, own-meal overlap, grouped-meal rejection, policy cutoff/carry, explicit reimbursement, legacy protection, and unrelated historical-write compatibility. It also exercises the authenticated HTTP boundary and service-role RPC access.

No test fixture contains the real handover corrections. Production verification should inspect new schema/function privileges and perform read-only previews with a verified session; use synthetic local data for mutation tests.
