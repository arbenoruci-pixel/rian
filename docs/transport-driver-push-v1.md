# Transport driver push notifications

When an order is committed with a new driver assignment and an `assigned` or
`dispatched` status, a database trigger queues one delivery per opted-in device.
The driver gets a generic TEPIHA notification even when the PWA is closed. The
notification opens the order after checking the logged-in user and current
assignment through the approved-device API. No customer name, phone, or address
is put on the lock screen.

Drivers use **Aktivizo njoftimet** on the Transport board/menu, approve the browser
prompt, and use **Provo njoftimin** to check their actual phone. iPhone/iPad require
iOS 16.4+ and a Home Screen installation. Notification settings, Focus, internet,
and OS restrictions can affect delivery. Provider acceptance is not proof of
delivery or reading. A physical device check remains part of rollout.

## Delivery and cost

- The existing Vite service worker imports `transport-push-sw.js`. A capability
  handshake upgrades older installed workers without deleting business storage.
- `api/transport/push` authenticates the existing approved device cookie for
  subscription/status/test/disable/open operations. It never sends push itself.
- Supabase `pg_net` wakes `transport-push` after commit. A Supabase database job
  checks for due work every two minutes; it makes no Edge Function request when
  there is no due work. No new Vercel cron or continuous client polling is added.
- Delivery claims use row locks and leases. Successful endpoints are never
  intentionally retried. Transient failures retry at most five times. HTTP
  404/410 disables the endpoint. Queue records expire after 12 hours and are
  deleted after seven days. Push-provider TTL is one hour.
- A stable event tag with `renotify:false` coalesces retries if a worker crashes
  after provider acceptance. Web Push cannot promise exactly-once reception.
- Reassignment, revoked device approval, disabled users, disabled subscriptions,
  and changed device ownership cancel obsolete pending deliveries. Session
  changes also unsubscribe locally. An already displayed generic notification
  may remain, but opening always checks authorization again.
- Subscription setup, tests and opening use normal existing hosting quotas;
  push sends use Supabase quotas. There is no paid push subscription or plan
  upgrade. This feature cannot guarantee a zero bill if account quotas are exceeded.

## Deployment

1. Apply `20261114163759_transport_driver_push_v1.sql` to the Tepiha project.
2. Create the encrypted Vault secret `tepiha_transport_push_v1` once, with
   `enabled`, VAPID `publicKey`/`privateKey`, `subject`, `workerUrl`, and a randomly
   generated 32-byte hex `workerToken`. Never commit these values. Keep the VAPID
   key stable so existing subscriptions remain valid.
3. Deploy `supabase/functions/transport-push/index.ts` with its worker and
   `deno.json`. `verify_jwt=false` is intentional: the handler authenticates the
   private worker token with constant-time comparison. No browser can invoke
   worker RPCs or read Vault configuration. No public/anon table privileges.
4. Deploy the frontend/API to the existing `rian` project / tepiha.vercel.app.
5. Each driver opts in and tests their phone. Existing orders are not backfilled.

Pause delivery by setting `enabled:false` in the existing Vault configuration.
The queue and business data remain intact. Removing the new trigger/job and
rolling back the app disables the feature without changing any order/payment.

## Validation

`npm run test:transport-push` covers actual SQL in PGlite, injected push-provider
outcomes, service-worker push/click events, endpoint validation, account changes,
device revocation, transaction rollback, concurrent claims, bounded retries and
React opt-in/test/disable/deep-link behavior with HTTP fixtures. The full existing
`npm run build` regression suite also runs these checks.
