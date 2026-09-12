# Dispatch submission investigation — 2026-09-12

The previous production release was PR #54, commit `62036777`. The operator reported needing several attempts to create one order.

## Evidence and limits

Production logs include successful PHONE_CHECK requests taking 28,008, 13,834 and 9,162 ms. The browser phone check has a 15-second deadline, so the longest successful server response is already too late for that attempt. The check is advisory and does not authorize creation.

The available CREATE logs show successful responses. They do not include the operator's taps or establish where each unsuccessful attempt stopped. Browser tab discovery timed out in this session; the actual iPhone could not be inspected. Do not treat passing Node scenarios as physical-device verification.

Reproduced in the shipping queue/storage code:

- A malformed old per-order record aborts enqueue for an unrelated new order.
- One read of 100 saved orders uses 102 IndexedDB transactions.
- A global drain promise makes later work wait behind an earlier response; newly enqueued work also waits for a subsequent drain snapshot.
- Failure to write a sent receipt propagates as failure even after the server confirms creation.
- The IndexedDB timeout waits for onabort and can remain unresolved if that event is never delivered.

The diagnostic endpoint also sent explicit nulls for `events_json` and `meta_json`; both columns are NOT NULL. Production logs repeatedly report PostgreSQL 23502. Fixed defaults were verified with a synthetic INSERT inside a rolled-back database transaction.

## Submission contract

1. Freeze the order payload and retain its UUID. Commit the complete request locally before any network write.
2. Send that specific order immediately, including after an operator reviews a blocked request and chooses to retry it. Per-order in-flight promises prevent the foreground path and background replay from submitting the same request simultaneously. Two background workers keep older requests moving independently.
3. Await the first server result in the form. Disable the form while that immutable request is being saved/sent.
4. Show the confirmed T-code after a verified server response. Otherwise clearly show a durable pending request or a blocked request requiring attention. Pending requests retry with the same UUID and payload.

Queue reads use one IndexedDB snapshot for entries instead of a transaction per item; expired receipts are also removed in one batch. Corrupt records remain untouched for recovery and cannot stop unrelated valid orders. A verified server receipt remains authoritative in memory even if its local metadata write fails; replay after reload still uses server UUID idempotency.

The complete submit has a deadline. Database transaction timeouts reject promptly without depending on a later abort event. No unverified local write is acknowledged and no authentication or identity denial is bypassed.

Diagnostics now record stage, elapsed time, build and error codes through the existing same-origin endpoint. They exclude names, phone numbers, addresses, order payloads and credentials. A prolonged foreground attempt reports its last stage once.

## Verification

Twelve regression scenarios cover malformed old rows, targeted submission during an earlier slow request, direct/background deduplication, confirmed receipt storage failure, bulk reads/cleanup, a permanently unresolved submit, and an IndexedDB abort event that never arrives. The shipping form and review-and-retry click handlers are also executed with the actual outbox to check server confirmation, rapid double taps, offline acknowledgement, blocked responses, failed local writes and targeted retries. Existing offline/reload, immutable payload, 100-timeout replay, actor isolation, phone identity, search, status and payment tests passed in the full production build.

Physical iPhone confirmation remains outstanding. No live customer order was created or altered in this investigation.
