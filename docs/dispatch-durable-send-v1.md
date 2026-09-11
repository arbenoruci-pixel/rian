# Dispatch order submission reliability — 11 September 2026

## Confirmed findings

- Production was running commit `090936549c44c7c60d60b1ee88a5d875f2e14df7` (PR #39). The earlier stale-UUID recovery fix was deployed.
- The previous create path made two attempts, each allowing 35 seconds for the request and up to 10 seconds for direct DB reconciliation. After roughly 90 seconds of timeouts it returned “PROVO PRAPË”. No automatic continuation followed.
- The intent journal persisted a UUID and hashes, not the full order. It could not replay after a closed/reloaded form. Editing an unresolved form preserved its UUID while changing its business fingerprint, potentially causing a conflict after a committed-but-lost response.
- The button displayed “DUKE KONTROLLU TELEFONIN…” during an advisory lookup even though submission was already enabled. This made the optional lookup appear mandatory.
- Production logs for 11 September 08:55–09:05 UTC include CREATE responses of 200 in 1,396 ms and 1,167 ms; advisory phone checks in that window also succeeded. This establishes that the endpoint was serving writes. It does not establish the worker device's connection quality or exact error.
- Larger log searches timed out. The worker's installed PWA/session could not be inspected: the available browser had no active Tepiha login. The local UI preview was blocked by that browser. No live customer order was created for testing.

## Change

A single tap first persists the full immutable request in a dedicated local outbox, then releases the form. Pending orders remain visible separately from server-confirmed orders. The outbox runs at the app root, retries temporary failures with backoff, and resumes on connectivity return, foregrounding, navigation and reload. A suspended/closed mobile app resumes work when reopened; this is not an OS background delivery guarantee.

New durable requests use a 12-second attempt deadline and replay through the approved-device API, retaining the same UUID and payload. Legacy callers retain their existing retry/reconciliation contract. Server verification of permanent T-code, phone, visit and active-order deduplication remains in place. Device denial and identity conflicts never get bypassed.

The outbox is scoped to the originating actor. An optional `expected_actor_id` is checked against the authenticated server actor before any DB access, preventing resumed work from running under another login. Storage errors retain the input form and prevent a false saved acknowledgement. Pending requests older than 24 hours remain available for explicit review; they are not silently deleted or sent with a new UUID.

Local records contain customer details necessary for replay, as existing app caches do. Confirmed records drop their full request and expire from the recent-status display after a day. Clearing browser/site data still removes unsent local work.

## Verification

- Full `npm run build`, including the repository's existing regression gates: passed.
- Durable-outbox behavior tests: offline persistence/reload, frozen payload, five consecutive network failures, lost response after commit, concurrent drains, actor isolation, server actor mismatch, explicit auth/identity denial, storage unavailable/corrupt, and overdue review.
- Existing server and transport recovery tests: passed, including stale UUID recovery, active-order deduplication, approved-device enforcement and exact request retry.
- Final Vite production compilation after the UI review: passed.
- Authenticated end-to-end verification on the worker's installed PWA remains outstanding.

No database migration is required.
