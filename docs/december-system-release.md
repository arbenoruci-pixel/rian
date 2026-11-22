# December meal policy, actual cash receipts and staff messages

## Release behavior

The monthly meal policy activates at 00:00 on 1 December 2026 in the business timezone, Europe/Belgrade. The fixed allowance is €78 per configured employee and payroll month (3 × 26). The three authorized memberships are configured privately against canonical active worker IDs. The release contains no recipient seed with actual identities. Earlier payroll snapshots and stored meal claims retain their original amounts and settlement history.

Dispatch records the money actually received against an immutable net handoff expectation. A partial receipt increases company cash by the received amount and leaves the balance on that worker's handoff. A later cash receipt or explicitly confirmed noncash resolution closes that balance. Reports, bonus retention, payroll checks and distributable profit use this same distinction. Noncash resolutions do not create cash or a salary deduction.

Authenticated Dispatch and administrative accounts can compose internal messages for selected active workers or all eligible operational workers. Recipients have an inbox, unread count and explicit acknowledgment. The sender sees read and acknowledgment status. Automatic meal-policy notices take priority when the dated rule becomes active. The release adds no scheduled service, external messaging channel or cron job.

Arka puts current pending receipts before historical detail. Pastrimi and Gati have grouped secondary tools, clearer customer and rack text, larger primary actions and more explicit search state. The Gati primary action distinguishes paid delivery from payment plus delivery. Pastrimi signals capacity above its configured maximum.

## Rollout

1. Run the complete existing `npm run build` gate, including the new meal, receipt and messaging suites.
2. Preserve a read-only fingerprint of existing handoff, budget, bonus-allocation and payroll records. Record the current production deployment.
3. Apply the migrations in this order: `20261122015736_meal_monthly_policy_v1.sql`, `20261122015743_actual_handoff_receipts_v1.sql`, `20261122015749_staff_messages_v1.sql`. These changes add protected tables and preserve previous function definitions before replacing them.
4. Configure the three authorized meal memberships in a transaction and verify the exact membership count and future allowance. Preserve the original worker-profile meal fields.
5. Verify schema/grants, current pre-cutoff state, future-month amounts and unchanged existing financial fingerprints. Do not create real worker receipts, salaries or messages for smoke testing.
6. Build the Git branch preview, inspect its read-only pages, then merge and verify the production commit, routes and active session.

## Recovery reference

The pre-release production commit is `cd345aecb78ebcd018022e85c9978c54ae4bf34b`; its Vercel deployment is `dpl_hhnhHzoyiiTC3Ea8JGJzEV2QsVk3`. The immutable Git revision remains available for comparison or a compatible recovery deployment.

Retain all additive tables, access restrictions, previous function definitions, receipts and message history. The migration-specific documents describe the pause controls and recovery boundaries:

- `meal-monthly-policy.md`
- `actual-handoff-receipts-v1.md`
- `staff-messages-v1.md`

Before new-policy payments or receipt events exist, a reviewed application rollback can use the previous deployment with compatible configuration. Once the new financial workflow has been used, pause fresh writes and correct the application while preserving its receipt-aware database guards and reporting. After the meal cutoff, keep the new payroll quote guard when constructing a recovery release. Restoring the entire previous application alone would also restore its old payroll API.

The receipt pause retains reads and successful-request replay. A completed transaction is never undone by deleting its event or by restoring a whole database snapshot over later business activity. A recovery release must verify existing customer flows and account access along with these financial constraints.

## Focused verification

`test:meal-monthly-policy` verifies the server date boundary, unchanged historical periods, monthly replacement, eligibility, acknowledgments, old-client guards, salary validation before cash movement and preserved legacy claim settlement.

`test:handoff-receipts` verifies actual cash, remaining balances, immutable audit, retries, stale competing requests, noncash resolution, bonus retention once, daily-close accounting, worker visibility, account history and Kapaku calculations.

`test:staff-messages` verifies approved-device identity, sender and recipient scope, atomic audience snapshots, retry idempotency, read/acknowledgment history, escaped content, account changes and bounded foreground polling.

The established customer, order, payment, offline, authentication, payroll and bonus suites remain in the full build. Synthetic database and React tests perform no production business writes. Visual smoke review is separate from physical-device testing.
