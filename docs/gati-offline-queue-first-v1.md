# GATI payment capture before device verification

The reported delivery sheet error happened because `ensureApprovedDeviceSession`
ran before IndexedDB enqueue. A missing or expired offline approval cache plus a
network failure prevented the existing durable payment command from being saved.

GATI now persists the complete payment/delivery command before attempting device
verification. The receipt explicitly remains pending. The detached sender verifies
the device before its money request; the outbox continues through the authenticated
ARKA API and its existing atomic/idempotent payment operation. Explicit denial is
retained for review and cannot authorize a money write. No auth policy, approval
cache lifetime, API permission, or database schema changes are made.

The existing sync runner resumes retained commands after connectivity returns or
the app reopens. A suspended/closed mobile app resumes when reopened. Storage
failure leaves the sheet open. The original payment key and worker are retained.
This fix covers positive payments in the GATI delivery/payment sheet.

Validation: executable tests invoke the actual confirm/background functions with
controlled browser dependencies: offline, failed fetch, explicit device rejection,
storage failure and duplicate taps. The full repository build also runs these
checks. No real payment is submitted during testing. An authenticated iPhone flow
has not been exercised from this workspace.
