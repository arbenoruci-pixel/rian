# Daily bonus entries and net cash handoff

## Behavior

The personal Arka view lists approved Base and Transport-control bonus entries by the date of the linked `READY_48H_BONUS` Arka booking. The booking ID is `base_ready_bonuses.arka_payment_id`; the originating customer payment and qualification timestamp are not used as substitute posting dates. Missing bookings remain explicit reconciliation notices. Customer cash and monthly bonus reporting retain their existing accounting meanings.

Opening the handoff flow refreshes the canonical cash snapshot, both bonus sources, unsettled meal payments and today's meal coverage. Incomplete or offline reads stop the preview. The review displays gross cash, applicable commission, meals, the bonus to keep, any bonus carried forward and the net cash for Dispatch. The displayed deduction follows the existing atomic RPC's cash cap, which preserves the final cent. The confirmed receipt uses the actual returned handoff amount without subtracting the bonus again.

Submission continues through the existing atomic handoff RPC. Partial allocations are checked against the requested bonus/payment mapping and exact cent totals. Requested bonuses left open by the cash cap remain available. Session changes clear the preview and prevent submission under the prior account. A reopened wizard starts with the newly loaded meal coverage.

## Verification

- `npm run test:worker-bonus-account` covers the report/API boundary, scoped booking reads, monthly compatibility and existing history/Dispatch displays.
- `npm run test:worker-daily-bonus-handoff` covers the actual daily React UI, daily posting boundaries, fresh preview reads, session changes, failed reads, cash/meal/bonus arithmetic, confirmed receipts and partial allocation proofs.
- `npm run build` runs these gates with the existing application checks and produces the deployable bundle. The legacy handoff installer preserves the strict online bonus reader.
- Financial mutation tests use synthetic fixtures. Hosted verification calls the read-only report endpoint and checks approved-device authorization, worker isolation, exact booking dates and field redaction.

## Rollback

The production deployment immediately before this change is `dpl_3pEFT1DuPRfiua2Vv5T2JPJ9RBs5`, built from commit `863be654274eddc1a7adcbd5d78119c3ade4b803` in the `rian` project under the `tepiha` team.

For an immediate application rollback, re-promote that ready deployment in Vercel and verify that `tepiha.vercel.app` resolves to it. For a persistent source rollback, revert this change's merged pull request and deploy the resulting commit through the normal build gates.

This release has no database migration, financial backfill, compensation-rule change or access-policy change. Application rollback therefore requires no database rollback. Keep legitimate handoffs and financial entries created by users after deployment; rolling back the application does not reverse those transactions.
