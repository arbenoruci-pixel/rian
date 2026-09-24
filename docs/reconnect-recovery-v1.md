# Dispatch and PWA reconnect recovery — 2026-09-24

## Production evidence

Production was running `5f20654457dfcd6eaac9e15a85be7d85b8527e67`, deployment
`dpl_4goUd1q8BsPMDXgAZs697spC4ggv`, with the RAFTI correction already released.

Read-only runtime incident records identify two Dispatch requests that timed out
after approximately 12 seconds and were confirmed on attempt five:

| Request UUID | Client timeout (UTC) | Client confirmation (UTC) |
| --- | --- | --- |
| `b45e806f-803d-4b7f-a59f-f4855acc9d20` | 07:55:53.694 | 07:57:05.811 |
| `4a6292ff-d4d5-4e03-b159-4f2c8990d540` | 08:22:43.049 | 08:23:53.323 |

The first request reached the server at 07:57:04 and completed in 801 ms. No
earlier CREATE appears in the inspected 07:55–07:58 production window. Delayed
incident uploads must not be mistaken for new failures after confirmation.
These records establish a pre-server communication gap; they do not establish
its device, network or browser cause.

Service-worker update errors also report failure fetching `/vite-sw.js` after
launch/resume. Direct reads of the live worker and imported navigation script
returned HTTP 200 with JavaScript MIME types. No worker-script routing defect was
established by those observations.

## Reproduced recovery defects

Three behavioral tests fail against the production source:

1. A reconnect leaves an already saved request in its retry backoff even after
   connectivity returns.
2. Launch/resume attempts an advisory worker update while the browser reports
   offline.
3. A failed worker update is stamped as a completed check and has no scheduled
   retry while the app remains visible.

## Correction

Real online/foreground-return events coalesce into one forced outbox drain.
Normal polling and focus retain backoff. A reconnect during a normal drain queues
one recovery pass; simultaneous forced passes share work. The existing immutable
UUID/payload, actor checks, explicit denials, expiry/review and server identity
verification remain authoritative.

Worker checks wait for visibility and connectivity, then allow foreground work
to resume before checking. A failed check retries after 5, 15 and 60 seconds,
with no continuous retry loop. Only successful completion starts the cooldown.
Concurrent checks of the same registration share one promise. Offline/hidden
events pause pending checks; unmount prevents late results from restarting work.
Failure diagnostics remain enabled. No cache/storage clearing, worker removal,
data migration or timeout increase is included.

## Verification

Ten isolated behavioral scenarios exercise the real outbox and the shipping
runtime/component functions. They cover unchanged replay bodies with one
synthetic server row, event bursts, a reconnect during an active drain, normal
backoff, authorization, actor isolation, expiry, offline/hidden state, update
failure/retry, successful cooldown, bounded attempts and unmount during a check.
The existing foreground, confirmation and durable-send tests pass. The complete
`npm run build` passes with 592 PASS lines, including all ten new scenarios.
Tests create no production orders, payments or messages.

Native installed-phone behavior and recovery from the original communication
failure still require post-release observation. This change repairs reproduced
recovery gaps; it does not establish that every network timeout is eliminated.
