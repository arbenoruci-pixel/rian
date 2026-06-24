# PATCH NOTE — PRANIMI Draft Resume Locked Code V475

## Problem
When a worker opened an incomplete PRANIMI draft from “Te Pa Plotesuarat” and edited the client/order information, the final save could switch to a new code if the currently logged-in PIN was different from the PIN that originally reserved the draft code.

Real incident:
- Draft code `199` had meaningful work and was reserved by PIN `1126`.
- User opened it later while logged in with master PIN `4563`.
- Final save re-verified through the current PIN and allocated `203` instead of keeping `199`.

## Fix
The draft-resume path now treats the code already attached to a meaningful incomplete draft as the locked lifecycle code.

Changes:
- On opening a draft from “Te Pa Plotesuarat”, the app reads the `base_code_pool` row returned by the existing guard.
- If the row is `reserved` for the same `draft_session_id`, the app uses the original `reserved_by` PIN as the code lifecycle PIN.
- Editing a resumed draft no longer causes a fresh allocation only because the active login PIN is different.
- Final verify / consume / acknowledge uses the code lifecycle PIN, while the UI/user session can still be the currently logged-in user.
- The final payload records `code_lifecycle_pin` for audit.

## Safety
- No SQL changes.
- No schema changes.
- No offline pre-reserved pool changes.
- No Service Worker/cache changes.
- New PRANIMI still allocates normally.
- Existing-client explicit mode remains unchanged.

## Validation
- `npm run build` passed.
- `npm run test:pranimi-allocator` passed.
- `npm run test:pranimi-new-client-mode` passed.
