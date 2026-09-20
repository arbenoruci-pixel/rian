# Dispatch foreground send recovery — 2026-09-20

## Observed production behavior

Production alias `tepiha.vercel.app` was running commit `cfe5b45e9d9c5a4eb3b89062cd27823c8a85519a` (PR #60).
Read-only diagnostics around 20:47–20:48 UTC show one CREATE timeout after 12,054 ms,
three phone-check timeouts and four list timeouts. Server logs in the same window
show successful CREATE processing in 755–759 ms, including idempotent retries,
PHONE_CHECK in 657 ms and LIST in 353–464 ms. The order reported by the user is
present once in the database. No customer or operational rows were changed during investigation.

This establishes a client/server acknowledgement gap. Server execution time
excludes travel to/from the device, queued browser requests and suspension.
It does not establish whether the underlying cause was connectivity, Safari/PWA
suspension or another device condition. Similar read timeouts predate PRs #59/#60;
their diffs do not prove the reported regression was introduced by those releases.

## Reproduced code weaknesses and correction

- The board continued downloading all 160 rows every 20 seconds and after realtime
  events while the create form was open. The current full response is about 832 KB
  before compression. Opening the form now cancels the advisory list download;
  poll/realtime requests remain paused until the form closes. Confirmed events
  still update the local board while paused; closing triggers a fresh server read.
- A phone check hung in the background kept its running flag and ignored resume
  events until its 15-second timeout. Visibility changes now cancel it quietly and
  start one fresh check on return. Stale responses cannot replace the new result.
  Successful checks and explicit authorization denials do not repeat on focus.
- Submission previously left phone-check retries competing with CREATE. The page
  now disposes the advisory check while the save is in progress. Authoritative
  identity verification remains in the approved-device server CREATE.
- Durable Dispatch CREATE used fetch keepalive even though the full request is
  already persisted. It now uses ordinary abortable fetch; local replay retains
  the exact UUID and payload after timeout. Legacy non-durable callers keep their
  existing keepalive behavior. No timeouts or server authorization were relaxed.

## Verification

Nine focused behavioral scenarios cover cancellation, rapid hide/show, suppressed
poll/realtime traffic, preserved local confirmation, silent phone recovery, hard
denial, shipping-page effects, and a committed CREATE whose response body is lost.
The latter executes the actual API client and real outbox: retry uses an identical
request, creates one synthetic row and ends with the confirmed server code.

Existing Dispatch read, submit, identity, storage and build gates also apply.
Physical iPhone/Safari behavior still needs observation after release; these tests
do not prove recovery of the user's particular connection or device.
