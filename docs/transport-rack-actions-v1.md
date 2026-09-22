# Transport rack action repair — 2026-09-22

## Production evidence

Production `7c0abf2` / `dpl_6cFnERBGUaZ7cnTuPVRQeXG1egXD` served
`/assets/index-BTOTqlCM.js`. A client runtime report at **09:37:01.698 UTC**
(11:37 Kosovo) on `/transport/board` recorded `ReferenceError: onOpenRack is
not defined`, at bundle line 195 column 11139. The bundle location maps to the
Inbox RAFTI click handler. Ngarkim had the same undeclared callback.

Both modules omitted the callback from their props, and both parent module slots
omitted `onOpenRack: openRackPicker`. The action sheet could close without opening
the rack picker. The existing picker/save implementation is unchanged.

## Repair and tests

- Connect the existing picker to Inbox and Ngarkim and receive the prop.
- Disable rack opening when its callback or saved order ID is unavailable.
- Preserve the deferred sheet-close/open sequence and selected order identity.
- Render the actual shipping JSX with React/JSDOM and click each action using
  synthetic rows. Verify one picker call, sheet closure, unchanged row data, and
  no SMS/status/navigation mutations. Verify parent wiring with the JSX AST.
- Eight regression checks fail on the production source before the repair. The
  test is part of the existing transport-recovery build gate.
- After repair, all eight checks pass. The complete `npm run build` also passes
  (582 PASS lines), including Dispatch retry/confirmation, payments, client linking
  and Smart SMS gates. This is synthetic component/build verification; no claim
  is made of a physical installed-iPhone test.

No production records, authorization, payments, queues, service workers, SMS
recipients or storage epochs are changed.

## Dispatch remains a separate unresolved incident

The same production bundle reported timeout for T1392 / request UUID
`69358cd5-bfef-48aa-95a5-6fd53e1f5aa8` at **11:54:46.043 UTC**, after 12069 ms.
The client confirmed that UUID at **11:58:54.992 UTC**, with attempts=9. The
server logged CREATE at 11:58:53 UTC, HTTP 200, 1546 ms; the database creation time
was 11:58:53.685367 UTC. No preceding CREATE appeared in the inspected
11:53:30–11:58:56 production log window. This narrows the investigation to
communication before the logged server execution, without proving whether the
cause is connectivity, browser/PWA networking, or an unobserved intermediary.

Seven other foreground sends confirmed in 958–2011 ms. All nine confirmed UUIDs
matched persisted rows; no other same-client order was found within +/-10 minutes
of those rows. This is bounded duplicate evidence, not an exhaustive guarantee.

The follow-up scan through approximately 16:02 UTC found six newly received
service-worker-update reports on `/`, including older client events, and no new
Dispatch submission report since 13:35 UTC. Production error/fatal logs and error
clusters for that follow-up window were empty. Absence of reports is not proof of
recovery. The RAFTI repair makes no claim to resolve Dispatch networking.

Before a Dispatch network patch, reproduce interrupted/resumed requests using the
actual request code and correlate UUID, original event time, active bundle and
server arrival. Preserve the original outbox IDs and pending payloads. Do not
clear storage or add speculative cache resets.
