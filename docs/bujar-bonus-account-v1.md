# Bujar bonus account and Dispatch reporting

## Purpose

Dispatch and Bujar need a clear account of Base bonuses and Transport inspection bonuses: earned money, cash retained in accepted handoffs, money reserved in pending handoffs, and the available balance. The former READY label combined both sources, while daily Arka history incorrectly included bonus approval rows in customer cash.

## Behavior

- `WorkerBonusAccount` is visible in the unified worker account (own Arka and Dispatch's worker detail) and in `LLOGARIA IME`. The `#bonuset` anchor opens the report from history and handoff links.
- The selected business month uses `Europe/Belgrade`, consistently with existing business reports. Earnings use the bonus qualification date; cash retained in that month uses the accepted handoff's decision date. Earlier earned bonuses retained this month therefore count in the correct cash month.
- Available and reserved balances include all outstanding periods. Their labels explicitly say they are current balances.
- Base and Transport controls have separate totals and rows. Each bonus lists its linked handoffs, allocation amount and acceptance/reversal state. Each handoff shows the Base/Transport split.
- Pending Transport inspections are shown separately as potential awards. They do not enter earned/available totals. Completed/cancelled orders are marked as requiring clarification; the report never approves them.
- Dispatch's pending handoff cards show the actual bonus allocation split for Bujar/bonus-enabled workers. Missing data is an error or an account link, never a fabricated zero balance.
- Daily Arka history and personal-account cash displays exclude bonus approval rows from customer receipts. History displays their Base/Transport source separately. `ACCEPTED_BY_DISPATCH` on a bonus payment means the bonus was approved; only accepted cash-handoff allocations establish retained cash.
- The fixed monthly transport salary allowance is labelled `SHTESË MUJORE TRANSPORTI` in the account, keeping it distinct from inspection awards.

## Data and access

`POST /api/worker-bonuses` is a read-only report. It verifies same-origin JSON, body size, the approved `tepiha_device_id` cookie, and the current active user. Staff can read their own account. The existing manager role family can read a selected worker. A supplied role/PIN never establishes the caller's authority, and an expected actor mismatch fails closed.

The server queries only the scoped worker's bonus ledger, its allocations and handoffs, and their pending Transport control codes/statuses. The response contains no PIN, device ID, customer name, phone, evidence URL, or unrestricted metadata. It calls no write RPC, creates no migration, and changes no pay rate, award rule, approval, salary, customer payment, or handoff balance.

Queries paginate with deterministic IDs and fail instead of returning partial financial totals. The browser deduplicates concurrent requests and keeps a 30-second memory cache scoped to actor, target and month. Explicit refresh reloads the report. No periodic polling or background job is added.

## Historical reconciliation

Accepted cash allocations are the source for `retained` and `retainedAllTime`. The bonus ledger's stored retained balance is also reported for comparison. A historical discrepancy is visible as a warning; the implementation never silently changes or removes an allocation. For example, an old repaired bonus can have two accepted allocation records while its current ledger retained amount records one. The history exposes allocation details only when the handoff belongs to the same worker. An allocation linked to a different worker's handoff is flagged as `HANDOFF_MISSING` without disclosing that handoff's details or treating it as this worker's retained cash.

Reversed allocations remain visible with their cancelled state and do not count as retained cash. Any restored available balance comes from the current bonus ledger. Missing acceptance dates or handoff records are flagged rather than assigned an invented payment date.

## Verification

`npm run test:worker-bonus-account` is a production-build gate. It covers the real read model/server/handler, role isolation, origin/device/body restrictions, pagination, cents, carryovers, business-month boundaries, partial/reversed allocations, old discrepancies, pending controls, actual history classification/rendering, and account UI behavior. Existing payout, Transport inspection, payroll, offline and client/payment regression gates remain in `npm run build`.

The change must pass the complete build before release. Hosted verification checks the new route with an approved worker/manager device and rejects anonymous, cross-origin and cross-worker reads. No live financial mutation is needed for these checks.

## Rollback

Pre-change production release:

- Commit: `3a0a1827eff3c4748ae3bf4f0bce94f9b299f231`
- Vercel deployment: `dpl_DLHTa8jFj1jSnGssxZ33Ghc4y7Mq`
- Project: `rian` / `prj_W5nwXeKHqk92Nt9IEWXkgaIjsEtF`, team `tepiha`

Restore that production deployment through Vercel rollback if the report causes an issue. Then revert only the bonus-report release commit in Git and run CI before the next promotion. No database rollback is required because this release makes no database mutation. The earlier base-code-pool RLS protection is already included in the rollback target and remains in place.

Refreshing the installed PWA online loads the released view. Do not clear device storage or offline drafts as part of this rollout.
