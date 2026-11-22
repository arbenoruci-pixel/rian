# Internal staff messages

Dispatch and existing administrative roles can compose a plain-text message to one, several, or all active operational workers. Messages appear inside the application. This feature sends no external email, SMS, or push notification.

## Access and storage

`/api/staff-messages` authenticates the existing approved device cookie, loads the canonical active user, and requires the expected account UUID to match. Sender identities and capabilities come from the server. Workers read only their own inbox. Senders read only their own sent messages and the associated read/acknowledgment receipts. There is no administrative impersonation or acknowledge-on-behalf operation.

The additive migration creates `staff_messages` and `staff_message_recipients`, enables RLS, and revokes direct table and RPC access from `PUBLIC`, `anon`, and `authenticated`. Only the existing service role can call the `SECURITY INVOKER` functions. The sender and recipient checks also run inside the database transaction. The service role needs its existing SELECT/UPDATE privileges on `users` because the send transaction takes shared row locks while validating active accounts. The migration does not expand those existing user-table privileges.

Sending uses a unique sender/request-key pair and a per-sender advisory transaction lock. Repeating an identical request returns the existing message. Reusing the key with different content or a different selected audience is rejected. An all-workers message snapshots the eligible recipient list on its first successful send, and retries keep that original snapshot even when the roster later changes. There is a bound of 100 recipients per message and 30 new messages per sender per hour; retries do not consume another send.

Read times and explicit **E lexova** confirmations are durable and idempotent. Opening an inbox message records `read_at`; the explicit button records `acknowledged_at`. Neither action changes an operational task, order, payment, salary, or bonus.

## Mounting and behavior

Mount `<StaffMessagesDock />` once inside the existing `AuthGate` in `src/AppRoot.jsx`, after the routes. It hides on login, customer/public, diagnostic, and offline routes. The optional Arka navigation entry can call `openStaffMessages()` from `lib/staffMessagesClient.js`.

The dock polls a count-only endpoint at most once every five minutes while the app is visible, and refreshes on focus/open and relevant message events. It uses a short, per-account memory cache and no persistent message cache, extra cron, realtime subscription, or external service. Each history request returns at most 30 messages with a timestamp/UUID cursor for the next page. Offline sending stays unsent with the draft retained in memory; retrying the same draft uses the same request key.

Ordinary messages never open an unsolicited modal. The separate meal policy notice has priority: it dispatches `tepiha:meal-policy-open` and exposes `data-meal-policy-notice="open"`. The message panel closes temporarily and retains its draft. Changing or logging out of the active account clears message content, recipient selections, capabilities, and the draft. Late responses from the previous account are rejected.

## Verification

Run:

```sh
node tools/verify-staff-messages.mjs
node tools/verify-staff-messages-ui.mjs
```

The integration test applies the actual migration to an isolated in-memory Postgres engine with synthetic identities. It covers access control, atomic and concurrent retries, inactive recipients, all-workers roster changes, durable acknowledgments, client role grants/RLS, pagination, and the send bound. The UI scenarios cover the real client/dock with synthetic network responses, escaping, uncertain-send retry, policy-modal priority, account changes, late responses, public-route exclusion, and foreground polling.

## Rollout and rollback

Apply and verify the additive migration before releasing the UI/API. The migration seeds no messages or actual staff data. Production smoke checks should be read-only; use synthetic tests for send/acknowledgment behavior.

To disable messaging independently, remove the UI mount and disable the API endpoint while retaining its tables, message history and current access restrictions. A rollback of the combined release must follow `december-system-release.md` and preserve the receipt-aware database guards, reporting and payroll quote validation. Do not drop tables or delete already-sent messages as a rollback step.
