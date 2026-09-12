# Dispatch confirmed-create/list-refresh incident — 2026-09-12

The operator's iPhone screenshots show a server-confirmed creation followed by a failed list refresh, plus an interrupted advisory phone check. Production evidence confirms a single successful CREATE at 14:16 UTC, taking 1,190 ms server-side; the browser reported `sent` after 1,453 ms on `dispatch-submit-confirmed-v2`. The order remained in the database. The exact cause of the phone's failed read was not recorded by that release.

## Reproduced code failures

- The list used the browser Supabase client, whose wrapper imposed a 5-second timeout despite Dispatch's outer 12-second deadline. CREATE used a separate same-origin approved-device endpoint. The list's 160-row JSON response was approximately 778 KB when checked.
- A committed order event contained only an ID. The page depended on another full list request to display a canonical row it already received from CREATE.
- An in-flight list caused refresh requests to be dropped, including a post-commit refresh. An older snapshot could replace the list after a create or edit.
- Phone checks stopped after two quick retries and required a browser online/focus event or a manual retry. Changing the phone ignored old replies but left old network requests running.

## Changes

LIST uses the same origin/device/role checks as CREATE. It requires the browser actor to match the authenticated device actor, queries only `transport_orders`, and fixes its scope to the existing 160 most recently updated rows. No permissions or database schema changed.

Verified server rows immediately enter the board and its local search data. Confirmed receipts retain the canonical row in IndexedDB for the outbox's existing one-day retention, so a reload can display them while offline. Newer server statuses win over earlier receipts. Refreshes coalesce with one follow-up, preserve confirmations that arrived during an older read, retry transient failures with backoff, and resume on online/focus/pageshow/visibility events.

Phone checks cancel obsolete requests, include the complete operation/body in their deadline, and continue at a 15-second interval after two quick retries while the form is visible. Explicit identity/auth denials remain explicit. Status copy distinguishes delayed checking/list refresh from creation confirmation.

List and phone failures now record safe error codes through the existing diagnostics endpoint. Customer names, phones, addresses and payloads are excluded from this telemetry.

## Verification and limits

Eighteen executable regression scenarios cover the actual API route, fixed query/actor scope, client validation, cancellation, hanging bodies, slow/failed/overlapping list reads, late snapshots, newer statuses, actor changes, restored IndexedDB receipts, phone recovery without an online event, and the shipping page's committed-event handler.

The full production build and existing regression gates passed. One verification script's Git file listing exceeded Node's output buffer because this repository tracks dependencies; excluding the same generated/dependency directories already excluded by its source filter fixed discovery without changing its checks.

No live customer order was created or modified. Interactive browser discovery again timed out; physical iPhone verification remains outstanding. The screenshot and production diagnostics establish that creation succeeded before this read/display repair.
