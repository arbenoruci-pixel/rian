# Dated monthly food allowance

## Behavior

The policy is effective on **1 December 2026 in Europe/Belgrade**, which is **30 November 2026 at 23:00 UTC**. PostgreSQL supplies the current business date. The daily food trigger checks the actual server insertion clock, including requests replayed by an older or offline client.

The policy row is `meal_monthly_2026_12`. It contains a daily rate of €3, 26 work days and a fixed monthly amount of **€78**. The amount replaces the prior food component for configured members in December and subsequent payroll periods. All new daily food cash entries stop at the cutoff; workers outside the membership have no new monthly food allowance. Membership is a separate table keyed by the canonical `users.id` UUID. Application code, migrations and tests contain no actual staff identifiers.

The existing `users.pay_meal_*` fields remain unchanged. November and earlier open payroll previews retain their previous behavior, and closed payroll snapshots are never rewritten. The compensation editor keeps the separate `legacy_meal_*` values when saving other profile fields. New-period salary quotes use the dated allowance plus the enabled base salary and fixed transport allowance. Server salary validation occurs before any budget debit and rejects a stale gross/net quote instead of changing an operator's approved amount.

Previously stored daily meal claims remain visible and can be settled through the existing handoff workflow. New backdated meal claims after the cutoff are rejected for review. Existing claim amounts, owners and dates cannot be rewritten. `MEAL_COVERED` is evidence for a beneficiary; it does not create a second payer deduction. A prior payer claim is deducted once through the existing atomic settlement.

## Deployment order and private configuration

1. Preserve the release's database backup and current function definitions. Apply `20261122015736_meal_monthly_policy_v1.sql` before the receipt migration. It stores the preceding compensation/profile, finance snapshot and monthly preview definitions in the protected `meal_policy_function_backups` table.
2. Resolve the three authorized employees privately to active canonical UUIDs. Insert exactly those UUIDs into `meal_policy_members` for the policy key, using parameters and a transaction. Verify all three are active and the resulting membership count is exactly three. Do not alter `users.pay_meal_amount` or use display names/PINs as policy identifiers.
3. Apply the receipt migration after this migration. Its finance snapshot and monthly pending-cash overlays build on the dated meal definitions. Its read API must return the active `pending_payment_ids` for each tracked handoff so payroll counts the remaining balance once rather than its full source payments.
4. Publish the API and frontend together. Mount `MealPolicyNotice` once inside the authenticated application. Pass `fetchMealPolicy` as the handoff preview's `readMealPolicy` reader and pass the returned policy to the wizard. Payroll and profit previews require the secure team-policy and handoff-receipt reads.
5. Verify the current API state shows the future policy and the expected `nextActivationAt`. No daily cash is disabled before the cutoff. The scheduled timer, focus/resume refresh and database clock activate the new behavior without a cron job or additional service.

The new read and acknowledgment RPCs, policy tables and salary basis RPC are service-only. `/api/meal-policy` authenticates the approved device's active staff account and enforces own-account versus management scope. The pre-existing invoker-only SQL monthly preview is an internal server calculation; browser screens use the secured policy/receipt reads with the JS preview. Its new helper calls require a server database context.

## Employee notice

An eligible worker sees a notice on the first active session on or after the effective business date. It states the €78 amount and €3 × 26 calculation, explains that daily food stops being taken from the cash handoff, and explains the settlement of earlier stored claims. “E kuptova” records an idempotent acknowledgment for that worker. A failed acknowledgment remains visible for retry. Inactive, noneligible and already acknowledged accounts do not see the popup.

The notice uses `data-meal-policy-notice="open"` and emits `tepiha:meal-policy-open` so the optional staff-message panel yields priority. `tepiha:meal-policy-updated` refreshes open accounting screens at the date boundary. Caches are account-scoped and expire against the server activation delay using a monotonic timer; a wrong device wall clock cannot authorize food cash or advance the notice date.

## Verification

Run:

```sh
node tools/verify-meal-monthly-policy.mjs
node tools/verify-meal-policy-ui.mjs
node tools/verify-worker-handoff-preview.mjs
node tools/verify-handoff-cash-summary.mjs
```

These use isolated synthetic PostgreSQL/browser fixtures. They cover the exact local midnight, November and future-month previews, €78 replacement, noneligible workers, canonical-account authorization, RLS/grants, idempotent acknowledgment, stale salary rejection before writes, old/offline daily-meal requests, legacy claim settlement, receipt residuals counted once, modal priority, wrong device clocks, account switching and retained November handoff behavior. Production database clocks and rows are never modified by the tests.

## Rollback and recovery

Prefer retaining the additive database tables, triggers, acknowledgment history and receipt events. A UI recovery release must keep the new server cutoff/quote checks or temporarily disable affected financial actions. An older application can otherwise display an outdated salary quote even while the database protects new daily-meal creation.

Before any new-policy salary payment or period close exists, an authorized operator can disable the policy configuration in a controlled transaction. This returns the legacy food component and daily-food rules while retaining all recorded history. Re-enable the same policy to restore its original effective date. Treat this as an operational rollback, not an automatic fallback on a failed read.

After December salary/receipt transactions exist, pause the affected workflow and reconcile actual entries before changing policy configuration. Do not delete meal claims, receipt events, acknowledgments or closed payroll snapshots. Do not restore the full old finance snapshot definition independently: the receipt migration also patches it. A full function rollback must reverse application order and preserve or reapply all receipt overlays. The protected backup tables retain the original definitions for a deliberate recovery reviewed against current data.
