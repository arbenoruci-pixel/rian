# GATI notification storage repair

The user's installed iPhone app displayed `The quota has been exceeded.` in the
GATI notification confirmation panel. `recordReadyNotification` synchronously
rewrote notification history to localStorage before permitting SMS/WhatsApp/Viber
handoff. A full localStorage quota therefore blocked the action. The family link
text is not part of the persisted notification event.

Notification events now use the separate `tepiha-ready-notifications-v3` IndexedDB
database. Both legacy arrays and per-event localStorage records migrate before
new events are accepted. Only identical old copies are removed after transaction
completion. Other orders, payment intents and session keys are untouched. Pending
and acknowledged copies remain separate, so a stale tab cannot undo a server
acknowledgement. Viewer identity, opened-before-confirmed replay and server UUID
idempotency remain enforced.

The modal awaits the disk commit before external handoff, locks rapid duplicate
taps, and discards late handoffs after an order/session/modal change. Clipboard
copy remains inside the Viber tap. If transient activation expires during a slow
save, a fresh “HAPE SMS/WHATSAPP/VIBER” tap reuses the committed attempt. A genuine
IndexedDB capacity failure displays Albanian guidance and does not invent a saved
confirmation. Untracked Transport messages preserve their direct handoff.

Verification:

- `verify-ready-notifications-v1.mjs`: offline/reload, actor isolation, request
  denial, lost replies, exact acknowledgements, full localStorage and failed disk
  commits, plus server replay and ownership checks.
- `verify-extended-flow-v1.mjs`: 20 checks including simultaneous tabs, 100 queued
  events, interrupted migration and immutable acknowledgements.
- `verify-ready-notification-quota-v3.mjs`: 11 migration/transaction and actual
  React modal scenarios, including the reported quota exception, native-handoff
  gating, double taps, slow saves, cancellation, Viber clipboard and Transport.
- Full production/PWA build passed. The new suite is part of the GATI build gate
  and its existing prebuild installer preserves that gate.

Tests use synthetic events and captured native URLs. No customer messages or
production business rows were created. Physical iPhone/PWA confirmation remains
the user's live acceptance check; DOM tests do not simulate the native SMS app.

Previous production commit: `5b22dc61dccba18179831d53cdc123d29ea1fa3a`. The verified
database snapshot `tepiha_before_family_20260914` remains intact; no server schema
change is needed. After a phone migrates, a UI rollback must retain the IndexedDB
queue and async notification boundary so its unsynced events remain visible.

Browser references: [WebKit user activation](https://webkit.org/blog/13862/the-user-activation-api/),
[WebKit clipboard access](https://webkit.org/blog/10855/async-clipboard-api/),
[MDN storage quotas](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria).
