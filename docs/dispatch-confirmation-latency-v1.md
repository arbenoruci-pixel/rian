# Dispatch confirmation latency — 2026-09-22

Production was still on `1ee7dd22622345554418cbc511aa94366318258b` (PR #61, deployment `dpl_Hoh1wVGNyEPvZ3m3npd9KRQdVQEU`).

## Read-only evidence and limits

- At 07:09:24.624 UTC the client reported pending / DISPATCH_ORDER_API_NETWORK_FAILED after 9,787 ms. CREATE reached production at 07:09:26 and succeeded in 1,417 ms. This is consistent with automatic retry. Old diagnostics have no request ID or background confirmation; they cannot establish that the successful request remained unacknowledged.
- Reports arriving together at 19:57:22 were partly delayed delivery: the phone error originated at 19:51:20, and list timeouts at 19:53:29, 19:54:01, 19:54:18 and 19:54:45. Their IDs identify events, not independent devices.
- DISPATCH_ORDER_STORAGE_TIMEOUT originated at 19:57:21.842. Old diagnostics lack its order ID and storage stage. CREATE at 19:57:22 succeeded in 1,969 ms. Successful form acknowledgements followed at 19:58 and 20:00.
- An iPhone failed to load /vite-sw.js. The shared build marker cannot identify its exact installed bundle. This establishes an interrupted request, not a service-worker implementation defect.
- Each of the two orders created around 07:09/07:13 and four around 19:47–20:00 has one same-client order in its +/-10 minute window. This limited check does not establish system-wide absence of duplicates.

No business rows or device/browser storage were modified during inspection.

## Reproduced defect and correction

The deployed outbox awaits a persisted sending marker before CREATE even though enqueue already durably stored the immutable request. It also awaits receipt persistence before publishing the validated server confirmation. Each local transaction can reach the adapter's five-second deadline. Two behavioral tests reproduced these stalls against deployed source and pass after correction. This proves a code weakness; old telemetry cannot attribute every production timeout to it.

The live in-flight map now supplies the sending indicator. Verified server confirmation returns immediately while its receipt persists asynchronously. A completed background drain flushes receipt writes. If persistence fails, the original durable UUID and payload remain available for idempotent replay after reload. Mandatory enqueue, actor isolation, explicit denials, server identity validation and permanent code resolution are preserved.

Diagnostics now record background confirmations, request/order UUIDs, original event time, loaded asset path and a release marker. Receipt errors identify their stage. Server CREATE logs record the same request UUID. Customer names, phones, addresses and form payloads are excluded.

## Verification

New behavioral tests cover both stalls, the shipping form, receipt failure plus reload/replay with one synthetic row, actor isolation, explicit rejection and diagnostic privacy/timing. Existing IndexedDB abort/quota, offline, lost-response, double-tap, phone/identity and background lifecycle gates also apply.

Physical installed-iPhone execution remains unverified. Post-release outcomes and the actual loaded bundle must be observed through the new telemetry. READY status or a quiet log window alone cannot prove recovery.
